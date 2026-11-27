#!/usr/bin/env node
/**
 * Self-check for dsh-ws-recency's client half: load client.js through a stubbed
 * dynamic-module protocol and a stub DOM, then assert
 *   - group order follows each workspace's freshest `updatedAt`,
 *   - sessions older than foldDays are folded, one control per group,
 *   - colors: running / unread / persistent manual follow-up,
 *   - the global pinned section renders native pins and hides the copies,
 *   - the search page posts the query and jumps to the matching turn.
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

/* Search-jump fixtures: the chat's scroller plus the message the hit points at.
   The real transcript has no per-turn anchor, so the jump locates text. */
const searchScroller = el("div", "scroll");
searchScroller.clientHeight = 600;
searchScroller.scrollTop = 1200;
searchScroller.scrollHeight = 6000;
const searchTurns = {};
const mountedTurn = el("div", "chat-row");
mountedTurn.attrs["data-chat-turn"] = "5";
mountedTurn.scrolled = false;
mountedTurn.textContent = "the build failed here while linking";
mountedTurn.childElementCount = 0;
mountedTurn.scrollIntoView = function () { mountedTurn.scrolled = true; };
searchTurns["5"] = mountedTurn;
/* Every element the transcript holds, so `querySelectorAll("*")` can find the
   message by its text. */
searchScroller.querySelectorAll = function (selector) {
  return selector === "*" ? [mountedTurn] : [];
};

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
    /* The search jump: the chat's scroller and the turn rows it mounts. */
    if (selector === "[data-conversation-scroll]") return searchScroller;
    if (selector.indexOf("[data-chat-turn=") === 0) {
      const turn = selector.slice(selector.indexOf('"') + 1, selector.lastIndexOf('"'));
      return searchTurns[turn] || null;
    }
    /* The plugin looks rows up by their host key when it has to fall back to
       clicking one (the pinned section's navigation fallback). */
    if (selector.indexOf("[data-row-key=") === 0) {
      return root.querySelector(selector) || overlayRoot.querySelector(selector);
    }
    return composerSeat.querySelector(selector);
  },
  createElement: (tag) => el(tag),
  createElementNS(ns, tag) {
    const node = el(tag);
    const base = node.setAttribute.bind(node);
    /* SVG elements expose the class only as an attribute. */
    node.setAttribute = (name, value) => {
      if (name === "class") node.className = String(value);
      base(name, value);
    };
    return node;
  },
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
      IconSearchOutlineRegular: () => ({ type: "icon" }),
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
let SearchIcon = null;
let SearchPage = null;
let FeaturesPage = null;
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
    /* Registrations are disposed when a feature switch goes off: keep a list. */
    registrations: [],
    inject(_name, factory) {
      const disposer = factory();
      return typeof disposer === "function" ? disposer : () => {};
    },
    register(spec2, component) {
      const entry = { spec: spec2, component };
      ctx.slots.registrations.push(entry);
      if (spec2.name === "shell.overlay") Sorter = component;
      if (spec2.name === "settings.general.item") SettingsRow = component;
      if (spec2.name === "sidebar.session.row.leading") FollowUpDot = component;
      if (spec2.id === "ws-recency-stats") StatsMenuItem = component;
      if (spec2.id === "ws-recency-move") MoveMenuItem = component;
      if (spec2.name === "sidebar.panellist" && spec2.id === "ws-recency-trash") TrashIcon = component;
      if (spec2.name === "sidebar.panellist" && spec2.id === "ws-recency-search") SearchIcon = component;
      if (spec2.id === "ws-recency-handoff" && spec2.name === "sidebar.workspaces.session.menu.item") HandoffItem = component;
      if (spec2.id === "ws-recency-handoff" && spec2.name === "conversation.chat.assistant-actions") HandoffAction = component;
      if (spec2.id === "ws-recency-handoff-card") HandoffCard = component;
      if (spec2.name === "plugins.detail.section" && spec2.id === "ws-recency-features") FeaturesPage = component;
      if (spec2.name === "main" && spec2.key === "ws-recency-trash") TrashPage = component;
      if (spec2.name === "main" && spec2.key === "ws-recency-search") SearchPage = component;
      return () => {
        const at = ctx.slots.registrations.indexOf(entry);
        if (at !== -1) ctx.slots.registrations.splice(at, 1);
      };
    },
  },
};
if (typeof mod.__setSearchEnabled === "function") mod.__setSearchEnabled(true);
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
assert.strictEqual(hiddenCount(B), 0, "a project that is all history shows its rows without a second click");
assert.strictEqual(hiddenCount(C), 0, "fresh sessions stay visible");
assert.strictEqual(blankRow.getAttribute("data-wsr-hidden"), null, "the New session row is never folded");

assert.ok(toggleOf(A) !== null, "a group with folded rows gets its own history control");
assert.strictEqual(toggleOf(A).textContent, "Show history (8)", "count covers folded rows plus rows the host has not rendered");
assert.strictEqual(A.button.textContent, "\u5c55\u5f00\u5176\u4f59 5 \u6761\u4f1a\u8bdd", "the host's own button is left untouched");
assert.strictEqual(toggleOf(B), null, "nothing is folded there, so it offers no history control");

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

assert.strictEqual(hiddenCount(B), 0, "an all-history project stays open on its own");

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

/** Render one registered component as the host would: unwrap feature gates. */
function mount(component, props) {
  let node = component(props === undefined ? {} : props);
  /* After a gate wrapper comes its real component, once; a host primitive is a
     leaf and must not be called again (it would lose its children). */
  let unwrapInner = component.__featureGate !== undefined;
  for (let depth = 0; depth < 6; depth += 1) {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (typeof node.type !== "function") return node;
    if (node.type.__featureGate === undefined) {
      if (!unwrapInner) return node;
      unwrapInner = false;
      node = node.type(node.props);
      continue;
    }
    unwrapInner = true;
    node = node.type(node.props);
  }
  return node;
}
const flaggedDot = mount(FollowUpDot, { sessionId: "D-done", useStore: (select) => select(prefs), actions });
assert.ok(flaggedDot !== null, "a flagged session renders the leading dot");
assert.strictEqual(flaggedDot.props.className, "wsr-dot");
assert.strictEqual(D.rows[1].querySelector(".wsr-dot"), null, "nothing is injected into the row");
assert.strictEqual(mount(FollowUpDot, { sessionId: "D-run", useStore: (sel) => sel(prefs), actions }), null);

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

/* A pinned session keeps its colour: the host's copy is hidden, so the state
   has to live on the plugin's own row as well. */
statuses["A-fresh-1"] = { running: true };
render();
const runningPin = pinSection.querySelector(".wsr-pin-row");
assert.strictEqual(runningPin.getAttribute("data-wsr-state"), "running", "a running pinned session is marked");
/* The grouped rows get a spinner from the host; the pinned row draws its own. */
const runningSlot = runningPin.querySelector(".wsr-pin-slot");
assert.strictEqual(runningSlot.getAttribute("data-wsr-dot"), "ongoing", "the pinned row shows the running spinner slot");
assert.strictEqual(runningSlot.querySelector(".wsr-pin-spin").getAttribute("class"), "wsr-pin-spin", "the spinner is an svg");
statuses["A-fresh-1"] = { completionUnread: true };
render();
const unreadPin = pinSection.querySelector(".wsr-pin-row");
assert.strictEqual(unreadPin.getAttribute("data-wsr-state"), "unread", "a pinned session that finished unread is marked");
assert.strictEqual(unreadPin.querySelector(".wsr-pin-slot").getAttribute("data-wsr-dot"), "done", "a finished pinned session gets the done dot");
statuses["A-fresh-1"] = {};
prefs.followUps["A-fresh-1"] = NOW;
render();
assert.strictEqual(pinSection.querySelector(".wsr-pin-row").querySelector(".wsr-pin-slot").getAttribute("data-wsr-dot"), "warning", "a followed-up pinned session gets the amber dot");
delete prefs.followUps["A-fresh-1"];
render();
assert.strictEqual(pinSection.querySelector(".wsr-pin-row").getAttribute("data-wsr-state"), null, "the mark clears with the state");
assert.strictEqual(pinSection.querySelector(".wsr-pin-slot").getAttribute("data-wsr-dot"), "idle", "an idle pinned row keeps an empty slot");

/* Waiting on the user is the host's amber dot, and it outranks "running". */
statuses["A-fresh-1"] = { running: true, pendingInteraction: { kind: "approval" } };
render();
assert.strictEqual(pinSection.querySelector(".wsr-pin-row").getAttribute("data-wsr-state"), "waiting", "a pinned session waiting for approval is marked");
assert.strictEqual(pinSection.querySelector(".wsr-pin-slot").getAttribute("data-wsr-dot"), "warning", "it gets the warning dot");
statuses["A-fresh-1"] = {};
render();
assert.strictEqual(pinSection.querySelector(".wsr-pin-slot").getAttribute("data-wsr-dot"), "idle", "an idle pinned row keeps an empty slot");

/* A rebuild (title change) must paint the state too, not just the in-place pass. */
statuses["A-fresh-1"] = { running: true };
sessions.byId["A-fresh-1"].title = "renamed while running";
render();
assert.strictEqual(pinSection.querySelector(".wsr-pin-row").getAttribute("data-wsr-state"), "running", "a rebuilt pin row keeps the running state");
sessions.byId["A-fresh-1"].title = "pinned one";
statuses["A-fresh-1"] = {};
render();

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
  /* React elements keep their text as string children, not as `textContent`. */
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node === null || node === undefined || typeof node !== "object") return "";
  const parts = [typeof node.textContent === "string" ? node.textContent : ""];
  for (const child of node.children || []) parts.push(textOf(child));
  return parts.join(" ");
}

(async () => {
  assert.ok(typeof mod.__stats.open === "function", "the statistics panel is reachable");

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
      amplified: {
        bill: 10000,
        attributed: 6000,
        share: 0.6,
        steps: 3,
        series: [
          { step: 1, context: 1000, entered: null },
          { step: 2, context: 3000, entered: { kind: "tool", name: "pwsh", detail: "npm test", tokens: 3500 } },
          { step: 3, context: 6000, entered: { kind: "tool", name: "read", detail: "src/app.js", tokens: 9200 } },
        ],
        byKind: [
          { kind: "results", tokens: 500, amplified: 1500, share: 0.15 },
          { kind: "args", tokens: 100, amplified: 300, share: 0.03 },
          { kind: "agent", tokens: 360, amplified: 900, share: 0.09 },
          { kind: "user", tokens: 50, amplified: 100, share: 0.01 },
        ],
        blocks: [
          { kind: "tool", name: "read", detail: "src/app.js", entry: 1, remaining: 5, tokens: 9200, args: 13, results: 9187, amplified: 46000, share: 0.46, saving: 36800 },
          { kind: "tool", name: "pwsh", detail: "npm test", entry: 2, remaining: 4, tokens: 3500, args: 60, results: 3440, amplified: 14000, share: 0.14, saving: 11200 },
        ],
      },
    },
  };

  mod.__stats.open("A-fresh-1");
  assert.strictEqual(global.fetch.calls.length, 1, "opening the panel asks the host for statistics");
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
  /* Five cards again, bill first and accented; the split card is gone, so the
     three-way breakdown rides in its own card as before. */
  assert.strictEqual(body.querySelectorAll(".wsr-stats-card").length, 5, "five cards");
  const cards = body.querySelectorAll(".wsr-stats-card");
  assert.strictEqual(cards[0].querySelector(".wsr-stats-label").textContent, "total", "the bill leads");
  assert.ok(String(cards[0].className).indexOf("wsr-stats-card-primary") !== -1, "only the bill is accented");
  assert.strictEqual(body.querySelectorAll(".wsr-stats-card-primary").length, 1, "one accented card");
  assert.strictEqual(body.querySelector(".wsr-stats-split"), null, "the split line is gone with the wide card");
  assert.strictEqual(body.querySelectorAll(".wsr-stats-footnote").length, 1, "the口径 note appears once");
  assert.strictEqual(body.querySelectorAll(".wsr-stats-note").length, 1, "no second copy of the estimate disclaimer");
  assert.strictEqual(body.querySelectorAll(".wsr-amplified-if").length, 0, "the what-if saving line is gone");

  /* The amplified section: content x remaining steps, not step tokens. */
  const amplified = body.querySelector(".wsr-amplified");
  assert.ok(amplified !== null, "the amplified cost section renders");
  assert.strictEqual(amplified.querySelector(".wsr-amplified-title").textContent, "Amplified cost (what the bill pays for)");
  assert.strictEqual(amplified.querySelectorAll(".wsr-context-bar").length, 3, "one bar per context point");
  /* The steepest rises are marked: the question is "where did the window jump",
     not "compare ninety-six bars by eye". */
  const jumpBars = amplified.querySelectorAll(".wsr-context-jump");
  assert.ok(jumpBars.length >= 1 && jumpBars.length <= 3, "the steepest rises are marked");
  const jumpRows = amplified.querySelectorAll(".wsr-context-jump-row");
  assert.ok(jumpRows.length >= 1, "each marked rise is spelled out");
  assert.ok(textOf(jumpRows[0]).indexOf("step 3") !== -1, "the biggest rise names step 3");
  /* Each row is a column layout carrying its rank, so the dot on the chart and
     the line under it can be matched by colour instead of by reading prose. */
  assert.ok(jumpRows[0].getAttribute("data-wsr-rank") !== null, "a row knows its rank");
  const rankDots = jumpRows[0].querySelectorAll(".wsr-context-jump-rank-dot");
  assert.strictEqual(rankDots.length, 1, "the row leads with its rank dot");
  assert.ok(textOf(jumpRows[0]).indexOf("+") !== -1, "the rise is shown as a delta");
  /* The row must say what entered: a step number and a delta alone leave the
     reader guessing which file or tool caused it. */
  const what = jumpRows[0].querySelector(".wsr-context-jump-what");
  assert.ok(what !== null, "the row names what entered");
  assert.ok(String(what.textContent).length > 0, "and it is not blank when the blocks are known");
  const jumpHits = amplified.querySelectorAll(".wsr-context-jump-hit");
  assert.ok(jumpHits.length >= 1, "the chart marker has its own hit area");
  /* The chart lists bars by step while the rows list rises by rank, so pair them
     by step, not by position. */
  const firstStep = jumpRows[0].getAttribute("data-wsr-jump-row");
  const matchingHit = Array.from(jumpHits).find((hit) => hit.getAttribute("data-wsr-jump-hit") === firstStep);
  assert.ok(matchingHit !== undefined, "every marked row has a marker on the curve");
  assert.strictEqual(matchingHit.getAttribute("data-wsr-rank"), jumpRows[0].getAttribute("data-wsr-rank"), "marker and row share the rank");
  /* The ranking lives in its own tab now: the curve answers "when", the ranking
     answers "what", and stacking both in one scroll hid half of each. */
  const rankingPanel = body.querySelector(".wsr-amplified-ranking");
  assert.ok(rankingPanel !== null, "the ranking renders in its own panel");
  assert.strictEqual(amplified.querySelectorAll(".wsr-kind").length, 0, "the composition legend is not on the curve tab");
  assert.strictEqual(rankingPanel.querySelectorAll(".wsr-kind").length, 4, "the kind legend lists the parts on the ranking tab");
  /* The copy has to say why these numbers dwarf the distribution tab's. */
  assert.ok(textOf(rankingPanel).indexOf("re-read") !== -1, "the ranking explains the multiplier");
  const amplifiedRows = rankingPanel.querySelectorAll(".wsr-amplified-row");
  assert.strictEqual(amplifiedRows.length, 2, "the ranking lists the amplified blocks");
  const topRow = amplifiedRows[0];
  assert.ok(textOf(topRow).indexOf("read") !== -1, "the top block is the read");
  assert.ok(textOf(topRow).indexOf("src/app.js") !== -1, "its file is shown");
  assert.ok(textOf(topRow).indexOf("46.0K") !== -1, "the amplified total is shown");
  assert.ok(textOf(topRow).indexOf("46.0%") !== -1, "its share of the bill is shown");
  assert.ok(textOf(topRow).indexOf("36.8K") === -1, "the what-if saving line is gone: the jump markers carry the advice now");
  assert.strictEqual(topRow.querySelector(".wsr-amplified-value").getAttribute("title"), "46000 tokens", "the exact count is on hover, so K/M units never need converting by hand");
  assert.ok(textOf(rankingPanel).indexOf("re-read") !== -1, "the meta says how often it is re-read");

  /* The header row shares the grid, so the bar rows are one fewer than the rows
     in the DOM; every bar row must keep five cells or the columns drift. */
  const headerRow = body.querySelector(".wsr-chart-headrow");
  assert.ok(headerRow !== null, "the chart has a column header row");
  const chartRows = body.querySelectorAll(".wsr-chart-row").filter((row) => row !== headerRow);
  assert.strictEqual(chartRows.length, 3, "one bar per source: the agent plus both tools");
  for (const row of chartRows) {
    assert.strictEqual(row.children.length, 5, "every bar row fills the five-column grid");
  }
  assert.strictEqual(headerRow.querySelector(".wsr-chart-calls-head").textContent, "calls", "the count column is labelled");
  assert.strictEqual(chartRows[1].querySelector(".wsr-chart-calls").textContent, "4x", "a tool row carries its call count");
  assert.strictEqual(chartRows[0].querySelector(".wsr-chart-calls").textContent, "", "the agent row keeps the cell empty, not missing");
  assert.strictEqual(chartRows[0].querySelector(".wsr-chart-value").textContent, "360");
  assert.strictEqual(chartRows[1].querySelector(".wsr-chart-label").textContent, "pwsh");
  const widest = chartRows[1].querySelector(".wsr-chart-group").style.width;
  assert.strictEqual(widest, "100.00%", "the largest bar fills the track");
  assert.ok(chartRows[0].querySelector(".wsr-chart-group").style.width !== widest, "smaller bars are shorter");

  /* Colour identity is the tool family, at one fixed vividness: the hue says
     what kind of work it is, never how big it got. */
  assert.strictEqual(chartRows[0].querySelector(".wsr-chart-group").style.background, undefined, "the group never paints a colour behind the segments");
  assert.strictEqual(chartRows[1].querySelector(".wsr-bar-results").style.background, "hsl(32, 72%, 58%)", "pwsh is a shell tool");
  assert.strictEqual(chartRows[2].querySelector(".wsr-bar-results").style.background, "hsl(152, 72%, 58%)", "read is a file tool at the same vividness");
  assert.strictEqual(chartRows[1].querySelector(".wsr-chart-family").textContent, "shell", "the name cell names the family its colour stands for");
  assert.strictEqual(chartRows[2].querySelector(".wsr-chart-family").textContent, "files", "the other family is named too");

  /* ---------- the argument / result split ------------------------------- */
  /* pwsh: 100 args of 600 total -> the light segment is a sixth of the bar. */
  const splitBar = chartRows[1];
  const argsSeg = splitBar.querySelector(".wsr-bar-args");
  const resultsSeg = splitBar.querySelector(".wsr-bar-results");
  assert.ok(argsSeg !== null, "a tool bar carries an argument segment");
  assert.ok(resultsSeg !== null, "a tool bar carries a result segment");
  assert.strictEqual(argsSeg.style.width, "16.67%", "the argument segment is sized inside the tool's bar");
  assert.strictEqual(resultsSeg.style.width, "83.33%", "the rest of the bar is results");
  assert.strictEqual(argsSeg.style.background, "hsl(32, 32%, 84%)", "the argument segment is a much lighter shade of the family");
  /* The split has to be legible on its own, so the bar says what its two shades mean. */
  const splitGroup = argsSeg.parentElement;
  assert.ok(splitGroup.getAttribute("title") !== null, "a split bar explains its shades on hover");
  assert.ok(String(splitGroup.getAttribute("title")).indexOf("total") !== -1, "the tooltip names the tool's total");
  assert.ok(String(splitGroup.getAttribute("title")).indexOf("light") === -1, "no colour words in the copy: users read them as the row colours below");
  assert.notStrictEqual(argsSeg.style.background, resultsSeg.style.background, "the two segments must not composite to the same colour");
  assert.strictEqual(argsSeg.style.opacity, undefined, "the contrast comes from the colour, not from opacity over a same-hue bar");
  assert.strictEqual(chartRows[0].querySelector(".wsr-bar-args"), null, "the agent bar is not split");
  const legend = body.querySelector(".wsr-chart-legend");
  assert.ok(legend !== null, "the split bars come with a legend");
  assert.strictEqual(legend.children.length, 2, "two legend entries: arguments and results");

  /* The toggle moves the argument tokens onto the agent. */
  prefs.argMode = "agent";
  mod.__stats.open("A-fresh-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const agentBody = overlayRoot.children[overlayRoot.children.length - 1].children[0].querySelector(".wsr-modal-body");
  const agentHeader = agentBody.querySelector(".wsr-chart-headrow");
  const agentRows = agentBody.querySelectorAll(".wsr-chart-row").filter((row) => row !== agentHeader);
  assert.strictEqual(agentRows[0].querySelector(".wsr-chart-value").textContent, "470", "the agent keeps its own tokens plus the moved arguments");
  assert.strictEqual(agentRows[1].querySelector(".wsr-chart-value").textContent, "500", "the tool keeps only its results");
  assert.strictEqual(agentRows[1].querySelector(".wsr-bar-args"), null, "nothing is split when arguments belong to the agent");
  assert.strictEqual(agentBody.querySelector(".wsr-chart-legend"), null, "the legend goes away too");
  assert.ok(textOf(agentBody).indexOf("currently count towards the agent") !== -1, "the panel explains the mode");
  overlayRoot.children[overlayRoot.children.length - 1].children[0].querySelector(".wsr-modal-close").click();
  prefs.argMode = "tool";
  assert.strictEqual(prefs.argMode, "tool", "the default mode stays per-tool");

  /* A compaction restarts the window, so each segment ranks its own top three:
     the steepest step before the rewrite cannot hide the ones after it. */
  global.fetch.answer.stats.amplified.series = [
    { step: 1, context: 1000, entered: null },
    { step: 2, context: 2000, entered: { kind: "tool", name: "grep", detail: "docs", tokens: 1200 } },
    { step: 3, context: 4000, entered: { kind: "tool", name: "read", detail: "a.md", tokens: 2200 } },
    { step: 4, context: 9000, entered: { kind: "tool", name: "read", detail: "b.md", tokens: 6000 } },
    { step: 5, context: 100, entered: null },
    { step: 6, context: 2000, entered: { kind: "tool", name: "pwsh", detail: "npm test", tokens: 1800 } },
    { step: 7, context: 6000, entered: { kind: "tool", name: "read", detail: "c.md", tokens: 4000 } },
    { step: 8, context: 7000, entered: { kind: "tool", name: "edit", detail: "d.ts", tokens: 900 } },
  ];
  global.fetch.answer.stats.amplified.compactions = [4];
  mod.__stats.open("A-fresh-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const segmentedBody = overlayRoot.children[overlayRoot.children.length - 1].children[0].querySelector(".wsr-modal-body");
  const segmentedGroups = segmentedBody.querySelectorAll(".wsr-context-jump-group");
  assert.strictEqual(segmentedGroups.length, 2, "one line per segment, not one per marker");
  const seg1 = segmentedGroups[0].querySelectorAll(".wsr-context-jump-row");
  const seg2 = segmentedGroups[1].querySelectorAll(".wsr-context-jump-row");
  assert.strictEqual(seg1.length, 3, "the first segment keeps its own top three");
  assert.strictEqual(seg2.length, 3, "the second segment gets its own top three");
  assert.ok(textOf(segmentedGroups[0]).indexOf("seg 1") !== -1, "the line names its segment");
  assert.ok(textOf(seg1[0]).indexOf("step 4") !== -1, "the first segment leads with its steepest step");
  assert.ok(textOf(seg2[0]).indexOf("step 7") !== -1, "the second segment leads with its own steepest step");
  assert.strictEqual(seg1[0].getAttribute("data-wsr-rank"), "1", "each segment ranks from the first hue");
  assert.strictEqual(seg2[0].getAttribute("data-wsr-rank"), "1", "the next segment starts its own ranking");
  assert.ok(segmentedBody.querySelector(".wsr-context-break") !== null, "the rewrite is drawn on the curve");
  overlayRoot.children[overlayRoot.children.length - 1].children[0].querySelector(".wsr-modal-close").click();
  /* Back to the single-segment fixture for the remaining assertions. */
  global.fetch.answer.stats.amplified.series = [{ step: 1, context: 1000 }, { step: 2, context: 3000 }, { step: 3, context: 6000 }];
  delete global.fetch.answer.stats.amplified.compactions;

  /* Three tabs: distribution, the curve with its jumps, and the ranking. The old
     details table only repeated the chart, so its one unique number (call counts)
     moved onto the bars and the agent split moved under the chart. */
  const tabs = body.querySelectorAll(".wsr-stats-tab");
  assert.strictEqual(tabs.length, 3, "three tabs");
  assert.deepStrictEqual(tabs.map((button) => button.textContent), ["Distribution", "Amplified", "Ranking"]);
  const distributionPanel = body.querySelectorAll(".wsr-stats-panel")[0];
  const amplifiedPanel = body.querySelector(".wsr-amplified").parentElement;
  const rankingTabPanel = body.querySelectorAll(".wsr-stats-panel")[2];
  assert.strictEqual(body.querySelector(".wsr-stats-table"), null, "the redundant table is gone");
  assert.ok(distributionPanel.querySelector(".wsr-chart-calls") !== null, "call counts ride on the bars");
  assert.ok(distributionPanel.querySelector(".wsr-stats-detail") !== null, "the agent split stays under the chart");
  assert.strictEqual(distributionPanel.style.display, "", "distribution is the default tab");
  assert.strictEqual(amplifiedPanel.style.display, "none", "the amplified tab starts hidden");
  assert.strictEqual(rankingTabPanel.style.display, "none", "the ranking tab starts hidden");
  tabs[1].click();
  assert.strictEqual(amplifiedPanel.style.display, "", "the amplified tab shows its panel");
  assert.strictEqual(distributionPanel.style.display, "none", "the other panel is hidden");
  assert.strictEqual(amplifiedPanel.querySelector(".wsr-amplified-row"), null, "the curve tab carries no ranking");
  tabs[2].click();
  assert.strictEqual(rankingTabPanel.style.display, "", "the ranking tab shows its panel");
  assert.ok(rankingTabPanel.querySelector(".wsr-amplified-row") !== null, "and it holds the ranking rows");
  tabs[0].click();
  assert.strictEqual(distributionPanel.style.display, "", "back to distribution");

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
  assert.ok(HandoffAction !== null, "the turn handoff action was registered");
  const handoffAction = mount(HandoffAction, { sessionId: "session-x", messageId: "m1" });
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

  /* The session-menu row for handoff is gone; the turn action above is the entry. */


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
  assert.strictEqual(mount(HandoffCard, { sessionId: "session-x" }), null, "idle renders nothing");
  handoffState.set({ sessionId: "session-x", phase: "running", block: "", needsEnter: false });
  const live = mount(HandoffCard, { sessionId: "session-x" });
  assert.strictEqual(live.props.className, "wsr-handoff-live", "a running handoff shows progress");
  handoffState.set({ sessionId: "session-x", phase: "ready", block: "# 交接" });
  const card = mount(HandoffCard, { sessionId: "session-x" });
  assert.strictEqual(card.props.className, "wsr-qcard", "a ready handoff renders the question card");
  assert.strictEqual(card.children.length, 5, "header, options, free text, preview and footer");
  const options = card.children[1];
  assert.strictEqual(options.props.className, "wsr-qoptions");
  assert.strictEqual(options.children.length, 2, "two mutually exclusive options");
  assert.ok(options.children[0].props.className.indexOf("wsr-qoption-selected") !== -1, "confirm is selected by default");
  assert.strictEqual(options.children[1].props.className, "wsr-qoption", "the second option is not selected");
  assert.strictEqual(card.children[2].children[0].props.className, "wsr-handoff-extra", "the third control is free text");
  assert.strictEqual(mount(HandoffCard, { sessionId: "other" }), null, "another session shows nothing");

  /* The card lives in a slot that renders once per turn: it may only show on
     the turn the note came from, or it pops under every earlier reply. */
  handoffState.set({ sessionId: "session-x", phase: "ready", block: "# 交接", turn: 5 });
  assert.strictEqual(mount(HandoffCard, { sessionId: "session-x", turn: 4 }), null, "an older turn tail shows no card");
  assert.ok(mount(HandoffCard, { sessionId: "session-x", turn: 5 }) !== null, "the card renders on its own turn");

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
  const iconElement = mount(TrashIcon, { size: 16 });
  assert.ok(iconElement !== null, "the glyph renders");
  const page = mount(TrashPage, {});
  assert.strictEqual(page.props.className, "wsr-page");
  assert.ok(page.children.length > 0);

  /* The session menu no longer carries a delete row: it holds the follow-up mark
     and move-to-workspace only. The trash panel and its routes are unchanged. */
  /* ---------- move to workspace ------------------------------------- */
  global.fetch.answer = { ok: true, workspace: "B" };
  assert.ok(MoveMenuItem !== null, "the move menu row was registered");
  const moveItem = mount(MoveMenuItem, { sessionId: "A-fresh-1" });
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

  /* ---------- session content search ----------------------------------- */
  const SEARCH = mod.__search;
  assert.ok(SEARCH !== undefined, "the search hooks are exposed");
  assert.ok(SearchIcon !== null, "the search panel glyph was registered");
  assert.ok(mount(SearchIcon, { size: 16 }) !== null, "the search glyph renders");
  assert.ok(SearchPage !== null, "the search page was registered");
  SEARCH.resetHistoryMirror();
  const searchPage = mount(SearchPage, {});
  assert.strictEqual(searchPage.props.className, "wsr-page wsr-search-page");

  const findNode = (node, predicate) => {
    if (node === null || typeof node !== "object") return null;
    if (predicate(node)) return node;
    const nodes = Array.isArray(node.children) ? node.children : [];
    for (const child of nodes) {
      const found = findNode(child, predicate);
      if (found !== null) return found;
    }
    return null;
  };

  const searchInput = findNode(searchPage, (node) => node.props !== undefined && node.props.className === "wsr-search-input");
  assert.ok(searchInput !== null, "the search box renders");

  /* Recent queries: a chip re-runs one, its × removes it, and Clear empties the
     list. The list lives in the shared store, so it survives a restart. */
  /* One entry predates the scope change (a bare string), one carries it. */
  const historyStore = { searchHistory: [{ query: "build failed", workspace: "Work", session: "", role: "assistant" }, "CDP"] };
  const dropped = [];
  SEARCH.resetHistoryMirror();
  const searchPageWithHistory = mount(SearchPage, {
    useStore: () => historyStore,
    actions: {
      pushSearch: function (query) { dropped.push(["push", query]); },
      dropSearch: function (query) { dropped.push(["drop", query]); },
      clearSearches: function () { dropped.push(["clear"]); },
    },
  });
  const chips = [];
  (function walk(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.props !== undefined && node.props.className === "wsr-search-chip") chips.push(node);
    for (const child of node.children || []) walk(child);
  })(searchPageWithHistory);
  assert.strictEqual(chips.length, 2, "each remembered query gets a chip");
  const chipButtons = chips[0].children.filter((node) => node.props !== undefined && typeof node.props.onClick === "function");
  assert.strictEqual(chipButtons.length, 2, "a chip carries a run button and a remove button");
  assert.strictEqual(chipButtons[0].children[0], "build failed (Work · assistant)", "the chip shows the query together with its scope");
  chipButtons[1].props.onClick({ stopPropagation() {} });
  assert.deepStrictEqual(dropped[0][0], "drop", "the × removes one entry");
  assert.deepStrictEqual(dropped[0][1], { query: "build failed", workspace: "Work", session: "", role: "assistant" }, "it removes the entry with its scope, so the same words in another scope survive");

  /* Clicking a chip restores the whole search, not just its words. */
  const applied = [];
  SEARCH.resetHistoryMirror();
  const scopePage = mount(SearchPage, {
    useStore: () => ({ searchHistory: [{ query: "CDP", workspace: "Bluegleam", session: "", role: "user" }] }),
    actions: {
      pushSearch: function (entry) { applied.push(entry); },
      dropSearch: function () {},
      clearSearches: function () {},
    },
  });
  let scopeChip = null;
  (function walk(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.props !== undefined && node.props.className === "wsr-search-chip") scopeChip = node;
    for (const child of node.children || []) walk(child);
  })(scopePage);
  assert.ok(scopeChip !== null, "the stored search has a chip");
  const scopeRun = scopeChip.children.find((node) => node.props !== undefined && node.props.className === "wsr-search-chip-run");
  assert.ok(String(scopeRun.children[0]).indexOf("Bluegleam") !== -1, "the chip names the scope it was run with");
  scopeRun.props.onClick();
  assert.strictEqual(SEARCH.filters().workspace, "Bluegleam", "clicking the chip restores the workspace it was run with");
  assert.strictEqual(SEARCH.filters().role, "user", "and the role");
  assert.strictEqual(SEARCH.draft(), "CDP", "and puts its words back in the field");

  /* What the store keeps must be a plain string: an object did not survive its
     write path, and the chips vanished after every search because of it. */
  const pushed = [];
  /* Start from an empty scope: the previous case left filters set. */
  SEARCH.filters().workspace = "";
  SEARCH.filters().session = "";
  SEARCH.filters().role = "";
  SEARCH.resetHistoryMirror();
  const writePage = mount(SearchPage, {
    useStore: () => ({ searchHistory: [] }),
    actions: { pushSearch: function (entry) { pushed.push(entry); }, dropSearch() {}, clearSearches() {} },
  });
  const writeInput = findNode(writePage, (node) => node.props !== undefined && node.props.className === "wsr-search-input");
  writeInput.props.onChange({ target: { value: "lulu" } });
  const writeRun = findNode(writePage, (node) => node.props !== undefined && node.props.className === "wsr-btn wsr-btn-primary");
  writeRun.props.onClick();
  assert.strictEqual(pushed.length, 1, "running a search records one entry");
  assert.deepStrictEqual(pushed[0], { query: "lulu", workspace: "", session: "", role: "" }, "the recorded entry carries the scope as well");

  /* The store keeps one encoded string per search: objects did not survive its
     write path, which is why the chips disappeared after every search. */
  const encoded = SEARCH.encodeSearch({ query: "CDP", workspace: "Bluegleam", session: "", role: "user" });
  assert.strictEqual(typeof encoded, "string", "an entry is stored as a string");
  assert.deepStrictEqual(SEARCH.decodeSearch(encoded), { query: "CDP", workspace: "Bluegleam", session: "", role: "user" }, "and decodes back with its scope");
  assert.deepStrictEqual(SEARCH.decodeSearch("old entry"), { query: "old entry", workspace: "", session: "", role: "" }, "an entry from an older version still reads");
  const clearNode = (function find(node) {
    if (node === null || typeof node !== "object") return null;
    if (node.props !== undefined && node.props.className === "wsr-search-history-clear") return node;
    for (const child of node.children || []) {
      const found = find(child);
      if (found !== null) return found;
    }
    return null;
  })(searchPageWithHistory);
  assert.ok(clearNode !== null, "the history row offers a clear button");
  clearNode.props.onClick();
  assert.deepStrictEqual(dropped[dropped.length - 1], ["clear"], "clear empties the list");

  /* A hit far behind the newest turn asks first instead of stalling the app. */
  const coldRow = SEARCH.hitRow(
    { sessionId: "s", turn: 3, turns: 130, role: "user", snippet: "x", seq: 1 },
    [],
    function () {},
    null,
  );
  assert.ok(coldRow !== null, "a hit row renders");

  /* Narrowing is a control, not syntax: a workspace select, a title box and three
     role chips, and the words in the box stay words. */
  const filterRow = findNode(searchPage, (node) => node.props !== undefined && node.props.className === "wsr-filters");
  assert.ok(filterRow !== null, "the search panel shows its filter controls");
  const filterText = [];
  (function walkFilters(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walkFilters(child);
      return;
    }
    if (node.props !== undefined && typeof node.props.className === "string" && node.props.className.indexOf("wsr-seg-item") === 0) filterText.push(node.children[0]);
    for (const child of node.children || []) walkFilters(child);
  })(filterRow);
  assert.deepStrictEqual(filterText, ["All", "You", "Assistant"], "the role filter offers all three choices");
  const helpButton = findNode(searchPage, (node) => node.props !== undefined && String(node.props.className || "").indexOf("wsr-help") === 0);
  assert.ok(helpButton !== null, "the syntax hint is one click away, not a permanent line");
  assert.strictEqual(findNode(searchPage, (node) => node.props !== undefined && node.props.className === "wsr-search-hint"), null, "the hint stays hidden until asked for");
  searchInput.props.onChange({ target: { value: "build failed" } });
  assert.strictEqual(SEARCH.draft(), "build failed", "the draft follows the input");

  global.fetch.answer = { ok: true, query: "build failed", terms: ["build", "failed"], hits: [], scanned: 3, total: 3, pending: 0, took: 12 };
  const beforeSearch = global.fetch.calls.length;
  searchInput.props.onKeyDown({ key: "Enter", preventDefault() {} });
  const searchCall = global.fetch.calls[beforeSearch];
  assert.ok(String(searchCall.url).indexOf("/ws-recency/search") !== -1, "Enter posts the search route");
  assert.strictEqual(JSON.parse(searchCall.options.body).query, "build failed", "the whole query is sent");

  /* A hit names its session and when it was said: without those two, two hits
     from the same workspace read identically. */
  const hitNode = SEARCH.hitRow({
    sessionId: "sess-1234567890abcdef",
    title: "Alpha work",
    workspace: "Work",
    cwd: "C:\\work",
    turn: 3,
    step: 7,
    seq: 42,
    at: 1763456789000,
    role: "assistant",
    snippet: "build failed here",
    lead: false,
    tail: false,
  }, ["build"], function () {});
  const hitHead = findNode(hitNode, (node) => node.props !== undefined && node.props.className === "wsr-hit-head");
  assert.ok(textOf(hitHead).indexOf("Alpha work") === -1, "the row does not repeat the session title");
  /* The step is what the reader checks against the chat after jumping. */
  const hitStep = findNode(hitNode, (node) => node.props !== undefined && node.props.className === "wsr-hit-pos");
  assert.ok(hitStep !== null, "an assistant hit names its turn and step");
  assert.strictEqual(hitStep.children[0], "turn 3 · step 7", "turn and step share one chip");
  const noStepHit = SEARCH.hitRow({ sessionId: "s", turn: 2, role: "user", snippet: "x" }, [], function () {});
  assert.strictEqual(findNode(noStepHit, (node) => node.props !== undefined && node.props.className === "wsr-hit-pos").children[0], "turn 2", "a prompt carries no step");
  const hitTitle = String(hitNode.props.title);
  assert.ok(hitTitle.indexOf("Alpha work") !== -1, "the session title stays available on hover");
  assert.ok(textOf(hitNode).indexOf("C:\\work") === -1, "the row does not repeat the working directory");
  const hitSnippet = findNode(hitNode, (node) => node.props !== undefined && node.props.className === "wsr-hit-snippet");
  assert.ok(hitSnippet !== null, "the snippet is still the body of the row");
  assert.ok(JSON.stringify(hitSnippet).indexOf("failed") !== -1, "and it carries the matched words");
  const hitTime = findNode(hitNode, (node) => node.props !== undefined && node.props.className === "wsr-hit-time");
  assert.ok(hitTime !== null, "and the time it was said");
  assert.ok(String(hitTime.children[0]).length > 0, "the time is not blank");
  /* With no title the id stands in, shortened so it stays readable. */
  const untitled = SEARCH.hitRow({ sessionId: "sess-1234567890abcdef", turn: 1, role: "user", snippet: "x" }, [], function () {});
  assert.ok(String(untitled.props.title).indexOf("sess-123") !== -1, "an untitled session falls back to its id on hover");
  assert.ok(String(untitled.props.title).indexOf("sess-1234567890abcdef") === -1, "the id is shortened");

  /* Highlighting the query's terms inside the transcript is drawn through the
     Custom Highlight API: no DOM is mutated, so React never fights it. */
  const painted = [];
  global.window.CSS = { highlights: { set: (name, value) => painted.push([name, value]), delete: () => {} } };
  global.window.Highlight = class { constructor(ranges) { this.ranges = ranges; } };
  global.NodeFilter = { SHOW_TEXT: 4 };
  global.document.createTreeWalker = (root) => {
    const nodes = [root];
    let index = -1;
    return { nextNode: () => (index += 1) < nodes.length ? nodes[index] : null, currentNode: null };
  };
  const textNode = { nodeValue: "the build failed here", parentElement: mountedTurn };
  global.document.createRange = () => ({
    startContainer: null,
    setStart(node) { this.startContainer = node; },
    setEnd() {},
  });
  global.document.createTreeWalker = () => {
    const nodes = [textNode];
    let index = -1;
    return {
      get currentNode() { return nodes[index]; },
      nextNode() { index += 1; return index < nodes.length ? nodes[index] : null; },
    };
  };
  SEARCH.jump({ sessionId: "A-fresh-1", turn: 5, turns: 10, seek: "the build failed here" }, ["build"]);
  flush();
  assert.ok(painted.length >= 1, "the query term is painted in the transcript");
  assert.strictEqual(painted[0][0], "wsr-search-hit", "the highlight is registered by name");
  delete global.window.CSS;
  delete global.window.Highlight;
  delete global.NodeFilter;

  /* Highlighting works on the snippet, so the list never re-renders to mark it. */
  const marked = SEARCH.highlight("the build failed here", ["build", "failed"]);
  const markNodes = marked.filter((node) => node.type === "mark");
  assert.strictEqual(markNodes.length, 2, "every term is marked");
  assert.strictEqual(markNodes[0].children[0], "build");
  assert.strictEqual(markNodes[1].children[0], "failed");

  /* A hit opens its session and rings the message it came from. The transcript
     exposes no turn anchor, so the jump finds the message by its text. */
  service.opened.length = 0;
  mountedTurn.scrolled = false;
  SEARCH.jump({ sessionId: "A-fresh-1", turn: 5, turns: 10, seek: "the build failed here" });
  assert.deepStrictEqual(service.opened, ["A-fresh-1"], "clicking a hit opens the session");
  flush();
  assert.strictEqual(mountedTurn.scrolled, true, "the matching message is scrolled into view");
  assert.strictEqual(mountedTurn.getAttribute("data-wsr-flash"), null, "the ring is cleared afterwards");

  /* A hit whose text is not on screen falls back to the chat's own turn rail:
     clicking the mark for that turn is the official navigation. */
  const railClicks = [];
  const railMark = el("button", "-U5R9G_mark");
  railMark.attrs["data-index"] = "7";
  railMark.attrs["aria-label"] = "Jump to turn 9";
  railMark.click = function () { railClicks.push(9); };
  /* A mark only counts when it is on screen: the rail of a session being left
     behind is still in the document for a moment. */
  railMark.getBoundingClientRect = () => ({ top: 100, left: 900, height: 8, width: 10 });
  global.document.querySelectorAll = function (selector) {
    if (selector === "button[data-index]") return [railMark];
    return [];
  };
  SEARCH.jump({ sessionId: "A-fresh-1", turn: 9, turns: 10, seek: "text that is not mounted" });
  flush();
  assert.deepStrictEqual(railClicks, [9], "the rail mark for the turn is clicked");

  /* The click starts a page load in the host; until the turn is really in the
     document, the note says it is loading rather than claiming success. */
  const loadingNotes = [];
  const realBodyAppendForLoading = global.document.body.appendChild;
  global.document.body.appendChild = function (node) {
    if (node !== null && typeof node === "object" && String(node.className).indexOf("wsr-jump-loading") !== -1) loadingNotes.push(node);
    return node;
  };
  SEARCH.jump({ sessionId: "A-fresh-1", turn: 9, turns: 120, seek: "text that is not mounted" });
  flush();
  assert.ok(loadingNotes.length >= 1, "a jump into older history reports that it is loading");
  assert.ok(String(loadingNotes[0].textContent).indexOf("9") !== -1, "the loading note names the turn");
  global.document.body.appendChild = realBodyAppendForLoading;


  /* A hit whose text is not on screen at least moves the transcript: the jump
     estimates the position from the turn index before it looks for the text. */
  global.document.querySelectorAll = () => [];
  const beforeJump = searchScroller.scrollTop;
  SEARCH.jump({ sessionId: "A-fresh-1", turn: 9, turns: 10, seek: "text that is not mounted" });
  flush();
  assert.ok(searchScroller.scrollTop !== beforeJump || searchScroller.scrollTop > 0, "the transcript moves towards the hit");

  /* A turn whose body is not rendered must not be reported as a hit: a very long
     session renders old turns without their message content. */
  const stub = el("div", "chat-row");
  stub.attrs["data-chat-turn"] = "6";
  stub.textContent = "";
  stub.childElementCount = 0;
  stub.scrolled = false;
  stub.scrollIntoView = function () { stub.scrolled = true; };
  searchTurns["6"] = stub;
  const toasts = [];
  const realAppend = overlayRoot.appendChild.bind(overlayRoot);
  overlayRoot.appendChild = function (node) {
    if (node !== null && typeof node === "object" && String(node.className).indexOf("wsr-jump-toast") !== -1) toasts.push(node);
    return realAppend(node);
  };
  const realBodyAppend = global.document.body.appendChild;
  global.document.body.appendChild = function (node) {
    if (node !== null && typeof node === "object" && String(node.className).indexOf("wsr-jump-toast") !== -1) toasts.push(node);
    return node;
  };
  SEARCH.jump({ sessionId: "A-fresh-1", turn: 6, turns: 10, seek: "text not inside the stub" });
  flush();
    /* A row with words is the landing even when the snippet does not match: the
     seek text is trimmed and re-wrapped, and reporting 'collapsed' here used to be
     followed by a contradictory 'turn not found' after the poll gave up. */
  const shortRow = el("div", "chat-row");
  shortRow.attrs["data-chat-turn"] = "7";
  shortRow.textContent = "短消息，和命中片段不完全一致";
  shortRow.childElementCount = 0;
  shortRow.scrolled = false;
  shortRow.scrollIntoView = function () { shortRow.scrolled = true; };
  searchTurns["7"] = shortRow;
  const landedToasts = [];
  const realBody = global.document.body.appendChild;
  global.document.body.appendChild = function (node) {
    if (node !== null && typeof node === "object" && String(node.className).indexOf("wsr-jump-toast") !== -1) landedToasts.push(node);
    return node;
  };
  SEARCH.jump({ sessionId: "A-fresh-1", turn: 7, turns: 10, seek: "完全不匹配的片段" });
  flush();
  assert.ok(landedToasts.length >= 1, "a rendered row reports a landing");
  assert.ok(String(landedToasts[0].textContent).indexOf("7") !== -1, "the landing names the turn");
  assert.strictEqual(String(landedToasts[0].className).indexOf("wsr-jump-loading") === -1, true, "it is not the loading note");
  global.document.body.appendChild = realBody;
  delete searchTurns["7"];

assert.ok(toasts.some((node) => String(node.textContent).indexOf("collapsed") !== -1), "a stub row is reported instead of claiming success");
  global.document.body.appendChild = realBodyAppend;
  overlayRoot.appendChild = realAppend;
  delete searchTurns["6"];

  SEARCH.resumePasses();
  conversationNode.attrs["data-conversation-session"] = "";
  render();
  /* A jump suspends the sidebar pass until the host settles, so the deferred
     pass is what clears the pill here. */
  flush();
  assert.strictEqual(composerSeat.querySelector("[data-wsr-composer-analysis]"), null, "the pill goes away with the conversation");
})().then(() => {
    /* ---------- search result grouping ---------------------------------- */
  {
    const hits = [
      { sessionId: "s1", title: "alpha", workspace: "ws-a", cwd: "D:\\a", turn: 5, step: 1, seq: 50, at: 900, sessionAt: 1000, turns: 130 },
      { sessionId: "s2", title: "beta", workspace: "ws-a", cwd: "D:\\a", turn: 2, step: 1, seq: 20, at: 500, sessionAt: 400, turns: 3 },
      { sessionId: "s1", title: "alpha", workspace: "ws-a", cwd: "D:\\a", turn: 3, step: 2, seq: 31, at: 800, sessionAt: 1000, turns: 130 },
      { sessionId: "s1", title: "alpha", workspace: "ws-a", cwd: "D:\\a", turn: 3, step: 1, seq: 30, at: 700, sessionAt: 1000, turns: 130 },
      { sessionId: "s3", title: "gamma", workspace: "ws-b", cwd: "D:\\b", turn: 1, step: 1, seq: 10, at: 950, sessionAt: 950, turns: 4 },
    ];
    const grouped = mod.__search.groupHits(hits);
    assert.strictEqual(grouped.length, 2, "two workspaces");
    assert.deepStrictEqual(grouped.map((group) => group.key), ["ws-a", "ws-b"], "the workspace with the newest session first");
    assert.deepStrictEqual(grouped[0].sessions.map((session) => session.sessionId), ["s1", "s2"], "sessions by last update, not by hit time");
    assert.deepStrictEqual(grouped[0].sessions[0].hits.map((hit) => hit.turn + ":" + hit.step), ["3:1", "3:2", "5:1"], "hits read in turn order");
    assert.strictEqual(grouped[0].hits, 4, "the workspace counts its hits");
  }

  /* ---------- feature switches ---------------------------------------- */
  {
    const toggled = [];
    const featureActions = {
      setFeature: (name) => {
        toggled.push(name);
        prefs.features = Object.assign({}, prefs.features, { [name]: !(((prefs.features || {})[name]) !== false) });
      },
      resetFeatures: () => { prefs.features = {}; },
    };
    const page = mount(FeaturesPage, {
      useStore: (select) => select(prefs),
      actions: featureActions,
      subject: { kind: "bundle", pkg: { name: "dsh-ws-recency" } },
    });
    assert.ok(page !== null, "the features page renders");
    /* The page lists one row per feature: the elements carry the id. */
    const rowElements = [];
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const props = node.props || {};
      const known = ["sidebar", "followUp", "search", "trash", "stats", "handoff", "move"];
      if (typeof props.id === "string" && known.indexOf(props.id) !== -1) rowElements.push(node);
      for (const child of node.children || []) walk(child);
    })(page);
    assert.strictEqual(rowElements.length, 7, "every feature has a row");

    /* Opening one row renders a control that toggles exactly that feature. */
    const searchElement = rowElements.find((node) => node.props.id === "search");
    assert.ok(searchElement !== undefined, "the search row exists");
    const searchRow = searchElement.type(searchElement.props);
    assert.strictEqual(searchRow.props["data-wsr-feature"], "search", "the row names its feature");
    const controls = searchRow.children[1];
    const toggle = controls.children[0];
    assert.ok(toggle !== undefined && toggle !== null, "the row carries a control");
    if (typeof toggle.props.onChange === "function") toggle.props.onChange(true);
    else toggle.props.onClick();
    assert.deepStrictEqual(toggled, ["search"], "the switch names its feature");

    /* With the switch off, the gated component renders nothing. */
    /* Another package's page must not show these switches. */
    assert.strictEqual(
      mount(FeaturesPage, {
        useStore: (select) => select(prefs),
        actions: featureActions,
        subject: { kind: "bundle", pkg: { name: "dsh-context" } },
      }),
      null,
      "a different package's page gets no section",
    );

    /* A sidebar row is fixed at startup, so its switch waits for a restart. */
    const bootCount = ctx.slots.registrations.length;
    prefs.features = { search: false };
    render();
    assert.strictEqual(ctx.slots.registrations.length, bootCount, "the row stays until a restart");
    assert.ok(prefs.features.search === false, "the choice stays in the store");
    const afterTogglePage = mount(FeaturesPage, {
      useStore: (select) => select(prefs),
      actions: featureActions,
      subject: { kind: "bundle", pkg: { name: "dsh-ws-recency" } },
    });
    const rowElementsAfter = [];
    (function walk2(node) {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk2(item);
        return;
      }
      if (typeof (node.props || {}).id === "string" && node.props.id === "search") rowElementsAfter.push(node);
      for (const child of node.children || []) walk2(child);
    })(afterTogglePage);
    const searchRowAfter = rowElementsAfter[0].type(rowElementsAfter[0].props);
    assert.ok(textOf(searchRowAfter).indexOf("after a restart") !== -1, "the page says the change needs a restart");
    prefs.features = {};
  }
console.log("selfcheck ok: order A>C>B, fold >3d, controls, colors, pinned section, stats panel, search jump");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

