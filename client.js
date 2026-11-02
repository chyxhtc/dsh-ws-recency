/**
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
        /** Safety stop for driving the host's own "show more" (5 rows per click). */
        var MAX_EXPAND_CLICKS = 40;
        var TICK_MS = 5 * 60 * 1000;

        var data = { sessions: null, workspaces: null, settings: null, statuses: null, actions: null, service: null, t: null };
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
        var expandClicks = new Map();
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
          ".wsr-pin-unpin:hover{color:var(--dsw-alias-label-primary)}",
          ".wsr-modal-backdrop{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}",
          ".wsr-modal{width:min(720px,92vw);max-height:84vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1f2226);color:var(--dsw-alias-label-primary,#e8e8e8);border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden}",
          ".wsr-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}",
          ".wsr-modal-title{font-size:14px;font-weight:600}",
          ".wsr-modal-close{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:4px}",
          ".wsr-modal-close:hover{color:var(--dsw-alias-label-primary,#e8e8e8)}",
          ".wsr-modal-body{padding:14px;overflow:auto;display:flex;flex-direction:column;gap:12px;font-size:12px}",
          ".wsr-stats-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}",
          ".wsr-stats-card{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));border-radius:8px;padding:8px 10px}",
          ".wsr-stats-value{font-size:15px;font-weight:600}",
          ".wsr-stats-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-stats-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.06)}",
          ".wsr-stats-seg{height:100%}",
          ".wsr-stats-legend{display:flex;flex-wrap:wrap;gap:10px}",
          ".wsr-stats-legend-item{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-stats-swatch{width:8px;height:8px;border-radius:2px}",
          ".wsr-stats-table{display:flex;flex-direction:column}",
          ".wsr-stats-row{display:grid;grid-template-columns:1.4fr .6fr .8fr .8fr .8fr .6fr;gap:6px;padding:6px 4px;border-bottom:.5px solid rgba(255,255,255,.06)}",
          ".wsr-stats-head{color:var(--dsw-alias-label-tertiary);font-size:11px}",
          ".wsr-td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
          ".wsr-td-name{font-weight:500}",
          ".wsr-td-strong{font-weight:600}",
          ".wsr-stats-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}",
          ".wsr-toggle{width:100%;height:28px;padding:0 12px 0 calc(28px + var(--dsh-workspace-indent,0px));cursor:pointer;text-align:left;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;font-size:12px}",
          ".wsr-toggle:hover{color:var(--dsw-alias-label-secondary)}",
          '[' + STATE_ATTR + '="running"] [class*="_title"]{color:#4f8ef7}',
          '[' + STATE_ATTR + '="unread"] [class*="_title"]{color:#3fae6b}',
          '[' + STATE_ATTR + '="followup"] [class*="_title"]{color:#d99a2b}',
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
          "settings.exempt": "\u9009\u4e2d / \u8fd0\u884c\u4e2d / \u7b49\u5f85\u5904\u7406\u7684\u4f1a\u8bdd\u4e0d\u6298\u53e0",
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
          "stats.col.args": "\u53c2\u6570",
          "stats.col.results": "\u7ed3\u679c",
          "stats.col.total": "\u4f30\u7b97",
          "stats.col.share": "\u5360\u6bd4",
          "stats.note": "\u5408\u8ba1\u6765\u81ea\u6bcf\u6b65\u8bb0\u5f55\u7684\u771f\u5b9e usage\uff08\u7f13\u5b58\u547d\u4e2d + \u8f93\u5165 + \u8f93\u51fa\uff09\uff1b\u672c\u8868\u6309\u6765\u6e90\u7684\u62c6\u5206\u662f\u6309\u5185\u5bb9\u957f\u5ea6\u4f30\u7b97\uff08\u4e2d\u6587\u7ea6 1 token/\u5b57\uff0c\u82f1\u6587\u7ea6 4 \u5b57\u7b26/token\uff09\uff0c\u7528\u4e8e\u6bd4\u8f83\u5360\u6bd4\uff0c\u4e0d\u662f\u8ba1\u8d39\u53e3\u5f84\u3002",
          "stats.agentDetail": "主 agent 构成：思考 {reasoning} · 回复 {text} · 用户消息 {user} · 系统提示 {system}",
          "stats.diagnose.unmounted": "\n\n（宿主半已加载，但统计路由没挂上——重启应用再试）",
          "stats.diagnose.noHost": "\n\n（宿主半未加载：需要重启应用加载新版本）",
          "trash.confirm": "\u5220\u9664\u8fd9\u4e2a\u4f1a\u8bdd\uff1f\n\n\u4f1a\u5148\u505c\u6b62\u5b83\u6b63\u5728\u8fdb\u884c\u7684\u5de5\u4f5c\uff0c\u518d\u628a\u65e5\u5fd7\u76ee\u5f55\u79fb\u5165\u56de\u6536\u7ad9\uff08\u4e0d\u662f\u7269\u7406\u5220\u9664\uff0c\u53ef\u4ee5\u624b\u52a8\u6062\u590d\uff09\u3002",
          "trash.failed": "\u5220\u9664\u5931\u8d25\uff1a",
        };
        var EN = {
          "settings.title": "Fold history after (days)",
          "settings.description": "Sessions with no update for this many days are folded; a workspace older than that shows as a bare header.",
          "settings.exempt": "Never fold the selected / running / waiting session",
          "fold.show": "Show history ({n})",
          "fold.hide": "Hide history",
          "color.title": "Colors and follow-up marks",
          "color.description": "Running = blue, finished-unopened = green, a session you marked as needing follow-up = amber. Mark it from the session's \"...\" menu.",
          "color.enabled": "Enable color marks",
          "pin.title": "Global pinned section",
          "pin.description": "Lists pinned sessions in one section above every workspace; unpinning sends a session back to its own group.",
          "pin.enabled": "Show the pinned section",
          "pin.head": "Pinned",
          "pin.unpin": "Unpin",
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
          "stats.col.args": "args",
          "stats.col.results": "results",
          "stats.col.total": "estimate",
          "stats.col.share": "share",
          "stats.note": "Totals come from the recorded per-step usage (cache read + input + output). The per-source split is estimated from content length (about 1 token per CJK character, 4 characters per token otherwise) so the shares are comparable, not billable.",
          "stats.agentDetail": "Agent composition: reasoning {reasoning} \u00b7 reply {text} \u00b7 user messages {user} \u00b7 system prompt {system}",
          "stats.diagnose.unmounted": "\n\n(the host half is loaded but the statistics route did not mount - restart the app and retry)",
          "stats.diagnose.noHost": "\n\n(the host half is not loaded: restart the app to pick up the new version)",
          "trash.confirm": "Delete this session?\n\nIt stops whatever the session is running, then moves the log directory into the trash folder (a move, not an erase: you can restore it by hand).",
          "trash.failed": "Delete failed: ",
        };

        var FALLBACK = { "fold.show": "Show history ({n})", "fold.hide": "Hide history" };

        function t(key, params) {
          if (typeof data.t === "function") {
            try { return data.t(key, params); } catch (error) { /* fall back below */ }
          }
          var text = FALLBACK[key] || key;
          if (params !== undefined && params.n !== undefined) text = text.replace("{n}", String(params.n));
          return text;
        }

        function top() {
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

            var expanded = expandedSections.has(entry.key);
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
              var exempt = settings.keepActive && (isActiveRow(row) || isSelectedRow(row));
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
            if (expanded) {
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

        function pinnedRowElement(item) {
          var row = document.createElement("div");
          row.className = "wsr-pin-row";
          row.setAttribute("data-row-key", "pin:" + item.id);
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
            if (data.service !== null && typeof data.service.unpinSession === "function") data.service.unpinSession(item.id);
            schedule();
          });
          row.appendChild(unpin);
          row.addEventListener("click", function () {
            if (data.service !== null && typeof data.service.openSession === "function") data.service.openSession(item.id);
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

        /**
         * Render the "pinned" section above every workspace group.
         *
         * It is a plain element inserted as the first child of the list container
         * (flex order -1), rebuilt only when the pinned set or its labels change. The
         * host keeps owning the list; the workspace grouping below is untouched.
         */
        function renderPinned(entries, sessions, workspaces, settings) {
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
            for (var i = 0; i < items.length; i += 1) pinHost.appendChild(pinnedRowElement(items[i]));
          }
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
        function decorateRows(entries, sessions, statuses, settings) {
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
            states[id] = running ? "running" : unread ? "unread" : flagged ? "followup" : null;
          }

          for (var i = 0; i < entries.length; i += 1) {
            var rows = rowElements(entries[i].section);
            for (var j = 0; j < rows.length; j += 1) {
              var row = rows[j];
              var sessionId = sessionIdOf(row);
              setRowState(row, sessionId === null ? null : states[sessionId] || null);
            }
          }
        }

        function apply() {
          if (disposed) return;
          var sessions = data.sessions;
          var workspaces = data.workspaces;
          if (!ready(sessions) || !ready(workspaces)) return;

          var settings = settingsOf();
          var entries = collect();
          if (entries.length === 0) return;

          orderGroups(entries, latestByWorkspace(sessions, workspaces));
          foldRows(entries, settings, sessions, Date.now());
          renderPinned(entries, sessions, workspaces, settings);
          if (settings.colors) decorateRows(entries, sessions, data.statuses, settings);
        }

        function schedule() {
          if (disposed || timer !== null) return;
          timer = window.setTimeout(function () {
            timer = null;
            try {
              apply();
            } catch (error) {
              console.warn("[dsh-ws-recency] pass failed:", error);
            }
          }, 0);
        }

        /** `shell.overlay` occupant; it renders no chrome of its own. */
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
          react.useEffect(function () { schedule(); });
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
          }, props.t(flagged ? "menu.unflag" : "menu.flag"));
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

        /**
         * Session "..." menu row: move the session into the trash folder.
         *
         * DSH itself only archives; the host half of this plugin stops the work,
         * detaches the bookkeeping and renames the log directory into
         * `<home>/.trash/ws-recency/`. The browser half only asks for confirmation
         * and posts the id.
         */
        function TrashMenuItem(props) {
          var Item = ui.MenuItemButton;
          if (typeof Item !== "function") return null;
          var Icon = ui.IconTrashOutlineRegular;
          return h(Item, {
            icon: typeof Icon === "function" ? h(Icon, {}) : undefined,
            onSelect: function () {
              var question = t("trash.confirm");
              var confirmed = typeof window.confirm === "function" ? window.confirm(question) : false;
              if (!confirmed) return;
              fetch("/ws-recency/session-trash?sessionId=" + encodeURIComponent(props.sessionId), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: props.sessionId }),
              })
                .then(function (response) {
                  return response.text().then(function (text) {
                    var parsed = null;
                    try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
                    return { status: response.status, text: text, json: parsed };
                  });
                })
                .then(function (result) {
                  if (result.json !== null && result.json.ok === true) return;
                  var reason = (result.json !== null && result.json.error) || (result.text || "").trim().slice(0, 120) || "(empty response)";
                  if (typeof window.alert === "function") window.alert(t("trash.failed") + "HTTP " + result.status + " \u00b7 " + reason);
                })
                .catch(function (error) {
                  if (typeof window.alert === "function") window.alert(t("trash.failed") + (error && error.message ? error.message : error));
                });
            },
          }, props.t("menu.trash"));
        }

        /* ------------------------- token statistics ------------------------- */

        var statsModal = null;

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

        /** One table row: source, calls, argument tokens, result tokens, total, share. */
        function statsRow(label, calls, args, results, total, share) {
          var row = document.createElement("div");
          row.className = "wsr-stats-row";
          var name = statsDiv("wsr-td wsr-td-name", label);
          row.appendChild(name);
          row.appendChild(statsDiv("wsr-td", calls === null ? "-" : String(calls)));
          row.appendChild(statsDiv("wsr-td", args === null ? "-" : formatTokens(args)));
          row.appendChild(statsDiv("wsr-td", results === null ? "-" : formatTokens(results)));
          row.appendChild(statsDiv("wsr-td wsr-td-strong", formatTokens(total)));
          row.appendChild(statsDiv("wsr-td", formatShare(share)));
          return row;
        }

        function renderStats(body, stats) {
          body.textContent = "";
          while (body.firstChild !== null) body.removeChild(body.firstChild);
          var totals = stats.totals || {};
          var estimate = stats.estimate || {};
          var agent = estimate.agent || {};

          var grid = document.createElement("div");
          grid.className = "wsr-stats-grid";
          var cards = [
            [t("stats.steps"), formatTokens(stats.steps)],
            [t("stats.input"), formatTokens(totals.inputTokens)],
            [t("stats.cache"), formatTokens(totals.cacheReadTokens)],
            [t("stats.output"), formatTokens(totals.outputTokens)],
            [t("stats.total"), formatTokens(totals.totalTokens)],
          ];
          for (var i = 0; i < cards.length; i += 1) {
            var card = statsDiv("wsr-stats-card");
            card.appendChild(statsDiv("wsr-stats-value", cards[i][1]));
            card.appendChild(statsDiv("wsr-stats-label", cards[i][0]));
            grid.appendChild(card);
          }
          body.appendChild(grid);

          var tools = estimate.tools || [];
          var palette = ["#d97706", "#059669", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#9333ea", "#dc2626"];
          var segments = [{ name: t("stats.agent"), share: agent.share || 0, color: "#4b8bf5" }];
          for (var j = 0; j < tools.length; j += 1) segments.push({ name: tools[j].name, share: tools[j].share || 0, color: palette[j % palette.length] });

          var bar = statsDiv("wsr-stats-bar");
          for (var k = 0; k < segments.length; k += 1) {
            if (segments[k].share <= 0) continue;
            var piece = statsDiv("wsr-stats-seg");
            piece.style.width = (segments[k].share * 100).toFixed(2) + "%";
            piece.style.background = segments[k].color;
            piece.setAttribute("title", segments[k].name + " " + formatShare(segments[k].share));
            bar.appendChild(piece);
          }
          body.appendChild(bar);

          var legend = statsDiv("wsr-stats-legend");
          for (var m = 0; m < segments.length; m += 1) {
            if (segments[m].share <= 0) continue;
            var item = statsDiv("wsr-stats-legend-item");
            var swatch = statsDiv("wsr-stats-swatch");
            swatch.style.background = segments[m].color;
            item.appendChild(swatch);
            item.appendChild(statsDiv("wsr-stats-legend-text", segments[m].name + " " + formatShare(segments[m].share)));
            legend.appendChild(item);
          }
          body.appendChild(legend);

          var table = statsDiv("wsr-stats-table");
          var head = document.createElement("div");
          head.className = "wsr-stats-row wsr-stats-head";
          var columns = ["stats.col.source", "stats.col.calls", "stats.col.args", "stats.col.results", "stats.col.total", "stats.col.share"];
          for (var n = 0; n < columns.length; n += 1) head.appendChild(statsDiv("wsr-td", t(columns[n])));
          table.appendChild(head);
          table.appendChild(statsRow(t("stats.agent"), stats.steps, null, null, agent.total, agent.share));
          for (var p = 0; p < tools.length; p += 1) {
            var tool = tools[p];
            table.appendChild(statsRow(tool.name, tool.calls, tool.args, tool.results, tool.total, tool.share));
          }
          body.appendChild(table);

          body.appendChild(statsDiv("wsr-stats-detail", t("stats.agentDetail", {
            reasoning: formatTokens(agent.reasoning),
            text: formatTokens(agent.text),
            user: formatTokens(agent.user),
            system: formatTokens(agent.system),
          })));
          body.appendChild(statsDiv("wsr-stats-note", t("stats.note")));
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

        /** Session "..." menu row: token statistics of that session. */
        function StatsMenuItem(props) {
          var Item = ui.MenuItemButton;
          if (typeof Item !== "function") return null;
          var Icon = ui.IconDataOutlineRegular;
          return h(Item, {
            icon: typeof Icon === "function" ? h(Icon, {}) : undefined,
            onSelect: function () { openStatsPanel(props.sessionId); },
          }, props.t("menu.stats"));
        }

        /** Settings -> General row: how old a session must be before it is folded. */
        function SettingsRow(props) {
          var settings = props.useStore(function (state) { return state; });
          var days = Number(settings.foldDays);
          if (!Number.isFinite(days)) days = DEFAULT_DAYS;
          var keep = settings.keepActive !== false;
          var text = props.t("settings.title");
          return h("div", { className: "wsr-setRow" },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, text),
              h("div", { className: "wsr-setDesc" }, props.t("settings.description")),
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
                props.t("settings.exempt")),
            ),
          );
        }

        /** Settings -> General row: color marks on/off. */
        function ColorsRow(props) {
          var settings = props.useStore(function (state) { return state; });
          var enabled = settings.colors !== false;
          var text = props.t("color.title");
          return h("div", { className: "wsr-setRow" },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, text),
              h("div", { className: "wsr-setDesc" }, props.t("color.description")),
            ),
            h("div", { className: "wsr-controls" },
              h("label", { className: "wsr-exempt" },
                h("input", {
                  type: "checkbox",
                  checked: enabled,
                  onChange: function (event) { props.actions.setColors(event.target.checked); },
                }),
                props.t("color.enabled")),
            ),
          );
        }

        /** Settings -> General row: the global pinned section on/off. */
        function PinSectionRow(props) {
          var settings = props.useStore(function (state) { return state; });
          var enabled = settings.pinnedSection !== false;
          var text = props.t("pin.title");
          return h("div", { className: "wsr-setRow" },
            h("div", { className: "wsr-setText" },
              h("div", { className: "wsr-setTitle" }, text),
              h("div", { className: "wsr-setDesc" }, props.t("pin.description")),
            ),
            h("div", { className: "wsr-controls" },
              h("label", { className: "wsr-exempt" },
                h("input", {
                  type: "checkbox",
                  checked: enabled,
                  onChange: function (event) { props.actions.setPinnedSection(event.target.checked); },
                }),
                props.t("pin.enabled")),
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
          try { data.service = ctx.get("uiWorkspace") || null; } catch (error) { data.service = null; }
          var prefs = clientStore.defineStore({
            init: function () {
              return { enabled: true, foldDays: DEFAULT_DAYS, keepActive: true, colors: true, pinnedSection: true, followUps: {} };
            },
            persist: "dsh.ws-recency.prefs.v1",
            actions: {
              setEnabled: function (draft, value) { draft.enabled = value === true; },
              setKeepActive: function (draft, value) { draft.keepActive = value === true; },
              setColors: function (draft, value) { draft.colors = value === true; },
              setPinnedSection: function (draft, value) { draft.pinnedSection = value === true; },
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
            },
          });

          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: ZH, en: EN });
          }, "dsh-ws-recency: dictionaries");

          if (typeof MutationObserver === "function" && top() !== null) {
            observer = new MutationObserver(schedule);
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
            }, SettingsRow);
          });

          ctx.slots.inject("settings.general.item", function () {
            return ctx.slots.register({
              name: "settings.general.item",
              id: "ws-recency-colors",
              order: 46,
              store: prefs,
              locale: NS,
            }, ColorsRow);
          });

          ctx.slots.inject("settings.general.item", function () {
            return ctx.slots.register({
              name: "settings.general.item",
              id: "ws-recency-pins",
              order: 47,
              store: prefs,
              locale: NS,
            }, PinSectionRow);
          });

          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "ws-recency",
              order: MENU_ORDER,
              store: prefs,
              locale: NS,
            }, FollowUpMenuItem);
          });

          ctx.slots.inject("sidebar.session.row.leading", function () {
            return ctx.slots.register({
              name: "sidebar.session.row.leading",
              id: "ws-recency",
              order: 400,
              store: prefs,
              locale: NS,
            }, FollowUpDot);
          });

          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "ws-recency-stats",
              order: 710,
              store: prefs,
              locale: NS,
            }, StatsMenuItem);
          });

          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "ws-recency-trash",
              order: 700,
              store: prefs,
              locale: NS,
            }, TrashMenuItem);
          });

          ctx.effect(function () {
            return function () { shutdown(); };
          }, "dsh-ws-recency: list observer");

          if (typeof window.setInterval === "function") ticker = window.setInterval(schedule, TICK_MS);
          schedule();
        }

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
