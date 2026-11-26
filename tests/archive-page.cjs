#!/usr/bin/env node
/**
 * Client-side check for the trash page: it must render the trash and the Host's
 * archive set as two sections, and the archived rows must call the route with the
 * right action (`unarchive` / `delete` / `forget`) for the right session.
 *
 * client.js is loaded through the same stub-module protocol as selfcheck.cjs, and
 * `react` is a tiny state machine that re-renders when a setter runs.
 */
const path = require("node:path");
const assert = require("node:assert");

/* ---------- module loader / window stubs -------------------------------- */

let spec = null;
const fetchCalls = [];
let fetchAnswer = () => ({ ok: false, error: "not configured" });
let lastDialog = null;

global.navigator = { language: "en-US" };
global.document = {
  documentElement: { lang: "en-US" },
  body: {
    appendChild(node) { lastDialog = node; return node; },
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  head: { appendChild() {} },
  createElement: (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      className: "",
      style: {},
      dataset: {},
      attrs: {},
      children: [],
      textContent: "",
      appendChild(child) { node.children.push(child); return child; },
      addEventListener(type, fn) { (node.handlers = node.handlers || {})[type] = (node.handlers[type] || []).concat(fn); },
      setAttribute(name, value) { node.attrs[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null; },
      removeAttribute(name) { delete node.attrs[name]; },
      remove() {},
      focus() {},
      click() { const handlers = node.handlers && node.handlers.click ? node.handlers.click : []; handlers.forEach((fn) => fn({ stopPropagation() {} })); },
    };
    return node;
  },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.fetch = (url, options) => {
  const body = JSON.parse(options.body);
  fetchCalls.push({ url, body });
  const answer = fetchAnswer(body);
  return Promise.resolve({
    status: answer.ok === true ? 200 : 500,
    text: () => Promise.resolve(JSON.stringify(answer)),
    json: () => Promise.resolve(answer),
  });
};
global.window = {
  setTimeout() { return 1; },
  clearTimeout() {},
  setInterval() { return 1; },
  clearInterval() {},
  location: { reload() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  __ModuleLoader__: { load(input) { spec = input; } },
};
global.window.window = global.window;
global.setImmediate = global.setImmediate || ((fn) => setTimeout(fn, 0));

require(path.join(__dirname, "..", "client.js"));
assert.ok(spec !== null, "client.js did not register through __ModuleLoader__");

/* ---------- a react stand-in that actually re-renders ------------------- */

const react = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
  useState(initial) {
    return [initial, function () {}];
  },
  useEffect(fn) {
    fn();
  },
};

function mount(component, props) {
  const slots = [];
  const effects = [];
  let index = 0;
  let dirty = false;
  let element = null;

  react.useState = (initial) => {
    const slot = index;
    index += 1;
    if (slot >= slots.length) slots.push(initial);
    return [slots[slot], (value) => { slots[slot] = value; dirty = true; }];
  };
  react.useEffect = (fn) => { effects.push(fn); };
  react.useMemo = (fn) => fn();

  const pass = () => {
    index = 0;
    element = component(props);
    /* The registered component is the feature gate; render what it decided. */
    if (component.__featureGate !== undefined && element !== null && element !== undefined
      && typeof element === "object" && typeof element.type === "function") {
      element = element.type(element.props);
    }
  };
  pass();
  for (const effect of effects.splice(0)) effect();

  return {
    get element() { return element; },
    /* Let the promise chain behind load() settle, re-rendering on each setState. */
    async settle() {
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => global.setImmediate(resolve));
        if (dirty) {
          dirty = false;
          pass();
          i = 0;
        }
      }
      return element;
    },
  };
}

/** Every rendered node, flattened. */
function collect(node, out) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children || []) collect(child, out);
  return out;
}

/** The text of a rendered node: labels are passed as string children. */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return "";
  return (node.children || []).map(textOf).join("");
}

function buttons(root) {
  return collect(root, []).filter((node) => node.type === "button");
}

/** Buttons inside the one card whose text contains `rowText` (labels repeat across cards). */
function buttonInRow(root, rowText, label) {
  const rows = collect(root, []).filter((node) => node.type === "div" && node.props.className === "wsr-card");
  const row = rows.find((node) => textOf(node).indexOf(rowText) !== -1);
  if (row === undefined || row === null) return null;
  /* Icon buttons carry their label as an accessible name, not as text. */
  return buttons(row).find((node) => textOf(node) === label || node.props["aria-label"] === label) || null;
}

/** Depth-first search in a real-DOM stub tree (the in-app dialog lives there). */
function findDom(node, predicate) {
  if (node === null || node === undefined) return null;
  if (typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findDom(child, predicate);
    if (found !== null) return found;
  }
  return null;
}

/* ---------- boot ------------------------------------------------------- */

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

let TrashPage = null;
const ctx = {
  effect(fn) { fn(); },
  get: () => undefined,
  locale: { register() { return () => {}; } },
  slots: {
    inject(_name, factory) { return factory(); },
    register(spec2, component) {
      if (spec2.name === "main") TrashPage = component;
      return () => {};
    },
  },
};
mod.apply(ctx);
assert.ok(TrashPage !== null, "the trash page was not registered on the main slot");

/* ---------- fixtures --------------------------------------------------- */

const TRASHED = {
  name: "session-trashed-2026-11-02T06-42-47-578Z",
  sessionId: "session-trashed",
  cwd: "D:\\proj",
  reason: "delete",
  at: 1760000000000,
  sizeBytes: 1024,
  restorable: true,
};
const ARCHIVED = [
  {
    sessionId: "session-archived-a",
    title: "Fix the build",
    cwd: "D:\\proj",
    createdAt: 1759000000000,
    lastAt: 1760000001000,
    sizeBytes: 2048,
    blank: false,
    workspaceId: "w-proj",
    workspacePath: "D:\\proj",
    listed: true,
  },
  {
    sessionId: "session-archived-b",
    title: "",
    cwd: "D:\\unregistered",
    createdAt: 1758000000000,
    lastAt: 0,
    sizeBytes: 512,
    blank: true,
    workspaceId: null,
    workspacePath: null,
    listed: false,
    missing: true,
  },
];

fetchAnswer = (body) => {
  if (body.action === "list") return { ok: true, entries: [TRASHED] };
  if (body.action === "archived") return { ok: true, entries: ARCHIVED };
  return { ok: true, sessionId: body.sessionId, purged: true, listed: true };
};

(async () => {
  const view = mount(TrashPage, {});
  const tree = await view.settle();

  /* ---------- both sections render ------------------------------------- */
  const text = textOf(tree);
  assert.ok(text.indexOf("Deleted sessions") !== -1, "the trash section has a heading");
  assert.ok(text.indexOf("Archived sessions") !== -1, "the archive section has a heading");
  assert.ok(text.indexOf("Fix the build") !== -1, "an archived row shows its title");
  assert.ok(text.indexOf("session-archived-b") !== -1, "a row without a title falls back to the id");
  assert.ok(text.indexOf("blank draft") !== -1, "a blank draft says so");
  assert.ok(text.indexOf("session-trashed") !== -1, "the trashed session is still listed");
  assert.deepStrictEqual(
    fetchCalls.map((call) => call.body.action).slice(0, 2),
    ["list", "archived"],
    "one load reads both lists",
  );

  /* ---------- the actions carry the right session ---------------------- */
  const expectAction = async (label, action) => {
    const before = fetchCalls.length;
    lastDialog = null;
    const button = buttonInRow(tree, ARCHIVED[0].title, label);
    assert.ok(button !== null, `no "${label}" button in the archived row`);
    button.props.onClick();
    /* No request before the user accepts: the confirmation is in the page now
       (a native confirm used to strip keyboard focus when it closed). */
    assert.strictEqual(fetchCalls.length, before, `"${label}" acts before the user confirms`);
    assert.ok(lastDialog !== null, `"${label}" opens an in-page dialog`);
    assert.strictEqual(lastDialog.getAttribute("data-wsr-confirm"), "confirm");
    const accept = findDom(lastDialog, (node) => node.attrs !== undefined && node.attrs["data-wsr-confirm-ok"] === "true");
    assert.ok(accept !== null, `"${label}" has an accept button`);
    accept.click();
    await view.settle();
    const sent = fetchCalls.slice(before).map((call) => call.body);
    const hit = sent.find((body) => body.action === action);
    assert.ok(hit !== undefined, `"${label}" did not post ${action}`);
    assert.strictEqual(typeof hit.sessionId, "string");
    assert.strictEqual(hit.sessionId, ARCHIVED[0].sessionId, `"${label}" addressed the wrong session`);
  };

  /* The trash row keeps its own, differently-scoped buttons. */
  assert.ok(buttonInRow(tree, "session-trashed", "Restore") !== null, "the trashed session still has Restore");

  /* Every action is one right-aligned row at the bottom: a single right edge, so
     nothing can drift, and the title keeps the full width. */
  const trashRow = collect(tree, []).find((node) => node.type === "div" && node.props.className === "wsr-card" && textOf(node).indexOf("session-trashed") !== -1);
  const actionRow = trashRow.children.find((child) => child.props !== undefined && String(child.props.className).indexOf("wsr-card-actions-row") !== -1);
  assert.ok(actionRow !== undefined, "the actions own a row at the bottom of the card");
  assert.strictEqual(trashRow.children[trashRow.children.length - 1], actionRow, "that row is the card's last line");
  assert.ok(buttons(actionRow).length >= 2, "the row holds every action");
  const head = trashRow.children.find((child) => child.props !== undefined && child.props.className === "wsr-card-head");
  assert.strictEqual(buttons(head).length, 0, "the title line is free of buttons");
  const iconButtons = buttons(trashRow).map((node) => String(node.props.className));
  assert.ok(iconButtons.length >= 2, "the card still offers its actions");
  /* The test's UI package exposes no glyphs, so the fallback path is what runs
     here; both paths have to stay keyboard-labelled and compact. */
  assert.ok(iconButtons.every((name) => name.indexOf("wsr-icon") !== -1), "actions render through the icon path, fallback included");
  assert.ok(buttons(trashRow).every((node) => typeof node.props.title === "string" && node.props.title !== ""), "each icon button names itself on hover");

  await expectAction("Unarchive", "unarchive");
  await expectAction("Move to trash", "delete");
  await expectAction("Delete for good", "forget");

  /* ---------- a record whose log is gone gets one honest action ---------- */
  /* Every other action would answer "session not found", which is exactly what
     the reported ghost row did. */
  assert.ok(buttonInRow(tree, "session-archived-b", "Unarchive") === null, "a record-only row offers no unarchive");
  assert.ok(buttonInRow(tree, "session-archived-b", "Delete for good") === null, "and no destructive action");
  const detachBefore = fetchCalls.length;
  lastDialog = null;
  const detachButton = buttonInRow(tree, "session-archived-b", "Remove from archive");
  assert.ok(detachButton !== null, "it offers to remove the record");
  /* The label says files are untouched, and the dialog repeats it. */
  detachButton.props.onClick();
  assert.strictEqual(fetchCalls.length, detachBefore, "nothing is sent before the confirmation");
  const detachAccept = findDom(lastDialog, (node) => node.attrs !== undefined && node.attrs["data-wsr-confirm-ok"] === "true");
  assert.ok(detachAccept !== null, "the record removal confirms in the page");
  detachAccept.click();
  await view.settle();
  const detachHit = fetchCalls.slice(detachBefore).map((call) => call.body).find((body) => body.action === "detach");
  assert.ok(detachHit !== undefined, "it posts the detach action");
  assert.strictEqual(detachHit.sessionId, "session-archived-b");
  assert.ok(textOf(tree).indexOf("record only") === -1, "the state badge is gone: the section heading already says it, so the card carries no glyph");
  assert.strictEqual(collect(tree, []).filter((node) => node.type === "span" && typeof node.props.className === "string" && node.props.className.indexOf("wsr-card-glyph") !== -1).length, 0, "no state glyph on any card");

  /* ---------- an older host half degrades gracefully ------------------- */
  fetchAnswer = (body) => {
    if (body.action === "list") return { ok: true, entries: [] };
    if (body.action === "archived") return { ok: false, error: "unknown action" };
    return { ok: true };
  };
  const legacy = mount(TrashPage, {});
  const legacyText = textOf(await legacy.settle());
  assert.ok(legacyText.indexOf("Archived sessions") === -1, "no archive section when the host half cannot list it");
  assert.ok(legacyText.indexOf("The trash is empty.") !== -1, "the trash still renders");

  console.log("archive page ok: two sections, titles, unarchive/delete/forget, record-only detach, legacy host");
})();
