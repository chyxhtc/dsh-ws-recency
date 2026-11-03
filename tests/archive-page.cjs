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
const confirms = [];

global.navigator = { language: "en-US" };
global.document = {
  documentElement: { lang: "en-US" },
  body: { appendChild() {}, querySelector: () => null, querySelectorAll: () => [] },
  head: { appendChild() {} },
  createElement: (tag) => ({ tagName: tag.toUpperCase(), className: "", style: {}, dataset: {}, children: [], appendChild() {}, addEventListener() {}, removeAttribute() {} }),
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
  confirm(question) { confirms.push(question); return true; },
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
  return buttons(row).find((node) => textOf(node) === label) || null;
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
    const button = buttonInRow(tree, ARCHIVED[0].title, label);
    assert.ok(button !== null, `no "${label}" button in the archived row`);
    button.props.onClick();
    await view.settle();
    const sent = fetchCalls.slice(before).map((call) => call.body);
    const hit = sent.find((body) => body.action === action);
    assert.ok(hit !== undefined, `"${label}" did not post ${action}`);
    assert.strictEqual(typeof hit.sessionId, "string");
    assert.strictEqual(hit.sessionId, ARCHIVED[0].sessionId, `"${label}" addressed the wrong session`);
    assert.ok(confirms.length > 0, `"${label}" asks for confirmation`);
  };

  /* The trash row keeps its own, differently-scoped buttons. */
  assert.ok(buttonInRow(tree, "session-trashed", "Restore") !== null, "the trashed session still has Restore");

  await expectAction("Unarchive", "unarchive");
  await expectAction("Move to trash", "delete");
  await expectAction("Delete for good", "forget");

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

  console.log("archive page ok: two sections, titles, unarchive/delete/forget, legacy host");
})();
