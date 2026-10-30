#!/usr/bin/env node
/**
 * Self-check for dsh-ws-recency's client half: load client.js through a stubbed
 * dynamic-module protocol and a stub DOM, then assert
 *   - group order follows each workspace's freshest `updatedAt`,
 *   - sessions older than foldDays are folded, and
 *   - the group's own control reveals them again.
 */
const path = require("node:path");
const assert = require("node:assert");

const DAY = 24 * 60 * 60 * 1000;

/* ---------- minimal DOM ------------------------------------------------ */

function matchOne(elm, part) {
  if (part.startsWith(".")) return String(elm.className).split(/\s+/).indexOf(part.slice(1)) !== -1;
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
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    click() { (this.handlers.click || []).forEach((fn) => fn({})); },
    append(child) { child.parentElement = this; this.children.push(child); return child; },
    appendChild(child) { return this.append(child); },
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

global.document = {
  body: {},
  head: { appendChild() {} },
  querySelector: () => null,
  createElement: (tag) => el(tag),
  querySelectorAll(selector) {
    if (selector.indexOf("workspace:") !== -1) return headers;
    return [];
  },
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.window = {
  setTimeout(fn) { pendingTimers.push(fn); return pendingTimers.length; },
  clearTimeout() {},
  setInterval() { return 1; },
  clearInterval() {},
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

const makeSection = (id, sessions, overflowText) => {
  const section = el("div", "SJMXQW_groupSection");
  section.parentElement = root;
  root.children.push(section);
  const header = el("div", "ozLDBG_projectRow");
  header.attrs["data-row-key"] = `workspace:${id}`;
  section.append(header);
  headers.push(header);
  sections.push(section);
  const rows = sessions.map((session, index) => {
    const row = el("div", "ozLDBG_sessionRow");
    row.attrs["data-row-key"] = `session:${session.id}`;
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

const A = makeSection("A", [
  { id: "A-fresh-1", updatedAt: NOW - 1 * DAY },
  { id: "A-old-1", updatedAt: NOW - 4 * DAY },
  { id: "A-fresh-2", updatedAt: NOW - 2 * DAY },
  { id: "A-old-2", updatedAt: NOW - 6 * DAY },
  { id: "A-old-3", updatedAt: NOW - 9 * DAY },
], "展开其余 5 条会话");
const B = makeSection("B", [
  { id: "B-old-1", updatedAt: NOW - 5 * DAY },
  { id: "B-old-2", updatedAt: NOW - 7 * DAY },
], null);
const C = makeSection("C", [
  { id: "C-fresh-1", updatedAt: NOW - 2 * DAY },
  { id: "C-fresh-2", updatedAt: NOW - 1 * DAY },
], null);

/* The provisional "New session" row: always rendered, never folded. */
const blankRow = el("div", "ozLDBG_sessionRow");
blankRow.attrs["data-row-key"] = "session:B-blank";
B.section.append(blankRow);

/* ---------- boot ------------------------------------------------------- */

const react = {
  useEffect(fn) { fn(); },
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
};
const mod = spec.factory((name) => {
  if (name === "react") return react;
  if (name === "@deepseek-ai/dsh-client-store") return { defineStore: () => ({}) };
  return {};
});

assert.strictEqual(mod.name, "dsh-ws-recency");

let Sorter = null;
let SettingsRow = null;
let FollowUpDot = null;
const ctx = {
  effect(fn) { fn(); },
  locale: { register() { return () => {}; } },
  slots: {
    inject(_name, factory) { return factory(); },
    register(spec2, component) {
      if (spec2.name === "shell.overlay") Sorter = component;
      if (spec2.name === "settings.general.item") SettingsRow = component;
      if (spec2.name === "sidebar.session.row.leading") FollowUpDot = component;
      return () => {};
    },
  },
};
mod.apply(ctx);
assert.ok(Sorter !== null, "overlay component was not registered");
assert.ok(SettingsRow !== null, "settings row was not registered");

const sessions = {
  phase: "ready",
  byId: {},
};
for (const group of [A, B, C]) {
  for (const row of group.rows) {
    const id = row.getAttribute("data-row-key").slice("session:".length);
    const found = [
      { id: "A-fresh-1", updatedAt: NOW - 1 * DAY },
      { id: "A-old-1", updatedAt: NOW - 4 * DAY },
      { id: "A-fresh-2", updatedAt: NOW - 2 * DAY },
      { id: "A-old-2", updatedAt: NOW - 6 * DAY },
      { id: "A-old-3", updatedAt: NOW - 9 * DAY },
      { id: "B-old-1", updatedAt: NOW - 5 * DAY },
      { id: "B-old-2", updatedAt: NOW - 7 * DAY },
      { id: "C-fresh-1", updatedAt: NOW - 2 * DAY },
      { id: "C-fresh-2", updatedAt: NOW - 1 * DAY },
    ].find((candidate) => candidate.id === id);
    sessions.byId[id] = { ...found, origin: "main" };
  }
}
sessions.byId["B-blank"] = { id: "B-blank", blank: true, updatedAt: NOW - 30 * DAY, origin: "main" };
const workspaces = {
  phase: "ready",
  items: [
    { workspaceId: "A", sessionIds: ["A-fresh-1", "A-old-1", "A-fresh-2", "A-old-2", "A-old-3"] },
    { workspaceId: "B", sessionIds: ["B-old-1", "B-old-2"] },
    { workspaceId: "C", sessionIds: ["C-fresh-1", "C-fresh-2"] },
  ],
  archivedSessionIds: [],
};
const prefs = { enabled: true, foldDays: 3, keepActive: true, colors: true, followUps: {} };
const statuses = {};
const actions = {
  clearFollowUp: (id) => { delete prefs.followUps[id]; },
  toggleFollowUp: (id) => {
    if (prefs.followUps[id] === undefined) prefs.followUps[id] = Date.now();
    else delete prefs.followUps[id];
  },
};

const storage = new Map();
global.window.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
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

/* ---------- assertions ------------------------------------------------- */

const hiddenCount = (group) => group.rows.filter((row) => row.getAttribute("data-wsr-hidden") === "true").length;
const toggleOf = (group) => group.section.querySelector('[data-wsr-fold="true"]');

assert.strictEqual(A.section.style.order, "0", "freshest workspace must lead");
assert.strictEqual(C.section.style.order, "1");
assert.strictEqual(B.section.style.order, "2");

assert.strictEqual(hiddenCount(A), 3, "three sessions older than 3 days are folded");
assert.strictEqual(hiddenCount(B), 2, "a fully stale workspace folds every row");
assert.strictEqual(hiddenCount(C), 0, "fresh sessions stay visible");
assert.strictEqual(blankRow.getAttribute("data-wsr-hidden"), null, "the New session row is never folded");

/* A group the host already paginates gets ONE control: the host's own button. */
assert.strictEqual(toggleOf(A), null, "no second control beside the host's show-more button");
assert.strictEqual(A.button.textContent, "展开其余 8 条会话", "host count includes the folded rows");

/* A group the host rendered completely gets this plugin's toggle. */
assert.ok(toggleOf(B) !== null, "a fully rendered group offers the history control");
assert.strictEqual(toggleOf(B).textContent, "Show history (2)");
assert.strictEqual(toggleOf(C), null, "a group with nothing folded gets no control");

/* The host's button reveals the fold, and collapses it again. */
A.button.click();
flush();
assert.strictEqual(hiddenCount(A), 0, "the host button reveals the folded rows");
assert.strictEqual(A.button.textContent, "展开其余 5 条会话", "expanded group hides nothing, so the count is the host's own");

A.button.attrs["aria-expanded"] = "true";
A.button.click();
flush();
assert.strictEqual(hiddenCount(A), 3, "clicking the host button again folds the history back");
assert.strictEqual(A.button.textContent, "展开其余 8 条会话");

/* The plugin's own toggle still works where the host has no button. */
toggleOf(B).click();
flush();
assert.strictEqual(hiddenCount(B), 0, "the group toggle reveals the folded rows");
assert.strictEqual(toggleOf(B).textContent, "Hide history");

/* ---------- colors: running / unread / manual follow-up ---------------- */

const D = makeSection("D", [
  { id: "D-run", updatedAt: NOW - 1 * DAY },
  { id: "D-done", updatedAt: NOW - 1 * DAY },
], null);
sessions.byId["D-run"] = { id: "D-run", updatedAt: NOW - 1 * DAY, origin: "main" };
sessions.byId["D-done"] = { id: "D-done", updatedAt: NOW - 1 * DAY, origin: "main" };
workspaces.items.push({ workspaceId: "D", sessionIds: ["D-run", "D-done"] });
statuses["D-run"] = { running: true };
statuses["D-done"] = { completionUnread: true };
render();

assert.strictEqual(D.rows[0].getAttribute("data-wsr-state"), "running", "a running session turns blue");
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), "unread", "a finished-unopened session turns green");

/* The follow-up mark is the user's own decision, never inferred. */
statuses["D-done"] = {};
prefs.followUps = { "D-done": NOW };
render();
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), "followup", "a manually flagged session turns amber");
/* The dot lives in the host's leading slot, never inside the row itself. */
const flaggedDot = FollowUpDot({
  sessionId: "D-done",
  useStore: (select) => select(prefs),
  actions,
});
assert.ok(flaggedDot !== null, "a flagged session renders the leading dot");
assert.strictEqual(flaggedDot.props.className, "wsr-dot");
assert.strictEqual(D.rows[1].querySelector(".wsr-dot"), null, "nothing was injected into the row");
assert.strictEqual(FollowUpDot({ sessionId: "D-run", useStore: (sel) => sel(prefs), actions }), null, "unflagged rows render nothing");

/* Clicking the dot drops the mark through the store action. */
flaggedDot.props.onClick({ stopPropagation() {} });
render();
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), null, "the dot clears the mark");
assert.strictEqual(prefs.followUps["D-done"], undefined, "the store action removed the flag");
assert.ok(D.rows[1].querySelector(".wsr-dot") === null, "the dot goes away with the mark");

/* Newer activity after the mark means the follow-up happened: cleared automatically. */
prefs.followUps = { "D-done": NOW };
sessions.byId["D-done"].updatedAt = NOW + 1000;
render();
assert.strictEqual(D.rows[1].getAttribute("data-wsr-state"), null, "newer activity clears the follow-up");
assert.strictEqual(prefs.followUps["D-done"], undefined, "the stale flag is dropped from the store");

console.log("selfcheck ok: order A>C>B, fold >3d, one control per group, colors + manual follow-up");
