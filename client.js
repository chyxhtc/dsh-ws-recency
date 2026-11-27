/**
           "trash.confirmRestoreGroup": "恢复到原来的工作区？这一组里的 {n} 个子会话会一起回来。",
* dsh-ws-recency - client half.
 *
 * Three sidebar behaviors, nothing else:
 *
 *   1. GROUP ORDER - DSH already sorts the sessions INSIDE a workspace group by
 *      `updatedAt` (orderBy: "updated"), but the groups themselves follow the
 *      workspace registry order (creation order). This plugin ranks every group
 *      by the freshest `updatedAt` among its own sessions and writes a flex
 *      `order` onto it. Native pins, archive state and the store are untouched.
 *      OPTIONAL interop: when dsh-plugin-busy-workspace happens to be installed
 *      it writes `data-busy-rank` (its urgency band) on the same elements; that
 *      band is then kept as the primary key and recency only decides the order
 *      inside one band. This plugin never depends on it.
 *
 *   2. HISTORY FOLD - a session that has not been updated for `foldDays` (default
 *      3) is folded away, and a workspace whose own freshest session is older than
 *      that shows as a bare header. A small "show history (n)" control on the
 *      group reveals the folded rows, and the host's own "show more" button keeps
 *      working for rows it did not render. The selected, running and waiting rows
 *      are never folded.
 *
 *   3. COLORS - running = blue, finished-unopened = green, and a MANUAL
 *      "needs follow-up" flag = amber. DSH only exposes `completionUnread`, which
 *      clears the moment a session is opened, so "I looked but never decided" is
 *      not readable anywhere: this plugin does not guess it. You mark it yourself
 *      from the session's "..." menu (or click the amber dot to drop it), exactly
 *      the way you would remember a conversation you still owe an answer to.
 *
 * Settings (Settings -> General) persist in the shared Client store.
 */
(() => {
  try {
    window.__ModuleLoader__.load({
      id: "dsh-ws-recency",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");
        var clientStore = (function () {
          try { return require("@deepseek-ai/dsh-client-store"); } catch (error) { return {}; }
        })();
        var ui = (function () {
          try { return require("@deepseek-ai/dsh-client-ui-primitives"); } catch (error) { return {}; }
        })();

        var NS = "ws-recency";
        var h = react.createElement;

        /**
         * Master switch for the search feature: its panel icon and the page behind
         * it. Off leaves the plugin present but registers no search side at all.
         */
        var SEARCH_ENABLED = true;

        var HEADER_PREFIX = "workspace:";
        var SESSION_PREFIX = "session:";
        var SECTION_TOKEN = "_groupSection";
        var OVERFLOW_TOKEN = "sessionOverflowButton";
        var ROOT_ATTR = "data-wsr-root";
        var RANK_ATTR = "data-wsr-order";
        var HIDDEN_ATTR = "data-wsr-hidden";
        var FOLD_ATTR = "data-wsr-fold";
        var STATE_ATTR = "data-wsr-state";
        var DOT_TOKEN = "wsr-dot";
        var PIN_ATTR = "data-wsr-pin";
        var PIN_HIDDEN_ATTR = "data-wsr-pin-hidden";
        var BUSY_RANK_ATTR = "data-busy-rank";
        var CSS_ID = "dsh-ws-recency/css";
        var MENU_ORDER = 460;

        var DAY = 24 * 60 * 60 * 1000;
        var MIN_DAYS = 1;
        var MAX_DAYS = 90;
        var DEFAULT_DAYS = 3;

        /**
         * Which parts of this plugin are on.
         *
         * The plugin grew several unrelated abilities; someone who already has
         * another plugin for search, or for statistics, should be able to turn that
         * part off here instead of living with two answers for one question.
         */
        var FEATURE_IDS = ["sidebar", "followUp", "search", "trash", "stats", "handoff", "move"];
        var FEATURE_DEFAULTS = {
          sidebar: true,
          followUp: true,
          search: true,
          trash: true,
          stats: true,
          handoff: true,
          move: true,
        };

        /**
         * Wrap a component in one feature switch.
         *
         * The wrapper calls exactly one hook on every render, then decides: a guard
         * inside the component itself would change its hook count the moment the
         * switch flips, and React rejects that. Switching off unmounts the component,
         * so its background work stops with it.
         */
        function withFeature(Component, feature) {
          var FeatureGated = function (props) {
            var settingsNow = typeof props.useStore === "function" ? props.useStore(function (state) { return state; }) : data.settings;
            if (!featureOn(settingsNow, feature)) return null;
            return h(Component, props);
          };
          FeatureGated.__featureGate = feature;
          return FeatureGated;
        }

        /** One feature's switch, with `on` as the default for a missing value. */
        function featureOn(state, name) {
          var bag = state !== null && state !== undefined ? state.features : undefined;
          if (bag !== null && bag !== undefined && typeof bag === "object" && typeof bag[name] === "boolean") return bag[name];
          return FEATURE_DEFAULTS[name] !== false;
        }

        /** A session this long makes every jump into old turns expensive. */
        var LONG_SESSION_TURNS = 60;

        /** Turns behind the newest that make a jump ask first; 0 disables asking. */
        var DEFAULT_COLD_JUMP = 40;
        var MAX_COLD_JUMP = 500;
        /** Safety stop for driving the host's own "show more" (5 rows per click). */
        var MAX_EXPAND_CLICKS = 40;
        var TICK_MS = 5 * 60 * 1000;
        /** A row press, for when the host's handler listens on one of these. */
        var PRESS_EVENTS = ["pointerdown", "mousedown", "mouseup"];

        var data = { sessions: null, workspaces: null, settings: null, statuses: null, actions: null, service: null, ctx: null, t: null };
        var timer = null;
        var ticker = null;
        var observer = null;
        var written = new Set();
        var roots = new Set();
        var hidden = new Set();
        var toggles = new Set();
        var dots = new Set();
        var pinHidden = new Set();
        var pinHost = null;
        var prefsStore = null;
        var expandClicks = new Map();
        var composerPill = null;
        var expandedSections = new Set();
        var headerMarked = new WeakSet();
        var disposed = false;

        var CSS = [
          "[" + ROOT_ATTR + '="true"]{display:flex;flex-direction:column}',
          "[" + ROOT_ATTR + '="true"]>*{flex:0 0 auto}',
          "[" + HIDDEN_ATTR + '="true"]{display:none !important}',
          "[" + PIN_HIDDEN_ATTR + '="true"]{display:none !important}',
          '[class*="' + OVERFLOW_TOKEN + '"]{display:none !important}',
          ".wsr-pin{display:flex;flex-direction:column;flex:0 0 auto;padding:2px 0 6px;margin-bottom:4px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
          ".wsr-pin-head{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:4px 12px 2px}",
          ".wsr-pin-row{display:flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:6px;cursor:pointer}",
          ".wsr-pin-row:hover{background:var(--dsw-alias-bg-layer-2)}",
          ".wsr-pin-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}",
          ".wsr-pin-ws{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-pin-unpin{flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;padding:2px 4px;border-radius:4px;visibility:hidden}",
          ".wsr-pin-row:hover .wsr-pin-unpin{visibility:visible}",
          ".wsr-pin-slot{flex:none;width:14px;height:14px;display:flex;align-items:center;justify-content:center}",
          ".wsr-pin-dot{display:block;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a8f98)}",
          '.wsr-pin-dot[data-state="done"]{background:var(--dsw-alias-state-success-primary,#3fae6b)}',
          '.wsr-pin-dot[data-state="warning"]{background:var(--dsw-alias-state-warning-primary,#d99a2b)}',
          ".wsr-pin-spin{animation:wsr-pin-spin 1s linear infinite;transform-origin:50% 50%}",
          ".wsr-pin-spin circle{fill:none;stroke-width:2}",
          ".wsr-pin-track{stroke:var(--dsw-alias-border-l3,rgba(255,255,255,.2))}",
          ".wsr-pin-arc{stroke:var(--dsw-alias-state-business-primary,#4f8ef7);stroke-linecap:round;stroke-dasharray:22 60}",
          "@keyframes wsr-pin-spin{to{transform:rotate(360deg)}}",
          ".wsr-pin-row[" + STATE_ATTR + '="running"] .wsr-pin-title{color:#4f8ef7}',
          ".wsr-pin-row[" + STATE_ATTR + '="unread"] .wsr-pin-title{color:#3fae6b}',
          ".wsr-pin-row[" + STATE_ATTR + '="followup"] .wsr-pin-title{color:#d99a2b}',
          ".wsr-pin-unpin:hover{color:var(--dsw-alias-label-primary)}",
          ".wsr-pill{box-sizing:border-box;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;border-radius:var(--dsw-radius-sm,6px);display:inline-flex;align-items:center;gap:6px;padding:1px 8px;cursor:pointer}",
          ".wsr-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#cfd3d8)}",
          ".wsr-modal-backdrop{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}",
          ".wsr-modal{width:min(720px,92vw);max-height:84vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1f2226);color:var(--dsw-alias-label-primary,#e8e8e8);border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden}",
          ".wsr-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}",
          ".wsr-modal-title{font-size:14px;font-weight:600}",
          ".wsr-modal-close{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:4px}",
          ".wsr-modal-close:hover{color:var(--dsw-alias-label-primary,#e8e8e8)}",
          ".wsr-modal-tools{display:flex;align-items:center;gap:8px;flex:none}",
          ".wsr-modal-body{padding:14px;overflow:auto;display:flex;flex-direction:column;gap:12px;font-size:12px}",
          ".wsr-stats-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}",
          ".wsr-stats-card-primary{box-shadow:inset 0 0 0 1px rgba(79,124,255,.45)}",
          ".wsr-stats-card-primary .wsr-stats-value{color:#7aa2ff}",
          ".wsr-stats-card{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));border-radius:8px;padding:8px 10px}",
          ".wsr-stats-value{font-size:15px;font-weight:600}",
          ".wsr-stats-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-stats-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.06)}",
          ".wsr-stats-seg{height:100%}",
          ".wsr-stats-legend{display:flex;flex-wrap:wrap;gap:10px}",
          ".wsr-stats-legend-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-stats-swatch{width:8px;height:8px;border-radius:2px}",
          ".wsr-move-warning{color:var(--dsw-alias-state-warn-primary,#d9a72c);font-size:11px;line-height:1.5}",
          ".wsr-move-list{display:flex;flex-direction:column;gap:4px}",
          ".wsr-move-row{display:flex;align-items:center;gap:8px;text-align:left;border:none;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:inherit;font:inherit;padding:8px 10px;border-radius:8px;cursor:pointer}",
          ".wsr-move-row:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
          ".wsr-move-row[disabled]{opacity:.55;cursor:default}",
          ".wsr-move-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
          ".wsr-move-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".wsr-move-path{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".wsr-move-badge{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-trash-row{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}",
          ".wsr-footer-action{display:flex;box-sizing:border-box;flex:none;align-items:center;justify-content:flex-start;gap:8px;width:calc(100% + 4px);min-width:0;height:42px;margin:4px -2px;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}",
          ".wsr-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover)}",
".wsr-page{display:flex;flex-direction:column;gap:10px;padding:16px 18px;min-width:0;box-sizing:border-box;height:100%;overflow:auto}",
          ".wsr-handoff-option{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer}",
          ".wsr-handoff-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
          ".wsr-handoff-option input{margin-top:2px}",
          ".wsr-handoff-option-text{display:flex;flex-direction:column;gap:2px;min-width:0}",
          ".wsr-handoff-option-title{font-size:13px;color:var(--dsw-alias-label-primary)}",
          ".wsr-handoff-option-desc{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-handoff-extra{width:100%;box-sizing:border-box;min-height:56px;max-height:140px;resize:vertical;font:inherit;font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-primary,#e6e6e6)}",
          ".wsr-handoff-body{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;max-height:220px;overflow:auto;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1b1b1b)}",
          ".wsr-qcard{width:100%;max-width:var(--dsh-chat-content-width,100%);border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2));box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;padding:0 0 10px;margin:8px 0;overflow:hidden}",
          ".wsr-qcard *{box-sizing:border-box}",
          ".wsr-qhead{display:flex;align-items:flex-start;gap:8px;padding:14px 16px 8px}",
          ".wsr-qheading{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
          ".wsr-qeyebrow{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}",
          ".wsr-qtitle{font-size:15px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}",
          ".wsr-qdetail{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-qicon{flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px}",
          ".wsr-qicon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary)}",
          ".wsr-qoptions{display:flex;flex-direction:column;gap:1px;margin:8px 0 0;padding:4px 12px}",
          ".wsr-qoption{display:flex;align-items:flex-start;gap:8px;width:100%;min-height:40px;padding:8px 12px 8px 8px;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;transition:background-color .12s,border-color .12s}",
          ".wsr-qoption:hover,.wsr-qoption-selected{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
          ".wsr-qoption-selected{border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.16))}",
          ".wsr-qnum{flex:none;width:18px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);text-align:center}",
          ".wsr-qtext{display:flex;flex-direction:column;gap:2px;min-width:0}",
          ".wsr-qextra{padding:4px 16px 0}",
          ".wsr-qpreview{margin:8px 16px 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.24));white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;max-height:220px;overflow:auto}",
          ".wsr-qfooter{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:8px 16px 0}",
          ".wsr-qactions{display:flex;align-items:center;gap:8px}",
          ".wsr-qcancel{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer;padding:4px 8px;border-radius:6px}",
          ".wsr-qcancel:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
          ".wsr-qsubmit{border:none;border-radius:8px;background:var(--dsw-alias-brand-primary,#4f7cff);color:#fff;font:inherit;font-size:12px;font-weight:500;cursor:pointer;padding:6px 14px}",
          ".wsr-qsubmit:hover{filter:brightness(1.06)}",
          ".wsr-handoff-live{margin:8px 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-msg-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
          ".wsr-msg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary)}",
          ".wsr-handoff-status{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}",
          ".wsr-handoff-text{width:100%;box-sizing:border-box;min-height:220px;max-height:46vh;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;padding:10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-primary,#e6e6e6)}",
".wsr-page-head{display:flex;align-items:center;gap:8px}",
".wsr-page-heading{flex:1;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
".wsr-page-list{display:flex;flex-direction:column;gap:6px}",
".wsr-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}",
".wsr-card-grid .wsr-card-head{flex-wrap:wrap}",
".wsr-card-grid .wsr-card-actions{flex-wrap:wrap}",
/* Icon actions: 24px instead of a text button, so the title keeps its width. */
".wsr-icon-btn{width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}",
".wsr-icon-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary)}",
/* The destructive action keeps the same frame as the others and only its glyph is
   red: a red border made one icon in a row of three shout louder than its size. */
".wsr-icon-btn-danger{color:var(--dsw-alias-state-error-primary,#d9534f)}",
".wsr-icon-btn-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 14%,transparent);color:var(--dsw-alias-state-error-primary,#d9534f)}",
".wsr-card-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}",
".wsr-card-glyph-danger{color:var(--dsw-alias-state-error-primary,#d9534f)}",
".wsr-card-glyph-muted{color:var(--dsw-alias-label-tertiary)}",
".wsr-card-glyph-warning{color:#d99a2b}",
".wsr-card-danger{flex:none;display:flex;align-items:center}",
/* Every icon button is the same 24px frame; the glyph inside keeps a 14px box
   so differing artwork aspects cannot change the button's size. */
".wsr-icon-btn-glyph{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px}",
".wsr-icon-btn-glyph>svg{display:block}",
/* The actions are one flex row on the title line, so a single layout does the
   alignment: no second right edge to reconcile. They keep out of the way until
   the card is hovered or holds focus. */
/* Every action is one right-aligned row pinned to the card's bottom edge: it is a
   real row in the card's column flow (so it never covers the path) and
   `margin-top:auto` keeps it against the bottom when the card has spare height. */
".wsr-card .wsr-card-actions-row{display:flex;justify-content:flex-end;align-items:center;gap:6px;min-height:24px;margin-top:auto;opacity:0;transition:opacity .12s}",
".wsr-card:hover .wsr-card-actions-row,.wsr-card:focus-within .wsr-card-actions-row{opacity:1}",
".wsr-page-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}",
".wsr-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}",
".wsr-card-head{display:flex;align-items:center;gap:10px;min-width:0}",
".wsr-card-badge{flex:none;font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary)}",
".wsr-card-badge-danger{color:var(--dsw-alias-state-error-primary,#d9534f);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 14%,transparent)}",
".wsr-card-badge-muted{color:var(--dsw-alias-label-tertiary)}",
".wsr-card-badge-warning{color:#d99a2b}",
".wsr-card-title{flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".wsr-card-title-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
".wsr-card-actions{flex:none;display:flex;gap:6px;align-items:center;white-space:nowrap}",
".wsr-chips{display:flex;flex-wrap:wrap;gap:6px}",
".wsr-chip{font-size:11px;line-height:18px;padding:0 7px;border-radius:9px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06));color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
".wsr-card-path{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".wsr-page-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
".wsr-page-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".wsr-page-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
".wsr-page-path{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".wsr-page-actions{display:flex;gap:6px;flex:none;align-items:center;white-space:nowrap}",
".wsr-page-note{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}",
".wsr-page-error{color:var(--dsw-alias-state-error-primary,#d9534f)}",
".wsr-page-section{display:flex;align-items:baseline;gap:8px;margin-top:8px;padding-bottom:2px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
".wsr-page-count{font-weight:400;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
".wsr-page-title-blank{color:var(--dsw-alias-label-tertiary);font-style:italic}",
          ".wsr-footer-action:active{background:var(--dsw-alias-interactive-bg-active)}",
          ".wsr-footer-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}",
          '.wsr-footer-action[data-wide="false"]{width:36px;height:36px;margin:8px 0 10px;padding:0;gap:0;border-radius:50%;justify-content:center}',
          ".wsr-footer-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px}",
          '.wsr-footer-action[data-wide="false"] .wsr-footer-glyph{width:18px;height:18px}',
          ".wsr-footer-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".wsr-trash-actions{display:flex;gap:6px;flex:none;align-items:center;white-space:nowrap}",
          ".wsr-btn{border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:0 0;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;line-height:1.6;padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;flex:none}",
          ".wsr-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
          ".wsr-btn-danger{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f)}",
          ".wsr-danger{border-color:var(--dsw-alias-state-error-primary,#d9534f);color:var(--dsw-alias-state-error-primary,#d9534f)}",
          /* In-app confirmation: native window.confirm leaves the renderer
             without keyboard focus on Windows (the composer then ignores
             clicks until the app loses and regains focus). */
          ".wsr-confirm{width:min(420px,88vw);display:flex;flex-direction:column;gap:14px;padding:16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1f2226);color:var(--dsw-alias-label-primary,#e8e8e8);border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));box-shadow:0 14px 44px rgba(0,0,0,.45);outline:none}",
          ".wsr-confirm-text{white-space:pre-wrap;font-size:13px;line-height:1.65}",
          ".wsr-confirm-actions{display:flex;justify-content:flex-end;gap:8px}",
          ".wsr-chart{display:flex;flex-direction:column;gap:6px}",
          ".wsr-chart-head{display:flex;align-items:center;justify-content:space-between;gap:10px}",
          ".wsr-chart-title{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-chart-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}",
          ".wsr-chart-row{display:grid;grid-template-columns:120px 1fr 64px 56px 48px;align-items:center;gap:8px}",
          ".wsr-chart-family{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-top:-2px}",
          ".wsr-family-legend{padding-bottom:4px}",
          ".wsr-chart-track{height:8px;border-radius:4px;background:rgba(255,255,255,.06);overflow:hidden;display:flex}",
          ".wsr-chart-fill{height:100%;border-radius:0;min-width:0}",
          ".wsr-chart-group{display:flex;height:100%;min-width:2px;border-radius:4px;overflow:hidden}",
          ".wsr-chart-swatch{width:8px;height:8px;border-radius:2px;background:hsl(217, 88%, 50%)}",
          ".wsr-chart-swatch-dim{background:hsl(217, 32%, 84%)}",
          ".wsr-chart-legend{display:flex;flex-wrap:wrap;gap:10px;align-items:center}",
          ".wsr-chart-legend-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-chart-legend-text{white-space:nowrap}",
          ".wsr-chart-value{text-align:right;font-variant-numeric:tabular-nums}",
          ".wsr-chart-share{text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
          ".wsr-chart-calls{text-align:right;color:var(--dsw-alias-label-tertiary);font-size:10px;font-variant-numeric:tabular-nums}",
          ".wsr-chart-headrow{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-chart-value-head,.wsr-chart-share-head,.wsr-chart-calls-head{text-align:right}",
          ".wsr-stats-details{display:flex;flex-direction:column;gap:8px}",
          ".wsr-stats-table{display:flex;flex-direction:column}",
          ".wsr-stats-row{display:grid;grid-template-columns:1.4fr .6fr .8fr .8fr .8fr .6fr;gap:6px;padding:6px 4px;border-bottom:.5px solid rgba(255,255,255,.06)}",
          ".wsr-stats-head{color:var(--dsw-alias-label-tertiary);font-size:11px}",
          ".wsr-td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".wsr-td-name{font-weight:500}",
          ".wsr-td-strong{font-weight:600}",
          ".wsr-td-dim{color:var(--dsw-alias-label-tertiary);opacity:.65}",
          ".wsr-stats-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}",
          /* Three views, one dialog: distribution, amplification, details. */
          ".wsr-stats-tabs{display:flex;gap:2px;border-bottom:.5px solid rgba(255,255,255,.08)}",
          ".wsr-stats-tab{border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;padding:6px 10px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-.5px}",
          ".wsr-stats-tab:hover{color:var(--dsw-alias-label-primary)}",
          ".wsr-stats-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary,#4f7cff)}",
          ".wsr-stats-panels{display:flex;flex-direction:column;gap:10px}",
          ".wsr-stats-panel{display:flex;flex-direction:column;gap:10px}",
          /* Amplified cost: the bill is the area under the context curve, so the
             ranking is by content x remaining steps, not by step tokens. */
          ".wsr-amplified{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}",
          ".wsr-amplified-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}",
          ".wsr-amplified-title{font-size:12px;font-weight:600}",
          ".wsr-amplified-summary{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-context-chart{display:flex;align-items:flex-end;gap:2px;height:54px;padding-top:4px;border-bottom:.5px solid rgba(255,255,255,.08)}",
          ".wsr-context-bar{flex:1;min-width:1px;border-radius:1px 1px 0 0;background:linear-gradient(180deg,rgba(79,124,255,.9),rgba(79,124,255,.3))}",
          ".wsr-context-caption{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-context-jump{position:relative;cursor:pointer}",
          /* Where a compaction rewrote the window: the curve restarts, and the
             divider keeps that drop from reading as a rendering glitch. */
          ".wsr-context-break{box-shadow:-1px 0 0 rgba(255,255,255,.35)}",
          ".wsr-context-jump-hit{position:absolute;left:50%;top:-9px;width:22px;height:22px;margin-left:-11px;display:flex;align-items:center;justify-content:center;border-radius:50%;cursor:pointer}",
          ".wsr-context-jump-dot{width:6px;height:6px;border-radius:50%;background:#d99a2b;transition:transform .12s,box-shadow .12s}",
          ".wsr-context-jump-hit[data-wsr-rank=\"1\"] .wsr-context-jump-dot{background:#f0553d}",
          ".wsr-context-jump-hit[data-wsr-rank=\"2\"] .wsr-context-jump-dot{background:#f5c542}",
          ".wsr-context-jump-hit[data-wsr-rank=\"3\"] .wsr-context-jump-dot{background:#4f9df7}",
          ".wsr-context-jump-hit-hot .wsr-context-jump-dot{transform:scale(1.8);box-shadow:0 0 0 4px rgba(217,154,43,.25)}",
          ".wsr-context-jump:hover .wsr-context-bar-inner{filter:brightness(1.15)}",
          ".wsr-context-jumps{display:flex;flex-direction:column;gap:2px;margin-top:2px}",
          ".wsr-context-jump-group{display:flex;flex-direction:column;gap:2px}",
          /* Fixed columns on every row is what aligns them: each row is its own
             grid, so `auto` widths would drift with the numbers they hold. */
          ".wsr-context-jump-row{display:grid;grid-template-columns:40px 84px 62px minmax(0,1fr);align-items:center;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary);padding:1px 5px;border-radius:4px;transition:background .12s,color .12s}",
          ".wsr-context-jump-segment{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
          ".wsr-context-jump-rank-dot{flex:none;width:6px;height:6px;border-radius:50%;background:#d99a2b}",
          ".wsr-context-jump-row[data-wsr-rank=\"1\"] .wsr-context-jump-rank-dot{background:#f0553d}",
          ".wsr-context-jump-row[data-wsr-rank=\"2\"] .wsr-context-jump-rank-dot{background:#f5c542}",
          ".wsr-context-jump-row[data-wsr-rank=\"3\"] .wsr-context-jump-rank-dot{background:#4f9df7}",
          ".wsr-context-jump-step{display:flex;align-items:center;gap:6px;white-space:nowrap}",
          ".wsr-context-jump-rise{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
          ".wsr-context-jump-what{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-context-jump-row-hot{background:rgba(217,154,43,.16);color:var(--dsw-alias-label-primary)}",
          ".wsr-kind-legend{display:flex;flex-wrap:wrap;gap:10px}",
          ".wsr-kind{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-kind-dot{width:8px;height:8px;border-radius:2px;flex:none}",
          ".wsr-amplified-list{display:flex;flex-direction:column;gap:2px}",
          ".wsr-amplified-row{display:grid;grid-template-columns:1fr 76px 48px;gap:8px;align-items:start;padding:6px 0;border-bottom:.5px solid rgba(255,255,255,.06)}",
          ".wsr-amplified-main{min-width:0;display:flex;flex-direction:column;gap:1px}",
          ".wsr-amplified-name{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".wsr-amplified-detail{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
          ".wsr-amplified-meta{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-amplified-value{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;font-size:12px}",
          ".wsr-amplified-share{text-align:right;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}",
          ".wsr-amplified-empty{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-amplified-subtitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-top:4px}",
          ".wsr-amplified-lead{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-stats-footnote{padding-top:6px;border-top:.5px solid rgba(255,255,255,.06)}",
          ".wsr-plugin-features{display:flex;flex-direction:column;gap:2px;margin-top:18px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-1,rgba(255,255,255,.10))}",
          ".wsr-features-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 2px 6px}",
          ".wsr-features-title{font-size:14px;font-weight:600}",
          ".wsr-toggle{width:100%;height:28px;padding:0 12px 0 calc(28px + var(--dsh-workspace-indent,0px));cursor:pointer;text-align:left;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;font-size:12px}",
          ".wsr-toggle:hover{color:var(--dsw-alias-label-secondary)}",
          '[' + STATE_ATTR + '="running"] [class*="_title"]{color:#4f8ef7}',
          '[' + STATE_ATTR + '="unread"] [class*="_title"]{color:#3fae6b}',
          '[' + STATE_ATTR + '="followup"] [class*="_title"]{color:#d99a2b}',
          '[' + STATE_ATTR + '="waiting"] [class*="_title"]{color:#d99a2b}',
          ".wsr-search-bar{display:flex;gap:8px;align-items:center}",
          ".wsr-hit-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:2px}",
          ".wsr-hit-context-toggle,.wsr-hit-context-jump{border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;cursor:pointer}",
          ".wsr-hit-context-toggle:hover,.wsr-hit-context-jump:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.24))}",
          ".wsr-hit-context{max-height:42vh;overflow:auto;margin-top:4px;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.75;white-space:pre-wrap;word-break:break-word;tab-size:2}",
          /* A column flex box with a fixed height shrinks its children once the
             content is taller than the box, and the shortest row goes first - that
             is how the recent-searches row vanished only after a search returned
             many results. Chrome keeps its size; the lists scroll. */
          ".wsr-search-page > *{flex:0 0 auto}",
          ".wsr-search-page > .wsr-page-list{flex:1 1 auto;min-height:0;overflow-y:auto}",
          ".wsr-search-toolbar{display:flex;align-items:center;gap:8px;min-width:0}",
          ".wsr-filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-filter{display:inline-flex;align-items:center;gap:4px;min-width:0}",
          ".wsr-filter-label{flex:none;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-filter-select,.wsr-filter-input{height:24px;box-sizing:border-box;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:0 6px;max-width:170px}",
          ".wsr-filter-input{width:120px}",
          ".wsr-seg{display:inline-flex;height:24px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));overflow:hidden}",
          ".wsr-seg-item{height:100%;padding:0 8px;border:none;border-left:.5px solid rgba(255,255,255,.12);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}",
          ".wsr-seg-item:first-child{border-left:none}",
          ".wsr-seg-item:hover{color:var(--dsw-alias-label-primary)}",
          ".wsr-seg-item-on{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f9df7) 16%,transparent)}",
          ".wsr-help{flex:none;width:24px;height:24px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}",
          ".wsr-help:hover,.wsr-help-on{color:var(--dsw-alias-label-primary);border-color:rgba(255,255,255,.3)}",
          ".wsr-search-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-search-status{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;padding-top:3px;border-top:.5px solid rgba(255,255,255,.06)}",
          ".wsr-search-group{display:flex;align-items:baseline;gap:8px;padding:10px 2px 4px;position:sticky;top:0;background:var(--dsw-alias-bg-base,transparent);z-index:1}",
          ".wsr-search-session{display:flex;align-items:baseline;gap:8px;padding:6px 2px 2px 6px;border-left:2px solid var(--dsw-alias-border-1,rgba(255,255,255,.10))}",
          ".wsr-search-session-name{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}",
          ".wsr-search-session-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-search-group-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
          ".wsr-search-group-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-hit-long{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:8px;background:rgba(217,154,43,.16);color:#d99a2b;white-space:nowrap}",
          ".wsr-btn-primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f9df7) 55%,transparent);color:var(--dsw-alias-label-primary)}",
          ".wsr-search-history{display:flex;align-items:center;flex-wrap:nowrap;overflow-x:auto;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary);scrollbar-width:none}",
          ".wsr-search-history-label{flex:none}",
          ".wsr-search-chip{display:inline-flex;align-items:center;border-radius:9px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.07));overflow:hidden}",
          ".wsr-search-chip-run{border:none;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;padding:0 4px 0 8px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".wsr-search-chip-run:hover{color:var(--dsw-alias-label-primary)}",
          ".wsr-search-chip-drop{border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:0 7px 0 2px;cursor:pointer}",
          ".wsr-search-chip-drop:hover{color:var(--dsw-alias-state-error-primary,#d9534f)}",
          ".wsr-search-history-clear{border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;padding:0 2px}",
          ".wsr-search-history-clear:hover{color:var(--dsw-alias-label-primary)}",
          ".wsr-search-input{flex:1;min-width:0;height:30px;padding:0 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font-size:13px}",
          ".wsr-hit{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;cursor:pointer}",
          ".wsr-hit:hover{background:var(--dsw-alias-bg-layer-2)}",
          ".wsr-hit-head{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-hit-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px}",
          ".wsr-hit-role{flex:none;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-size:10px}",
          ".wsr-hit-user{color:#4f8ef7}",
          ".wsr-hit-agent{color:#3fae6b}",
          ".wsr-hit-ws{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".wsr-hit-turn{flex:none}",
          ".wsr-hit-snippet{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}",
          ".wsr-hit-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-hit-time{flex:none;font-variant-numeric:tabular-nums}",
          ".wsr-hit-step{flex:none;color:var(--dsw-alias-label-secondary)}",
          ".wsr-jump-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;padding:6px 12px;border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-layer-3,rgba(32,34,38,.96));color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none}",
          ".wsr-jump-loading{color:var(--dsw-alias-label-secondary)}",
          ".wsr-jump-toast-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 45%,transparent);color:var(--dsw-alias-state-error-primary,#d9534f)}",
          ".wsr-hit-cwd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}",
          ".wsr-mark{background:rgba(79,142,247,.28);color:inherit;border-radius:2px}",
          '[data-wsr-flash="true"]{outline:2px solid #4f8ef7;outline-offset:2px;border-radius:8px}',
          ".wsr-dot{display:block;width:7px;height:7px;border-radius:50%;margin:0 auto;background:#d99a2b;cursor:pointer}",
          ".wsr-dot:hover{outline:2px solid var(--dsw-alias-border-l2)}",
          ".wsr-setRow{display:flex;align-items:center;gap:16px;justify-content:space-between;padding:12px 0}",
          ".wsr-setText{min-width:0}",
          ".wsr-setTitle{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}",
          ".wsr-setDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
          ".wsr-controls{display:flex;align-items:center;gap:8px;flex:none}",
          ".wsr-step{width:24px;height:24px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1}",
          ".wsr-input{width:48px;height:24px;text-align:center;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font-size:13px}",
          ".wsr-exempt{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:8px}",
        ].join("");

        var ZH = {
          "settings.title": "\u5386\u53f2\u6298\u53e0\u5929\u6570",
          "settings.description": "\u4f1a\u8bdd\u8d85\u8fc7\u8fd9\u4e48\u591a\u5929\u6ca1\u6709\u66f4\u65b0\u5c31\u6298\u53e0\uff1b\u6574\u4e2a\u5de5\u4f5c\u533a\u90fd\u8fc7\u671f\u65f6\u53ea\u5269\u5de5\u4f5c\u533a\u6807\u9898\u3002",
          "settings.exempt": "选中 / 运行中 / 等待处理 / 标记跟进的会话不折叠",
          "fold.show": "\u5c55\u5f00\u5386\u53f2 {n}",
          "fold.hide": "\u6536\u8d77\u5386\u53f2",
          "color.title": "\u989c\u8272\u4e0e\u8ddf\u8fdb\u6807\u8bb0",
          "color.description": "\u8fd0\u884c\u4e2d=\u84dd\uff0c\u5b8c\u6210\u672a\u8bfb=\u7eff\uff0c\u624b\u52a8\u6807\u8bb0\u9700\u8981\u8ddf\u8fdb=\u7425\u73c0\u3002\u5728\u4f1a\u8bdd\u300c\u2026\u300d\u83dc\u5355\u91cc\u6807\u8bb0 / \u53d6\u6d88\u3002",
          "color.enabled": "\u542f\u7528\u989c\u8272\u6807\u8bb0",
          "pin.title": "\u5168\u5c40\u7f6e\u9876\u533a",
          "pin.description": "\u5728\u6240\u6709\u5de5\u4f5c\u533a\u4e4b\u4e0a\u5355\u72ec\u5217\u51fa\u7f6e\u9876\u4f1a\u8bdd\uff1b\u53d6\u6d88\u7f6e\u9876\u540e\u56de\u5230\u5b83\u539f\u6765\u7684\u5de5\u4f5c\u533a\u4f4d\u7f6e\u3002",
          "pin.enabled": "\u663e\u793a\u7f6e\u9876\u533a",
          "pin.head": "\u7f6e\u9876",
          "pin.unpin": "\u53d6\u6d88\u7f6e\u9876",
          "pin.status.running": "运行中",
          "pin.status.done": "已完成",
          "pin.status.followup": "需要跟进",
          "pin.status.waiting": "等待你的确认",
          "argmode.title": "把工具参数计入主 agent",
          "argmode.description": "工具参数是模型自己写的（pwsh 的命令、write 的文件内容），严格说算主 agent 的输出，不算工具的消耗。打开后消耗分布里工具只算返回结果，参数并入主 agent。",
          "argmode.enabled": "工具参数计入主 agent",
          "menu.flag": "\u6807\u8bb0\u9700\u8981\u8ddf\u8fdb",
          "menu.unflag": "\u53d6\u6d88\u8ddf\u8fdb\u6807\u8bb0",
          "menu.trash": "\u5220\u9664\u4f1a\u8bdd\uff08\u79fb\u5165\u56de\u6536\u7ad9\uff09",
          "menu.stats": "Token \u6d88\u8017\u7edf\u8ba1",
          "stats.title": "Token \u6d88\u8017\u7edf\u8ba1",
          "stats.loading": "\u7edf\u8ba1\u4e2d\u2026\uff08\u5927\u4f1a\u8bdd\u9700\u8981\u4e00\u4e24\u79d2\uff09",
          "stats.failed": "\u7edf\u8ba1\u5931\u8d25\uff1a",
          "stats.steps": "\u6b65\u6570",
          "stats.input": "\u8f93\u5165\uff08\u672a\u7f13\u5b58\uff09",
          "stats.cache": "\u7f13\u5b58\u547d\u4e2d",
          "stats.output": "\u8f93\u51fa",
          "stats.total": "\u5408\u8ba1",
          "stats.agent": "\u4e3b agent",
          "stats.col.source": "\u6765\u6e90",
          "stats.col.calls": "\u8c03\u7528",
          "stats.callsShort": "{n} 次",
          "stats.col.tokensShort": "内容估算",
          "stats.col.shareShort": "占比",
          "stats.col.args": "\u53c2\u6570",
          "stats.col.results": "\u7ed3\u679c",
          "stats.col.total": "\u4f30\u7b97",
          "stats.col.share": "\u5360\u6bd4",
          "stats.note": "\u5408\u8ba1\u6765\u81ea\u6bcf\u6b65\u8bb0\u5f55\u7684\u771f\u5b9e usage\uff08\u7f13\u5b58\u547d\u4e2d + \u8f93\u5165 + \u8f93\u51fa\uff09\uff1b\u672c\u8868\u6309\u6765\u6e90\u7684\u62c6\u5206\u662f\u6309\u5185\u5bb9\u957f\u5ea6\u4f30\u7b97\uff08\u4e2d\u6587\u7ea6 1 token/\u5b57\uff0c\u82f1\u6587\u7ea6 4 \u5b57\u7b26/token\uff09\uff0c\u7528\u4e8e\u6bd4\u8f83\u5360\u6bd4\uff0c\u4e0d\u662f\u8ba1\u8d39\u53e3\u5f84\u3002",
          "stats.agentDetail": "主 agent 构成：思考 {reasoning} · 回复 {text} · 用户消息 {user} · 系统提示 {system}",
          "stats.split": "输入 {input} · 缓存命中 {cache} · 输出 {output}",
          "stats.diagnose.unmounted": "\n\n（宿主半已加载，但统计路由没挂上——重启应用再试）",
          "stats.diagnose.noHost": "\n\n（宿主半未加载：需要重启应用加载新版本）",
          "menu.move": "移动到工作区…",
          "menu.handoff": "交接到新会话",
          "handoff.title": "会话交接",
          "handoff.note": "交接指令已经放进输入框（或点「复制指令」自己粘），发送后我在这里等 AI 写出交接块；抓到以后可以直接开到新会话。",
          "handoff.instruction": "我要把这个会话交接给一个新会话继续推进。请按下面的要求输出一份交接说明，写进一个 ~~~handoff 代码块里（三个波浪线 + 语言标记 handoff），我会原样交给新会话：\n\n1. 只给文档路径和一句话说明「读它为什么」，不要粘贴文档内容；\n2. 文档按重要性排序，标注哪些必读、哪些按需；\n3. 包含：目标、当前进度、尚未完成与下一步、关键决策与约束、踩过的坑、验证方式；\n4. 交接正文控制在 400 字以内（文档引用除外）。",
          "handoff.inserted": "交接指令已放进输入框，按回车发送；我会自动抓取回复。",
          "handoff.copyHint": "没能直接写入输入框，请点「复制指令」再粘贴到输入框发送。",
          "handoff.copy": "复制指令",
          "handoff.waiting": "等待 AI 写出交接块…（{n} 秒）",
          "handoff.found": "已抓到交接块，确认后会在当前工作区开一个新会话并把它带过去。",
          "handoff.confirm": "确认交接，开新会话",
          "handoff.more": "继续补充",
          "handoff.noService": "没能自动开新会话，交接内容已复制到剪贴板，手动新建会话粘贴即可。",
          "handoff.preamble": "以下是一个会话交接说明，来自上一个会话。请先按「文档引用」逐份阅读文档，再结合要点接续工作；已经完成的部分不要重做。",
          "handoff.footnote": "交接内容会另存一份到 .wsr/handoff/，方便追溯。",
          "handoff.preparing": "正在准备交接，等这一轮回复写完…",
          "handoff.pressEnter": "指令已放进输入框，请按回车发送（自动发送没有生效）。",
          "handoff.cancel": "放弃交接",
          "handoff.confirmDesc": "带着这份内容在当前工作区开一个新会话",
          "handoff.regen": "不满意，重新生成一版",
          "handoff.regenDesc": "让当前会话按同样的要求再写一份",
          "handoff.extraPlaceholder": "补充调整意见（填了就按这些要求重写，例如：多写接口约束、少写历史）",
          "handoff.preview": "查看内容",
          "handoff.submit": "提交",
          "handoff.eyebrow": "需要你确认",
          "handoff.regeneratePrompt": "这份交接说明需要重写。请按最初同样的要求再输出一份，同样写进 ~~~handoff 代码块，路径与要点保持精炼。",
          "handoff.adjustPrompt": "请按下面的补充要求重写交接说明，保持 ~~~handoff 代码块格式：",
          "move.title": "移动到工作区",
          "move.warning": "只移动会话本身：它在旧工作区里创建或修改的文件不会跟着走，仍留在原目录。",
          "move.note": "会话属于哪个工作区，由它创建时的目录决定；移动会改写会话记录的 cwd，把日志搬到新工作区目录，旧日志备份在 .trash/ws-recency。",
          "move.confirm": "把会话移动到「{workspace}」？\n\n只移动会话记录，旧工作区里的文件不会跟着搬。",
          "move.current": "当前",
          "move.working": "移动中…（会先停止会话）",
          "move.done": "已移动到「{workspace}」。若列表没刷新，切换一下工作区或重启应用。",
          "move.doneLive": "\n\n这个会话刚才是打开状态：建议重启应用后再继续对话，避免它沿用旧的目录。",
          "move.repaired": "已补登记到「{workspace}」：上一次移动只搬了日志、没登记工作区，这次把它补上了。",
          "move.live": "这个会话正开着，无法移动。请重启应用，重启后不要打开它，再从列表里移动。",
          "adopt.title": "补登记游离会话",
          "adopt.description": "修复会话归属：把“目录属于某工作区却不在任何分组”的会话挂回去，并把仍挂在旧工作区分组里的重复归属清掉。",
          "adopt.action": "扫描并刷新",
          "adopt.working": "扫描中…",
          "adopt.done": "已补登记 {n} 个会话。",
          "adopt.cleaned": "清理了 {n} 处重复/失效的工作区归属。",
          "adopt.failed": "扫描失败：",
                    "features.title": "插件功能",
          "features.on": "已启用",
          "features.off": "已关闭",
          "features.reset": "全部启用",
          "features.restart": "改动需要重启应用后生效。",
          "features.note": "只关掉你不需要的部分：关掉的入口会从界面上消失，相关的后台逻辑也会停下。",
          "features.takesEffect": "当前启用 {on} / {all} 项。",
          "features.sidebar.title": "侧栏会话管理",
          "features.sidebar.desc": "旧会话折叠、会话颜色、置顶分区。关掉后侧栏交回宿主原样。",
          "features.followUp.title": "标记需要跟进",
          "features.followUp.desc": "会话菜单里的标记与侧栏旁边的圆点。",
          "features.search.title": "搜索会话内容",
          "features.search.desc": "侧栏搜索面板：全文搜索、筛选、跳转。装了别的搜索插件可以关掉这个。",
          "features.trash.title": "回收站",
          "features.trash.desc": "侧栏回收站面板：管理已归档会话和彻底删除。",
          "features.stats.title": "Token 消耗统计",
          "features.stats.desc": "输入框上方的「用量分析」胶囊与统计面板。",
          "features.handoff.title": "交接到新会话",
          "features.handoff.desc": "每轮回复下方的交接按钮，把要点写成文档带到新会话。",
          "features.move.title": "移动到工作区",
          "features.move.desc": "把会话改登记到另一个工作区（会重写日志 header，需重启后操作）。",
          "search.title": "搜索会话内容",
          "search.placeholder": "输入关键词后回车；多个词用空格分隔，要求同时出现",
          "search.run": "搜索",
          "search.searching": "搜索中…",
          "search.indexing": "还有 {n} 个会话正在建立索引，结果会陆续补上…",
          "search.summary": "{hits} 处命中 · 共 {sessions} 个会话 · {ms} ms",
          "search.empty": "没有匹配的内容。",
          "search.failed": "搜索失败：",
          "search.you": "你",
          "search.assistant": "助手",
          "search.turn": "第 {n} 轮",
          "search.turnWithStep": "第 {turn} 轮 · 第 {step} 步",
          "search.pluginCost": "插件 {ms}ms",
          "search.contextShow": "看上下文",
          "search.contextHide": "收起",
          "search.coldExpanded": "第 {turn} 轮在最新一轮之前 {behind} 轮，已展开上下文；要跳转请点这一行的「打开会话」。",
          "search.settings.coldTitle": "跳转前确认",
          "search.settings.coldDesc": "命中离最新一轮超过这么多轮时先问一句；0 表示每次都直接跳。",
          "search.groupCount": "{n} 处",
          "search.noWorkspace": "无归属工作区",
          "search.longBadge": "长会话 · {n} 轮",
          "search.longHint": "这一轮之前还有很多内容，跳过去要加载历史，可能很慢",
          "search.openSession": "打开会话",
          "search.hint": "空格=都要有 · \"词组\" · a|b 或 · -排除",
          "search.filterWorkspace": "工作区",
          "search.filterSession": "会话标题",
          "search.filterSessionPlaceholder": "包含…（回车）",
          "search.filterRole": "角色",
          "search.filterAll": "全部",
          "search.sessionResults": "会话（{n}）",
          "search.history": "最近搜索",
          "search.historyRun": "再搜一次：{query}",
          "search.historyDrop": "从历史里删除",
          "search.historyClear": "清空",

          "search.historyEmpty": "还没有记录",
          "search.step": "第 {n} 步",
          "search.jumpLoading": "正在加载第 {turn} 轮… {secs}s",
          "search.jumpLoadingCold": "正在加载第 {turn} 轮（历史较早，可能要十几秒）… {secs}s",
          "search.jumpTurn": "已定位：第 {turn} 轮 · 按轮次",
          "search.jumpText": "已定位：第 {turn} 轮 · 按文字",
          "search.jumpNoSession": "打不开这个会话（可能已归档、或不在当前工作区）",
          "search.jumpNoTurn": "会话已打开，但没找到第 {turn} 轮（共 {turns} 轮）",
          "search.jumpCollapsed": "找到了第 {turn} 轮，但这一轮的历史内容没有被渲染（长会话的旧轮次是折叠的），请手动向上翻一点",
          "ui.reload": "刷新界面",
          "ui.refresh": "刷新列表",
          "trash.title": "回收站",
          "trash.description": "被删除的会话会移到这里（日志目录），可以恢复，也可以彻底删除。",
          "trash.open": "打开",
          "trash.loading": "读取中…",
          "trash.empty": "回收站是空的。",
          "trash.reason.delete": "已删除",
          "trash.reason.move": "移动时的旧副本",
          "trash.groupParent": "含 {n} 个子会话",
          "trash.groupChild": "子会话",
          "trash.restore": "恢复",
          "trash.purge": "彻底删除",
          "trash.confirmRestore": "恢复到原来的工作区？",
          "trash.confirmPurge": "彻底删除这份日志？不可恢复。",
          "trash.restored": "已恢复，并重新挂回原工作区。若侧栏还没出现，点下面的「刷新界面」，或在本页右上角点「扫描并刷新」。",
          "trash.purged": "已彻底删除。",
          "trash.working": "处理中…",
          "trash.failed": "操作失败：",
          "trash.note": "回收站里的都是完整日志目录；恢复会按记录的 cwd 放回 sessions/<项目> 并重新挂到对应工作区。",
          "trash.turns": "轮次",
          "trash.steps": "步骤",
          "trash.section.trash": "已删除的会话",
          "trash.section.archived": "已归档的会话",
          "archive.description": "归档是宿主的「视图选项 → 仅显示已归档」那一套：会话被隐藏，但日志仍在 sessions/ 里，原工作区的槽位也保留着。这里可以取消归档、移入回收站，或者彻底删除。",
          "archive.empty": "没有已归档的会话。",
          "archive.unarchive": "取消归档",
          "archive.delete": "移到回收站",
          "archive.forget": "彻底删除",
          "archive.confirmUnarchive": "把这个会话放回原工作区的原位置？",
          "archive.tasksWarning": "这个会话有 {n} 个定时任务指向它{names}。删除后它们仍会到点触发，请先到「自动化任务」里停掉或改到别的会话。",
          "archive.confirmDelete": "把这个会话移入回收站？之后仍可在上面一栏恢复。",
          "archive.confirmForget": "彻底删除这个会话的日志？不可恢复。",
          "archive.badgeMissing": "记录失效",
          "archive.detach": "移出归档",
          "archive.detached": "已移出归档：只清理了归档记录，没有删除任何文件。",
          "archive.confirmDetach": "这个会话的日志已经不在磁盘上，只剩一条归档记录。要把它移出归档列表吗？\n\n只清理记录，不会删除任何文件；如果日志以后又被恢复，需要重新归档。",
          "archive.unarchived": "已取消归档，会话回到原来的位置。",
          "archive.deleted": "已移入回收站，可在「已删除的会话」里恢复。",
          "archive.forgotten": "已彻底删除。",
          "archive.failed": "归档操作失败：",
          "archive.noWorkspace": "（它原来的目录现在没有对应的工作区，需要先建一个同名工作区才能看到它）",
          "archive.badge": "已归档",
          "archive.blank": "空白草稿",
          "archive.workspace": "工作区",
          "move.failed": "移动失败：",
          "stats.chart": "消耗分布",
          "stats.family.shell": "命令执行",
          "stats.family.files": "文件操作",
          "stats.family.web": "网络检索",
          "stats.family.agents": "子代理/协作",
          "stats.family.misc": "其它工具",
          "stats.family.other": "未归类",
          "composer.analysis": "用量分析",
          "stats.legend.args": "参数（模型写的）",
          "stats.legend.results": "结果（环境返回的）",
          "stats.barTooltip": "{name} 共 {total}：参数 {args}（{argsShare}），结果 {results}（{resultsShare}）",
          "stats.argModeNote": "当前把工具参数计入主 agent：每个工具只算返回结果，表格里「参数」列显示为淡色（那些 token 记在主 agent 那一行）。",
          "stats.amplified.title": "放大成本（账单归因）",
          "stats.amplified.kindTitle": "账单构成",
          "stats.amplified.repeatTitle": "重复读取合计",
          "stats.amplified.repeatMeta": "{count} 次 · 合计 {tokens}",
          "stats.amplified.repeatTitle": "Repeated reads",
          "stats.amplified.repeatMeta": "{count} times · {tokens} total",
          "stats.amplified.lead": "按「内容大小 × 之后重读次数」排序：一块内容读进来一次，之后每一步都会再发一遍，乘上重读次数才是它真正的开销。上面的分布统计只算内容本身多大，两个数不能直接比。",
          "stats.amplified.summary": "账单 {bill} token；可归因内容经重读放大后占 {share}（{attributed}）",
          "stats.amplified.contextCaption": "每步上下文（面积≈账单）：一步＝一次模型调用，越早进入的内容被重读越多",
          "stats.amplified.point": "第 {step} 步 · {context}",
          "stats.amplified.jump": "第 {step} 步上下文涨了 {rise}",
          "stats.amplified.jumpStep": "第 {step} 步",
          "stats.amplified.segment": "第 {segment} 段",
          "stats.amplified.jumpFrom": "（{name} 进来 {tokens}）",
          "stats.amplified.meta": "{tokens} token × {remaining} 次重读 · 第 {entry} 步进入",
          "stats.amplified.whatIf": "若压到 20%，可省 {save}（{share}）",
          "stats.amplified.empty": "没有可归因的放大内容（压缩后或旧日志可能缺失）",
          "stats.amplified.note": "放大成本按内容长度估算；账单总量来自真实 usage。思维链通常不回传，故未计入。",
          "stats.amplified.results": "工具结果",
          "stats.amplified.args": "工具参数",
          "stats.amplified.agent": "主 agent 输出",
          "stats.amplified.user": "用户消息",
          "stats.amplified.system": "系统消息",
          "stats.tab.distribution": "分布统计",
          "stats.tab.amplified": "放大归因",
          "stats.tab.ranking": "放大排行",
          "stats.tab.details": "明细",
          "trash.confirm": "\u5220\u9664\u8fd9\u4e2a\u4f1a\u8bdd\uff1f\n\n\u4f1a\u5148\u505c\u6b62\u5b83\u6b63\u5728\u8fdb\u884c\u7684\u5de5\u4f5c\uff0c\u518d\u628a\u65e5\u5fd7\u76ee\u5f55\u79fb\u5165\u56de\u6536\u7ad9\uff08\u4e0d\u662f\u7269\u7406\u5220\u9664\uff0c\u53ef\u4ee5\u624b\u52a8\u6062\u590d\uff09\u3002",
          "trash.failed": "\u5220\u9664\u5931\u8d25\uff1a",
          "confirm.cancel": "\u53d6\u6d88",
          "confirm.ok": "\u786e\u8ba4",
        };
        var EN = {
          "settings.title": "Fold history after (days)",
          "settings.description": "Sessions with no update for this many days are folded; a workspace older than that shows as a bare header.",
          "settings.exempt": "Never fold the selected, running, waiting or follow-up session",
          "fold.show": "Show history ({n})",
          "fold.hide": "Hide history",
          "color.title": "Colors and follow-up marks",
          "color.description": "Running = blue, finished-unopened = green, a session you marked as needing follow-up = amber. Mark it from the session's \"...\" menu.",
          "color.enabled": "Enable color marks",
          "pin.title": "Global pinned section",
          "pin.description": "Lists pinned sessions in one section above every workspace; unpinning sends a session back to its own group.",
          "pin.enabled": "Show the pinned section",
          "argmode.title": "Count tool arguments as the agent's writing",
          "argmode.description": "A tool's arguments are what the model wrote (a shell command, a file body), so they arguably belong to the agent rather than to the tool. When this is on, the usage chart counts only tool results and moves the argument tokens onto the agent.",
          "argmode.enabled": "Tool arguments count for the agent",
          "pin.head": "Pinned",
          "pin.unpin": "Unpin",
          "pin.status.running": "Running",
          "pin.status.done": "Completed",
          "pin.status.followup": "Needs follow-up",
          "pin.status.waiting": "Waiting for you",
          "menu.flag": "Mark as needs follow-up",
          "menu.unflag": "Clear follow-up mark",
          "menu.trash": "Delete session (move to trash)",
          "menu.stats": "Token statistics",
          "stats.title": "Token statistics",
          "stats.loading": "Counting\u2026 (a large session takes a second or two)",
          "stats.failed": "Statistics failed: ",
          "stats.steps": "steps",
          "stats.input": "input (uncached)",
          "stats.cache": "cache read",
          "stats.output": "output",
          "stats.total": "total",
          "stats.agent": "main agent",
          "stats.col.source": "source",
          "stats.col.calls": "calls",
          "stats.callsShort": "{n}x",
          "stats.col.tokensShort": "content est.",
          "stats.col.shareShort": "share",
          "stats.col.args": "args",
          "stats.col.results": "results",
          "stats.col.total": "estimate",
          "stats.col.share": "share",
          "stats.note": "Totals come from the recorded per-step usage (cache read + input + output). The per-source split is estimated from content length (about 1 token per CJK character, 4 characters per token otherwise) so the shares are comparable, not billable.",
          "stats.agentDetail": "Agent composition: reasoning {reasoning} \u00b7 reply {text} \u00b7 user messages {user} \u00b7 system prompt {system}",
          "stats.split": "input {input} \u00b7 cache hit {cache} \u00b7 output {output}",
          "stats.diagnose.unmounted": "\n\n(the host half is loaded but the statistics route did not mount - restart the app and retry)",
          "stats.diagnose.noHost": "\n\n(the host half is not loaded: restart the app to pick up the new version)",
          "menu.move": "Move to workspace\u2026",
          "menu.handoff": "Hand off to a new session",
          "handoff.title": "Session handoff",
          "handoff.note": "The instruction is in the composer (or copy it yourself). Once you send it I watch for the handoff block and can carry it into a fresh Session.",
          "handoff.instruction": "I am handing this session over to a new one. Please answer with a handoff note inside a ~~~handoff code block (three tildes, tagged handoff), which I will pass on verbatim:\n\n1. Reference documents by path with one line on why to read them; never paste document contents.\n2. Order them by importance and mark which are required and which are optional.\n3. Cover: goal, current progress, remaining work and next step, key decisions and constraints, pitfalls, and how to verify.\n4. Keep the note under 400 words (references excluded).",
          "handoff.inserted": "Instruction placed in the composer; press Enter and I will pick up the reply.",
          "handoff.copyHint": "Could not write into the composer; copy the instruction and paste it yourself.",
          "handoff.copy": "Copy instruction",
          "handoff.waiting": "Waiting for the handoff block… ({n}s)",
          "handoff.found": "Handoff found. Confirming opens a new Session in this workspace with it carried over.",
          "handoff.confirm": "Confirm and open new Session",
          "handoff.more": "Keep refining",
          "handoff.noService": "Could not open a Session automatically; the handoff was copied to the clipboard.",
          "handoff.preamble": "Below is a handoff note from the previous Session. Read the referenced documents first, then continue from the notes; do not redo what is already done.",
          "handoff.footnote": "A copy is saved under .wsr/handoff/ for later reference.",
          "handoff.preparing": "Preparing the handoff; waiting for this turn to finish…",
          "handoff.pressEnter": "The instruction is in the composer; press Enter to send it (automatic send did not take).",
          "handoff.cancel": "Cancel handoff",
          "handoff.confirmDesc": "Open a new Session in this workspace with this note",
          "handoff.regen": "Not good enough, regenerate",
          "handoff.regenDesc": "Ask the current Session to write it again with the same rules",
          "handoff.extraPlaceholder": "Adjustments (if filled, the note is rewritten with them: more constraints, less history, …)",
          "handoff.preview": "Show note",
          "handoff.submit": "Submit",
          "handoff.eyebrow": "Needs your decision",
          "handoff.regeneratePrompt": "Rewrite the handoff note with the same rules as before, again inside a ~~~handoff block.",
          "handoff.adjustPrompt": "Rewrite the handoff note following these adjustments, keeping the ~~~handoff block format:",
          "move.title": "Move to workspace",
          "move.warning": "Only the session moves: files it created or changed in the old workspace stay where they are.",
          "move.note": "A session belongs to the workspace of the directory it was created in. Moving rewrites the stored cwd, relocates the log and keeps the old one as a backup in .trash/ws-recency.",
          "move.confirm": "Move this session to \"{workspace}\"?\n\nOnly the session record moves; its files stay in the old workspace.",
          "move.current": "current",
          "move.working": "Moving\u2026 (the session is stopped first)",
          "move.done": "Moved to \"{workspace}\". If the list has not refreshed, switch workspaces or restart the app.",
          "move.doneLive": "\n\nThe session was open: restart the app before continuing it so it does not keep using the old directory.",
          "move.repaired": "Registered in \"{workspace}\": the previous attempt moved the log without the bookkeeping, and this repaired it.",
          "adopt.title": "Adopt unlisted sessions",
          "adopt.description": "Repairs session membership: re-attaches sessions whose directory belongs to a workspace but are listed nowhere, and clears stale memberships that make one session appear twice.",
          "adopt.action": "Scan and reload",
          "adopt.working": "Scanning\u2026",
          "adopt.done": "Re-attached {n} session(s).",
          "adopt.cleaned": " Cleared {n} stale membership(s).",
          "adopt.failed": "Scan failed: ",
                    "features.title": "Plugin features",
          "features.on": "On",
          "features.off": "Off",
          "features.reset": "Enable all",
          "features.restart": "the change takes effect after a restart.",
          "features.note": "Turn off only what you do not need: the entry disappears from the interface and its background work stops.",
          "features.takesEffect": "{on} of {all} features are on.",
          "features.sidebar.title": "Sidebar session management",
          "features.sidebar.desc": "Folding old sessions, session colours, the pinned section. Off returns the sidebar to the host.",
          "features.followUp.title": "Follow-up marks",
          "features.followUp.desc": "The mark in the session menu and the dot beside the row.",
          "features.search.title": "Search sessions",
          "features.search.desc": "The search panel: full text, filters, jumping. Turn it off if another search plugin owns this.",
          "features.trash.title": "Trash",
          "features.trash.desc": "The trash panel: manage archived sessions and delete for good.",
          "features.stats.title": "Token statistics",
          "features.stats.desc": "The usage pill above the composer and the statistics panel.",
          "features.handoff.title": "Hand off to a new session",
          "features.handoff.desc": "The action under each reply that carries the gist into a fresh session.",
          "features.move.title": "Move to workspace",
          "features.move.desc": "Re-register a session under another workspace (rewrites the log header; restart first).",
          "search.title": "Search session content",
          "search.placeholder": "Type a word and press Enter; separate words with spaces to require all of them",
          "search.run": "Search",
          "search.searching": "Searching\u2026",
          "search.indexing": "Still indexing {n} session(s); results will fill in\u2026",
          "search.summary": "{hits} hit(s) across {sessions} session(s) \u00b7 {ms} ms",
          "search.empty": "Nothing matched.",
          "search.failed": "Search failed: ",
          "search.you": "You",
          "search.assistant": "Assistant",
          "search.turn": "turn {n}",
          "search.turnWithStep": "turn {turn} · step {step}",
          "search.pluginCost": "plugin {ms}ms",
          "search.contextShow": "Show context",
          "search.contextHide": "Hide",
          "search.coldExpanded": "Turn {turn} is {behind} turns behind the newest one, so its context is shown here; press Open session on this row to jump.",
          "search.settings.coldTitle": "Ask before a long jump",
          "search.settings.coldDesc": "Ask when a hit is this many turns behind the newest one; 0 jumps every time.",
          "search.groupCount": "{n} hits",
          "search.noWorkspace": "No workspace",
          "search.longBadge": "Long session · {n} turns",
          "search.longHint": "There is a lot of history before this turn; jumping there loads it and can be slow",
          "search.openSession": "Open session",
          "search.hint": "space = all of them · \"phrase\" · a|b either · -exclude",
          "search.filterWorkspace": "Workspace",
          "search.filterSession": "Session",
          "search.filterSessionPlaceholder": "title contains… (Enter)",
          "search.filterRole": "Role",
          "search.filterAll": "All",
          "search.sessionResults": "Sessions ({n})",
          "search.history": "Recent",
          "search.historyRun": "Search again: {query}",
          "search.historyDrop": "Remove from history",
          "search.historyClear": "Clear",

          "search.historyEmpty": "nothing yet",
          "search.step": "step {n}",
          "search.jumpLoading": "Loading turn {turn}… {secs}s",
          "search.jumpLoadingCold": "Loading turn {turn} (older history, this can take a while)… {secs}s",
          "search.jumpTurn": "Landed on turn {turn} (by turn)",
          "search.jumpText": "Landed on turn {turn} (by text)",
          "search.jumpNoSession": "Could not open that session (archived, or outside the current workspace)",
          "search.jumpNoTurn": "Session opened, but turn {turn} was not found (of {turns})",
          "search.jumpCollapsed": "Turn {turn} was found, but its history is not rendered (old turns of a long session are collapsed); scroll up a little",
          "ui.reload": "Reload UI",
          "ui.refresh": "Refresh",
          "trash.title": "Trash",
          "trash.description": "Deleted sessions land here (their log directory). Restore them, or delete them for good.",
          "trash.open": "Open",
          "trash.loading": "Loading\u2026",
          "trash.empty": "The trash is empty.",
          "trash.reason.delete": "deleted",
          "trash.reason.move": "old copy from a move",
          "trash.groupParent": "with {n} subagent session(s)",
          "trash.groupChild": "subagent",
          "trash.restore": "Restore",
          "trash.purge": "Delete for good",
          "trash.confirmRestore": "Restore it to its original workspace?",
          "trash.confirmRestoreGroup": "Restore it to its old workspace? The {n} subagent session(s) in this batch come back too.",
          "trash.confirmPurge": "Delete this log for good? This cannot be undone.",
          "trash.restored": "Restored and re-attached to its workspace. If the sidebar has not picked it up, press \"Reload UI\" below, or use \"Scan and reload\" at the top right of this panel.",
          "trash.purged": "Deleted for good.",
          "trash.working": "Working\u2026",
          "trash.failed": "Action failed: ",
          "trash.note": "Every entry is a complete log directory; restoring puts it back under sessions/<project> using the recorded cwd and re-attaches it.",
          "trash.turns": "turns",
          "trash.steps": "steps",
          "trash.section.trash": "Deleted sessions",
          "trash.section.archived": "Archived sessions",
          "archive.description": "Archiving is the Host's own view filter (\"Show archived only\"): the session is hidden, but its log stays under sessions/ and its workspace still holds its slot. Unarchive it here, move it into the trash, or delete it for good.",
          "archive.empty": "No archived sessions.",
          "archive.unarchive": "Unarchive",
          "archive.delete": "Move to trash",
          "archive.forget": "Delete for good",
          "archive.confirmUnarchive": "Put this session back where it was in its workspace?",
          "archive.tasksWarning": "{n} scheduled task(s) point at this session{names}. They still fire after it is deleted; stop or retarget them under Automation first.",
          "archive.confirmDelete": "Move this session into the trash? You can still restore it from the section above.",
          "archive.confirmForget": "Delete this session's log for good? This cannot be undone.",
          "archive.badgeMissing": "record only",
          "archive.detach": "Remove from archive",
          "archive.detached": "Removed from the archive: only the archive record was cleared, no files were touched.",
          "archive.confirmDetach": "This session's log is no longer on disk; only its archive record is left. Remove that record from the archive list?\n\nNo files are touched. If the log ever comes back, the session has to be archived again.",
          "archive.unarchived": "Unarchived: the session is back in its place.",
          "archive.deleted": "Moved into the trash; restore it from \"Deleted sessions\".",
          "archive.forgotten": "Deleted for good.",
          "archive.failed": "Archive action failed: ",
          "archive.noWorkspace": " (its original directory has no workspace right now - create one with the same path to see it again)",
          "archive.blank": "blank draft",
          "archive.workspace": "workspace",
          "move.failed": "Move failed: ",
          "move.live": "This session is open, so it cannot be moved. Restart the app, do not open it, then move it from the list.",
          "stats.chart": "Where the tokens went",
          "stats.family.shell": "shell",
          "stats.family.files": "files",
          "stats.family.web": "web",
          "stats.family.agents": "subagents",
          "stats.family.misc": "other tools",
          "stats.family.other": "unclassified",
          "composer.analysis": "Usage analysis",
          "stats.legend.args": "arguments (written by the model)",
          "stats.legend.results": "results (returned by the environment)",
          "stats.barTooltip": "{name}: {total} total - arguments {args} ({argsShare}), results {results} ({resultsShare})",
          "stats.argModeNote": "Tool arguments currently count towards the agent: each tool shows only its results, and the table's \"args\" column is faded because those tokens sit on the agent's row.",
          "stats.amplified.title": "Amplified cost (what the bill pays for)",
          "stats.amplified.kindTitle": "What the bill is made of",
          "stats.amplified.lead": "Ranked by content size × the later steps that re-read it: content is re-sent on every step after it enters, so the multiplier is what the bill actually pays. The distribution tab measures only the content itself, so the two numbers do not compare directly.",
          "stats.amplified.summary": "Bill {bill} tokens; attributable content amplifies to {share} ({attributed})",
          "stats.amplified.contextCaption": "Context per step (area ≈ bill): one step is one model call; earlier content is re-read more",
          "stats.amplified.point": "step {step} · {context}",
          "stats.amplified.jump": "step {step} grew by {rise}",
          "stats.amplified.jumpStep": "step {step}",
          "stats.amplified.segment": "seg {segment}",
          "stats.amplified.jumpFrom": "({name} brought {tokens})",
          "stats.amplified.meta": "{tokens} tokens × {remaining} re-reads · entered at step {entry}",
          "stats.amplified.whatIf": "at 20%, saves {save} ({share})",
          "stats.amplified.empty": "No amplifiable content (compacted or older logs may lack it)",
          "stats.amplified.note": "Amplified cost is estimated from content length; the bill total comes from real usage. Reasoning is usually not resent, so it is excluded.",
          "stats.amplified.results": "tool results",
          "stats.amplified.args": "tool arguments",
          "stats.amplified.agent": "agent output",
          "stats.amplified.user": "user messages",
          "stats.amplified.system": "system messages",
          "stats.tab.distribution": "Distribution",
          "stats.tab.amplified": "Amplified",
          "stats.tab.ranking": "Ranking",
          "stats.tab.details": "Details",
          "trash.confirm": "Delete this session?\n\nIt stops whatever the session is running, then moves the log directory into the trash folder (a move, not an erase: you can restore it by hand).",
          "trash.failed": "Delete failed: ",
          "confirm.cancel": "Cancel",
          "confirm.ok": "Confirm",
        };

        /* Resolved lazily: the dictionaries are declared further down this closure. */
        var resolvedDictionary = null;

        function fallbackDictionary() {
          if (resolvedDictionary !== null) return resolvedDictionary;
          var language = "";
          /* The page's own lang wins: it is what the UI is actually rendered in. */
          try { if (typeof document !== "undefined" && document.documentElement !== null && document.documentElement !== undefined) language = document.documentElement.lang || ""; } catch (error) { language = ""; }
          try { if (language === "" && typeof navigator !== "undefined" && navigator.language) language = navigator.language; } catch (error) { /* keep empty */ }
          resolvedDictionary = String(language).toLowerCase().indexOf("zh") === 0 ? ZH : EN;
          return resolvedDictionary;
        }

        function t(key, params) {
          if (typeof data.t === "function") {
            var translated = null;
            try { translated = data.t(key, params); } catch (error) { translated = null; }
            if (typeof translated === "string" && translated !== key) return translated;
          }
          var dictionary = fallbackDictionary();
          var text = (dictionary && dictionary[key]) || key;
          /* The host's translate may interpolate; the local fallback has to do
             it itself, or every template would render its braces verbatim. */
          if (params !== undefined && params !== null) {
            for (var name in params) {
              if (!Object.prototype.hasOwnProperty.call(params, name)) continue;
              text = text.split("{" + name + "}").join(String(params[name]));
            }
          }
          return text;
        }

        /**
         * Whether a mutated node belongs to the conversation, not the sidebar.
         *
         * The observer used to watch the whole body, so a chat that mounts a page
         * of history - thousands of nodes - ran this plugin's sidebar pass over and
         * over while the host was rendering, and that is what made a jump into a
         * long session feel frozen. Nothing here decorates the chat, so its
         * mutations are none of this observer's business.
         */
        /**
         * The sidebar's own containers, as a set of ancestors of a workspace row.
         *
         * Filtering by "is the chat in this node" was not enough: the turn rail and
         * the host's hover preview are portalled onto <body>, outside the chat, so
         * moving the pointer along the rail ran this plugin's sidebar pass on every
         * preview repaint - which is exactly the delay felt after a long jump. The
         * sidebar is a sibling subtree, and only its containers can hold a row.
         */
        var sidebarAncestors = null;

        function sidebarChain() {
          if (sidebarAncestors !== null && sidebarAncestors.size > 0) {
            /* Revalidate cheaply: a stale set would stop noticing real changes. */
            var alive = 0;
            sidebarAncestors.forEach(function (node) {
              if (node.isConnected !== false) alive += 1;
            });
            if (alive > 0) return sidebarAncestors;
          }
          var set = new Set();
          var header = document.querySelector('[data-row-key^="' + HEADER_PREFIX + '"]');
          if (header === null || header === undefined) return set;
          var node = header.parentElement;
          while (node !== null && node !== undefined && node.parentElement !== null
            && node.parentElement !== undefined && node.parentElement !== document.body) {
            set.add(node);
            node = node.parentElement;
          }
          sidebarAncestors = set;
          return set;
        }

        function outsideSidebar(node, chain) {
          if (node === null || node === undefined) return false;
          var element = node;
          if (element.nodeType !== 1) element = element.parentElement;
          if (element === null || element === undefined) return false;
          var containers = chain === undefined || chain === null ? sidebarChain() : chain;
          var current = element;
          while (current !== null && current !== undefined) {
            if (containers.has(current)) return false;
            if (current === document.body) return true;
            current = current.parentElement;
          }
          return true;
        }        function top() {
          return typeof document !== "undefined" && document.body !== null ? document.body : null;
        }

        function log(message, detail) {
          if (window.__DSH_WSR_DEBUG__ === true) console.debug("[dsh-ws-recency] " + message, detail === undefined ? "" : detail);
        }

        function installCss() {
          if (typeof document === "undefined") return;
          if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return;
          var tag = document.createElement("style");
          tag.dataset.plugin = "dsh-ws-recency";
          tag.dataset.pluginCss = CSS_ID;
          tag.textContent = CSS;
          document.head.appendChild(tag);
        }

        function settingsOf() {
          var settings = data.settings || {};
          var days = Number(settings.foldDays);
          if (!Number.isFinite(days)) days = DEFAULT_DAYS;
          return {
            enabled: settings.enabled !== false,
            foldDays: Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(days))),
            keepActive: settings.keepActive !== false,
            colors: settings.colors !== false,
            pinnedSection: settings.pinnedSection !== false,
            argMode: settings.argMode === "agent" ? "agent" : "tool",
            followUps: settings.followUps !== null && typeof settings.followUps === "object" ? settings.followUps : {},
          };
        }

        function latestByWorkspace(sessions, workspaces) {
          var map = new Map();
          if (sessions === null || workspaces === null) return map;
          var byId = sessions.byId || {};
          var items = workspaces.items || [];
          var archived = new Set(workspaces.archivedSessionIds || []);
          for (var i = 0; i < items.length; i += 1) {
            var workspace = items[i];
            var ids = workspace.sessionIds || [];
            var latest = 0;
            for (var j = 0; j < ids.length; j += 1) {
              var session = byId[ids[j]];
              if (session === undefined || session === null) continue;
              if (session.blank === true) continue;
              if (session.origin === "subagent") continue;
              if (archived.has(session.id)) continue;
              var updated = typeof session.updatedAt === "number" ? session.updatedAt : 0;
              if (updated > latest) latest = updated;
            }
            map.set(workspace.workspaceId, latest);
          }
          return map;
        }

        function sectionOf(header) {
          var current = header.parentElement;
          while (current !== null) {
            var className = typeof current.className === "string" ? current.className : "";
            if (className.indexOf(SECTION_TOKEN) !== -1) return current;
            current = current.parentElement;
          }
          return null;
        }

        function collect() {
          var out = [];
          var headers = document.querySelectorAll('[data-row-key^="' + HEADER_PREFIX + '"]');
          for (var i = 0; i < headers.length; i += 1) {
            var header = headers[i];
            var section = sectionOf(header);
            if (section === null) continue;
            var key = header.getAttribute("data-row-key") || "";
            out.push({
              header: header,
              section: section,
              key: key,
              id: key.slice(HEADER_PREFIX.length),
            });
          }
          return out;
        }

        function busyRankOf(section) {
          var raw = section.getAttribute(BUSY_RANK_ATTR);
          if (raw === null || raw === "") return 0;
          var value = Number(raw);
          return Number.isFinite(value) ? value : 0;
        }

        function ready(snapshot) {
          if (snapshot === null || snapshot === undefined) return false;
          return snapshot.phase === undefined || snapshot.phase === "ready";
        }

        function orderGroups(entries, latest) {
          var byParent = new Map();
          for (var i = 0; i < entries.length; i += 1) {
            var parent = entries[i].section.parentElement;
            if (parent === null) continue;
            var list = byParent.get(parent);
            if (list === undefined) {
              list = [];
              byParent.set(parent, list);
            }
            list.push(entries[i]);
          }
          byParent.forEach(function (list, parent) {
            if (list.length < 2) return;
            if (parent.getAttribute(ROOT_ATTR) !== "true") {
              parent.setAttribute(ROOT_ATTR, "true");
              roots.add(parent);
            }
            list.sort(function (a, b) {
              var ua = a.id === "" ? 1 : 0;
              var ub = b.id === "" ? 1 : 0;
              if (ua !== ub) return ua - ub;
              var ra = busyRankOf(a.section);
              var rb = busyRankOf(b.section);
              if (ra !== rb) return rb - ra;
              var la = a.id === "" ? -1 : latest.get(a.id) || 0;
              var lb = b.id === "" ? -1 : latest.get(b.id) || 0;
              return lb - la;
            });
            for (var k = 0; k < list.length; k += 1) {
              var section = list[k].section;
              var value = String(k);
              if (section.style.order !== value) section.style.order = value;
              if (section.getAttribute(RANK_ATTR) !== value) section.setAttribute(RANK_ATTR, value);
              written.add(section);
            }
          });
        }

        /** Direct children of a group that carry a Session row (the host wraps some). */
        function rowElements(section) {
          var out = [];
          var children = section.children || [];
          for (var i = 0; i < children.length; i += 1) {
            var child = children[i];
            if (child.getAttribute !== undefined && child.getAttribute("role") === "group") continue;
            if (child.tagName === "BUTTON") continue;
            if (child.dataset !== undefined && child.dataset !== null && child.dataset.dshUxPlus !== undefined) continue;
            var own = child.getAttribute !== undefined ? child.getAttribute("data-row-key") : null;
            if (typeof own === "string" && own.indexOf(SESSION_PREFIX) === 0) {
              out.push(child);
              continue;
            }
            if (typeof child.querySelector === "function" && child.querySelector('[data-row-key^="' + SESSION_PREFIX + '"]') !== null) out.push(child);
          }
          return out;
        }

        function isActiveRow(row) {
          if (typeof row.querySelector !== "function") return false;
          return row.querySelector('[data-state="ongoing"], [data-state="warning"]') !== null;
        }

        function isSelectedRow(row) {
          if (typeof row.getAttribute !== "function") return false;
          return row.getAttribute("aria-selected") === "true";
        }

        function sessionIdOf(row) {
          var key = typeof row.getAttribute === "function" ? row.getAttribute("data-row-key") : null;
          if (typeof key !== "string" || key.indexOf(SESSION_PREFIX) !== 0) {
            if (typeof row.querySelector === "function") {
              var inner = row.querySelector('[data-row-key^="' + SESSION_PREFIX + '"]');
              if (inner !== null) key = inner.getAttribute("data-row-key");
            }
          }
          return typeof key === "string" && key.indexOf(SESSION_PREFIX) === 0 ? key.slice(SESSION_PREFIX.length) : null;
        }

        function updatedAtOf(row, sessions) {
          var id = sessionIdOf(row);
          if (id === null || sessions === null) return null;
          var session = (sessions.byId || {})[id];
          if (session === undefined || session === null) return null;
          return typeof session.updatedAt === "number" ? session.updatedAt : null;
        }

        /**
         * The provisional "New session" row. The host always renders it, and folding
         * it would remove the very input row you are typing into.
         */
        function isBlankRow(row, sessions) {
          if (sessions === null || sessions === undefined) return false;
          var id = sessionIdOf(row);
          if (id === null) return false;
          var session = (sessions.byId || {})[id];
          return session !== undefined && session !== null && session.blank === true;
        }

        /** The host's own "show more" button, hidden by CSS but still clickable. */
        function overflowButtonOf(section) {
          if (typeof section.querySelector !== "function") return null;
          return section.querySelector('button[class*="' + OVERFLOW_TOKEN + '"]');
        }

        /** The count the host reports on its own button, 0 when there is none. */
        function labelNumber(button) {
          if (button === null || button === undefined) return 0;
          var text = typeof button.textContent === "string" ? button.textContent : "";
          var match = /\d+/.exec(text);
          if (match === null) return 0;
          var value = Number(match[0]);
          return Number.isFinite(value) && value > 0 ? value : 0;
        }

        /** Collapsing a group resets its fold state, so the click is observed. */
        function markHeader(header, key) {
          if (typeof header.addEventListener !== "function" || headerMarked.has(header)) return;
          headerMarked.add(header);
          header.addEventListener("click", function () {
            if (disposed) return;
            expandedSections.delete(key);
            schedule();
          });
        }

        /** The group's own "show history" control, created only when something is folded. */
        function ensureToggle(section, key, label, onClick) {
          var button = section.querySelector('[data-wsr-fold="true"]');
          if (button === null) {
            button = document.createElement("button");
            button.type = "button";
            button.className = "wsr-toggle";
            button.setAttribute(FOLD_ATTR, "true");
            button.addEventListener("click", function (event) {
              if (disposed) return;
              if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
              var current = button.wsrOnClick;
              if (typeof current === "function") current();
            });
            section.appendChild(button);
            toggles.add(button);
          }
          /* The handler is refreshed every pass: the button toggles between "show"
             and "hide", and a captured first callback would only ever show. */
          button.wsrOnClick = onClick;
          if (button.textContent !== label) button.textContent = label;
          return button;
        }

        function dropToggle(section) {
          var button = section.querySelector('[data-wsr-fold="true"]');
          if (button !== null) {
            toggles.delete(button);
            button.remove();
          }
        }

        /**
         * Fold the rows the host rendered that have not changed for `foldDays`, and
         * offer the group's own control to bring them back. A workspace whose every
         * session is that old therefore renders as a bare header.
         *
         * The host's own "show more" button is hidden (CSS) and driven from here: it
         * only renders five rows at a time and cannot collapse once everything is
         * rendered, which made "show more" look broken next to a fold. Expanding the
         * group now clicks that hidden button once per pass until the host has
         * rendered every session, so one click reveals everything; collapsing just
         * folds the stale rows again.
         */
        function foldRows(entries, settings, sessions, now) {
          var cutoff = now - settings.foldDays * DAY;
          for (var i = 0; i < entries.length; i += 1) {
            var entry = entries[i];
            var section = entry.section;
            var rows = rowElements(section);
            var hostButton = overflowButtonOf(section);
            markHeader(entry.header, entry.key);

            /* Everything this project holds is history: no session inside it is
               recent, so the user's expansion of the project is itself the
               request to see its sessions. Folding here only adds a second click
               for a group the user has already gone looking for. */
            var onlyHistory = rows.length > 0;
            for (var scan = 0; scan < rows.length; scan += 1) {
              var scannedAt = updatedAtOf(rows[scan], sessions);
              var covers = scannedAt === null || scannedAt >= cutoff;
              if (covers && !isBlankRow(rows[scan], sessions)) {
                onlyHistory = false;
                break;
              }
            }
            var expanded = expandedSections.has(entry.key) || onlyHistory;
            var hostHidden = hostButton === null ? 0 : labelNumber(hostButton);
            var hostExpanded = hostButton !== null
              && typeof hostButton.getAttribute === "function"
              && hostButton.getAttribute("aria-expanded") === "true";
            if (expanded && hostButton !== null && !hostExpanded) {
              /* The host renders five more per click (or everything when five or
                 fewer remain) and reports `aria-expanded` once nothing is hidden.
                 Stopping on that flag is what keeps the loop from collapsing the
                 very thing it just expanded - a click on an expanded host button
                 resets the watermark. */
              var used = expandClicks.get(entry.key) || 0;
              if (used < MAX_EXPAND_CLICKS) {
                expandClicks.set(entry.key, used + 1);
                hostButton.click();
              }
            } else if (!expanded) {
              expandClicks.delete(entry.key);
            }

            var folded = 0;
            for (var j = 0; j < rows.length; j += 1) {
              var row = rows[j];
              var updated = updatedAtOf(row, sessions);
              var stale = updated !== null && updated < cutoff;
              var blank = isBlankRow(row, sessions);
              /* "Needs follow-up" means "I still owe this one an answer": hiding it
                 behind a fold defeats the mark, so it is exempt like a running row. */
              var marked = sessionIdOf(row);
              var flagged = marked !== null && settings.followUps !== null
                && typeof settings.followUps === "object"
                && settings.followUps[marked] !== undefined;
              var exempt = flagged || (settings.keepActive && (isActiveRow(row) || isSelectedRow(row)));
              var hide = !expanded && stale && !exempt && !blank;
              if (hide) {
                if (row.getAttribute(HIDDEN_ATTR) !== "true") row.setAttribute(HIDDEN_ATTR, "true");
                hidden.add(row);
                folded += 1;
              } else {
                if (row.getAttribute(HIDDEN_ATTR) !== null) row.removeAttribute(HIDDEN_ATTR);
                hidden.delete(row);
              }
            }

            /* ONE control per group: its count is everything the group still hides,
               both the rows the host did not render and the stale rows this plugin
               folded. Expanding drives the hidden host button until nothing is left
               unrendered, so one click reveals the whole group. */
            var remaining = folded + hostHidden;
            /* A project that is entirely history is open because opening it is the
               request; there is nothing to offer to fold back. */
            if (expanded && !onlyHistory) {
              (function (entryKey) {
                ensureToggle(section, entryKey, t("fold.hide"), function () {
                  expandedSections.delete(entryKey);
                  expandClicks.delete(entryKey);
                  schedule();
                });
              })(entry.key);
            } else if (remaining > 0) {
              (function (entryKey) {
                ensureToggle(section, entryKey, t("fold.show", { n: remaining }), function () {
                  expandedSections.add(entryKey);
                  schedule();
                });
              })(entry.key);
            } else {
              dropToggle(section);
            }
          }
        }

        function baseName(path) {
          if (typeof path !== "string" || path === "") return "";
          var parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
          return parts.length === 0 ? path : parts[parts.length - 1];
        }

        /** sessionId -> owning workspace label, for the trailing tag in the pinned rows. */
        function workspaceLabels(workspaces) {
          var map = {};
          var items = (workspaces !== null && workspaces !== undefined && workspaces.items) || [];
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i];
            var label = (item.title && String(item.title)) || baseName(item.path);
            var ids = item.sessionIds || [];
            for (var j = 0; j < ids.length; j += 1) if (map[ids[j]] === undefined) map[ids[j]] = label;
          }
          return map;
        }

        /**
         * The sessions the host itself has pinned, newest first.
         *
         * The pins are the host's own set (`workspaces.pinnedSessionIds`), so this is
         * not a second pinning system: pin / unpin from the normal "..." menu and the
         * section follows.
         */
        function pinnedItemsOf(sessions, workspaces, settings) {
          if (!settings.pinnedSection) return [];
          var ids = (workspaces !== null && workspaces !== undefined && workspaces.pinnedSessionIds) || [];
          if (ids.length === 0) return [];
          var byId = sessions.byId || {};
          var archived = new Set((workspaces && workspaces.archivedSessionIds) || []);
          var labels = workspaceLabels(workspaces);
          var out = [];
          for (var i = 0; i < ids.length; i += 1) {
            var session = byId[ids[i]];
            if (session === undefined || session === null) continue;
            if (session.origin === "subagent" || session.blank === true) continue;
            if (archived.has(ids[i])) continue;
            var title = (session.title || "").trim();
            out.push({
              id: ids[i],
              title: title === "" ? ids[i].slice(0, 8) : title,
              where: labels[ids[i]] || "",
              updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : 0,
            });
          }
          out.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
          return out;
        }

        /**
         * The browser's workspace-navigation service (`uiWorkspace`).
         *
         * Resolved late on purpose: a client plugin can apply before the Workspace
         * UI has provided the service, and cordis refuses un-injected service
         * access. The value is cached once it is available and re-asked on use
         * until then, so a plugin that lost the race still navigates.
         */
        function workspaceService() {
          if (data.service !== null && data.service !== undefined) return data.service;
          var ctx = data.ctx;
          if (ctx === null || ctx === undefined) return null;
          try {
            var service = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
            if (service !== null && service !== undefined) data.service = service;
          } catch (error) {
            /* not resolvable from this context yet */
          }
          return data.service === undefined ? null : data.service;
        }

        /**
         * Open a session this plugin rendered itself (the pinned section).
         *
         * The service call is the one the host's own rows make, so it is the
         * primary path. If the service is unreachable or throws, fall back to the
         * host's own row for that session - it is still in the DOM, only hidden
         * behind the pinned section - and let the app navigate itself.
         */
        function openSessionRow(sessionId) {
          var service = workspaceService();
          if (service !== null && typeof service.openSession === "function") {
            try {
              service.openSession(sessionId);
              return true;
            } catch (error) {
              log("openSession threw; falling back to the host row", error);
            }
          }
          var row = null;
          try {
            row = document.querySelector('[data-row-key="session:' + sessionId + '"]');
          } catch (error) {
            row = null;
          }
          if (row !== null && typeof row.click === "function") {
            try {
              /* Some row handlers listen on mousedown: send the whole press so the
                 host's own navigation runs whichever event it uses. */
              if (typeof MouseEvent === "function") {
                for (var t = 0; t < PRESS_EVENTS.length; t += 1) {
                  row.dispatchEvent(new MouseEvent(PRESS_EVENTS[t], { bubbles: true, cancelable: true, view: typeof window === "undefined" ? null : window }));
                }
              }
              row.click();
              return true;
            } catch (error) {
              log("the host row could not be clicked", error);
            }
          }
          return false;
        }

        /** Ask the host to drop a pin; same late-resolution rule as above. */
        function unpinSession(sessionId) {
          var service = workspaceService();
          if (service !== null && typeof service.unpinSession === "function") {
            try {
              service.unpinSession(sessionId);
              return true;
            } catch (error) {
              log("unpinSession threw", error);
            }
          }
          return false;
        }

        /** The host's four status looks, mapped onto the plugin's own states. */
        function pinDotStateOf(state) {
          if (state === "running") return "ongoing";
          if (state === "waiting") return "warning";
          if (state === "unread") return "done";
          if (state === "followup") return "warning";
          return "idle";
        }

        /** The running spinner, drawn as the host draws it: track + arc, both circling. */
        function pinSpinner() {
          if (typeof document === "undefined" || typeof document.createElementNS !== "function") return null;
          try {
            var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("class", "wsr-pin-spin");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("width", "14");
            svg.setAttribute("height", "14");
            svg.setAttribute("aria-hidden", "true");
            var track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            track.setAttribute("class", "wsr-pin-track");
            track.setAttribute("cx", "12");
            track.setAttribute("cy", "12");
            track.setAttribute("r", "9.5");
            var arc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            arc.setAttribute("class", "wsr-pin-arc");
            arc.setAttribute("cx", "12");
            arc.setAttribute("cy", "12");
            arc.setAttribute("r", "9.5");
            svg.appendChild(track);
            svg.appendChild(arc);
            return svg;
          } catch (error) {
            return null;
          }
        }

        /**
         * Repaint the leading marker of a pinned row.
         *
         * A grouped row gets this from the host (`SessionStatusDots`: spinner while
         * running, a dot when done). Pinned rows are the plugin's own DOM, so the
         * same shapes are drawn here; the paint is skipped when the state did not
         * change, so a running spinner is not re-created on every pass.
         */
        function paintPinState(row, state) {
          if (row === null || typeof row.querySelector !== "function") return;
          var slot = row.querySelector(".wsr-pin-slot");
          if (slot === null) return;
          var key = pinDotStateOf(state);
          if (slot.getAttribute("data-wsr-dot") === key) return;
          slot.setAttribute("data-wsr-dot", key);
          while (slot.firstChild !== undefined && slot.firstChild !== null) slot.removeChild(slot.firstChild);
          if (key === "ongoing") {
            slot.setAttribute("title", t("pin.status.running"));
            var spinner = pinSpinner();
            if (spinner !== null) slot.appendChild(spinner);
            return;
          }
          if (key === "idle") {
            slot.setAttribute("title", "");
            return;
          }
          var label = state === "waiting"
            ? t("pin.status.waiting")
            : state === "unread"
              ? t("pin.status.done")
              : t("pin.status.followup");
          var dot = document.createElement("span");
          dot.className = "wsr-pin-dot";
          dot.setAttribute("data-state", key);
          dot.setAttribute("role", "img");
          dot.setAttribute("aria-label", label);
          dot.setAttribute("title", label);
          slot.appendChild(dot);
        }

        function pinnedRowElement(item, state) {
          var row = document.createElement("div");
          row.className = "wsr-pin-row";
          row.setAttribute("data-row-key", "pin:" + item.id);
          setRowState(row, state === undefined ? null : state);
          var slot = document.createElement("span");
          slot.className = "wsr-pin-slot";
          row.appendChild(slot);
          paintPinState(row, state === undefined ? null : state);
          var title = document.createElement("span");
          title.className = "wsr-pin-title";
          title.textContent = item.title;
          title.setAttribute("title", item.title);
          row.appendChild(title);
          if (item.where !== "") {
            var where = document.createElement("span");
            where.className = "wsr-pin-ws";
            where.textContent = item.where;
            row.appendChild(where);
          }
          var unpin = document.createElement("button");
          unpin.type = "button";
          unpin.className = "wsr-pin-unpin";
          unpin.textContent = t("pin.unpin");
          unpin.addEventListener("click", function (event) {
            if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
            unpinSession(item.id);
            schedule();
          });
          row.appendChild(unpin);
          row.addEventListener("click", function () {
            openSessionRow(item.id);
          });
          return row;
        }

        /** Hide the copies inside their own groups so nothing is listed twice. */
        function hideOriginalRows(entries, pinnedIds) {
          for (var i = 0; i < entries.length; i += 1) {
            var rows = rowElements(entries[i].section);
            for (var j = 0; j < rows.length; j += 1) {
              var id = sessionIdOf(rows[j]);
              if (id !== null && pinnedIds.has(id)) {
                if (rows[j].getAttribute(PIN_HIDDEN_ATTR) !== "true") rows[j].setAttribute(PIN_HIDDEN_ATTR, "true");
                pinHidden.add(rows[j]);
              } else if (rows[j].getAttribute(PIN_HIDDEN_ATTR) !== null) {
                rows[j].removeAttribute(PIN_HIDDEN_ATTR);
                pinHidden.delete(rows[j]);
              }
            }
          }
        }

        /** One session's running / unread / follow-up state, or null. */
        function statesOfId(states, id) {
          if (states === null || states === undefined || id === null || id === undefined || id === "") return null;
          var state = states[id];
          return state === undefined ? null : state;
        }

        /**
         * Push the current state onto the pin rows already in the DOM.
         *
         * The section is rebuilt only when the pinned set or its labels change, so
         * a session that starts running has to be recoloured in place - otherwise
         * its row would keep the state it had when the section was last built.
         */
        function applyPinStates(host, states) {
          if (host === null || typeof host.querySelectorAll !== "function") return;
          var rows = host.querySelectorAll('[data-row-key^="pin:"]');
          for (var i = 0; i < rows.length; i += 1) {
            var key = rows[i].getAttribute("data-row-key");
            var id = key === null ? "" : key.slice("pin:".length);
            var state = statesOfId(states, id);
            setRowState(rows[i], state);
            paintPinState(rows[i], state);
          }
        }

        /**
         * Render the "pinned" section above every workspace group.
         *
         * It is a plain element inserted as the first child of the list container
         * (flex order -1), rebuilt only when the pinned set or its labels change. The
         * host keeps owning the list; the workspace grouping below is untouched.
         */
        function renderPinned(entries, sessions, workspaces, settings, states) {
          if (typeof document === "undefined") return;
          var items = pinnedItemsOf(sessions, workspaces, settings);

          if (items.length === 0) {
            if (pinHost !== null) {
              pinHost.remove();
              pinHost = null;
            }
            hideOriginalRows(entries, new Set());
            return;
          }
          if (entries.length === 0) return;
          var container = entries[0].section.parentElement;
          if (container === null) return;

          if (pinHost === null || pinHost.parentElement !== container) {
            var existing = container.querySelector("[" + PIN_ATTR + '="true"]');
            if (existing !== null) existing.remove();
            pinHost = document.createElement("div");
            pinHost.className = "wsr-pin";
            pinHost.setAttribute(PIN_ATTR, "true");
            pinHost.style.order = "-1";
            if (typeof container.insertBefore === "function" && container.firstChild !== undefined && container.firstChild !== null) {
              container.insertBefore(pinHost, container.firstChild);
            } else {
              container.appendChild(pinHost);
            }
          }
          pinHost.style.order = "-1";

          var signature = items.map(function (item) { return item.id + "\u0000" + item.title + "\u0000" + item.where; }).join("\u0001");
          if (pinHost.dataset.wsrSignature !== signature) {
            pinHost.dataset.wsrSignature = signature;
            while (pinHost.firstChild !== undefined && pinHost.firstChild !== null) pinHost.removeChild(pinHost.firstChild);
            var head = document.createElement("div");
            head.className = "wsr-pin-head";
            head.textContent = t("pin.head");
            pinHost.appendChild(head);
            for (var i = 0; i < items.length; i += 1) pinHost.appendChild(pinnedRowElement(items[i], statesOfId(states, items[i].id)));
          }
          /* The state can change while the pinned set stays the same. */
          applyPinStates(pinHost, states);
          var pinnedIds = new Set(items.map(function (item) { return item.id; }));
          hideOriginalRows(entries, pinnedIds);
        }

        function statusOf(statuses, id) {
          if (statuses === null || statuses === undefined) return null;
          if (typeof statuses.get === "function") return statuses.get(id) || null;
          return statuses[id] || null;
        }

        /**
         * Color one rendered row. The state lives on the row element only: the
         * follow-up dot is NOT injected here. A row is a flex/grid layout the host
         * owns, and an extra child shifted every following row down by one, so the
         * dot is rendered through the host's own `sidebar.session.row.leading`
         * slot instead (see FollowUpDot).
         */
        function setRowState(row, state) {
          if (state === null || state === undefined) {
            if (row.getAttribute(STATE_ATTR) !== null) row.removeAttribute(STATE_ATTR);
            return;
          }
          if (row.getAttribute(STATE_ATTR) !== state) row.setAttribute(STATE_ATTR, state);
        }

        /**
         * Color the rows: running (blue), finished-unopened (green), and the manual
         * "needs follow-up" flag (amber). The flag is the user's own judgement - it
         * is never inferred, and only an explicit clear removes it. Running and
         * unread outrank it on screen; once they pass, amber comes back.
         */
        /**
         * running / unread / follow-up per session id.
         *
         * Both the host's rows and the plugin's own pinned rows read this, so a
         * pinned session keeps the same colour it had inside its group.
         */
        function statesOf(sessions, statuses, settings) {
          var flags = settings.followUps;
          var byId = sessions.byId || {};
          var states = {};

          for (var id in byId) {
            if (!Object.prototype.hasOwnProperty.call(byId, id)) continue;
            var session = byId[id];
            if (session === null || session === undefined) continue;
            if (session.blank === true || session.origin === "subagent") continue;
            var status = statusOf(statuses, id);
            var running = status !== null ? status.running === true : session.running === true;
            var unread = status !== null ? status.completionUnread === true : session.completed === true;
            /* The mark is the user's own judgement and survives everything except
               an explicit clear: running / unread only outrank it on screen, and
               once those pass it comes back. It is never dropped just because the
               conversation moved on - continuing a conversation is often the very
               reason a follow-up is still owed. */
            var flagged = flags[id] !== undefined;
            /* Waiting on the user outranks everything the host itself reports:
               an approval, a plan review or a question is what the row is for now. */
            var pending = status !== null && status.pendingInteraction !== null && status.pendingInteraction !== undefined
              ? status.pendingInteraction.kind
              : undefined;
            var waiting = pending === "approval" || pending === "plan-review" || pending === "question";
            states[id] = waiting ? "waiting" : running ? "running" : unread ? "unread" : flagged ? "followup" : null;
          }
          return states;
        }

        function decorateRows(entries, states) {
          for (var i = 0; i < entries.length; i += 1) {
            var rows = rowElements(entries[i].section);
            for (var j = 0; j < rows.length; j += 1) {
              var row = rows[j];
              var sessionId = sessionIdOf(row);
              setRowState(row, sessionId === null ? null : states[sessionId] || null);
            }
          }
        }

        /** The session the conversation view is showing, from its own DOM hook. */
        function currentConversationId() {
          if (typeof document === "undefined") return null;
          var element = document.querySelector("[data-conversation-session]");
          if (element === null || typeof element.getAttribute !== "function") return null;
          var id = element.getAttribute("data-conversation-session");
          return typeof id === "string" && id !== "" ? id : null;
        }

        /**
         * The highest turn number currently rendered in the conversation.
         *
         * The handoff card lives in the `turnTail` slot, which renders once per
         * turn; without this the card would appear under every reply. A running
         * handoff may only speak from the tail of the turn it just started.
         */
        function latestTurnNumber() {
          if (typeof document === "undefined") return null;
          var body = null;
          try { body = document.querySelector("[data-conversation-content]"); } catch (error) { body = null; }
          var elements;
          try {
            elements = body !== null && body !== undefined && typeof body.querySelectorAll === "function"
              ? body.querySelectorAll("[data-turn-tail]")
              : (typeof document.querySelectorAll === "function" ? document.querySelectorAll("[data-turn-tail]") : []);
          } catch (error) {
            return null;
          }
          var max = null;
          for (var i = 0; i < elements.length; i += 1) {
            var value = Number(elements[i].getAttribute("data-turn-tail"));
            if (!isFinite(value)) continue;
            if (max === null || value > max) max = value;
          }
          return max;
        }

        /** The nearest horizontal flex row above the stats: the whole footer dock. */
        function composerDockOf(row) {
          var node = row;
          for (var depth = 0; depth < 4; depth += 1) {
            var parent = node.parentElement;
            if (parent === null) break;
            var style = null;
            try {
              style = typeof window !== "undefined" && typeof window.getComputedStyle === "function"
                ? window.getComputedStyle(parent)
                : null;
            } catch (error) {
              style = null;
            }
            if (style !== null && style.display === "flex" && (style.flexDirection === "row" || style.flexDirection === "")) return parent;
            node = parent;
          }
          return row.parentElement === null ? row : row.parentElement;
        }

        /** The host's own pill in that row, used as the visual template. */
        function pillTemplateOf(row) {
          if (typeof row.querySelector !== "function") return null;
          var button = row.querySelector('button[class*="_pill"]');
          return button !== null ? button : row.querySelector('[class*="_pill"]');
        }

        function cloneIconOf(template) {
          if (template === null || typeof template.querySelector !== "function") return null;
          var icon = template.querySelector("svg");
          if (icon === null || typeof icon.cloneNode !== "function") return null;
          try { return icon.cloneNode(true); } catch (error) { return null; }
        }

        /** Copy the host pill's own computed metrics onto the clone. */
        function copyPillMetrics(template, wrapper, button) {
          if (template === null || template === undefined || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return;
          var read = function (name) {
            try {
              return window.getComputedStyle(template).getPropertyValue(name) || "";
            } catch (error) {
              return "";
            }
          };
          var inherited = ["font-size", "font-family", "font-weight", "line-height", "letter-spacing"];
          for (var i = 0; i < inherited.length; i += 1) {
            var value = read(inherited[i]);
            if (value !== "") {
              wrapper.style[inherited[i]] = value;
              button.style[inherited[i]] = value;
            }
          }
          var own = ["padding", "gap", "border-radius", "color"];
          for (var j = 0; j < own.length; j += 1) {
            var metric = read(own[j]);
            if (metric !== "") button.style[own[j]] = metric;
          }
        }

        /**
         * Add one pill at the END of the composer footer that opens the analysis
         * panel for the conversation on screen.
         *
         * It reuses the host pill's own class names and icon so it reads as part of
         * the same row, sits after the context ring rather than between the stats,
         * is re-attached whenever the host re-renders, and disappears with the row.
         */
        function decorateComposerStats() {
          if (typeof document === "undefined") return;
          /* Switch off: take the pill away rather than leave a dead one. */
          if (!featureOn(data.settings, "stats")) {
            var stale = document.querySelector("[data-wsr-composer-analysis]");
            if (stale !== null && typeof stale.remove === "function") stale.remove();
            return;
          }
          var existing = document.querySelector("[data-wsr-composer-analysis]");
          var seat = document.querySelector("[data-composer-seat]");
          var anchors = seat === null || typeof seat.querySelectorAll !== "function" ? [] : seat.querySelectorAll("[data-composer-stat]");
          if (anchors.length === 0 || currentConversationId() === null) {
            if (existing !== null) existing.remove();
            composerPill = null;
            return;
          }
          var row = anchors[0].parentElement;
          if (row === null) return;
          var dock = composerDockOf(row);

          if (existing === null) {
            var template = pillTemplateOf(row);
            /* Wrapped exactly like a host pill (its anchor span) and carrying the
               host's own computed metrics: appended to the footer dock rather than
               into the stats row, this pill would otherwise inherit the dock's font
               size and read larger than its neighbours. */
            var wrapper = document.createElement("span");
            wrapper.setAttribute("data-wsr-composer-analysis", "true");
            var anchorTemplate = template === null ? null : template.parentElement;
            var anchorClass = anchorTemplate !== null && typeof anchorTemplate.className === "string" ? anchorTemplate.className : "";
            if (anchorClass !== "") wrapper.className = anchorClass;
            var button = document.createElement("button");
            button.type = "button";
            var base = template !== null && typeof template.className === "string" ? template.className : "";
            button.className = base === "" ? "wsr-pill" : base + " wsr-pill";
            var icon = cloneIconOf(template);
            if (icon !== null) button.appendChild(icon);
            var label = document.createElement("span");
            var labelTemplate = template === null || typeof template.querySelector !== "function" ? null : template.querySelector('[class*="_label"]');
            label.className = labelTemplate !== null && typeof labelTemplate.className === "string" && labelTemplate.className !== ""
              ? labelTemplate.className
              : "wsr-pill-label";
            label.textContent = t("composer.analysis");
            button.appendChild(label);
            button.addEventListener("click", function () {
              var id = currentConversationId();
              if (id !== null) openStatsPanel(id);
            });
            copyPillMetrics(template, wrapper, button);
            wrapper.appendChild(button);
            composerPill = wrapper;
          } else {
            composerPill = existing;
          }
          var children = dock.children || [];
          if (composerPill.parentElement !== dock || children[children.length - 1] !== composerPill) {
            dock.appendChild(composerPill);
          }
        }

        function apply() {
          if (disposed) return;
          var sessions = data.sessions;
          var workspaces = data.workspaces;
          var settings = settingsOf();
          if (!ready(sessions) || !ready(workspaces)) {
            decorateComposerStats();
            return;
          }

          var entries = collect();
          if (entries.length === 0) {
            decorateComposerStats();
            return;
          }

          orderGroups(entries, latestByWorkspace(sessions, workspaces));
          foldRows(entries, settings, sessions, Date.now());
          var states = settings.colors ? statesOf(sessions, data.statuses, settings) : null;
          renderPinned(entries, sessions, workspaces, settings, states);
          if (states !== null) decorateRows(entries, states);
          decorateComposerStats();
        }

        /**
         * While this is in the future the sidebar pass stays off.
         *
         * Jumping to a hit in a long session makes the host mount a whole page of
         * history. That is thousands of DOM changes, and each one used to run this
         * plugin's sidebar pass on top of the host's own rendering, which is what
         * still froze the window even after chat mutations were filtered out.
         */
        var suppressedUntil = 0;

        function suspendPasses(ms) {
          var span = typeof ms === "number" && ms > 0 ? ms : 8000;
          suppressedUntil = Date.now() + span;
        }

        function passesSuspended() {
          return suppressedUntil !== 0 && Date.now() < suppressedUntil;
        }
        /** At most this often, whatever happens: a pass writes DOM, and writing DOM
         * can be observed by our own observer, so the interval is the guarantee that
         * a feedback loop cannot turn into a busy main thread. */
        var PASS_MIN_GAP = 400;
        var lastPassAt = 0;

        function schedule() {
          if (disposed || timer !== null) return;
          /* The interval keeps calling us; a switched-off half must not paint. */
          if (!featureOn(data.settings, "sidebar")) {
            unpaintSidebar();
            return;
          }
          sidebarAncestors = null;
          if (passesSuspended()) {
            /* One pass, once the host has finished mounting. */
            var wait = Math.max(120, suppressedUntil - Date.now() + 60);
            window.setTimeout(function () {
              if (!disposed) schedule();
            }, wait);
            return;
          }
          var since = Date.now() - lastPassAt;
          var delay = since >= PASS_MIN_GAP ? 60 : PASS_MIN_GAP - since + 16;
          timer = window.setTimeout(function () {
            timer = null;
            lastPassAt = Date.now();
            var began = Date.now();
            try {
              apply();
            } catch (error) {
              console.warn("[dsh-ws-recency] pass failed:", error);
            }
          }, delay);
        }
        /** `shell.overlay` occupant; it renders no chrome of its own. */
        /** Remove every mark this plugin paints on the sidebar rows. */
        function unpaintSidebar() {
          if (typeof document === "undefined") return;
          try {
            var pinned = document.querySelectorAll('[data-wsr-pin="true"]');
            for (var k = 0; k < pinned.length; k += 1) pinned[k].remove();
            pinHost = null;
            var painted = document.querySelectorAll("[data-wsr-rank],[data-wsr-dot],[data-wsr-state],[data-wsr-pin-hidden]");
            for (var i = 0; i < painted.length; i += 1) {
              painted[i].removeAttribute("data-wsr-rank");
              painted[i].removeAttribute("data-wsr-dot");
              painted[i].removeAttribute("data-wsr-state");
              painted[i].removeAttribute("data-wsr-pin-hidden");
              painted[i].style.removeProperty("order");
            }
            var hidden = document.querySelectorAll(".wsr-hidden");
            for (var j = 0; j < hidden.length; j += 1) hidden[j].classList.remove("wsr-hidden");
          } catch (error) {
            /* a half-painted list is not worth a crash */
          }
        }

        function Sorter(props) {
          if (typeof props.useSessions === "function") {
            data.sessions = props.useSessions(function (state) { return state; });
          }
          if (typeof props.useWorkspaces === "function") {
            data.workspaces = props.useWorkspaces(function (state) { return state; });
          }
          if (typeof props.useSessionStatus === "function") {
            data.statuses = props.useSessionStatus(function (state) { return state; });
          }
          if (typeof props.useStore === "function") {
            data.settings = props.useStore(function (state) { return state; });
          }
          if (props.actions !== undefined && props.actions !== null) data.actions = props.actions;
          if (typeof props.t === "function") data.t = props.t;
          /* With the sidebar half off, drop our paint and stop the timer. */
          var sidebarOn = featureOn(data.settings, "sidebar");
          react.useEffect(function () {
            if (sidebarOn) {
              schedule();
              return;
            }
            unpaintSidebar();
          });
          return null;
        }

        /** Session "..." menu row: mark / unmark this conversation as needing follow-up. */
        function FollowUpMenuItem(props) {
          var flags = props.useStore(function (state) { return state.followUps; }) || {};
          var flagged = flags[props.sessionId] !== undefined;
          var Item = ui.MenuItemButton;
          if (typeof Item !== "function") return null;
          /* Every shipped row in this menu carries an icon; without one the text
             column starts where the others start after their icon, so the row
             would look shifted. The checklist mark reads as "still to do". */
          var Icon = flagged ? ui.IconCheckOutlineRegular : ui.IconChecklistOutlineRegular;
          return h(Item, {
            icon: typeof Icon === "function" ? h(Icon, {}) : undefined,
            onSelect: function () { props.actions.toggleFollowUp(props.sessionId); },
          }, t(flagged ? "menu.unflag" : "menu.flag"));
        }

        /**
         * The host's leading slot for one row: the amber dot of a follow-up mark.
         *
         * Rendering here (instead of injecting a child into the row) is what keeps
         * the list's own layout intact - the host reserves this slot, so a dot in it
         * costs no space and cannot push the following rows down.
         */
        function FollowUpDot(props) {
          var flags = props.useStore(function (state) { return state.followUps; }) || {};
          if (flags[props.sessionId] === undefined) return null;
          return h("span", {
            className: DOT_TOKEN,
            role: "img",
            "aria-label": "needs follow-up",
            title: "needs follow-up",
            onClick: function (event) {
              if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
              props.actions.clearFollowUp(props.sessionId);
            },
          });
        }

        
        /* ------------------------- token statistics ------------------------- */

        var statsModal = null;
        /** Which stats tab stays selected across openings. */
        var statsTab = "distribution";

        function formatTokens(value) {
          var n = Number(value) || 0;
          if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
          if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
          if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
          return String(Math.round(n));
        }

        function formatShare(share) {
          if (typeof share !== "number" || !Number.isFinite(share)) return "-";
          return (share * 100).toFixed(1) + "%";
        }

        function closeStatsPanel() {
          /* A confirmation may sit on top of the panel it was opened from. */
          closeConfirm(null);
          if (statsModal !== null) {
            if (typeof statsModal.remove === "function") statsModal.remove();
            statsModal = null;
          }
          if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("keydown", onStatsKey);
          }
        }

        function onStatsKey(event) {
          if (event !== undefined && event.key === "Escape") closeStatsPanel();
        }

        function statsDiv(className, text) {
          var node = document.createElement("div");
          node.className = className;
          if (text !== undefined) node.textContent = text;
          return node;
        }

        /* --------------------------- in-app dialogs ------------------------- *
         * `window.confirm` / `window.alert` are native dialogs. On Windows the
         * renderer comes back from one without keyboard focus: clicking the
         * composer does nothing, switching sessions does not help, and only
         * leaving the app and coming back fixes it. These stay in the page and
         * never take the window's focus away.
         * ------------------------------------------------------------------- */

        /** What the sidebar bound at startup, so the page can say "restart to apply". */
        var panelBoot = null;

        /** The stored switches, read before the store instance exists. */
        function readStoredFeatures() {
          if (typeof localStorage === "undefined") return null;
          try {
            var raw = localStorage.getItem("dsh.ws-recency.prefs.v1");
            if (raw === null || raw === undefined) {
              /* A scoped key carries a suffix; find it by prefix. */
              for (var i = 0; i < localStorage.length; i += 1) {
                var key = localStorage.key(i);
                if (typeof key === "string" && key.indexOf("dsh.ws-recency.prefs.v1") === 0) {
                  raw = localStorage.getItem(key);
                  break;
                }
              }
            }
            if (raw === null || raw === undefined) return null;
            var parsed = JSON.parse(raw);
            var bag = parsed !== null && parsed !== undefined ? parsed.features : null;
            return bag !== null && bag !== undefined && typeof bag === "object" ? bag : null;
          } catch (error) {
            return null;
          }
        }

        var confirmBackdrop = null;
        var confirmPrevious = null;
        var confirmKey = null;

        /** Close the current dialog; `onConfirm` runs only for an accept. */
        function closeConfirm(onConfirm) {
          var backdrop = confirmBackdrop;
          confirmBackdrop = null;
          if (backdrop !== null && typeof backdrop.remove === "function") backdrop.remove();
          if (typeof document !== "undefined" && confirmKey !== null && typeof document.removeEventListener === "function") {
            document.removeEventListener("keydown", confirmKey);
          }
          confirmKey = null;
          var previous = confirmPrevious;
          confirmPrevious = null;
          if (previous !== null && previous !== undefined && previous.isConnected !== false && typeof previous.focus === "function") {
            try { previous.focus(); } catch (error) { /* the element may be gone */ }
          }
          if (typeof onConfirm === "function") onConfirm();
        }

        /**
         * Ask before acting, in the page.
         *
         * @param question - message shown in the dialog.
         * @param onConfirm - runs when the user accepts; omitted for a notice.
         * @param notice - render a single acknowledge button.
         */
        function askConfirm(question, onConfirm, notice) {
          if (typeof document === "undefined") return;
          closeConfirm();
          var isNotice = notice === true;
          confirmPrevious = typeof document.activeElement !== "undefined" ? document.activeElement : null;

          var backdrop = statsDiv("wsr-modal-backdrop");
          backdrop.setAttribute("data-wsr-confirm", isNotice ? "notice" : "confirm");
          var panel = statsDiv("wsr-confirm");
          panel.setAttribute("role", "dialog");
          panel.setAttribute("aria-modal", "true");
          panel.setAttribute("tabindex", "-1");
          panel.appendChild(statsDiv("wsr-confirm-text", question));

          var actions = statsDiv("wsr-confirm-actions");
          var cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "wsr-qcancel";
          cancel.textContent = t("confirm.cancel");
          cancel.addEventListener("click", function (event) {
            if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
            closeConfirm(null);
          });
          var accept = document.createElement("button");
          accept.type = "button";
          accept.className = "wsr-qsubmit";
          accept.setAttribute("data-wsr-confirm-ok", "true");
          accept.textContent = t("confirm.ok");
          accept.addEventListener("click", function (event) {
            if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
            closeConfirm(isNotice ? null : onConfirm);
          });
          if (!isNotice) actions.appendChild(cancel);
          actions.appendChild(accept);
          panel.appendChild(actions);

          panel.addEventListener("click", function (event) {
            if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
          });
          backdrop.addEventListener("click", function (event) {
            if (event === undefined || event.target === backdrop) closeConfirm(null);
          });
          backdrop.appendChild(panel);
          document.body.appendChild(backdrop);
          confirmBackdrop = backdrop;

          confirmKey = function (event) {
            if (event === undefined) return;
            if (event.key === "Escape") {
              if (typeof event.preventDefault === "function") event.preventDefault();
              closeConfirm(null);
              return;
            }
            if (event.key === "Enter" && !isNotice) {
              if (typeof event.preventDefault === "function") event.preventDefault();
              closeConfirm(onConfirm);
            }
            if (event.key === "Enter" && isNotice) {
              if (typeof event.preventDefault === "function") event.preventDefault();
              closeConfirm(null);
            }
          };
          if (typeof document.addEventListener === "function") document.addEventListener("keydown", confirmKey);
          try { accept.focus(); } catch (error) { /* focus is best effort */ }
        }

        /** A one-button notice, used when a request fails. */
        function askNotice(message) {
          askConfirm(message, null, true);
        }

        /** One table row: source, calls, argument tokens, result tokens, total, share. */
        function statsRow(label, calls, args, results, total, share, dimArgs) {
          var row = document.createElement("div");
          row.className = "wsr-stats-row";
          var name = statsDiv("wsr-td wsr-td-name", label);
          row.appendChild(name);
          row.appendChild(statsDiv("wsr-td", calls === null ? "-" : String(calls)));
          /* In "arguments belong to the agent" mode the cell stays readable but
             fades: those tokens are no longer part of this tool's total. */
          row.appendChild(statsDiv(dimArgs === true ? "wsr-td wsr-td-dim" : "wsr-td", args === null ? "-" : formatTokens(args)));
          row.appendChild(statsDiv("wsr-td", results === null ? "-" : formatTokens(results)));
          row.appendChild(statsDiv("wsr-td wsr-td-strong", formatTokens(total)));
          row.appendChild(statsDiv("wsr-td", formatShare(share)));
          return row;
        }

        /**
         * Where a tool's argument tokens are counted.
         *
         * A tool's arguments are what the model wrote (a shell command, a file
         * body), so they arguably belong to the agent rather than to the tool. The
         * default keeps the historical per-tool total; "agent" moves the argument
         * tokens onto the agent's bar and leaves each tool its results.
         */
        function argModeOf() {
          var fromRenderer = data.settings !== null && data.settings !== undefined ? data.settings.argMode : undefined;
          if (fromRenderer === "agent" || fromRenderer === "tool") return fromRenderer;
          try {
            var store = prefsStore;
            var snapshot = store !== null && store !== undefined && typeof store.getSnapshot === "function" ? store.getSnapshot() : null;
            if (snapshot !== null && snapshot !== undefined && (snapshot.argMode === "agent" || snapshot.argMode === "tool")) return snapshot.argMode;
          } catch (error) {
            /* the store is not readable here */
          }
          return "tool";
        }

        /** A thin legend for the two-tone bar: arguments vs results. */
        function chartLegend() {
          var legend = statsDiv("wsr-chart-legend");
          var pairs = [["stats.legend.args", "wsr-chart-swatch wsr-chart-swatch-dim"], ["stats.legend.results", "wsr-chart-swatch"]];
          for (var i = 0; i < pairs.length; i += 1) {
            var item = statsDiv("wsr-chart-legend-item");
            item.appendChild(statsDiv(pairs[i][1]));
            var text = statsDiv("wsr-chart-legend-text");
            text.textContent = t(pairs[i][0]);
            item.appendChild(text);
            legend.appendChild(item);
          }
          return legend;
        }

        /**
         * One bar. The coloured group is the source's own total against the largest
         * source; inside a tool's group the faded segment is its argument tokens.
         */
        function chartBar(entry, largest) {
          var line = statsDiv("wsr-chart-row");
          var labelCell = statsDiv("wsr-chart-label", entry.name);
          /* The colour now means a family, so the name cell says which one: a
             colour without a caption is a riddle, not an encoding. It lives in
             the name cell so the five-column grid stays intact. */
          if (typeof entry.family === "string" && entry.family !== "") {
            labelCell.appendChild(statsDiv("wsr-chart-family", t("stats.family." + entry.family)));
          }
          line.appendChild(labelCell);
          var track = statsDiv("wsr-chart-track");
          var group = statsDiv("wsr-chart-group");
          var width = largest > 0 ? (entry.value / largest) * 100 : 0;
          group.style.width = width.toFixed(2) + "%";
          /* No background on the group: the two segments paint themselves, and a
             same-hue group behind a translucent argument segment would hide the
             split entirely. */
          var argsPart = entry.split === true && entry.value > 0 ? (entry.args / entry.value) * 100 : 0;
          if (argsPart > 0) {
            var argsSeg = statsDiv("wsr-chart-fill wsr-bar-args");
            argsSeg.style.width = argsPart.toFixed(2) + "%";
            argsSeg.style.background = sourceColorDim(entry.hue);
            group.appendChild(argsSeg);
          }
          var resultsSeg = statsDiv("wsr-chart-fill wsr-bar-results");
          resultsSeg.style.width = (100 - argsPart).toFixed(2) + "%";
          resultsSeg.style.background = sourceColor(entry.hue);
          group.appendChild(resultsSeg);
          /* What the two shades mean, on the thing that has them: the legend is
             a row away and reads like a second chart header. */
          if (argsPart > 0) {
            group.setAttribute("title", t("stats.barTooltip", {
              name: entry.name,
              total: formatTokens(entry.value),
              args: formatTokens(entry.args || 0),
              argsShare: formatShare((entry.value > 0 ? (entry.args || 0) / entry.value : 0)),
              results: formatTokens(entry.results || 0),
              resultsShare: formatShare((entry.value > 0 ? (entry.results || 0) / entry.value : 0)),
            }));
          }
          track.appendChild(group);
          line.appendChild(track);
          var valueCell = statsDiv("wsr-chart-value", formatTokens(entry.value));
          valueCell.setAttribute("title", String(Math.round(entry.value)) + " tokens");
          line.appendChild(valueCell);
          line.appendChild(statsDiv("wsr-chart-share", formatShare(entry.share)));          /* The count the chart cannot draw: a bar says how heavy a source is,
             the call count says how often it got there. The details table used to
             be the only place for it. It always renders (empty for rows without
             a count) so the five-column grid stays aligned. */
          line.appendChild(statsDiv(
            "wsr-chart-calls",
            typeof entry.calls === "number" && entry.calls > 0 ? t("stats.callsShort", { n: String(entry.calls) }) : "",
          ));
          return line;
        }

        /**
         * Colour identity for a source, by tool family.
         *
         * The colour answers one question - what kind of work is this - so the
         * hue is the family, not the tool: five named families with a fixed
         * vividness, and unknown tools fall back to the same neutral instead of a
         * hash. Ranking no longer modulates anything: a faded tail colour told the
         * reader nothing they could act on.
         */
        var TOOL_FAMILIES = [
          { key: "shell", hue: 32, tools: ["pwsh", "powershell", "shell", "bash", "command", "cmd", "run_code"], prefixes: [] },
          { key: "files", hue: 152, tools: ["read", "write", "edit", "grep", "glob", "str_replace_editor", "ls", "delete", "move_file"], prefixes: ["univer_"] },
          { key: "web", hue: 205, tools: ["web_fetch", "web_search", "platform_search", "multi_search", "advanced_search", "domain_search", "video_search", "browser_"], prefixes: ["browser_"] },
          { key: "agents", hue: 268, tools: ["subagent", "subagent_fork", "workflow", "spawn_teammate", "send_message", "wait_agent", "task"], prefixes: ["team_"] },
          { key: "misc", hue: 330, tools: ["todo_write", "todo_read", "todo", "job_output", "job_list", "job_kill", "skill", "create_goal", "update_goal", "ask_user_question", "present", "weknora_"], prefixes: ["job_", "weknora_", "mcp__"] },
        ];
        /** The neutral an unknown tool gets: no family, no claim of one. */
        var TOOL_FAMILY_NEUTRAL = { key: "other", hue: 210 };

        /**
         * A stable hue for a tool that belongs to no family.
         *
         * Every unknown tool used to share the neutral hue, so the chart showed
         * several tools in one colour. A hash of the name spreads them out, and a
         * nudge keeps the result clear of the family hues it would otherwise
         * collide with.
         */
        function hueOfUnknown(name) {
          var hash = 2166136261;
          for (var i = 0; i < name.length; i += 1) {
            hash ^= name.charCodeAt(i);
            hash = Math.imul(hash, 16777619) >>> 0;
          }
          var hue = hash % 360;
          for (var f = 0; f < TOOL_FAMILIES.length; f += 1) {
            var distance = Math.abs(hue - TOOL_FAMILIES[f].hue);
            if (distance < 16 || distance > 344) hue = (hue + 41) % 360;
          }
          return hue;
        }

        function toolFamily(name) {
          if (typeof name !== "string" || name === "") return TOOL_FAMILY_NEUTRAL;
          var key = name.toLowerCase();
          for (var i = 0; i < TOOL_FAMILIES.length; i += 1) {
            var family = TOOL_FAMILIES[i];
            if (family.tools.indexOf(key) !== -1) return family;
            for (var p = 0; p < family.prefixes.length; p += 1) {
              if (key.indexOf(family.prefixes[p]) === 0) return family;
            }
          }
          return TOOL_FAMILY_NEUTRAL;
        }

        function sourceHue(name) {
          return toolFamily(name).hue;
        }

        /** The hue of a family key, for the legend swatches. */
        function hueOfFamily(key) {
          for (var i = 0; i < TOOL_FAMILIES.length; i += 1) if (TOOL_FAMILIES[i].key === key) return TOOL_FAMILIES[i].hue;
          return TOOL_FAMILY_NEUTRAL.hue;
        }

        /** One vividness for every family bar: colour means "which family", not "how big". */
        function sourceColor(hue) {
          return "hsl(" + hue + ", 72%, 58%)";
        }

        /**
         * The same hue, lifted and softened: the argument segment of a tool's bar.
         *
         * It has to be a real colour rather than an opacity: the segment sits on a
         * solid bar of the same hue, so a translucent copy of it would composite
         * back to exactly the same colour and the split would be invisible. The
         * gap between the two is deliberately wide - a 20-point lightness step read
         * as one smudged bar in the reported panel.
         */
        function sourceColorDim(hue) {
          return "hsl(" + hue + ", 32%, 84%)";
        }

        var AMPLIFIED_KIND = {
          results: ["stats.amplified.results", "#4f8ef7"],
          args: ["stats.amplified.args", "#8fa3c8"],
          agent: ["stats.amplified.agent", "#7a6cff"],
          user: ["stats.amplified.user", "#6fbf73"],
          system: ["stats.amplified.system", "#c9a227"],
        };

        /**
         * The bill's shape, then its amplified ranking.
         *
         * A step's token count is just "context at that moment", which is nearly
         * the same on every step; the number that explains the bill is a content
         * block's tokens times the number of later steps that re-read it. The
         * host half computes that attribution; this only draws it.
         */
        /** Chart/list pairs whose jump markers highlight together on hover. */
        var jumpHoverHosts = [];
        /** Document-level listener for jump hover; registered once per panel open. */
        var jumpHoverBound = false;

        /**
         * Highlight one jump: the bar, its dot and the row that spells it out.
         *
         * Both the chart and the list live under the same section, so the pairing
         * is by `data-wsr-jump*` attributes rather than by DOM position (the chart
         * is downsampled and a bar may cover several steps).
         */
        function highlightJumpRow(event) {
          var target = event !== undefined && event.currentTarget !== undefined ? event.currentTarget : null;
          if (target === null || typeof target.getAttribute !== "function") return;
          var step = target.getAttribute("data-wsr-jump-hit");
          if (step === null) return;
          for (var i = 0; i < jumpHoverHosts.length; i += 1) {
            var host = jumpHoverHosts[i];
            if (host.chart === null || typeof host.chart.querySelectorAll !== "function") continue;
            var rows = host.chart.querySelectorAll("[data-wsr-jump-row]");
            for (var r = 0; r < rows.length; r += 1) {
              rows[r].className = "wsr-context-jump-row" + (rows[r].getAttribute("data-wsr-jump-row") === step ? " wsr-context-jump-row-hot" : "");
            }
            var hits = host.chart.querySelectorAll("[data-wsr-jump-hit]");
            for (var h = 0; h < hits.length; h += 1) {
              hits[h].className = "wsr-context-jump-hit" + (hits[h].getAttribute("data-wsr-jump-hit") === step ? " wsr-context-jump-hit-hot" : "");
            }
          }
        }

        function clearJumpHighlight() {
          for (var i = 0; i < jumpHoverHosts.length; i += 1) {
            var host = jumpHoverHosts[i];
            if (host.chart === null || typeof host.chart.querySelectorAll !== "function") continue;
            var rows = host.chart.querySelectorAll("[data-wsr-jump-row]");
            for (var r = 0; r < rows.length; r += 1) rows[r].className = "wsr-context-jump-row";
            var hits = host.chart.querySelectorAll("[data-wsr-jump-hit]");
            for (var h = 0; h < hits.length; h += 1) hits[h].className = "wsr-context-jump-hit";
          }
        }

        /**
         * A short "what entered" label for a jump row.
         *
         * The detail is often a full path or a whole command; the row has one
         * narrow cell. Keep the tool name and the last path segment, and let the
         * tooltip carry the rest.
         */
        function jumpWhatOf(name, detail) {
          if (typeof name !== "string" || name === "") return "";
          if (typeof detail !== "string" || detail === "") return name;
          var text = detail.trim();
          var cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
          if (cut !== -1 && cut < text.length - 1) text = text.slice(cut + 1);
          if (text.length > 22) text = text.slice(0, 21) + "…";
          return name + " " + text;
        }

        /**
         * The steepest rise in each compaction segment.
         *
         * A compaction rewrites the window, so a rise measured across that boundary
         * compares two different conversations: each segment has to be ranked on its
         * own. One marker per segment answers "where did this segment start growing",
         * and it keeps the chart readable when a session compacted several times.
         */
        function contextJumps(amplified) {
          var series = Array.isArray(amplified.series) ? amplified.series : [];
          var blocks = Array.isArray(amplified.blocks) ? amplified.blocks : [];
          var compactions = Array.isArray(amplified.compactions)
            ? amplified.compactions.map(Number).sort(function (a, b) { return a - b; })
            : [];
          var segmentOf = function (step) {
            var segment = 1;
            for (var c = 0; c < compactions.length; c += 1) if (step > compactions[c]) segment += 1;
            return segment;
          };
          /* Rises grouped per segment; the step that starts a new segment has no
             rise to compare against the step before the rewrite. */
          var bySegment = {};
          for (var i = 1; i < series.length; i += 1) {
            var from = Number(series[i - 1].step);
            var to = Number(series[i].step);
            if (segmentOf(from) !== segmentOf(to)) continue;
            var rise = Number(series[i].context) - Number(series[i - 1].context);
            if (rise <= 0) continue;
            var segment = segmentOf(to);
            if (bySegment[segment] === undefined) bySegment[segment] = [];
            /* `from` is the previous bar's step: on a downsampled curve one bar
               stands for several steps, and the content that entered during that
               span is what made it rise. The host labels each point with it. */
            bySegment[segment].push({ step: to, from: from, rise: rise, entered: series[i].entered || null });
          }
          var total = compactions.length + 1;
          var picked = [];
          /* Three markers per segment, not three for the whole session: after a
             rewrite the earlier segment cannot crowd out the later ones. The
             spacing only matters when many steps share one bar; on a short curve
             each bar is wide enough for neighbouring marks. */
          var spacing = Math.max(1, Math.round(series.length / 10));
          for (var s = 1; s <= total; s += 1) {
            var rises = bySegment[s];
            if (rises === undefined || rises.length === 0) continue;
            rises.sort(function (a, b) { return b.rise - a.rise; });
            var chosen = [];
            for (var r = 0; r < rises.length && chosen.length < 3; r += 1) {
              /* Two markers side by side read as one wide jump. */
              var close = false;
              for (var p = 0; p < chosen.length; p += 1) {
                if (Math.abs(chosen[p].step - rises[r].step) < spacing) close = true;
              }
              if (close) continue;
              chosen.push(rises[r]);
            }
            for (var k = 0; k < chosen.length; k += 1) {
              var best = chosen[k];
              /* The host labels each curve point with the biggest content block
                 that first appeared inside it. That is the honest attribution: a
                 bar spans several steps, so `entry === step` almost never holds,
                 and guessing "the most recent entrant" pointed at the system
                 prompt instead of the file that actually landed. */
              var block = null;
              var blockName = "";
              var blockDetail = "";
              var blockTokens = 0;
              if (best.entered !== null && best.entered !== undefined) {
                blockName = best.entered.kind === "tool" ? String(best.entered.name) : t("stats.agent");
                blockDetail = typeof best.entered.detail === "string" ? best.entered.detail : "";
                blockTokens = Number(best.entered.tokens) || 0;
              } else {
                /* An older host half sends no labels: fall back to the block that
                   entered inside this span, and never to an unrelated older one. */
                for (var b = 0; b < blocks.length; b += 1) {
                  var candidate = blocks[b];
                  var entry = Number(candidate.entry);
                  if (entry > best.step || entry <= best.from) continue;
                  if (block === null || Number(candidate.tokens) > Number(block.tokens)) block = candidate;
                }
                if (block !== null) {
                  blockName = block.kind === "tool" ? String(block.name) : t("stats.agent");
                  if (typeof block.detail === "string" && block.detail !== "") blockDetail = block.detail;
                  blockTokens = Number(block.tokens) || 0;
                }
              }
              var label = t("stats.amplified.jump", {
                step: String(best.step),
                rise: formatTokens(best.rise),
              });
              if (blockName !== "") {
                label += " " + t("stats.amplified.jumpFrom", {
                  name: blockDetail === "" ? blockName : blockName + " " + blockDetail,
                  tokens: formatTokens(blockTokens),
                });
              }
              picked.push({
                step: best.step,
                rise: best.rise,
                segment: s,
                /* Rank is within the segment; the row's segment number keeps two
                   "first" markers apart when a session compacted more than once. */
                rank: k + 1,
                blockName: blockName,
                blockDetail: blockDetail,
                label: label,
              });
            }
          }
          return picked;
        }

        function buildAmplified(stats) {
          var amplified = stats.amplified;
          if (amplified === null || amplified === undefined || !Array.isArray(amplified.series)) return null;
          var bill = Number(amplified.bill) || 0;
          var section = statsDiv("wsr-amplified");

          var head = statsDiv("wsr-amplified-head");
          head.appendChild(statsDiv("wsr-amplified-title", t("stats.amplified.title")));
          head.appendChild(statsDiv("wsr-amplified-summary", t("stats.amplified.summary", {
            bill: formatTokens(bill),
            share: formatShare(Number(amplified.share) || 0),
            attributed: formatTokens(amplified.attributed || 0),
          })));
          section.appendChild(head);

          var series = amplified.series;
          var largest = 1;
          for (var i = 0; i < series.length; i += 1) {
            if (Number(series[i].context) > largest) largest = Number(series[i].context);
          }
          var chart = statsDiv("wsr-context-chart");
          /* Mark the steepest step of every compaction segment: a single read of a
             large file shows up as one tall rise, and after a rewrite the window
             starts over, so each segment is read on its own. */
          var jumps = contextJumps(amplified);
          var jumpByStep = {};
          for (var jj = 0; jj < jumps.length; jj += 1) jumpByStep[jumps[jj].step] = jumps[jj];
          /* Where the window was rewritten: a faint divider makes the drop on the
             curve legible instead of looking like a glitch. */
          var breaks = {};
          var compactionAt = Array.isArray(amplified.compactions) ? amplified.compactions.map(Number) : [];
          for (var cb = 0; cb < compactionAt.length; cb += 1) breaks[compactionAt[cb]] = true;
          var openBreak = false;
          for (var j = 0; j < series.length; j += 1) {
            var bar = statsDiv("wsr-context-bar");
            bar.style.height = Math.max(2, Math.round((Number(series[j].context) / largest) * 100)) + "%";
            /* A compaction recorded at step N ends the segment at N: the first bar
               whose step is past it opens the next one. */
            var step = Number(series[j].step);
            var startsSegment = false;
            for (var cb2 = 0; cb2 < compactionAt.length; cb2 += 1) {
              if (step > compactionAt[cb2] && !openBreak) startsSegment = true;
            }
            if (startsSegment) {
              bar.className = "wsr-context-bar wsr-context-break";
              openBreak = true;
            }
            var jump = jumpByStep[step];
            if (jump !== undefined) {
              bar.className = "wsr-context-bar wsr-context-jump" + (startsSegment ? " wsr-context-break" : "");
              bar.setAttribute("data-wsr-jump", String(jump.step));
              bar.setAttribute("title", jump.label);
              /* A hover target that is big enough to hit: a 5px dot on a 3px bar
                 is unraisable without aiming, and the label lives in the row
                 below, so hovering the bar also lifts that row. */
              var hit = statsDiv("wsr-context-jump-hit");
              hit.setAttribute("data-wsr-jump-hit", String(jump.step));
              hit.setAttribute("data-wsr-rank", String(jump.rank));
              hit.appendChild(statsDiv("wsr-context-jump-dot"));
              hit.addEventListener("mouseenter", highlightJumpRow);
              hit.addEventListener("mouseleave", clearJumpHighlight);
              bar.appendChild(hit);
            } else {
              bar.setAttribute("title", t("stats.amplified.point", { step: String(step), context: formatTokens(series[j].context) }));
            }
            chart.appendChild(bar);
          }
          section.appendChild(chart);
          section.appendChild(statsDiv("wsr-context-caption", t("stats.amplified.contextCaption")));
          if (jumps.length > 0) {
            /* One row per rise, in fixed columns (segment / step / rise / what).
               Packing three rises onto one line truncated every label, and a row
               per rise with prose labels was too tall; four fixed columns give
               both: aligned numbers and room for the file name. */
            var segments = [];
            for (var js = 0; js < jumps.length; js += 1) {
              if (segments.indexOf(jumps[js].segment) === -1) segments.push(jumps[js].segment);
            }
            var multiSegment = segments.length > 1;
            var jumpList = statsDiv("wsr-context-jumps");
            for (var sg = 0; sg < segments.length; sg += 1) {
              var group = statsDiv("wsr-context-jump-group");
              var firstOfSegment = true;
              for (var jl = 0; jl < jumps.length; jl += 1) {
                if (jumps[jl].segment !== segments[sg]) continue;
                var jumpRow = statsDiv("wsr-context-jump-row");
                jumpRow.setAttribute("data-wsr-jump-row", String(jumps[jl].step));
                jumpRow.setAttribute("data-wsr-rank", String(jumps[jl].rank));
                jumpRow.setAttribute("title", jumps[jl].label);
                /* The segment is named once per group, not on every row. */
                jumpRow.appendChild(statsDiv(
                  "wsr-context-jump-segment",
                  multiSegment && firstOfSegment ? t("stats.amplified.segment", { segment: String(segments[sg]) }) : "",
                ));
                firstOfSegment = false;
                var stepCell = statsDiv("wsr-context-jump-step");
                stepCell.appendChild(statsDiv("wsr-context-jump-rank-dot"));
                stepCell.appendChild(statsDiv("wsr-context-jump-step-text", t("stats.amplified.jumpStep", { step: String(jumps[jl].step) })));
                jumpRow.appendChild(stepCell);
                jumpRow.appendChild(statsDiv("wsr-context-jump-rise", "+" + formatTokens(jumps[jl].rise)));
                /* What entered: the tool and a short form of what it touched, so
                   the row answers "which file" instead of only "read". The full
                   detail stays in the tooltip. */
                jumpRow.appendChild(statsDiv("wsr-context-jump-what", jumpWhatOf(jumps[jl].blockName, jumps[jl].blockDetail)));
                group.appendChild(jumpRow);
              }
              jumpList.appendChild(group);
            }
            section.appendChild(jumpList);
          }
          /* The rows only make sense while the chart is on screen; hovering a
             bar or its row lifts both, which is what "挪上去更明显" means here. */
          jumpHoverHosts.push({ chart: chart, list: section });

          /* The ranking is a separate tab: the curve answers "when", the ranking
             answers "what", and stacking both in one scroll hid half of each. */
          var ranking = statsDiv("wsr-amplified wsr-amplified-ranking");
          ranking.appendChild(statsDiv("wsr-amplified-lead", t("stats.amplified.lead")));
          var kinds = amplified.byKind || [];
          if (kinds.length > 0) {
            ranking.appendChild(statsDiv("wsr-amplified-subtitle", t("stats.amplified.kindTitle")));
            var legend = statsDiv("wsr-kind-legend");
            for (var k = 0; k < kinds.length; k += 1) {
              var kind = kinds[k];
              var known = AMPLIFIED_KIND[kind.kind];
              var item = statsDiv("wsr-kind");
              var dot = statsDiv("wsr-kind-dot");
              dot.style.background = known === undefined ? "#9aa0a6" : known[1];
              item.appendChild(dot);
              item.appendChild(statsDiv("", t(known === undefined ? kind.kind : known[0]) + " " + formatShare(kind.share || 0)));
              legend.appendChild(item);
            }
            ranking.appendChild(legend);
          }

          var list = statsDiv("wsr-amplified-list");
          var blocks = amplified.blocks || [];
          if (blocks.length === 0) list.appendChild(statsDiv("wsr-amplified-empty", t("stats.amplified.empty")));
          for (var b = 0; b < blocks.length; b += 1) {
            var block = blocks[b];
            var known = AMPLIFIED_KIND[block.kind];
            var row = statsDiv("wsr-amplified-row");
            var main = statsDiv("wsr-amplified-main");
            main.appendChild(statsDiv("wsr-amplified-name", block.kind === "tool" ? String(block.name) : t(known === undefined ? block.kind : known[0])));
            if (typeof block.detail === "string" && block.detail !== "") main.appendChild(statsDiv("wsr-amplified-detail", block.detail));
            main.appendChild(statsDiv("wsr-amplified-meta", t("stats.amplified.meta", {
              entry: String(block.entry),
              tokens: formatTokens(block.tokens),
              remaining: String(block.remaining),
            })));
            row.appendChild(main);
            var valueCell = statsDiv("wsr-amplified-value", formatTokens(block.amplified));
            /* The exact count, so a number here can be matched against the same
               figure on the distribution tab without converting K/M by hand. */
            valueCell.setAttribute("title", String(Math.round(Number(block.amplified) || 0)) + " tokens");
            row.appendChild(valueCell);
            row.appendChild(statsDiv("wsr-amplified-share", formatShare(block.share || 0)));
            list.appendChild(row);
          }
          ranking.appendChild(list);

          /* Repetition is the actionable part: reading one file twice costs the
             same as two files, and the list above shows it as two rows. */
          var repeated = amplified.repeated || [];
          if (repeated.length > 0) {
            ranking.appendChild(statsDiv("wsr-amplified-subtitle", t("stats.amplified.repeatTitle")));
            var repeats = statsDiv("wsr-amplified-list");
            for (var rp = 0; rp < repeated.length; rp += 1) {
              var item = repeated[rp];
              var row = statsDiv("wsr-amplified-row");
              var main = statsDiv("wsr-amplified-main");
              main.appendChild(statsDiv("wsr-amplified-name", typeof item.detail === "string" ? item.detail : ""));
              main.appendChild(statsDiv("wsr-amplified-meta", t("stats.amplified.repeatMeta", {
                count: String(item.count),
                tokens: formatTokens(item.tokens),
              })));
              row.appendChild(main);
              var value = statsDiv("wsr-amplified-value", formatTokens(item.amplified));
              value.setAttribute("title", String(Math.round(Number(item.amplified) || 0)) + " tokens");
              row.appendChild(value);
              row.appendChild(statsDiv("wsr-amplified-share", formatShare(item.share || 0)));
              repeats.appendChild(row);
            }
            ranking.appendChild(repeats);
          }
          return { top: section, ranking: ranking };
        }

        function renderStats(body, stats) {
          body.textContent = "";
          while (body.firstChild !== null) body.removeChild(body.firstChild);
          /* A re-render replaces the DOM the hover handlers pointed at. */
          jumpHoverHosts.length = 0;
          var totals = stats.totals || {};
          var estimate = stats.estimate || {};
          var agent = estimate.agent || {};

          /* Five cards as before, bill first: it is the number the rest of the
             panel explains, so it leads and carries the accent. */
          var grid = document.createElement("div");
          grid.className = "wsr-stats-grid";
          var cards = [
            [t("stats.total"), formatTokens(totals.totalTokens), true, Number(totals.totalTokens) || 0],
            [t("stats.steps"), formatTokens(stats.steps), false, Number(stats.steps) || 0],
            [t("stats.input"), formatTokens(totals.inputTokens), false, Number(totals.inputTokens) || 0],
            [t("stats.cache"), formatTokens(totals.cacheReadTokens), false, Number(totals.cacheReadTokens) || 0],
            [t("stats.output"), formatTokens(totals.outputTokens), false, Number(totals.outputTokens) || 0],
          ];
          for (var i = 0; i < cards.length; i += 1) {
            var card = statsDiv("wsr-stats-card" + (cards[i][2] === true ? " wsr-stats-card-primary" : ""));
            var valueCell = statsDiv("wsr-stats-value", cards[i][1]);
            /* Numbers auto-scale to K/M/B; the exact count on hover is what makes
               two tabs comparable without converting units in your head. */
            valueCell.setAttribute("title", String(cards[i][3]));
            card.appendChild(valueCell);
            card.appendChild(statsDiv("wsr-stats-label", cards[i][0]));
            grid.appendChild(card);
          }
          body.appendChild(grid);

          /* Three views instead of one long page: distribution, amplification,
             details. The summary cards stay above the tabs for every view. */
          var amplifiedSection = buildAmplified(stats);

          var tools = estimate.tools || [];
          var mode = argModeOf();
          var movedArgs = 0;
          if (mode === "agent") {
            for (var a = 0; a < tools.length; a += 1) movedArgs += tools[a].args || 0;
          }
          var grand = estimate.grandTotal || 0;
          if (grand <= 0 && mode === "agent") {
            /* An older host half may not send grandTotal: rebuild the denominator. */
            grand = (agent.total || 0) + movedArgs;
            for (var g = 0; g < tools.length; g += 1) grand += tools[g].total || 0;
          }
          var shareOf = function (value) {
            if (grand > 0) return value / grand;
            return 0;
          };

          var agentValue = (agent.total || 0) + movedArgs;
          var entries = [{
            name: t("stats.agent"),
            value: agentValue,
            share: grand > 0 ? shareOf(agentValue) : (agent.share || 0),
            hue: 217,
            rank: 0,
            args: 0,
            split: false,
          }];
          for (var j = 0; j < tools.length; j += 1) {
            var tool = tools[j];
            var args = tool.args || 0;
            var results = tool.results || 0;
            var value = mode === "agent" ? results : (tool.total || args + results);
            entries.push({
              name: tool.name,
              value: value,
              share: shareOf(value),
              hue: sourceHue(tool.name),
              family: toolFamily(tool.name).key,
              rank: j + 1,
              calls: tool.calls || 0,
              args: args,
              results: results,
              split: mode !== "agent" && args > 0 && results > 0,
            });
          }

          /* The picture first: one bar per source, split into args and results. */
          var chart = document.createElement("div");
          chart.className = "wsr-chart";
          var familyOrder = [];
          var familySeen = {};
          for (var f = 0; f < entries.length; f += 1) {
            var fam = entries[f].family;
            if (typeof fam === "string" && fam !== "" && familySeen[fam] !== true) {
              familySeen[fam] = true;
              familyOrder.push(fam);
            }
          }
          if (familyOrder.length > 0) {
            var familyLegend = statsDiv("wsr-kind-legend wsr-family-legend");
            for (var fl = 0; fl < familyOrder.length; fl += 1) {
              var famItem = statsDiv("wsr-kind");
              var famDot = statsDiv("wsr-kind-dot");
              famDot.style.background = sourceColor(hueOfFamily(familyOrder[fl]));
              famItem.appendChild(famDot);
              famItem.appendChild(statsDiv("", t("stats.family." + familyOrder[fl])));
              familyLegend.appendChild(famItem);
            }
            chart.appendChild(familyLegend);
          }
          var chartHead = statsDiv("wsr-chart-head");
          chartHead.appendChild(statsDiv("wsr-chart-title", t("stats.chart")));
          if (mode !== "agent") chartHead.appendChild(chartLegend());
          chart.appendChild(chartHead);
          /* A header row keeps the count column from reading as a stray number. */
          var callHead = statsDiv("wsr-chart-row wsr-chart-headrow");
          callHead.appendChild(statsDiv("wsr-chart-label", ""));
          callHead.appendChild(statsDiv("wsr-chart-track-head", ""));
          callHead.appendChild(statsDiv("wsr-chart-value-head", t("stats.col.tokensShort")));
          callHead.appendChild(statsDiv("wsr-chart-share-head", t("stats.col.shareShort")));
          callHead.appendChild(statsDiv("wsr-chart-calls-head", t("stats.col.calls")));
          chart.appendChild(callHead);
          var largest = 1;
          for (var m = 0; m < entries.length; m += 1) if (entries[m].value > largest) largest = entries[m].value;
          for (var k = 0; k < entries.length; k += 1) chart.appendChild(chartBar(entries[k], largest));
          var distributionPanel = statsDiv("wsr-stats-panel");
          distributionPanel.appendChild(chart);
          /* The agent's own split is the one number the bars cannot show: the
             rows for tools already name their source, so a whole table was
             repeating the chart. It sits under the chart instead. */
          distributionPanel.appendChild(statsDiv("wsr-stats-detail", t("stats.agentDetail", {
            reasoning: formatTokens(agent.reasoning),
            text: formatTokens(agent.text),
            user: formatTokens(agent.user),
            system: formatTokens(agent.system),
          })));

          var tabs = statsDiv("wsr-stats-tabs");
          tabs.setAttribute("role", "tablist");
          var panels = statsDiv("wsr-stats-panels");
          var defs = [["distribution", "stats.tab.distribution", distributionPanel]];
          if (amplifiedSection !== null) {
            var amplifiedPanel = statsDiv("wsr-stats-panel");
            amplifiedPanel.appendChild(amplifiedSection.top);
            defs.push(["amplified", "stats.tab.amplified", amplifiedPanel]);
            var rankingPanel = statsDiv("wsr-stats-panel");
            rankingPanel.appendChild(amplifiedSection.ranking);
            defs.push(["ranking", "stats.tab.ranking", rankingPanel]);
          }
          if (mode === "agent") defs[0][2].appendChild(statsDiv("wsr-stats-note", t("stats.argModeNote")));
          var tabButtons = {};
          var selectTab = function (id) {
            statsTab = id;
            for (var index = 0; index < defs.length; index += 1) {
              var def = defs[index];
              var active = def[0] === id;
              if (tabButtons[def[0]] !== undefined) {
                tabButtons[def[0]].className = "wsr-stats-tab" + (active ? " wsr-stats-tab-active" : "");
                tabButtons[def[0]].setAttribute("aria-selected", active ? "true" : "false");
              }
              def[2].style.display = active ? "" : "none";
            }
          };
          for (var d = 0; d < defs.length; d += 1) {
            (function (def) {
              var button = document.createElement("button");
              button.type = "button";
              button.className = "wsr-stats-tab";
              button.setAttribute("role", "tab");
              button.setAttribute("data-wsr-stats-tab", def[0]);
              button.textContent = t(def[1]);
              button.addEventListener("click", function () { selectTab(def[0]); });
              tabButtons[def[0]] = button;
              tabs.appendChild(button);
              panels.appendChild(def[2]);
            })(defs[d]);
          }
          var initialTab = statsTab;
          /* A remembered tab may name a view this build no longer has. */
          var known = false;
          for (var kt = 0; kt < defs.length; kt += 1) if (defs[kt][0] === initialTab) known = true;
          if (!known) initialTab = "distribution";
          selectTab(initialTab);
          body.appendChild(tabs);
          body.appendChild(panels);
          /* One口径 note for the whole dialog: both views are estimates over the
             same logs, and repeating it under each view crowded out the numbers. */
          body.appendChild(statsDiv("wsr-stats-note wsr-stats-footnote", t("stats.note")));
        }

        function openStatsPanel(sessionId) {
          if (typeof document === "undefined") return;
          closeStatsPanel();
          var backdrop = statsDiv("wsr-modal-backdrop");
          var panel = statsDiv("wsr-modal");
          backdrop.appendChild(panel);
          var head = statsDiv("wsr-modal-head");
          head.appendChild(statsDiv("wsr-modal-title", t("stats.title")));
          var close = document.createElement("button");
          close.type = "button";
          close.className = "wsr-modal-close";
          close.textContent = "\u00d7";
          close.addEventListener("click", closeStatsPanel);
          head.appendChild(close);
          panel.appendChild(head);
          var body = statsDiv("wsr-modal-body");
          body.textContent = t("stats.loading");
          panel.appendChild(body);
          backdrop.addEventListener("click", function (event) {
            if (event !== undefined && event.target === backdrop) closeStatsPanel();
          });
          document.body.appendChild(backdrop);
          statsModal = backdrop;
          document.addEventListener("keydown", onStatsKey);

          var controller = typeof AbortController === "function" ? new AbortController() : null;
          var timer = controller === null ? null : window.setTimeout(function () { controller.abort(); }, 180000);
          var request = fetch("/ws-recency/session-stats?sessionId=" + encodeURIComponent(sessionId), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: sessionId }),
            signal: controller === null ? undefined : controller.signal,
          }).then(function (response) {
            if (timer !== null) window.clearTimeout(timer);
            return response.text().then(function (text) {
              var parsed = null;
              try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
              return { status: response.status, text: text, json: parsed };
            });
          }, function (error) {
            if (timer !== null) window.clearTimeout(timer);
            throw error;
          });

          request.then(function (result) {
            if (result.status === 200 && result.json !== null && result.json.ok === true) {
              renderStats(body, result.json.stats);
              return;
            }
            var reason = (result.json !== null && result.json.error)
              || (result.text || "").trim().slice(0, 120)
              || "(empty response)";
            body.textContent = t("stats.failed") + "HTTP " + result.status + " \u00b7 " + reason;
            /* A 405 here is the SPA fallback answering an unknown POST: the host
               half never mounted. Ask the health route which part is missing. */
            return fetch("/ws-recency/health").then(function (response) {
              return response.text();
            }).then(function (text) {
              var health = null;
              try { health = JSON.parse(text); } catch (error) { health = null; }
              body.textContent += health !== null && health.ok === true
                ? t("stats.diagnose.unmounted")
                : t("stats.diagnose.noHost");
            }).catch(function () {
              body.textContent += t("stats.diagnose.noHost");
            });
          }).catch(function (error) {
            body.textContent = t("stats.failed") + (error && error.message ? error.message : error);
          });
        }

        /** Which workspace currently owns a session, per the client snapshot. */
        function workspaceOfSession(sessionId) {
          var items = (data.workspaces && data.workspaces.items) || [];
          for (var i = 0; i < items.length; i += 1) {
            if ((items[i].sessionIds || []).indexOf(sessionId) !== -1) return items[i];
          }
          return null;
        }

        /** Modal that lists the workspaces and moves the session into the chosen one. */
        function openMovePanel(sessionId) {
          if (typeof document === "undefined") return;
          closeStatsPanel();
          var backdrop = statsDiv("wsr-modal-backdrop");
          var panel = statsDiv("wsr-modal");
          backdrop.appendChild(panel);
          var head = statsDiv("wsr-modal-head");
          head.appendChild(statsDiv("wsr-modal-title", t("move.title")));
          var close = document.createElement("button");
          close.type = "button";
          close.className = "wsr-modal-close";
          close.textContent = "\u00d7";
          close.addEventListener("click", closeStatsPanel);
          head.appendChild(close);
          panel.appendChild(head);
          var body = statsDiv("wsr-modal-body");
          panel.appendChild(body);
          body.appendChild(statsDiv("wsr-stats-note", t("move.note")));
          body.appendChild(statsDiv("wsr-move-warning", t("move.warning")));
          if (currentConversationId() === sessionId) {
            var liveNote = statsDiv("wsr-move-warning", t("move.live"));
            liveNote.setAttribute("data-wsr-move-live", "true");
            body.appendChild(liveNote);
          }

          var current = workspaceOfSession(sessionId);
          var items = (data.workspaces && data.workspaces.items) || [];
          var list = statsDiv("wsr-move-list");
          for (var i = 0; i < items.length; i += 1) {
            (function (item) {
              var isCurrent = current !== null && current.workspaceId === item.workspaceId;
              var row = document.createElement("button");
              row.type = "button";
              row.className = "wsr-move-row";
              row.setAttribute("data-wsr-move-target", String(item.workspaceId));
              if (isCurrent) row.setAttribute("disabled", "true");
              var text = statsDiv("wsr-move-text");
              text.appendChild(statsDiv("wsr-move-title", (item.title && String(item.title)) || baseName(item.path)));
              text.appendChild(statsDiv("wsr-move-path", String(item.path || "")));
              row.appendChild(text);
              row.appendChild(statsDiv("wsr-move-badge", isCurrent ? t("move.current") : ""));
              if (!isCurrent) {
                row.addEventListener("click", function () {
                  var label = (item.title && String(item.title)) || baseName(item.path);
                  askConfirm(t("move.confirm", { workspace: label }), function () {
                    body.textContent = t("move.working");
                    fetch("/ws-recency/session-move?sessionId=" + encodeURIComponent(sessionId), {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ sessionId: sessionId, workspaceId: item.workspaceId }),
                    })
                      .then(function (response) {
                        return response.text().then(function (text) {
                          var parsed = null;
                          try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
                          return { status: response.status, text: text, json: parsed };
                        });
                      })
                      .then(function (result) {
                        if (result.json !== null && result.json.ok === true) {
                          if (result.json.repaired === true) {
                            body.textContent = t("move.repaired", { workspace: label });
                            return;
                          }
                          body.textContent = t("move.done", { workspace: label });
                          if (result.json.live === true) body.textContent += t("move.doneLive");
                          return;
                        }
                        /* The raw persistence error names no remedy. */
                        if (result.json !== null && result.json.code === "session-live") {
                          body.textContent = t("move.live");
                          return;
                        }
                        var reason = (result.json !== null && result.json.error) || (result.text || "").trim().slice(0, 160) || "(empty response)";
                        body.textContent = t("move.failed") + "HTTP " + result.status + " \u00b7 " + reason;
                      })
                      .catch(function (error) {
                        body.textContent = t("move.failed") + (error && error.message ? error.message : error);
                      });
                  });
                });
              }
              list.appendChild(row);
            })(items[i]);
          }
          body.appendChild(list);
          backdrop.addEventListener("click", function (event) {
            if (event !== undefined && event.target === backdrop) closeStatsPanel();
          });
          document.body.appendChild(backdrop);
          statsModal = backdrop;
          document.addEventListener("keydown", onStatsKey);
        }

        /** Session "..." menu row: move the conversation to another workspace. */
        function MoveMenuItem(props) {
          var Item = ui.MenuItemButton;
          if (typeof Item !== "function") return null;
          var Icon = ui.IconFolderOpenOutlineRegular;
          return h(Item, {
            icon: typeof Icon === "function" ? h(Icon, {}) : undefined,
            onSelect: function () { openMovePanel(props.sessionId); },
          }, t("menu.move"));
        }

        /* ------------------------------ handoff ------------------------------ */

        /* A plain observable, not a slot store: the turn card and the turn action are
           different slot instances, and a store handle would hand each its own copy. */
        var handoffState = { sessionId: "", phase: "idle", block: "", needsEnter: false };
        var handoffListeners = [];

        function currentHandoffState() {
          return handoffState;
        }

        function setHandoffState(patch) {
          handoffState = Object.assign({}, handoffState, patch);
          var listeners = handoffListeners.slice();
          for (var i = 0; i < listeners.length; i += 1) {
            try { listeners[i](handoffState); } catch (error) { /* a dead component */ }
          }
        }

        function subscribeHandoff(listener) {
          handoffListeners.push(listener);
          return function () {
            var at = handoffListeners.indexOf(listener);
            if (at !== -1) handoffListeners.splice(at, 1);
          };
        }

        var handoffTimer = null;
        var handoffBaseline = 0;
        var handoffTries = 0;
        var handoffSession = null;
        /** Wall clock of the instruction/rewrite: older replies are never the answer. */
        var handoffStartedAt = 0;

        /** Retention-source tag the Host books this plugin's borrows under. */
        var HANDOFF_SOURCE = "dsh-ws-recency";

        /** The instruction the user sends to the current Session. */
        function handoffInstruction() {
          return t("handoff.instruction");
        }

        /** The Host's session service, when this Client provides it. */
        function sessionsService() {
          var ctx = data.ctx;
          if (ctx === null || ctx === undefined || typeof ctx.get !== "function") return null;
          var sessions;
          try { sessions = ctx.get("sessions"); } catch (error) { sessions = undefined; }
          return sessions === undefined ? null : sessions;
        }

        /**
         * Send one prompt through the Host's own Session controller.
         *
         * The composer path further down is a synthetic key event: it depends on
         * the editor being mounted, focused, and on the insert and the key landing
         * in different frames. The Session controller owns a real prompt call, so
         * a plugin can retain the session, wait until it is open, and hand the text
         * over - no DOM, no key events, and it works for a session that is not the
         * one on screen (the "..." menu starts a handoff that way).
         *
         * @param sessionId - target Session.
         * @param text - prompt text, sent as one text block.
         * @param onUnsent - called when the prompt could not be dispatched.
         * @returns true when a request was dispatched (its promise may still fail).
         */
        function promptSession(sessionId, text, onUnsent) {
          var sessions = sessionsService();
          if (sessions !== null && typeof sessions.using === "function") {
            try {
              sessions.using(sessionId, { source: HANDOFF_SOURCE }, function (reference) {
                var binding = reference === null || reference === undefined ? undefined : reference.binding;
                var session = binding === null || binding === undefined ? undefined : binding.session;
                if (session === undefined || session === null || typeof session.prompt !== "function") throw new Error("session unavailable");
                return Promise.resolve(session.prompt([{ type: "text", text: text }], "queue")).then(function (result) {
                  if (result !== null && result !== undefined && result.ok === false) throw new Error("the session refused the prompt");
                  return result;
                });
              }).catch(function () {
                if (typeof onUnsent === "function") onUnsent();
              });
              return true;
            } catch (error) {
              /* fall through to the caller's own path */
            }
          }
          if (typeof onUnsent === "function") onUnsent();
          return false;
        }

        function handoffPost(payload) {
          return fetch("/ws-recency/handoff", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }).then(function (response) {
            return response.json().catch(function () { return null; });
          });
        }

        /** Enter is the only submit path the composer exposes to a plugin. */
        function pressEnter(editor) {
          try {
            var event = new window.KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            });
            editor.dispatchEvent(event);
            return true;
          } catch (error) {
            return false;
          }
        }

        /** The composer of the open conversation, if it is on screen. */
        function composerEditor() {
          if (typeof document === "undefined") return null;
          var seat = typeof document.querySelector === "function" ? document.querySelector("[data-composer-seat]") : null;
          if (seat === null || seat === undefined) return null;
          var editor = null;
          try { editor = seat.querySelector('[contenteditable="true"]'); } catch (error) { editor = null; }
          if (editor === null || editor === undefined) {
            try { editor = seat.querySelector("textarea"); } catch (error) { editor = null; }
          }
          return editor === undefined ? null : editor;
        }

        function editorText(editor) {
          if (editor === null || editor === undefined) return "";
          if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") return typeof editor.value === "string" ? editor.value : "";
          return typeof editor.textContent === "string" ? editor.textContent : "";
        }

        /**
         * Send the handoff in the Session that was just opened.
         *
         * The draft initialises asynchronously: poll until the composer actually holds
         * the note, press Enter once, then stop. If it never shows up (slow render,
         * another draft kept) the text simply stays there for a manual Enter.
         */
        function autoSendDraft(marker) {
          if (typeof window === "undefined") return;
          var tries = 0;
          function step() {
            tries += 1;
            var editor = composerEditor();
            if (editor !== null) {
              var text = editorText(editor);
              if (text.indexOf(marker) !== -1) {
                try { if (typeof editor.focus === "function") editor.focus(); } catch (error) { /* focus is best effort */ }
                pressEnter(editor);
                return;
              }
            }
            if (tries < 40) window.setTimeout(step, 350);
          }
          window.setTimeout(step, 400);
        }

        /** Put text into an editor without losing the framework's own input event. */
        function writeIntoEditor(editor, text) {
          try {
            if (typeof editor.focus === "function") editor.focus();
            if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
              editor.value = text;
              editor.dispatchEvent(new window.Event("input", { bubbles: true }));
              return true;
            }
            var selection = typeof window.getSelection === "function" ? window.getSelection() : null;
            if (selection !== null && typeof document.createRange === "function") {
              var range = document.createRange();
              range.selectNodeContents(editor);
              range.collapse(false);
              selection.removeAllRanges();
              selection.addRange(range);
            }
            if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) return true;
            editor.textContent = text;
            editor.dispatchEvent(new window.Event("input", { bubbles: true }));
            return true;
          } catch (error) {
            return false;
          }
        }

        /**
         * Press Enter until the text actually leaves the composer.
         *
         * The editor commits an inserted text and a synthetic Enter in different
         * frames: pressing Enter in the same tick as the insert is swallowed, which
         * is why the instruction used to sit in the box until the user pressed it.
         * Wait a beat, then press again only while the text is still there.
         */
        function armEnter(editor, attempt) {
          if (typeof window === "undefined") return;
          window.setTimeout(function () {
            if (composerEditor() !== editor) return;
            if (editorText(editor).trim() === "") return;
            pressEnter(editor);
            if (attempt < 2) armEnter(editor, attempt + 1);
          }, attempt === 0 ? 250 : 800);
        }

        /** Fallback: write into the open composer and press Enter until it leaves. */
        function sendThroughComposer(sessionId, text) {
          if (typeof document === "undefined") return false;
          /* Never write into another conversation's composer: the open editor
             belongs to the session on screen, not to the target id. */
          if (currentConversationId() !== sessionId) return false;
          var editor = composerEditor();
          if (editor === null || editor === undefined) return false;
          if (!writeIntoEditor(editor, text)) return false;
          armEnter(editor, 0);
          return true;
        }

        /**
         * Send one prompt to one Session.
         *
         * Preferred: the Host's Session controller (see promptSession). Only when
         * that seam is unavailable does it fall back to writing into the composer
         * of the session on screen and pressing Enter; a target that is not on
         * screen then just reports "press Enter" on the card instead of sending
         * the instruction into the wrong conversation.
         */
        function sendToSession(sessionId, text) {
          if (typeof text !== "string" || text === "") return false;
          var fallback = function () {
            if (sendThroughComposer(sessionId, text)) return;
            setHandoffState({ sessionId: sessionId, phase: "running", block: "", needsEnter: true });
          };
          return promptSession(sessionId, text, fallback);
        }

        function stopHandoffPolling() {
          if (handoffTimer !== null && typeof window.clearTimeout === "function") window.clearTimeout(handoffTimer);
          handoffTimer = null;
        }

        function resetHandoff() {
          stopHandoffPolling();
          handoffSession = null;
          handoffBaseline = 0;
          handoffTries = 0;
          setHandoffState({ sessionId: "", phase: "idle", block: "", needsEnter: false });
        }

        /**
         * Every fenced block in a reply, in order: `{ label, body }`.
         *
         * A fence stops only on a line that is nothing but backticks. The handoff
         * note names the fence it came in ("→ 抓到 ```handoff 块"), and matching the
         * first three backticks used to close the block right there: the note was
         * cut mid-sentence and that truncated text went into the new Session.
         */
        function fencedBlocks(text) {
          var lines = String(text).split(/\r?\n/);
          var opens = /^ {0,3}(`{3,})[ \t]*([A-Za-z0-9_+-]*)[ \t]*$/;
          var closes = /^ {0,3}(`{3,})[ \t]*$/;
          var blocks = [];
          var at = -1;
          var label = "";
          for (var i = 0; i < lines.length; i += 1) {
            if (at !== -1) {
              if (closes.test(lines[i])) {
                blocks.push({ label: label, body: lines.slice(at + 1, i).join("\n").trim() });
                at = -1;
                label = "";
              }
              continue;
            }
            var opened = opens.exec(lines[i]);
            if (opened === null) continue;
            at = i;
            label = opened[2].toLowerCase();
          }
          return blocks;
        }

        /**
         * Pull the handoff block out of an assistant reply.
         *
         * Both fence kinds are read: the prompt asks for `~~~handoff` (three tildes
         * rarely appear in prose), `' + '```handoff` stays supported for older replies.
         * A fence only counts when it owns its line and is closed by the same kind,
         * so a note that mentions the marker in a sentence cannot cut itself short,
         * and a reply that is still streaming is not captured half-written.
         */
        function handoffBlockOf(text) {
          if (typeof text !== "string") return "";
          var bodyOf = function (openedAt, openedLength, mark) {
            var closer = new RegExp("^[ \\t]*" + mark + "[ \\t]*$", "m");
            var rest = text.slice(openedAt + openedLength);
            var closed = closer.exec(rest);
            if (closed === null) return "";
            return rest.slice(0, closed.index).replace(/^\r?\n/, "").trim();
          };
          var tagged = /^[ \t]*(```|~~~)[ \t]*handoff[ \t]*$/m.exec(text);
          if (tagged !== null) return bodyOf(tagged.index, tagged[0].length, tagged[1]);
          var fence = /^[ \t]*(```|~~~)[ \t]*[a-zA-Z0-9_-]*[ \t]*$/gm;
          var opened;
          while ((opened = fence.exec(text)) !== null) {
            var candidate = bodyOf(opened.index, opened[0].length, opened[1]);
            if (candidate !== "" && candidate.indexOf("#") !== -1) return candidate;
            var next = text.indexOf("\n", opened.index + opened[0].length);
            if (next === -1) return "";
            fence.lastIndex = next + 1;
          }
          return "";
        }

        /**
         * Whether a tail answer is a *new, finished* reply worth reading.
         *
         * Three guards, because the tail always reports the newest assistant text
         * in the whole log:
         *   - the session must have no open turn: a freshly started turn logs
         *     assistant messages with only reasoning/tool-call blocks, and if the
         *     previous reply happened to be a handoff note the old text would be
         *     read as the answer while the model is still working;
         *   - the text must be newer than the moment the instruction went out;
         *   - an older Host without `seq`/`turnOpen` falls back to the timestamp.
         */
        function handoffAnswerReady(answer, baseline) {
          if (answer === null || answer === undefined || answer.ok !== true) return false;
          if (answer.turnOpen === true) return false;
          var seqFresh = typeof answer.textSeq === "number" && answer.textSeq !== 0 && typeof baseline === "number" && answer.textSeq > baseline;
          var timeFresh = typeof answer.at === "number" && answer.at > 0 && handoffStartedAt > 0 && answer.at > handoffStartedAt;
          if (seqFresh || timeFresh) return true;
          /* A Host too old to report either marker: the caller's count is all we have. */
          if ((typeof answer.textSeq !== "number" || answer.textSeq === 0) && (typeof answer.at !== "number" || answer.at === 0)) return true;
          return false;
        }

        /** Start the watch: the next finished reply that carries a handoff block becomes the card. */
        function watchHandoff(sessionId) {
          handoffSession = sessionId;
          handoffTries = 0;
          handoffStartedAt = Date.now();
          stopHandoffPolling();
          if (typeof window === "undefined") return;
          function tick() {
            if (handoffSession !== sessionId) return;
            handoffTries += 1;
            handoffPost({ action: "tail", sessionId: sessionId }).then(function (answer) {
              if (handoffSession !== sessionId) return;
              if (answer !== null && answer.ok === true) {
                var reached = typeof answer.lastSeq === "number"
                  ? answer.lastSeq > handoffBaseline
                  : (typeof answer.replies === "number" ? answer.replies > handoffBaseline : false);
                if (reached && handoffAnswerReady(answer, handoffBaseline)) {
                  var found = handoffBlockOf(answer.text);
                  if (found !== "") {
                    setHandoffState({
                      sessionId: sessionId,
                      phase: "ready",
                      block: found,
                      needsEnter: false,
                      turn: typeof answer.turn === "number" ? answer.turn : undefined,
                    });
                    return;
                  }
                }
                /* Not ready yet (turn still open, text not newer, or no block in
                   this reply): keep looking at the same session. */
              }
              if (handoffTries > 150) {
                setHandoffState({ sessionId: "", phase: "idle", block: "", needsEnter: false });
                handoffSession = null;
                return;
              }
              handoffTimer = window.setTimeout(tick, 2000);
            }).catch(function () {
              handoffTimer = window.setTimeout(tick, 4000);
            });
          }
          /* The baseline is where the log stood before the instruction is answered. */
          handoffPost({ action: "tail", sessionId: sessionId }).then(function (answer) {
            if (handoffSession !== sessionId) return;
            handoffBaseline = answer !== null && answer.ok === true && typeof answer.lastSeq === "number"
              ? answer.lastSeq
              : (answer !== null && answer.ok === true && typeof answer.replies === "number" ? answer.replies : 0);
            handoffTimer = window.setTimeout(tick, 1500);
          }).catch(function () {
            handoffTimer = window.setTimeout(tick, 3000);
          });
        }

        /** The turn action: send the instruction and wait for the block. */
        function startHandoff(sessionId) {
          if (typeof sessionId !== "string" || sessionId === "") return;
          /* The card starts in its "working" state; if the Host refuses the send
             the fallback flips needsEnter so the card tells the user to press
             Enter instead of pretending the handoff is running. */
          var startTurn = latestTurnNumber();
          setHandoffState({ sessionId: sessionId, phase: "running", block: "", needsEnter: false, afterTurn: startTurn === null ? undefined : startTurn });
          sendToSession(sessionId, handoffInstruction());
          watchHandoff(sessionId);
        }

        /**
         * Fallback carry: the Host opened a blank session and keeps the note as an
         * unsent draft (the pre-0.35 behaviour). Only used when the Session
         * controller seam is missing or the workspace is unknown.
         */
        function startHandoffSession(workspaceId, prompt) {
          var service = data.service;
          if (service !== null && service !== undefined && typeof service.startSession === "function") {
            try {
              service.startSession(workspaceId, { prompt: prompt, whenDraftExists: "replace" });
              resetHandoff();
              autoSendDraft(t("handoff.preamble").slice(0, 12));
              return true;
            } catch (error) {
              /* fall through to the clipboard */
            }
          }
          try {
            if (navigator !== undefined && navigator.clipboard !== undefined) navigator.clipboard.writeText(prompt);
          } catch (error) {
            /* clipboard unavailable */
          }
          resetHandoff();
          return false;
        }

        /**
         * The card carries it over: open a fresh Session in the same workspace and
         * put the note in as its first prompt through the Host's own API.
         *
         * `connectWorkspace` creates (or reuses) the blank and returns its id
         * without navigating; `sessions.using` retains that session until it is
         * open, so the prompt is the session's real first message - nothing has to
         * be typed into a composer and no Enter is synthesised.
         */
        function carryHandoff(sessionId, block) {
          var text = typeof block === "string" ? block.trim() : "";
          if (text === "") return;
          handoffPost({ action: "save", sessionId: sessionId, text: text }).catch(function () { return null; }).then(function () {
            var owner = workspaceOfSession(sessionId);
            var workspaceId = owner === null || owner === undefined ? undefined : owner.workspaceId;
            var service = data.service;
            var sessions = sessionsService();
            var prompt = t("handoff.preamble") + "\n\n" + text;
            if (workspaceId !== undefined
              && service !== null && service !== undefined
              && typeof service.connectWorkspace === "function"
              && typeof service.openSession === "function"
              && sessions !== null && typeof sessions.using === "function") {
              service.connectWorkspace(workspaceId).then(function (newSessionId) {
                try { service.openSession(newSessionId); } catch (error) { /* the prompt still lands */ }
                return sessions.using(newSessionId, { source: HANDOFF_SOURCE }, function (reference) {
                  var binding = reference === null || reference === undefined ? undefined : reference.binding;
                  var session = binding === null || binding === undefined ? undefined : binding.session;
                  if (session === undefined || session === null || typeof session.prompt !== "function") throw new Error("session unavailable");
                  return session.prompt([{ type: "text", text: prompt }], "queue");
                });
              }).then(function (result) {
                if (result !== null && result !== undefined && result.ok === false) throw new Error("the session refused the prompt");
                resetHandoff();
              }).catch(function () {
                startHandoffSession(workspaceId, prompt);
              });
              return;
            }
            startHandoffSession(workspaceId, prompt);
          });
        }

        /** Ask the current Session to rewrite the handoff with the user's adjustments. */
        function rewriteHandoff(sessionId, extra) {
          var text = extra.trim() === "" ? t("handoff.regeneratePrompt") : t("handoff.adjustPrompt") + "\n\n" + extra.trim();
          var startTurn = latestTurnNumber();
          setHandoffState({ sessionId: sessionId, phase: "running", block: "", needsEnter: false, afterTurn: startTurn === null ? undefined : startTurn });
          sendToSession(sessionId, text);
          handoffBaseline = 0;
          handoffTries = 0;
          handoffSession = sessionId;
          watchHandoff(sessionId);
        }

        /**
         * The handoff question card.
         *
         * Visual language copied from the Host's own ask-a-question card (the one the
         * question tool renders): a raised panel with a title, numbered option rows
         * and one footer of actions. Two mutually exclusive choices plus a free-text
         * field, which takes precedence when it has content.
         */
        function HandoffTailCard(props) {
          var sessionId = props !== undefined && props !== null && typeof props.sessionId === "string" ? props.sessionId : "";
          var pair = react.useState(currentHandoffState());
          var live = pair[0];
          var setLive = pair[1];
          react.useEffect(function () {
            return subscribeHandoff(function (next) { setLive(next); });
          }, []);
          var choice = react.useState("confirm");
          var picked = choice[0];
          var setPicked = choice[1];
          var extraPair = react.useState("");
          var extra = extraPair[0];
          var setExtra = extraPair[1];

          var state = live;
          if (state === null || state === undefined || state.sessionId !== sessionId) return null;
          /* One rendered `turnTail` per turn: show the card only on the turn the
             note came from, and the progress line only on the newest turn (the
             open one). Props without a turn number keep the old behaviour. */
          var turn = props !== undefined && props !== null && typeof props.turn === "number" ? props.turn : null;
          if (state.phase === "running" && turn !== null) {
            if (typeof state.afterTurn === "number") {
              /* Only a turn that started after the click can be the answer. */
              if (turn <= state.afterTurn) return null;
            } else {
              var latest = latestTurnNumber();
              if (latest !== null && turn !== latest) return null;
            }
          }
          if (state.phase === "ready" && turn !== null) {
            var target = typeof state.turn === "number" ? state.turn : latestTurnNumber();
            if (target !== null && turn !== target) return null;
          }
          if (state.phase === "running") {
            return h("div", { className: "wsr-handoff-live" }, state.needsEnter === true ? t("handoff.pressEnter") : t("handoff.preparing"));
          }
          if (state.phase !== "ready") return null;

          function optionRow(id, index, title, description) {
            return h("button", {
              type: "button",
              key: "opt-" + id,
              className: "wsr-qoption" + (picked === id ? " wsr-qoption-selected" : ""),
              onClick: function () { setPicked(id); },
            },
              h("span", { className: "wsr-qnum" }, String(index)),
              h("span", { className: "wsr-qtext" },
                h("span", { className: "wsr-qtitle" }, title),
                h("span", { className: "wsr-qdetail" }, description),
              ),
            );
          }

          return h("div", { className: "wsr-qcard" },
            h("div", { className: "wsr-qhead" },
              h("div", { className: "wsr-qheading" },
                h("div", { className: "wsr-qeyebrow" }, t("handoff.eyebrow")),
                h("div", { className: "wsr-qtitle" }, t("handoff.found")),
              ),
              h("button", {
                type: "button",
                className: "wsr-qicon",
                title: t("handoff.preview"),
                onClick: function () {
                  var body = typeof document !== "undefined" ? document.querySelector('[data-wsr-handoff-preview="' + sessionId + '"]') : null;
                  if (body !== null && body !== undefined && body.style !== undefined) {
                    body.style.display = body.style.display === "none" ? "" : "none";
                  }
                },
              }, t("handoff.preview")),
            ),
            h("div", { className: "wsr-qoptions" },
              optionRow("confirm", 1, t("handoff.confirm"), t("handoff.confirmDesc")),
              optionRow("redo", 2, t("handoff.regen"), t("handoff.regenDesc")),
            ),
            h("div", { className: "wsr-qextra" },
              h("textarea", {
                className: "wsr-handoff-extra",
                placeholder: t("handoff.extraPlaceholder"),
                value: extra,
                onChange: function (event) { setExtra(event.target.value); },
              }),
            ),
            h("div", { "data-wsr-handoff-preview": sessionId, className: "wsr-qpreview", style: { display: "none" } }, state.block),
            h("div", { className: "wsr-qfooter" },
              h("div", { className: "wsr-qactions" },
                h("button", {
                  type: "button",
                  className: "wsr-qcancel",
                  onClick: function () { resetHandoff(); },
                }, t("handoff.cancel")),
                h("button", {
                  type: "button",
                  className: "wsr-qsubmit",
                  onClick: function () {
                    if (extra.trim() !== "") { rewriteHandoff(sessionId, extra); return; }
                    if (picked === "redo") { rewriteHandoff(sessionId, ""); return; }
                    carryHandoff(sessionId, state.block);
                  },
                }, t("handoff.submit")),
              ),
            ),
          );
        }

        /**
         * Turn actions: the handoff sits in the same row as copy / rate / branch,
         * which the chat renders once at the end of a completed turn.
         */
        function HandoffTurnAction(props) {
          var Icon = ui.IconShareOutlineRegular;
          var Tooltip = ui.Tooltip;
          var label = t("menu.handoff");
          var button = h("button", {
            type: "button",
            className: "wsr-msg-btn",
            "aria-label": label,
            "data-wsr-handoff-action": "true",
            onClick: function () {
              var sessionId = props !== undefined && props !== null && typeof props.sessionId === "string" ? props.sessionId : null;
              if (sessionId !== null) startHandoff(sessionId);
            },
          }, typeof Icon === "function" ? h(Icon, { size: 16 }) : null);
          return typeof Tooltip === "function" ? h(Tooltip, { label: label, side: "bottom" }, button) : button;
        }

        
        
        /** Settings -> General row: ask before a jump that loads a lot of history. */
        function ColdJumpRow(props) {
          var settings = props.useStore(function (state) { return state; });
          var value = Number(settings.coldJumpTurns);
          if (!Number.isFinite(value)) value = DEFAULT_COLD_JUMP;
          var text = t("search.settings.coldTitle");
          return h("div", { className: "wsr-setRow" },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, text),
              h("div", { className: "wsr-setDesc" }, t("search.settings.coldDesc")),
            ),
            h("div", { className: "wsr-controls" },
              h("button", {
                type: "button",
                className: "wsr-step",
                "aria-label": text + " -1",
                onClick: function () { props.actions.setColdJumpTurns(value - 10); },
              }, "-"),
              h("input", {
                type: "number",
                className: "wsr-input",
                min: 0,
                max: MAX_COLD_JUMP,
                value: String(value),
                "aria-label": text,
                onChange: function (event) { props.actions.setColdJumpTurns(event.target.value); },
              }),
              h("button", {
                type: "button",
                className: "wsr-step",
                "aria-label": text + " +1",
                onClick: function () { props.actions.setColdJumpTurns(value + 10); },
              }, "+"),
            ),
          );
        }

        /** Settings -> General row: how old a session must be before it is folded. */
        function SettingsRow(props) {
          var settings = props.useStore(function (state) { return state; });
          var days = Number(settings.foldDays);
          if (!Number.isFinite(days)) days = DEFAULT_DAYS;
          var keep = settings.keepActive !== false;
          var text = t("settings.title");
          return h("div", { className: "wsr-setRow" },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, text),
              h("div", { className: "wsr-setDesc" }, t("settings.description")),
            ),
            h("div", { className: "wsr-controls" },
              h("button", {
                type: "button",
                className: "wsr-step",
                "aria-label": text + " -1",
                onClick: function () { props.actions.setFoldDays(days - 1); },
              }, "-"),
              h("input", {
                type: "number",
                className: "wsr-input",
                min: MIN_DAYS,
                max: MAX_DAYS,
                value: String(days),
                "aria-label": text,
                onChange: function (event) { props.actions.setFoldDays(event.target.value); },
              }),
              h("button", {
                type: "button",
                className: "wsr-step",
                "aria-label": text + " +1",
                onClick: function () { props.actions.setFoldDays(days + 1); },
              }, "+"),
              h("label", { className: "wsr-exempt" },
                h("input", {
                  type: "checkbox",
                  checked: keep,
                  onChange: function (event) { props.actions.setKeepActive(event.target.checked); },
                }),
                t("settings.exempt")),
            ),
          );
        }

        /** Settings -> General row: color marks on/off. */
        function ColorsRow(props) {
          var settings = props.useStore(function (state) { return state; });
          var enabled = settings.colors !== false;
          var text = t("color.title");
          return h("div", { className: "wsr-setRow" },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, text),
              h("div", { className: "wsr-setDesc" }, t("color.description")),
            ),
            h("div", { className: "wsr-controls" },
              h("label", { className: "wsr-exempt" },
                h("input", {
                  type: "checkbox",
                  checked: enabled,
                  onChange: function (event) { props.actions.setColors(event.target.checked); },
                }),
                t("color.enabled")),
            ),
          );
        }

        /* ---------------------------- trash panel ---------------------------- */

/** A page reload rebuilds the sidebar from disk without restarting the app. */
        function reloadButton() {
          var button = document.createElement("button");
          button.type = "button";
          button.className = "wsr-step";
          button.textContent = t("ui.reload");
          button.addEventListener("click", function () {
            try {
              if (typeof window !== "undefined" && window.location !== undefined && typeof window.location.reload === "function") window.location.reload();
            } catch (error) {
              /* nothing to do */
            }
          });
          return button;
        }

        function formatBytes(value) {
          var n = Number(value) || 0;
          if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
          if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
          return n + " B";
        }

        function formatWhen(at) {
          if (typeof at !== "number" || at <= 0) return "";
          try {
            return new Date(at).toLocaleString();
          } catch (error) {
            return "";
          }
        }

        
        /* --------------------------- trash panel page ------------------------ */

        function trashPost(payload) {
          return fetch("/ws-recency/trash", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }).then(function (response) {
            return response.text().then(function (text) {
              var parsed = null;
              try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
              return { status: response.status, text: text, json: parsed };
            });
          });
        }

        /* ---------- session content search -------------------------------- */

        /**
         * Narrowing chosen through controls rather than typed syntax.
         *
         * Typing `ws:` is a sentence to learn; a select is not. The typed forms
         * still work, and both are merged on the host.
         */
        var searchFilters = { workspace: "", session: "", role: "" };

        /**
         * Recent searches recorded since the plugin loaded.
         *
         * Shown merged with the store's own list. Freezing one copy of the store was
         * wrong: when the panel rendered before the store hydrated, that copy stayed
         * empty and every search looked like it wiped the history.
         */
        var searchHistoryMirror = [];

        /** Keys removed here; hidden until the store drops them as well. */
        var historyDropped = {};

        /** Set by "clear", so a store that has not caught up cannot restore them. */
        var historyCleared = false;

        function mergedHistory(stored) {
          var storedList = Array.isArray(stored) ? stored : [];
          var out = [];
          var seen = {};
          var push = function (item) {
            var key = historyKey(item);
            if (seen[key] === true || historyDropped[key] === true) return;
            seen[key] = true;
            out.push(item);
          };
          for (var i = 0; i < searchHistoryMirror.length; i += 1) push(searchHistoryMirror[i]);
          if (!historyCleared) {
            for (var j = 0; j < storedList.length; j += 1) push(storedList[j]);
          } else if (storedList.length === 0) {
            historyCleared = false;
          }
          return out.slice(0, SEARCH_HISTORY_MAX);
        }

        /** Bumped when a stored query restores the controls, so the title box remounts. */
        var filterEpoch = 0;

        /**
         * One stored search: the words plus the scope they were run with.
         *
         * A query without its scope is an incomplete memory - "CDP" under one
         * workspace is not the same search as "CDP" everywhere - so both travel
         * together. Entries written by older versions were plain strings.
         */
        /** Separator for the stored form; a control character cannot appear in a query. */
        var HISTORY_SEP = "\u0001";

        function historyEntry(item) {
          if (typeof item === "string") {
            var parts = item.split(HISTORY_SEP);
            return {
              query: parts[0] === undefined ? "" : parts[0],
              workspace: parts[1] === undefined ? "" : parts[1],
              session: parts[2] === undefined ? "" : parts[2],
              role: parts[3] === undefined ? "" : parts[3],
            };
          }
          if (item === null || typeof item !== "object") {
            return { query: "", workspace: "", session: "", role: "" };
          }
          return {
            query: typeof item.query === "string" ? item.query : "",
            workspace: typeof item.workspace === "string" ? item.workspace : "",
            session: typeof item.session === "string" ? item.session : "",
            role: typeof item.role === "string" ? item.role : "",
          };
        }

        /** The stored form: one string, so the store keeps handling it like it always did. */
        function historyEncode(item) {
          var entry = historyEntry(item);
          return [entry.query, entry.workspace, entry.session, entry.role]
            .map(function (part) { return String(part).split(HISTORY_SEP).join(" "); })
            .join(HISTORY_SEP);
        }

        function historyKey(item) {
          var entry = historyEntry(item);
          return entry.query + "\u0000" + entry.workspace + "\u0000" + entry.session + "\u0000" + entry.role;
        }

        /** What a chip says: the words, plus whichever scope parts it carries. */
        function historyLabel(item) {
          var entry = historyEntry(item);
          var parts = [];
          if (entry.workspace !== "") parts.push(entry.workspace);
          if (entry.session !== "") parts.push("in:" + entry.session);
          if (entry.role !== "") parts.push(entry.role === "user" ? "me" : "assistant");
          var scope = parts.length > 0 ? " (" + parts.join(" · ") + ")" : "";
          return (entry.query === "" ? "(scope only)" : entry.query) + scope;
        }

        /** How many recent queries the panel remembers. */
        var SEARCH_HISTORY_MAX = 12;

        /** What the uncontrolled input holds; the panel keeps only results in state. */
        var searchDraft = "";
        /** Bumped per search so a slow answer cannot overwrite a newer one. */
        var searchGeneration = 0;
        /**
         * The last answer, kept outside the component.
         *
         * Opening a hit switches the main view to the conversation, which unmounts
         * this page; without this the results were gone when the user came back
         * and every search had to be run again.
         */
        var searchLast = null;

        function searchPost(body) {
          return fetch("/ws-recency/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
          }).then(function (response) {
            return response.text().then(function (text) {
              var parsed = null;
              try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
              return { status: response.status, text: text, json: parsed };
            });
          });
        }

        function SearchPanelIcon(props) {
          var Icon = ui.IconSearchOutlineRegular;
          if (typeof Icon !== "function") return null;
          var size = props !== undefined && props !== null && typeof props.size === "number" ? props.size : 16;
          return h(Icon, { size: size });
        }

        /**
         * Move a scroller and announce it.
         *
         * The chat pages older history in when its own scroll handler sees movement.
         * Assigning `scrollTop` from script does not fire that handler, so a long
         * session stayed at the same page no matter how often the value was set;
         * a synthetic scroll event is what lets the next page load.
         */
        function scrollTo(scroller, top) {
          /* Only used on the turn rail. No synthetic scroll event: the rail
             virtualises on scrollTop alone, and a fabricated event is one more
             thing the host can read as the reader moving. */
          if (scroller === null || scroller === undefined) return;
          var target = Math.max(0, Number(top) || 0);
          try {
            scroller.scrollTop = target;
          } catch (error) {
            return;
          }
          var fire = function () {
            try {
              var event = document.createEvent("Event");
              event.initEvent("scroll", true, false);
              scroller.dispatchEvent(event);
            } catch (error) {
              /* an engine without createEvent still got the assignment */
            }
          };
          void fire;
        }
        function conversationScroller() {
          if (typeof document === "undefined") return null;
          try {
            var direct = document.querySelector("[data-conversation-scroll]");
            if (direct !== null) return direct;
            /* The marker is the documented hook; without it, take the nearest
               ancestor that actually scrolls rather than giving up. */
            var anyRow = document.querySelector("[data-chat-turn]");
            var node = anyRow === null ? null : anyRow.parentElement;
            while (node !== null && node !== undefined) {
              if (typeof node.scrollHeight === "number" && node.scrollHeight > node.clientHeight && node.clientHeight > 0) return node;
              node = node.parentElement;
            }
            return null;
          } catch (error) {
            return null;
          }
        }

        function turnRowOf(turn) {
          if (typeof document === "undefined" || !isFinite(turn)) return null;
          try {
            /* Scoped when possible: a document-wide attribute query on a long
               transcript is the expensive part of a jump's polling loop. The
               document stays as the fallback because the scroller is not always
               the element that holds the rows. */
            var selector = '[data-chat-turn="' + String(turn) + '"]';
            var scope = conversationScroller();
            if (scope !== null && typeof scope.querySelector === "function") {
              var scoped = scope.querySelector(selector);
              if (scoped !== null && scoped !== undefined) return scoped;
            }
            return document.querySelector(selector);
          } catch (error) {
            return null;
          }
        }

        /** The progress line shown while a jump waits for the host. */
        var jumpNote = null;
        var jumpNoteTimer = 0;
        var jumpNoteStarted = 0;

        function clearJumpNote() {
          try {
            if (jumpNoteTimer !== 0) {
              window.clearInterval(jumpNoteTimer);
              jumpNoteTimer = 0;
            }
            if (jumpNote !== null && jumpNote !== undefined) {
              if (jumpNote.parentElement !== null && jumpNote.parentElement !== undefined) jumpNote.remove();
              jumpNote = null;
            }
          } catch (error) {
            /* nothing to clean up */
          }
        }

        /**
         * Say that history is being loaded, and for how long.
         *
         * Clicking a rail cell starts a real page load in the host; on a long
         * session that takes seconds. The old code announced "landed" at the moment
         * of the click, so the window looked frozen with a success note already on
         * screen.
         */
        function announceJumpLoading(hit) {
          if (typeof document === "undefined") return;
          clearJumpNote();
          jumpNoteStarted = Date.now();
          /* Far behind the newest turn: say so, because the wait is proportional. */
          var cold = Number(hit.turns) - Number(hit.turn) > 40;
          var text = function () {
            var secs = String(Math.max(0, Math.round((Date.now() - jumpNoteStarted) / 1000)));
            return cold
              ? t("search.jumpLoadingCold", { turn: String(hit.turn), secs: secs })
              : t("search.jumpLoading", { turn: String(hit.turn), secs: secs });
          };
          try {
            var note = statsDiv("wsr-jump-toast wsr-jump-loading");
            note.textContent = text();
            document.body.appendChild(note);
            jumpNote = note;
            jumpNoteTimer = window.setInterval(function () {
              if (jumpNote === null || jumpNote === undefined) return;
              try {
                jumpNote.textContent = text();
              } catch (error) {
                clearJumpNote();
              }
            }, 500);
          } catch (error) {
            /* a toast is a nicety: never break the jump for it */
          }
        }

        /** A short-lived line that says where the jump landed and how it got there. */
        function announceJump(hit, byText, costMs) {
          if (typeof document === "undefined") return;
          clearJumpNote();
          try {
            var note = statsDiv("wsr-jump-toast");
            var text = t(byText === true ? "search.jumpText" : "search.jumpTurn", { turn: String(hit.turn) });
            if (isFinite(Number(costMs))) text += " · " + t("search.pluginCost", { ms: String(Math.round(Number(costMs))) });
            note.textContent = text;
            document.body.appendChild(note);
            window.setTimeout(function () {
              if (note.parentElement !== null) note.remove();
            }, 3200);
          } catch (error) {
            /* a toast is a nicety: never break the jump for it */
          }
        }
        /**
         * Say why a jump did not land.
         *
         * Without this a failed jump is indistinguishable from a jump that landed
         * in the wrong place: the panel just sits where it was and the user cannot
         * tell whether the session opened, whether the turn exists, or whether the
         * text was never rendered.
         */
        function announceJumpFailure(hit, reason) {
          if (typeof document === "undefined") return;
          clearJumpNote();
          try {
            var note = statsDiv("wsr-jump-toast wsr-jump-toast-warn");
            note.textContent = t(reason, { turn: String(hit.turn), turns: String(hit.turns) });
            document.body.appendChild(note);
            window.setTimeout(function () {
              if (note.parentElement !== null) note.remove();
            }, 5000);
          } catch (error) {
            /* nothing to do if the toast itself fails */
          }
        }

        /** Ring the row the search sent the user to, without taking keyboard focus. */
        function flashTurnRow(row) {
          try {
            if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "center" });
          } catch (error) {
            /* some engines only accept the boolean form */
          }
          try {
            row.setAttribute("data-wsr-flash", "true");
            window.setTimeout(function () {
              if (row.getAttribute("data-wsr-flash") !== null) row.removeAttribute("data-wsr-flash");
            }, 2600);
          } catch (error) {
            /* the conversation may have been replaced while we waited */
          }
        }

        /**
         * Bring one turn of one session into view.
         *
         * The chat mounts recent turns first and loads older history as the
         * scroller approaches its top, so this walks the scroller upwards until
         * the turn exists, then centres it. Every step is DOM-only: nothing here
         * steals focus or synthesises keystrokes.
         */
        function revealTurn(sessionId, turn) {
          if (typeof document === "undefined" || !isFinite(turn)) return;
          var deadline = Date.now() + 8000;
          var steps = 0;
          var tick = function () {
            if (Date.now() > deadline) return;
            if (currentConversationId() !== sessionId) {
              window.setTimeout(tick, 150);
              return;
            }
            var row = turnRowOf(turn);
            if (row !== null) {
              flashTurnRow(row);
              return;
            }
            var scroller = conversationScroller();
            if (scroller === null) {
              window.setTimeout(tick, 150);
              return;
            }
            if (steps >= 24) {
              window.setTimeout(tick, 300);
              return;
            }
            steps += 1;
            var height = typeof scroller.clientHeight === "number" && scroller.clientHeight > 0 ? scroller.clientHeight : 600;
            var top = Number(scroller.scrollTop) || 0;
            scroller.scrollTop = Math.max(0, top - Math.max(240, height * 0.8));
            window.setTimeout(tick, 260);
          };
          window.setTimeout(tick, 120);
        }

        /** Collapsed text of an element, for matching a message fragment. */
        function normalizedText(node) {
          var text = node !== null && node !== undefined && typeof node.textContent === "string" ? node.textContent : "";
          return text.replace(/\s+/g, " ").trim();
        }

        /**
         * The smallest element in the transcript that holds this fragment.
         *
         * The conversation view renders no per-turn anchor (`data-chat-turn` does
         * not exist in it), so text is the only handle a jump has. The needle is
         * retried in shorter pieces because markdown rendering can split or drop
         * parts of a long sentence.
         */
        function findByText(scroller, seeks) {
          if (scroller === null) return null;
          var candidates = Array.isArray(seeks) ? seeks : (typeof seeks === "string" ? [seeks] : []);
          if (candidates.length === 0) return null;
          var probes = [];
          for (var c = 0; c < candidates.length; c += 1) {
            var needle = String(candidates[c] || "").replace(/\s+/g, " ").trim();
            if (needle === "") continue;
            probes.push(needle);
            if (needle.length > 34) probes.push(needle.slice(0, 34));
            if (needle.length > 16) probes.push(needle.slice(0, 16));
          }
          /* Walk the turn rows, not every element: one `textContent` read per row
             is a few dozen reads, where sweeping `querySelectorAll("*")` over a
             126-turn transcript is tens of thousands and freezes the panel. */
          var rows = [];
          try {
            var found = scroller.querySelectorAll("[data-chat-turn]");
            for (var r = 0; r < found.length && r < 400; r += 1) rows.push(found[r]);
          } catch (error) {
            rows = [];
          }
          for (var p = 0; p < probes.length; p += 1) {
            var probe = probes[p].trim();
            if (probe === "") continue;
            for (var q = 0; q < rows.length; q += 1) {
              if (normalizedText(rows[q]).indexOf(probe) !== -1) return rows[q];
            }
          }
          return null;
        }
        /**
         * Whether a turn row actually carries the matched text.
         *
         * A very long session renders its old turns through a lighter path than
         * the recent ones - the per-message action bar is absent - and that path
         * may hold a collapsed placeholder instead of the message body. Landing on
         * one of those scrolls somewhere useless, so a row is only trusted when
         * the matched text (or at least a real block of text) is inside it.
         */
        function rowCarriesSeek(row, seeks) {
          if (row === null || row === undefined) return false;
          var text = normalizedText(row);
          var candidates = Array.isArray(seeks) ? seeks : (typeof seeks === "string" ? [seeks] : []);
          for (var i = 0; i < candidates.length; i += 1) {
            var needle = String(candidates[i] || "").replace(/\s+/g, " ").trim();
            if (needle === "") continue;
            if (text.indexOf(needle) !== -1) return true;
            if (needle.length > 20 && text.indexOf(needle.slice(0, 20)) !== -1) return true;
          }
          /* No needle matched: any text still proves the row is rendered. */
          return text.length > 12;
        }
        
        
        /**
         * The rail mark for one turn, if that mark is actually on screen.
         *
         * The rail is part of the chat shell, and during a session switch two of
         * them can be in the document at once. Matching by turn number alone could
         * therefore click the departing session's rail and start a history load
         * nobody asked for, so the mark has to be visible to qualify.
         */
        function railMarkFor(turn) {
          var wanted = Number(turn);
          if (!isFinite(wanted)) return null;
          var marks = railMarks();
          for (var i = 0; i < marks.length; i += 1) {
            if (turnOfRailMark(marks[i]) !== wanted) continue;
            var rect = typeof marks[i].getBoundingClientRect === "function"
              ? marks[i].getBoundingClientRect()
              : null;
            if (rect === null || !(rect.height > 0) || !(rect.width > 0)) continue;
            return marks[i];
          }
          return null;
        }
        /**
         * The rail's own scroll container.
         *
         * A mark's parent is the marks list, not the scroller: scrolling the list
         * does nothing, so the ancestor that actually scrolls is what has to move.
         */
        function railList() {
          var marks = railMarks();
          if (marks.length === 0) return null;
          var node = marks[0].parentElement;
          while (node !== null && node !== undefined) {
            var scrolls = typeof node.scrollHeight === "number" && typeof node.clientHeight === "number"
              && node.scrollHeight > node.clientHeight && node.clientHeight > 0;
            if (scrolls) return node;
            node = node.parentElement;
          }
          return null;
        }

        /** The style rule the Custom Highlight API paints matches with. */
        var searchHighlightReady = false;

        function ensureSearchHighlight() {
          if (searchHighlightReady || typeof document === "undefined") return;
          searchHighlightReady = true;
          try {
            var style = document.createElement("style");
            style.setAttribute("data-wsr-search-highlight", "true");
            style.textContent = "::highlight(wsr-search-hit){background:rgba(245,197,66,.45);color:inherit}";
            if (document.head !== null && document.head !== undefined) document.head.appendChild(style);
          } catch (error) {
            /* without the rule the jump still scrolls; only the paint is lost */
          }
        }

        /** Text nodes under a root, for finding the query terms inside a message. */
        function textNodesIn(root, limit) {
          var out = [];
          var cap = typeof limit === "number" && limit > 0 ? limit : 3000;
          if (root === null || root === undefined) return out;
          if (typeof NodeFilter === "undefined" || typeof document.createTreeWalker !== "function") return out;
          try {
            var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
            while (out.length < cap && walker.nextNode() !== null) out.push(walker.currentNode);
          } catch (error) {
            return out;
          }
          return out;
        }
        /**
         * Paints the query's terms where they appear and centres the first one.
         *
         * Landing on the right turn is not enough: a long turn buries the match,
         * and reading it out of the chat by hand is what this panel exists to
         * avoid. The Custom Highlight API paints the ranges without touching the
         * React-managed DOM, so nothing is re-rendered or fought over.
         */
        function markHitTerms(terms) {
          if (typeof document === "undefined") return;
          var needles = [];
          for (var i = 0; i < (Array.isArray(terms) ? terms.length : 0); i += 1) {
            var term = String(terms[i] || "").toLowerCase();
            if (term !== "" && needles.indexOf(term) === -1) needles.push(term);
          }
          if (needles.length === 0) return;
          /* Four short attempts at most: every attempt walks text nodes, and a
             long transcript has enough of them that polling was felt as lag. */
          var attempts = 0;
          var tick = function () {
            attempts += 1;
            if (attempts > 2) return;
            var scroller = conversationScroller();
            if (scroller === null) {
              window.setTimeout(tick, 300);
              return;
            }
            var beganScan = Date.now();
            var nodes = textNodesIn(scroller, 1200);
            var ranges = [];
            for (var n = 0; n < nodes.length && ranges.length < 40; n += 1) {
              var node = nodes[n];
              var text = String(node.nodeValue || "");
              if (text === "") continue;
              var lower = text.toLowerCase();
              for (var k = 0; k < needles.length && ranges.length < 40; k += 1) {
                var from = 0;
                while (from < lower.length && ranges.length < 40) {
                  var at = lower.indexOf(needles[k], from);
                  if (at < 0) break;
                  try {
                    var range = document.createRange();
                    range.setStart(node, at);
                    range.setEnd(node, at + needles[k].length);
                    ranges.push(range);
                  } catch (error) {
                    /* a node the range API refuses is simply skipped */
                  }
                  from = at + needles[k].length;
                }
              }
            }
            if (ranges.length === 0) {
              if (attempts < 2) window.setTimeout(tick, 600);
              return;
            }
            var painted = false;
            try {
              /* `CSS` in this module is the plugin's stylesheet array, so the
                 DOM API has to be reached through `window`. */
              var cssApi = typeof window !== "undefined" && window !== null ? window.CSS : undefined;
              var HighlightCtor = typeof window !== "undefined" && window !== null ? window.Highlight : undefined;
              if (cssApi !== undefined && cssApi !== null && cssApi.highlights !== undefined && typeof HighlightCtor === "function") {
                ensureSearchHighlight();
                cssApi.highlights.set("wsr-search-hit", new HighlightCtor(ranges));
                painted = true;
                window.setTimeout(function () {
                  try {
                    cssApi.highlights.delete("wsr-search-hit");
                  } catch (error) {
                    /* the panel may have closed already */
                  }
                }, 12000);
              }
            } catch (error) {
              painted = false;
            }
            var spentScan = Date.now() - beganScan;
            if (spentScan > 120 && typeof window !== "undefined") window.__DSH_WSR_LAST_TAIL_MS__ = spentScan;
            var first = ranges[0];
            var holder = first !== undefined && first !== null
              && first.startContainer !== undefined && first.startContainer !== null
              ? first.startContainer.parentElement
              : null;
            if (holder !== null && holder !== undefined) flashTurnRow(holder);
            else if (!painted) window.setTimeout(tick, 300);
          };
          window.setTimeout(tick, 120);
        }        /**
         * Bring one search hit into view.
         *
         * Three routes, best first: a mounted `data-chat-turn` row (the chat keeps
         * one per flow item), the turn rail's own mark for that turn (it loads a
         * turn that is outside the window), and finally a proportional scroll plus
         * a text search, with the upward walk while older history loads.
         */
                /** The badge currently pinned to a rail cell, if any. */

                
                /**
         * Bring one search hit into view.
         *
         * Scrolling the transcript does not page older history in: the chat asks the
         * user to load it. Clicking the turn rail's mark for that turn does load it,
         * which is the route the host itself uses, so the rail is the primary path
         * here. Mounted rows and a text search remain as fallbacks.
         */
        /**
         * One last look after a rail click: the host is loading a whole page of
         * history, so nothing here may poll while that runs.
         */
        /**
         * Look for the landed turn, and keep looking while the host pages in.
         *
         * `settle` is what makes the progress note honest: it only turns into
         * "landed" once the turn is actually in the document.
         */
        /**
         * Watch for the landing and stop counting as soon as it happens.
         *
         * The row appearing is the landing: the host moves the viewport and mounts
         * the turn, and on a session whose turns hold dozens of steps the body can
         * take many more seconds to render than the move itself. Requiring the
         * matched text before declaring success reported "not found" for jumps that
         * had visibly worked, and kept the progress note counting to its deadline.
         */
        function settleJump(hit, terms, attempt, spentMs) {
          if (typeof document === "undefined") return;
          var seeks = Array.isArray(hit.seeks) ? hit.seeks : hit.seek;
          var row = turnRowOf(Number(hit.turn));
          if (row === null) {
            /* The row can be missing while the window is still being replaced; the
               text search is only a fallback for the case the row never appears. */
            var scroller = conversationScroller();
            if (scroller !== null) row = findByText(scroller, seeks);
          }
          if (row !== null) {
            clearJumpNote();
            flashTurnRow(row);
            announceJump(hit, false, spentMs);
            markHitTerms(terms);
            suppressedUntil = 0;
            schedule();
            return;
          }
          /* Roughly ten seconds: past that the host is not going to land it, and
             the note should stop pretending to know. */
          if (attempt < 14) {
            window.setTimeout(function () { settleJump(hit, terms, attempt + 1, spentMs); }, 700);
            return;
          }
          announceJumpFailure(hit, "search.jumpNoTurn");
        }

        /**
         * Bring one search hit into view.
         *
         * Scrolling does not page older history in; clicking the rail's cell for the
         * turn does, so that is the route. Everything else here is a cheap poll that
         * stops as soon as the click has been made - the landing is decided by
         * settleJump, not by this loop.
         */
        function revealHit(hit, terms) {
          if (typeof document === "undefined" || hit === null || hit === undefined) return;
          var sessionId = hit.sessionId;
          var turn = Number(hit.turn);
          var seeksNow = Array.isArray(hit.seeks) ? hit.seeks : hit.seek;
          var deadline = Date.now() + (Number(hit.turns) > 40 ? 15000 : 9000);
          var opened = false;
          var reportedStub = false;
          var pokes = 0;
          var ticks = 0;
          /* Wall time includes the host opening the session and loading its
             history; only the synchronous work in here belongs to this plugin. */
          var spentMs = 0;
          var tick = function () {
            var beganTick = Date.now();
            var result = tickOnce();
            spentMs += Date.now() - beganTick;
            return result;
          };
          var tickOnce = function () {
            if (Date.now() > deadline) {
              announceJumpFailure(hit, opened ? "search.jumpNoTurn" : "search.jumpNoSession");
              return;
            }
            if (currentConversationId() !== sessionId) {
              window.setTimeout(tick, 250);
              return;
            }
            opened = true;
            ticks += 1;
            var row = turnRowOf(turn);
            if (row !== null) {
              flashTurnRow(row);
              /* The row exists and holds words: that IS the landing. The seek text
                 is only how we would rather highlight it, and a snippet can differ
                 from the rendered text (trimmed, re-wrapped, markdown stripped). */
              if (rowCarriesSeek(row, seeksNow)) {
                announceJump(hit, false, spentMs);
                markHitTerms(terms);
                return;
              }
              if (normalizedText(row).length > 12) {
                announceJump(hit, false, spentMs);
                markHitTerms(terms);
                return;
              }
              /* An empty row is the host's collapsed placeholder: say so once and
                 stop, instead of polling on and then claiming the turn is missing. */
              if (!reportedStub) {
                reportedStub = true;
                announceJumpFailure(hit, "search.jumpCollapsed");
              }
              return;
            }
            /* Query the rail every other tick: it is a document-wide lookup. */
            if (ticks % 2 === 1) {
              var mark = railMarkFor(turn);
              if (mark !== null) {
                try {
                  /* The lookup above can straddle a switch, and clicking the wrong
                     session's rail would page history into a conversation nobody
                     asked about. */
                  if (currentConversationId() !== sessionId) {
                    window.setTimeout(tick, 200);
                    return;
                  }
                  mark.click();
                  /* The click starts a real history load; until it lands, the only
                     honest thing to say is that it is under way. */
                  announceJumpLoading(hit);
                  window.setTimeout(function () { settleJump(hit, terms, 0, spentMs); }, 900);
                  return;
                } catch (error) {
                  /* fall through */
                }
              }
            }
            /* The rail is virtualised too: nudge it so the wanted mark renders. */
            if (pokes < 4) {
              var list = railList();
              var turns = Number(hit.turns);
              if (list !== null && turn > 0 && turns > 0) {
                var span = Math.max(0, (Number(list.scrollHeight) || 0) - (Number(list.clientHeight) || 0));
                var ratio = Math.min(1, Math.max(0, (turn - 1) / Math.max(1, turns - 1)));
                scrollTo(list, span * ratio);
                pokes += 1;
                window.setTimeout(tick, 350);
                return;
              }
            }
            window.setTimeout(tick, 350);
          };
          window.setTimeout(tick, 200);
        }

        function jumpToSearchHit(hit, terms) {
          suspendPasses(12000);
          openSessionRow(hit.sessionId);
          revealHit(hit, terms);
        }

        /**
         * The chat's own turn rail: one button per turn, `data-index` + an
         * aria-label that names the turn. Clicking a mark is the official
         * navigation, and it also loads a turn that is not in the window yet.
         */
        function railMarks() {
          if (typeof document === "undefined") return [];
          var all = null;
          try {
            /* The rail's own frame first: the same collection, found without
               walking the whole document. */
            var frame = document.querySelector('[class*="_frame"]');
            var scopedAll = frame === null ? null : frame.querySelectorAll("button[data-index]");
            all = scopedAll !== null && scopedAll.length > 0 ? scopedAll : document.querySelectorAll("button[data-index]");
          } catch (error) {
            return [];
          }
          var marks = [];
          for (var i = 0; i < (all === null ? 0 : all.length); i += 1) {
            var button = all[i];
            var className = typeof button.className === "string" ? button.className : "";
            if (className.indexOf("_mark") === -1) continue;
            marks.push(button);
          }
          return marks;
        }

        /** The turn a rail mark points at: the last integer in its label. */
        /**
         * The turn a rail mark points at.
         *
         * The label starts with the turn number ("Jump to turn 3", "跳转到第 3 轮");
         * any count a wording appends comes later, so the first integer is the turn.
         * A label that carries a count instead of a turn would make the FIRST match
         * wrong in exactly the same way the LAST one was, so both are tried and the
         * mark's own order breaks the tie.
         */
        function turnOfRailMark(button) {
          if (button === null || button === undefined || typeof button.getAttribute !== "function") return NaN;
          var label = String(button.getAttribute("aria-label") || "");
          var found = label.match(/\d+/);
          return found === null ? NaN : Number(found[0]);
        }

        /** Click the rail mark for one turn, if it is currently rendered. */
        function jumpViaRail(turn) {
          var wanted = Number(turn);
          if (!isFinite(wanted)) return false;
          var marks = railMarks();
          for (var i = 0; i < marks.length; i += 1) {
            if (turnOfRailMark(marks[i]) !== wanted) continue;
            try {
              marks[i].click();
              return true;
            } catch (error) {
              return false;
            }
          }
          return false;
        }

        /** Snippet text with every query term wrapped in a mark. */
        function highlightSnippet(snippet, terms) {
          var text = typeof snippet === "string" ? snippet : "";
          var lower = text.toLowerCase();
          var ranges = [];
          for (var i = 0; i < terms.length; i += 1) {
            var term = String(terms[i] || "").toLowerCase();
            if (term === "") continue;
            var from = 0;
            while (from < lower.length) {
              var at = lower.indexOf(term, from);
              if (at < 0) break;
              ranges.push({ start: at, end: at + term.length });
              from = at + term.length;
            }
          }
          ranges.sort(function (a, b) { return a.start - b.start; });
          var pieces = [];
          var cursor = 0;
          for (var j = 0; j < ranges.length; j += 1) {
            var range = ranges[j];
            if (range.start < cursor) continue;
            if (range.start > cursor) pieces.push(h("span", { key: "t" + j }, text.slice(cursor, range.start)));
            pieces.push(h("mark", { key: "m" + j, className: "wsr-mark" }, text.slice(range.start, range.end)));
            cursor = range.end;
          }
          if (cursor < text.length) pieces.push(h("span", { key: "tail" }, text.slice(cursor)));
          return pieces;
        }

        /**
         * The search page: one input, one list of hits.
         *
         * The host answers with the sessions it managed to index inside its time
         * budget plus how many are still pending, so this asks again until the
         * index has caught up instead of making the user press search twice.
         */
        /** A session id is a UUID; the head and tail are what tells two apart. */
        function shortSessionId(sessionId) {
          if (typeof sessionId !== "string" || sessionId === "") return "";
          return sessionId.length > 12 ? sessionId.slice(0, 8) + "\u2026" + sessionId.slice(-4) : sessionId;
        }

        /**
         * One search hit.
         *
         * A hit is only useful if it says which conversation and when: the
         * workspace narrows it down, but two sessions in one workspace read the
         * same without a title and a timestamp.
         */
        function searchHitRow(hit, terms, onClick, extra) {
          var title = typeof hit.title === "string" && hit.title.trim() !== ""
            ? hit.title.trim()
            : (typeof hit.sessionId === "string" ? shortSessionId(hit.sessionId) : "");
          var when = formatWhen(Number(hit.at) || 0);
          return h("div", {
            className: "wsr-hit",
            title: [title, hit.cwd || ""].filter(function (part) { return part !== ""; }).join("\n"),
            onClick: onClick,
          },
            /*
             * The row sits under its workspace band and its session band, so it repeats
             * neither the title nor the path: what differs between hits is the role, the
             * turn, when it was said, and the words themselves.
             */
            h("div", { className: "wsr-hit-head" },
              h("span", { className: "wsr-hit-role " + (hit.role === "user" ? "wsr-hit-user" : "wsr-hit-agent") }, hit.role === "user" ? t("search.you") : t("search.assistant")),
              /* Where in the conversation this hit sits is the row's identity now:
                 the session and the workspace are the bands above it. */
              typeof hit.step === "number" && isFinite(hit.step)
                ? h("span", { className: "wsr-hit-title" }, t("search.turnWithStep", { turn: String(hit.turn), step: String(hit.step) }))
                : h("span", { className: "wsr-hit-title" }, t("search.turn", { n: String(hit.turn) })),
              when !== "" ? h("span", { className: "wsr-hit-time" }, when) : null,
            ),
            h("div", { className: "wsr-hit-snippet" },
              hit.lead === true ? "\u2026" : null,
              highlightSnippet(hit.snippet || "", terms),
              hit.tail === true ? "\u2026" : null,
            ),
            extra === undefined || extra === null ? null : extra,
          );
        }

/**
 * Workspace -> session -> turn.
 *
 * A flat list ordered by hit time answers "what matched" but not "where": the
 * same conversation can appear eight times between two other projects. Sessions
 * are ordered by when the session last moved (not by their newest hit), and the
 * hits inside a session by turn, so a conversation reads in the order it was
 * spoken.
 */
function groupHits(hits) {
  var list = Array.isArray(hits) ? hits : [];
  var byWorkspace = new Map();
  for (var i = 0; i < list.length; i += 1) {
    var hit = list[i];
    var key = typeof hit.workspace === "string" && hit.workspace !== ""
      ? hit.workspace
      : (typeof hit.cwd === "string" && hit.cwd !== "" ? baseName(hit.cwd) : "");
    if (!byWorkspace.has(key)) {
      byWorkspace.set(key, { key: key, path: typeof hit.cwd === "string" ? hit.cwd : "", sessions: [], hits: 0, newest: 0 });
    }
    var group = byWorkspace.get(key);
    group.hits += 1;
    var stamp = Number(hit.sessionAt) || Number(hit.at) || 0;
    if (stamp > group.newest) group.newest = stamp;
    var session = null;
    for (var j = 0; j < group.sessions.length; j += 1) {
      if (group.sessions[j].sessionId === hit.sessionId) {
        session = group.sessions[j];
        break;
      }
    }
    if (session === null) {
      session = {
        sessionId: hit.sessionId,
        title: typeof hit.title === "string" ? hit.title : "",
        turns: Number(hit.turns) || 0,
        at: stamp,
        hits: [],
      };
      group.sessions.push(session);
    }
    if (stamp > session.at) session.at = stamp;
    session.hits.push(hit);
  }

  var groups = [];
  byWorkspace.forEach(function (group) {
    group.sessions.sort(function (a, b) { return b.at - a.at; });
    for (var k = 0; k < group.sessions.length; k += 1) {
      group.sessions[k].hits.sort(function (a, b) {
        var turnDiff = (Number(a.turn) || 0) - (Number(b.turn) || 0);
        if (turnDiff !== 0) return turnDiff;
        var stepDiff = (Number(a.step) || 0) - (Number(b.step) || 0);
        if (stepDiff !== 0) return stepDiff;
        return (Number(a.seq) || 0) - (Number(b.seq) || 0);
      });
    }
    groups.push(group);
  });
  groups.sort(function (a, b) { return b.newest - a.newest; });
  return groups;
}

/** A short, human session label: the title, else the id. */
function hitSessionLabel(session) {
  var title = typeof session.title === "string" ? session.title.trim() : "";
  if (title !== "") return title;
  return typeof session.sessionId === "string" ? shortSessionId(session.sessionId) : "";
}

        /**
         * One search hit, with the surrounding text on demand.
         *
         * Opening a hit in a long session makes the chat mount a page of history,
         * which can take seconds. Reading the hit does not have to: the host ships
         * the matched neighbourhood, so the row can show it where it stands.
         */
        function SearchHitRow(props) {
          var opened = react.useState(false);
          /* A hit far behind the newest turn means the host has to mount a lot of
             history to show it; asking first keeps a search from stalling the app
             for ten seconds without warning. */
          var cold = props.coldAfter > 0
            && Number(props.hit.turns) - Number(props.hit.turn) > props.coldAfter;
          var go = function () {
            if (cold) {
              /* Showing the context here is cheaper and more readable than a
                 modal, and the row's own button is the explicit "jump anyway". */
              opened[1](true);
              announceColdHint(props.hit);
              return;
            }
            if (typeof props.onJump === "function") props.onJump();
          };
          var context = typeof props.hit.context === "string" ? props.hit.context : "";
          var extra = context === "" ? null : [
            h("div", { className: "wsr-hit-actions" },
              h("button", {
                type: "button",
                className: "wsr-hit-context-toggle",
                onClick: function (event) {
                  if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
                  opened[1](opened[0] !== true);
                },
              }, opened[0] === true ? t("search.contextHide") : t("search.contextShow")),
              h("button", {
                type: "button",
                className: "wsr-hit-context-jump",
                onClick: function (event) {
                  if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
                  /* Pressing this is the confirmation. */
                  if (typeof props.onJump === "function") props.onJump();
                },
              }, t("search.openSession")),
            ),
            opened[0] === true
              ? h("div", { className: "wsr-hit-context" }, highlightSnippet(context, props.terms))
              : null,
          ];
          return searchHitRow(props.hit, props.terms, go, extra);
        }

        /**
         * One session, for a search that narrowed by title or workspace only.
         *
         * Without words there is nothing to point at inside a transcript, so the
         * useful answer is the session itself: its title, where it lives, and when.
         */
        function SearchSessionRow(props) {
          var item = props.item;
          var when = formatWhen(Number(item.at) || 0);
          return h("div", {
            className: "wsr-hit wsr-session-hit",
            title: item.title || "",
            onClick: function () {
              if (typeof props.onOpen === "function") props.onOpen();
            },
          },
            h("div", { className: "wsr-hit-head" },
              h("span", { className: "wsr-hit-title", title: item.title || "" }, item.title || props.shortId),
              typeof item.workspace === "string" && item.workspace !== "" ? h("span", { className: "wsr-hit-ws" }, item.workspace) : null,
            ),
            h("div", { className: "wsr-hit-meta" },
              when !== "" ? h("span", { className: "wsr-hit-time" }, when) : null,
              typeof item.cwd === "string" && item.cwd !== "" ? h("span", { className: "wsr-hit-cwd" }, item.cwd) : null,
            ),
            h("div", { className: "wsr-hit-actions" },
              h("button", {
                type: "button",
                className: "wsr-hit-context-jump",
                onClick: function (event) {
                  if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
                  if (typeof props.onOpen === "function") props.onOpen();
                },
              }, t("search.openSession")),
            ),
          );
        }


        /** Say why a cold hit opened its context instead of jumping. */
        function announceColdHint(hit) {
          if (typeof document === "undefined") return;
          try {
            var note = statsDiv("wsr-jump-toast");
            note.textContent = t("search.coldExpanded", {
              turn: String(hit.turn),
              behind: String(Math.max(0, Number(hit.turns) - Number(hit.turn))),
            });
            document.body.appendChild(note);
            window.setTimeout(function () {
              if (note.parentElement !== null) note.remove();
            }, 6000);
          } catch (error) {
            /* a toast is a nicety */
          }
        }

        function SearchPanelPage(props) {
          /* A previous build could leave its own backdrop behind; clear it. */
          try {
            var strays = document.querySelectorAll('[data-wsr-confirm="cold"]');
            for (var stray = 0; stray < strays.length; stray += 1) strays[stray].remove();
          } catch (error) {
            /* nothing to clean */
          }
          var state = react.useState(searchLast === null
            ? { loaded: false, query: "", hits: [], sessions: [], terms: [], scanned: 0, total: 0, pending: 0, took: 0, busy: false, error: "" }
            : searchLast);
          var view = state[0];
          var setView = state[1];
          /* The syntax hint is reference material, not a permanent line. */
          var help = react.useState(false);
          /* The recent-query list lives in the shared store, so it survives a
             restart and is the same list on every panel. */
          var preferences = props !== undefined && props !== null && typeof props.useStore === "function"
            ? props.useStore(function (snapshot) { return snapshot; })
            : (data.settings || {});
          var actions = props !== undefined && props !== null && props.actions !== undefined ? props.actions : {};
          var storedHistory = preferences !== null && preferences !== undefined
            && Array.isArray(preferences.searchHistory) ? preferences.searchHistory : [];
          var historyList = mergedHistory(storedHistory);
          /* 0 turns the question off and jumps straight away, as before. */
          var coldAfterRaw = Number(preferences !== null && preferences !== undefined ? preferences.coldJumpTurns : 0);
          var coldJumpTurns = Number.isFinite(coldAfterRaw) ? Math.max(0, Math.round(coldAfterRaw)) : DEFAULT_COLD_JUMP;
          /* Every update also parks the answer outside the component, so coming
             back from a hit restores the list instead of asking for a new search. */
          var commit = function (next) {
            searchLast = next;
            setView(next);
          };

          /* Changing a filter with a query on screen should show the effect at
             once instead of waiting for another Enter. */
          var rerun = function () {
            if (view.query !== "") run(view.query, false);
          };

          var run = function (text, refresh) {
            var query = typeof text === "string" ? text.trim() : "";
            searchGeneration += 1;
            var generation = searchGeneration;
            /* A filter alone is a question too: "which session was that?". */
            var hasFilters = searchFilters.workspace !== "" || searchFilters.session !== ""
              || searchFilters.role !== "";
            if (query === "" && !hasFilters) {
              commit({ loaded: true, query: "", hits: [], terms: [], scanned: 0, total: 0, pending: 0, took: 0, busy: false, error: "" });
              return;
            }
            var entry = {
              query: query,
              workspace: searchFilters.workspace,
              session: searchFilters.session,
              role: searchFilters.role,
            };
            if (typeof actions.pushSearch === "function") actions.pushSearch(entry);
            var entryKey = historyKey(entry);
            if (historyDropped[entryKey] === true) delete historyDropped[entryKey];
            var nextMirror = [historyEncode(entry)];
            for (var hi = 0; hi < searchHistoryMirror.length && nextMirror.length < SEARCH_HISTORY_MAX; hi += 1) {
              if (historyKey(searchHistoryMirror[hi]) === entryKey) continue;
              nextMirror.push(searchHistoryMirror[hi]);
            }
            searchHistoryMirror = nextMirror;
            historyCleared = false;
            commit({ loaded: true, query: query, hits: view.hits, terms: view.terms, scanned: view.scanned, total: view.total, pending: view.pending, took: view.took, busy: true, error: "" });
            var ask = function (needRefresh) {
              searchPost({
                query: query,
                refresh: needRefresh === true,
                workspace: searchFilters.workspace,
                session: searchFilters.session,
                role: searchFilters.role,
              }).then(function (answer) {
                if (generation !== searchGeneration) return;
                var json = answer.json;
                if (json === null || json.ok !== true) {
                  commit({ loaded: true, query: query, hits: [], terms: [], scanned: 0, total: 0, pending: 0, took: 0, busy: false, error: t("search.failed") + "HTTP " + answer.status });
                  return;
                }
                commit({
                  loaded: true,
                  query: query,
                  hits: Array.isArray(json.hits) ? json.hits : [],
                  sessions: Array.isArray(json.sessions) ? json.sessions : [],
                  terms: Array.isArray(json.terms) ? json.terms : [],
                  scanned: json.scanned || 0,
                  total: json.total || 0,
                  pending: json.pending || 0,
                  took: json.took || 0,
                  busy: false,
                  error: "",
                });
                if (json.pending > 0) {
                  window.setTimeout(function () {
                    if (generation === searchGeneration) ask(false);
                  }, 150);
                }
              }).catch(function (error) {
                if (generation !== searchGeneration) return;
                commit({ loaded: true, query: query, hits: [], terms: [], scanned: 0, total: 0, pending: 0, took: 0, busy: false, error: t("search.failed") + (error && error.message ? error.message : error) });
              });
            };
            ask(refresh === true);
          };

          var input = h("input", {
            className: "wsr-search-input",
            type: "search",
            placeholder: t("search.placeholder"),
            /* The box comes back with the query that produced the results below. */
            defaultValue: view.query || searchDraft,
            onChange: function (event) {
              searchDraft = event !== undefined && event.target !== undefined ? String(event.target.value || "") : "";
            },
            onKeyDown: function (event) {
              if (event !== undefined && event.key === "Enter") {
                if (typeof event.preventDefault === "function") event.preventDefault();
                run(searchDraft, false);
              }
            },
          });

          var sessionRows = (Array.isArray(view.sessions) ? view.sessions : []).map(function (item, index) {
            var row = h(SearchSessionRow, {
              item: item,
              shortId: shortSessionId(String(item.sessionId || "")),
              onOpen: function () { openSessionRow(item.sessionId); },
            });
            row.key = "session:" + String(item.sessionId || index);
            return row;
          });

          /*
           * Group by workspace, newest group first, newest hit inside each group.
           *
           * A flat list ordered only by time mixes a 130-turn session from one
           * project with a two-line one from another; which project a hit belongs to
           * is the first thing a reader needs, and the workspace name on every row was
           * not enough to see that boundary.
           */
          var grouped = groupHits(view.hits);
          var rows = [];
          for (var groupIndex = 0; groupIndex < grouped.length; groupIndex += 1) {
            (function (group) {
              var groupRow = h("div", { className: "wsr-search-group" },
                h("span", { className: "wsr-search-group-name", title: group.path }, group.key === "" ? t("search.noWorkspace") : group.key),
                h("span", { className: "wsr-search-group-count" }, t("search.groupCount", { n: String(group.hits) })),
              );
              groupRow.key = "group:" + group.key;
              rows.push(groupRow);

              for (var sessionIndex = 0; sessionIndex < group.sessions.length; sessionIndex += 1) {
                (function (session) {
                  var sessionRow = h("div", { className: "wsr-search-session" },
                    h("span", { className: "wsr-search-session-name" }, hitSessionLabel(session)),
                    Number(session.turns) >= LONG_SESSION_TURNS
                      ? h("span", { className: "wsr-hit-long", title: t("search.longHint") }, t("search.longBadge", { n: String(session.turns) }))
                      : null,
                    h("span", { className: "wsr-search-session-count" }, t("search.groupCount", { n: String(session.hits.length) })),
                  );
                  sessionRow.key = "session:" + String(session.sessionId) + ":" + String(sessionIndex);
                  rows.push(sessionRow);

                  for (var innerIndex = 0; innerIndex < session.hits.length; innerIndex += 1) {
                    (function (hit, index) {
                      var row = h(SearchHitRow, {
                        hit: hit,
                        terms: view.terms,
                        coldAfter: coldJumpTurns,
                        onJump: function () { jumpToSearchHit(hit, view.terms); },
                      });
                      row.key = String(hit.sessionId || "") + ":" + String(hit.seq || 0) + ":" + String(index);
                      rows.push(row);
                    })(session.hits[innerIndex], innerIndex);
                  }
                })(group.sessions[sessionIndex]);
              }
            })(grouped[groupIndex]);
          }
          return h("div", { className: "wsr-page wsr-search-page" },
            h("div", { className: "wsr-page-head" },
              h("div", { className: "wsr-page-heading" }, t("search.title")),
            ),
            h("div", { className: "wsr-search-toolbar" },
              h("div", { className: "wsr-filters" },
                h("label", { className: "wsr-filter" },
                  h("span", { className: "wsr-filter-label" }, t("search.filterWorkspace")),
                  h("select", {
                    className: "wsr-filter-select",
                    value: searchFilters.workspace,
                    onChange: function (event) {
                      searchFilters.workspace = event.target.value || "";
                      rerun();
                    },
                  },
                    h("option", { value: "" }, t("search.filterAll")),
                    (function () {
                      var items = data.workspaces !== null && data.workspaces !== undefined
                        && Array.isArray(data.workspaces.items) ? data.workspaces.items : [];
                      var options = [];
                      for (var wi = 0; wi < items.length; wi += 1) {
                        var name = typeof items[wi].name === "string" && items[wi].name !== ""
                          ? items[wi].name
                          : String(items[wi].title || "");
                        if (name === "") continue;
                        options.push(h("option", { value: name, key: "ws:" + name }, name));
                      }
                      return options;
                    })(),
                  ),
                ),
                h("label", { className: "wsr-filter" },
                  h("span", { className: "wsr-filter-label" }, t("search.filterSession")),
                  h("input", {
                    type: "text",
                    key: "wsr-filter-session:" + String(filterEpoch),
                    className: "wsr-filter-input",
                    defaultValue: searchFilters.session,
                    placeholder: t("search.filterSessionPlaceholder"),
                    onChange: function (event) {
                      searchFilters.session = String(event.target.value || "").trim();
                    },
                    onKeyDown: function (event) {
                      if (event !== undefined && event.key === "Enter") {
                        event.preventDefault();
                        rerun();
                      }
                    },
                  }),
                ),
                h("span", { className: "wsr-filter" },
                  h("span", { className: "wsr-filter-label" }, t("search.filterRole")),
                  h("span", { className: "wsr-seg" },
                    (function () {
                      var roles = [
                        ["", "search.filterAll"],
                        ["user", "search.you"],
                        ["assistant", "search.assistant"],
                      ];
                      var buttons = [];
                      for (var ri = 0; ri < roles.length; ri += 1) {
                        (function (value, label) {
                          buttons.push(h("button", {
                            type: "button",
                            key: "role:" + value,
                            className: "wsr-seg-item" + (searchFilters.role === value ? " wsr-seg-item-on" : ""),
                            onClick: function () {
                              searchFilters.role = value;
                              rerun();
                            },
                          }, t(label)));
                        })(roles[ri][0], roles[ri][1]);
                      }
                      return buttons;
                    })(),
                  ),
                ),
              ),
              h("button", {
                type: "button",
                className: "wsr-help" + (help[0] === true ? " wsr-help-on" : ""),
                title: t("search.hint"),
                "aria-label": t("search.hint"),
                onClick: function () { help[1](help[0] !== true); },
              }, "?"),
            ),
            help[0] === true ? h("div", { className: "wsr-search-hint" }, t("search.hint")) : null,
            h("div", { className: "wsr-search-bar" },
              input,
              h("button", { type: "button", className: "wsr-btn wsr-btn-primary", onClick: function () { run(searchDraft, false); } }, t("search.run")),
            ),
            h("div", { className: "wsr-search-history" },
              h("span", { className: "wsr-search-history-label" }, t("search.history")),
              historyList.map(function (item, index) {
                var entry = historyEntry(item);
                var label = historyLabel(entry);
                return h("span", { className: "wsr-search-chip", key: historyKey(entry) + ":" + String(index) },
                  h("button", {
                    type: "button",
                    className: "wsr-search-chip-run",
                    title: t("search.historyRun", { query: label }),
                    onClick: function () {
                      /* Restore the scope too: the words alone would answer a
                         different question than the one that was asked. */
                      searchFilters.workspace = entry.workspace;
                      searchFilters.session = entry.session;
                      searchFilters.role = entry.role;
                      filterEpoch += 1;
                      searchDraft = entry.query;
                      run(entry.query, false);
                    },
                  }, label),
                  h("button", {
                    type: "button",
                    className: "wsr-search-chip-drop",
                    title: t("search.historyDrop"),
                    "aria-label": t("search.historyDrop"),
                    onClick: function (event) {
                      if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
                      if (typeof actions.dropSearch === "function") actions.dropSearch(entry);
                      var dropKey = historyKey(entry);
                      historyDropped[dropKey] = true;
                      searchHistoryMirror = searchHistoryMirror.filter(function (item) {
                        return historyKey(item) !== dropKey;
                      });
                      commit(Object.assign({}, view));
                    },
                  }, "\u00d7"),
                );
              }),
              historyList.length === 0
                ? h("span", { className: "wsr-search-history-empty" }, t("search.historyEmpty"))
                : null,
              h("button", {
                type: "button",
                className: "wsr-search-history-clear",
                onClick: function () {
                  if (typeof actions.clearSearches === "function") actions.clearSearches();
                  searchHistoryMirror = [];
                  historyDropped = {};
                  historyCleared = true;
                  commit(Object.assign({}, view));
                },
              }, t("search.historyClear")),
            ),
            h("div", { className: "wsr-search-status" },
              view.busy ? t("search.searching") : null,
              view.error !== "" ? view.error : null,
              view.pending > 0 ? t("search.indexing", { n: String(view.pending) }) : null,
              view.loaded && !view.busy && view.error === ""
                ? t("search.summary", { hits: String(view.hits.length), sessions: String(view.total), ms: String(view.took) })
                : null,
            ),
            view.loaded && !view.busy && view.hits.length === 0 && sessionRows.length === 0
              ? h("div", { className: "wsr-page-note" }, t("search.empty"))
              : null,
            sessionRows.length > 0
              ? h("div", { className: "wsr-page-list" },
                h("div", { className: "wsr-search-group" }, t("search.sessionResults", { n: String(sessionRows.length) })),
                sessionRows,
              )
              : null,
            sessionRows.length === 0 ? h("div", { className: "wsr-page-list" }, rows) : null,
          );
        }

        /** The sidebar's trash entry glyph. */

        function TrashPanelIcon(props) {
          var Icon = ui.IconTrashOutlineRegular;
          if (typeof Icon !== "function") return null;
          var size = props !== undefined && props !== null && typeof props.size === "number" ? props.size : 16;
          return h(Icon, { size: size });
        }

        /** One switch: a title, what it costs to turn off, and the host's own toggle. */
        function FeatureRow(props) {
          var on = props.on === true;
          var Switch = ui.Switch;
          var control;
          if (typeof Switch === "function") {
            control = h(Switch, {
              checked: on,
              label: props.title,
              onChange: function () {
                if (typeof props.onToggle === "function") props.onToggle(props.id);
              },
            });
          } else {
            /* Older hosts without the primitive fall back to a plain button. */
            control = h("button", {
              type: "button",
              className: on ? "wsr-toggle wsr-toggle-on" : "wsr-toggle",
              "aria-pressed": on ? "true" : "false",
              "data-wsr-feature-toggle": props.id,
              onClick: function () {
                if (typeof props.onToggle === "function") props.onToggle(props.id);
              },
            }, t(on ? "features.on" : "features.off"));
          }
          return h("div", { className: "wsr-setRow", "data-wsr-feature": props.id },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, props.title),
              h("div", { className: "wsr-setDesc" }, props.description),
            ),
            h("div", { className: "wsr-controls", "data-wsr-feature-toggle": props.id }, control),
          );
        }        /** The package this section belongs to, as the plugin page names it. */
        var OUR_PACKAGE = "dsh-ws-recency";

        /** The package name a detail subject stands for, whichever shape it takes. */
        function subjectPackageName(subject) {
          if (subject === null || subject === undefined || typeof subject !== "object") return "";
          if (typeof subject.name === "string" && subject.name !== "") return subject.name;
          var pkg = subject.pkg;
          if (typeof pkg === "string") return pkg;
          if (pkg !== null && pkg !== undefined && typeof pkg === "object") {
            if (typeof pkg.name === "string") return pkg.name;
            if (typeof pkg.id === "string") return pkg.id;
          }
          var row = subject.row;
          if (row !== null && row !== undefined && typeof row === "object" && typeof row.package === "string") return row.package;
          return "";
        }

        /**
         * The plugin page's own section: every ability of this plugin, on or off.
         *
         * It renders nothing for another package's page, which is the contract for a
         * detail section.
         */
        function FeaturesSection(props) {
          var storeSettings = typeof props.useStore === "function" ? props.useStore(function (state) { return state; }) : data.settings;
          var name = subjectPackageName(props.subject);
          /* A row subject carries the package differently; accept both spellings. */
          if (name !== OUR_PACKAGE && String(name).indexOf(OUR_PACKAGE) !== 0) return null;

          /* A toggle is visible at once, even where the slot hands us no store hook. */
          var overrides = react.useState({});
          var valueOf = function (id) {
            var bag = overrides[0] || {};
            if (typeof bag[id] === "boolean") return bag[id];
            return featureOn(storeSettings, id);
          };
          var setAll = function (bag) { overrides[1](bag); };
          var toggle = function (id) {
            var next = {};
            var bag = overrides[0] || {};
            next[id] = !valueOf(id);
            setAll(Object.assign({}, bag, next));
            if (props.actions !== undefined) props.actions.setFeature(id);
          };
          var reset = function () {
            setAll({});
            if (props.actions !== undefined) props.actions.resetFeatures();
          };

          /* These two own a sidebar row, and a row is fixed at startup. */
          var boot = panelBoot;
          var waitsForRestart = function (id) {
            if (id !== "search" && id !== "trash") return false;
            if (boot === null) return false;
            return boot[id] !== valueOf(id);
          };
          var rows = FEATURE_IDS.map(function (id) {
            return h(FeatureRow, {
              key: id,
              id: id,
              title: t("features." + id + ".title"),
              description: waitsForRestart(id)
                ? t("features." + id + ".desc") + " " + t("features.restart")
                : t("features." + id + ".desc"),
              on: valueOf(id),
              onToggle: toggle,
            });
          });

          var onCount = FEATURE_IDS.filter(function (id) { return valueOf(id); }).length;
          return h("section", { className: "wsr-plugin-features", "data-wsr-features": OUR_PACKAGE },
            h("div", { className: "wsr-features-head" },
              h("div", { className: "wsr-features-title" }, t("features.title")),
              h("button", {
                type: "button",
                className: "wsr-btn",
                "data-wsr-features-reset": "true",
                onClick: reset,
              }, t("features.reset")),
            ),
            h("div", { className: "wsr-setNote" }, t("features.note")),
            rows,
            h("div", { className: "wsr-setNote" }, t("features.takesEffect", {
              on: String(onCount),
              all: String(FEATURE_IDS.length),
            })),
          );
        }        /**
         * The trash page itself: the plugin's trash (deleted logs) on top, the
         * Host's archive set (hidden sessions whose logs are still in place)
         * below. Both are "put away", so both are managed from here.
         */
        /** One entry as a card: badge, title, the numbers that matter, and actions. */
        /**
         * An action as an icon button.
         *
         * Text buttons in the card header squeezed the title to an ellipsis; an
         * icon says the same thing in 24px, and the label moves into the title
         * attribute so it is still discoverable on hover.
         */
        function iconButton(options) {
          var Icon = ui[options.icon];
          var label = options.label;
          var className = "wsr-icon-btn" + (options.danger === true ? " wsr-icon-btn-danger" : "");
          if (typeof Icon !== "function") {
            /* An older UI package without this glyph: keep the action usable. */
            return h("button", {
              type: "button",
              className: (options.danger === true ? "wsr-btn wsr-btn-danger" : "wsr-btn") + " wsr-icon-fallback",
              title: label,
              onClick: options.onClick,
            }, label);
          }
          /* One frame for every icon. The glyph artwork has its own intrinsic
             aspect (archive, trash and refresh outlines differ), so a raw `size`
             made neighbouring buttons look different sizes. */
          return h("button", {
            type: "button",
            className: className,
            title: label,
            "aria-label": label,
            onClick: options.onClick,
          }, h("span", { className: "wsr-icon-btn-glyph" }, h(Icon, { size: 14 })));
        }

        /**
         * One entry as a card.
         *
         * The section heading already says "deleted" or "archived", so no badge
         * repeats it. Every action lives in one row at the bottom of the card,
         * right-aligned: one row is one right edge, so nothing can drift, and the
         * title keeps the full width.
         */
        function entryCard(options) {
          var safeActions = options.actions === null || options.actions === undefined ? [] : options.actions;
          var actions = [];
          for (var i = 0; i < safeActions.length; i += 1) actions.push(safeActions[i]);
          if (options.danger !== null && options.danger !== undefined) actions.push(options.danger);
          return h("div", { className: "wsr-card", key: options.key, title: options.titleAttr || "" },
            h("div", { className: "wsr-card-head" },
              h("div", { className: options.titleClass || "wsr-card-title" }, options.title),
            ),
            options.chips.length > 0
              ? h("div", { className: "wsr-chips" }, options.chips.map(function (text, index) {
                return h("span", { className: "wsr-chip", key: String(index) }, text);
              }))
              : null,
            typeof options.path === "string" && options.path !== ""
              ? h("div", { className: "wsr-card-path" }, options.path)
              : null,
            actions.length > 0
              ? h("div", { className: "wsr-card-actions wsr-card-actions-row" }, actions)
              : null,
          );
        }

        function TrashPanelPage() {
          var state = react.useState({ loaded: false, entries: [], archived: [], note: "", failed: "" });
          var view = state[0];
          var setView = state[1];

          var load = function (note) {
            /* The two listings are independent: a Host without the archive route
               still gets a working trash, so failures are reported per section. */
            return Promise.all([trashPost({ action: "list" }), trashPost({ action: "archived" })]).then(function (answers) {
              var trash = answers[0];
              var archive = answers[1];
              var entries = [];
              var archived = [];
              /* One error line: the trash failure is the one that matters, an
                 archive-only failure still explains itself below. */
              var failed = "";
              if (trash.json === null || trash.json.ok !== true) {
                failed = t("trash.failed") + "HTTP " + trash.status + " \u00b7 " + (trash.text || "").slice(0, 120);
              } else {
                entries = Array.isArray(trash.json.entries) ? trash.json.entries : [];
              }
              if (archive.json !== null && archive.json.ok === true) {
                archived = Array.isArray(archive.json.entries) ? archive.json.entries : [];
              } else if (typeof archive.json === "object" && archive.json !== null && typeof archive.json.error === "string" && archive.json.error.indexOf("unknown action") !== -1) {
                /* An older host half: no archive section, not an error. */
                archived = null;
              } else if (failed === "") {
                failed = t("archive.failed") + "HTTP " + archive.status + " \u00b7 " + (archive.text || "").slice(0, 120);
              }
              setView({ loaded: true, entries: entries, archived: archived, note: note === undefined ? "" : note, failed: failed });
            }).catch(function (error) {
              setView({ loaded: true, entries: [], archived: [], note: "", failed: t("trash.failed") + (error && error.message ? error.message : error) });
            });
          };

          react.useEffect(function () { load(""); }, []);

          var act = function (entry, action) {
            var question = action === "restore"
            ? (Number(entry.groupSize) > 1 && (entry.parentSession === null || entry.parentSession === undefined)
              ? t("trash.confirmRestoreGroup", { n: String((Number(entry.groupSize) || 1) - 1) })
              : t("trash.confirmRestore"))
            : t("trash.confirmPurge");
            askConfirm(question, function () {
              load(t("trash.working"));
              trashPost({ action: action, name: entry.name }).then(function (result) {
                var ok = result.json !== null && result.json.ok === true;
                load(ok ? (action === "restore" ? t("trash.restored") : t("trash.purged")) : t("trash.failed") + (result.json && result.json.error ? result.json.error : result.text));
              }).catch(function (error) {
                load(t("trash.failed") + (error && error.message ? error.message : error));
              });
            });
          };

          var actArchived = function (entry, action) {
            var question = action === "unarchive" ? t("archive.confirmUnarchive")
              : action === "detach" ? t("archive.confirmDetach")
                : action === "forget" ? t("archive.confirmForget")
                  : t("archive.confirmDelete");
            /* Scheduled tasks outlive the log: say so before the user acts. */
            var taskCount = Number(entry.tasks) || 0;
            if (action !== "unarchive" && taskCount > 0) {
              var names = Array.isArray(entry.taskTitles) && entry.taskTitles.length > 0
                ? "：" + entry.taskTitles.join("、")
                : "";
              question += "\n\n" + t("archive.tasksWarning", { n: String(taskCount), names: names });
            }

            askConfirm(question, function () {
              load(t("trash.working"));
              trashPost({ action: action, sessionId: entry.sessionId }).then(function (result) {
                if (result.json === null || result.json.ok !== true) {
                  load(t("archive.failed") + (result.json && result.json.error ? result.json.error : result.text));
                  return;
                }
                if (action === "unarchive") {
                  load(t("archive.unarchived") + (result.json.listed === false ? t("archive.noWorkspace") : ""));
                } else if (action === "detach") {
                  load(t("archive.detached"));
                } else if (action === "forget") {
                  load(t("archive.forgotten"));
                } else {
                  load(t("archive.deleted"));
                }
              }).catch(function (error) {
                load(t("archive.failed") + (error && error.message ? error.message : error));
              });
            });
          };

          var rows = [];
          for (var i = 0; i < view.entries.length; i += 1) {
            (function (entry) {
              var chips = [];
              if (entry.turns > 0) chips.push(t("trash.turns") + " " + entry.turns);
              if (entry.steps > 0) chips.push(t("trash.steps") + " " + entry.steps);
              if (entry.tokens > 0) chips.push(formatTokens(entry.tokens) + " tokens");
              chips.push(formatBytes(entry.sizeBytes));
              /* A move leaves its old log here too; it is not a deleted session. */
              if (entry.reason === "move") chips.push(t("trash.reason.move"));
              var groupSize = Number(entry.groupSize) || 1;
              if (groupSize > 1) {
                if (entry.parentSession === null || entry.parentSession === undefined) {
                  chips.push(t("trash.groupParent", { n: String(groupSize - 1) }));
                } else {
                  chips.push(t("trash.groupChild"));
                }
              }
              var when = formatWhen(entry.at);
              if (when !== "") chips.push(when);
              var actions = [];
              if (entry.restorable === true) {
                actions.push(iconButton({
                  icon: "IconRefreshOutlineRegular",
                  label: t("trash.restore"),
                  onClick: function () { act(entry, "restore"); },
                }));
              }
              var hasTitle = typeof entry.title === "string" && entry.title !== "";
              rows.push(entryCard({
                key: entry.name,
                titleClass: hasTitle ? "wsr-card-title" : "wsr-card-title wsr-card-title-id",
                title: hasTitle ? entry.title : (entry.sessionId === null ? entry.name : entry.sessionId),
                titleAttr: entry.sessionId === null ? entry.name : entry.sessionId,
                chips: chips,
                path: entry.cwd,
                danger: iconButton({
                  icon: "IconCloseOutlineRegular",
                  label: t("trash.purge"),
                  danger: true,
                  onClick: function () { act(entry, "purge"); },
                }),
                actions: actions,
              }));
            })(view.entries[i]);
          }

          var archivedRows = [];
          var archivedList = Array.isArray(view.archived) ? view.archived : [];
          for (var j = 0; j < archivedList.length; j += 1) {
            (function (entry) {
              var chips = [];
              if (entry.turns > 0) chips.push(t("trash.turns") + " " + entry.turns);
              if (entry.steps > 0) chips.push(t("trash.steps") + " " + entry.steps);
              if (entry.tokens > 0) chips.push(formatTokens(entry.tokens) + " tokens");
              chips.push(formatBytes(entry.sizeBytes));
              var when = formatWhen(entry.lastAt !== 0 ? entry.lastAt : entry.createdAt);
              if (when !== "") chips.push(when);
              if (entry.blank === true) chips.push(t("archive.blank"));
              var hasTitle = typeof entry.title === "string" && entry.title !== "";
              /* A log that is gone can only be detached from the archive set;
                 the other three actions would all fail with "session not found". */
              var missing = entry.missing === true;
              archivedRows.push(entryCard({
                key: entry.sessionId,
                titleClass: hasTitle ? "wsr-card-title" : "wsr-card-title wsr-card-title-id",
                title: hasTitle ? entry.title : entry.sessionId,
                titleAttr: entry.sessionId,
                chips: chips,
                path: typeof entry.workspacePath === "string" && entry.workspacePath !== "" ? entry.workspacePath : entry.cwd,
                /* The destructive action stays alone on the title line; the safe
                   ones sit in the corner with the rest of the card actions. */
                danger: missing
                  ? null
                  : iconButton({
                    icon: "IconCloseOutlineRegular",
                    label: t("archive.forget"),
                    danger: true,
                    onClick: function () { actArchived(entry, "forget"); },
                  }),
                actions: missing
                  ? [iconButton({
                    icon: "IconArchiveOffOutlineRegular",
                    label: t("archive.detach"),
                    onClick: function () { actArchived(entry, "detach"); },
                  })]
                  : [
                    iconButton({
                      icon: "IconRefreshOutlineRegular",
                      label: t("archive.unarchive"),
                      onClick: function () { actArchived(entry, "unarchive"); },
                    }),
                    iconButton({
                      icon: "IconTrashOutlineRegular",
                      label: t("archive.delete"),
                      onClick: function () { actArchived(entry, "delete"); },
                    }),
                  ],
              }));
            })(archivedList[j]);
          }

          var archiveSection = view.archived === null ? null : [
            h("div", { className: "wsr-page-section", key: "archive-head" },
              h("span", null, t("trash.section.archived")),
              h("span", { className: "wsr-page-count" }, String(archivedList.length)),
            ),
            archivedList.length === 0
              ? h("div", { className: "wsr-page-note", key: "archive-empty" }, t("archive.empty"))
              : h("div", { className: "wsr-card-grid", key: "archive-list" }, archivedRows),
            h("div", { className: "wsr-page-note", key: "archive-note" }, t("archive.description")),
          ];

          return h("div", { className: "wsr-page" },
            h("div", { className: "wsr-page-head" },
              h("div", { className: "wsr-page-heading" }, t("trash.title")),
              h("button", {
                type: "button",
                className: "wsr-btn",
                onClick: function () { load(""); },
              }, t("ui.refresh")),
              h("button", {
                type: "button",
                className: "wsr-btn",
                onClick: function () { reloadButton().click(); },
              }, t("ui.reload")),
            ),
            view.note !== "" ? h("div", { className: "wsr-page-note" }, view.note) : null,
            view.failed !== "" ? h("div", { className: "wsr-page-note wsr-page-error" }, view.failed) : null,
            !view.loaded ? h("div", { className: "wsr-page-note" }, t("trash.loading"))
              : [
                h("div", { className: "wsr-page-section", key: "trash-head" },
                  h("span", null, t("trash.section.trash")),
                  h("span", { className: "wsr-page-count" }, String(view.entries.length)),
                ),
                view.entries.length === 0
                  ? h("div", { className: "wsr-page-note", key: "trash-empty" }, t("trash.empty"))
                  : h("div", { className: "wsr-card-grid", key: "trash-list" }, rows),
                h("div", { className: "wsr-page-note", key: "trash-note" }, t("trash.note")),
                archiveSection,
              ],
          );
        }

        
        /**
         * Re-attach sessions that belong to no workspace.
         *
         * General Settings is the host's own page, so this repair action lives in
         * our trash panel instead of posing as a shell preference there.
         */
        function adoptUnlistedSessions(done) {
          fetch("/ws-recency/session-adopt", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
            .then(function (response) {
              return response.text().then(function (text) {
                var parsed = null;
                try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
                return { status: response.status, text: text, json: parsed };
              });
            })
            .then(function (answer) {
              if (answer.json !== null && answer.json.ok === true) {
                var count = Array.isArray(answer.json.adopted) ? answer.json.adopted.length : 0;
                var cleaned = typeof answer.json.cleaned === "number" ? answer.json.cleaned : 0;
                var text = t("adopt.done", { n: count });
                if (cleaned > 0) text += t("adopt.cleaned", { n: cleaned });
                done(text);
                return;
              }
              done(t("adopt.failed") + (answer.json && answer.json.error ? answer.json.error : answer.text.slice(0, 120)));
            })
            .catch(function (error) {
              done(t("adopt.failed") + (error && error.message ? error.message : error));
            });
        }

        /** Settings -> General row: the global pinned section on/off. */
        function PinSectionRow(props) {
          var settings = props.useStore(function (state) { return state; });
          var enabled = settings.pinnedSection !== false;
          var text = t("pin.title");
          return h("div", { className: "wsr-setRow" },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, text),
              h("div", { className: "wsr-setDesc" }, t("pin.description")),
            ),
            h("div", { className: "wsr-controls" },
              h("label", { className: "wsr-exempt" },
                h("input", {
                  type: "checkbox",
                  checked: enabled,
                  onChange: function (event) { props.actions.setPinnedSection(event.target.checked); },
                }),
                t("pin.enabled")),
            ),
          );
        }

        /**
         * Settings -> General row: whether a tool's argument tokens count as tool
         * consumption or as the agent's own writing.
         */
        function ArgModeRow(props) {
          var settings = props.useStore(function (state) { return state; });
          var agentMode = settings.argMode === "agent";
          return h("div", { className: "wsr-setRow" },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, t("argmode.title")),
              h("div", { className: "wsr-setDesc" }, t("argmode.description")),
            ),
            h("div", { className: "wsr-controls" },
              h("label", { className: "wsr-exempt" },
                h("input", {
                  type: "checkbox",
                  checked: agentMode,
                  onChange: function (event) { props.actions.setArgMode(event.target.checked ? "agent" : "tool"); },
                }),
                t("argmode.enabled")),
            ),
          );
        }

        function shutdown() {
          disposed = true;
          if (timer !== null) window.clearTimeout(timer);
          timer = null;
          if (ticker !== null) window.clearInterval(ticker);
          ticker = null;
          if (observer !== null) observer.disconnect();
          observer = null;
          written.forEach(function (section) {
            if (section.style !== undefined) section.style.order = "";
            if (section.getAttribute(RANK_ATTR) !== null) section.removeAttribute(RANK_ATTR);
          });
          written.clear();
          hidden.forEach(function (element) {
            if (element.removeAttribute !== undefined) element.removeAttribute(HIDDEN_ATTR);
          });
          hidden.clear();
          toggles.forEach(function (button) { button.remove(); });
          toggles.clear();
          dots.forEach(function (dot) { dot.remove(); });
          dots.clear();
          pinHidden.forEach(function (element) {
            if (element.removeAttribute !== undefined) element.removeAttribute(PIN_HIDDEN_ATTR);
          });
          pinHidden.clear();
          if (pinHost !== null && pinHost.parentElement !== null) pinHost.remove();
          if (composerPill !== null && typeof composerPill.remove === "function") composerPill.remove();
          composerPill = null;
          pinHost = null;
          expandClicks.clear();
          roots.forEach(function (root) { root.removeAttribute(ROOT_ATTR); });
          roots.clear();
          var marked = document.querySelectorAll("[" + STATE_ATTR + "]");
          for (var m = 0; m < marked.length; m += 1) marked[m].removeAttribute(STATE_ATTR);
          expandedSections.clear();
          var tag = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
          if (tag !== null) tag.remove();
        }

        var inject = ["slots", "locale"];

        function apply_(ctx) {
          installCss();
          /* The turn rail's cells carry no text, and the host's own hover preview
             shows a turn's prompt (a number appears only when that prompt is
             empty). Labelling belongs to the search feature, so it is off with
             it. */
          /* Navigation and unpinning live in the Workspace UI service. It can be
             provided after this plugin applies, so take it now when it is there and
             let cordis hand it over later when it is not. Never fail the plugin over
             it: workspaceService() also retries at use time. */
          data.ctx = ctx;
          try { data.service = ctx.get("uiWorkspace") || null; } catch (error) { data.service = null; }
          try {
            if (typeof ctx.inject === "function") {
              ctx.inject(["uiWorkspace"], function (workspaceCtx) {
                try { data.service = workspaceCtx.uiWorkspace || null; } catch (error) { /* the lazy path covers it */ }
              });
            }
          } catch (error) {
            /* an older client runtime without per-service inject */
          }
          var prefs = clientStore.defineStore({
            init: function () {
              return { enabled: true, foldDays: DEFAULT_DAYS, keepActive: true, colors: true, pinnedSection: true, argMode: "tool", followUps: {}, searchHistory: [], coldJumpTurns: DEFAULT_COLD_JUMP, features: {} };
            },
            persist: "dsh.ws-recency.prefs.v1",
            actions: {
              setEnabled: function (draft, value) { draft.enabled = value === true; },
              setKeepActive: function (draft, value) { draft.keepActive = value === true; },
              setColors: function (draft, value) { draft.colors = value === true; },
              setPinnedSection: function (draft, value) { draft.pinnedSection = value === true; },
              setArgMode: function (draft, value) { draft.argMode = value === "agent" ? "agent" : "tool"; },
              setFeature: function (draft, name) {
                if (FEATURE_IDS.indexOf(String(name)) === -1) return;
                if (draft.features === null || draft.features === undefined || typeof draft.features !== "object") draft.features = {};
                draft.features[String(name)] = !featureOn(draft, String(name));
              },
              resetFeatures: function (draft) {
                draft.features = {};
              },
              setColdJumpTurns: function (draft, value) {
                var next = Number(value);
                if (!Number.isFinite(next)) return;
                draft.coldJumpTurns = Math.min(MAX_COLD_JUMP, Math.max(0, Math.round(next)));
              },
              setFoldDays: function (draft, value) {
                var next = Number(value);
                if (!Number.isFinite(next)) return;
                draft.foldDays = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(next)));
              },
              toggleFollowUp: function (draft, sessionId) {
                if (typeof sessionId !== "string" || sessionId === "") return;
                if (draft.followUps === null || typeof draft.followUps !== "object") draft.followUps = {};
                if (draft.followUps[sessionId] === undefined) draft.followUps[sessionId] = Date.now();
                else delete draft.followUps[sessionId];
              },
              clearFollowUp: function (draft, sessionId) {
                if (draft.followUps === null || typeof draft.followUps !== "object") return;
                if (draft.followUps[sessionId] !== undefined) delete draft.followUps[sessionId];
              },
              /* One entry per distinct search, newest first; identical searches
                 move to the front instead of appearing twice. */
              pushSearch: function (draft, entry) {
                var item = historyEntry(entry);
                if (item.query === "" && item.workspace === "" && item.session === "" && item.role === "") return;
                var list = Array.isArray(draft.searchHistory) ? draft.searchHistory : [];
                var key = historyKey(item);
                var next = [historyEncode(item)];
                for (var i = 0; i < list.length && next.length < SEARCH_HISTORY_MAX; i += 1) {
                  if (historyKey(list[i]) === key) continue;
                  next.push(historyEncode(list[i]));
                }
                draft.searchHistory = next;
              },
              dropSearch: function (draft, entry) {
                var key = historyKey(entry);
                var list = Array.isArray(draft.searchHistory) ? draft.searchHistory : [];
                draft.searchHistory = list.filter(function (item) {
                  return historyKey(item) !== key;
                });
              },
              clearSearches: function (draft) {
                draft.searchHistory = [];
              },
            },
          });

          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: ZH, en: EN });
          }, "dsh-ws-recency: dictionaries");

          /* The statistics renderer is plain DOM, not a slot component: keep the
             store handle so it can read the argument-mode preference live. */

          prefsStore = prefs;

          if (typeof MutationObserver === "function" && top() !== null) {
            observer = new MutationObserver(function (records) {
              if (passesSuspended()) return;
              /* One relevant record is enough: the pass itself is the expensive
                 part, and it always looks at the whole sidebar. */
              var list = Array.isArray(records) ? records : [];
              var chain = sidebarChain();
              for (var i = 0; i < list.length; i += 1) {
                if (outsideSidebar(list[i] === undefined || list[i] === null ? null : list[i].target, chain)) {
                  schedule();
                  return;
                }
              }
            });
            observer.observe(top(), {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: [BUSY_RANK_ATTR, "data-row-key", "aria-expanded", "aria-selected"],
            });
          }

          ctx.slots.inject("shell.overlay", function () {
            return ctx.slots.register({
              name: "shell.overlay",
              id: "ws-recency",
              order: 5,
              store: prefs,
              locale: NS,
            }, Sorter);
          });

          ctx.slots.inject("settings.general.item", function () {
            return ctx.slots.register({
              name: "settings.general.item",
              id: "ws-recency",
              order: 45,
              store: prefs,
              locale: NS,
            }, withFeature(SettingsRow, "sidebar"));
          });

          ctx.slots.inject("settings.general.item", function () {
            return ctx.slots.register({
              name: "settings.general.item",
              id: "ws-recency-cold-jump",
              order: 45,
              store: prefs,
              locale: NS,
            }, withFeature(ColdJumpRow, "search"));
          });

          ctx.slots.inject("settings.general.item", function () {
            return ctx.slots.register({
              name: "settings.general.item",
              id: "ws-recency-colors",
              order: 46,
              store: prefs,
              locale: NS,
            }, withFeature(ColorsRow, "sidebar"));
          });

          if (SEARCH_ENABLED) {
            

            ctx.slots.inject("main", function () {
              return ctx.slots.register({
                name: "main",
                key: "ws-recency-search",
                locale: NS,
                store: prefs,
              }, withFeature(SearchPanelPage, "search"));
            });
          }



          

          ctx.slots.inject("plugins.detail.section", function () {
            return ctx.slots.register({
              name: "plugins.detail.section",
              id: "ws-recency-features",
              order: 60,
              store: prefs,
              locale: NS,
            }, FeaturesSection);
          });

          ctx.slots.inject("main", function () {
            return ctx.slots.register({
              name: "main",
              key: "ws-recency-trash",
              store: prefs,
              locale: NS,
            }, withFeature(TrashPanelPage, "trash"));
          });

          ctx.slots.inject("settings.general.item", function () {
            return ctx.slots.register({
              name: "settings.general.item",
              id: "ws-recency-pins",
              order: 47,
              store: prefs,
              locale: NS,
            }, withFeature(PinSectionRow, "sidebar"));
          });

          ctx.slots.inject("settings.general.item", function () {
            return ctx.slots.register({
              name: "settings.general.item",
              id: "ws-recency-argmode",
              order: 48,
              store: prefs,
              locale: NS,
            }, withFeature(ArgModeRow, "stats"));
          });

          ctx.slots.inject("conversation.chat.assistant-actions", function () {
            return ctx.slots.register({
              name: "conversation.chat.assistant-actions",
              id: "ws-recency-handoff",
              order: 20,
              store: prefs,
              locale: NS,
              inject: function (sessionId) { return { sessionId: sessionId }; },
            }, withFeature(HandoffTurnAction, "handoff"));
          });

          ctx.slots.inject("conversation.chat.turnTail", function () {
            return ctx.slots.register({
              name: "conversation.chat.turnTail",
              id: "ws-recency-handoff-card",
              order: 30,
              store: prefs,
              locale: NS,
              inject: function (sessionId) { return { sessionId: sessionId }; },
            }, withFeature(HandoffTailCard, "handoff"));
          });

          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "ws-recency",
              order: MENU_ORDER,
              store: prefs,
              locale: NS,
            }, withFeature(FollowUpMenuItem, "followUp"));
          });

          ctx.slots.inject("sidebar.session.row.leading", function () {
            return ctx.slots.register({
              name: "sidebar.session.row.leading",
              id: "ws-recency",
              order: 400,
              store: prefs,
              locale: NS,
            }, withFeature(FollowUpDot, "followUp"));
          });

          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "ws-recency-move",
              order: 690,
              store: prefs,
              locale: NS,
            }, withFeature(MoveMenuItem, "move"));
          });





          /*
           * Search and trash own a sidebar row, and a row is decided by the host at
           * registration time. So they are registered here, from the settings read out of
           * storage: registering them later, from a render, left the trash row without its
           * panel page. A switch for one of these two therefore applies on the next start,
           * and the plugin page says exactly that.
           */
          var bootFeatures = readStoredFeatures();
          panelBoot = {
            search: featureOn({ features: bootFeatures || {} }, "search"),
            trash: featureOn({ features: bootFeatures || {} }, "trash"),
          };
          if (panelBoot.search) {
            ctx.slots.inject("sidebar.panellist", function () {
              return ctx.slots.register({
                name: "sidebar.panellist",
                id: "ws-recency-search",
                order: 19,
                store: prefs,
                locale: NS,
                label: function () { return t("search.title"); },
              }, SearchPanelIcon);
            });
            ctx.slots.inject("main", function () {
              return ctx.slots.register({
                name: "main",
                key: "ws-recency-search",
                store: prefs,
                locale: NS,
              }, SearchPanelPage);
            });
          }
          if (panelBoot.trash) {
            ctx.slots.inject("sidebar.panellist", function () {
              return ctx.slots.register({
                name: "sidebar.panellist",
                id: "ws-recency-trash",
                order: 20,
                store: prefs,
                locale: NS,
                label: function () { return t("trash.title"); },
              }, TrashPanelIcon);
            });
            ctx.slots.inject("main", function () {
              return ctx.slots.register({
                name: "main",
                key: "ws-recency-trash",
                store: prefs,
                locale: NS,
              }, TrashPanelPage);
            });
          }
          ctx.effect(function () {
            return function () { shutdown(); };
          }, "dsh-ws-recency: list observer");

          if (typeof window.setInterval === "function") ticker = window.setInterval(schedule, TICK_MS);
          schedule();
        }

        /* Test hook: the card state is a module observable, invisible from outside. */
        exports.__handoff = {
          current: currentHandoffState,
          set: setHandoffState,
          blockOf: handoffBlockOf,
          readyOf: handoffAnswerReady,
          start: startHandoff,
          rewrite: rewriteHandoff,
          carry: carryHandoff,
          send: sendToSession,
        };

        /* Test hook: the jump and the highlighting are pure DOM helpers. */
        /* The statistics panel no longer has a menu row; tests open it here. */
        /* What the sidebar bound at startup: the page reads it to say "restart". */
        exports.__features = {
          boot: function () { return panelBoot; },
          readStored: readStoredFeatures,
        };

        exports.__stats = { open: openStatsPanel, close: closeStatsPanel };

        exports.__search = {
          groupHits: groupHits,
          draft: function () { return searchDraft; },
          highlight: highlightSnippet,
          reveal: revealTurn,
          jump: jumpToSearchHit,
          turnRow: turnRowOf,
          hitRow: searchHitRow,
          shortId: shortSessionId,
          resumePasses: function () { suppressedUntil = 0; },
          filters: function () { return searchFilters; },
          resetHistoryMirror: function () { searchHistoryMirror = []; historyDropped = {}; historyCleared = false; },
          encodeSearch: historyEncode,
          decodeSearch: historyEntry,
          searchLabel: historyLabel,
        };

        /* The search feature ships disabled while its cost is being isolated;
           tests turn it on so the code stays covered. */
        exports.__setSearchEnabled = function (value) {
          SEARCH_ENABLED = value === true;
        };

        exports.name = "dsh-ws-recency";
        exports.inject = inject;
        exports.apply = apply_;
        return module.exports;
      },
    });
  } catch (error) {
    console.warn("[dsh-ws-recency] client half failed to load:", error);
  }
})();
