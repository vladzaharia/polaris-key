// Browser module for Expressive Code blocks (docs plan 8.2): the console CodeBlock's Copy.
//
// - Each Copy button is named by what it copies ("Copy .npmrc", "Copy command" for a terminal).
// - A click copies through the clipboard API, then the selection fallback, and announces "Copied"
//   in the frame's polite live region.
// - When both are refused it selects the code and says which chord to press. That hint is not a
//   success: it is drawn neutral and stays until focus or the selection moves.
//
// Plain script text, read by ec.config.mjs and handed to Expressive Code as a jsModule;
// test/ecModules.test.ts parses it and the built bundle, because a syntax error here silently
// kills every Copy button on the site.
try {
  (() => {
    const chord = () =>
      /Mac|iPhone|iPad|iPod/.test(
        (navigator.platform || "") + " " + (navigator.userAgent || ""),
      )
        ? "⌘C"
        : "Ctrl+C";

    // Names: "Copy <title>", "Copy command" for a terminal frame.
    for (const btn of document.querySelectorAll(
      ".expressive-code .copy button",
    )) {
      const frame = btn.closest("figure.frame");
      const title = frame?.querySelector(".header .title")?.textContent?.trim();
      const name = frame?.classList.contains("is-terminal")
        ? "Copy command"
        : title
          ? "Copy " + title
          : "Copy code";
      btn.setAttribute("aria-label", name);
      btn.setAttribute("title", name);
      btn.dataset.copied = "Copied";
    }

    const say = (box, text, hint) => {
      const live = box && box.querySelector("[aria-live]");
      if (!live) return;
      for (const old of live.querySelectorAll(".feedback")) old.remove();
      const note = document.createElement("div");
      note.className = hint ? "feedback pk-hint" : "feedback";
      note.textContent = text;
      live.append(note);
      requestAnimationFrame(() => note.classList.add("show"));
      if (hint) {
        const clear = () => {
          note.remove();
          document.removeEventListener("selectionchange", onSelection);
          box.removeEventListener("focusout", clear);
        };
        const onSelection = () => {
          const s = getSelection();
          if (!s || s.isCollapsed) clear();
        };
        // The selection we just made fires selectionchange once; wait it out.
        setTimeout(
          () => document.addEventListener("selectionchange", onSelection),
          0,
        );
        box.addEventListener("focusout", clear);
      } else {
        setTimeout(() => note.classList.remove("show"), 1500);
        setTimeout(() => note.remove(), 2500);
      }
    };

    const viaSelection = (text) => {
      const pre = document.createElement("pre");
      Object.assign(pre.style, {
        opacity: "0",
        pointerEvents: "none",
        position: "absolute",
        left: "0",
        top: "0",
        width: "20px",
        height: "20px",
        userSelect: "all",
      });
      pre.setAttribute("aria-hidden", "true");
      pre.textContent = text;
      document.body.appendChild(pre);
      const range = document.createRange();
      range.selectNode(pre);
      const sel = getSelection();
      if (!sel) {
        pre.remove();
        return false;
      }
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } finally {
        sel.removeAllRanges();
        pre.remove();
      }
      return ok;
    };

    document.addEventListener(
      "click",
      async (e) => {
        const btn =
          e.target instanceof Element
            ? e.target.closest(".expressive-code .copy button")
            : null;
        if (!btn) return;
        e.stopPropagation();
        const text = btn.dataset.code.replace(/\u007f/g, "\n");
        const box = btn.parentElement;
        let ok = false;
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch {
          ok = viaSelection(text);
        }
        if (ok) {
          say(box, btn.dataset.copied || "Copied", false);
          return;
        }
        const code = btn.closest("figure")?.querySelector("pre code");
        if (code) {
          const range = document.createRange();
          range.selectNodeContents(code);
          const sel = getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        say(box, "Press " + chord() + " to copy", true);
      },
      true,
    );
  })();
} catch (error) {
  console.error("[pk] copy module failed:", error);
}
