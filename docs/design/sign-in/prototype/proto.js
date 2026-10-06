/*
 * The integrated web flow prototype (SIGN-IN.md §4.16) with the motion of §3.18.
 *
 * CSP-safe: no eval, no inline handlers, no style attributes and no HTML strings. Steps are
 * <template>s cloned into the one card. Transitions use the View Transitions API when present;
 * otherwise the Web Animations API runs the same exit, morph and enter (CSSOM only, which
 * `style-src 'self'` allows). Under reduced motion every step swaps instantly.
 *
 * window.pkProto exposes go(), state and a few helpers for record.cjs.
 */
(function () {
  "use strict";

  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  root.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
  if (params.get("motion") === "reduce") root.classList.add("reduce");

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const card = $("#card");
  const stepEl = $("#step");
  const person = $("#person");
  const stepLabel = $("#proto-step");

  const css = getComputedStyle(root);
  const ms = (name, fallback) => {
    const v = css.getPropertyValue(name).trim();
    return v ? parseFloat(v) : fallback;
  };
  const ease = (name, fallback) =>
    css.getPropertyValue(name).trim() || fallback;
  const T = {
    quick: ms("--pk-duration-quick", 160),
    base: ms("--pk-duration-base", 200),
    moderate: ms("--pk-duration-moderate", 260),
    standard: ease("--pk-ease-standard", "cubic-bezier(0.2, 0, 0, 1)"),
    enter: ease("--pk-ease-enter", "cubic-bezier(0, 0, 0, 1)"),
    exit: ease("--pk-ease-exit", "cubic-bezier(0.3, 0, 1, 1)"),
  };
  const reduced = () =>
    root.classList.contains("reduce") ||
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  const LABELS = {
    methods: "Sign in",
    code: "Check your email",
    choose: "Choose a license",
    key: "License key",
    replace: "Replace a device",
    consent: "Consent",
    done: "Return",
  };
  const SIGNED_IN = new Set(["choose", "replace", "consent", "done"]);

  const state = {
    step: "methods",
    choice: "pro", // pro | replace | key
    onramp: false,
    replaceDevice: "Work laptop",
    history: [],
    busy: false,
  };

  // ---------- rendering ----------
  function render(step) {
    const tpl = document.getElementById(`t-${step}`);
    stepEl.replaceChildren(tpl.content.cloneNode(true));
    person.hidden = !(SIGNED_IN.has(step) || (step === "key" && !state.onramp));
    stepLabel.textContent = LABELS[step];
    state.step = step;
    if (step === "key" && state.onramp) {
      const h = $("h1", stepEl);
      h.textContent = h.dataset.titleOnramp;
      $("[data-key-primary] .lbl", stepEl).textContent = "Continue";
    }
    if (step === "consent") fillConsent();
    if (step === "done") fillDone();
  }

  function fillConsent() {
    const t = $("[data-chosen]", stepEl);
    const m = $("[data-chosen-meta]", stepEl);
    if (state.choice === "replace") {
      t.textContent = "Tidewater Studio Edu";
      m.textContent = `Until 12 Jun 2027 · replaces ${state.replaceDevice}`;
    } else if (state.choice === "key") {
      t.textContent = "Tidewater Studio";
      m.textContent = "Key ending 3WPLDA · added to your account";
    }
  }
  function fillDone() {
    const n = $("[data-done-license]", stepEl);
    if (state.choice === "replace")
      n.textContent = `Tidewater Studio Edu · replaced ${state.replaceDevice}`;
    if (state.choice === "key")
      n.textContent = "Tidewater Studio · Key ending 3WPLDA";
  }

  // What runs once a step is on screen: focus, skeleton → rows, the confirm, the success moment.
  function afterEnter(step) {
    const h = $("h1", stepEl);
    if (h) h.focus({ preventScroll: true });
    if (step === "choose") loadRows();
    if (step === "replace")
      later(() => expand($("[data-confirm]", stepEl)), reduced() ? 0 : 260);
    if (step === "done") $(".success", stepEl).classList.add("play");
    if (step === "code") $("#code", stepEl).focus({ preventScroll: true });
  }

  function loadRows() {
    const rows = $("[data-rows]", stepEl);
    const swap = () => {
      if (state.step !== "choose") return;
      const frag = document.getElementById("t-rows").content.cloneNode(true);
      const items = $$(".lic", frag);
      if (!reduced())
        items.forEach((el, i) =>
          el.classList.add(`pk-stagger-${Math.min(i + 1, 6)}`),
        );
      const h0 = rows.getBoundingClientRect().height;
      rows.replaceChildren(frag);
      morphHeight(rows, h0);
      selectLicense(state.choice === "replace" ? "edu" : "pro");
    };
    later(swap, reduced() ? 0 : 520);
  }

  // ---------- motion primitives ----------
  function later(fn, delay) {
    if (delay <= 0) fn();
    else setTimeout(fn, delay);
  }
  // morph: animate an element from its old height to its new one (measured, CSSOM only)
  function morphHeight(el, from) {
    if (reduced()) return;
    const to = el.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;
    el.animate(
      [
        { height: `${from}px`, overflow: "clip" },
        { height: `${to}px`, overflow: "clip" },
      ],
      {
        duration: T.moderate,
        easing: T.standard,
      },
    );
  }
  // expand: open a hidden block in place (height 0 → auto, content fades in)
  function expand(el) {
    if (!el || !el.hidden) return;
    el.hidden = false;
    if (reduced()) return;
    const h = el.getBoundingClientRect().height;
    el.animate(
      [
        { height: "0px", opacity: 0, overflow: "clip", paddingBlock: "0px" },
        { height: `${h}px`, opacity: 1, overflow: "clip" },
      ],
      { duration: T.moderate, easing: T.standard },
    );
  }

  // One step change: exit, morph, enter, in the direction of travel.
  function go(step, opts = {}) {
    const dir = opts.dir || "forward";
    if (state.busy || step === state.step) return Promise.resolve();
    if (opts.push !== false) {
      if (dir === "back") state.history.pop();
      else state.history.push(state.step);
      history.pushState({ step }, "", `#${step}`);
    }
    root.dataset.dir = dir;
    const update = () => render(step);
    if (reduced()) {
      update();
      afterEnter(step);
      return Promise.resolve();
    }
    if (document.startViewTransition) {
      state.busy = true;
      const t = document.startViewTransition(update);
      return t.finished.finally(() => {
        state.busy = false;
        afterEnter(step);
      });
    }
    return fallbackTransition(update, dir).then(() => afterEnter(step));
  }

  // The same choreography without View Transitions (Web Animations API).
  function fallbackTransition(update, dir) {
    state.busy = true;
    const sign = dir === "back" ? -1 : 1;
    const h0 = card.getBoundingClientRect().height;
    return stepEl
      .animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: `translateX(${-8 * sign}px)` },
        ],
        {
          duration: T.quick,
          easing: T.exit,
        },
      )
      .finished.then(() => {
        update();
        morphHeight(card, h0);
        return stepEl.animate(
          [
            { opacity: 0, transform: `translateX(${12 * sign}px)` },
            { opacity: 1, transform: "none" },
          ],
          { duration: T.base, easing: T.enter, delay: 90, fill: "backwards" },
        ).finished;
      })
      .finally(() => {
        state.busy = false;
      });
  }

  // ---------- interactions ----------
  function selectLicense(id) {
    $$(".lic[role=radio]", stepEl).forEach((el) => {
      const on = el.dataset.lic === id;
      el.classList.toggle("sel", on);
      el.setAttribute("aria-checked", String(on));
    });
  }
  function selectDevice(name) {
    state.replaceDevice = name;
    $$(".dev", stepEl).forEach((el) => {
      const on = el.dataset.dev === name;
      el.classList.toggle("sel", on);
      el.setAttribute("aria-checked", String(on));
      el.tabIndex = on ? 0 : -1;
    });
    const title = $("[data-confirm-title]", stepEl);
    const body = $("[data-confirm-body]", stepEl);
    title.textContent = `Replace ${name}?`;
    body.textContent = `${name} signs out of Tidewater Studio and Mara's MacBook Pro takes its seat. ${name} can sign in again later if a seat is free. We'll email you about it.`;
    const inUse = $("[data-inuse]", stepEl);
    const wasHidden = inUse.hidden;
    inUse.textContent = `${name} is in use right now.`;
    if (name === "Studio iMac" && wasHidden) expand(inUse);
    else if (name !== "Studio iMac") inUse.hidden = true;
  }

  function withBusy(btn, delay, fn) {
    if (!delay || reduced()) return fn();
    btn.classList.add("busy");
    btn.setAttribute("aria-busy", "true");
    setTimeout(() => {
      btn.classList.remove("busy");
      btn.removeAttribute("aria-busy");
      fn();
    }, delay);
  }

  function onCodeInput(input) {
    const digits = input.value.replace(/\D/g, "").slice(0, 6);
    input.value = digits;
    const cells = $$("[data-cells] div", stepEl);
    cells.forEach((c, i) => {
      c.textContent = digits[i] || "";
      c.classList.toggle("filled", i < digits.length);
      c.classList.toggle("cur", i === Math.min(digits.length, 5));
    });
    const btn = $("[data-needs-code]", stepEl);
    btn.disabled = digits.length < 6;
    if (digits.length === 6)
      withBusy(btn, 450, () => go(state.onramp ? "consent" : "choose"));
  }

  function typeInto(input, text, each, onDone) {
    let i = 0;
    const tick = () => {
      input.value = text.slice(0, ++i);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (i < text.length) setTimeout(tick, reduced() ? 0 : each);
      else if (onDone) onDone();
    };
    tick();
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, [role=radio]");
    if (!t) return;
    const action = t.dataset.action;
    if (action === "theme") {
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      t.textContent =
        root.dataset.theme === "dark" ? "Light theme" : "Dark theme";
      return;
    }
    if (action === "motion") {
      const on = root.classList.toggle("reduce");
      t.setAttribute("aria-pressed", String(on));
      return;
    }
    if (action === "restart") {
      state.history = [];
      state.choice = "pro";
      state.onramp = false;
      go("methods", { dir: "back" });
      return;
    }
    if (action === "demo-code") {
      typeInto($("#code", stepEl), "481516", 90);
      return;
    }
    if (action === "demo-key") {
      typeInto($("#key", stepEl), "pkey_tidewater_7Q2M4XkR9vLp2Hc3WPLDA", 18);
      return;
    }
    if (t.matches(".lic[role=radio]")) {
      selectLicense(t.dataset.lic);
      state.choice = "pro";
      return;
    }
    if (t.matches(".dev[role=radio]")) {
      selectDevice(t.dataset.dev);
      return;
    }
    if (t.hasAttribute("data-back")) {
      const prev = state.history[state.history.length - 1] || "methods";
      go(prev, { dir: "back" });
      return;
    }
    const target = t.dataset.go;
    if (!target) return;
    if (target === "key") state.onramp = t.dataset.onramp === "1";
    if (target === "methods") state.onramp = false;
    if (t.hasAttribute("data-replace")) state.choice = "replace";
    if (t.hasAttribute("data-key-primary")) state.choice = "key";
    const dir = t.dataset.dir || "forward";
    // the on-ramp's key leads to sign-in; the key is then the choice (I-04 decision 10)
    const next =
      target === "consent" && state.onramp && state.step === "key"
        ? "code"
        : target;
    withBusy(t, Number(t.dataset.busy || 0), () => go(next, { dir }));
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "code") onCodeInput(e.target);
    if (e.target.id === "key") {
      const v = $("[data-verdict]", stepEl);
      if (/^pkey_tidewater_/.test(e.target.value)) expand(v);
      else v.hidden = true;
    }
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if ((e.key === " " || e.key === "Enter") && t.matches("[role=radio]")) {
      e.preventDefault();
      t.click();
    }
    if (
      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
      t.matches(".dev[role=radio]")
    ) {
      e.preventDefault();
      const all = $$(".dev[role=radio]", stepEl);
      const next =
        all[
          (all.indexOf(t) + (e.key === "ArrowDown" ? 1 : all.length - 1)) %
            all.length
        ];
      next.focus();
      next.click();
    }
  });

  window.addEventListener("popstate", (e) => {
    const step = (e.state && e.state.step) || "methods";
    state.history.pop();
    go(step, { dir: "back", push: false });
  });

  // ---------- start ----------
  const initial = (location.hash || "").slice(1);
  render(LABELS[initial] ? initial : "methods");
  history.replaceState({ step: state.step }, "", `#${state.step}`);
  afterEnter(state.step);

  window.pkProto = { go, state, render, afterEnter, typeInto, $, $$ };
})();
