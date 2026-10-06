// S-23 portal prototype: Library → product → activate → free a device, on motion.js/motion.css.
import { h, check } from "./h.js";
import {
  viewTransition,
  presence,
  countTo,
  highlight,
  celebrateOnce,
  reducedMotion,
} from "./motion.js";
import { wireProtoBar, toast } from "./shared.js";

const PRODUCTS = [
  {
    slug: "nightfall",
    name: "Nightfall",
    by: "Lanternworks",
    tier: "Deluxe",
    sub: "Deluxe · 2 of 3 devices",
  },
  {
    slug: "tidewater",
    name: "Tidewater Studio",
    by: "Fennick Audio",
    tier: "Pro",
    sub: "Pro · 2 of 3 devices",
  },
  {
    slug: "ember",
    name: "Ember Tactics",
    by: "Kiln Games",
    tier: "Standard",
    sub: "Updates ended at 1.8",
  },
];
const SEATS = 3;
const INITIAL_DEVICES = [
  {
    id: "mbp",
    name: "Mara's MacBook Pro",
    sub: "macOS · 1.4.2 · last seen 2 hr. ago",
    ico: "💻",
  },
  {
    id: "pc",
    name: "Studio PC",
    sub: "Windows · 1.4.2 · last seen yesterday",
    ico: "🖥",
  },
];

const state = {
  route: "library",
  product: null,
  loaded: false,
  devices: [...INITIAL_DEVICES],
  activated: false,
};
const view = document.getElementById("view");

function art(slug, extra = "") {
  return h(`div.art.${slug}${extra}`, { "aria-hidden": "true" });
}

// ── Library ─────────────────────────────────────────────────────────────────────────────────────
function librarySkeleton() {
  return h(
    "div",
    h("h1.page-title", "Your library"),
    h("p.lede", "3 products · signed in as mara@fennick.studio"),
    h(
      "div.grid.pk-skeleton-group",
      { "aria-busy": "true", "aria-label": "Loading your library" },
      [0, 1, 2].map(() =>
        h(
          "div.sk-tile",
          h("div.pk-skeleton.art"),
          h("div.pk-skeleton.sk-line.w60"),
          h("div.pk-skeleton.sk-line.w40"),
        ),
      ),
    ),
  );
}

function library() {
  return h(
    "div",
    h("h1.page-title", "Your library"),
    h("p.lede", "3 products · signed in as mara@fennick.studio"),
    h(
      `div.grid${state.loaded ? "" : ".pk-stagger"}`,
      PRODUCTS.map((p) =>
        h(
          "button.tile.pk-lift.pk-pressable",
          {
            type: "button",
            "data-slug": p.slug,
            on: { click: (e) => openProduct(p, e.currentTarget) },
          },
          h("div.art-wrap", art(p.slug, ".pk-lift-art")),
          h(
            "div.meta",
            h("h3", p.name),
            h(
              "p",
              p.slug === "nightfall" && state.activated
                ? "Deluxe · 3 of 3 devices"
                : p.sub,
            ),
          ),
        ),
      ),
    ),
  );
}

// ── Product ─────────────────────────────────────────────────────────────────────────────────────
function product(p) {
  const used = state.devices.length;
  return h(
    "div",
    h(
      "button.back",
      { type: "button", on: { click: backToLibrary } },
      "← Library",
    ),
    art(p.slug, ".hero.pk-vt-hero"),
    h(
      "div.hero-row",
      h(
        "div",
        h(
          "h1.pk-vt-hero-title",
          { tabindex: "-1", id: "product-title" },
          p.name,
        ),
        h("div.by", `by ${p.by} · ${p.tier}`),
      ),
      h(
        "button.btn.primary.pk-pressable",
        { type: "button" },
        "Download for macOS",
      ),
    ),
    h(
      "div.cols",
      h(
        "section.card",
        h("h2", `Get ${p.name}`),
        h("p.muted", "Latest: 1.4.2, released 22 Sep 2026"),
        [
          ["macOS", "Universal · .dmg · 3.1 GB"],
          ["Windows", "x64 · .exe · 3.4 GB"],
          ["Linux", "x86_64 · .appimage · 3.2 GB"],
        ].map(([os, d]) =>
          h(
            "div.platform",
            h("div", h("strong", os), h("div.muted", d)),
            h("button.btn.sm.pk-pressable", { type: "button" }, "Download"),
          ),
        ),
      ),
      h(
        "aside",
        h(
          "section.card",
          h("h2", `${p.name} license`),
          h("p.muted", "Licensed to mara@fennick.studio"),
          h("span.pill", p.tier),
        ),
        devicesCard(used),
      ),
    ),
  );
}

function devicesCard(used) {
  return h(
    "section.card.pk-vt-scope#devices",
    h("h2", "Devices"),
    h(
      "div.dev-head",
      h("strong#dev-count", { "aria-hidden": "true" }, String(used)),
      h("span.sr-only", String(used)),
      h("span.muted", `of ${SEATS} devices in use`),
      used >= SEATS
        ? h("span.pill.warn.pk-pop-in#full-pill", h("i"), "All seats used")
        : null,
    ),
    h(
      "div.meter#meter",
      { "aria-hidden": "true" },
      Array.from({ length: SEATS }, (_, i) =>
        h("span.pk-seg", { "data-used": i < used }),
      ),
    ),
    h("ul.devices#device-list", state.devices.map(deviceRow)),
    h("p.muted", "Removing a device frees its seat at once."),
  );
}

function deviceRow(d) {
  const confirmId = `confirm-${d.id}`;
  return h(
    "li",
    { "data-id": d.id },
    h(
      "div.dev",
      h("span.ico", { "aria-hidden": "true" }, d.ico),
      h("div", h("div.name", d.name), h("div.sub", d.sub)),
      h(
        "button.btn.sm.pk-pressable",
        {
          type: "button",
          "aria-expanded": "false",
          "aria-controls": confirmId,
          on: { click: (e) => toggleConfirm(d, e.currentTarget) },
        },
        "Remove",
      ),
    ),
    h(
      `div.pk-expand#${confirmId}`,
      h(
        "div",
        h(
          "div.confirm",
          h("h3", { tabindex: "-1" }, `Remove ${d.name}?`),
          h(
            "p",
            "Polaris Key signs it out of Nightfall and frees its seat. You can sign in on it again later.",
          ),
          h(
            "div.row",
            h(
              "button.btn.sm.pk-pressable",
              {
                type: "button",
                on: {
                  click: (e) =>
                    toggleConfirm(
                      d,
                      e.currentTarget.closest("li").querySelector(".dev .btn"),
                    ),
                },
              },
              "Cancel",
            ),
            h(
              "button.btn.sm.danger.pk-pressable",
              { type: "button", on: { click: () => removeDevice(d) } },
              "Remove device",
            ),
          ),
        ),
      ),
    ),
  );
}

// ── Navigation ──────────────────────────────────────────────────────────────────────────────────
function render() {
  view.replaceChildren(
    state.route === "library" ? library() : product(state.product),
  );
}

function openProduct(p, tile) {
  const tileArt = tile.querySelector(".art");
  const tileName = tile.querySelector("h3");
  viewTransition(
    () => {
      state.route = "product";
      state.product = p;
      render();
      scrollTo(0, 0);
    },
    {
      type: "forward",
      shared: [
        [tileArt, "pk-hero"],
        [tileName, "pk-hero-title"],
      ],
    },
  ).updateCallbackDone.then(() =>
    document.getElementById("product-title")?.focus({ preventScroll: true }),
  );
}

function backToLibrary() {
  const slug = state.product.slug;
  // The hero and title already carry their names; the tile picks them up in the new state.
  let named = [];
  const t = viewTransition(
    () => {
      state.route = "library";
      render();
      scrollTo(0, 0);
      const tile = view.querySelector(`[data-slug="${slug}"]`);
      named = [
        [tile.querySelector(".art"), "pk-hero"],
        [tile.querySelector("h3"), "pk-hero-title"],
      ];
      for (const [el, n] of named)
        el.style.setProperty("view-transition-name", n);
    },
    { type: "back" },
  );
  t.updateCallbackDone.then(() =>
    view.querySelector(`[data-slug="${slug}"]`)?.focus({ preventScroll: true }),
  );
  t.finished.then(() => {
    for (const [el] of named) el.style.removeProperty("view-transition-name");
  });
}

// ── Free a device ───────────────────────────────────────────────────────────────────────────────
function toggleConfirm(d, button) {
  const region = document.getElementById(`confirm-${d.id}`);
  const open = !region.hasAttribute("data-open");
  region.toggleAttribute("data-open", open);
  button.setAttribute("aria-expanded", String(open));
  if (open) region.querySelector("h3").focus({ preventScroll: true });
  else button.focus();
}

function updateDevices({ removed, added, from }) {
  const list = document.getElementById("device-list");
  viewTransition(
    () => {
      if (removed) list.querySelector(`[data-id="${removed.id}"]`)?.remove();
      if (added) list.append(deviceRow(added));
      const used = state.devices.length;
      // Meter: the segment that changed pulses once while its colour eases.
      document.querySelectorAll("#meter .pk-seg").forEach((seg, i) => {
        const was = seg.hasAttribute("data-used");
        const now = i < used;
        seg.toggleAttribute("data-used", now);
        if (was !== now) {
          seg.setAttribute("data-changed", "");
          setTimeout(() => seg.removeAttribute("data-changed"), 160);
        }
      });
      // Full pill appears (pops) or leaves.
      const head = document.querySelector(".dev-head");
      const pill = document.getElementById("full-pill");
      if (used >= SEATS && !pill)
        head.append(
          h("span.pill.warn.pk-pop-in#full-pill", h("i"), "All seats used"),
        );
      if (used < SEATS && pill) pill.remove();
      countTo(document.getElementById("dev-count"), used, {
        from,
        duration: 320,
      });
    },
    { type: "list", list },
  ).updateCallbackDone.then(() => {
    if (added) highlight(list.querySelector(`[data-id="${added.id}"]`));
  });
}

function removeDevice(d) {
  const index = state.devices.findIndex((x) => x.id === d.id);
  state.devices.splice(index, 1);
  updateDevices({ removed: d, from: state.devices.length + 1 });
  document.getElementById("product-title")?.focus({ preventScroll: true });
  toast(`${d.name} removed · its seat is free`, {
    action: "Undo",
    onAction: () => {
      state.devices.splice(index, 0, d);
      updateDevices({ added: d, from: state.devices.length - 1 });
    },
  });
}

// ── Activate ────────────────────────────────────────────────────────────────────────────────────
const overlay = document.getElementById("overlay");
const dialog = document.getElementById("dialog");
let lastFocus = null;

function openActivate() {
  lastFocus = document.activeElement;
  dialog.replaceChildren(keyStep());
  presence(overlay, true);
  presence(dialog, true);
  dialog.querySelector("input").focus();
}

function closeDialog() {
  presence(overlay, false);
  presence(dialog, false);
  lastFocus?.focus?.();
}

function keyStep() {
  const field = h("input.field", {
    value: "PKEY-NIGHT-FALL-2026-DLX",
    "aria-label": "License key",
    autocomplete: "off",
    spellcheck: "false",
  });
  const go = h(
    "button.btn.primary.pk-pressable",
    { type: "button" },
    "Activate",
  );
  go.addEventListener("click", () => {
    go.replaceChildren(
      h("span.spinner", { "aria-hidden": "true" }),
      "Activating…",
    );
    go.setAttribute("aria-disabled", "true");
    setTimeout(activated, 700);
  });
  return h(
    "div",
    h("h2#dlg-title", "Activate a license"),
    h("p.muted", "Paste the key from your email or store receipt."),
    field,
    h(
      "div.actions",
      h(
        "button.btn.pk-pressable",
        { type: "button", on: { click: closeDialog } },
        "Cancel",
      ),
      go,
    ),
  );
}

function activated() {
  // The dialog keeps its name (pk-dialog), so the View Transition morphs its size between steps.
  viewTransition(
    () => {
      const mark = h("div.success", check());
      dialog.replaceChildren(
        h(
          "div.center",
          mark,
          h(
            "h2#dlg-title",
            { tabindex: "-1" },
            "Nightfall is yours on this Mac",
          ),
          h("p.muted", "This Mac now uses a seat: 3 of 3 devices."),
          h(
            "div.actions",
            h(
              "button.btn.primary.pk-pressable",
              { type: "button", on: { click: finishActivate } },
              "Done",
            ),
          ),
        ),
      );
      celebrateOnce("activate-nightfall", mark);
    },
    { type: "dialog" },
  ).updateCallbackDone.then(() => dialog.querySelector("h2").focus());
}

function finishActivate() {
  closeDialog();
  if (state.activated) return;
  state.activated = true;
  const device = {
    id: "mac",
    name: "This Mac",
    sub: "macOS · 1.4.2 · activated just now",
    ico: "💻",
  };
  state.devices.push(device);
  if (state.route === "product")
    setTimeout(
      () => updateDevices({ added: device, from: state.devices.length - 1 }),
      reducedMotion() ? 0 : 220,
    );
  toast("Nightfall activated on this Mac");
}

document
  .getElementById("activate-open")
  .addEventListener("click", openActivate);
overlay.addEventListener("click", closeDialog);
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !dialog.hidden) closeDialog();
});

// ── Boot ────────────────────────────────────────────────────────────────────────────────────────
function boot() {
  Object.assign(state, {
    route: "library",
    product: null,
    loaded: false,
    devices: [...INITIAL_DEVICES],
    activated: false,
  });
  try {
    localStorage.removeItem("pk-moment:activate-nightfall");
  } catch {}
  view.replaceChildren(librarySkeleton());
  setTimeout(() => {
    render();
    state.loaded = true;
  }, 700);
}
wireProtoBar(boot);
window.__proto = {
  state,
  openProduct,
  backToLibrary,
  openActivate,
  removeDevice,
  toggleConfirm,
  boot,
};
boot();
