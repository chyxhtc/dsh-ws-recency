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
  /* The client's argument/result split and its "arguments belong to the agent"
     mode both re-bucket these fields, so their arithmetic has to hold exactly. */
  assert.strictEqual(stats.estimate.grandTotal, stats.estimate.agent.total + stats.estimate.toolsTotal);
  assert.strictEqual(stats.estimate.toolsTotal, pwsh.total);
  const share = pwsh.share + stats.estimate.agent.share;
  assert.ok(Math.abs(share - 1) < 1e-9, "shares add up to 1");

  /* ---------- amplified cost: content x remaining steps ------------------ */
  const amplified = stats.amplified;
  assert.strictEqual(amplified.steps, 2);
  assert.strictEqual(amplified.bill, 1030, "the bill is the real per-step context sum");
  assert.deepStrictEqual(amplified.series.map((point) => point.context), [1000, 30], "the context curve comes from real usage");
  assert.ok(Math.abs(amplified.share - 18 / 1030) < 1e-9, "the attributed share is the amplified total over the bill");
  const topBlock = amplified.blocks.find((block) => block.kind === "tool");
  assert.ok(topBlock !== undefined, "the tool call is attributed");
  assert.strictEqual(topBlock.name, "pwsh");
  assert.strictEqual(topBlock.detail, "ls", "the argument JSON names what was touched");
  assert.strictEqual(topBlock.entry, 2, "it enters before the second step");
  assert.strictEqual(topBlock.remaining, 1, "one later step re-reads it");
  assert.strictEqual(topBlock.tokens, 8);
  assert.strictEqual(topBlock.amplified, 8, "one re-read leaves the tokens unchanged");
  assert.strictEqual(topBlock.saving, 6);
  const kinds = Object.fromEntries(amplified.byKind.map((entry) => [entry.kind, entry]));
  assert.deepStrictEqual(Object.keys(kinds).sort(), ["agent", "args", "results", "user"]);
  assert.strictEqual(kinds.user.amplified, 8, "the user message entered before step 1, so it is re-read twice");
  assert.strictEqual(kinds.args.amplified, 4);
  assert.strictEqual(kinds.results.amplified, 4);
  assert.strictEqual(kinds.agent.amplified, 2);

  /* A compaction stops the re-reading of what it folded away. */
  const compacted = mod.aggregateSession([
    { type: "user/message", data: { message: { content: [{ type: "text", text: "abcdefgh" }] } } },
    { type: "assistant/message", data: { usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1, totalTokens: 11 }, message: { content: [{ type: "text", text: "ok" }] } } },
    { type: "context/compacted", data: {} },
    { type: "assistant/message", data: { usage: { inputTokens: 20, cacheReadTokens: 0, outputTokens: 1, totalTokens: 21 }, message: { content: [{ type: "text", text: "done" }] } } },
  ]);
  assert.strictEqual(compacted.amplified.bill, 30);
  assert.strictEqual(compacted.amplified.blocks[0].kind, "user");
  assert.strictEqual(compacted.amplified.blocks[0].entry, 1, "the user message entered before step 1");
  assert.strictEqual(compacted.amplified.blocks[0].remaining, 1, "the compaction limits it to the one step it was in");
  assert.strictEqual(compacted.amplified.blocks[0].amplified, 2);

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

  console.log("stats ok: estimator, aggregation, args/results split fields, shares, persistence seam, cache");
})();
