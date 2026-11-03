        /* ------------------------------ handoff ------------------------------ */

        var handoffTimer = null;
        var handoffPanelSession = null;

        /** The instruction the user sends to the current Session. */
        function handoffInstruction() {
          return t("handoff.instruction");
        }

        /** Write text into the composer; returns false when there is no editor. */
        function insertIntoComposer(text) {
          if (typeof document === "undefined" || typeof text !== "string") return false;
          var seat = typeof document.querySelector === "function" ? document.querySelector("[data-composer-seat]") : null;
          if (seat === null || seat === undefined) return false;
          var editor = null;
          try { editor = seat.querySelector('[contenteditable="true"]'); } catch (error) { editor = null; }
          if (editor === null || editor === undefined) {
            try { editor = seat.querySelector("textarea"); } catch (error) { editor = null; }
          }
          if (editor === null || editor === undefined) return false;
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

        function copyText(text) {
          try {
            if (navigator !== undefined && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
              navigator.clipboard.writeText(text);
              return true;
            }
          } catch (error) {
            /* fall through */
          }
          return false;
        }

        /** Pull the fenced block out of an assistant reply. */
        function handoffBlockOf(text) {
          if (typeof text !== "string") return "";
          var match = /```handoff[ \t]*\r?\n([\s\S]*?)```/i.exec(text);
          if (match !== null) return match[1].trim();
          var loose = /```[ \t]*\r?\n([\s\S]*?)```/.exec(text);
          if (loose !== null && loose[1].indexOf("#") !== -1) return loose[1].trim();
          return "";
        }

        function closeHandoffPanel() {
          if (handoffTimer !== null && typeof window.clearTimeout === "function") window.clearTimeout(handoffTimer);
          handoffTimer = null;
          handoffPanelSession = null;
          closeStatsPanel();
        }

        /**
         * The handoff flow: seed the instruction, watch for the reply, then open a
         * fresh Session in the same workspace with the handoff carried over.
         */
        function openHandoffPanel(sessionId) {
          if (typeof document === "undefined") return;
          closeStatsPanel();
          handoffPanelSession = sessionId;

          var backdrop = statsDiv("wsr-modal-backdrop");
          var panel = statsDiv("wsr-modal");
          backdrop.appendChild(panel);
          var head = statsDiv("wsr-modal-head");
          head.appendChild(statsDiv("wsr-modal-title", t("handoff.title")));
          var close = document.createElement("button");
          close.type = "button";
          close.className = "wsr-modal-close";
          close.textContent = "\u00d7";
          close.addEventListener("click", closeHandoffPanel);
          head.appendChild(close);
          panel.appendChild(head);

          var body = statsDiv("wsr-modal-body");
          panel.appendChild(body);
          body.appendChild(statsDiv("wsr-stats-note", t("handoff.note")));

          var status = statsDiv("wsr-handoff-status", t("handoff.waiting", { n: 0 }));
          body.appendChild(status);

          var preview = document.createElement("textarea");
          preview.className = "wsr-handoff-text";
          preview.setAttribute("data-wsr-handoff-text", "true");
          preview.style.display = "none";
          body.appendChild(preview);

          var actions = statsDiv("wsr-trash-actions");
          var copy = document.createElement("button");
          copy.type = "button";
          copy.className = "wsr-btn";
          copy.textContent = t("handoff.copy");
          copy.addEventListener("click", function () {
            if (copyText(handoffInstruction())) status.textContent = t("handoff.inserted");
          });
          actions.appendChild(copy);

          var more = document.createElement("button");
          more.type = "button";
          more.className = "wsr-btn";
          more.textContent = t("handoff.more");
          more.addEventListener("click", function () {
            preview.style.display = "none";
            baseline = replies;
            status.textContent = t("handoff.waiting", { n: 0 });
            insertIntoComposer(handoffInstruction());
            poll(0);
          });
          actions.appendChild(more);

          var confirm = document.createElement("button");
          confirm.type = "button";
          confirm.className = "wsr-btn";
          confirm.disabled = true;
          confirm.style.display = "none";
          confirm.textContent = t("handoff.confirm");
          confirm.addEventListener("click", function () {
            var text = preview.value.trim();
            if (text === "") return;
            confirm.disabled = true;
            fetch("/ws-recency/handoff", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "save", sessionId: sessionId, text: text }),
            }).catch(function () { return null; }).then(function () {
              var owner = workspaceOfSession(sessionId);
              var workspaceId = owner === null ? undefined : owner.workspaceId;
              var service = data.service;
              var prompt = t("handoff.preamble") + "\n\n" + text;
              if (service !== null && service !== undefined && typeof service.startSession === "function") {
                try {
                  service.startSession(workspaceId, { prompt: prompt, whenDraftExists: "replace" });
                  closeHandoffPanel();
                  return;
                } catch (error) {
                  /* fall through to the clipboard */
                }
              }
              copyText(prompt);
              status.textContent = t("handoff.noService");
            });
          });
          actions.appendChild(confirm);
          body.appendChild(actions);

          body.appendChild(statsDiv("wsr-stats-note", t("handoff.footnote")));
          document.body.appendChild(backdrop);

          /* Seed the instruction: the user only presses Enter. */
          if (!insertIntoComposer(handoffInstruction())) {
            status.textContent = t("handoff.copyHint");
          } else {
            status.textContent = t("handoff.inserted");
          }

          var baseline = 0;
          var replies = 0;
          var tries = 0;
          function poll(delay) {
            if (typeof window === "undefined") return;
            handoffTimer = window.setTimeout(function () {
              if (handoffPanelSession !== sessionId) return;
              fetch("/ws-recency/handoff", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "tail", sessionId: sessionId }),
              }).then(function (response) {
                return response.json().catch(function () { return null; });
              }).then(function (answer) {
                if (answer === null || answer.ok !== true) return;
                replies = typeof answer.replies === "number" ? answer.replies : 0;
                if (baseline === 0) baseline = replies > 0 ? replies - 1 : 0;
                tries += 1;
                var block = replies > baseline ? handoffBlockOf(answer.text) : "";
                if (block !== "") {
                  preview.value = block;
                  preview.style.display = "";
                  confirm.style.display = "";
                  confirm.disabled = false;
                  status.textContent = t("handoff.found");
                  return;
                }
                status.textContent = t("handoff.waiting", { n: tries * 2 });
                poll(2000);
              }).catch(function () {
                poll(4000);
              });
            }, delay);
          }
          poll(1500);
        }

