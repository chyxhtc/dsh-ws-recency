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

        /** The trash page itself: same data as the dialog, rendered in the main region. */
        function TrashPanelPage() {
          var state = react.useState({ loaded: false, entries: [], note: "", failed: "" });
          var view = state[0];
          var setView = state[1];

          var load = function (note) {
            trashPost({ action: "list" }).then(function (answer) {
              if (answer.json === null || answer.json.ok !== true) {
                setView({ loaded: true, entries: [], note: "", failed: t("trash.failed") + "HTTP " + answer.status + " \u00b7 " + (answer.text || "").slice(0, 120) });
                return;
              }
              setView({ loaded: true, entries: Array.isArray(answer.json.entries) ? answer.json.entries : [], note: note === undefined ? "" : note, failed: "" });
            }).catch(function (error) {
              setView({ loaded: true, entries: [], note: "", failed: t("trash.failed") + (error && error.message ? error.message : error) });
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
              : view.entries.length === 0 ? h("div", { className: "wsr-page-note" }, t("trash.empty"))
                : h("div", { className: "wsr-page-list" }, rows),
            h("div", { className: "wsr-page-note" }, t("trash.note")),
          );
        }

