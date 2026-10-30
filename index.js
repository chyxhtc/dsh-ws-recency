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
import { mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Cordis plugin name shown by the loader. */
export const name = "ws-recency";

/** Host services this module asks for; `webServer` is injected separately. */
export const inject = ["sessionPersistence", "workspaceRegistry", "sessions"];

/** Exact route the client half calls. */
export const TRASH_SESSION_PATH = "/ws-recency/session-trash";

const STOP_SETTLE_MS = 500;
const MAX_BODY_BYTES = 16 * 1024;
const RENAME_RETRY = 4;
const RENAME_GAP_MS = 150;

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
    const sessionId = body !== null && typeof body.sessionId === "string" ? body.sessionId.trim() : "";
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

/** Cordis entry point: mount the route when the host has a web server. */
export function apply(ctx) {
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
          kind: "exact",
          path: TRASH_SESSION_PATH,
          handler: (req, res) => handleTrashRequest(ctx, req, res),
        }), "ws-recency: trash route");
      });
    }
  } catch {
    /* a headless profile simply gets no route */
  }
}
