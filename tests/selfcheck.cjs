#!/usr/bin/env node
/**
 * Self-check for dsh-ws-recency's client half: load client.js through a stubbed
 * dynamic-module protocol and a stub DOM, then assert
 *   - group order follows each workspace's freshest `updatedAt`,
 *   - sessions older than foldDays are folded, one control per group,
 *   - colors: running / unread / persistent manual follow-up,
 *   - the global pinned section renders native pins and hides the copies.
 */
const path = require("node:path");
const assert = require("node:assert");

const DAY = 24 * 60 * 60 * 1000;

/* ---------- minimal DOM ------------------------------------------------ */

function matchOne(elm, part) {
  if (part.startsWith(".")) return String(elm.className).split(/\s+/).indexOf(part.slice(1)) !== -1;
  const presence = /^\[([a-zA-Z-]+)\]$/.exec(part);
  if (presence !== null) return elm.attrs[presence[1]] !== undefined;
  const attr = /^([a-zA-Z]+)?\[([a-zA-Z-]+)([\^*$]?)=["']?([^"'\]]*)["']?\]$/.exec(part);
  if (attr === null) {
    if (/^[a-zA-Z]+$/.test(part)) return elm.tagName === part.toUpperCase();
    return false;
  }
  const [, tag, name, op, value] = attr;
  if (tag !== undefined && elm.tagName !== tag.toUpperCase()) return false;
  const actual = name === "class" ? elm.className : elm.attrs[name];
  if (actual === undefined) return false;
  if (op === "^") return String(actual).indexOf(value) === 0;
  if (op === "*") return String(actual).indexOf(value) !== -1;
  return String(actual) === value;
}

function matches(elm, selector) {
  return selector.split(",").some((part) => matchOne(elm, part.trim()));
}

function walk(elm, out) {
  for (const child of elm.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function el(tag, className) {
  return {
    tagName: tag.toUpperCase(),
    className: className || "",
    parentElement: null,
    children: [],
    style: {},
    dataset: {},
    attrs: {},
    textContent: "",
    handlers: {},
    get firstChild() { return this.children.length > 0 ? this.children[0] : null; },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    click() { (this.handlers.click || []).forEach((fn) => fn({ stopPropagation() {} })); },
    append(child) { child.parentElement = this; this.children.push(child); return child; },
    appendChild(child) { return this.append(child); },
    insertBefore(child, ref) {
      child.parentElement = this;
      const index = ref === undefined || ref === null ? -1 : this.children.indexOf(ref);
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentElement = null;
      return child;
    },
    remove() {
      const parent = this.parentElement;
      if (parent === null) return;
      parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    },
    querySelector(selector) {
      const found = walk(this, []).find((candidate) => matches(candidate, selector));
      return found === undefined ? null : found;
    },
    querySelectorAll(selector) {
      return walk(this, []).filter((candidate) => matches(candidate, selector));
    },
  };
}

/* ---------- module loader / window stubs ------------------------------- */

let spec = null;
const pendingTimers = [];
const flush = () => {
  let guard = 0;
  while (pendingTimers.length > 0 && guard < 50) {
    guard += 1;
    pendingTimers.shift()();
  }
};

const overlayRoot = el("div", "overlay-root");

/* The composer's statistics row and the conversation's own session hook. */
const composerSeat = el("div", "seat");
const composerRow = el("div", "row");
const turnsPill = el("div", "K-8v-a_anchor");
turnsPill.attrs["data-composer-stat"] = "turns";
turnsPill.append(el("span", "K-8v-a_pill"));
composerRow.append(turnsPill);
composerSeat.append(composerRow);
const conversationNode = el("div", "conv");
conversationNode.attrs["data-conversation-session"] = "A-fresh-1";

/* Keep the fallback dictionary deterministic in this test. */
global.navigator = { language: "en-US" };
global.documentElement = null;

global.document = {
  documentElement: { lang: "en-US" },
  body: overlayRoot,
  head: { appendChild() {} },
  querySelector(selector) {
    if (selector === "[data-composer-seat]") return composerSeat;
    if (selector === "[data-conversation-session]") return conversationNode;
    /* The plugin looks rows up by their host key when it has to fall back to
       clicking one (the pinned section's navigation fallback). */
    if (selector.indexOf("[data-row-key=") === 0) {
      return root.querySelector(selector) || overlayRoot.querySelector(selector);
    }
    return composerSeat.querySelector(selector);
  },
  createElement: (tag) => el(tag),
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll(selector) {
    if (selector.indexOf("workspace:") !== -1) return headers;
    return [];
  },
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.fetch = (url, options) => {
  global.fetch.calls.push({ url, options });
  const answer = global.fetch.answer;
  const text = JSON.stringify(answer);
  return Promise.resolve({
    status: answer && answer.ok ? 200 : 500,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(answer),
  });
};
global.fetch.calls = [];
global.fetch.answer = { ok: false, error: "not configured" };
global.window = {
  setTimeout(fn) { pendingTimers.push(fn); return pendingTimers.length; },
  clearTimeout() {},
  setInterval() { return 1; },
  clearInterval() {},
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  __ModuleLoader__: { load(input) { spec = input; } },
};
global.window.window = global.window;

require(path.join(__dirname, "..", "client.js"));
assert.ok(spec !== null, "client.js did not register through __ModuleLoader__");

/* ---------- fixture ---------------------------------------------------- */

const NOW = Date.now();
const root = el("body");
const headers = [];
const sections = [];

const makeSection = (id, sessionIds, overflowText) => {
  const section = el("div", "SJMXQW_groupSection");
  section.parentElement = root;
  root.children.push(section);
  const header = el("div", "ozLDBG_projectRow");
  header.attrs["data-row-key"] = `workspace:${id}`;
  section.append(header);
  headers.push(header);
  sections.push(section);
  const rows = sessionIds.map((sessionId) => {
    const row = el("div", "ozLDBG_sessionRow");
    row.attrs["data-row-key"] = `session:${sessionId}`;
    section.append(row);
    return row;
  });
  let button = null;
  if (overflowText) {
    button = el("button", "SJMXQW_sessionOverflowButton");
    button.textContent = overflowText;
    section.append(button);
  }
  return { section, header, rows, button };
};

const A = makeSection("A", ["A-fresh-1", "A-old-1", "A-fresh-2", "A-old-2", "A-old-3"], "\u5c55\u5f00\u5176\u4f59 5 \u6761\u4f1a\u8bdd");
const B = makeSection("B", ["B-old-1", "B-old-2"], null);
const C = makeSection("C", ["C-fresh-1", "C-fresh-2"], null);

/* The provisional "New session" row: always rendered, never folded. */
const blankRow = el("div", "ozLDBG_sessionRow");
blankRow.attrs["data-row-key"] = "session:B-blank";
B.section.append(blankRow);

/* Counts how often the plugin drives the host's own show-more button. */
let hostClicks = 0;
A.button.addEventListener("click", () => { hostClicks += 1; });

/* ---------- boot ------------------------------------------------------- */

const react = {
  useEffect(fn) { fn(); },
  useState(initial) { return [initial, function () {}]; },
  useMemo(fn) { return fn(); },
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
};
const mod = spec.factory((name) => {
  if (name === "react") return react;
  if (name === "@deepseek-ai/dsh-client-store") return { defineStore: () => ({}) };
  if (name === "@deepseek-ai/dsh-client-ui-primitives") {
    return {
      MenuItemButton: (props, ...children) => ({ type: "menuitem", props: props || {}, children }),
      IconDataOutlineRegular: () => ({ type: "icon" }),
      IconTrashOutlineRegular: () => ({ type: "icon" }),
    };
  }
  return {};
});

assert.strictEqual(mod.name, "dsh-ws-recency");

let Sorter = null;
let SettingsRow = null;
let FollowUpDot = null;
let StatsMenuItem = null;
let MoveMenuItem = null;
let TrashIcon = null;
let HandoffItem = null;
let HandoffAction = null;
let HandoffCard = null;
let TrashPage = null;
let TrashMenuItem = null;
const service = {
  opened: [],
  unpinned: [],
  connected: [],
  started: [],
  openSession(id) { this.opened.push(id); },
  unpinSession(id) { this.unpinned.push(id); },
  pinSession() {},
  connectWorkspace(workspaceId) {
    this.connected.push(workspaceId);
    return Promise.resolve("handoff-new-1");
  },
  startSession(workspaceId, options) { this.started.push({ workspaceId, options }); },
};
/* The Host's Session controller surface the handoff now sends through. */
const sessionService = {
  prompts: [],
  using(target, options, operation) {
    const session = {
      prompt(content, mode) {
        sessionService.prompts.push({ target, content, mode, options });
        return Promise.resolve({ ok: true });
      },
    };
    return Promise.resolve(operation({ binding: { session } }));
  },
};
const ctx = {
  effect(fn) { fn(); },
  get(name) {
    if (name === "uiWorkspace") return service;
    if (name === "sessions") return sessionService;
    return undefined;
  },
  locale: { register() { return () => {}; } },
  slots: {
    inject(_name, factory) { return factory(); },
    register(spec2, component) {
      if (spec2.name === "shell.overlay") Sorter = component;
      if (spec2.name === "settings.general.item") SettingsRow = component;
      if (spec2.name === "sidebar.session.row.leading") FollowUpDot = component;
      if (spec2.id === "ws-recency-stats") StatsMenuItem = component;
      if (spec2.id === "ws-recency-move") MoveMenuItem = component;
      if (spec2.name === "sidebar.panellist") TrashIcon = component;
      if (spec2.id === "ws-recency-handoff" && spec2.name === "sidebar.workspaces.session.menu.item") HandoffItem = component;
      if (spec2.id === "ws-recency-handoff" && spec2.name === "conversation.chat.assistant-actions") HandoffAction = component;
      if (spec2.id === "ws-recency-handoff-card") HandoffCard = component;
      if (spec2.name === "main") TrashPage = component;
      if (spec2.id === "ws-recency-trash") TrashMenuItem = component;
      return () => {};
    },
  },
};
mod.apply(ctx);
assert.ok(Sorter !== null, "overlay component was not registered");
assert.ok(SettingsRow !== null, "settings row was not registered");

const sessions = {
  phase: "ready",
  byId: {
    "A-fresh-1": { id: "A-fresh-1", updatedAt: NOW - 1 * DAY, origin: "main" },
    "A-old-1": { id: "A-old-1", updatedAt: NOW - 4 * DAY, origin: "main" },
    "A-fresh-2": { id: "A-fresh-2", updatedAt: NOW - 2 * DAY, origin: "main" },
    "A-old-2": { id: "A-old-2", updatedAt: NOW - 6 * DAY, origin: "main" },
    "A-old-3": { id: "A-old-3", updatedAt: NOW - 9 * DAY, origin: "main" },
    "B-old-1": { id: "B-old-1", updatedAt: NOW - 5 * DAY, origin: "main" },
    "B-old-2": { id: "B-old-2", updatedAt: NOW - 7 * DAY, origin: "main" },
    "B-blank": { id: "B-blank", blank: true, updatedAt: NOW - 30 * DAY, origin: "main" },
    "C-fresh-1": { id: "C-fresh-1", updatedAt: NOW - 2 * DAY, origin: "main" },
    "C-fresh-2": { id: "C-fresh-2", updatedAt: NOW - 1 * DAY, origin: "main" },
  },
};
const workspaces = {
  phase: "ready",
  items: [
    { workspaceId: "A", title: "alpha", sessionIds: ["A-fresh-1", "A-old-1", "A-fresh-2", "A-old-2", "A-old-3"] },
    { workspaceId: "B", title: "beta", sessionIds: ["B-old-1", "B-old-2"] },
    { workspaceId: "C", title: "gamma", sessionIds: ["C-fresh-1", "C-fresh-2"] },
  ],
  archivedSessionIds: [],
  pinnedSessionIds: [],
};
const prefs = { enabled: true, foldDays: 3, keepActive: true, colors: true, pinnedSection: true, followUps: {} };
const statuses = {};
const actions = {
  clearFollowUp: (id) => { delete prefs.followUps[id]; },
  toggleFollowUp: (id) => {
    if (prefs.followUps[id] === undefined) prefs.followUps[id] = Date.now();
    else delete prefs.followUps[id];
  },
};

const render = () => {
  Sorter({
    useSessions: (select) => select(sessions),
    useWorkspaces: (select) => select(workspaces),
    useStore: (select) => select(prefs),
    useSessionStatus: (select) => select(statuses),
    actions,
  });
  flush();
};

render();

/* ---------- assertions: group order ------------------------------------ */

assert.strictEqual(A.section.style.order, "0", "freshest workspace must lead");
assert.strictEqual(C.section.style.order, "1");
assert.strictEqual(B.section.style.order, "2");
assert.strictEqual(root.attrs["data-wsr-root"], "true");

/* ---------- assertions: fold ------------------------------------------ */

const hiddenCount = (group) => group.rows.filter((row) => row.getAttribute("data-wsr-hidden") === "true").length;
const toggleOf = (group) => group.section.querySelector('[data-wsr-fold="true"]');

assert.strictEqual(hiddenCount(A), 3, "three sessions older than 3 days are folded");
assert.strictEqual(hiddenCount(B), 2, "a fully stale workspace folds every row");
assert.strictEqual(hiddenCount(C), 0, "fresh sessions stay visible");
assert.strictEqual(blankRow.getAttribute("data-wsr-hidden"), null, "the New session row is never folded");

assert.ok(toggleOf(A) !== null, "a group with folded rows gets its own history control");
assert.strictEqual(toggleOf(A).textContent, "Show history (8)", "count covers folded rows plus rows the host has not rendered");
assert.strictEqual(A.button.textContent, "\u5c55\u5f00\u5176\u4f59 5 \u6761\u4f1a\u8bdd", "the host's own button is left untouched");
assert.ok(toggleOf(B) !== null, "a fully rendered group offers the history control");
assert.strictEqual(toggleOf(B).textContent, "Show history (2)");
assert.strictEqual(toggleOf(C), null, "a group with nothing folded gets no control");

toggleOf(A).click();
flush();
assert.strictEqual(hiddenCount(A), 0, "the history control reveals the folded rows");
assert.strictEqual(toggleOf(A).textContent, "Hide history");
assert.strictEqual(hostClicks, 1, "expanding drives the hidden host button, which renders more rows");

render();
assert.strictEqual(hostClicks, 2, "it keeps driving it while the host still hides rows");
A.button.attrs["aria-expanded"] = "true";
render();
assert.strictEqual(hostClicks, 2, "it stops once the host reports everything visible");
delete A.button.attrs["aria-expanded"];

toggleOf(A).click();
flush();
assert.strictEqual(hiddenCount(A), 3, "the same control folds them back");
assert.strictEqual(toggleOf(A).textContent, "Show history (8)");

toggleOf(B).click();
flush();
assert.strictEqual(hiddenCount(B), 0, "the group toggle reveals the folded rows");

/* a session marked "needs follow-up" is exempt from folding, however stale */
const staleRow = A.rows.find((row) => row.getAttribute("data-wsr-hidden") === "true");
assert.ok(staleRow !== undefined, "a stale row to mark");
const staleId = staleRow.getAttribute("data-row-key").slice("session:".length);
const foldedBefore = hiddenCount(A);
prefs.followUps[staleId] = NOW;
render();
assert.strictEqual(staleRow.getAttribute("data-wsr-hidden"), null, "a marked row is not folded");
assert.strictEqual(hiddenCount(A), foldedBefore - 1, "the marked row leaves the folded set");
assert.strictEqual(toggleOf(A).textContent, "Show history (" + (foldedBefore - 1 + 5) + ")");
delete prefs.followUps[staleId];
render();
assert.strictEqual(hiddenCount(A), foldedBefore, "clearing the mark folds it again");

/* ---------- colors + persistent follow-up ------------------------------ */

const D = makeSection("D", ["D-run", "D-done"], null);
sessions.byId["D-run"] = { id: "D-run", updatedAt: NOW - 1 * DAY, origin: "main" };
sessions.byId["D-done"] = { id: "D-done", updatedAt: NOW - 1 * DAY, origin: "main" };
workspaces.items.push({ workspaceId: "D", title: "delta", sessionIds: ["D-run", "D-done"] });
statuses["D-run"] = { running: true };
statuses["D-done"] = { completionUnread: true };
render();

assert.strictEqual(D.rows[0].getAttribute("data-wsr-state"), "running", "a running session turns blue");
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), "unread", "a finished-unopened session turns green");

statuses["D-done"] = {};
prefs.followUps = { "D-done": NOW };
render();
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), "followup", "a flagged session turns amber");

const flaggedDot = FollowUpDot({ sessionId: "D-done", useStore: (select) => select(prefs), actions });
assert.ok(flaggedDot !== null, "a flagged session renders the leading dot");
assert.strictEqual(flaggedDot.props.className, "wsr-dot");
assert.strictEqual(D.rows[1].querySelector(".wsr-dot"), null, "nothing is injected into the row");
assert.strictEqual(FollowUpDot({ sessionId: "D-run", useStore: (sel) => sel(prefs), actions }), null);

flaggedDot.props.onClick({ stopPropagation() {} });
render();
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), null, "the dot clears the mark");
assert.strictEqual(prefs.followUps["D-done"], undefined);

/* The mark survives new activity: running / unread only outrank it on screen. */
prefs.followUps = { "D-done": NOW };
statuses["D-done"] = { running: true };
render();
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), "running", "running outranks the mark");
statuses["D-done"] = { completionUnread: true };
render();
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), "unread", "unread outranks the mark");
statuses["D-done"] = {};
render();
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), "followup", "the mark comes back once read");
assert.strictEqual(prefs.followUps["D-done"], NOW, "the mark is never dropped automatically");

/* ---------- global pinned section -------------------------------------- */

sessions.byId["A-fresh-1"].title = "pinned one";
workspaces.pinnedSessionIds = ["A-fresh-1"];
render();

const pinSection = root.children.find((child) => child.className === "wsr-pin");
assert.ok(pinSection !== undefined, "a pinned section is rendered");
assert.strictEqual(root.children[0], pinSection, "it leads the list");
const pinRow = pinSection.querySelector(".wsr-pin-row");
assert.ok(pinRow !== null, "the pinned session gets a row");
assert.strictEqual(pinRow.getAttribute("data-row-key"), "pin:A-fresh-1");
assert.strictEqual(A.rows[0].getAttribute("data-wsr-pin-hidden"), "true", "the original row is hidden, not duplicated");

pinRow.click();
assert.deepStrictEqual(service.opened, ["A-fresh-1"], "clicking a pinned row opens it");

/* ---------- pinned navigation never depends on one service call -------- */

/* The row is the app's own way in, so it is the fallback for both failures. */
let hostRowClicks = 0;
A.rows[0].addEventListener("click", () => { hostRowClicks += 1; });
const realOpenSession = service.openSession;

service.openSession = () => { throw new Error("navigation service refused"); };
pinRow.click();
assert.strictEqual(hostRowClicks, 1, "a throwing openSession falls back to the host's own row");

service.openSession = undefined;
pinRow.click();
assert.strictEqual(hostRowClicks, 2, "a missing openSession falls back to the host's own row");

service.openSession = realOpenSession;
pinRow.click();
assert.deepStrictEqual(service.opened, ["A-fresh-1", "A-fresh-1"], "the service is preferred when it works again");
assert.strictEqual(hostRowClicks, 2, "the working service does not click the row");

/* Late resolution: apply() ran while the service was absent, and a later click
   still finds it instead of giving up on the row fallback forever. */
const lateService = { opened: [], openSession(id) { this.opened.push(id); } };
const realGet = ctx.get;
ctx.get = () => undefined;
mod.apply(ctx);
assert.strictEqual(hostRowClicks, 2, "no service at apply time: no navigation yet");
ctx.get = (name) => (name === "uiWorkspace" ? lateService : undefined);
pinRow.click();
assert.deepStrictEqual(lateService.opened, ["A-fresh-1"], "a service provided after apply is resolved on use");
assert.strictEqual(hostRowClicks, 2, "the late service is preferred over the row fallback");
ctx.get = realGet;
mod.apply(ctx);

pinRow.querySelector(".wsr-pin-unpin").click();
assert.deepStrictEqual(service.unpinned, ["A-fresh-1"], "unpin goes through the host service");

workspaces.pinnedSessionIds = [];
render();
assert.strictEqual(root.children.some((child) => child.className === "wsr-pin"), false, "the section disappears when nothing is pinned");
assert.strictEqual(A.rows[0].getAttribute("data-wsr-pin-hidden"), null, "the original row comes back");

/* ---------- token statistics panel -------------------------------------- */

function textOf(node) {
  const parts = [typeof node.textContent === "string" ? node.textContent : ""];
  for (const child of node.children || []) parts.push(textOf(child));
  return parts.join(" ");
}

(async () => {
  assert.ok(StatsMenuItem !== null, "the stats menu row was not registered");
  assert.ok(TrashMenuItem !== null, "the trash menu row was not registered");

  global.fetch.answer = {
    ok: true,
    stats: {
      session: { id: "A-fresh-1", title: "demo" },
      steps: 3,
      totals: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500, totalTokens: 10500 },
      estimate: {
        agent: { reasoning: 100, text: 200, user: 50, system: 10, total: 360, share: 0.36 },
        tools: [
          { name: "pwsh", calls: 4, args: 100, results: 500, total: 600, share: 0.6 },
          { name: "read", calls: 2, args: 10, results: 30, total: 40, share: 0.04 },
        ],
        toolsTotal: 640,
        grandTotal: 1000,
      },
    },
  };

  const item = StatsMenuItem({ sessionId: "A-fresh-1", t: (key) => key });
  assert.ok(item !== null, "the stats row renders");
  assert.strictEqual(item.children[0], "Token statistics");
  assert.ok(item.props.icon !== undefined, "the row carries an icon");

  item.props.onSelect();
  assert.strictEqual(global.fetch.calls.length, 1, "selecting the row asks the host for statistics");
  assert.ok(String(global.fetch.calls[0].url).indexOf("/ws-recency/session-stats") !== -1);
  assert.ok(String(global.fetch.calls[0].url).indexOf("sessionId=A-fresh-1") !== -1, "the id travels in the query too");
  assert.deepStrictEqual(JSON.parse(global.fetch.calls[0].options.body), { sessionId: "A-fresh-1" });

  const backdrop = overlayRoot.children[overlayRoot.children.length - 1];
  assert.ok(String(backdrop.className).indexOf("wsr-modal-backdrop") !== -1, "a modal opens");

  await new Promise((resolve) => setTimeout(resolve, 0));

  const panel = backdrop.children[0];
  const body = panel.querySelector(".wsr-modal-body");
  const text = textOf(body);
  assert.ok(text.indexOf("Counting") === -1, "the loading text is replaced by the statistics");
  assert.ok(text.indexOf("pwsh") !== -1, "the tool table lists the tool");
  assert.ok(text.indexOf("main agent") !== -1, "the agent row is present");
  assert.ok(text.indexOf("60.0%") !== -1, "shares are shown as percentages");
  assert.ok(text.indexOf("10.5K") !== -1, "token totals are compact");
  assert.strictEqual(body.querySelectorAll(".wsr-stats-card").length, 5, "five exact totals are shown");

  const chartRows = body.querySelectorAll(".wsr-chart-row");
  assert.strictEqual(chartRows.length, 3, "one bar per source: the agent plus both tools");
  assert.strictEqual(chartRows[0].querySelector(".wsr-chart-value").textContent, "360");
  assert.strictEqual(chartRows[1].querySelector(".wsr-chart-label").textContent, "pwsh");
  const widest = chartRows[1].querySelector(".wsr-chart-group").style.width;
  assert.strictEqual(widest, "100.00%", "the largest bar fills the track");
  assert.ok(chartRows[0].querySelector(".wsr-chart-group").style.width !== widest, "smaller bars are shorter");

  /* Colour identity: curated hue per known tool, hash for the rest, rank fades. */
  assert.strictEqual(chartRows[0].querySelector(".wsr-chart-group").style.background, undefined, "the group never paints a colour behind the segments");
  assert.strictEqual(chartRows[0].querySelector(".wsr-bar-results").style.background, "hsl(217, 88%, 50%)");
  assert.strictEqual(chartRows[1].querySelector(".wsr-bar-results").style.background, "hsl(32, 80%, 52%)", "pwsh keeps its orange");
  assert.strictEqual(chartRows[2].querySelector(".wsr-bar-results").style.background, "hsl(152, 72%, 54%)", "read keeps its green and fades one rank");

  /* ---------- the argument / result split ------------------------------- */
  /* pwsh: 100 args of 600 total -> the light segment is a sixth of the bar. */
  const splitBar = chartRows[1];
  const argsSeg = splitBar.querySelector(".wsr-bar-args");
  const resultsSeg = splitBar.querySelector(".wsr-bar-results");
  assert.ok(argsSeg !== null, "a tool bar carries an argument segment");
  assert.ok(resultsSeg !== null, "a tool bar carries a result segment");
  assert.strictEqual(argsSeg.style.width, "16.67%", "the argument segment is sized inside the tool's bar");
  assert.strictEqual(resultsSeg.style.width, "83.33%", "the rest of the bar is results");
  assert.strictEqual(argsSeg.style.background, "hsl(32, 56%, 68%)", "the argument segment is its own, lighter colour");
  assert.notStrictEqual(argsSeg.style.background, resultsSeg.style.background, "the two segments must not composite to the same colour");
  assert.strictEqual(argsSeg.style.opacity, undefined, "the contrast comes from the colour, not from opacity over a same-hue bar");
  assert.strictEqual(chartRows[0].querySelector(".wsr-bar-args"), null, "the agent bar is not split");
  const legend = body.querySelector(".wsr-chart-legend");
  assert.ok(legend !== null, "the split bars come with a legend");
  assert.strictEqual(legend.children.length, 2, "two legend entries: arguments and results");

  /* The toggle moves the argument tokens onto the agent. */
  prefs.argMode = "agent";
  const itemAgain = StatsMenuItem({ sessionId: "A-fresh-1", t: (key) => key });
  itemAgain.props.onSelect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const agentBody = overlayRoot.children[overlayRoot.children.length - 1].children[0].querySelector(".wsr-modal-body");
  const agentRows = agentBody.querySelectorAll(".wsr-chart-row");
  assert.strictEqual(agentRows[0].querySelector(".wsr-chart-value").textContent, "470", "the agent keeps its own tokens plus the moved arguments");
  assert.strictEqual(agentRows[1].querySelector(".wsr-chart-value").textContent, "500", "the tool keeps only its results");
  assert.strictEqual(agentRows[1].querySelector(".wsr-bar-args"), null, "nothing is split when arguments belong to the agent");
  assert.strictEqual(agentBody.querySelector(".wsr-chart-legend"), null, "the legend goes away too");
  assert.ok(textOf(agentBody).indexOf("currently count towards the agent") !== -1, "the panel explains the mode");
  overlayRoot.children[overlayRoot.children.length - 1].children[0].querySelector(".wsr-modal-close").click();
  prefs.argMode = "tool";
  assert.strictEqual(prefs.argMode, "tool", "the default mode stays per-tool");

  const details = body.querySelector(".wsr-stats-details");
  assert.strictEqual(details.style.display, "none", "the table starts folded");
  const toggle = body.querySelector(".wsr-details-toggle");
  assert.strictEqual(toggle.textContent, "Show details");
  toggle.click();
  assert.strictEqual(details.style.display, "", "the toggle unfolds the detail table");
  assert.strictEqual(toggle.textContent, "Hide details");
  toggle.click();
  assert.strictEqual(details.style.display, "none", "and folds it again");

  panel.querySelector(".wsr-modal-close").click();
  assert.strictEqual(overlayRoot.children.indexOf(backdrop), -1, "closing removes the modal");

  /* ---------- composer pill ---------------------------------------- */
  const pill = composerSeat.querySelector("[data-wsr-composer-analysis]");
  assert.ok(pill !== null, "the composer statistics row gains an analysis pill");
  const pillButton = pill.children[0];
  const pillLabel = pillButton.children[pillButton.children.length - 1];
  assert.strictEqual(pillLabel.textContent, "Usage analysis");
  assert.strictEqual(composerSeat.children[composerSeat.children.length - 1], pill, "it sits at the end of the footer");
  const before = global.fetch.calls.length;
  pillButton.click();
  assert.strictEqual(global.fetch.calls.length, before + 1, "clicking the pill asks for statistics");
  assert.ok(String(global.fetch.calls[before].url).indexOf("sessionId=A-fresh-1") !== -1, "it analyses the conversation it sits in");

  /* ---------- handoff ------------------------------------------------- */
  assert.ok(HandoffItem !== null, "the handoff menu row was registered");
  assert.ok(HandoffAction !== null, "the turn handoff action was registered");
  const handoffAction = HandoffAction({ sessionId: "session-x", messageId: "m1" });
  const handoffButton = typeof handoffAction.type === "function" ? handoffAction : handoffAction;
  assert.ok(handoffButton !== null, "the turn action renders");

  /* The instruction goes through the Session controller, not a synthetic Enter. */
  const beforePrompts = sessionService.prompts.length;
  handoffAction.props.onClick();
  assert.strictEqual(sessionService.prompts.length, beforePrompts + 1, "the turn action prompts the session through the controller");
  const turnPrompt = sessionService.prompts[beforePrompts];
  assert.strictEqual(turnPrompt.target, "session-x", "it addresses the session it sits in");
  assert.strictEqual(turnPrompt.mode, "queue", "a prompt uses the queue delivery mode");
  assert.ok(String(turnPrompt.content[0].text).indexOf("~~~handoff") !== -1, "the instruction asks for the tilde fence");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(turnPrompt.options)), { source: "dsh-ws-recency" }, "the borrow is tagged");

  /* The "..." menu row starts the same handoff; before 0.24.1 it called a
     function that no longer existed and threw on every click. */
  const beforeMenuPrompts = sessionService.prompts.length;
  const handoffRow = HandoffItem({ sessionId: "A-fresh-1" });
  assert.ok(handoffRow !== null, "the menu row renders");
  assert.strictEqual(handoffRow.children[0], "Hand off to a new session", "the row is labelled");
  handoffRow.props.onSelect();
  assert.ok(service.opened.indexOf("A-fresh-1") !== -1, "the menu row opens the conversation first");
  assert.strictEqual(sessionService.prompts.length, beforeMenuPrompts + 1, "the menu row sends the instruction");
  assert.strictEqual(sessionService.prompts[beforeMenuPrompts].target, "A-fresh-1");

  /* Rewrite keeps the card's own wording and goes through the same seam. */
  const beforeRewrite = sessionService.prompts.length;
  mod.__handoff.rewrite("A-fresh-1", "多写接口约束");
  assert.strictEqual(sessionService.prompts.length, beforeRewrite + 1, "a free-text rewrite prompts the session");
  assert.ok(String(sessionService.prompts[beforeRewrite].content[0].text).indexOf("多写接口约束") !== -1, "the user's adjustment is carried");
  const beforeRegen = sessionService.prompts.length;
  mod.__handoff.rewrite("A-fresh-1", "");
  assert.ok(String(sessionService.prompts[beforeRegen].content[0].text).indexOf("~~~handoff") !== -1, "a plain rewrite asks for the fence again");

  /* Without the controller seam the card asks for a manual Enter instead of
     pretending the handoff is running. */
  const usingSeam = sessionService.using;
  sessionService.using = undefined;
  mod.__handoff.set({ sessionId: "", phase: "idle", block: "", needsEnter: false });
  mod.__handoff.start("A-fresh-1");
  assert.strictEqual(mod.__handoff.current().needsEnter, true, "a refused send flips the card to press-Enter");
  sessionService.using = usingSeam;
  mod.__handoff.set({ sessionId: "", phase: "idle", block: "", needsEnter: false });

  /* Carry-over: a new blank through the Host's navigation service, prompted
     through the controller - no draft left behind, no Enter. */
  mod.__handoff.set({ sessionId: "", phase: "idle", block: "", needsEnter: false });
  const beforeCarry = sessionService.prompts.length;
  mod.__handoff.carry("A-fresh-1", "# 交接\n内容");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(service.connected, ["A"], "the blank is created in the session's workspace");
  assert.ok(service.opened.indexOf("handoff-new-1") !== -1, "the new session is opened");
  assert.strictEqual(sessionService.prompts.length, beforeCarry + 1, "the note is the new session's first prompt");
  const carried = sessionService.prompts[beforeCarry];
  assert.strictEqual(carried.target, "handoff-new-1");
  assert.ok(String(carried.content[0].text).indexOf("# 交接\n内容") !== -1, "the note travels verbatim");
  assert.ok(String(carried.content[0].text).indexOf("from the previous Session") !== -1, "the preamble comes first");
  assert.strictEqual(mod.__handoff.current().phase, "idle", "the card closes after the carry");

  /* Without the controller seam the old draft path still runs. */
  const using = sessionService.using;
  sessionService.using = undefined;
  service.started.length = 0;
  mod.__handoff.carry("A-fresh-1", "# 交接\n兜底");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  sessionService.using = using;
  assert.strictEqual(service.started.length, 1, "the fallback opens a draft session");
  assert.ok(String(service.started[0].options.prompt).indexOf("# 交接\n兜底") !== -1, "the note is prefilled there");

  assert.ok(HandoffCard !== null, "the handoff card was registered");
  const tilde = String.fromCharCode(126, 126, 126);
  /* a fence mentioned inside the note must not end it early */
  const fence = String.fromCharCode(96, 96, 96);
  const replyWithInlineFence = [
    fence + "handoff",
    "# 交接",
    "## 当前进度",
    "流程：指令自动发送 → 抓 " + fence + "handoff 块 → 出卡片。",
    "",
    "## 验证方式",
    "六个套件全绿。",
    fence,
    "完。",
  ].join("\n");
  const parsed = mod.__handoff.blockOf(replyWithInlineFence);
  assert.ok(parsed.indexOf("流程：指令自动发送") !== -1, "an inline fence inside the note is kept");
  assert.ok(parsed.indexOf("六个套件全绿") !== -1, "the note is not cut at the inline fence");
  assert.strictEqual(parsed.indexOf("完。"), -1, "text after the closing fence is dropped");
  assert.strictEqual(mod.__handoff.blockOf("没有代码块"), "");
  assert.strictEqual(mod.__handoff.blockOf(fence + "\nnot a document\n" + fence), "", "a fence without a heading is not a handoff");

  /* the tilde fence is the current instruction, and both kinds are read */
  const tildeBlock = [
    tilde + "handoff",
    "# 交接",
    "## 进度",
    "写进 " + fence + "handoff 一类的正文不会截断。",
    tilde,
  ].join("\n");
  assert.strictEqual(mod.__handoff.blockOf(tildeBlock).indexOf("## 进度") !== -1, true, "the tilde block is read");
  const backtickBlock = [fence + "handoff", "# 交接", "内容", fence].join("\n");
  assert.strictEqual(mod.__handoff.blockOf(backtickBlock), "# 交接\n内容", "the backtick block still parses");
  const mixed = [tilde + "handoff", "# 交接", "内容", fence].join("\n");
  assert.strictEqual(mod.__handoff.blockOf(mixed), "", "a mismatched closer does not count");

  const handoffState = mod.__handoff;
  assert.ok(handoffState !== undefined, "the handoff state hook exists");
  handoffState.set({ sessionId: "", phase: "idle", block: "", needsEnter: false });
  assert.strictEqual(HandoffCard({ sessionId: "session-x" }), null, "idle renders nothing");
  handoffState.set({ sessionId: "session-x", phase: "running", block: "", needsEnter: false });
  const live = HandoffCard({ sessionId: "session-x" });
  assert.strictEqual(live.props.className, "wsr-handoff-live", "a running handoff shows progress");
  handoffState.set({ sessionId: "session-x", phase: "ready", block: "# 交接" });
  const card = HandoffCard({ sessionId: "session-x" });
  assert.strictEqual(card.props.className, "wsr-qcard", "a ready handoff renders the question card");
  assert.strictEqual(card.children.length, 5, "header, options, free text, preview and footer");
  const options = card.children[1];
  assert.strictEqual(options.props.className, "wsr-qoptions");
  assert.strictEqual(options.children.length, 2, "two mutually exclusive options");
  assert.ok(options.children[0].props.className.indexOf("wsr-qoption-selected") !== -1, "confirm is selected by default");
  assert.strictEqual(options.children[1].props.className, "wsr-qoption", "the second option is not selected");
  assert.strictEqual(card.children[2].children[0].props.className, "wsr-handoff-extra", "the third control is free text");
  assert.strictEqual(HandoffCard({ sessionId: "other" }), null, "another session shows nothing");

  /* The card lives in a slot that renders once per turn: it may only show on
     the turn the note came from, or it pops under every earlier reply. */
  handoffState.set({ sessionId: "session-x", phase: "ready", block: "# 交接", turn: 5 });
  assert.strictEqual(HandoffCard({ sessionId: "session-x", turn: 4 }), null, "an older turn tail shows no card");
  assert.ok(HandoffCard({ sessionId: "session-x", turn: 5 }) !== null, "the card renders on its own turn");

  /* Waiting for the turn to finish: a tool step that lands first must not make
     the previous reply's block look like the new answer. */
  const readyOf = handoffState.readyOf;
  assert.strictEqual(typeof readyOf, "function", "the readiness predicate is testable");
  assert.strictEqual(readyOf({ ok: true, turnOpen: true, textSeq: 8, lastSeq: 10 }, 7), false, "a running turn is not answered");
  assert.strictEqual(readyOf({ ok: true, turnOpen: false, textSeq: 7, lastSeq: 10 }, 7), false, "the previous reply's text is stale");
  assert.strictEqual(readyOf({ ok: true, turnOpen: false, textSeq: 9, lastSeq: 9 }, 7), true, "a new finished text is accepted");
  assert.strictEqual(readyOf({ ok: false }, 7), false, "a failed tail read is never accepted");
  handoffState.set({ sessionId: "", phase: "idle", block: "", needsEnter: false });

  /* ---------- handoff block extraction ------------------------------- */
  assert.strictEqual(typeof handoffState.blockOf, "function", "the block parser is testable");
  const fullReply = [
    "已写好交接：",
    "",
    "```handoff",
    "# 交接",
    "链路：抓到 ```handoff 块 → 开新会话",
    "## 结尾",
    "最后一行",
    "```",
    "",
    "完。",
  ].join("\n");
  assert.strictEqual(
    handoffState.blockOf(fullReply),
    "# 交接\n链路：抓到 ```handoff 块 → 开新会话\n## 结尾\n最后一行",
    "a fence named inside the note does not close it",
  );
  assert.strictEqual(
    handoffState.blockOf("```\n# 交接\n内容\n```"),
    "# 交接\n内容",
    "an unlabelled fence still counts when it reads like the note",
  );
  assert.strictEqual(handoffState.blockOf("这里没有代码块。"), "", "a reply without a fence yields nothing");
  assert.strictEqual(handoffState.blockOf("```handoff\n# 交接"), "", "an unclosed fence is not taken as ready");
  assert.strictEqual(
    handoffState.blockOf("```js\nconst a = 1;\n```\n```\n# 交接\n内容\n```"),
    "# 交接\n内容",
    "a leading code sample does not win over the note",
  );

  /* ---------- trash panel ------------------------------------------- */
  assert.ok(TrashIcon !== null, "the sidebar panel glyph was registered");
  assert.ok(TrashPage !== null, "the main-region trash page was registered");
  global.fetch.answer = { ok: true, entries: [] };
  const iconElement = TrashIcon({ size: 16 });
  assert.ok(iconElement !== null, "the glyph renders");
  const page = TrashPage({});
  assert.strictEqual(page.props.className, "wsr-page");
  assert.ok(page.children.length > 0);

  /* ---------- delete asks in the page, not with a native dialog ------- */
  /* A native window.confirm left the renderer without keyboard focus on
     Windows: the composer then ignored clicks until the app was refocused. */
  const deleteRow = TrashMenuItem({ sessionId: "A-fresh-1" });
  assert.ok(deleteRow !== null, "the delete menu row renders");
  const beforeDelete = global.fetch.calls.length;
  deleteRow.props.onSelect();
  assert.strictEqual(global.fetch.calls.length, beforeDelete, "nothing is deleted before the user confirms");
  const deleteDialog = overlayRoot.children[overlayRoot.children.length - 1];
  assert.strictEqual(deleteDialog.getAttribute("data-wsr-confirm"), "confirm", "the confirmation is an in-page dialog");
  const deleteText = deleteDialog.querySelector(".wsr-confirm-text");
  assert.ok(deleteText !== null && deleteText.textContent.indexOf("Delete this session") !== -1, "it asks the delete question");
  deleteDialog.querySelector("[data-wsr-confirm-ok]").click();
  assert.strictEqual(global.fetch.calls.length, beforeDelete + 1, "accepting deletes the session");
  assert.ok(String(global.fetch.calls[beforeDelete].url).indexOf("/ws-recency/session-trash") !== -1, "it posts the trash route");
  assert.strictEqual(overlayRoot.children.indexOf(deleteDialog), -1, "the dialog closes after accepting");

  /* ---------- move to workspace ------------------------------------- */
  global.fetch.answer = { ok: true, workspace: "B" };
  assert.ok(MoveMenuItem !== null, "the move menu row was registered");
  const moveItem = MoveMenuItem({ sessionId: "A-fresh-1" });
  assert.ok(moveItem !== null);
  assert.strictEqual(moveItem.children[0], "Move to workspace\u2026");
  moveItem.props.onSelect();
  const moveBackdrop = overlayRoot.children[overlayRoot.children.length - 1];
  assert.ok(String(moveBackdrop.className).indexOf("wsr-modal-backdrop") !== -1);
  const moveBody = moveBackdrop.querySelector(".wsr-modal-body");
  const targets = moveBody.querySelectorAll("[data-wsr-move-target]");
  assert.strictEqual(targets.length, 4, "every workspace is offered");
  assert.strictEqual(targets[0].getAttribute("disabled"), "true", "the current workspace is not a target");
  const warning = moveBody.querySelector(".wsr-move-warning");
  assert.ok(warning !== null, "the dialog warns that files stay behind");
  assert.ok(warning.textContent.indexOf("Only the session moves") !== -1);
  const beforeMove = global.fetch.calls.length;
  targets[1].click();
  assert.strictEqual(global.fetch.calls.length, beforeMove, "the move waits for the confirmation");
  const moveConfirm = overlayRoot.children[overlayRoot.children.length - 1];
  assert.strictEqual(moveConfirm.getAttribute("data-wsr-confirm"), "confirm");
  const moveOk = moveConfirm.querySelector("[data-wsr-confirm-ok]");
  assert.ok(moveOk !== null, "the move asks in-page");
  moveOk.click();
  assert.strictEqual(global.fetch.calls.length, beforeMove + 1, "picking a workspace posts the move");
  assert.ok(String(global.fetch.calls[beforeMove].url).indexOf("/ws-recency/session-move") !== -1);
  assert.deepStrictEqual(JSON.parse(global.fetch.calls[beforeMove].options.body), { sessionId: "A-fresh-1", workspaceId: "B" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(moveBody.children.length > 0);

  conversationNode.attrs["data-conversation-session"] = "";
  render();
  assert.strictEqual(composerSeat.querySelector("[data-wsr-composer-analysis]"), null, "the pill goes away with the conversation");
})().then(() => {
  console.log("selfcheck ok: order A>C>B, fold >3d, controls, colors, pinned section, stats panel");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

