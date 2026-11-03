#!/usr/bin/env node
/**
 * Host-side check for the handoff route: the newest assistant reply (which the
 * Client polls while the current Session writes its handoff) and the markdown
 * copy saved under the DSH home.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(path.join(__dirname, "..", "index.js")).href;

function fakeRequest(payload, options = {}) {
  const text = JSON.stringify(payload);
  return {
    method: options.method ?? "POST",
    url: "/ws-recency/handoff",
    headers: options.headers ?? {},
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wsr-handoff-"));
  process.env.DSH_HOME = home;

  const events = [
    { type: "session", id: "session-h", cwd: "D:\\proj", seq: 1 },
    { type: "turn/start", time: 900, seq: 2, data: { turn: 1 } },
    { type: "assistant/message", time: 1000, seq: 3, data: { turn: 1, message: { content: [{ type: "text", text: "older reply" }] } } },
    { type: "turn/end", time: 1500, seq: 4, data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/start", time: 2000, seq: 5, data: { turn: 2 } },
    { type: "user/message", time: 2100, seq: 6, data: { message: { content: [{ type: "text", text: "now hand off" }] } } },
    {
      type: "assistant/message",
      time: 3000,
      seq: 7,
      data: {
        turn: 2,
        message: {
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "已写好交接：\n\n```handoff\n# 交接\n目标：完成插件\n文档：README.md（必读）\n```\n完。" },
          ],
        },
      },
    },
  ];

  const ctx = {
    sessionPersistence: {
      stat: async (id) => (id === "session-h" ? { header: { id, cwd: "D:\\proj" }, sizeBytes: 128 } : undefined),
      open: async () => ({
        read: async (offset, limit) => ({ events: events.slice(offset, offset + limit) }),
        close: async () => {},
      }),
    },
  };

  /* ---------- tail: the newest assistant text wins ---------------------- */
  let response = fakeResponse();
  await mod.handleHandoffRequest(ctx, fakeRequest({ action: "tail", sessionId: "session-h" }), response);
  assert.strictEqual(response.status, 200);
  let tail = response.json();
  assert.strictEqual(tail.ok, true, tail.error);
  assert.strictEqual(tail.replies, 2, "both replies are counted");
  assert.ok(tail.text.indexOf("```handoff") !== -1, "the newest reply is returned");
  assert.ok(tail.text.indexOf("older reply") === -1);
  assert.strictEqual(tail.at, 3000);
  assert.strictEqual(tail.textSeq, 7, "the newest text carries its log sequence");
  assert.strictEqual(tail.lastSeq, 7, "the newest event of any kind is reported");
  assert.strictEqual(tail.turn, 2, "the turn of the text is reported");
  assert.strictEqual(tail.turnOpen, true, "the turn is still running");

  /* a turn that ends makes the same text acceptable */
  events.push({ type: "turn/end", time: 3100, seq: 8, data: { turn: 2, reason: { kind: "completed" } } });
  response = fakeResponse();
  await mod.handleHandoffRequest(ctx, fakeRequest({ action: "tail", sessionId: "session-h" }), response);
  tail = response.json();
  assert.strictEqual(tail.turnOpen, false, "the closed turn is reported closed");
  assert.strictEqual(tail.lastSeq, 8);

  /* a new turn that has only logged tool steps must not look like a new text:
     textSeq stays on the previous reply, lastSeq moves on. */
  events.push({ type: "turn/start", time: 3200, seq: 9, data: { turn: 3 } });
  events.push({ type: "assistant/message", time: 3300, seq: 10, data: { turn: 3, message: { content: [{ type: "reasoning", text: "..." }, { type: "tool-call", id: "c1", name: "pwsh" }] } } });
  response = fakeResponse();
  await mod.handleHandoffRequest(ctx, fakeRequest({ action: "tail", sessionId: "session-h" }), response);
  tail = response.json();
  assert.strictEqual(tail.lastSeq, 10, "a tool step advances the log sequence");
  assert.strictEqual(tail.textSeq, 7, "the stale text keeps its own sequence");
  assert.strictEqual(tail.turnOpen, true, "the new turn is open");
  assert.strictEqual(tail.at, 3000, "the stale text keeps its timestamp");

  /* ---------- save: a markdown copy under the DSH home ------------------- */
  response = fakeResponse();
  await mod.handleHandoffRequest(ctx, fakeRequest({ action: "save", sessionId: "session-h", text: "# 交接\n内容" }), response);
  assert.strictEqual(response.status, 200);
  const saved = response.json();
  assert.strictEqual(saved.ok, true, saved.error);
  assert.ok(fs.existsSync(saved.path), "the handoff file exists");
  assert.strictEqual(fs.readFileSync(saved.path, "utf8"), "# 交接\n内容");
  assert.ok(saved.path.indexOf(path.join(".wsr", "handoff")) !== -1, "it lands in .wsr/handoff");

  /* ---------- guards ----------------------------------------------------- */
  response = fakeResponse();
  await mod.handleHandoffRequest(ctx, fakeRequest({ action: "save", text: "x" }, { method: "GET" }), response);
  assert.strictEqual(response.status, 405, "only POST is accepted");

  response = fakeResponse();
  await mod.handleHandoffRequest(ctx, fakeRequest({ action: "save", text: "x" }, { headers: { origin: "https://evil.example" } }), response);
  assert.strictEqual(response.status, 403, "a foreign origin is refused");

  response = fakeResponse();
  await mod.handleHandoffRequest(ctx, fakeRequest({ action: "save", text: "   " }), response);
  assert.strictEqual(response.status, 400, "an empty handoff is refused");

  response = fakeResponse();
  await mod.handleHandoffRequest(ctx, fakeRequest({ action: "tail" }), response);
  assert.strictEqual(response.status, 400, "a session id is required");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("handoff ok: tail, save, guards");
})();
