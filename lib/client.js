/*! dsh-plugin-mermaid/client.js
 *  Browser entry: must be a factory-form CJS bundle registered with
 *  window.__ModuleLoader__.load({ id, factory }). The Node half of DSH's
 *  client-modules service scans the `dsh.client` package field, serves
 *  this file under /plugins/<id>/client.js, and the browser kernel
 *  materializes it on boot.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-mermaid",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const PLUGIN_ID = "dsh-plugin-mermaid";
    const MERMAID_VERSION = "11";
    const MERMAID_CDN = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`;
    const RENDER_DEBOUNCE_MS = 500;

    // ── Markers ────────────────────────────────────────────────────────────
    // `data-dsh-mermaid="ready"`   : wrapper has been enhanced (views built)
    // `data-dsh-mermaid-view`      : on wrapper, "chart" | "source"
    // `data-dsh-mermaid-state`     : on wrapper, "idle" | "rendering" | "ok" | "error"
    // `data-dsh-mermaid-hash`      : last rendered source hash (to skip re-render)

    // ── Mermaid loader (ESM via dynamic import) ────────────────────────────
    let mermaidPromise = null;
    function loadMermaid() {
      if (mermaidPromise) return mermaidPromise;
      mermaidPromise = import(/* webpackIgnore: true */ MERMAID_CDN).then((mod) => {
        const mermaid = mod.default ?? mod;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: currentTheme(),
          fontFamily: "getComputedStyle(document.body).fontFamily",
        });
        return mermaid;
      });
      return mermaidPromise;
    }

    function currentTheme() {
      // ui-layout sets body[data-ds-dark-theme] when in dark mode;
      // absence means light (system resolves the same attribute).
      if (document.body && document.body.hasAttribute("data-ds-dark-theme")) {
        return "dark";
      }
      return "default";
    }

    // Stable short hash to skip identical re-renders while streaming.
    function hashString(s) {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    }

    // ── Block detection ────────────────────────────────────────────────────
    // DSH renders fenced blocks as:
    //   <div class="md-code-block">
    //     <div class="...bannerWrap">
    //       <div class="...banner">
    //         <div class="...infostring">mermaid</div>   <-- language label
    //         <div class="...action"><button>copy</button></div>
    //       </div>
    //     </div>
    //     <pre class="...plain"><code>...source...</code></pre>   (plain)
    //     -- or --
    //     <div dangerouslySetInnerHTML=shiki-highlighted />     (highlighted)
    //   </div>
    // The language class on <code> is NOT guaranteed (Shiki may drop it for
    // unknown grammars), so we detect off the infostring text. We also accept
    // the standard `code.language-mermaid` form as a fallback.
    function isMermaidBlock(wrapper) {
      const info = wrapper.querySelector('[class*="infostring"]');
      if (info && (info.textContent || "").trim().toLowerCase() === "mermaid") return true;
      if (wrapper.querySelector("code.language-mermaid, code[class*='language-mermaid']")) return true;
      return false;
    }

    function findCodeEl(wrapper) {
      return (
        wrapper.querySelector("code.language-mermaid, code[class*='language-mermaid']") ||
        wrapper.querySelector("pre code")
      );
    }

    // ── View construction ──────────────────────────────────────────────────
    function buildViews(wrapper, codeEl) {
      if (wrapper.hasAttribute("data-dsh-mermaid")) return;
      wrapper.setAttribute("data-dsh-mermaid", "ready");
      wrapper.setAttribute("data-dsh-mermaid-view", "chart");
      wrapper.setAttribute("data-dsh-mermaid-state", "idle");

      // DSH's own banner:
      //   <div class="...bannerWrap">
      //     <div class="...banner">
      //       <div class="...infostring">mermaid</div>
      //       <div class="...action"><button>复制</button></div>
      //     </div>
      //   </div>
      // We inject our buttons into `.action`, right next to "复制".
      const actionArea = wrapper.querySelector('[class*="banner"] [class*="action"]');
      const bannerWrap = actionArea?.closest?.('[class*="bannerWrap"]');
      const nativePre = codeEl.closest("pre");

      const mkBtn = (text, title, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "dsh-mermaid-btn";
        b.textContent = text;
        b.title = title;
        if (onClick) {
          b.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onClick();
          });
        }
        return b;
      };

      const toggleBtn = mkBtn("源码", "切换到 Mermaid 源码", null);
      const rerenderBtn = mkBtn("重渲染", "重新渲染图表", () => {
        wrapper.removeAttribute("data-dsh-mermaid-hash");
        scheduleRender(wrapper, { force: true });
      });

      const setView = (next) => {
        wrapper.setAttribute("data-dsh-mermaid-view", next);
        if (next === "chart") {
          toggleBtn.textContent = "源码";
          toggleBtn.title = "切换到 Mermaid 源码";
          if (nativePre) nativePre.style.display = "none";
          preview.style.display = "";
        } else {
          toggleBtn.textContent = "图表";
          toggleBtn.title = "切换到渲染图";
          if (nativePre) nativePre.style.display = "";
          preview.style.display = "none";
        }
      };

      toggleBtn.addEventListener("click", () => {
        const cur = wrapper.getAttribute("data-dsh-mermaid-view");
        setView(cur === "chart" ? "source" : "chart");
      });

      if (actionArea) {
        // Insert before the copy button so ours appear on the left of it.
        actionArea.insertBefore(rerenderBtn, actionArea.firstChild);
        actionArea.insertBefore(toggleBtn, rerenderBtn);
      }

      // Preview container rendered below the banner. In chart view we show
      // this and hide the <pre>; in source view the opposite.
      const preview = document.createElement("div");
      preview.className = "dsh-mermaid-preview";
      const stage = document.createElement("div");
      stage.className = "dsh-mermaid-stage";
      preview.appendChild(stage);
      const err = document.createElement("div");
      err.className = "dsh-mermaid-error";
      err.hidden = true;
      preview.appendChild(err);

      if (nativePre) {
        nativePre.setAttribute("data-dsh-mermaid-role", "source");
        nativePre.parentNode.insertBefore(preview, nativePre.nextSibling);
      } else {
        wrapper.appendChild(preview);
      }

      // Start in chart view: hide source <pre>.
      if (nativePre) nativePre.style.display = "none";
    }

    function setError(wrapper, message) {
      const err = wrapper.querySelector(".dsh-mermaid-error");
      wrapper.setAttribute("data-dsh-mermaid-state", message ? "error" : "ok");
      if (!err) return;
      if (message) {
        err.hidden = false;
        err.textContent = "Mermaid 渲染失败：" + message;
      } else {
        err.hidden = true;
        err.textContent = "";
      }
    }

    // ── Rendering ──────────────────────────────────────────────────────────
    async function renderOne(wrapper) {
      const codeEl = findCodeEl(wrapper);
      if (!codeEl) return;
      const source = codeEl.textContent ?? "";
      if (source.trim() === "") return;

      const hash = hashString(source + "::" + currentTheme());
      if (wrapper.getAttribute("data-dsh-mermaid-hash") === hash) return;

      wrapper.setAttribute("data-dsh-mermaid-state", "rendering");
      try {
        const mermaid = await loadMermaid();
        if (currentTheme() !== mermaid.mermaidAPI?.getSiteConfig?.().theme) {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: currentTheme() });
        }
        const id = "dsh-mermaid-" + hash + "-" + Math.random().toString(36).slice(2, 8);
        const { svg, bindFunctions } = await mermaid.render(id, source);
        const stage = wrapper.querySelector(".dsh-mermaid-stage");
        if (stage) {
          stage.innerHTML = svg;
          bindFunctions?.(stage);
        }
        wrapper.setAttribute("data-dsh-mermaid-hash", hash);
        setError(wrapper, "");
      } catch (e) {
        setError(wrapper, e?.message ?? String(e));
      }
    }

    // Debounce per-wrapper so streaming token appends don't thrash mermaid.
    const pending = new WeakMap();
    function scheduleRender(wrapper, opts) {
      const existing = pending.get(wrapper);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        pending.delete(wrapper);
        renderOne(wrapper);
      }, opts?.force ? 0 : RENDER_DEBOUNCE_MS);
      pending.set(wrapper, t);
    }

    function scan(root) {
      const scope = root instanceof Element ? root : document;
      const blocks = scope.querySelectorAll(".md-code-block");
      blocks.forEach((wrapper) => {
        if (wrapper.hasAttribute("data-dsh-mermaid-skip")) return;
        if (!isMermaidBlock(wrapper)) {
          // Mark non-mermaid blocks so we don't re-test their infostring
          // every scan (infostring is stable after render).
          if (wrapper.querySelector('[class*="infostring"]') || wrapper.querySelector("code[class*='language-']")) {
            wrapper.setAttribute("data-dsh-mermaid-skip", "");
          }
          return;
        }
        const code = findCodeEl(wrapper);
        if (!code) return;
        if (!wrapper.hasAttribute("data-dsh-mermaid")) {
          buildViews(wrapper, code);
        }
        scheduleRender(wrapper);
      });
    }

    // ── Theme change handling ──────────────────────────────────────────────
    // ui-layout mutates body[data-ds-dark-theme]; observe attribute flips and
    // re-render all existing blocks with the new theme.
    function observeTheme() {
      const mo = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === "attributes" && r.attributeName === "data-ds-dark-theme") {
            document.querySelectorAll('.md-code-block[data-dsh-mermaid="ready"]').forEach((w) => {
              w.removeAttribute("data-dsh-mermaid-hash");
              scheduleRender(w, { force: true });
            });
            break;
          }
        }
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
    }

    // ── DOM observation for new/streaming blocks ───────────────────────────
    let scanScheduled = false;
    function scheduleScan() {
      if (scanScheduled) return;
      scanScheduled = true;
      queueMicrotask(() => {
        scanScheduled = false;
        scan(document);
      });
    }

    function observeDom() {
      const mo = new MutationObserver((mutations) => {
        // Scan whenever nodes change; scan() is idempotent and cheap because
        // it only acts on blocks that are not yet enhanced.
        let needScan = false;
        for (const m of mutations) {
          if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) {
            needScan = true;
            break;
          }
          if (m.type === "characterData") {
            // Streaming text inside a code block.
            const host = m.target.parentElement?.closest?.(".md-code-block");
            if (host) {
              if (host.hasAttribute("data-dsh-mermaid")) {
                // Already enhanced: re-render.
                scheduleRender(host);
              } else {
                // Not yet enhanced (language label may have just appeared).
                scheduleScan();
              }
            }
          }
        }
        if (needScan) scheduleScan();
      });
      mo.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    // ── Styles (injected once) ─────────────────────────────────────────────
    const CSS = `
      .md-code-block[data-dsh-mermaid] .dsh-mermaid-preview {
        padding: 12px;
        background: var(--dsw-alias-surface-l1, transparent);
        overflow: auto;
      }
      .md-code-block[data-dsh-mermaid] .dsh-mermaid-stage {
        display: flex;
        justify-content: center;
        min-height: 2em;
      }
      .md-code-block[data-dsh-mermaid] .dsh-mermaid-stage svg {
        max-width: 100%;
        height: auto;
      }
      .md-code-block[data-dsh-mermaid] .dsh-mermaid-error {
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: 6px;
        background: rgba(220, 50, 50, 0.08);
        border: 1px solid rgba(220, 50, 50, 0.3);
        color: #c93b3b;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        white-space: pre-wrap;
      }
      .md-code-block[data-dsh-mermaid][data-dsh-mermaid-state="rendering"] .dsh-mermaid-stage::before {
        content: "渲染中…";
        opacity: 0.5;
        font-size: 12px;
      }
      /* Our text buttons sit in the native action cluster next to the copy
         icon button. Keep them small and low-key so they don't fight the
         copy button for attention. */
      .md-code-block[data-dsh-mermaid] button.dsh-mermaid-btn {
        appearance: none;
        background: transparent;
        border: 0;
        color: var(--dsw-alias-label-secondary, currentColor);
        font: inherit;
        font-size: 12px;
        line-height: 1;
        padding: 2px 6px;
        margin-right: 6px;
        border-radius: 4px;
        cursor: pointer;
      }
      .md-code-block[data-dsh-mermaid] button.dsh-mermaid-btn:hover {
        color: var(--dsw-alias-label-primary, currentColor);
        background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.15));
      }
    `;
    function injectStyles() {
      if (document.getElementById("dsh-plugin-mermaid-styles")) return;
      const style = document.createElement("style");
      style.id = "dsh-plugin-mermaid-styles";
      style.setAttribute("data-plugin", PLUGIN_ID);
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ── Cordis plugin face ─────────────────────────────────────────────────
    const name = PLUGIN_ID;
    const inject = [];
    function apply(ctx) {
      ctx.logger?.info?.("dsh-plugin-mermaid: client apply");
      injectStyles();
      // Wait for <body> so the MutationObserver target exists.
      const start = () => {
        scan(document);
        observeDom();
        observeTheme();
      };
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
      ctx.effect?.(() => () => {
        // No teardown needed; page reload owns lifecycle.
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
