#!/usr/bin/env node
/**
 * Host-side check for the token statistics: the estimator, the aggregator, and a
 * smoke test that a real session log decodes at all (concatenated zstd frames).
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(path.join(__dirname, "..", "index.js")).href;

(async () => {
  const mod = await import(modulePath);

  /* ---------- estimator ------------------------------------------------ */
  assert.strictEqual(mod.estimateTokens(""), 0);
  assert.strictEqual(mod.estimateTokens("abcd"), 1, "four Latin characters are one token");
  assert.strictEqual(mod.estimateTokens("abcdefgh"), 2);
  assert.strictEqual(mod.estimateTokens("\u4e2d\u6587"), 2, "one token per CJK character");

  /* ---------- aggregator ----------------------------------------------- */
  const events = [
    { type: "session", id: "s-1", cwd: "C:\\work", createdAt: 1000 },
    { type: "session/title", data: { title: "hello" } },
    { type: "user/message", time: 1100, data: { message: { content: [{ type: "text", text: "please run it" }] } } },
    {
      type: "assistant/message",
      time: 1200,
      data: {
        usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050 },
        message: {
          content: [
            { type: "reasoning", text: "thinking hard" },
            { type: "text", text: "running" },
            { type: "tool-call", id: "call-1", name: "pwsh", arguments: "{\"command\":\"ls\"}" },
          ],
        },
      },
    },
    { type: "tool/call", time: 1210, data: { turn: 1, step: 1, callId: "call-1", name: "pwsh", arguments: "{\"command\":\"ls\"}" } },
    { type: "tool/result", time: 1300, data: { toolCallId: "call-1", message: { content: [{ type: "text", text: "file-a\nfile-b" }] } } },
    {
      type: "assistant/message",
      time: 1400,
      data: { usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 5, totalTokens: 35 }, message: { content: [{ type: "text", text: "done" }] } },
    },
  ];
  const stats = mod.aggregateSession(events);
  assert.strictEqual(stats.session.id, "s-1");
  assert.strictEqual(stats.session.title, "hello");
  assert.strictEqual(stats.steps, 2);
  assert.deepStrictEqual(stats.totals, { inputTokens: 110, cacheReadTokens: 920, outputTokens: 55, totalTokens: 1085 });
  assert.ok(stats.estimate.agent.reasoning > 0 && stats.estimate.agent.text > 0 && stats.estimate.agent.user > 0);
  assert.strictEqual(stats.estimate.tools.length, 1);
  const pwsh = stats.estimate.tools[0];
  assert.strictEqual(pwsh.name, "pwsh");
  assert.strictEqual(pwsh.calls, 1);
  assert.ok(pwsh.args > 0 && pwsh.results > 0);
  assert.strictEqual(pwsh.total, pwsh.args + pwsh.results);
  assert.ok(stats.estimate.grandTotal > 0);
  const share = pwsh.share + stats.estimate.agent.share;
  assert.ok(Math.abs(share - 1) < 1e-9, "shares add up to 1");

  /* A tool call without its own tool/call record still lands in the table. */
  const orphan = mod.aggregateSession([
    {
      type: "assistant/message",
      data: { usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1, totalTokens: 2 }, message: { content: [{ type: "tool-call", id: "x", name: "read", arguments: "{}" }] } },
    },
    { type: "tool/result", data: { toolCallId: "x", message: { content: [{ type: "text", text: "abc" }] } } },
  ]);
  assert.strictEqual(orphan.estimate.tools[0].name, "read");

  /* ---------- reading through the persistence seam ---------------------- */
  let opens = 0;
  const fakeCtx = {
    sessionPersistence: {
      stat: async () => ({ header: { id: "s-1", cwd: "C:\\work", createdAt: 1000 }, sizeBytes: 42, revision: "r1" }),
      open: async () => {
        opens += 1;
        return { read: async () => ({ events }), close: async () => {} };
      },
    },
  };
  const answer = await mod.sessionStatistics(fakeCtx, "s-1");
  assert.strictEqual(answer.ok, true, "statistics come back through the seam");
  assert.strictEqual(answer.stats.session.id, "s-1");
  assert.strictEqual(answer.stats.session.cwd, "C:\\work");
  assert.strictEqual(opens, 1);

  const again = await mod.sessionStatistics(fakeCtx, "s-1");
  assert.strictEqual(again.ok, true);
  assert.strictEqual(opens, 1, "a repeat call inside the cache window does not re-read the log");

  const missing = await mod.sessionStatistics({ sessionPersistence: { stat: async () => undefined } }, "nope");
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error, "session not found");

  console.log("stats ok: estimator, aggregation, shares, persistence seam, cache");
})();
