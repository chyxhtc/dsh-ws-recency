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
".wsr-page-head{display:flex;align-items:center;gap:8px}",
".wsr-page-heading{flex:1;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
".wsr-page-list{display:flex;flex-direction:column;gap:6px}",
".wsr-page-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}",
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
          ".wsr-chart{display:flex;flex-direction:column;gap:6px}",
          ".wsr-chart-title{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
          ".wsr-chart-row{display:grid;grid-template-columns:120px 1fr 64px 56px;align-items:center;gap:8px}",
          ".wsr-chart-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}",
          ".wsr-chart-track{height:8px;border-radius:4px;background:rgba(255,255,255,.06);overflow:hidden}",
          ".wsr-chart-fill{height:100%;border-radius:4px;min-width:2px}",
          ".wsr-chart-value{text-align:right;font-variant-numeric:tabular-nums}",
          ".wsr-chart-share{text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
          ".wsr-details-toggle{align-self:flex-start;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer;padding:2px 0}",
          ".wsr-details-toggle:hover{color:var(--dsw-alias-label-primary)}",
          ".wsr-stats-details{display:flex;flex-direction:column;gap:8px}",
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
          "menu.move": "移动到工作区…",
          "move.title": "移动到工作区",
          "move.warning": "只移动会话本身：它在旧工作区里创建或修改的文件不会跟着走，仍留在原目录。",
          "move.note": "会话属于哪个工作区，由它创建时的目录决定；移动会改写会话记录的 cwd，把日志搬到新工作区目录，旧日志备份在 .trash/ws-recency。",
          "move.confirm": "把会话移动到「{workspace}」？\n\n只移动会话记录，旧工作区里的文件不会跟着搬。",
          "move.current": "当前",
          "move.working": "移动中…（会先停止会话）",
          "move.done": "已移动到「{workspace}」。若列表没刷新，切换一下工作区或重启应用。",
          "move.doneLive": "\n\n这个会话刚才是打开状态：建议重启应用后再继续对话，避免它沿用旧的目录。",
          "move.repaired": "已补登记到「{workspace}」：上一次移动只搬了日志、没登记工作区，这次把它补上了。",
          "adopt.title": "补登记游离会话",
          "adopt.description": "修复会话归属：把“目录属于某工作区却不在任何分组”的会话挂回去，并把仍挂在旧工作区分组里的重复归属清掉。",
          "adopt.action": "扫描并刷新",
          "adopt.working": "扫描中…",
          "adopt.done": "已补登记 {n} 个会话。",
          "adopt.cleaned": "清理了 {n} 处重复/失效的工作区归属。",
          "adopt.failed": "扫描失败：",
          "ui.reload": "刷新界面",
          "ui.refresh": "刷新列表",
          "trash.title": "回收站",
          "trash.description": "被删除的会话会移到这里（日志目录），可以恢复，也可以彻底删除。",
          "trash.open": "打开",
          "trash.loading": "读取中…",
          "trash.empty": "回收站是空的。",
          "trash.reason.delete": "已删除",
          "trash.reason.move": "移动时的旧副本",
          "trash.restore": "恢复",
          "trash.purge": "彻底删除",
          "trash.confirmRestore": "恢复到原来的工作区？",
          "trash.confirmPurge": "彻底删除这份日志？不可恢复。",
          "trash.restored": "已恢复，并重新挂回原工作区。若侧栏还没出现，点下面的「刷新界面」，或在本页右上角点「扫描并刷新」。",
          "trash.purged": "已彻底删除。",
          "trash.working": "处理中…",
          "trash.failed": "操作失败：",
          "trash.note": "回收站里的都是完整日志目录；恢复会按记录的 cwd 放回 sessions/<项目> 并重新挂到对应工作区。",
          "trash.section.trash": "已删除的会话",
          "trash.section.archived": "已归档的会话",
          "archive.description": "归档是宿主的「视图选项 → 仅显示已归档」那一套：会话被隐藏，但日志仍在 sessions/ 里，原工作区的槽位也保留着。这里可以取消归档、移入回收站，或者彻底删除。",
          "archive.empty": "没有已归档的会话。",
          "archive.unarchive": "取消归档",
          "archive.delete": "移到回收站",
          "archive.forget": "彻底删除",
          "archive.confirmUnarchive": "把这个会话放回原工作区的原位置？",
          "archive.confirmDelete": "把这个会话移入回收站？之后仍可在上面一栏恢复。",
          "archive.confirmForget": "彻底删除这个会话的日志？不可恢复。",
          "archive.unarchived": "已取消归档，会话回到原来的位置。",
          "archive.deleted": "已移入回收站，可在「已删除的会话」里恢复。",
          "archive.forgotten": "已彻底删除。",
          "archive.failed": "归档操作失败：",
          "archive.noWorkspace": "（它原来的目录现在没有对应的工作区，需要先建一个同名工作区才能看到它）",
          "archive.blank": "空白草稿",
          "archive.workspace": "工作区",
          "move.failed": "移动失败：",
          "stats.chart": "消耗分布",
          "stats.details.show": "显示明细 ▾",
          "stats.details.hide": "收起明细 ▴",
          "composer.analysis": "用量分析",
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
          "menu.move": "Move to workspace\u2026",
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
          "ui.reload": "Reload UI",
          "ui.refresh": "Refresh",
          "trash.title": "Trash",
          "trash.description": "Deleted sessions land here (their log directory). Restore them, or delete them for good.",
          "trash.open": "Open",
          "trash.loading": "Loading\u2026",
          "trash.empty": "The trash is empty.",
          "trash.reason.delete": "deleted",
          "trash.reason.move": "old copy from a move",
          "trash.restore": "Restore",
          "trash.purge": "Delete for good",
          "trash.confirmRestore": "Restore it to its original workspace?",
          "trash.confirmPurge": "Delete this log for good? This cannot be undone.",
          "trash.restored": "Restored and re-attached to its workspace. If the sidebar has not picked it up, press \"Reload UI\" below, or use \"Scan and reload\" at the top right of this panel.",
          "trash.purged": "Deleted for good.",
          "trash.working": "Working\u2026",
          "trash.failed": "Action failed: ",
          "trash.note": "Every entry is a complete log directory; restoring puts it back under sessions/<project> using the recorded cwd and re-attaches it.",
          "trash.section.trash": "Deleted sessions",
          "trash.section.archived": "Archived sessions",
          "archive.description": "Archiving is the Host's own view filter (\"Show archived only\"): the session is hidden, but its log stays under sessions/ and its workspace still holds its slot. Unarchive it here, move it into the trash, or delete it for good.",
          "archive.empty": "No archived sessions.",
          "archive.unarchive": "Unarchive",
          "archive.delete": "Move to trash",
          "archive.forget": "Delete for good",
          "archive.confirmUnarchive": "Put this session back where it was in its workspace?",
          "archive.confirmDelete": "Move this session into the trash? You can still restore it from the section above.",
          "archive.confirmForget": "Delete this session's log for good? This cannot be undone.",
          "archive.unarchived": "Unarchived: the session is back in its place.",
          "archive.deleted": "Moved into the trash; restore it from \"Deleted sessions\".",
          "archive.forgotten": "Deleted for good.",
          "archive.failed": "Archive action failed: ",
          "archive.noWorkspace": " (its original directory has no workspace right now - create one with the same path to see it again)",
          "archive.blank": "blank draft",
          "archive.workspace": "workspace",
          "move.failed": "Move failed: ",
          "stats.chart": "Where the tokens went",
          "stats.details.show": "Show details",
          "stats.details.hide": "Hide details",
          "composer.analysis": "Usage analysis",
          "trash.confirm": "Delete this session?\n\nIt stops whatever the session is running, then moves the log directory into the trash folder (a move, not an erase: you can restore it by hand).",
          "trash.failed": "Delete failed: ",
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

        /** The session the conversation view is showing, from its own DOM hook. */
        function currentConversationId() {
          if (typeof document === "undefined") return null;
          var element = document.querySelector("[data-conversation-session]");
          if (element === null || typeof element.getAttribute !== "function") return null;
          var id = element.getAttribute("data-conversation-session");
          return typeof id === "string" && id !== "" ? id : null;
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
          renderPinned(entries, sessions, workspaces, settings);
          if (settings.colors) decorateRows(entries, sessions, data.statuses, settings);
          decorateComposerStats();
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
          }, t("menu.trash"));
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

        /**
         * Colour identity for a source.
         *
         * The tool set is open - every plugin and MCP server adds tools - so it
         * cannot be enumerated. A curated hue for the common tools plus a stable
         * hash for everything else keeps one name on one hue across sessions, and
         * the rank only modulates how vivid it is: the heaviest source reads
         * strongest, the tail fades back.
         */
        var TOOL_HUES = {
          pwsh: 32, powershell: 32, shell: 32, bash: 32, command: 32,
          read: 152, write: 217, edit: 268, grep: 190, glob: 88,
          todo_write: 292, todo_read: 292, todo: 292,
          job_output: 330, job_list: 330, job_kill: 330,
          web_fetch: 205, web_search: 205, platform_search: 205, multi_search: 205, advanced_search: 205,
          subagent: 250, subagent_fork: 250, workflow: 250, spawn_teammate: 250, send_message: 250, wait_agent: 250,
          ask_user_question: 12, present: 12,
          skill: 60, create_goal: 60, update_goal: 60,
        };
        var TOOL_PREFIX_HUES = [
          ["mcp__", 235],
          ["browser_", 0],
          ["univer_", 175],
          ["weknora_", 300],
          ["job_", 330],
          ["team_", 250],
        ];

        function hashHue(name) {
          var hash = 0;
          for (var i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
          return hash;
        }

        function sourceHue(name) {
          if (typeof name !== "string" || name === "") return 210;
          var key = name.toLowerCase();
          if (TOOL_HUES[key] !== undefined) return TOOL_HUES[key];
          for (var i = 0; i < TOOL_PREFIX_HUES.length; i += 1) {
            if (key.indexOf(TOOL_PREFIX_HUES[i][0]) === 0) return TOOL_PREFIX_HUES[i][1];
          }
          return hashHue(key);
        }

        /** Rank 0 is the heaviest source; later ranks fade towards grey. */
        function sourceColor(hue, rank) {
          var saturation = Math.max(40, 88 - rank * 8);
          var lightness = Math.min(64, 50 + rank * 2);
          return "hsl(" + hue + ", " + saturation + "%, " + lightness + "%)";
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
          var entries = [{ name: t("stats.agent"), value: agent.total || 0, share: agent.share || 0, color: sourceColor(217, 0) }];
          for (var j = 0; j < tools.length; j += 1) {
            entries.push({
              name: tools[j].name,
              value: tools[j].total || 0,
              share: tools[j].share || 0,
              color: sourceColor(sourceHue(tools[j].name), j + 1),
            });
          }

          /* The picture first: one bar per source, sized against the largest. */
          var chart = statsDiv("wsr-chart");
          chart.appendChild(statsDiv("wsr-chart-title", t("stats.chart")));
          var largest = 1;
          for (var m = 0; m < entries.length; m += 1) if (entries[m].value > largest) largest = entries[m].value;
          for (var k = 0; k < entries.length; k += 1) {
            var line = statsDiv("wsr-chart-row");
            line.appendChild(statsDiv("wsr-chart-label", entries[k].name));
            var track = statsDiv("wsr-chart-track");
            var fill = statsDiv("wsr-chart-fill");
            fill.style.width = ((entries[k].value / largest) * 100).toFixed(2) + "%";
            fill.style.background = entries[k].color;
            track.appendChild(fill);
            line.appendChild(track);
            line.appendChild(statsDiv("wsr-chart-value", formatTokens(entries[k].value)));
            line.appendChild(statsDiv("wsr-chart-share", formatShare(entries[k].share)));
            chart.appendChild(line);
          }
          body.appendChild(chart);

          /* The table is the detail view: folded away until asked for. */
          var toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "wsr-details-toggle";
          toggle.textContent = t("stats.details.show");

          var details = statsDiv("wsr-stats-details");
          details.style.display = "none";

          var table = statsDiv("wsr-stats-table");
          var head = document.createElement("div");
          head.className = "wsr-stats-row wsr-stats-head";
          var columns = ["stats.col.source", "stats.col.calls", "stats.col.args", "stats.col.results", "stats.col.total", "stats.col.share"];
          for (var n = 0; n < columns.length; n += 1) head.appendChild(statsDiv("wsr-td", t(columns[n])));
          table.appendChild(head);
          table.appendChild(statsRow(t("stats.agent"), stats.steps, null, null, agent.total, agent.share));
          for (var q = 0; q < tools.length; q += 1) {
            var tool = tools[q];
            table.appendChild(statsRow(tool.name, tool.calls, tool.args, tool.results, tool.total, tool.share));
          }
          details.appendChild(table);
          details.appendChild(statsDiv("wsr-stats-detail", t("stats.agentDetail", {
            reasoning: formatTokens(agent.reasoning),
            text: formatTokens(agent.text),
            user: formatTokens(agent.user),
            system: formatTokens(agent.system),
          })));

          toggle.addEventListener("click", function () {
            var open = details.style.display !== "none";
            details.style.display = open ? "none" : "";
            toggle.textContent = open ? t("stats.details.show") : t("stats.details.hide");
          });

          body.appendChild(toggle);
          body.appendChild(details);
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
                  if (typeof window.confirm !== "function" || !window.confirm(t("move.confirm", { workspace: label }))) return;
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
                      var reason = (result.json !== null && result.json.error) || (result.text || "").trim().slice(0, 160) || "(empty response)";
                      body.textContent = t("move.failed") + "HTTP " + result.status + " \u00b7 " + reason;
                    })
                    .catch(function (error) {
                      body.textContent = t("move.failed") + (error && error.message ? error.message : error);
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

        /** Session "..." menu row: token statistics of that session. */
        function StatsMenuItem(props) {
          var Item = ui.MenuItemButton;
          if (typeof Item !== "function") return null;
          var Icon = ui.IconDataOutlineRegular;
          return h(Item, {
            icon: typeof Icon === "function" ? h(Icon, {}) : undefined,
            onSelect: function () { openStatsPanel(props.sessionId); },
          }, t("menu.stats"));
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

        /** Modal: list the plugin's trash, restore an entry or delete it for good. */
        function openTrashPanel() {
          if (typeof document === "undefined") return;
          closeStatsPanel();
          var backdrop = statsDiv("wsr-modal-backdrop");
          var panel = statsDiv("wsr-modal");
          backdrop.appendChild(panel);
          var head = statsDiv("wsr-modal-head");
          head.appendChild(statsDiv("wsr-modal-title", t("trash.title")));
          var tools = statsDiv("wsr-modal-tools");
          var adopt = document.createElement("button");
          adopt.type = "button";
          adopt.className = "wsr-btn";
          adopt.title = t("adopt.description");
          adopt.textContent = t("adopt.action");
          tools.appendChild(adopt);
          var close = document.createElement("button");
          close.type = "button";
          close.className = "wsr-modal-close";
          close.textContent = "\u00d7";
          close.addEventListener("click", closeStatsPanel);
          tools.appendChild(close);
          head.appendChild(tools);
          panel.appendChild(head);
          var body = statsDiv("wsr-modal-body");
          panel.appendChild(body);
          backdrop.addEventListener("click", function (event) {
            if (event !== undefined && event.target === backdrop) closeStatsPanel();
          });
          document.body.appendChild(backdrop);
          statsModal = backdrop;
          document.addEventListener("keydown", onStatsKey);

          var post = function (payload) {
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
          };

          var load = function (note) {
            body.textContent = t("trash.loading");
            post({ action: "list" }).then(function (answer) {
              body.textContent = "";
              if (note !== undefined && note !== "") {
                body.appendChild(statsDiv("wsr-stats-detail", note));
                var noteActions = statsDiv("wsr-trash-actions");
                noteActions.appendChild(reloadButton());
                body.appendChild(noteActions);
              }
              if (answer.json === null || answer.json.ok !== true) {
                body.appendChild(statsDiv("wsr-stats-note", t("trash.failed") + "HTTP " + answer.status + " \u00b7 " + (answer.text || "").slice(0, 120)));
                return;
              }
              var entries = Array.isArray(answer.json.entries) ? answer.json.entries : [];
              if (entries.length === 0) {
                body.appendChild(statsDiv("wsr-stats-note", t("trash.empty")));
                return;
              }
              var list = statsDiv("wsr-move-list");
              for (var i = 0; i < entries.length; i += 1) {
                (function (entry) {
                  var row = document.createElement("div");
                  row.className = "wsr-trash-row";
                  var text = statsDiv("wsr-move-text");
                  var title = entry.sessionId === null ? entry.name : entry.sessionId;
                  text.appendChild(statsDiv("wsr-move-title", title));
                  var meta = [];
                  if (entry.reason === "delete") meta.push(t("trash.reason.delete"));
                  else if (entry.reason === "move") meta.push(t("trash.reason.move"));
                  meta.push(formatBytes(entry.sizeBytes));
                  var when = formatWhen(entry.at);
                  if (when !== "") meta.push(when);
                  text.appendChild(statsDiv("wsr-move-path", meta.join(" \u00b7 ")));
                  if (typeof entry.cwd === "string" && entry.cwd !== "") {
                    text.appendChild(statsDiv("wsr-move-path", entry.cwd));
                  }
                  row.appendChild(text);

                  var actions = statsDiv("wsr-trash-actions");
                  if (entry.restorable === true) {
                    var restore = document.createElement("button");
                    restore.type = "button";
                    restore.className = "wsr-btn";
                    restore.textContent = t("trash.restore");
                    restore.addEventListener("click", function () {
                      if (typeof window.confirm === "function" && !window.confirm(t("trash.confirmRestore"))) return;
                      load(t("trash.working"));
                      post({ action: "restore", name: entry.name }).then(function (result) {
                        var ok = result.json !== null && result.json.ok === true;
                        load(ok ? t("trash.restored") : t("trash.failed") + (result.json && result.json.error ? result.json.error : result.text));
                      }).catch(function (error) {
                        load(t("trash.failed") + (error && error.message ? error.message : error));
                      });
                    });
                    actions.appendChild(restore);
                  }
                  var purge = document.createElement("button");
                  purge.type = "button";
                  purge.className = "wsr-btn wsr-btn-danger";
                  purge.textContent = t("trash.purge");
                  purge.addEventListener("click", function () {
                    if (typeof window.confirm === "function" && !window.confirm(t("trash.confirmPurge"))) return;
                    load(t("trash.working"));
                    post({ action: "purge", name: entry.name }).then(function (result) {
                      var ok = result.json !== null && result.json.ok === true;
                      load(ok ? t("trash.purged") : t("trash.failed") + (result.json && result.json.error ? result.json.error : result.text));
                    }).catch(function (error) {
                      load(t("trash.failed") + (error && error.message ? error.message : error));
                    });
                  });
                  actions.appendChild(purge);
                  row.appendChild(actions);
                  list.appendChild(row);
                })(entries[i]);
              }
              body.appendChild(list);
              body.appendChild(statsDiv("wsr-stats-note", t("trash.note")));
            }).catch(function (error) {
              body.textContent = t("trash.failed") + (error && error.message ? error.message : error);
            });
          };
          adopt.addEventListener("click", function () {
            adopt.disabled = true;
            adopt.textContent = t("adopt.working");
            adoptUnlistedSessions(function (message) {
              adopt.disabled = false;
              adopt.textContent = t("adopt.action");
              load(message);
            });
          });
          load("");
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

        /** The sidebar's trash entry glyph. */
        function TrashPanelIcon(props) {
          var Icon = ui.IconTrashOutlineRegular;
          if (typeof Icon !== "function") return null;
          var size = props !== undefined && props !== null && typeof props.size === "number" ? props.size : 16;
          return h(Icon, { size: size });
        }

        /**
         * The trash page itself: the plugin's trash (deleted logs) on top, the
         * Host's archive set (hidden sessions whose logs are still in place)
         * below. Both are "put away", so both are managed from here.
         */
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
              } else {
                failed = t("archive.failed") + "HTTP " + archive.status + " \u00b7 " + (archive.text || "").slice(0, 120);
              }
              setView({ loaded: true, entries: entries, archived: archived, note: note === undefined ? "" : note, failed: failed });
            }).catch(function (error) {
              setView({ loaded: true, entries: [], archived: [], note: "", failed: t("trash.failed") + (error && error.message ? error.message : error) });
            });
          };

          react.useEffect(function () { load(""); }, []);

          var act = function (entry, action) {
            var question = action === "restore" ? t("trash.confirmRestore") : t("trash.confirmPurge");
            if (typeof window.confirm === "function" && !window.confirm(question)) return;
            load(t("trash.working"));
            trashPost({ action: action, name: entry.name }).then(function (result) {
              var ok = result.json !== null && result.json.ok === true;
              load(ok ? (action === "restore" ? t("trash.restored") : t("trash.purged")) : t("trash.failed") + (result.json && result.json.error ? result.json.error : result.text));
            }).catch(function (error) {
              load(t("trash.failed") + (error && error.message ? error.message : error));
            });
          };

          var actArchived = function (entry, action) {
            var question = action === "unarchive" ? t("archive.confirmUnarchive")
              : action === "forget" ? t("archive.confirmForget")
                : t("archive.confirmDelete");
            if (typeof window.confirm === "function" && !window.confirm(question)) return;
            load(t("trash.working"));
            trashPost({ action: action, sessionId: entry.sessionId }).then(function (result) {
              if (result.json === null || result.json.ok !== true) {
                load(t("archive.failed") + (result.json && result.json.error ? result.json.error : result.text));
                return;
              }
              if (action === "unarchive") {
                load(t("archive.unarchived") + (result.json.listed === false ? t("archive.noWorkspace") : ""));
              } else if (action === "forget") {
                load(t("archive.forgotten"));
              } else {
                load(t("archive.deleted"));
              }
            }).catch(function (error) {
              load(t("archive.failed") + (error && error.message ? error.message : error));
            });
          };

          var rows = [];
          for (var i = 0; i < view.entries.length; i += 1) {
            (function (entry) {
              var meta = [];
              if (entry.reason === "delete") meta.push(t("trash.reason.delete"));
              else if (entry.reason === "move") meta.push(t("trash.reason.move"));
              meta.push(formatBytes(entry.sizeBytes));
              var when = formatWhen(entry.at);
              if (when !== "") meta.push(when);
              var actions = [h("button", {
                type: "button",
                className: "wsr-btn",
                onClick: function () { act(entry, "restore"); },
              }, t("trash.restore"))].filter(function () { return entry.restorable === true; });
              actions.push(h("button", {
                type: "button",
                className: "wsr-btn wsr-btn-danger",
                onClick: function () { act(entry, "purge"); },
              }, t("trash.purge")));
              rows.push(h("div", { className: "wsr-page-row", key: entry.name },
                h("div", { className: "wsr-page-text" },
                  h("div", { className: "wsr-page-title" }, entry.sessionId === null ? entry.name : entry.sessionId),
                  h("div", { className: "wsr-page-meta" }, meta.join(" \u00b7 ")),
                  typeof entry.cwd === "string" && entry.cwd !== "" ? h("div", { className: "wsr-page-path" }, entry.cwd) : null,
                ),
                h("div", { className: "wsr-page-actions" }, actions),
              ));
            })(view.entries[i]);
          }

          var archivedRows = [];
          var archivedList = Array.isArray(view.archived) ? view.archived : [];
          for (var j = 0; j < archivedList.length; j += 1) {
            (function (entry) {
              var meta = [];
              if (entry.blank === true) meta.push(t("archive.blank"));
              if (typeof entry.workspacePath === "string" && entry.workspacePath !== "") meta.push(entry.workspacePath);
              meta.push(formatBytes(entry.sizeBytes));
              var when = formatWhen(entry.lastAt !== 0 ? entry.lastAt : entry.createdAt);
              if (when !== "") meta.push(when);
              var label = typeof entry.title === "string" && entry.title !== "" ? entry.title : entry.sessionId;
              archivedRows.push(h("div", { className: "wsr-page-row", key: entry.sessionId },
                h("div", { className: "wsr-page-text" },
                  h("div", {
                    className: typeof entry.title === "string" && entry.title !== "" ? "wsr-page-title" : "wsr-page-title wsr-page-title-blank",
                  }, label),
                  h("div", { className: "wsr-page-meta" }, meta.join(" \u00b7 ")),
                  typeof entry.cwd === "string" && entry.cwd !== "" ? h("div", { className: "wsr-page-path" }, entry.cwd) : null,
                ),
                h("div", { className: "wsr-page-actions" },
                  h("button", {
                    type: "button",
                    className: "wsr-btn",
                    onClick: function () { actArchived(entry, "unarchive"); },
                  }, t("archive.unarchive")),
                  h("button", {
                    type: "button",
                    className: "wsr-btn",
                    onClick: function () { actArchived(entry, "delete"); },
                  }, t("archive.delete")),
                  h("button", {
                    type: "button",
                    className: "wsr-btn wsr-btn-danger",
                    onClick: function () { actArchived(entry, "forget"); },
                  }, t("archive.forget")),
                ),
              ));
            })(archivedList[j]);
          }

          var archiveSection = view.archived === null ? null : [
            h("div", { className: "wsr-page-section", key: "archive-head" },
              h("span", null, t("trash.section.archived")),
              h("span", { className: "wsr-page-count" }, String(archivedList.length)),
            ),
            archivedList.length === 0
              ? h("div", { className: "wsr-page-note", key: "archive-empty" }, t("archive.empty"))
              : h("div", { className: "wsr-page-list", key: "archive-list" }, archivedRows),
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
                  : h("div", { className: "wsr-page-list", key: "trash-list" }, rows),
                h("div", { className: "wsr-page-note", key: "trash-note" }, t("trash.note")),
                archiveSection,
              ],
          );
        }

        /**
         * Sidebar footer action: the trash, one click away from the account area.
         *
         * Geometry is the same house rule the official launchers follow
         * (`dshUpdateLauncher` / `dshMarketLauncher`): full-width seat bled 2px
         * per side, 42px tall, 12px radius. `wide` comes from the slot, so the
         * narrow rail keeps its 36px circle instead of a stretched row.
         */
        function TrashFooterAction(props) {
          var wide = props === undefined || props === null || props.wide !== false;
          var label = t("trash.title");
          var Icon = ui.IconTrashOutlineRegular;
          return h("button", {
            type: "button",
            className: "wsr-footer-action",
            title: label,
            "aria-label": label,
            "aria-haspopup": "dialog",
            style: {
              boxSizing: "border-box",
              width: "100%",
              alignSelf: "stretch",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              gap: "10px",
              minHeight: "40px",
              padding: "0 10px",
              border: "none",
              background: "transparent",
              color: "var(--dsw-alias-label-primary)",
              borderRadius: "10px",
              font: "inherit",
              fontSize: "14px",
              lineHeight: "22px",
              cursor: "pointer",
              textAlign: "left",
            },
            onClick: function () { openTrashPanel(); },
          },
            h("span", {
              style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "20px", height: "20px", flex: "none" },
              "aria-hidden": "true",
            }, typeof Icon === "function" ? h(Icon, { size: 18 }) : null),
            wide ? h("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, label) : null);
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

          ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register({
              name: "sidebar.panellist",
              id: "ws-recency-trash",
              order: 20,
              locale: NS,
              label: function () { return t("trash.title"); },
            }, TrashPanelIcon);
          });

          ctx.slots.inject("main", function () {
            return ctx.slots.register({
              name: "main",
              key: "ws-recency-trash",
              locale: NS,
            }, TrashPanelPage);
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
              id: "ws-recency-move",
              order: 690,
              store: prefs,
              locale: NS,
            }, MoveMenuItem);
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
