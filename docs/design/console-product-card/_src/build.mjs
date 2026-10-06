// Builds the console product card mockups (docs/design/console-product-card/README.md):
//
//   mise exec node@22 -- node docs/design/console-product-card/_src/build.mjs
//
// Writes, next to this folder:
//   a-rail.html, b-ledger.html, c-spectrum.html            Home at 1280 (3 columns) and 390 (one
//                                                          column), the same file: the layout is
//                                                          responsive, like the console's
//   a-rail-states.html, b-ledger-states.html, c-spectrum-states.html
//                                                          the states each direction must handle
//   _src/accents.generated.css                             each sample product's presentation accent
//                                                          resolved by @polaris-key/brand's own
//                                                          resolveAccent (UI-KITS.md §3.3)
//
// Glyphs are the console's own: lucide-react for six services and the brand's Star Cut for
// Distribution (markSvg, the string twin of the PolarisMark that ui/ServiceBadge.tsx draws). It also prints the
// contrast of every resolved accent role against the brand surfaces (the README's a11y table).

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..");
const repo = join(here, "../../../..");
const req = createRequire(join(repo, "packages/admin/package.json"));
const React = req("react");
const { renderToStaticMarkup } = req("react-dom/server");
const L = req("lucide-react");
const { markSvg } = await import(req.resolve("@polaris-key/brand/svg"));
const { resolveAccent } = await import(
  req.resolve("@polaris-key/brand/accent")
);
const { contrastRatio } = await import(req.resolve("@polaris-key/brand/color"));
const { THEME_TOKENS } = await import(req.resolve("@polaris-key/brand"));

const h = React.createElement;
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const icon = (C, size = 16) =>
  renderToStaticMarkup(h(C, { size, "aria-hidden": true }));
const fmt = (n) => n.toLocaleString("en-US");

// ── services (services.generated.ts order, ServiceBadge.tsx glyphs, nav.ts landing pages) ──
const SERVICES = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
];
const LABEL = {
  license: "License",
  config: "Config",
  release: "Release",
  distribution: "Distribution",
  update: "Update",
  identity: "Identity",
  sync: "Cloud Sync",
};
const LUCIDE = {
  license: L.KeyRound,
  config: L.SlidersHorizontal,
  release: L.Package,
  update: L.CircleArrowUp,
  identity: L.UserRound,
  sync: L.Cloud,
};
const LANDING = {
  license: "license/licenses",
  config: "config/catalog",
  release: "release/releases",
  distribution: "distribution/matrix",
  update: "update/feed",
  identity: "identity/portal",
  sync: "sync/data",
};
function glyph(s, size = 16) {
  const inner =
    s === "distribution"
      ? markSvg({ kind: "update", size, theme: "mono" })
      : icon(LUCIDE[s], size);
  return `<span class="glyph" data-service="${s}" aria-hidden="true">${inner}</span>`;
}
const landing = (p, s) => `#/p/${p.slug}/${LANDING[s]}`;

// ── stand-in developer art (content, not chrome): the icons the image host would serve ──
const art = (svg) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${svg}</svg>`)}`;
const ICONS = {
  tidewater: {
    shape: "square",
    src: art(
      '<rect width="128" height="128" fill="#2f8378"/><circle cx="90" cy="38" r="15" fill="#f6d58e"/><path d="M8 78c14-12 28-12 42 0s28 12 42 0 22-10 28-10" fill="none" stroke="#e9fbf6" stroke-width="10" stroke-linecap="round"/><path d="M8 102c14-12 28-12 42 0s28 12 42 0 22-10 28-10" fill="none" stroke="#8fd9cb" stroke-width="10" stroke-linecap="round"/>',
    ),
  },
  driftKart: {
    shape: "shaped",
    src: art(
      '<circle cx="64" cy="64" r="60" fill="#ff6a3d"/><circle cx="64" cy="64" r="51" fill="none" stroke="#fff4ec" stroke-width="4" stroke-dasharray="10 8"/><path d="M34 78 60 38h30L70 62h26L58 98l8-20Z" fill="#fff4ec"/>',
    ),
  },
  metronome: {
    shape: "square",
    src: art(
      '<rect width="128" height="128" fill="#26282e"/><path d="M50 22h28l20 84H30z" fill="#f2e6cf"/><path d="M64 98 86 38" stroke="#26282e" stroke-width="7" stroke-linecap="round"/><circle cx="80" cy="54" r="8" fill="#d9573b"/>',
    ),
  },
  harbor: {
    shape: "square",
    src: art(
      '<rect width="128" height="128" fill="#2f6b3a"/><path d="M0 104h128v24H0z" fill="#245a2f"/><path d="M54 42h20l7 62H47z" fill="#f4f1e8"/><path d="M51 58h26v9H51zM49 80h30v9H49z" fill="#d6452f"/><path d="M52 30h24v12H52z" fill="#ffd36b"/><path d="M58 22h12v8H58z" fill="#f4f1e8"/>',
    ),
  },
};

// ── sample products: the six cards every board shows ──
const LONG_NAME =
  "Northwind Broadcast Audio Workstation — Enterprise Edition for Studios";
const LONG_SLUG = "northwind-broadcast-audio-workstation";
const PRODUCTS = [
  {
    slug: "tidewater",
    name: "Tidewater Studio",
    accent: "#369186",
    icon: ICONS.tidewater,
    services: [
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
    ],
    facts: {
      license: 1284,
      config: 8,
      release: ["2.4.0", "stable"],
      distribution: 3,
      identity: 312,
    },
    attention: [],
    when: "Synced 2 hr ago",
  },
  {
    slug: "drift-kart",
    name: "Drift Kart",
    accent: "#ff6a3d",
    icon: ICONS.driftKart,
    services: ["license", "config", "release", "distribution", "update"],
    facts: {
      license: 46,
      config: 3,
      release: ["0.9.2", "beta"],
      distribution: 1,
    },
    attention: [
      {
        service: "release",
        tone: "info",
        short: "Needs setup",
        href: "release/releases",
      },
      {
        service: "config",
        tone: "warning",
        short: "Needs approval",
        href: "config/edge-mint",
      },
    ],
    when: "Synced yesterday",
  },
  {
    slug: "atlas-notes",
    name: "Atlas Notes",
    accent: "#b5651d",
    icon: null,
    services: ["license", "config", "identity"],
    facts: { license: 208, config: 2, identity: 1940 },
    attention: [],
    when: "Changed 3 days ago",
  },
  {
    slug: "metronome",
    name: "Metronome",
    accent: null,
    icon: ICONS.metronome,
    services: ["license"],
    facts: { license: 12 },
    attention: [],
    when: "Changed last week",
  },
  {
    slug: "harbor",
    name: "Harbor",
    accent: "#3a7d44",
    icon: ICONS.harbor,
    services: [...SERVICES],
    facts: {
      license: 9412,
      config: 14,
      release: ["5.1.0", "stable"],
      distribution: 6,
      identity: 8077,
    },
    attention: [],
    when: "Synced 20 min ago",
  },
  {
    slug: LONG_SLUG,
    name: LONG_NAME,
    accent: null,
    icon: null,
    services: ["license", "config", "identity", "sync"],
    facts: { license: 64, config: 5, identity: 71 },
    attention: [
      {
        service: "identity",
        tone: "warning",
        short: "Secret missing",
        href: "keys",
      },
    ],
    when: "Synced 4 hr ago",
  },
];
const byName = Object.fromEntries(PRODUCTS.map((p) => [p.slug, p]));

// Products used only on the states boards.
const QUAYSIDE = {
  slug: "quayside",
  name: "Quayside",
  accent: "#475569",
  icon: null,
  services: ["license", "config"],
  facts: { license: 530, config: 4 },
  attention: [
    { service: null, tone: "danger", short: "No signing key", href: "keys" },
  ],
  when: "Changed today",
};
const SANDBOX = {
  slug: "sandbox",
  name: "Sandbox",
  accent: null,
  icon: null,
  services: [],
  facts: {},
  attention: [],
  when: "Changed 2 weeks ago",
};
const ALL = [...PRODUCTS, QUAYSIDE, SANDBOX];

// ── facts: one per service; only Config's rides data Home already loads (/me schemaVersion) ──
const FREE_TODAY = new Set(["config"]);
function fact(p, s, mode = "all") {
  const f = p.facts[s];
  if (f == null) return null;
  if (mode === "today" && !FREE_TODAY.has(s)) return null;
  if (mode === "loading" && !FREE_TODAY.has(s)) return { loading: true };
  switch (s) {
    case "license":
      return {
        html: `${fmt(f)} active`,
        text: `${fmt(f)} active`,
        v: fmt(f),
        k: "licenses",
      };
    case "config":
      return {
        html: `Schema v${f}`,
        text: `Schema v${f}`,
        v: `v${f}`,
        k: "schema",
      };
    case "release":
      return {
        html: `<span class="mono-text">${f[0]}</span> · ${f[1]}`,
        text: `${f[0]} on ${f[1]}`,
        v: f[0],
        k: `on ${f[1]}`,
        mono: true,
      };
    case "distribution":
      return {
        html: `${f} ${f === 1 ? "storefront" : "storefronts"}`,
        text: `${f} ${f === 1 ? "storefront" : "storefronts"}`,
        v: String(f),
        k: f === 1 ? "storefront" : "storefronts",
      };
    case "identity":
      return {
        html: `${fmt(f)} users`,
        text: `${fmt(f)} users`,
        v: fmt(f),
        k: "users",
      };
    default:
      return null;
  }
}

// ── shared parts ──
const TONE_ICON = { warning: L.TriangleAlert, danger: L.CircleX, info: L.Info };
const TONE_RANK = { danger: 3, warning: 2, info: 1 };
const pill = (tone, text) =>
  `<span class="pill" data-tone="${tone}">${icon(TONE_ICON[tone], 12)}<span>${esc(text)}</span></span>`;
const worst = (items) =>
  items.reduce(
    (a, b) => (TONE_RANK[b.tone] > TONE_RANK[a] ? b.tone : a),
    "info",
  );
/** The header pill: the one issue by name, or a count. Healthy draws nothing. */
function headPill(items) {
  if (!items.length) return "";
  return pill(
    worst(items),
    items.length === 1 ? items[0].short : `${items.length} need attention`,
  );
}
const letterOf = (name) =>
  (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
/**
 * The logo: the hosted icon whenever a copy exists (`ready`, or a failed or stale re-pull that kept
 * the last good copy); otherwise the monogram tile, tinted when the product declares an accent.
 */
function logo(p, size = 40, state = "ready") {
  if (p.icon && state !== "pending" && state !== "failed-no-copy")
    return `<img class="logo ${p.icon.shape}" data-size="${size}" src="${p.icon.src}" width="${size}" height="${size}" alt="">`;
  return `<span class="logo mono${p.accent ? " tinted" : ""}" data-size="${size}" aria-hidden="true">${letterOf(p.name)}</span>`;
}
const idBlock = (p, o) =>
  `<div class="id"><h3 class="name" title="${esc(p.name)}"><a class="stretch" id="n-${o.uid}" href="#/p/${p.slug}">${esc(p.name)}</a></h3><p class="slug" title="${p.slug}">${p.slug}</p></div>`;
const attnFor = (p, s) => p.attention.filter((a) => a.service === s);
const dot = (items) =>
  items.length ? `<span class="dot" data-tone="${worst(items)}"></span>` : "";
const st = (o, kind, s) => {
  const c = [];
  if (o.hover === `${kind}:${s}`) c.push("is-hover");
  if (o.focus === `${kind}:${s}`) c.push("is-focus");
  return c.length ? ` ${c.join(" ")}` : "";
};
const cardState = (o) =>
  `${o.hover === "card" ? " is-hover" : ""}${o.focus === "card" ? " is-focus" : ""}`;
/** A service link's accessible name: the service, its fact, its issue. */
function serviceName(p, s, mode) {
  const f = fact(p, s, mode);
  const a = attnFor(p, s);
  return `${LABEL[s]}${f && !f.loading ? `: ${f.text}` : ""}${a.length ? `, ${a.map((x) => x.short.toLowerCase()).join(", ")}` : ""}`;
}
const tip = (p, s, mode) => {
  const f = fact(p, s, mode);
  const a = attnFor(p, s);
  return `<span class="tip" role="tooltip"><b>${LABEL[s]}</b>${f && !f.loading ? ` · ${f.text}` : ""}${a.length ? ` · ${a.map((x) => x.short).join(", ")}` : ""}</span>`;
};

// ── Direction A: Rail ──
function cardA(p, o = {}) {
  const mode = o.facts ?? "all";
  const rail = p.services.length
    ? `<ul class="rail" aria-label="Services">${p.services
        .map(
          (s) =>
            `<li><a class="chip${st(o, "svc", s)}" data-service="${s}" href="${landing(p, s)}" aria-label="${esc(serviceName(p, s, mode))}">${glyph(s)}${dot(attnFor(p, s))}${o.tip === s ? tip(p, s, mode) : ""}</a></li>`,
        )
        .join("")}</ul>`
    : `<p class="meta none">No services</p>`;
  return `<article class="card rounded-lg a${cardState(o)}" data-product="${p.slug}" aria-labelledby="n-${o.uid}">
  <div class="head" data-card-header>${logo(p, 40, o.icon)}${idBlock(p, o)}${headPill(p.attention)}</div>
  ${rail}
</article>`;
}

// ── Direction B: Ledger ──
const LEDGER_MAX = 4;
function ledgerRows(p) {
  if (p.services.length <= LEDGER_MAX) return { rows: p.services, more: [] };
  const hot = new Set(p.attention.map((a) => a.service).filter(Boolean));
  const ordered = [
    ...p.services.filter((s) => hot.has(s)),
    ...p.services.filter((s) => !hot.has(s)),
  ];
  const rows = ordered.slice(0, LEDGER_MAX - 1);
  return {
    rows: p.services.filter((s) => rows.includes(s)),
    more: p.services.filter((s) => !rows.includes(s)),
  };
}
function cardB(p, o = {}) {
  const mode = o.facts ?? "all";
  const { rows, more } = ledgerRows(p);
  const row = (s) => {
    const a = attnFor(p, s);
    const f = fact(p, s, mode);
    const right = a.length
      ? pill(worst(a), a.length === 1 ? a[0].short : `${a.length} issues`)
      : f?.loading
        ? `<span class="skel" aria-hidden="true"></span>`
        : f
          ? `<span class="val">${f.html}</span>`
          : "";
    const href = a.length ? `#/p/${p.slug}/${a[0].href}` : landing(p, s);
    return `<li><a class="row${st(o, "svc", s)}" data-service="${s}" href="${href}">${glyph(s)}<span class="lbl">${LABEL[s]}</span>${right}</a></li>`;
  };
  const moreRow = more.length
    ? `<li class="more">${more
        .map(
          (s) =>
            `<a class="chip${st(o, "svc", s)}" data-service="${s}" href="${landing(p, s)}" aria-label="${esc(serviceName(p, s, mode))}">${glyph(s)}</a>`,
        )
        .join("")}<span class="n">${more.length} more</span></li>`
    : "";
  const ledger = p.services.length
    ? `<ul class="ledger" aria-label="Services">${rows.map(row).join("")}${moreRow}</ul>`
    : `<ul class="ledger"><li class="empty">No services</li></ul>`;
  const productLevel = p.attention.filter((a) => !a.service);
  return `<article class="card rounded-lg b${cardState(o)}" data-product="${p.slug}" aria-labelledby="n-${o.uid}">
  <div class="head" data-card-header>${logo(p, 40, o.icon)}${idBlock(p, o)}${headPill(productLevel)}</div>
  ${ledger}
  <p class="meta">${esc(p.when)}</p>
</article>`;
}

// ── Direction C: Spectrum ──
const FIG_ORDER = ["release", "license", "identity", "distribution", "config"];
function cardC(p, o = {}) {
  const mode = o.facts ?? "all";
  const figs = FIG_ORDER.filter((s) => p.services.includes(s))
    .map((s) => [s, fact(p, s, mode)])
    .filter(([, f]) => f)
    .slice(0, 3);
  const figHtml = figs.length
    ? figs
        .map(([, f]) =>
          f.loading
            ? `<div class="fig"><span class="skel" aria-hidden="true"></span></div>`
            : `<div class="fig"><span class="v${f.mono ? " mono-text" : ""}">${esc(f.v)}</span><span class="k">${esc(f.k)}</span></div>`,
        )
        .join("")
    : `<p class="meta quiet">${p.services.length ? esc(p.when) : "No services"}</p>`;
  const slots = SERVICES.map((s) =>
    p.services.includes(s)
      ? `<li><a class="slot${st(o, "svc", s)}" data-service="${s}" href="${landing(p, s)}" aria-label="${esc(serviceName(p, s, mode))}">${glyph(s)}${dot(attnFor(p, s))}${o.tip === s ? tip(p, s, mode) : ""}</a></li>`
      : `<li aria-hidden="true"><span class="slot off"></span></li>`,
  ).join("");
  return `<article class="card rounded-lg c${cardState(o)}" data-product="${p.slug}" aria-labelledby="n-${o.uid}">
  <div class="band"><div class="band-top" data-card-header>${logo(p, 48, o.icon)}${headPill(p.attention)}</div>${idBlock(p, o)}</div>
  <div class="figs">${figHtml}</div>
  <ul class="spectrum" aria-label="Services">${slots}</ul>
</article>`;
}

// ── pages ──
const mark = `<span class="mark-dark">${markSvg({ kind: "key", size: 32, theme: "dark" })}</span><span class="mark-light">${markSvg({ kind: "key", size: 32, theme: "light" })}</span>`;
function page(title, bodyClass, body) {
  return `<!doctype html>
<!-- GENERATED by _src/build.mjs. Edit the generator, then rebuild; do not edit this file. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);})();</script>
<link rel="stylesheet" href="../../../packages/brand/fonts/fonts.css">
<link rel="stylesheet" href="../../../packages/brand/css/tokens.css">
<link rel="stylesheet" href="_src/cards.css">
<link rel="stylesheet" href="_src/accents.generated.css">
</head>
<body class="${bodyClass}">
${body}
</body>
</html>
`;
}
function home(cards) {
  return `<header class="top">
  <span class="act menu" aria-hidden="true">${icon(L.Menu, 20)}</span>
  <span aria-hidden="true">${mark}</span><span class="wm">Polaris Key</span><span class="grow"></span>
  <span class="search">${icon(L.Search, 16)}<span>Search or jump to…</span><kbd>⌘K</kbd></span>
  <span class="act">${icon(L.BookOpen, 16)}<span>Docs</span></span>
  <span class="act">${icon(L.Moon, 18)}</span>
  <span class="avatar">AL</span>
</header>
<nav class="side" aria-label="Main"><a aria-current="page">${icon(L.House, 16)}Home</a><a>${icon(L.Boxes, 16)}Products</a><p class="group">PLATFORM</p></nav>
<main id="content">
  <div class="ph"><div><h1 data-page-title>Home</h1><p class="sub">${cards.length} products</p></div><a class="btn" href="#/products/new">${icon(L.Plus, 16)}New product</a></div>
  <section class="panel" aria-labelledby="all">
    <div class="panel-head"><h2 id="all">All products</h2><div class="ctl"><span class="field filter">${icon(L.Search, 16)}Filter products</span><span class="field sort">Recently changed ${icon(L.ChevronDown, 16)}</span></div></div>
    <ul class="grid" aria-label="Products">${cards.map((c) => `<li>${c}</li>`).join("\n")}</ul>
  </section>
</main>`;
}

const DIRECTIONS = [
  { id: "a-rail", name: "A · Rail", card: cardA },
  { id: "b-ledger", name: "B · Ledger", card: cardB },
  { id: "c-spectrum", name: "C · Spectrum", card: cardC },
];
const tide = byName.tidewater;
const STATES = (d) => [
  {
    cap: "Icon still pulling",
    note: "No copy yet: the monogram, tinted by the declared accent. No spinner.",
    p: tide,
    o: { icon: "pending" },
  },
  {
    cap: "Pull failed, no accent",
    note: "No copy and no accent: a neutral monogram. A failed re-pull that kept a copy still shows the logo.",
    p: byName.metronome,
    o: { icon: "failed-no-copy" },
  },
  ...(d.id === "a-rail"
    ? [
        {
          cap: "Data Home has today",
          note: "A renders from today's data alone; until the summary read lands a tooltip names only the service.",
          p: tide,
          o: { facts: "today", hover: "svc:release", tip: "release" },
        },
        {
          cap: "What a dot means",
          note: "The dot points at the service; the header pill and the tooltip carry the words.",
          p: byName["drift-kart"],
          o: { hover: "svc:config", tip: "config" },
        },
      ]
    : [
        {
          cap: "Data Home has today",
          note: "Before the summary read: services, attention and Schema vN only.",
          p: tide,
          o: { facts: "today" },
        },
        {
          cap: "Facts loading",
          note: "The summary read in flight: shaped skeletons, no layout shift.",
          p: tide,
          o: { facts: "loading" },
        },
      ]),
  d.id === "a-rail"
    ? {
        cap: "Hover on a service",
        note: "The fact moves into the tooltip; the chip takes its service's subtle tint.",
        p: tide,
        o: { hover: "svc:license", tip: "license" },
      }
    : d.id === "b-ledger"
      ? {
          cap: "Hover",
          note: "The card edge takes the product accent; the row under the pointer is sunken.",
          p: tide,
          o: { hover: "card", rowHover: true },
        }
      : {
          cap: "Hover on a service",
          note: "The slot outlines in its accent; the tooltip names it and its fact.",
          p: tide,
          o: { hover: "svc:release", tip: "release" },
        },
  {
    cap: "Keyboard focus on the card",
    note: "The name link has focus: the violet ring goes around the whole card.",
    p: tide,
    o: { focus: "card" },
  },
  {
    cap: "Keyboard focus on a service",
    note: "The next Tab stop: its own violet ring, the card's ring off.",
    p: tide,
    o: { focus: d.id === "b-ledger" ? "svc:config" : "svc:config" },
  },
  {
    cap: "Issue on the product, not a service",
    note: "A signing key or a failed sync belongs to the product: a header pill.",
    p: QUAYSIDE,
    o: {},
  },
  {
    cap: "Runs no services",
    note: "Core only. One muted line keeps the card from reading as broken.",
    p: SANDBOX,
    o: {},
  },
];

let uid = 0;
for (const d of DIRECTIONS) {
  const cards = PRODUCTS.map((p) => d.card(p, { uid: `${d.id}-${uid++}` }));
  writeFileSync(
    join(outDir, `${d.id}.html`),
    page(`Home · ${d.name}`, "home", home(cards)),
  );
  const cells = STATES(d)
    .map(({ cap, note, p, o }) => {
      const opts = { ...o, uid: `${d.id}-${uid++}` };
      if (o.rowHover) opts.hover = "card";
      let html = d.card(p, opts);
      if (o.rowHover)
        html = html.replace('class="row"', 'class="row is-hover"');
      return `<div class="cell"><p class="cap"><b>${esc(cap)}</b>${esc(note)}</p><div class="frame">${html}</div></div>`;
    })
    .join("\n");
  writeFileSync(
    join(outDir, `${d.id}-states.html`),
    page(
      `States · ${d.name}`,
      "states",
      `<h1>${esc(d.name)}: states</h1><p class="lede">Each card at its real width at 1280 (301 px). Captions are annotations, not UI.</p><div class="cells">${cells}</div>`,
    ),
  );
}

// ── accents: each product's presentation accent through the brand resolver ──
const SURFACES = (t) => {
  const s = THEME_TOKENS[t].surface;
  return {
    page: s.page,
    raised: s.raised,
    overlay: s.overlay,
    sunken: s.sunken,
  };
};
let css = `/* GENERATED by _src/build.mjs from each sample product's presentation.accent, resolved by
   @polaris-key/brand resolveAccent (UI-KITS.md §3.3). Do not edit by hand. */\n`;
const block = (sel, t) =>
  ALL.filter((p) => p.accent)
    .map((p) => {
      const r = resolveAccent(
        t === "dark" ? (p.accentDark ?? p.accent) : p.accent,
        t,
      );
      return `${sel} [data-product="${p.slug}"] { --product-solid: ${r.solid}; --product-on: ${r.on}; --product-fg: ${r.fg}; --product-subtle: ${r.subtle}; }`;
    })
    .join("\n");
css += `${block(":root", "dark")}\n@media (prefers-color-scheme: light) {\n${block(':root:not([data-theme="dark"])', "light")}\n}\n${block('[data-theme="dark"]', "dark")}\n${block('[data-theme="light"]', "light")}\n`;
writeFileSync(join(here, "accents.generated.css"), css);

// ── the a11y table: the worst contrast of each role, per product and theme ──
const rows = [];
const PROBES = [
  ...ALL.filter((p) => p.accent).map((p) => [p.name, p.accent]),
  ["Pale yellow (stress)", "#fff3a0"],
  ["Near-black navy (stress)", "#0b1020"],
];
for (const [name, hex] of PROBES)
  for (const t of ["dark", "light"]) {
    const r = resolveAccent(hex, t);
    const surf = Object.values(SURFACES(t));
    const tx = THEME_TOKENS[t].text;
    rows.push({
      product: name,
      input: hex,
      theme: t,
      solid: r.solid,
      "solid vs surfaces (min)": Math.min(
        ...surf.map((s) => contrastRatio(r.solid, s)),
      ).toFixed(2),
      "letter on solid": contrastRatio(r.on, r.solid).toFixed(2),
      subtle: r.subtle,
      "strong on subtle": contrastRatio(tx.strong, r.subtle).toFixed(2),
      "muted on subtle": contrastRatio(tx.muted, r.subtle).toFixed(2),
      "warning on subtle": contrastRatio(
        THEME_TOKENS[t].status.warning.fg,
        r.subtle,
      ).toFixed(2),
    });
  }
console.table(rows);
console.log(`wrote ${DIRECTIONS.length * 2} boards and accents.generated.css`);
