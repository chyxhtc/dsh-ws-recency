#!/usr/bin/env node
/**
 * Host-side check for the trash panel: listing, restoring (files back under the
 * recorded cwd's project key, workspace re-attached) and permanent deletion.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(path.join(__dirname, "..", "index.js")).href;

(async () => {
  const mod = await import(modulePath);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wsr-trash-"));
  process.env.DSH_HOME = home;

  /* ---------- the project key matches the session store's own naming ---- */
  assert.strictEqual(mod.projectKey("D:\\proj"), "--D-proj--");
  assert.strictEqual(mod.projectKey("C:\\Users\\Konka\\Hypers Work\\workspace"), "--C-Users-Konka-Hypers~0020Work-workspace--");

  /* ---------- listing --------------------------------------------------- */
  const root = path.join(home, ".trash", "ws-recency");
  const deleted = path.join(root, "session-a-2026-11-02T06-42-47-578Z");
  const backup = path.join(root, "session-b-move-123");
  fs.mkdirSync(deleted, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(deleted, "session.v4.jsonl.zstd"), "0123456789");
  fs.writeFileSync(path.join(deleted, ".wsr-trash.json"), JSON.stringify({ sessionId: "session-a", cwd: "D:\\proj", reason: "delete", at: 2000 }));
  fs.writeFileSync(path.join(backup, "session.v4.jsonl.zstd"), "01234");
  fs.writeFileSync(path.join(backup, ".wsr-trash.json"), JSON.stringify({ sessionId: "session-b", cwd: "D:\\other", reason: "move", at: 1000 }));

  const listing = await mod.listTrash();
  assert.strictEqual(listing.ok, true);
  assert.strictEqual(listing.entries.length, 2);
  const first = listing.entries[0];
  assert.strictEqual(first.sessionId, "session-a", "newest entry first");
  assert.strictEqual(first.sizeBytes, 10, "the sidecar is not counted as payload");
  assert.strictEqual(first.restorable, true, "a deleted session can be restored");
  assert.strictEqual(listing.entries[1].restorable, false, "a move backup is not restorable");

  /* ---------- restore --------------------------------------------------- */
  const attached = [];
  const emitted = [];
  const ctx = {
    workspaceRegistry: { list: () => [{ id: "w", path: "D:\\proj", attachSession: async (id) => { attached.push(id); } }] },
    emit: (event, payload) => emitted.push([event, payload]),
    /* The Host reads messages through the same seam the sidebar uses; the
       restore needs one for its first line, so give it a tiny real log file. */
    sessionPersistence: {
      stat: async (id) => {
        const file = path.join(home, "sessions", "--D-proj--", id, "session.v4.jsonl.zstd");
        return fs.existsSync(file) ? { header: { id, cwd: "D:\\proj", createdAt: 1000 }, sizeBytes: 10 } : undefined;
      },
      open: async (id) => {
        const events = [
          { type: "session", id, cwd: "D:\\proj" },
          { type: "session/title", data: { title: "restored" } },
          { type: "turn/start", time: 1100, data: { turn: 1 } },
          { type: "user/message", time: 1100, data: { turn: 1, message: { content: [{ type: "text", text: "first prompt" }] } } },
        ];
        return { read: async (offset) => ({ events: offset === 0 ? events : [] }), close: async () => {} };
      },
    },
  };
  const restored = await mod.restoreTrashEntry(ctx, "session-a-2026-11-02T06-42-47-578Z");
  assert.strictEqual(restored.ok, true, restored.error);
  assert.deepStrictEqual(attached, ["session-a"], "the session is re-attached to its workspace");
  const restoredFile = path.join(home, "sessions", "--D-proj--", "session-a", "session.v4.jsonl.zstd");
  assert.strictEqual(fs.readFileSync(restoredFile, "utf8"), "0123456789", "the log is back under its project key");
  assert.strictEqual(fs.existsSync(deleted), false, "the trash entry is gone");
  /* A restored session is unknown to the running Host, so the browser only gets
     a row if the summary is broadcast (otherwise it appeared after a restart). */
  assert.strictEqual(emitted.some(([event, payload]) => event === "api-session/added" && payload.sessionId === "session-a"), true, "the sidebar is told about the restored row");
  assert.strictEqual(emitted.length, 1, "one announce, not a stream of them");
  /* The sidebar groups rows through list-surface projections: without them the
     summary lands in the list but never inside a workspace group, which is what
     made a restored session look invisible until the next restart. */
  const announced = emitted[0][1];
  assert.strictEqual(announced.projections.kind, "cached", "the announce carries list-surface projections");
  assert.strictEqual(announced.projections.values.title, "restored", "the title comes from the log when the cache has no record");
  assert.ok(announced.projections.values.lastPromptAt > 0, "the last prompt time comes with it");

  /* ---------- delete keeps the archive flag; restore clears it ----------- */
  /* A trashed log leaves `sessions/`, so only the archive flag tells the rest of
     the app (dsh-context included) that the session is put away. */
  const flags = [];
  let archived = new Set();
  const liveCtx = {
    workspaceRegistry: {
      get archivedSessionIds() { return [...archived]; },
      list: () => [{ id: "w2", path: "D:\\keep", sessionIds: ["session-live"], attachSession: async () => {}, detachSession: async () => {} }],
      archiveSession: async (id) => { archived.add(id); flags.push(["archive", id]); },
      unarchiveSession: async (id) => { archived.delete(id); flags.push(["unarchive", id]); },
      unpinSession: async () => {},
    },
    get: () => undefined,
    sessionPersistence: {
      stat: async (id) => (fs.existsSync(path.join(home, "sessions", "--D-keep--", id)) ? { header: { id, cwd: "D:\\keep", createdAt: 1 }, sizeBytes: 1 } : undefined),
    },
    sessions: { get: () => undefined },
    parallel: async () => {},
    emit: () => {},
  };
  const liveDir = path.join(home, "sessions", "--D-keep--", "session-live");
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, "session.v4.jsonl.zstd"), "live");

  const deletedLive = await mod.trashSession(liveCtx, "session-live");
  assert.strictEqual(deletedLive.ok, true, deletedLive.error);
  assert.strictEqual(archived.has("session-live"), true, "a deleted session keeps its archive flag");
  assert.deepStrictEqual(flags.filter(([kind]) => kind === "archive"), [["archive", "session-live"]], "the flag is set once, before the move");
  assert.strictEqual(fs.existsSync(liveDir), false, "the log left its directory");
  const deletedEntry = fs.readdirSync(path.join(home, ".trash", "ws-recency")).find((name) => name.startsWith("session-live-"));
  const deletedSidecar = JSON.parse(fs.readFileSync(path.join(home, ".trash", "ws-recency", deletedEntry, ".wsr-trash.json"), "utf8"));
  assert.strictEqual(deletedSidecar.archived, true, "the sidecar records that an unarchive is owed");

  const restoredLive = await mod.restoreTrashEntry(liveCtx, deletedEntry);
  assert.strictEqual(restoredLive.ok, true, restoredLive.error);
  const order = flags.map(([kind]) => kind);
  assert.deepStrictEqual(order, ["archive", "unarchive"], "restore clears the flag after the files are back");
  assert.strictEqual(archived.has("session-live"), false, "the session is no longer archived");

  /* Purging a trashed entry drops the flag before the files go. */
  const purgedLive = await mod.trashSession(liveCtx, "session-live");
  const purgedEntry = fs.readdirSync(path.join(home, ".trash", "ws-recency")).find((name) => name.startsWith("session-live-"));
  assert.strictEqual(archived.has("session-live"), true, "still archived while it sits in the trash");
  assert.strictEqual((await mod.purgeTrashEntry(purgedEntry, liveCtx)).ok, true);
  assert.strictEqual(archived.has("session-live"), false, "purging drops the flag");

  /* A failed move puts the flag back, so the session is not hidden by accident. */
  let failedArchived = new Set();
  const failingCtx = {
    ...liveCtx,
    workspaceRegistry: {
      get archivedSessionIds() { return [...failedArchived]; },
      list: () => [{ id: "w3", path: "D:\\fails", sessionIds: ["session-fails"], attachSession: async () => {}, detachSession: async () => {} }],
      archiveSession: async (id) => { failedArchived.add(id); },
      unarchiveSession: async (id) => { failedArchived.delete(id); },
      unpinSession: async () => {},
    },
    sessionPersistence: { stat: async () => ({ header: { id: "session-fails", cwd: "D:\\missing-on-purpose", createdAt: 1 }, sizeBytes: 1 }) },
  };
  const failed = await mod.trashSession(failingCtx, "session-fails");
  assert.strictEqual(failed.ok, false, "a log that is not on disk fails the delete");
  assert.strictEqual(failedArchived.has("session-fails"), false, "the flag is rolled back");

  /* ---------- purge ----------------------------------------------------- */
  assert.strictEqual((await mod.purgeTrashEntry("session-b-move-123")).ok, true);
  assert.strictEqual(fs.existsSync(backup), false);
  assert.strictEqual((await mod.purgeTrashEntry("../escape")).ok, false, "path traversal is refused");

  /* ---------- an entry without a manifest is not restorable ------------- */
  const legacy = path.join(root, "legacy-entry");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "session.v4.jsonl.zstd"), "x");
  const after = await mod.listTrash();
  const legacyEntry = after.entries.find((entry) => entry.name === "legacy-entry");
  assert.strictEqual(legacyEntry.restorable, false);
  const refused = await mod.restoreTrashEntry(ctx, "legacy-entry");
  assert.strictEqual(refused.ok, false);

  /* ---------- card facts come from the parked log ----------------------- */
  const zlib = require("node:zlib");
  if (typeof zlib.zstdCompressSync === "function") {
    const cardDir = path.join(root, "session-c-2026-11-02T07-00-00-000Z");
    fs.mkdirSync(cardDir, { recursive: true });
    const events = [
      { type: "session", id: "session-c", cwd: "D:\\proj", createdAt: 1000 },
      { type: "session/title", data: { title: "回收站卡片测试" } },
      { type: "turn/start", data: {} },
      { type: "user/message", data: { message: { content: [{ type: "text", text: "hi" }] } } },
      { type: "assistant/message", data: { usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 50, totalTokens: 350 }, message: { content: [{ type: "text", text: "hello" }] } } },
      { type: "turn/start", data: {} },
      { type: "user/message", data: { message: { content: [{ type: "text", text: "again" }] } } },
      { type: "assistant/message", data: { usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 5, totalTokens: 35 }, message: { content: [{ type: "text", text: "ok" }] } } },
    ];
    const encode = (list) => zlib.zstdCompressSync(Buffer.from(list.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8"));
    const split = Math.ceil(events.length / 2);
    fs.writeFileSync(path.join(cardDir, "session.v4.jsonl.zstd"), Buffer.concat([encode(events.slice(0, split)), encode(events.slice(split))]));
    fs.writeFileSync(path.join(cardDir, ".wsr-trash.json"), JSON.stringify({ sessionId: "session-c", cwd: "D:\\proj", reason: "delete", at: 3000 }));
    const withCard = await mod.listTrash();
    const card = withCard.entries.find((entry) => entry.name === "session-c-2026-11-02T07-00-00-000Z");
    assert.strictEqual(card.title, "回收站卡片测试", "the title comes out of the parked log");
    assert.strictEqual(card.turns, 2);
    assert.strictEqual(card.steps, 2);
    assert.strictEqual(card.tokens, 385);
    const cached = JSON.parse(fs.readFileSync(path.join(cardDir, ".wsr-trash.json"), "utf8"));
    assert.ok(cached.meta !== undefined && cached.meta.title === "回收站卡片测试", "card facts are cached in the sidecar");
  } else {
    console.log("(zstd unavailable: card facts skipped)");
  }

  fs.rmSync(home, { recursive: true, force: true });
  console.log("trash ok: projectKey, list, restore, purge, guards");
})();
