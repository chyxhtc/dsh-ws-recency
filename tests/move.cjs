#!/usr/bin/env node
/**
 * Host-side check for the workspace move: the log is parked in the trash, the
 * session is re-created with the target cwd, the workspace bookkeeping follows,
 * and a failed attach rolls the original log back into place.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(path.join(__dirname, "..", "index.js")).href;

function fixture(root) {
  const oldCwd = path.join(root, "old-workspace");
  const targetCwd = path.join(root, "target-workspace");
  fs.mkdirSync(oldCwd, { recursive: true });
  fs.mkdirSync(targetCwd, { recursive: true });
  const sourceDir = path.join(root, "sessions", "old-project", "sid");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "session.v4.jsonl.zstd"), "log");

  const events = [
    { type: "user/message", seq: 0, data: { message: { content: [{ type: "text", text: "hi" }] } } },
    { type: "assistant/message", seq: 1, data: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 }, message: { content: [{ type: "text", text: "hello" }] } } },
  ];

  const state = {
    header: { id: "sid", cwd: oldCwd, createdAt: 1234, version: 4 },
    appended: null,
    newDir: path.join(root, "sessions", "target-project", "sid"),
    detached: [],
    attached: [],
    attachFails: false,
    projcacheDeleted: false,
    stopped: false,
  };

  const persistence = {
    stat: async () => ({ header: state.header, sizeBytes: 3, revision: "r1" }),
    locate: (meta) => ({ path: path.join(root, "sessions", meta.cwd === targetCwd ? "target-project" : "old-project", meta.id, "session.v4.jsonl.zstd") }),
    open: async () => ({ read: async () => ({ events }), close: async () => {} }),
    create: async (header) => {
      fs.mkdirSync(state.newDir, { recursive: true });
      return {
        append: async (batch) => { state.appended = batch; },
        flush: async () => {},
        close: async () => {},
        header,
      };
    },
  };

  const workspaces = [
    {
      id: "w-old",
      path: oldCwd,
      sessionIds: ["sid"],
      title: "old",
      detachSession: async (id) => { state.detached.push(id); },
      attachSession: async (id) => { state.attached.push(id); },
    },
    {
      id: "w-target",
      path: targetCwd,
      sessionIds: [],
      title: "target",
      attachSession: async (id) => {
        if (state.attachFails) throw new Error("refused");
        state.attached.push(id);
      },
    },
  ];

  const live = { header: { ...state.header } };
  const ctx = {
    sessionPersistence: persistence,
    sessions: { get: (id) => (id === "sid" ? live : undefined) },
    workspaceRegistry: {
      list: () => workspaces,
      indexHeader: async (header) => { live.header = header; },
      readSessionHeader: async () => live.header,
    },
    parallel: async () => { state.stopped = true; },
    get: (name) => (name === "storageDomain"
      ? { get: () => ({ table: () => ({ delete: async () => { state.projcacheDeleted = true; } }) }) }
      : undefined),
    emit() {},
  };

  return { ctx, state, live, oldCwd, targetCwd, sourceDir, root };
}

(async () => {
  const mod = await import(modulePath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsr-move-"));
  process.env.DSH_HOME = root;

  /* ---------- success -------------------------------------------------- */
  {
    const f = fixture(path.join(root, "ok"));
    /* The rewritten header is what `stat` reports after the create. */
    const originalCreate = f.ctx.sessionPersistence.create;
    f.ctx.sessionPersistence.create = async (header) => {
      const handle = await originalCreate(header);
      f.state.header = header;
      return handle;
    };

    const result = await mod.moveSessionToWorkspace(f.ctx, "sid", "w-target");
    assert.strictEqual(result.ok, true, "the move reports success");
    assert.deepStrictEqual(f.state.appended, [
      { type: "user/message", seq: 0, data: { message: { content: [{ type: "text", text: "hi" }] } } },
      { type: "assistant/message", seq: 1, data: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 }, message: { content: [{ type: "text", text: "hello" }] } } },
    ], "every event is carried over");
    assert.strictEqual(f.state.stopped, true, "the session is stopped first");
    assert.deepStrictEqual(f.state.detached, ["sid"], "detached from the old workspace");
    assert.deepStrictEqual(f.state.attached, ["sid"], "attached to the target");
    assert.strictEqual(f.state.projcacheDeleted, true, "the projection cache is dropped");
    assert.strictEqual(fs.existsSync(f.sourceDir), false, "the old log directory is parked");
    assert.ok(fs.existsSync(result.backup), "the backup exists in the trash");
    assert.strictEqual(result.path, f.targetCwd);
  }

  /* ---------- an open session's header follows the move ---------------- */
  {
    const f = fixture(path.join(root, "live"));
    f.ctx.sessionPersistence.create = async (header) => {
      f.state.header = header;
      fs.mkdirSync(f.state.newDir, { recursive: true });
      return { append: async () => {}, flush: async () => {}, close: async () => {} };
    };
    const result = await mod.moveSessionToWorkspace(f.ctx, "sid", "w-target");
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(f.live.header.cwd, f.targetCwd, "the live session object carries the new cwd");
    assert.deepStrictEqual(f.state.attached, ["sid"]);
  }

  /* ---------- a stale in-memory header asks for a restart -------------- */
  {
    const f = fixture(path.join(root, "stale"));
    f.ctx.sessionPersistence.create = async (header) => {
      f.state.header = header;
      fs.mkdirSync(f.state.newDir, { recursive: true });
      return { append: async () => {}, flush: async () => {}, close: async () => {} };
    };
    f.ctx.workspaceRegistry.readSessionHeader = async () => ({ cwd: f.oldCwd });
    f.ctx.workspaceRegistry.indexHeader = async () => {};
    const result = await mod.moveSessionToWorkspace(f.ctx, "sid", "w-target");
    assert.strictEqual(result.ok, false);
    assert.ok(String(result.error).indexOf("restart") !== -1, result.error);
    assert.strictEqual(fs.existsSync(f.sourceDir), true, "nothing is left half moved");
  }

  /* ---------- a refused attach rolls the log back ---------------------- */
  {
    const f = fixture(path.join(root, "rollback"));
    f.state.attachFails = true;
    f.ctx.sessionPersistence.create = async (header) => {
      f.state.header = header;
      fs.mkdirSync(f.state.newDir, { recursive: true });
      return { append: async (batch) => { f.state.appended = batch; }, flush: async () => {}, close: async () => {} };
    };
    const result = await mod.moveSessionToWorkspace(f.ctx, "sid", "w-target");
    assert.strictEqual(result.ok, false, "a refused attach is reported");
    assert.ok(String(result.error).indexOf("refused") !== -1, result.error);
    assert.strictEqual(fs.existsSync(f.sourceDir), true, "the original log is back in place");
    assert.strictEqual(fs.existsSync(f.state.newDir), false, "the half-written log is removed");
  }

  /* ---------- input guards --------------------------------------------- */
  {
    const f = fixture(path.join(root, "guards"));
    assert.strictEqual((await mod.moveSessionToWorkspace(f.ctx, "sid", "nope")).ok, false);
    const same = await mod.moveSessionToWorkspace(f.ctx, "sid", f.oldCwd);
    assert.strictEqual(same.ok, true, "a session already in the target is repaired, not refused");
    assert.strictEqual(same.repaired, true);
    assert.deepStrictEqual(f.state.attached, ["sid"], "the repair attaches it to its own workspace");
  }

  /* ---------- adopting sessions that belong nowhere ------------------- */
  {
    const target = { id: "w", path: "D:\\proj", sessionIds: [], attachSession: async (id) => { target.sessionIds.push(id); } };
    const ctx = {
      sessionPersistence: {
        list: async () => [
          { header: { id: "orphan", cwd: "D:\\proj" } },
          { header: { id: "listed", cwd: "D:\\proj" } },
          { header: { id: "elsewhere", cwd: "D:\\other" } },
        ],
      },
      workspaceRegistry: { list: () => [{ ...target, sessionIds: ["listed"] }, target] },
    };
    const result = await mod.adoptOrphanSessions(ctx);
    assert.deepStrictEqual(result.adopted, ["orphan"], "only the unlisted matching session is adopted");
    assert.deepStrictEqual(target.sessionIds, ["orphan"]);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log("move ok: success path, rollback, guards");
})();
