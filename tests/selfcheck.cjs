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
const service = {
  opened: [],
  unpinned: [],
  openSession(id) { this.opened.push(id); },
  unpinSession(id) { this.unpinned.push(id); },
  pinSession() {},
};
const ctx = {
  effect(fn) { fn(); },
  get(name) { return name === "uiWorkspace" ? service : undefined; },
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
assert.strictEqual(toggleOf(A).textContent, "Show history (3)");
assert.strictEqual(A.button.textContent, "\u5c55\u5f00\u5176\u4f59 5 \u6761\u4f1a\u8bdd", "the host's own button is left untouched");
assert.ok(toggleOf(B) !== null, "a fully rendered group offers the history control");
assert.strictEqual(toggleOf(B).textContent, "Show history (2)");
assert.strictEqual(toggleOf(C), null, "a group with nothing folded gets no control");

toggleOf(A).click();
flush();
assert.strictEqual(hiddenCount(A), 0, "the history control reveals the folded rows");
assert.strictEqual(toggleOf(A).textContent, "Hide history");

toggleOf(A).click();
flush();
assert.strictEqual(hiddenCount(A), 3, "the same control folds them back");
assert.strictEqual(toggleOf(A).textContent, "Show history (3)");

toggleOf(B).click();
flush();
assert.strictEqual(hiddenCount(B), 0, "the group toggle reveals the folded rows");

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

pinRow.querySelector(".wsr-pin-unpin").click();
assert.deepStrictEqual(service.unpinned, ["A-fresh-1"], "unpin goes through the host service");

workspaces.pinnedSessionIds = [];
render();
assert.strictEqual(root.children.some((child) => child.className === "wsr-pin"), false, "the section disappears when nothing is pinned");
assert.strictEqual(A.rows[0].getAttribute("data-wsr-pin-hidden"), null, "the original row comes back");

console.log("selfcheck ok: order A>C>B, fold >3d, one control per group, colors + persistent follow-up, pinned section");
