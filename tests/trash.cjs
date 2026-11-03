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
  const ctx = { workspaceRegistry: { list: () => [{ id: "w", path: "D:\\proj", attachSession: async (id) => { attached.push(id); } }] } };
  const restored = await mod.restoreTrashEntry(ctx, "session-a-2026-11-02T06-42-47-578Z");
  assert.strictEqual(restored.ok, true, restored.error);
  assert.deepStrictEqual(attached, ["session-a"], "the session is re-attached to its workspace");
  const restoredFile = path.join(home, "sessions", "--D-proj--", "session-a", "session.v4.jsonl.zstd");
  assert.strictEqual(fs.readFileSync(restoredFile, "utf8"), "0123456789", "the log is back under its project key");
  assert.strictEqual(fs.existsSync(deleted), false, "the trash entry is gone");

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
