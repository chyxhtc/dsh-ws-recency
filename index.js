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
 * @module dsh-ws-recency
 */
import { mkdir, readdir, rename, rm, stat as statPath } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Cordis plugin name shown by the loader. */
export const name = "ws-recency";

/** Version marker reported by the health route. */
export const HOST_VERSION = "0.10.1";

/**
 * Exact routes the client half calls. Registered on the bare web server, so they
 * win over the SPA's fallback (which answers unknown POSTs with an empty 405).
 */
export const TRASH_SESSION_PATH = "/ws-recency/session-trash";
export const STATS_SESSION_PATH = "/ws-recency/session-stats";
export const HEALTH_PATH = "/ws-recency/health";
export const MOVE_SESSION_PATH = "/ws-recency/session-move";

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

  for (const workspace of ctx.workspaceRegistry.list()) {
    if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue;
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
        }
        const content = data.message !== null && data.message !== undefined ? data.message.content : undefined;
        for (const block of Array.isArray(content) ? content : []) {
          if (block === null || typeof block !== "object") continue;
          if (block.type === "reasoning") summary.estimate.agent.reasoning += estimateTokens(block.text);
          else if (block.type === "text") summary.estimate.agent.text += estimateTokens(block.text);
          else if (block.type === "tool-call" && block.id !== undefined) callNames.set(String(block.id), block.name);
        }
        break;
      }
      case "tool/call": {
        const name = data.name;
        if (data.callId !== undefined) callNames.set(String(data.callId), name);
        const entry = toolOf(name);
        entry.calls += 1;
        entry.args += estimateTokens(data.arguments);
        break;
      }
      case "tool/result": {
        const name = callNames.get(String(data.toolCallId ?? data.message?.source?.callId ?? ""));
        const entry = toolOf(name);
        entry.results += estimateTokens(blockText(data.message !== null && data.message !== undefined ? data.message.content : data.content));
        break;
      }
      case "user/message": {
        summary.estimate.agent.user += estimateTokens(blockText(data.message !== null && data.message !== undefined ? data.message.content : data.content));
        break;
      }
      case "system/message": {
        summary.estimate.agent.system += estimateTokens(blockText(data.message !== null && data.message !== undefined ? data.message.content : data.content));
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
  if (header.cwd === targetPath) return { ok: false, error: "already in that workspace" };

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

  /* Attach first, detach second: a refused attach must not orphan the session. */
  try {
    await target.attachSession(sessionId);
  } catch (error) {
    await rollback();
    return { ok: false, error: `the workspace refused the attach: ${error instanceof Error ? error.message : String(error)}` };
  }

  const detached = [];
  for (const workspace of workspaces) {
    if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue;
    if (workspace.id === target.id) continue;
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

  return { ok: true, workspace: target.id, path: targetPath, detached, backup };
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

      webCtx.inject(["sessionPersistence", "workspaceRegistry"], (moveCtx) => {
        moveMounted = true;
        webCtx.effect(() => server.register({
          kind: "exact",
          path: MOVE_SESSION_PATH,
          handler: (req, res) => handleMoveRequest(moveCtx, req, res),
        }), "ws-recency: move route");
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
