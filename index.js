/**
 * Host half of dsh-ws-recency: the one part that needs the file system.
 *
 * Deleting a conversation is the only sidebar operation the Client cannot do on
 * its own: DSH only offers "archive" (a flag in `archivedSessionIds`), while the
 * log directory and the projection cache stay on disk forever. This module moves
 * a session into a trash folder instead of erasing it:
 *
 *   1. stop whatever the session is running (`workspace/session-stop`)
 *   2. drop the archive flag and the pin
 *   3. detach it from every workspace that lists it
 *   4. delete its projection-cache row
 *   5. move `<home>/sessions/<project>/<sessionId>` to
 *      `<home>/.trash/ws-recency/<sessionId>-<timestamp>`
 *   6. broadcast `api-session/removed` so the browser drops the row
 *
 * Nothing is erased irreversibly: the log directory is renamed, so restoring is
 * a move back. The route only answers loopback origins and only accepts POST.
 *
 * The same module owns the other kind of put-away: the Host's archive set. An
 * archived Session keeps its slot and its log but is hidden from every grouping
 * surface, so the trash panel lists it too and can unarchive it, delete it into
 * the trash above, or erase it for good.
 *
 * @module dsh-ws-recency
 */
import { mkdir, readFile, readdir, rename, rm, stat as statPath, writeFile } from "node:fs/promises";
import zlib from "node:zlib";
import { dirname, join } from "node:path";

/** Cordis plugin name shown by the loader. */
export const name = "ws-recency";

/** Version marker reported by the health route. */
export const HOST_VERSION = "0.25.1";

/**
 * Exact routes the client half calls. Registered on the bare web server, so they
 * win over the SPA's fallback (which answers unknown POSTs with an empty 405).
 */
export const TRASH_SESSION_PATH = "/ws-recency/session-trash";
export const STATS_SESSION_PATH = "/ws-recency/session-stats";
export const HEALTH_PATH = "/ws-recency/health";
export const MOVE_SESSION_PATH = "/ws-recency/session-move";
export const ADOPT_SESSION_PATH = "/ws-recency/session-adopt";
export const TRASH_LIST_PATH = "/ws-recency/trash";

export const HANDOFF_PATH = "/ws-recency/handoff";

const TRASH_SIDECAR = ".wsr-trash.json";

const STOP_SETTLE_MS = 500;
const MAX_BODY_BYTES = 16 * 1024;
const RENAME_RETRY = 4;
const RENAME_GAP_MS = 150;

/** `?sessionId=` first, then the JSON body: a middleware may have consumed the body. */
function sessionIdFrom(req, body) {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const fromQuery = url.searchParams.get("sessionId");
    if (typeof fromQuery === "string" && fromQuery.trim() !== "") return fromQuery.trim();
  } catch {
    /* fall through to the body */
  }
  return body !== null && body !== undefined && typeof body.sessionId === "string" ? body.sessionId.trim() : "";
}

/** Only the app itself may call these routes: a foreign origin is refused. */
function loopbackOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function dshHome() {
  try {
    const module = await import("@deepseek-ai/dsh-home-paths");
    if (typeof module.resolveDshHome === "function") return module.resolveDshHome();
  } catch {
    /* fall through to the environment */
  }
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh");
}

/** Absolute path of a session's log file, or undefined when it cannot be located. */
function locateLog(ctx, meta) {
  const persistence = ctx.sessionPersistence;
  if (persistence !== undefined && typeof persistence.locate === "function") {
    try {
      const located = persistence.locate(meta);
      if (located !== undefined && located !== null && typeof located.path === "string" && located.path !== "") return located.path;
    } catch {
      /* fall back to the scan below */
    }
  }
  return undefined;
}

/** Rename with a short retry: Windows can hold a handle for a moment. */
async function moveWithRetry(source, target) {
  for (let attempt = 0; attempt < RENAME_RETRY; attempt += 1) {
    try {
      await rename(source, target);
      return true;
    } catch (error) {
      if (attempt === RENAME_RETRY - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_GAP_MS));
    }
  }
  return false;
}

/** Move the session log directory into the trash; returns the new path. */
async function trashSessionLog(ctx, meta, trashRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(trashRoot, `${meta.id}-${stamp}`);
  await mkdir(trashRoot, { recursive: true });

  const located = locateLog(ctx, meta);
  if (located !== undefined) {
    if (await moveWithRetry(dirname(located), target)) return target;
  }

  /* No `locate()` (older host): scan `<home>/sessions/<project>/<sessionId>`. */
  const home = await dshHome();
  const root = join(home, "sessions");
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    try {
      if (await moveWithRetry(join(root, project.name, meta.id), target)) return target;
    } catch {
      /* not in this project directory */
    }
  }
  return undefined;
}

/** Stop the session, drop its bookkeeping, trash its logs, tell the browser. */
export async function trashSession(ctx, sessionId) {
  const live = typeof ctx.sessions?.get === "function" ? ctx.sessions.get(sessionId) : undefined;
  let meta;
  if (live !== undefined) {
    meta = live.header;
  } else {
    const stat = await ctx.sessionPersistence.stat(sessionId);
    if (stat === undefined) return { ok: false, error: "session not found" };
    meta = stat.header;
  }

  try {
    await ctx.parallel("workspace/session-stop", { sessionId });
  } catch {
    /* stopping is best effort, exactly like "stop and archive" */
  }
  await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS));

  try { await ctx.workspaceRegistry.unarchiveSession(sessionId); } catch { /* not archived */ }
  try { await ctx.workspaceRegistry.unpinSession(sessionId); } catch { /* not pinned */ }

  /* Same filtered-view trap as the move: the workspace's own sessionIds may
     already hide the id while the stored record still lists it. */
  const rawMembers = await rawWorkspaceMembership();
  for (const workspace of ctx.workspaceRegistry.list()) {
    const record = rawMembers === null ? undefined : rawMembers.get(workspace.id);
    const listed = record !== undefined
      ? record.sessionIds.includes(sessionId)
      : Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId);
    if (!listed) continue;
    try { await workspace.detachSession(sessionId); } catch { /* keep going */ }
  }

  try {
    const domain = ctx.get("storageDomain");
    const projcache = typeof domain?.get === "function" ? domain.get("session_projcache") : undefined;
    if (projcache !== undefined) await projcache.table("sessions").delete(sessionId);
  } catch {
    /* the cache is derived data: a miss only costs a cold read */
  }

  const home = await dshHome();
  const trashRoot = join(home, ".trash", "ws-recency");
  let moved;
  try {
    moved = await trashSessionLog(ctx, meta, trashRoot);
    if (moved !== undefined) {
      /* Card facts are captured now, while the log is still on this machine:
         the list only has to read the sidecar afterwards. */
      const card = await trashEntryMetadata(moved);
      await writeTrashSidecar(moved, {
        sessionId: meta.id,
        cwd: typeof meta.cwd === "string" ? meta.cwd : null,
        reason: "delete",
        at: Date.now(),
        ...(card === null ? {} : { meta: card }),
      });
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  ctx.emit("api-session/removed", sessionId);
  return { ok: true, trash: moved };
}

/** POST { sessionId } -> move that session into the trash folder. */
export async function handleTrashRequest(ctx, req, res) {
  if ((req.method ?? "POST").toUpperCase() !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (!loopbackOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "origin not trusted" });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const sessionId = sessionIdFrom(req, body);
    if (sessionId === "") {
      sendJson(res, 400, { ok: false, error: "sessionId required" });
      return;
    }
    const result = await trashSession(ctx, sessionId);
    sendJson(res, result.ok ? 200 : 500, result);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/* ------------------------------------------------------------------------- *
 * Token statistics
 *
 * The Client knows nothing about what a finished session cost, and a session may
 * be months old, so this reads the session's own log. Recorded usage is exact
 * (per assistant step: input / cache-read / output); the split between the agent
 * itself and each tool is an estimate over the recorded content, because a
 * prompt's tokens cannot be attributed to a single message - the whole context
 * is billed every step.
 *
 * The log is a sequence of independent Zstandard frames, one per append, and the
 * standard decoder stops after the first one. Splitting on the frame magic and
 * decoding each frame is what makes the whole transcript readable.
 * ------------------------------------------------------------------------- */

const STATS_CACHE_MS = 10 * 1000;
const statsCache = new Map();

/** Archived sessions keep their log, so their card facts never change: key by size. */
const archiveMetaCache = new Map();

/** bytes/4 per Latin character, ~1 token per CJK character. */
export function estimateTokens(text) {
  if (typeof text !== "string" || text === "") return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/** Text of one content block / a whole content array, whatever shape it takes. */
function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (typeof block.text === "string") text += block.text;
    else if (typeof block.arguments === "string") text += block.arguments;
    else if (typeof block.content === "string") text += block.content;
  }
  return text;
}

/**
 * A one-line hint of what a tool call touched, for the amplified ranking.
 *
 * The argument text is the model's own JSON; the interesting field is the first
 * path/command/query it names, and a malformed or non-string argument simply
 * yields no hint.
 */
function toolDetail(args) {
  if (typeof args !== "string") return "";
  try {
    const parsed = JSON.parse(args);
    const value = parsed?.file_path ?? parsed?.path ?? parsed?.command ?? parsed?.pattern ?? parsed?.query ?? parsed?.url ?? parsed?.name;
    if (typeof value === "string" && value.trim() !== "") return value.trim().replace(/\s+/g, " ").slice(0, 80);
  } catch {
    /* not JSON: no hint */
  }
  return "";
}

/** First non-empty line, trimmed, for a user/system block's label. */
function snippetOf(text, limit = 80) {
  const line = String(text ?? "").split("\n")[0].trim().replace(/\s+/g, " ");
  return line.slice(0, limit);
}

/**
 * Aggregate one session's events into costs.
 *
 * Pure on purpose: the tests call it with hand-written events, and the route
 * calls it with the decoded log.
 */
export function aggregateSession(events) {
  const summary = {
    session: { id: "", title: "", cwd: "", createdAt: 0, lastAt: 0 },
    steps: 0,
    totals: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
    estimate: { agent: { reasoning: 0, text: 0, user: 0, system: 0, total: 0 }, tools: [], toolsTotal: 0, grandTotal: 0 },
  };
  const tools = new Map();
  const callNames = new Map();
  /* Real per-step context, so the bill can be attributed back to the content
     that produced it instead of to the step that happened to be running. */
  const steps = [];
  /** Content blocks with the step before which they enter the prompt. */
  const blocks = [];
  /** Tool-call blocks by call id, so a result can extend its own call. */
  const callBlocks = new Map();
  /** Steps at which a compaction dropped the prefix; blocks stop being re-read. */
  const compactions = [];
  const toolOf = (name) => {
    const key = typeof name === "string" && name !== "" ? name : "unknown";
    let entry = tools.get(key);
    if (entry === undefined) {
      entry = { name: key, calls: 0, args: 0, results: 0, total: 0, share: 0 };
      tools.set(key, entry);
    }
    return entry;
  };

  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const data = event.data ?? {};
    if (typeof event.type === "string" && event.type.toLowerCase().indexOf("compact") !== -1) {
      compactions.push(steps.length);
    }
    if (typeof event.time === "number") {
      if (summary.session.createdAt === 0 || event.time < summary.session.createdAt) summary.session.createdAt = event.time;
      if (event.time > summary.session.lastAt) summary.session.lastAt = event.time;
    }
    switch (event.type) {
      case "session": {
        if (typeof event.id === "string") summary.session.id = event.id;
        if (typeof event.cwd === "string") summary.session.cwd = event.cwd;
        if (typeof event.createdAt === "number") summary.session.createdAt = event.createdAt;
        if (typeof data.createdAt === "number") summary.session.createdAt = data.createdAt;
        break;
      }
      case "session/title": {
        const title = typeof data === "string" ? data : data.title;
        if (typeof title === "string" && title !== "") summary.session.title = title;
        break;
      }
      case "assistant/message": {
        const usage = data.usage;
        if (usage !== null && typeof usage === "object") {
          summary.steps += 1;
          summary.totals.inputTokens += Number(usage.inputTokens) || 0;
          summary.totals.cacheReadTokens += Number(usage.cacheReadTokens) || 0;
          summary.totals.outputTokens += Number(usage.outputTokens) || 0;
          summary.totals.totalTokens += Number(usage.totalTokens) || 0;
          steps.push({
            input: Number(usage.inputTokens) || 0,
            cacheRead: Number(usage.cacheReadTokens) || 0,
            output: Number(usage.outputTokens) || 0,
          });
        }
        /* Whatever this reply said or requested enters the prompt of the next
           step. Reasoning is deliberately left out: providers usually do not
           resend it, so it would be counted as amplified when it never is. */
        const content = data.message !== null && data.message !== undefined ? data.message.content : undefined;
        for (const block of Array.isArray(content) ? content : []) {
          if (block === null || typeof block !== "object") continue;
          if (block.type === "reasoning") summary.estimate.agent.reasoning += estimateTokens(block.text);
          else if (block.type === "text") {
            const tokens = estimateTokens(block.text);
            summary.estimate.agent.text += tokens;
            if (tokens > 0) blocks.push({ kind: "agent", name: "agent", detail: snippetOf(block.text), tokens, entry: steps.length });
          } else if (block.type === "tool-call" && block.id !== undefined) callNames.set(String(block.id), block.name);
        }
        break;
      }
      case "tool/call": {
        const name = data.name;
        if (data.callId !== undefined) callNames.set(String(data.callId), name);
        const entry = toolOf(name);
        entry.calls += 1;
        const args = estimateTokens(data.arguments);
        entry.args += args;
        const block = {
          kind: "tool",
          name: typeof name === "string" && name !== "" ? name : "unknown",
          detail: toolDetail(data.arguments),
          tokens: args,
          args,
          results: 0,
          entry: steps.length,
        };
        blocks.push(block);
        if (data.callId !== undefined) callBlocks.set(String(data.callId), block);
        break;
      }
      case "tool/result": {
        const callId = String(data.toolCallId ?? data.message?.source?.callId ?? "");
        const name = callNames.get(callId);
        const entry = toolOf(name);
        const results = estimateTokens(blockText(data.message !== null && data.message !== undefined ? data.message.content : data.content));
        entry.results += results;
        const block = callBlocks.get(callId);
        if (block !== undefined) {
          block.results += results;
          block.tokens += results;
        } else if (results > 0) {
          blocks.push({ kind: "tool", name: typeof name === "string" && name !== "" ? name : "unknown", detail: "", tokens: results, args: 0, results, entry: steps.length });
        }
        break;
      }
      case "user/message": {
        const text = blockText(data.message !== null && data.message !== undefined ? data.message.content : data.content);
        const tokens = estimateTokens(text);
        summary.estimate.agent.user += tokens;
        if (tokens > 0) blocks.push({ kind: "user", name: "user", detail: snippetOf(text), tokens, entry: steps.length });
        break;
      }
      case "system/message": {
        const text = blockText(data.message !== null && data.message !== undefined ? data.message.content : data.content);
        const tokens = estimateTokens(text);
        summary.estimate.agent.system += tokens;
        if (tokens > 0) blocks.push({ kind: "system", name: "system", detail: snippetOf(text), tokens, entry: steps.length });
        break;
      }
      default:
        break;
    }
  }

  const agent = summary.estimate.agent;
  agent.total = agent.reasoning + agent.text + agent.user + agent.system;
  const list = [...tools.values()].sort((a, b) => (b.args + b.results) - (a.args + a.results));
  for (const entry of list) entry.total = entry.args + entry.results;
  summary.estimate.tools = list;
  summary.estimate.toolsTotal = list.reduce((sum, entry) => sum + entry.total, 0);
  summary.estimate.grandTotal = agent.total + summary.estimate.toolsTotal;
  const grand = summary.estimate.grandTotal;
  if (grand > 0) {
    for (const entry of list) entry.share = entry.total / grand;
    summary.estimate.agent.share = agent.total / grand;
  }

  /* -------------------------------------------------------------------------
   * Amplified cost: the bill is `sum(context per step)`, so a block that enters
   * early is paid for again on every later step. Its share of the bill is
   * `tokens x remaining steps`, not the tokens it showed at the moment it
   * appeared. That is what makes "top steps" useless and "top content" useful.
   * ----------------------------------------------------------------------- */
  const totalSteps = steps.length;
  const bill = steps.reduce((sum, step) => sum + step.input + step.cacheRead, 0);
  const limitFor = (entry) => {
    let limit = totalSteps;
    /* Conservative: a compaction recorded before step k replaces everything up
       to k, so a block that entered at k is not re-read afterwards either. */
    for (const at of compactions) if (at >= entry && at < limit) limit = at;
    return limit;
  };
  const byKind = new Map();
  const addKind = (kind, tokens, remaining) => {
    let entry = byKind.get(kind);
    if (entry === undefined) {
      entry = { kind, tokens: 0, amplified: 0 };
      byKind.set(kind, entry);
    }
    entry.tokens += tokens;
    entry.amplified += tokens * remaining;
  };
  for (const block of blocks) {
    const limit = limitFor(block.entry);
    block.remaining = Math.max(0, limit - block.entry);
    block.amplified = block.tokens * block.remaining;
    if (block.kind === "tool") {
      addKind("results", block.results, block.remaining);
      addKind("args", block.args, block.remaining);
    } else {
      addKind(block.kind, block.tokens, block.remaining);
    }
  }
  const attributed = [...byKind.values()].reduce((sum, entry) => sum + entry.amplified, 0);
  const ranked = blocks
    .filter((block) => block.amplified > 0)
    .sort((a, b) => b.amplified - a.amplified)
    .slice(0, 15)
    .map((block) => ({
      kind: block.kind,
      name: block.name,
      detail: block.detail,
      entry: block.entry + 1,
      remaining: block.remaining,
      tokens: block.tokens,
      args: block.args || 0,
      results: block.results || 0,
      amplified: block.amplified,
      share: bill > 0 ? block.amplified / bill : 0,
      saving: Math.round(block.amplified * 0.8),
    }));

  /* Downsample the context curve: at most 96 points keeps the panel cheap. */
  const series = [];
  if (totalSteps > 0) {
    const buckets = Math.min(96, totalSteps);
    const size = Math.ceil(totalSteps / buckets);
    for (let start = 0; start < totalSteps; start += size) {
      const end = Math.min(totalSteps, start + size);
      let sum = 0;
      for (let index = start; index < end; index += 1) sum += steps[index].input + steps[index].cacheRead;
      series.push({ step: start + 1, context: Math.round(sum / (end - start)) });
    }
  }
  summary.amplified = {
    bill,
    attributed,
    share: bill > 0 ? attributed / bill : 0,
    steps: totalSteps,
    series,
    blocks: ranked,
    byKind: [...byKind.values()]
      .map((entry) => ({ ...entry, share: bill > 0 ? entry.amplified / bill : 0 }))
      .sort((a, b) => b.amplified - a.amplified),
  };
  return summary;
}

/**
 * Read a session's events through the host's own persistence seam.
 *
 * Decoding the log by hand looked simpler, but it is a chain of independent
 * Zstandard frames, and the host's Node build is not guaranteed to ship a zstd
 * decoder. The persistence service owns both concerns (it carries its own frame
 * decoder), so ask it instead of touching the file.
 */
async function readSessionEvents(ctx, sessionId) {
  const handle = await ctx.sessionPersistence.open(sessionId, "read");
  const all = [];
  try {
    /* Page through in slices: one huge read holds the whole transcript plus its
       parse alive at the same time, which is a lot for a months-old session. */
    let offset = 0;
    const page = 5000;
    for (;;) {
      const slice = await handle.read(offset, page);
      const events = slice !== null && slice !== undefined && Array.isArray(slice.events) ? slice.events : [];
      for (const event of events) all.push(event);
      if (events.length < page) break;
      offset += events.length;
      if (offset >= 400000) break;
    }
  } finally {
    try {
      if (typeof handle.close === "function") await handle.close();
    } catch {
      /* closing is best effort */
    }
  }
  return all;
}

/** Statistics for one session, cached briefly so re-opening the panel is cheap. */
export async function sessionStatistics(ctx, sessionId) {
  let stat;
  try {
    stat = await ctx.sessionPersistence.stat(sessionId);
  } catch {
    return { ok: false, error: "session not found" };
  }
  if (stat === undefined || stat === null) return { ok: false, error: "session not found" };
  const cacheKey = `${stat.sizeBytes ?? 0}:${stat.revision ?? ""}`;
  const cached = statsCache.get(sessionId);
  if (cached !== undefined && cached.cacheKey === cacheKey && Date.now() - cached.at < STATS_CACHE_MS) return { ok: true, stats: cached.stats };
  try {
    const events = await readSessionEvents(ctx, sessionId);
    const stats = aggregateSession(events);
    if (stats.session.id === "") stats.session.id = sessionId;
    const header = stat.header;
    if (header !== undefined && header !== null) {
      if (stats.session.createdAt === 0 && typeof header.createdAt === "number") stats.session.createdAt = header.createdAt;
      if (stats.session.cwd === "" && typeof header.cwd === "string") stats.session.cwd = header.cwd;
    }
    statsCache.set(sessionId, { cacheKey, stats, at: Date.now() });
    return { ok: true, stats };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Which workspaces list a session in the stored table (the registry view is filtered). */
async function rawWorkspaceMembership() {
  try {
    const home = await dshHome();
    const raw = JSON.parse(await readFile(join(home, "storages", "workspace.json"), "utf8"));
    const table = raw !== null && raw.tables !== undefined && raw.tables !== null ? raw.tables.workspaces : undefined;
    if (table === undefined || table === null || typeof table !== "object") return null;
    const map = new Map();
    for (const [id, record] of Object.entries(table)) {
      const ids = record !== null && Array.isArray(record.sessionIds) ? record.sessionIds : [];
      map.set(id, { path: typeof record.path === "string" ? record.path : "", sessionIds: ids });
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Move one session into another workspace.
 *
 * A Session belongs to a Workspace through its stored header's `cwd`, and the
 * Workspace registry refuses to attach a session whose header names another
 * directory - so the header itself has to change. It is the immutably stored
 * first record, so the move rewrites the log:
 *
 *   1. stop the session and read every event through the persistence seam
 *   2. rename the old log directory into `.trash/ws-recency` (a backup, and it
 *      frees the id for the create below)
 *   3. create the same id with the new `cwd` and append the same events
 *   4. verify the new header, then detach from the old workspace and attach to
 *      the target (which validates the new cwd)
 *   5. drop the projection cache so it rebuilds against the new path
 *
 * Any failure before step 4 rolls the backup back into place. The backup is kept
 * afterwards on purpose: it is the only undo, and it is one rename away.
 */
export async function moveSessionToWorkspace(ctx, sessionId, workspaceId) {
  const stat = await ctx.sessionPersistence.stat(sessionId);
  if (stat === undefined || stat === null) return { ok: false, error: "session not found" };
  const header = stat.header;
  if (header === undefined || header === null) return { ok: false, error: "session header unavailable" };

  const workspaces = ctx.workspaceRegistry.list();
  const target = workspaces.find((workspace) => workspace.id === workspaceId)
    ?? workspaces.find((workspace) => workspace.path === workspaceId);
  if (target === undefined) return { ok: false, error: "workspace not found" };
  const targetPath = target.path;
  if (header.cwd === targetPath) {
    /* Already pointed at the target: a previous attempt moved the log but died
       before the bookkeeping (the app's in-memory header refused it). Repair the
       membership instead of failing, so such a session is not left unlisted. */
    try {
      await target.attachSession(sessionId);
    } catch (error) {
      return { ok: false, error: `session is already in that directory but the workspace refused it: ${error instanceof Error ? error.message : String(error)}` };
    }
    const stale = [];
    for (const workspace of workspaces) {
      if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue;
      if (workspace.id === target.id) continue;
      try {
        await workspace.detachSession(sessionId);
        stale.push(workspace.id);
      } catch {
        /* a stale membership that filters itself out anyway */
      }
    }
    return { ok: true, repaired: true, workspace: target.id, path: targetPath, detached: stale };
  }

  let targetDirectory;
  try {
    targetDirectory = await statPath(targetPath);
  } catch {
    return { ok: false, error: `target directory does not exist: ${targetPath}` };
  }
  if (!targetDirectory.isDirectory()) return { ok: false, error: "target path is not a directory" };

  try {
    await ctx.parallel("workspace/session-stop", { sessionId });
  } catch {
    /* stopping is best effort, exactly like "stop and archive" */
  }
  await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS));

  let events;
  try {
    events = await readSessionEvents(ctx, sessionId);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const located = typeof ctx.sessionPersistence.locate === "function" ? ctx.sessionPersistence.locate(header) : undefined;
  const sourceDirectory = located !== undefined && located !== null && typeof located.path === "string" ? dirname(located.path) : undefined;
  if (sourceDirectory === undefined) return { ok: false, error: "session log not found" };

  const home = await dshHome();
  const backupRoot = join(home, ".trash", "ws-recency");
  const backup = join(backupRoot, `${sessionId}-move-${Date.now()}`);
  let movedAside = false;
  try {
    await mkdir(backupRoot, { recursive: true });
    await rename(sourceDirectory, backup);
    movedAside = true;
    await writeTrashSidecar(backup, { sessionId, cwd: header.cwd, reason: "move", at: Date.now() });
  } catch (error) {
    return { ok: false, error: `could not park the old log: ${error instanceof Error ? error.message : String(error)}` };
  }

  /** Undo the rewrite: drop whatever was written and put the original back. */
  const rollback = async () => {
    try {
      const partial = typeof ctx.sessionPersistence.locate === "function" ? ctx.sessionPersistence.locate({ ...header, cwd: targetPath }) : undefined;
      if (partial !== undefined && partial !== null && typeof partial.path === "string") await rm(dirname(partial.path), { recursive: true, force: true });
    } catch {
      /* nothing partial to clean */
    }
    try {
      await rename(backup, sourceDirectory);
    } catch {
      /* the backup stays in the trash folder */
    }
  };

  try {
    const created = await ctx.sessionPersistence.create({ ...header, cwd: targetPath }, { inheritedEventCount: 0 });
    try {
      if (events.length > 0) await created.append(events);
      if (typeof created.flush === "function") await created.flush();
    } finally {
      try {
        await created.close();
      } catch {
        /* closing is best effort */
      }
    }
    const check = await ctx.sessionPersistence.stat(sessionId);
    if (check === undefined || check === null || check.header === undefined || check.header.cwd !== targetPath) {
      throw new Error("the rewritten header did not take");
    }
  } catch (error) {
    await rollback();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  /* The moved cwd lives in three places: the log (just rewritten), the Workspace
     registry's header index, and the live Session object when this process still
     has the session open. The registry validates against its own view, so both the
     cached header and the live one have to follow - otherwise an open session is
     refused with its old directory. */
  let wasLive = false;
  try {
  const movedHeader = { ...header, cwd: targetPath };
  /* Cordis throws on an undeclared service, so the probe is guarded. */
  try {
    wasLive = typeof ctx.sessions?.get === "function" && ctx.sessions.get(sessionId) !== undefined;
  } catch {
    wasLive = false;
  }
  try {
    if (typeof ctx.workspaceRegistry.indexHeader === "function") await ctx.workspaceRegistry.indexHeader(movedHeader);
  } catch {
    /* the index rebuilds from disk on its own */
  }
  try {
    const live = typeof ctx.sessions?.get === "function" ? ctx.sessions.get(sessionId) : undefined;
    if (live !== undefined && live !== null && live.header !== undefined) live.header = movedHeader;
  } catch {
    /* an immutable live header: the attach below reports it */
  }

  let seenCwd = targetPath;
  try {
    if (typeof ctx.workspaceRegistry.readSessionHeader === "function") {
      const seen = await ctx.workspaceRegistry.readSessionHeader(sessionId);
      if (seen !== undefined && seen !== null && typeof seen.cwd === "string") seenCwd = seen.cwd;
    }
  } catch {
    seenCwd = targetPath;
  }
  if (seenCwd !== targetPath) {
    await rollback();
    return { ok: false, error: `the app still holds this session's old directory (${seenCwd}); restart the app and move it again` };
  }
  } catch (error) {
    await rollback();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  /* Attach first, detach second: a refused attach must not orphan the session. */
  try {
    await target.attachSession(sessionId);
  } catch (error) {
    await rollback();
    return { ok: false, error: `the workspace refused the attach: ${error instanceof Error ? error.message : String(error)}` };
  }

  /* Detach by the RAW record, not the filtered view: once the header carries the
     new cwd, the old workspace's own `sessionIds` getter already hides the id, so
     an "is it listed?" check would skip exactly the membership that has to go. */
  const detached = [];
  const raw = await rawWorkspaceMembership();
  for (const workspace of workspaces) {
    if (workspace.id === target.id) continue;
    const record = raw === null ? undefined : raw.get(workspace.id);
    if (record !== undefined && !record.sessionIds.includes(sessionId)) continue;
    try {
      await workspace.detachSession(sessionId);
      detached.push(workspace.id);
    } catch {
      /* the session is already in the target; a stale membership is cosmetic */
    }
  }

  try {
    const domain = ctx.get("storageDomain");
    const projcache = typeof domain?.get === "function" ? domain.get("session_projcache") : undefined;
    if (projcache !== undefined) await projcache.table("sessions").delete(sessionId);
  } catch {
    /* the cache is derived data */
  }

  await announceSession(ctx, sessionId);
  return { ok: true, workspace: target.id, path: targetPath, detached, backup, live: wasLive };
}

/**
 * Re-attach sessions whose stored cwd already names a workspace but which are
 * listed by none - the shape an aborted move leaves behind. Idempotent: it only
 * ever adds memberships the registry's own validation accepts.
 */
export async function adoptOrphanSessions(ctx) {
  const snapshots = await ctx.sessionPersistence.list();
  const workspaces = ctx.workspaceRegistry.list();
  const byPath = new Map();
  for (const workspace of workspaces) byPath.set(workspace.path, workspace);
  const adopted = [];
  const raw = await rawWorkspaceMembership();
  let cleaned = 0;
  for (const snapshot of snapshots) {
    const header = snapshot !== null && snapshot !== undefined ? snapshot.header : undefined;
    if (header === undefined || header === null || typeof header.cwd !== "string" || typeof header.id !== "string") continue;
    const target = byPath.get(header.cwd);
    /* Stale memberships first: a workspace whose path is not this session's cwd
       must not keep listing it - that is what puts one session in two groups. */
    if (raw !== null) {
      for (const workspace of workspaces) {
        if (target !== undefined && workspace.id === target.id) continue;
        const record = raw.get(workspace.id);
        if (record === undefined || !record.sessionIds.includes(header.id)) continue;
        try {
          await workspace.detachSession(header.id);
          cleaned += 1;
        } catch {
          /* leave it */
        }
      }
    }
    if (target === undefined) continue;
    const record = raw === null ? undefined : raw.get(target.id);
    /* Without the raw table, fall back to the registry's own (filtered) view. */
    const physically = record !== undefined
      ? record.sessionIds.includes(header.id)
      : Array.isArray(target.sessionIds) && target.sessionIds.includes(header.id);
    if (physically) continue;
    try {
      await target.attachSession(header.id);
      adopted.push(header.id);
      await announceSession(ctx, header.id);
    } catch {
      /* the registry refused it; leave it alone */
    }
  }
  return { ok: true, adopted, cleaned };
}

/**
 * Tell the browser about a Session it does not know yet.
 *
 * A restored session exists on disk but not in the running Host's client-side
 * list, so a sidebar that was loaded before the restore has no row to show. The
 * session list is kept in sync by `api-session/added`; announce the summary the
 * session controller itself would produce, or a minimal one built from the
 * stored header when that service is not injected here.
 */
export async function announceSession(ctx, sessionId) {
  try {
    const controller = ctx.get("sessionController");
    if (controller !== undefined && controller !== null && typeof controller.list === "function") {
      const items = await controller.list();
      const summary = Array.isArray(items) ? items.find((item) => item !== null && item !== undefined && item.sessionId === sessionId) : undefined;
      if (summary !== undefined) {
        ctx.emit("api-session/added", summary);
        return true;
      }
    }
  } catch {
    /* fall through to the header-built summary */
  }
  try {
    const stat = await ctx.sessionPersistence.stat(sessionId);
    const header = stat !== undefined && stat !== null ? stat.header : undefined;
    if (header !== undefined && header !== null) {
      ctx.emit("api-session/added", {
        sessionId: header.id,
        updatedAt: typeof header.updatedAt === "number" ? header.updatedAt : Date.now(),
        agentAvailable: false,
        formatStatus: "current",
        running: false,
        blank: false,
        title: header.title,
        cwd: header.cwd,
        createdAt: header.createdAt,
      });
      return true;
    }
  } catch {
    /* nothing to announce */
  }
  return false;
}

/** The session root's project-directory key: separators collapse to `-`. */
export function projectKey(cwd) {
  if (typeof cwd !== "string" || cwd === "") return undefined;
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

async function trashRoot() {
  return join(await dshHome(), ".trash", "ws-recency");
}

/** Record what a trashed directory was, so the UI can put it back. */
export async function writeTrashSidecar(directory, sidecar) {
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, TRASH_SIDECAR), JSON.stringify(sidecar, null, 2), "utf8");
  } catch {
    /* the entry stays restorable-by-hand only */
  }
}

async function readTrashSidecar(directory) {
  try {
    const raw = JSON.parse(await readFile(join(directory, TRASH_SIDECAR), "utf8"));
    return raw !== null && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/** The one log file a session directory holds. */
const SESSION_LOG = "session.v4.jsonl.zstd";

/** zstd frame magic: every append is its own frame, so a log must be split on it. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Read a session log that is no longer reachable through the persistence service.
 *
 * A trashed log sits outside `sessions/`, so the Host's own reader cannot open
 * it; the frames are decompressed directly with the bundled zstd support (Node
 * 22.15 and newer). Without it the caller keeps the id-only card.
 */
async function readLogEvents(file) {
  if (typeof zlib.zstdDecompressSync !== "function") return null;
  const buffer = await readFile(file);
  const offsets = [];
  let index = buffer.indexOf(ZSTD_MAGIC, 0);
  while (index !== -1) {
    offsets.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length);
  }
  if (offsets.length === 0) return null;
  const parts = [];
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : buffer.length;
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(offsets[frame], end)));
    } catch {
      /* a torn tail frame is normal after a crash */
    }
  }
  const text = Buffer.concat(parts).toString("utf8");
  const events = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip a partial line */
    }
  }
  return events;
}

/**
 * The card facts for a trashed session: title, turns, steps and recorded tokens.
 * @param directory - one entry of the trash root.
 * @returns metadata, or null when the log cannot be read here.
 */
export async function trashEntryMetadata(directory) {
  let events;
  try {
    events = await readLogEvents(join(directory, SESSION_LOG));
  } catch {
    return null;
  }
  if (events === null || events.length === 0) return null;
  const summary = aggregateSession(events);
  let turns = 0;
  let messages = 0;
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    if (event.type === "turn/start") turns += 1;
    if (event.type === "user/message") messages += 1;
  }
  if (turns === 0) turns = messages;
  return {
    title: typeof summary.session.title === "string" ? summary.session.title : "",
    turns,
    messages,
    steps: summary.steps,
    tokens: summary.totals.totalTokens,
    inputTokens: summary.totals.inputTokens,
    outputTokens: summary.totals.outputTokens,
    lastAt: summary.session.lastAt,
  };
}

/** Every entry in the plugin's trash, newest first. */
export async function listTrash() {
  const root = await trashRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { ok: true, entries: [] };
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const sidecar = await readTrashSidecar(directory);
    let size = 0;
    try {
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (file.name === TRASH_SIDECAR || !file.isFile()) continue;
        try {
          size += (await statPath(join(directory, file.name))).size;
        } catch {
          /* skip unreadable files */
        }
      }
    } catch {
      /* skip unreadable directories */
    }
    let meta = sidecar !== null && sidecar.meta !== null && typeof sidecar.meta === "object" ? sidecar.meta : null;
    if (meta === null) {
      /* One decode per entry, then cached in its sidecar so the list stays cheap. */
      const computed = await trashEntryMetadata(directory);
      if (computed !== null) {
        meta = computed;
        await writeTrashSidecar(directory, {
          sessionId: sidecar !== null && typeof sidecar.sessionId === "string" ? sidecar.sessionId : null,
          cwd: sidecar !== null && typeof sidecar.cwd === "string" ? sidecar.cwd : null,
          reason: sidecar !== null && typeof sidecar.reason === "string" ? sidecar.reason : "unknown",
          at: sidecar !== null && typeof sidecar.at === "number" ? sidecar.at : 0,
          meta: computed,
        });
      }
    }
    results.push({
      name: entry.name,
      sizeBytes: size,
      title: meta !== null && typeof meta.title === "string" ? meta.title : "",
      turns: meta !== null && typeof meta.turns === "number" ? meta.turns : 0,
      steps: meta !== null && typeof meta.steps === "number" ? meta.steps : 0,
      tokens: meta !== null && typeof meta.tokens === "number" ? meta.tokens : 0,
      lastAt: meta !== null && typeof meta.lastAt === "number" ? meta.lastAt : 0,
      sessionId: sidecar !== null && typeof sidecar.sessionId === "string" ? sidecar.sessionId : null,
      cwd: sidecar !== null && typeof sidecar.cwd === "string" ? sidecar.cwd : null,
      reason: sidecar !== null && typeof sidecar.reason === "string" ? sidecar.reason : "unknown",
      at: sidecar !== null && typeof sidecar.at === "number" ? sidecar.at : 0,
      restorable: sidecar !== null && sidecar.reason === "delete" && typeof sidecar.cwd === "string" && typeof sidecar.sessionId === "string",
    });
  }
  results.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  return { ok: true, entries: results };
}

/** Put one deleted session back where its cwd says it belongs, and re-attach it. */
export async function restoreTrashEntry(ctx, name) {
  const root = await trashRoot();
  const directory = join(root, name);
  const sidecar = await readTrashSidecar(directory);
  if (sidecar === null || typeof sidecar.cwd !== "string" || typeof sidecar.sessionId !== "string") {
    return { ok: false, error: "this entry has no recorded directory; restore it by hand" };
  }
  const key = projectKey(sidecar.cwd);
  if (key === undefined) return { ok: false, error: "the recorded directory is not usable" };
  const home = await dshHome();
  const target = join(home, "sessions", key, sidecar.sessionId);
  try {
    await mkdir(target, { recursive: true });
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.name === TRASH_SIDECAR) continue;
      await rename(join(directory, file.name), join(target, file.name));
    }
  } catch (error) {
    return { ok: false, error: `could not move the files back: ${error instanceof Error ? error.message : String(error)}` };
  }
  const workspaces = ctx.workspaceRegistry.list();
  const owner = workspaces.find((workspace) => workspace.path === sidecar.cwd);
  let attached = false;
  if (owner !== undefined) {
    try {
      await owner.attachSession(sidecar.sessionId);
      attached = true;
    } catch {
      /* an old header may be refused; the files are back either way */
    }
  }
  /* A restore must not resurrect the stale membership the delete left behind. */
  const raw = await rawWorkspaceMembership();
  for (const workspace of workspaces) {
    if (owner !== undefined && workspace.id === owner.id) continue;
    const record = raw === null ? undefined : raw.get(workspace.id);
    const listed = record !== undefined
      ? record.sessionIds.includes(sidecar.sessionId)
      : Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sidecar.sessionId);
    if (!listed) continue;
    try {
      await workspace.detachSession(sidecar.sessionId);
    } catch {
      /* leave it; the scan can clean it later */
    }
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    /* an empty leftover directory is harmless */
  }
  await announceSession(ctx, sidecar.sessionId);
  return { ok: true, sessionId: sidecar.sessionId, cwd: sidecar.cwd, attached };
}

/** Delete one trash entry for good. */
export async function purgeTrashEntry(name) {
  const root = await trashRoot();
  if (name === "" || name.indexOf("..") !== -1 || name.indexOf("/") !== -1 || name.indexOf("\\") !== -1) {
    return { ok: false, error: "invalid entry name" };
  }
  await rm(join(root, name), { recursive: true, force: true });
  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Archived sessions
 *
 * The Host's archive is nothing but a flag in the registry's
 * `archivedSessionIds`: the Session keeps its slot in the Workspace that owns it
 * and its log stays under `sessions/`, yet every grouping surface hides it. That
 * makes "archived" a second kind of put-away that nothing manages - only DSH's
 * own view filter can show it again. The trash panel lists it next to the trash
 * so both kinds of "put away" live in one place: unarchive (back into its old
 * slot), delete into the plugin's trash (recoverable), or delete for good.
 * ------------------------------------------------------------------------- */

/** The registry's durable archive set; a Host without one has none. */
function archivedSessionIds(ctx) {
  try {
    const ids = ctx.workspaceRegistry?.archivedSessionIds;
    return Array.isArray(ids) ? ids.slice() : [];
  } catch {
    return [];
  }
}

/** One session's projection-cache record: a listing hint, never authority. */
function cachedCheckpoint(ctx, sessionId) {
  try {
    const domain = ctx.get("storageDomain");
    const table = domain !== undefined && domain !== null && typeof domain.get === "function"
      ? domain.get("session_projcache")?.table("sessions")
      : undefined;
    const record = table !== undefined && table !== null && typeof table.get === "function" ? table.get(sessionId) : undefined;
    return record !== undefined && record !== null && typeof record === "object" ? record : undefined;
  } catch {
    return undefined;
  }
}

/** A checkpoint row's `val`, whichever fold unit it belongs to. */
function checkpointValue(record, key) {
  const row = record?.rows?.[key];
  return row !== null && typeof row === "object" && "val" in row ? row.val : undefined;
}

/**
 * Title fallback for a session the projection cache has no record for.
 *
 * A title is written right after the first prompt, so the first page of the log
 * is enough - and reading one page is far cheaper than folding the whole Log.
 */
async function titleFromLog(ctx, sessionId) {
  let handle;
  try {
    handle = await ctx.sessionPersistence.open(sessionId, "read");
  } catch {
    return "";
  }
  try {
    const slice = await handle.read(0, 60);
    const events = slice !== null && slice !== undefined && Array.isArray(slice.events) ? slice.events : [];
    for (const event of events) {
      if (event?.type !== "session/title") continue;
      const title = typeof event.data === "string" ? event.data : event.data?.title;
      if (typeof title === "string" && title.trim() !== "") return title.trim();
    }
    for (const event of events) {
      if (event?.type !== "user/message") continue;
      const line = blockText(event.data?.content).split("\n")[0].trim();
      if (line !== "") return line.slice(0, 120);
    }
    return "";
  } catch {
    return "";
  } finally {
    try {
      if (typeof handle.close === "function") await handle.close();
    } catch {
      /* closing is best effort */
    }
  }
}

/** Whether a workspace lists the session in the stored table rather than the filtered view. */
function listedBy(workspace, raw, sessionId) {
  const record = raw === null ? undefined : raw.get(workspace.id);
  if (record !== undefined) return record.sessionIds.includes(sessionId);
  return Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId);
}

/**
 * Every archived session, newest activity first.
 *
 * One persistence listing covers the stored headers (cwd, createdAt); the title
 * and the last prompt time come from the projection cache, which is far cheaper
 * than folding each log - and is only a display hint, so a stale title is fine.
 */
export async function listArchivedSessions(ctx) {
  const ids = archivedSessionIds(ctx);
  if (ids.length === 0) return { ok: true, entries: [] };

  const headers = new Map();
  const sizes = new Map();
  try {
    const snapshots = await ctx.sessionPersistence.list();
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      const header = snapshot !== null && snapshot !== undefined ? snapshot.header : undefined;
      if (header === null || header === undefined || typeof header.id !== "string") continue;
      headers.set(header.id, header);
      if (typeof snapshot.sizeBytes === "number") sizes.set(header.id, snapshot.sizeBytes);
    }
  } catch {
    /* fall back to a stat per id below */
  }

  const raw = await rawWorkspaceMembership();
  const workspaces = ctx.workspaceRegistry.list();
  const entries = [];
  for (const sessionId of ids) {
    let header = headers.get(sessionId);
    let sizeBytes = sizes.get(sessionId) ?? 0;
    if (header === undefined) {
      try {
        const stat = await ctx.sessionPersistence.stat(sessionId);
        header = stat !== undefined && stat !== null ? stat.header : undefined;
        sizeBytes = Number(stat?.sizeBytes) || 0;
      } catch {
        header = undefined;
      }
    }

    const checkpoint = cachedCheckpoint(ctx, sessionId);
    let title = checkpointValue(checkpoint, "title");
    title = typeof title === "string" ? title.trim() : "";
    if (title === "") {
      /* The first prompt is what the sidebar itself falls back to. */
      const outline = checkpointValue(checkpoint, "turnOutline");
      const prompt = Array.isArray(outline?.turns) && outline.turns.length > 0 ? outline.turns[0]?.prompt : undefined;
      if (typeof prompt === "string") title = prompt.split("\n")[0].trim().slice(0, 120);
    }
    if (title === "" && typeof header?.title === "string") title = header.title.trim();
    /* Last resort: the cache may have no record for this session at all. */
    if (title === "") title = await titleFromLog(ctx, sessionId);

    const outlineTurns = checkpointValue(checkpoint, "turnOutline");
    const turns = Array.isArray(outlineTurns?.turns) ? outlineTurns.turns.length : 0;
    /* Same facts the trash cards show, so both sections read alike. */
    const metaKey = `${sessionId}:${sizeBytes}`;
    let archiveMeta = archiveMetaCache.get(metaKey);
    if (archiveMeta === undefined) {
      try {
        const stats = await sessionStatistics(ctx, sessionId);
        archiveMeta = stats.ok === true ? { steps: stats.stats.steps, tokens: stats.stats.totals.totalTokens } : { steps: 0, tokens: 0 };
      } catch {
        archiveMeta = { steps: 0, tokens: 0 };
      }
      archiveMetaCache.set(metaKey, archiveMeta);
    }
    const listMeta = checkpointValue(checkpoint, "sessionListMetadata");
    let lastAt = typeof listMeta?.lastPromptAt === "number" ? listMeta.lastPromptAt : 0;
    if (lastAt === 0 && typeof header?.updatedAt === "number") lastAt = header.updatedAt;
    if (lastAt === 0 && typeof header?.createdAt === "number") lastAt = header.createdAt;

    const cwd = typeof header?.cwd === "string" && header.cwd !== "" ? header.cwd : null;
    let workspace = workspaces.find((candidate) => listedBy(candidate, raw, sessionId));
    if (workspace === undefined && cwd !== null) workspace = workspaces.find((candidate) => candidate.path === cwd);

    entries.push({
      sessionId,
      title,
      turns,
      steps: archiveMeta.steps,
      tokens: archiveMeta.tokens,
      cwd,
      createdAt: typeof header?.createdAt === "number" ? header.createdAt : 0,
      lastAt,
      sizeBytes,
      blank: listMeta?.blank === true,
      workspaceId: workspace !== undefined ? workspace.id : null,
      workspacePath: workspace !== undefined ? workspace.path : null,
      /* Whether a Workspace still lists it: an unarchive without one has nowhere to show up. */
      listed: workspace !== undefined,
    });
  }
  entries.sort((a, b) => b.lastAt - a.lastAt || (a.sessionId < b.sessionId ? -1 : 1));
  return { ok: true, entries };
}

/**
 * Put an archived session back.
 *
 * Unarchiving never touches workspace accounting, so the slot the session had is
 * normally enough. A session whose Workspace was deleted while it was archived
 * has nowhere to return to: attach it to a Workspace whose path matches its cwd,
 * and report that it could not be shown otherwise.
 */
export async function restoreArchivedSession(ctx, sessionId) {
  if (!archivedSessionIds(ctx).includes(sessionId)) return { ok: false, error: "session is not archived" };
  try {
    await ctx.workspaceRegistry.unarchiveSession(sessionId);
  } catch (error) {
    return { ok: false, error: `could not unarchive: ${error instanceof Error ? error.message : String(error)}` };
  }

  let cwd = null;
  let createdAt = 0;
  try {
    const stat = await ctx.sessionPersistence.stat(sessionId);
    const header = stat !== undefined && stat !== null ? stat.header : undefined;
    if (typeof header?.cwd === "string") cwd = header.cwd;
    if (typeof header?.createdAt === "number") createdAt = header.createdAt;
  } catch {
    /* the archive flag is already gone; membership follows below */
  }

  const workspaces = ctx.workspaceRegistry.list();
  const raw = await rawWorkspaceMembership();
  let listed = workspaces.some((workspace) => listedBy(workspace, raw, sessionId));
  if (!listed && cwd !== null) {
    const owner = workspaces.find((workspace) => workspace.path === cwd);
    if (owner !== undefined) {
      try {
        await owner.attachSession(sessionId);
        listed = true;
      } catch {
        /* a stale header is refused; the log is untouched */
      }
    }
  }

  await announceSession(ctx, sessionId);
  return { ok: true, sessionId, cwd, createdAt, listed };
}

/**
 * Delete an archived session for good.
 *
 * The normal delete already unarchives, detaches and moves the log into the
 * plugin's trash - erasing it is then the trash's own purge, so the two paths
 * cannot drift apart.
 */
export async function forgetArchivedSession(ctx, sessionId) {
  const result = await trashSession(ctx, sessionId);
  if (result.ok !== true) return result;
  let purged = false;
  if (typeof result.trash === "string" && result.trash !== "") {
    const name = result.trash.split(/[/\\]/).filter((part) => part !== "").pop();
    if (typeof name === "string" && name !== "") {
      try {
        purged = (await purgeTrashEntry(name)).ok === true;
      } catch {
        purged = false;
      }
    }
  }
  return { ok: true, sessionId, purged };
}

/**
 * POST { action, name?, sessionId? } -> the plugin's trash and the archive set.
 *
 * `list`/`restore`/`purge` address trash entries by directory name; `archived`
 * lists the archive set, and `unarchive`/`forget`/`delete` address sessions by id.
 */
/**
 * Handoff support: the newest assistant reply, and a place to park the document.
 *
 * The Client cannot read a Session log, so it polls this route while the current
 * Session writes its handoff. Saving is a plain markdown file under the DSH home,
 * which keeps a record the next Session can be pointed at.
 */
export async function handleHandoffRequest(ctx, req, res) {
  if ((req.method ?? "POST").toUpperCase() !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (!loopbackOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "origin not trusted" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const action = typeof body.action === "string" ? body.action : "tail";

  if (action === "save") {
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim() === "") {
      sendJson(res, 400, { ok: false, error: "nothing to save" });
      return;
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "session";
    const home = await dshHome();
    const directory = join(home, ".wsr", "handoff");
    try {
      await mkdir(directory, { recursive: true });
      const file = join(directory, `${sessionId}-${Date.now()}.md`);
      await writeFile(file, text, "utf8");
      sendJson(res, 200, { ok: true, path: file });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (sessionId === "") {
    sendJson(res, 400, { ok: false, error: "sessionId is required" });
    return;
  }
  let events;
  try {
    events = await readSessionEvents(ctx, sessionId);
  } catch (error) {
    sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  let text = "";
  let at = 0;
  let replies = 0;
  /** `seq` of the newest assistant text; the Client compares it with its start. */
  let textSeq = 0;
  /** `seq` of the newest event of any kind (a turn can add tool steps). */
  let lastSeq = 0;
  /** Turn of the newest assistant text, so the card renders on that turn only. */
  let turn;
  let turnOpen = false;
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    if (typeof event.seq === "number" && event.seq > lastSeq) lastSeq = event.seq;
    if (event.type === "turn/start") {
      turnOpen = true;
      continue;
    }
    if (event.type === "turn/end") {
      turnOpen = false;
      continue;
    }
    if (event.type !== "assistant/message") continue;
    replies += 1;
    const content = event.data?.message?.content ?? event.data?.content;
    const parts = [];
    for (const block of Array.isArray(content) ? content : []) {
      if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    const joined = parts.join("\n").trim();
    if (joined !== "") {
      text = joined;
      at = typeof event.time === "number" ? event.time : 0;
      if (typeof event.seq === "number") textSeq = event.seq;
      if (typeof event.data?.turn === "number") turn = event.data.turn;
    }
  }
  sendJson(res, 200, { ok: true, text, at, replies, textSeq, lastSeq, turn, turnOpen });
}

export async function handleTrashListRequest(ctx, req, res) {
  if ((req.method ?? "POST").toUpperCase() !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (!loopbackOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "origin not trusted" });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const action = body !== null && typeof body.action === "string" ? body.action : "list";
    if (action === "list") {
      sendJson(res, 200, await listTrash());
      return;
    }
    if (action === "archived") {
      sendJson(res, 200, await listArchivedSessions(ctx));
      return;
    }
    if (action === "unarchive" || action === "forget" || action === "delete") {
      const sessionId = sessionIdFrom(req, body);
      if (sessionId === "") {
        sendJson(res, 400, { ok: false, error: "sessionId required" });
        return;
      }
      /* `delete` is the archived row's way into the recoverable trash; the other
         two either put the session back or erase it afterwards. */
      const result = action === "unarchive"
        ? await restoreArchivedSession(ctx, sessionId)
        : action === "forget"
          ? await forgetArchivedSession(ctx, sessionId)
          : await trashSession(ctx, sessionId);
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }
    const name = body !== null && typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") {
      sendJson(res, 400, { ok: false, error: "entry name required" });
      return;
    }
    if (action === "restore") {
      const result = await restoreTrashEntry(ctx, name);
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }
    if (action === "purge") {
      sendJson(res, 200, await purgeTrashEntry(name));
      return;
    }
    sendJson(res, 400, { ok: false, error: "unknown action" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** POST {} -> attach every session that belongs nowhere. */
export async function handleAdoptRequest(ctx, req, res) {
  if ((req.method ?? "POST").toUpperCase() !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (!loopbackOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "origin not trusted" });
    return;
  }
  try {
    sendJson(res, 200, await adoptOrphanSessions(ctx));
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** POST { sessionId, workspaceId } -> move that session to another workspace. */
export async function handleMoveRequest(ctx, req, res) {
  if ((req.method ?? "POST").toUpperCase() !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (!loopbackOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "origin not trusted" });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const sessionId = sessionIdFrom(req, body);
    const workspaceId = body !== null && typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    if (sessionId === "" || workspaceId === "") {
      sendJson(res, 400, { ok: false, error: "sessionId and workspaceId are required" });
      return;
    }
    const result = await moveSessionToWorkspace(ctx, sessionId, workspaceId);
    sendJson(res, result.ok ? 200 : 500, result);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** POST { sessionId } -> token statistics for that session. */
export async function handleStatsRequest(ctx, req, res) {
  if ((req.method ?? "POST").toUpperCase() !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (!loopbackOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "origin not trusted" });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const sessionId = sessionIdFrom(req, body);
    if (sessionId === "") {
      sendJson(res, 400, { ok: false, error: "sessionId required" });
      return;
    }
    const result = await sessionStatistics(ctx, sessionId);
    sendJson(res, result.ok ? 200 : 404, result);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Cordis entry point.
 *
 * `apply` itself must not wait for services: the Client half is served from this
 * same package, and a plugin whose row never applies still shows its sidebar
 * menu while none of its routes exist. So every capability is injected in its
 * own nested scope, and the health route reports what actually mounted - the
 * panel calls it to say "host plugin not loaded" instead of an empty 405.
 */
export function apply(ctx) {
  try {
    if (typeof ctx.inject !== "function") return;
    ctx.inject(["webServer"], (webCtx) => {
      const server = webCtx.webServer;
      if (server === undefined || server === null) return;
      webCtx.effect(() => server.register({
        kind: "exact",
        path: HEALTH_PATH,
        handler: (req, res) => sendJson(res, 200, {
          ok: true,
          version: HOST_VERSION,
          routes: { stats: statsMounted, trash: trashMounted, move: moveMounted },
        }),
      }), "ws-recency: health route");

      webCtx.inject(["sessionPersistence"], (statsCtx) => {
        statsMounted = true;
        webCtx.effect(() => server.register({
          kind: "exact",
          path: STATS_SESSION_PATH,
          handler: (req, res) => handleStatsRequest(statsCtx, req, res),
        }), "ws-recency: stats route");
      });

      webCtx.inject(["sessionPersistence", "workspaceRegistry", "sessions"], (moveCtx) => {
        moveMounted = true;
        webCtx.effect(() => server.register({
          kind: "exact",
          path: MOVE_SESSION_PATH,
          handler: (req, res) => handleMoveRequest(moveCtx, req, res),
        }), "ws-recency: move route");
        webCtx.effect(() => server.register({
          kind: "exact",
          path: TRASH_LIST_PATH,
          handler: (req, res) => handleTrashListRequest(moveCtx, req, res),
        }), "ws-recency: trash route");
        webCtx.effect(() => server.register({
          kind: "exact",
          path: ADOPT_SESSION_PATH,
          handler: (req, res) => handleAdoptRequest(moveCtx, req, res),
        }), "ws-recency: adopt route");
      });

      webCtx.inject(["sessionPersistence"], (handoffCtx) => {
        webCtx.effect(() => server.register({
          kind: "exact",
          path: HANDOFF_PATH,
          handler: (req, res) => handleHandoffRequest(handoffCtx, req, res),
        }), "ws-recency: handoff route");
      });

      webCtx.inject(["sessionPersistence", "workspaceRegistry", "sessions"], (trashCtx) => {
        trashMounted = true;
        webCtx.effect(() => server.register({
          kind: "exact",
          path: TRASH_SESSION_PATH,
          handler: (req, res) => handleTrashRequest(trashCtx, req, res),
        }), "ws-recency: trash route");
      });
    });
  } catch {
    /* a headless profile simply gets no routes */
  }
}

let statsMounted = false;
let trashMounted = false;
let moveMounted = false;
