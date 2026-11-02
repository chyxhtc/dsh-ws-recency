#!/usr/bin/env node
/**
 * Host-side check for the archive half of the trash panel: listing the archive
 * set (titles, owning workspace, ordering), unarchiving back into the workspace,
 * and the two ways out (recoverable delete into the trash, permanent delete).
 *
 * The Host's archive is only `archivedSessionIds`, so these paths are exercised
 * against a stand-in registry, persistence service and projection cache.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(path.join(__dirname, "..", "index.js")).href;

/** A stand-in request: the body reader only needs an async iterator. */
function fakeRequest(payload) {
  const text = JSON.stringify(payload);
  return {
    method: "POST",
    url: "/ws-recency/trash",
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, "utf8");
    },
  };
}

function fakeResponse() {
  return {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
    json() { return JSON.parse(this.body); },
  };
}

(async () => {
  const mod = await import(modulePath);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wsr-archive-"));
  process.env.DSH_HOME = home;

  const archived = new Set(["session-new", "session-old", "session-gone", "session-titled", "session-untitled"]);
  const emitted = [];
  const attached = [];
  const unarchived = [];

  const headers = {
    "session-new": { id: "session-new", cwd: "D:\\proj", createdAt: 1000 },
    "session-old": { id: "session-old", cwd: "D:\\proj", createdAt: 2000 },
    /* Its workspace is gone: nothing holds its slot any more. */
    "session-gone": { id: "session-gone", cwd: "D:\\unregistered", createdAt: 3000 },
    "session-routed": { id: "session-routed", cwd: "D:\\proj", createdAt: 4000 },
    /* No projection-cache record at all: the title has to come from the log. */
    "session-titled": { id: "session-titled", cwd: "D:\\proj", createdAt: 600 },
    "session-untitled": { id: "session-untitled", cwd: "D:\\proj", createdAt: 500 },
  };
  const logs = {
    "session-titled": [
      { type: "session", id: "session-titled", cwd: "D:\\proj" },
      { type: "session/title", data: { title: "named from the log" } },
      { type: "user/message", data: { content: "never used" } },
    ],
    "session-untitled": [{ type: "session", id: "session-untitled", cwd: "D:\\proj" }],
  };
  const checkpoints = {
    "session-new": {
      rows: {
        title: { ver: 1, seq: 9, val: "a real title" },
        sessionListMetadata: { ver: 1, seq: 9, val: { blank: false, lastPromptAt: 5000 } },
      },
    },
    /* No title row: the first prompt is the sidebar's own fallback. */
    "session-old": {
      rows: {
        turnOutline: { ver: 2, seq: 9, val: { turns: [{ prompt: "first prompt line\nsecond line" }] } },
        sessionListMetadata: { ver: 1, seq: 9, val: { blank: false, lastPromptAt: 9000 } },
      },
    },
    "session-gone": {
      rows: {
        title: { ver: 1, seq: 9, val: "orphan" },
        sessionListMetadata: { ver: 1, seq: 9, val: { blank: true, lastPromptAt: 4000 } },
      },
    },
  };

  const registry = {
    get archivedSessionIds() { return [...archived]; },
    list: () => [
      {
        id: "w-proj",
        path: "D:\\proj",
        sessionIds: ["session-new"],
        attachSession: async (id) => { attached.push(id); },
        detachSession: async () => {},
      },
    ],
    unarchiveSession: async (id) => { archived.delete(id); unarchived.push(id); },
    unpinSession: async () => {},
  };

  const ctx = {
    workspaceRegistry: registry,
    get: (name) => {
      if (name === "sessionController") return undefined;
      if (name === "storageDomain") {
        return {
          get: (domain) => (domain === "session_projcache"
            ? { table: () => ({ get: (id) => checkpoints[id], delete: async () => {} }) }
            : undefined),
        };
      }
      return undefined;
    },
    sessionPersistence: {
      list: async () => Object.values(headers).map((header) => ({ header, sizeBytes: header.id === "session-new" ? 2048 : 64 })),
      stat: async (id) => (headers[id] === undefined ? undefined : { header: headers[id], sizeBytes: 64 }),
      open: async (id) => {
        const events = logs[id];
        if (events === undefined) throw new Error("this stand-in has no log");
        return {
          read: async (offset, limit) => ({ events: events.slice(offset, offset + limit) }),
          close: async () => {},
        };
      },
    },
    sessions: { get: () => undefined },
    parallel: async () => {},
    emit: (event, payload) => { emitted.push([event, payload]); },
  };

  /* ---------- listing ---------------------------------------------------- */
  const listing = await mod.listArchivedSessions(ctx);
  assert.strictEqual(listing.ok, true);
  assert.deepStrictEqual(
    listing.entries.map((entry) => entry.sessionId),
    ["session-old", "session-new", "session-gone", "session-titled", "session-untitled"],
    "newest activity first, then the sessions with only a createdAt",
  );
  const fresh = listing.entries.find((entry) => entry.sessionId === "session-new");
  assert.strictEqual(fresh.title, "a real title", "the cached title is used");
  assert.strictEqual(fresh.sizeBytes, 2048, "the log size comes from the listing");
  assert.strictEqual(fresh.workspaceId, "w-proj", "the owning workspace comes from its slot");
  assert.strictEqual(fresh.listed, true, "the slot matches its cwd");
  const old = listing.entries.find((entry) => entry.sessionId === "session-old");
  assert.strictEqual(old.title, "first prompt line", "the first prompt is the title fallback");
  const gone = listing.entries.find((entry) => entry.sessionId === "session-gone");
  assert.strictEqual(gone.workspaceId, null, "a workspace that no longer exists is not claimed");
  assert.strictEqual(gone.listed, false);
  assert.strictEqual(gone.blank, true, "the blank-draft hint is carried through");

  const titled = listing.entries.find((entry) => entry.sessionId === "session-titled");
  assert.strictEqual(titled.title, "named from the log", "a session the cache never saw takes its title from the log");
  const untitled = listing.entries.find((entry) => entry.sessionId === "session-untitled");
  assert.strictEqual(untitled.title, "", "a session with neither a cache row nor a title event stays untitled");

  const empty = await mod.listArchivedSessions({ ...ctx, workspaceRegistry: { get archivedSessionIds() { return []; }, list: () => [] } });
  assert.deepStrictEqual(empty.entries, [], "an empty archive set is not an error");

  /* ---------- unarchive -------------------------------------------------- */
  const unarchive = await mod.restoreArchivedSession(ctx, "session-old");
  assert.strictEqual(unarchive.ok, true, unarchive.error);
  assert.deepStrictEqual(unarchived, ["session-old"], "the durable flag is dropped");
  assert.deepStrictEqual(attached, ["session-old"], "a session with no slot is re-attached to the workspace whose path is its cwd");
  assert.strictEqual(unarchive.listed, true);
  assert.strictEqual(emitted.some(([event]) => event === "api-session/added"), true, "the sidebar is told about the row");
  const refused = await mod.restoreArchivedSession(ctx, "session-old");
  assert.strictEqual(refused.ok, false, "an id that is not archived is refused");

  /* ---------- delete for good ------------------------------------------- */
  const goneLog = path.join(home, "sessions", "--D-proj--", "session-gone");
  fs.mkdirSync(goneLog, { recursive: true });
  fs.writeFileSync(path.join(goneLog, "session.v4.jsonl.zstd"), "gone");
  headers["session-gone"] = { id: "session-gone", cwd: "D:\\proj", createdAt: 3000 };

  const forgotten = await mod.forgetArchivedSession(ctx, "session-gone");
  assert.strictEqual(forgotten.ok, true, forgotten.error);
  assert.strictEqual(forgotten.purged, true, "the trash copy is erased, not kept");
  assert.strictEqual(fs.existsSync(goneLog), false, "the log directory is gone");
  const trashRoot = path.join(home, ".trash", "ws-recency");
  const left = fs.existsSync(trashRoot) ? fs.readdirSync(trashRoot) : [];
  assert.deepStrictEqual(left, [], "nothing is left behind in the trash");
  assert.strictEqual(emitted.some(([event, id]) => event === "api-session/removed" && id === "session-gone"), true);

  /* ---------- the route dispatch ---------------------------------------- */
  const archivedResponse = fakeResponse();
  await mod.handleTrashListRequest(ctx, fakeRequest({ action: "archived" }), archivedResponse);
  assert.strictEqual(archivedResponse.status, 200);
  assert.strictEqual(archivedResponse.json().ok, true);
  assert.strictEqual(Array.isArray(archivedResponse.json().entries), true);

  const missing = fakeResponse();
  await mod.handleTrashListRequest(ctx, fakeRequest({ action: "unarchive" }), missing);
  assert.strictEqual(missing.status, 400, "an action that needs a session id says so");

  const unknown = fakeResponse();
  await mod.handleTrashListRequest(ctx, fakeRequest({ action: "nonsense", name: "entry" }), unknown);
  assert.strictEqual(unknown.status, 400);
  assert.strictEqual(unknown.json().ok, false);

  /* An archived row's recoverable delete is the plugin's normal trash path. */
  const routedLog = path.join(home, "sessions", "--D-proj--", "session-routed");
  fs.mkdirSync(routedLog, { recursive: true });
  fs.writeFileSync(path.join(routedLog, "session.v4.jsonl.zstd"), "routed");
  const deleted = fakeResponse();
  await mod.handleTrashListRequest(ctx, fakeRequest({ action: "delete", sessionId: "session-routed" }), deleted);
  assert.strictEqual(deleted.status, 200, deleted.body);
  assert.strictEqual(deleted.json().ok, true);
  const trashed = await mod.listTrash();
  assert.strictEqual(trashed.entries.length, 1, "the session now sits in the trash");
  assert.strictEqual(trashed.entries[0].sessionId, "session-routed");
  assert.strictEqual(trashed.entries[0].reason, "delete");
  assert.strictEqual(trashed.entries[0].restorable, true, "it can still be restored");
  const purged = fakeResponse();
  await mod.handleTrashListRequest(ctx, fakeRequest({ action: "purge", name: trashed.entries[0].name }), purged);
  assert.strictEqual(purged.json().ok, true);

  fs.rmSync(home, { recursive: true, force: true });
  console.log("archive ok: list, titles, unarchive, delete for good, route dispatch");
})();
