// S-23 console prototype: product overview → licence record → device drawer → confirm → toast.
import { h, check } from "./h.js";
import {
  viewTransition,
  presence,
  countTo,
  setMeter,
  highlight,
  celebrateOnce,
} from "./motion.js";
import { wireProtoBar, toast } from "./shared.js";

const LICENSES = [
  {
    key: "pkey_nightfall_9F2C",
    holder: "mara@fennick.studio",
    tier: "Deluxe",
    status: "Active",
  },
  {
    key: "pkey_nightfall_41AA",
    holder: "ada@lovelace.dev",
    tier: "Standard",
    status: "Active",
  },
  {
    key: "pkey_nightfall_7B10",
    holder: "booth@venue.events",
    tier: "Deluxe",
    status: "Suspended",
  },
  {
    key: "pkey_nightfall_C03E",
    holder: "sam@kiln.games",
    tier: "Standard",
    status: "Active",
  },
  {
    key: "pkey_nightfall_5D77",
    holder: "lee@north.wind",
    tier: "Standard",
    status: "Expired",
  },
  {
    key: "pkey_nightfall_E812",
    holder: "ivy@tide.water",
    tier: "Deluxe",
    status: "Active",
  },
  {
    key: "pkey_nightfall_2A90",
    holder: "kai@ember.studio",
    tier: "Standard",
    status: "Suspended",
  },
  {
    key: "pkey_nightfall_8E44",
    holder: "jo@lantern.works",
    tier: "Deluxe",
    status: "Active",
  },
];
// ?rows=N pads the table to N licences, for the long-list performance check (tools/perf.mjs).
const ROWS = Number(new URLSearchParams(location.search).get("rows")) || 0;
for (let i = LICENSES.length; i < ROWS; i++) {
  const status = ["Active", "Active", "Suspended", "Expired"][i % 4];
  LICENSES.push({
    key: `pkey_nightfall_${(4096 + i * 37).toString(16).toUpperCase()}`,
    holder: `user${i}@example.com`,
    tier: i % 3 ? "Standard" : "Deluxe",
    status,
  });
}
const DEVICES = [
  { id: "d1", name: "Studio Mac", os: "macOS 15.1", status: "Authorized" },
  { id: "d2", name: "Ada's laptop", os: "Windows 11", status: "Authorized" },
  { id: "d3", name: "Stage iPad", os: "iPadOS 18", status: "Authorized" },
];

const state = {
  route: "overview",
  filter: "All",
  license: null,
  tab: "Status",
  devices: DEVICES.map((d) => ({ ...d })),
};
const view = document.getElementById("view");
const pillClass = {
  Active: "ok",
  Authorized: "ok",
  Suspended: "warn",
  Expired: "bad",
  Deauthorized: "bad",
};
const pill = (s, extra = "") =>
  h(`span.pill.pk-pill.${pillClass[s]}${extra}`, h("i"), s);

// ── Overview ────────────────────────────────────────────────────────────────────────────────────
function overviewSkeleton() {
  return h(
    "div",
    h("div.page-head", h("h1", { tabindex: "-1" }, "Overview")),
    h(
      "div.tiles.pk-skeleton-group",
      { "aria-busy": "true" },
      [0, 1, 2, 3].map(() => h("div.pk-skeleton.sk-stat")),
    ),
  );
}

function overview() {
  const stat = (label, id, extra) =>
    h(
      "div.card.tile-stat",
      h("div.label", label),
      h(`div.value#${id}`, { "aria-hidden": "true" }, "0"),
      h("span.sr-only"),
      extra,
    );
  return h(
    "div.pk-content-in",
    h(
      "div.page-head",
      h("h1", { tabindex: "-1" }, "Overview"),
      h("span.muted", "Nightfall · production"),
    ),
    h(
      "div.tiles.pk-stagger",
      stat("Active licenses", "s-lic"),
      stat("Devices", "s-dev"),
      stat(
        "Refreshed after key rotation",
        "s-ref",
        h("div.bar-meter", h("div.pk-meter-fill#m-ref")),
      ),
      stat("Releases this month", "s-rel"),
    ),
    h(
      "div.card.banner#first-release",
      h("div.success#first-release-mark", check()),
      h(
        "div",
        h("strong", "Your first release is live"),
        h("div.muted", "1.4.2 · signed by release key K-2 · 2 min ago"),
      ),
      h(
        "button.btn.primary.sm.pk-pressable",
        { type: "button" },
        "Roll it out",
      ),
    ),
    h("h2.section-title", "Needs attention"),
    h(
      "ul.card.attention.pk-stagger",
      h(
        "li",
        pill("Suspended"),
        h("span", "2 licenses suspended for chargebacks"),
        h("span.muted", "· today"),
      ),
      h(
        "li",
        pill("Expired"),
        h("span", "Signing key K-1 retires in 6 days"),
        h("span.muted", "· 92% of devices refreshed"),
      ),
      h(
        "li",
        pill("Active"),
        h("span", "Storefront listing approved on Steam"),
        h("span.muted", "· yesterday"),
      ),
    ),
  );
}

function animateOverview() {
  for (const [id, n] of [
    ["s-lic", 1284],
    ["s-dev", 3912],
    ["s-ref", 92],
    ["s-rel", 3],
  ])
    countTo(document.getElementById(id), n, { duration: 480 });
  setMeter(document.getElementById("m-ref"), 0.92);
  celebrateOnce(
    "first-release-nightfall",
    document.getElementById("first-release-mark"),
  );
}

// ── Licenses ────────────────────────────────────────────────────────────────────────────────────
function licenses() {
  rowCache.clear();
  const counts = { All: LICENSES.length };
  for (const l of LICENSES) counts[l.status] = (counts[l.status] ?? 0) + 1;
  return h(
    "div",
    h(
      "div.page-head",
      h("h1", { tabindex: "-1" }, "Licenses"),
      h("span.muted", `${LICENSES.length} licenses`),
    ),
    h(
      "div.chips",
      { role: "group", "aria-label": "Filter by status" },
      ["All", "Active", "Suspended", "Expired"].map((f) =>
        h(
          "button.chip.pk-pressable",
          {
            type: "button",
            "aria-pressed": String(state.filter === f),
            on: { click: () => setFilter(f) },
          },
          f,
          h("span.n", String(counts[f] ?? 0)),
        ),
      ),
    ),
    h(
      "div.table.pk-vt-scope",
      h(
        "div.thead",
        h("span", "Key"),
        h("span", "Holder"),
        h("span", "Tier"),
        h("span", "Status"),
      ),
      h("div.tbody#lic-rows", licenseRows()),
    ),
  );
}

// Rows keep their elements across filters (as React keeps keyed rows), so a list View Transition
// pairs each surviving row with itself and moves it, instead of fading every row out and in.
const rowCache = new Map();
function licenseRows() {
  return LICENSES.filter(
    (l) => state.filter === "All" || l.status === state.filter,
  ).map((l) => {
    if (!rowCache.has(l.key)) rowCache.set(l.key, licenseRow(l));
    return rowCache.get(l.key);
  });
}
function licenseRow(l) {
  return h(
    "button.trow",
    {
      type: "button",
      "data-key": l.key,
      on: { click: (e) => openLicense(l, e.currentTarget) },
    },
    h("span.key", l.key),
    h("span", l.holder),
    h("span", l.tier),
    h("span", pill(l.status)),
  );
}

function setFilter(f) {
  if (state.filter === f) return;
  const rows = document.getElementById("lic-rows");
  viewTransition(
    () => {
      state.filter = f;
      document
        .querySelectorAll(".chip")
        .forEach((c) =>
          c.setAttribute(
            "aria-pressed",
            String(c.firstChild.textContent === f),
          ),
        );
      rows.replaceChildren(...licenseRows());
    },
    { type: "list", list: rows },
  );
}

// ── Record ──────────────────────────────────────────────────────────────────────────────────────
function record(l) {
  return h(
    "div",
    h(
      "button.btn.ghost.sm",
      { type: "button", on: { click: () => go("licenses", { type: "back" }) } },
      "← Licenses",
    ),
    h(
      "div.record-head",
      h("h1.key.pk-vt-key", { tabindex: "-1", id: "record-title" }, l.key),
      pill(l.status),
    ),
    h("div.muted", `${l.holder} · ${l.tier} · issued 3 Oct 2026`),
    h(
      "div.rtabs",
      { role: "tablist" },
      ["Status", "Devices", "Activity"].map((t) =>
        h(
          "button",
          {
            role: "tab",
            type: "button",
            "aria-selected": String(state.tab === t),
            on: { click: () => setTab(t) },
          },
          t,
          state.tab === t ? h("b.pk-vt-indicator") : null,
        ),
      ),
    ),
    h("div.pk-vt-tabpanel#tabpanel", { role: "tabpanel" }, tabPanel()),
  );
}

function tabPanel() {
  if (state.tab === "Status")
    return h(
      "div",
      h(
        "div.card.health",
        h("strong", "Healthy."),
        " Last check 7 sec. ago from Studio Mac. No refusals in 30 days.",
      ),
      h(
        "div.card.health",
        h("strong", "3 of 3 devices"),
        " in use. Deauthorize one to free a seat.",
      ),
    );
  if (state.tab === "Devices")
    return h(
      "div.table.dev-table",
      h("div.thead", h("span", "Device"), h("span", "OS"), h("span", "Status")),
      h(
        "div.tbody",
        state.devices.map((d) =>
          h(
            "button.trow",
            {
              type: "button",
              "data-id": d.id,
              on: { click: () => openDrawer(d) },
            },
            h("span", h("strong", d.name)),
            h("span.muted", d.os),
            h("span.status", pill(d.status)),
          ),
        ),
      ),
    );
  return h(
    "ul.card.attention",
    h("li", h("span.mono", "18:15"), "Studio Mac checked in"),
    h("li", h("span.mono", "17:02"), "Ada's laptop activated"),
    h("li", h("span.mono", "Mon"), "License issued by mara@fennick.studio"),
  );
}

function setTab(t) {
  if (state.tab === t) return;
  viewTransition(
    () => {
      state.tab = t;
      const panel = document.getElementById("tabpanel");
      document.querySelectorAll(".rtabs button").forEach((b) => {
        const on = b.firstChild.textContent === t;
        b.setAttribute("aria-selected", String(on));
        b.querySelector("b")?.remove();
        if (on) b.append(h("b.pk-vt-indicator"));
      });
      panel.replaceChildren(tabPanel());
    },
    { type: "tab" },
  );
}

// ── Drawer → confirm → toast ────────────────────────────────────────────────────────────────────
const overlay = document.getElementById("overlay");
const drawer = document.getElementById("drawer");
const overlay2 = document.getElementById("overlay2");
const dialog = document.getElementById("dialog");
let drawerReturn = null;

function openDrawer(d) {
  drawerReturn = document.activeElement;
  drawer.replaceChildren(
    h(
      "header",
      h("h2#drawer-title", { tabindex: "-1" }, d.name),
      h("div.mono.muted", `dev_${d.id}0000000000000001`),
    ),
    h(
      "div.body",
      h(
        "dl.facts",
        h("div", h("dt", "Status"), h("dd", pill(d.status))),
        h("div", h("dt", "License"), h("dd.mono", state.license.key)),
        h("div", h("dt", "Platform"), h("dd", d.os)),
        h("div", h("dt", "Last seen"), h("dd", "7 sec. ago")),
        h("div", h("dt", "Hardware binding"), h("dd", "Verified")),
        h("div", h("dt", "App version"), h("dd.mono", "1.4.2")),
      ),
    ),
    h(
      "footer",
      h(
        "button.btn.pk-pressable",
        { type: "button", on: { click: closeDrawer } },
        "Close",
      ),
      h(
        "button.btn.danger.pk-pressable",
        {
          type: "button",
          disabled: d.status !== "Authorized",
          on: { click: () => openConfirm(d) },
        },
        "Deauthorize…",
      ),
    ),
  );
  presence(overlay, true);
  presence(drawer, true);
  drawer.querySelector("h2").focus();
}

async function closeDrawer() {
  presence(overlay, false);
  await presence(drawer, false);
  drawerReturn?.focus?.();
}

function openConfirm(d) {
  dialog.replaceChildren(
    h("h2#dlg-title", `Deauthorize ${d.name}?`),
    h(
      "p.muted",
      "It stops using Nightfall until someone signs in on it again, and its seat is freed now.",
    ),
    h(
      "div.actions",
      h(
        "button.btn.pk-pressable#cancel",
        { type: "button", on: { click: closeConfirm } },
        "Cancel",
      ),
      h(
        "button.btn.danger.pk-pressable",
        { type: "button", on: { click: () => deauthorize(d) } },
        "Deauthorize",
      ),
    ),
  );
  presence(overlay2, true);
  presence(dialog, true);
  dialog.querySelector("#cancel").focus();
}

function closeConfirm() {
  presence(overlay2, false);
  return presence(dialog, false);
}

async function deauthorize(d) {
  closeConfirm();
  await closeDrawer();
  setStatus(d, "Deauthorized");
  toast(`${d.name} deauthorized · its seat is free`, {
    action: "Undo",
    onAction: () => setStatus(d, "Authorized"),
  });
}

function setStatus(d, status) {
  d.status = status;
  const row = document.querySelector(`.trow[data-id="${d.id}"]`);
  if (!row) return;
  const cell = row.querySelector(".status");
  const old = cell.firstElementChild;
  // The pill keeps its element so its colours ease, and its word pops in.
  old.className = `pill pk-pill ${pillClass[status]}`;
  old.replaceChildren(h("i"), h("span.pk-pop-in", status));
  highlight(row);
}

// ── Palette ─────────────────────────────────────────────────────────────────────────────────────
const palette = document.getElementById("palette");
let paletteReturn = null;
function openPalette() {
  paletteReturn = document.activeElement;
  palette.replaceChildren(
    h("input", { "aria-label": "Search", placeholder: "Search or jump to…" }),
    h(
      "ul",
      { role: "listbox" },
      h("li", { role: "option", "aria-selected": "true" }, "Licenses"),
      h("li", { role: "option" }, "Create license…"),
      h("li", { role: "option" }, "Devices"),
      h("li", { role: "option" }, "Rotate signing key…"),
    ),
  );
  presence(overlay, true);
  presence(palette, true);
  palette.querySelector("input").focus();
}
async function closePalette() {
  presence(overlay, false);
  await presence(palette, false);
  paletteReturn?.focus?.();
}
document.getElementById("palette-open").addEventListener("click", openPalette);
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    palette.hidden ? openPalette() : closePalette();
  }
  if (e.key === "Escape") {
    if (!dialog.hidden) closeConfirm();
    else if (!palette.hidden) closePalette();
    else if (!drawer.hidden) closeDrawer();
  }
});
overlay.addEventListener("click", () =>
  palette.hidden ? closeDrawer() : closePalette(),
);

// ── Routing ─────────────────────────────────────────────────────────────────────────────────────
function render() {
  const page =
    state.route === "overview"
      ? overview()
      : state.route === "licenses"
        ? licenses()
        : record(state.license);
  view.replaceChildren(page);
  document.querySelectorAll(".side a").forEach((a) => {
    const on =
      a.dataset.route === (state.route === "record" ? "licenses" : state.route);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.documentElement.dataset.service =
    state.route === "overview" ? "core" : "license";
}

function go(route, { type = "route", shared = [] } = {}) {
  viewTransition(
    () => {
      state.route = route;
      render();
      scrollTo(0, 0);
    },
    { type, shared },
  ).updateCallbackDone.then(() => {
    view.querySelector("h1")?.focus({ preventScroll: true });
    if (route === "overview") animateOverview();
  });
}

function openLicense(l, row) {
  state.license = l;
  state.tab = "Status";
  go("record", {
    type: "forward",
    shared: [[row.querySelector(".key"), "pk-key"]],
  });
}

document.querySelectorAll(".side a").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const r = a.dataset.route;
    if (r === "overview" || r === "licenses") go(r);
  }),
);

function boot() {
  Object.assign(state, {
    route: "overview",
    filter: "All",
    license: null,
    tab: "Status",
    devices: DEVICES.map((d) => ({ ...d })),
  });
  try {
    localStorage.removeItem("pk-moment:first-release-nightfall");
  } catch {}
  document.documentElement.dataset.service = "core";
  view.replaceChildren(overviewSkeleton());
  setTimeout(() => {
    render();
    animateOverview();
  }, 700);
}
wireProtoBar(boot);
window.__proto = {
  state,
  go,
  openLicense,
  setTab,
  setFilter,
  openDrawer,
  openConfirm,
  deauthorize,
  openPalette,
  closePalette,
  boot,
};
boot();
