#!/usr/bin/env node
/**
 * Host-side check for the session content search: transcript extraction, the
 * literal multi-term match with snippets, the on-disk cache keyed by the log's
 * size+revision, and the HTTP route's guards.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(path.join(__dirname, "..", "index.js")).href;

/** One page of events through the persistence seam. */
function reader(events) {
  return {
    read: async (offset) => ({ events: offset === 0 ? events : [] }),
    close: async () => {},
  };
}

function request(body, method = "POST", origin = "http://127.0.0.1:43120") {
  const payload = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  return {
    method,
    url: "/ws-recency/search",
    headers: { origin, "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
}

function response() {
  const state = { status: 0, body: "" };
  return {
    state,
    setHeader() {},
    writeHead(status) { state.status = status; },
    end(value) { state.body = String(value ?? ""); },
  };
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wsr-search-"));
  process.env.DSH_HOME = home;
  const mod = await import(modulePath);

  const s1 = [
    { type: "session", id: "s-1", time: 1000, data: {} },
    { type: "session/title", data: { title: "Alpha work" } },
    { type: "turn/start", time: 1010, data: { turn: 1 } },
    { type: "user/message", time: 1020, data: { turn: 1, message: { content: [{ type: "text", text: "please build the thing" }] } } },
    { type: "assistant/message", time: 1030, data: { turn: 1, step: 3, message: { content: [{ type: "text", text: "build failed: ERROR in place.ts" }] } } },
    { type: "turn/end", time: 1040, data: { turn: 1 } },
    { type: "turn/start", time: 1050, data: { turn: 2 } },
    { type: "user/message", time: 1060, data: { turn: 2, message: { content: [{ type: "text", text: "and then rebuild" }] } } },
  ];
  const s2 = [
    { type: "session", id: "s-2", time: 2000, data: {} },
    /* A session titles itself twice: the first-prompt prefix, then the provider's
       name. The second one is what the sidebar shows. */
    { type: "session/title", data: { title: "unrelated topi", source: { kind: "fallback" } } },
    { type: "session/title", data: { title: "Beta", source: { kind: "provider" } } },
    { type: "turn/start", time: 2010, data: { turn: 1 } },
    { type: "user/message", time: 2020, data: { turn: 1, message: { content: [{ type: "text", text: "unrelated topic" }] } } },
    { type: "assistant/message", time: 2030, data: { turn: 1, message: { content: [{ type: "reasoning", text: "build build build" }, { type: "text", text: "nothing here" }] } } },
  ];
  const s3 = [
    /* No title in the header and no session/title event: the first prompt names it. */
    { type: "session", id: "s-3", time: 3000, data: {} },
    { type: "turn/start", time: 3010, data: { turn: 1 } },
    { type: "user/message", time: 3020, data: { turn: 1, message: { content: [{ type: "text", text: "gamma first line\nsecond line" }] } } },
    { type: "assistant/message", time: 3030, data: { turn: 1, message: { content: [{ type: "text", text: "a".repeat(200) + " marker " + "b".repeat(200) }] } } },
    /* Markdown in the log, plain text on screen: the jump fragment has to match
       what the renderer produces, not what the log stores. */
    { type: "assistant/message", time: 3040, data: { turn: 2, step: 1, message: { content: [{ type: "text", text: "## Verdict\n\n**the docs say manual** and `code` lives here" }] } } },
  ];

  const logs = { "s-1": s1, "s-2": s2, "s-3": s3 };
  const opens = {};
  const ctx = {
    workspaceRegistry: {
      list: () => [
        { id: "w-1", name: "Work", path: "C:\\work" },
        { id: "w-2", name: "Elsewhere", path: "D:\\other" },
      ],
    },
    sessionPersistence: {
      list: async () => [
        { header: { id: "s-1", title: "Alpha work", cwd: "C:\\work\\", updatedAt: 1100 }, sizeBytes: 10 },
        { header: { id: "s-2", title: "Beta", cwd: "D:\\other", updatedAt: 2100 }, sizeBytes: 20 },
        { header: { id: "s-3", cwd: "C:\\work", updatedAt: 3100 }, sizeBytes: 30 },
      ],
      stat: async (id) => ({ sizeBytes: id.length * 10, revision: "r1", header: { id } }),
      open: async (id) => {
        opens[id] = (opens[id] || 0) + 1;
        return reader(logs[id] || []);
      },
    },
  };

  /* ---------- extraction and literal matching --------------------------- */
  const answer = await mod.searchSessions(ctx, "build");
  assert.strictEqual(answer.ok, true);
  assert.deepStrictEqual(answer.terms, ["build"]);
  assert.ok(answer.hits.length >= 2, "both messages that mention build are found");
  const users = answer.hits.filter((hit) => hit.role === "user");
  const assistants = answer.hits.filter((hit) => hit.role === "assistant");
  assert.ok(users.length >= 1 && assistants.length >= 1, "prompts and replies are both searchable");
  const first = answer.hits[0];
  assert.strictEqual(first.sessionId, "s-1", "hits come back newest first");
  assert.strictEqual(first.at, 1060, "the newest matching message leads");
  const gamma = await mod.searchSessions(ctx, "gamma");
  assert.strictEqual(gamma.hits[0].title, "gamma first line", "the first prompt names an untitled session");
  /* A hit carries the session's own title even when the persistence header has
     none: the title event is captured while indexing, not read from the header. */
  const beta = await mod.searchSessions(ctx, "unrelated");
  assert.strictEqual(beta.hits[0].title, "Beta", "the provider title wins over the first-prompt prefix");

  /* Filters narrow sessions instead of text, and the small syntax joins or
     excludes terms: both are decided on the host, where matching happens. */
  const byWorkspace = await mod.searchSessions(ctx, "build ws:work");
  assert.ok(byWorkspace.hits.length >= 1, "a workspace filter keeps its own sessions");
  assert.ok(byWorkspace.hits.every((hit) => hit.workspace === "Work"), "the workspace filter excludes the others");
  const byOtherWorkspace = await mod.searchSessions(ctx, "build ws:nowhere");
  assert.strictEqual(byOtherWorkspace.hits.length, 0, "a workspace filter that matches nothing returns nothing");
  const byRole = await mod.searchSessions(ctx, "build role:assistant");
  assert.ok(byRole.hits.every((hit) => hit.role !== "user"), "the role filter drops the other side");
  const excluded = await mod.searchSessions(ctx, "build -unrelated");
  assert.ok(excluded.hits.every((hit) => (hit.snippet + hit.context).toLowerCase().indexOf("unrelated") === -1), "a leading dash excludes");
  const alternatives = await mod.searchSessions(ctx, "build or unrelated");
  assert.ok(alternatives.hits.length >= 2, "or joins alternatives into one required group");
  const phrase = await mod.searchSessions(ctx, '"build failed: ERROR"');
  assert.ok(phrase.hits.length >= 1, "a quoted phrase is matched whole");
  const brokenPhrase = await mod.searchSessions(ctx, '"failed build"');
  assert.strictEqual(brokenPhrase.hits.length, 0, "a phrase that does not appear in that order is not a match");
  /* The transcript is markdown-free: a jump can only find the message if the
     fragment has the markers taken out. */
  assert.ok(Array.isArray(beta.hits[0].seeks) && beta.hits[0].seeks.length >= 1, "a hit carries text fragments to find it by");
  assert.strictEqual(beta.hits[0].seek, beta.hits[0].seeks[0], "the first fragment is the plain seek");
  assert.ok(beta.hits[0].seeks.every((fragment) => fragment.indexOf("**") === -1 && fragment.indexOf("`") === -1), "fragments are markdown-free");
  const verdict = await mod.searchSessions(ctx, "verdict");
  const headingHit = verdict.hits.find((hit) => hit.sessionId === "s-3");
  assert.ok(headingHit !== undefined, "a match inside a markdown heading is found");
  const fragment = headingHit.seeks[0];
  assert.ok(fragment.indexOf("#") === -1, "the heading marker is stripped from the fragment");
  assert.ok(fragment.indexOf("**") === -1 && fragment.indexOf("`") === -1, "bold and code markers are stripped too");
  assert.ok(fragment.toLowerCase().indexOf("verdict") !== -1, "the fragment still starts at the match");
  /* Reading a hit must not require opening the session: the neighbourhood of the
     match travels with the hit, flattened and centred on it. */
  assert.ok(typeof headingHit.context === "string" && headingHit.context !== "", "a hit carries its surrounding text");
  assert.ok(headingHit.context.toLowerCase().indexOf("verdict") !== -1, "the context is centred on the match");
  assert.ok(headingHit.context.length <= 1000, "the context is capped so the payload stays small");
  assert.ok(beta.hits[0].at > 0, "each hit carries its timestamp");
  const s1hit = answer.hits.find((hit) => hit.sessionId === "s-1" && hit.role === "assistant");
  assert.strictEqual(s1hit.workspace, "Work", "the workspace label is resolved from cwd");
  assert.strictEqual(s1hit.turn, 1, "the hit names the turn");
  assert.strictEqual(s1hit.step, 3, "an assistant hit names its step inside the turn");
  const promptHit = answer.hits.find((hit) => hit.sessionId === "s-1" && hit.role === "user");
  assert.strictEqual(promptHit.step, null, "a prompt has no step: it arrives before the turn's steps");
  assert.ok(s1hit.snippet.indexOf("build failed") !== -1, "the snippet shows the match");
  assert.strictEqual(s1hit.lead, false, "a match at the start needs no leading ellipsis");

  const long = await mod.searchSessions(ctx, "marker");
  const longHit = long.hits.find((hit) => hit.sessionId === "s-3");
  assert.ok(longHit !== undefined, "a match deep inside a long message is found");
  assert.strictEqual(longHit.lead, true, "the snippet is cut at the front");
  assert.strictEqual(longHit.tail, true, "the snippet is cut at the back");
  assert.ok(longHit.snippet.length < 300, "the snippet stays short");
  assert.ok(longHit.snippet.indexOf("marker") !== -1);

  /* Reasoning is not conversation text: s-2 only says "build" in its thinking. */
  assert.strictEqual(answer.hits.some((hit) => hit.sessionId === "s-2"), false, "reasoning blocks are not searchable");

  /* ---------- case, multiple terms, snippet ----------------------------- */
  const upper = await mod.searchSessions(ctx, "BUILD");
  assert.ok(upper.hits.length > 0, "the match is case-insensitive");

  const both = await mod.searchSessions(ctx, "build error");
  assert.strictEqual(both.hits.length, 1, "every term has to appear in the same message");
  assert.strictEqual(both.hits[0].sessionId, "s-1");
  assert.ok(both.hits[0].snippet.toLowerCase().indexOf("error") !== -1, "the snippet is built around the first term");

  const none = await mod.searchSessions(ctx, "zzz-not-there");
  assert.strictEqual(none.hits.length, 0);
  assert.ok(none.total >= 3, "the response still counts the scanned sessions");

  const empty = await mod.searchSessions(ctx, "   ");
  assert.strictEqual(empty.hits.length, 0, "an empty query searches nothing");

  /* ---------- cache: size+revision, refresh ----------------------------- */
  const opened = Object.keys(opens).reduce((sum, id) => sum + opens[id], 0);
  await mod.searchSessions(ctx, "build");
  const openedAgain = Object.keys(opens).reduce((sum, id) => sum + opens[id], 0);
  assert.strictEqual(openedAgain, opened, "a repeated query reads only the cache");

  const cacheFiles = fs.readdirSync(path.join(home, ".wsr", "search")).filter((name) => name.endsWith(".json"));
  assert.deepStrictEqual(cacheFiles.sort(), ["s-1.json", "s-2.json", "s-3.json"], "every session keeps its own cache file");

  const before = opens["s-1"] || 0;
  await mod.searchSessions(ctx, "build", { refresh: true });
  assert.strictEqual(opens["s-1"], before + 1, "refresh re-decodes the log");

  /* A changed log invalidates its cache through the stat key. */
  const oldStat = ctx.sessionPersistence.stat;
  ctx.sessionPersistence.stat = async (id) => ({ sizeBytes: 99, revision: "r2", header: { id } });
  const beforeChange = opens["s-1"] || 0;
  await mod.searchSessions(ctx, "build");
  assert.strictEqual(opens["s-1"], beforeChange + 1, "a new size or revision re-decodes the log");
  ctx.sessionPersistence.stat = oldStat;

  /* ---------- route guards ---------------------------------------------- */
  const ok = response();
  await mod.handleSearchRequest(ctx, request({ query: "build" }), ok);
  const parsed = JSON.parse(ok.state.body);
  assert.strictEqual(ok.state.status, 200);
  assert.strictEqual(parsed.ok, true);
  assert.ok(Array.isArray(parsed.hits) && parsed.hits.length > 0, "the route answers with hits");

  const wrongMethod = response();
  await mod.handleSearchRequest(ctx, request({ query: "build" }, "GET"), wrongMethod);
  assert.strictEqual(wrongMethod.state.status, 405);

  const foreign = response();
  await mod.handleSearchRequest(ctx, request({ query: "build" }, "POST", "https://example.com"), foreign);
  assert.strictEqual(foreign.state.status, 403);

  fs.rmSync(home, { recursive: true, force: true });
  console.log("search ok: extraction, literal multi-term match, snippets, turn/workspace, cache, refresh, guards");
})();
