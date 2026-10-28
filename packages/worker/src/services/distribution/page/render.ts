/**
 * The public download page's HTML (P2b-06): a pure function of the page model (`model.ts`) and
 * the visitor's detected platform (`detect.ts`). No I/O, no clock, no randomness — the same input
 * renders the same bytes.
 *
 * ── SAFE BY CONSTRUCTION ────────────────────────────────────────────────────────────────────
 *
 * Every string that reaches the markup goes through `esc` (text and attribute values alike; every
 * attribute is double-quoted). Every `href` goes through `safeHref`, which admits only an `https:`
 * URL the URL parser accepts or one of the deep-link schemes the Worker itself builds
 * (`model.ts`), so a `javascript:`, `data:` or `vbscript:` value can never become a link, whatever
 * a listing says. There is no script, no inline event handler, no `style=` attribute and one
 * external resource at most: the product's hosted icon on the image host (HA-07), a Worker-built
 * `https:` URL the policy names by origin. The one `<style>` element is allowed by its hash
 * (`PAGE_CSS`, `index.ts` sets the policy), and QR codes are inline SVG built from numbers
 * (`qr.ts`).
 *
 * ── THE PRIMARY ACTION ──────────────────────────────────────────────────────────────────────
 *
 * The detected platform's primary action leads the page. When the browser looked like a Mac in a
 * way an iPad does too (`touchAmbiguous`), the iOS primary is rendered beside it and CSS shows the
 * one that fits the pointer: `(hover: none) and (pointer: coarse)` is the script-free form of
 * `maxTouchPoints > 1`. With no detected platform, every platform's primary is offered.
 */

import { FONT, THEME_TOKENS } from "@polaris-key/brand";
import { buildLabel, type BuildLabel } from "@polaris-key/manifest";
import {
  LOCKER_LOCKUP_CSS,
  lockerFaviconHref,
  lockerLockup,
} from "../../../core/assets/lockerShell.js";
import type {
  DetectedPlatform,
  PagePlatform,
} from "../../../core/platformDetect.js";
import {
  pickBuild,
  type DownloadModel,
  type PageAction,
  type PageBuild,
  type PagePlatformGroup,
} from "./model.js";
import { BRAND_LOCKUP_HEIGHT } from "../../../core/brandHtml.js";
import { WORKER_HELP_LINKS } from "../../../core/helpLinks.js";
import { qrSvg } from "../../../core/qr.js";
import { escapeHtmlDecimalApostrophe as esc } from "../../../platform/html.js";

/** The deep-link schemes the Worker builds (`model.ts`). Nothing else but `https:` is linked. */
export const DEEP_LINK_SCHEMES = [
  "altstore:",
  "altstore-pal:",
  "sidestore:",
  "obtainium:",
  "fdroidrepos:",
  "ms-windows-store:",
  "steam:",
] as const;

/** An escaped `href` value, or `null` when the URL is not one the page may link to. */
export function safeHref(url: string | null): string | null {
  if (url === null || url.length > 4096) return null;
  // No whitespace or control characters anywhere: they are how scheme filters get dodged.
  if (/[\u0000- \u007f"'<>\\`]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === "https:") return esc(parsed.toString());
  if ((DEEP_LINK_SCHEMES as readonly string[]).includes(scheme)) {
    // The Worker built it; it must still START with the scheme it parses as.
    return url.toLowerCase().startsWith(scheme) ? esc(url) : null;
  }
  return null;
}

/** The page's colours for one theme: the brand theme tokens only. The page is customer-facing,
 *  so it is Polaris Locker: neutral ink for actions and links, the lockup's coral (`--lb`) only
 *  as the 2 px link underline (BRAND.md §8, "Customer download page"). */
function palette(theme: "dark" | "light"): string {
  const t = THEME_TOKENS[theme];
  return [
    `color-scheme:${theme}`,
    `--bg:${t.surface.page}`,
    `--card:${t.surface.raised}`,
    `--sunken:${t.surface.sunken}`,
    `--strong:${t.text.strong}`,
    `--fg:${t.text.default}`,
    `--muted:${t.text.muted}`,
    `--line:${t.border.subtle}`,
    `--edge:${t.border.strong}`,
    `--focus:${t.text.strong}`,
  ].join(";");
}

/**
 * The page's whole stylesheet: allowed by its SHA-256 in the page's CSP, nothing else is. Dark
 * first, light under `prefers-color-scheme: light` (BRAND.md §3). The type is the system stack
 * behind Rubik with no `@font-face`: the bytes host's policy has no font source (BRAND.md §8,
 * "What the page omits").
 */
export const PAGE_CSS = [
  `:root{${palette("dark")}}`,
  `@media (prefers-color-scheme:light){:root{${palette("light")}}}`,
  `*{box-sizing:border-box}`,
  `html{background:var(--bg)}`,
  `body{margin:0;background:var(--bg);color:var(--fg);font-family:${FONT.sans};font-synthesis:none;font-size:1rem;line-height:1.5;-webkit-text-size-adjust:100%}`,
  // The task frame (PORTAL.md §3.3): a top bar with the one lockup, then a centred column that
  // never pins left: breadcrumb, a 56 px identity row, the action card, the rest.
  `.top,main,header,footer{max-width:46rem;margin:0 auto;padding-left:1rem;padding-right:1rem}`,
  `.topbar{border-bottom:1px solid var(--line)}`,
  `.top{display:flex;align-items:center;min-height:4.5rem;padding-top:.5rem;padding-bottom:.5rem}`,
  `.cover{display:block;width:100%;height:120px;margin:0 0 1rem;border-radius:10px;object-fit:cover;background:var(--sunken)}`,
  `.top svg{display:block;max-width:100%;height:auto}`,
  `header{padding-top:1.5rem}`,
  `.crumbs{margin:0 0 1rem;color:var(--muted);font-size:.75rem;line-height:1rem}`,
  `.identity{display:flex;align-items:center;gap:1rem;min-width:0}`,
  `.identity>div{min-width:0}`,
  `.icon{display:block;flex:none;width:3.5rem;height:3.5rem;border-radius:22%;object-fit:contain}`,
  `h1{margin:0;color:var(--strong);font-size:3rem;line-height:3.25rem;font-weight:600;letter-spacing:-.02em;overflow-wrap:anywhere}`,
  `@media (max-width:640px){h1{font-size:2rem;line-height:2.25rem}}`,
  `.rec{margin:0 0 .25rem;color:var(--muted);font-size:.875rem}`,
  `h2{margin:2rem 0 .75rem;color:var(--strong);font-size:1.25rem;line-height:1.75rem;font-weight:600}`,
  `h3{margin:1.25rem 0 .5rem;color:var(--strong);font-size:1rem;font-weight:600}`,
  `.sub,.by,.meta,.note,footer{color:var(--muted)}`,
  `.sub{margin:1rem 0 0;font-size:1rem}`,
  `.by{margin:0;font-size:.875rem}`,
  `.primary{margin:1.5rem 0;min-width:0;padding:1.25rem;border:1px solid var(--line);border-radius:10px;background:var(--card)}`,
  `.primary h2{margin-top:0}`,
  `.button{display:inline-flex;align-items:center;min-height:44px;padding:.625rem 1.25rem;border-radius:6px;background:var(--strong);color:var(--bg);font-weight:500;text-decoration:none}`,
  `.button:focus-visible{outline:2px solid var(--focus);outline-offset:3px}`,
  `@media (max-width:480px){.button{display:flex;justify-content:center;width:100%}}`,
  `.meta{margin:.5rem 0 0;font-size:.875rem}`,
  `.touch-only{display:none}`,
  `@media (hover:none) and (pointer:coarse){.touch-only{display:block}.pointer-only{display:none}}`,
  `a{color:var(--strong);text-decoration:underline;text-decoration-color:var(--lb);text-decoration-thickness:2px;text-underline-offset:.2em}`,
  `.card{margin:0 0 1rem;border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:hidden}`,
  `.card>h3{margin:0;padding:.75rem 1rem;border-bottom:1px solid var(--line);font-size:1rem}`,
  `.rows{list-style:none;margin:0;padding:0}`,
  `.row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;padding:.75rem 1rem;border-top:1px solid var(--line)}`,
  `.row:first-child{border-top:0}`,
  `.row-extra{flex:1 1 100%;min-width:0;display:flex;flex-direction:column;gap:.5rem}`,
  `.row-lead .row-title{color:var(--muted);font-weight:400;font-size:.875rem}`,
  `.row-text{flex:1 1 14rem;min-width:0;display:flex;flex-direction:column;gap:.25rem}`,
  `.row-title{color:var(--strong);font-weight:500}`,
  `h3.row-title{margin:0;font-size:inherit}`,
  `.row-meta{display:flex;flex-wrap:wrap;gap:.25rem .75rem;color:var(--muted);font-size:.875rem}`,
  `.row-qr{flex:none;width:4rem;height:4rem}`,
  `.row-qr .qr{display:block;width:4rem;height:4rem;border-radius:4px}`,
  `.row-act{display:flex;flex-wrap:wrap;gap:.5rem;flex:none}`,
  `.obtn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:.5rem 1rem;border:1px solid var(--edge);border-radius:6px;color:var(--strong);font-weight:500;text-decoration:none}`,
  `.obtn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
  `@media (max-width:480px){.row-act{flex:1 1 100%}.obtn{flex:1 1 auto}.row-qr{display:none}}`,
  `.choose{list-style:none;padding:0;display:grid;gap:.75rem}`,
  `.choose .primary{margin:0}`,
  `details.files{margin:1rem 0}`,
  `summary{cursor:pointer;min-height:44px;display:flex;align-items:center;color:var(--strong);font-weight:500}`,
  `summary::before{content:"\\25B8";display:inline-block;width:1.25rem;color:var(--muted)}`,
  `details[open]>summary::before{content:"\\25BE"}`,
  `summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
  `a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
  `code{font:.85rem/1.4 ${FONT.mono};overflow-wrap:anywhere}`,
  `.cmd{display:block;padding:.5rem .75rem;border-radius:6px;background:var(--sunken);border:1px solid var(--line);color:var(--strong)}`,
  `.scroll{overflow-x:auto}`,
  `.scroll:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
  `table{border-collapse:collapse;width:100%;min-width:44rem;font-size:.875rem;font-variant-numeric:tabular-nums}`,
  `th,td{text-align:left;padding:.5rem .75rem;border-top:1px solid var(--line);vertical-align:top}`,
  `th{color:var(--muted);font-weight:400;font-size:.75rem}`,
  `.sha{word-break:break-all}`,
  `.mono code{font-size:.8125rem}`,
  `.summary{white-space:pre-line}`,
  `footer{padding:2.5rem 1rem 3rem;font-size:.875rem}`,
  `footer p{margin:0 0 1rem}`,
  LOCKER_LOCKUP_CSS,
].join("\n");

const KEY_LABELS: Readonly<Record<string, string>> = {
  "android-app-signing": "Android app signing certificate",
  "android-sideload": "Android sideload signing certificate",
  "fdroid-repo": "F-Droid repository signing certificate",
  "sparkle-ed25519": "macOS update (Sparkle) Ed25519 key",
  release: "Release-record signing key",
  "msix-publisher": "Windows (MSIX) publisher certificate",
};

/** `12345678` → `11.8 MB`. */
export function formatSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `1791331200` → `Oct 7, 2026` (UTC, so the same bytes render the same everywhere). */
function humanDay(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const d = new Date(seconds * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** The OS a minimum version is a version of, as the page says it. */
const OS_NAMES: Readonly<Record<PagePlatform, string>> = {
  ios: "iOS",
  android: "Android",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

function minOsText(b: PageBuild): string | null {
  return b.minOs ? `${OS_NAMES[b.platform]} ${b.minOs}` : null;
}

/** A build's platform and arch, in the page's wording ("macOS Apple silicon"). */
function labelOf(b: PageBuild): BuildLabel {
  return buildLabel(
    { platform: b.platform, arch: b.arch },
    { audience: "consumer" },
  );
}

function buildMeta(b: PageBuild): string {
  const min = minOsText(b);
  const parts = [
    `Version ${b.version}`,
    labelOf(b).short,
    b.format ? b.format.toUpperCase() : null,
    formatSize(b.size),
    min ? `requires ${min}` : null,
  ].filter((p): p is string => p !== null);
  return esc(parts.join(" · "));
}

/**
 * The "Arch" cell, beside the "Platform" cell: the display name with the raw value when they
 * differ ("Intel (x86_64)"), or the raw value where the platform implies it (iOS's `arm64`).
 */
function archCell(b: PageBuild): string {
  const arch = labelOf(b).arch;
  if (arch === null) return b.arch;
  return arch.toLowerCase() === b.arch.toLowerCase() || b.arch === "any"
    ? arch
    : `${arch} (${b.arch})`;
}

/**
 * A link to a Worker-validated URL. `detail` (a build's platform and arch) becomes the tooltip
 * and is appended to the accessible name, which still starts with the visible text.
 */
function link(url: string | null, text: string, cls = "", detail = ""): string {
  const href = safeHref(url);
  if (!href) return "";
  return `<a${cls ? ` class="${cls}"` : ""} href="${href}"${
    detail
      ? ` title="${esc(detail)}" aria-label="${esc(`${text}, ${detail}`)}"`
      : ""
  }>${esc(text)}</a>`;
}

/** The big button (and its line of detail) for one action. */
function primaryBody(
  a: PageAction,
  group: PagePlatformGroup,
  detected: DetectedPlatform,
): string {
  if (a.kind === "download") {
    const build =
      (detected.platform === group.platform
        ? pickBuild(group.builds, group.platform, detected.arch)
        : null) ?? a.build;
    if (!build) return "";
    const button = link(
      build.url,
      `Download for ${group.label}`,
      "button",
      `${build.name}, ${labelOf(build).long}`,
    );
    return `${button}<p class="meta">${buildMeta(build)}</p>`;
  }
  const target = a.deepLink ?? a.url;
  const verb =
    a.kind === "app-store" ||
    a.kind === "play" ||
    a.kind === "ms-store" ||
    a.kind === "steam" ||
    a.kind === "itch" ||
    a.kind === "flathub" ||
    a.kind === "snap"
      ? `Get it on ${a.label}`
      : a.label;
  const button = target ? link(target, verb, "button") : "";
  const command = a.command ? `<code class="cmd">${esc(a.command)}</code>` : "";
  const version = a.version
    ? `<p class="meta">Version ${esc(a.version)}</p>`
    : "";
  return `${button}${command}${version}`;
}

function primaryBlock(
  model: DownloadModel,
  group: PagePlatformGroup,
  detected: DetectedPlatform,
  cls: string,
  recommended = false,
): string {
  const a = model.actions.find((x) => x.id === group.primary);
  if (!a) return "";
  const body = primaryBody(a, group, detected);
  if (!body) return "";
  const rec = recommended
    ? `<p class="rec">Recommended for your device</p>`
    : "";
  const build = a.kind === "download" ? a.build : null;
  const older =
    build && model.release && build.version !== model.release.version
      ? `<p class="meta">Newest build for ${esc(group.label)}. ${esc(model.release.version)} has none yet.</p>`
      : "";
  return `<div class="primary${cls ? ` ${cls}` : ""}" data-platform="${esc(group.platform)}" data-action="${esc(a.kind)}">${rec}<h2>${esc(group.label)}</h2>${body}${older}</div>`;
}

/** One row of a platform's card: what it is, its QR code in a fixed column, outlined actions. */
function row(
  kind: string,
  title: string,
  meta: string[],
  extra: string[],
  qr: string,
  actions: string[],
  titleTag: "span" | "h3" = "span",
): string {
  const metaHtml = meta.length
    ? `<span class="row-meta">${meta.join("")}</span>`
    : "";
  const act = actions.filter((x) => x !== "");
  return `<li class="row" data-action="${esc(kind)}"><div class="row-text"><${titleTag} class="row-title">${esc(title)}</${titleTag}>${metaHtml}</div>${
    qr ? `<div class="row-qr">${qr}</div>` : ""
  }${act.length ? `<div class="row-act">${act.join("")}</div>` : ""}${
    extra.length ? `<div class="row-extra">${extra.join("")}</div>` : ""
  }</li>`;
}

/** The rows of one platform action: a row per build for a download, else one row. */
function way(a: PageAction, group: PagePlatformGroup): string {
  if (a.kind === "download") {
    // The `direct` outlet is presented as Polaris Locker (S-21 §6.8, LK-07); its id stays `direct`.
    const same = group.builds.filter((x) => x.releaseId === a.build?.releaseId);
    const rows = (same.length ? same : a.build ? [a.build] : []).map((b) =>
      row(
        a.kind,
        labelOf(b).long,
        [
          `<span>Version ${esc(b.version)}</span>`,
          ...(formatSize(b.size)
            ? [`<span>${esc(formatSize(b.size)!)}</span>`]
            : []),
          `<span class="mono"><code>${esc(b.name)}</code></span>`,
        ],
        [],
        "",
        [link(b.url, "Download", "obtn", `${b.name}, ${labelOf(b).long}`)],
      ),
    );
    // Said once per card, not on every build row.
    return rows.length
      ? `<li class="row row-lead" data-action="download"><span class="row-title">Download from Polaris Locker</span></li>${rows.join("")}`
      : "";
  }
  const meta = a.version ? [`<span>Version ${esc(a.version)}</span>`] : [];
  const actions: string[] = [];
  if (a.deepLink) actions.push(link(a.deepLink, "Open in the app", "obtn"));
  if (a.url && a.url !== a.deepLink)
    actions.push(
      link(
        a.url,
        a.kind === "altstore" ||
          a.kind === "sidestore" ||
          a.kind === "altstore-pal"
          ? "Source URL"
          : a.kind === "obtainium"
            ? "Open via obtainium.imranr.dev"
            : a.kind === "fdroid"
              ? "Repository URL"
              : `Open ${a.label}`,
        "obtn",
      ),
    );
  const extra: string[] = [];
  // The URL to paste by hand into AltStore, SideStore or F-Droid: shown only if it is one the
  // page would link to.
  if (
    (a.kind === "altstore" ||
      a.kind === "sidestore" ||
      a.kind === "altstore-pal" ||
      a.kind === "fdroid") &&
    a.url &&
    a.url.startsWith("https:") &&
    safeHref(a.url)
  )
    extra.push(`<code class="cmd">${esc(a.url)}</code>`);
  if (a.command) extra.push(`<code class="cmd">${esc(a.command)}</code>`);
  if (a.kind === "fdroid")
    extra.push(
      a.fingerprint
        ? `<span class="note">Repository fingerprint (SHA-256): <code class="sha">${esc(a.fingerprint)}</code></span>`
        : `<span class="note">No repository fingerprint is published: check it with the developer before trusting the repository.</span>`,
    );
  const svg = a.qr ? qrSvg(a.qr, esc(`QR code: ${a.label}`)) : null;
  return row(a.kind, a.label, meta, extra, svg ?? "", actions);
}

/** The header's icon: an `https:` URL only (`safeHref`), never a deep link; decorative. */
function iconTag(url: string | null): string {
  const src = url && url.startsWith("https:") ? safeHref(url) : null;
  return src
    ? `<img class="icon" src="${src}" alt="" width="56" height="56" decoding="async">`
    : "";
}

/** The cover band: an `https:` image-host URL only, decorative, never under text. */
function coverTag(url: string | null): string {
  const src = url && url.startsWith("https:") ? safeHref(url) : null;
  return src
    ? `<img class="cover" src="${src}" alt="" width="736" height="120" decoding="async">`
    : "";
}

/**
 * The release's generated `SHA256SUMS` (DC-15), beside its files: the URL of one of the release's
 * builds with the file name swapped. Null when the page offers no build of the release with a
 * `files/<releaseId>/<name>` URL, so nothing is linked that the Worker did not mint.
 */
function checksumsUrlOf(model: DownloadModel): string | null {
  const id = model.release?.releaseId;
  const url = model.platforms
    .flatMap((g) => g.builds)
    .find(
      (b) => b.releaseId === id && b.url.includes("/distribution/files/"),
    )?.url;
  return url ? url.replace(/\/[^/]+$/, "/SHA256SUMS") : null;
}

/** What the page shows beside its model, resolved per request (`index.ts`). */
export interface PageExtras {
  /**
   * The product's hosted icon on the image host (HA-07), or `null`. Drawn only when it is an
   * `https:` URL `safeHref` accepts; it is decorative (the name is the heading beside it).
   */
  iconUrl?: string | null;
  /** The product's cover on the image host, or `null`; drawn as a plain band, same rules. */
  coverUrl?: string | null;
  /**
   * The origin the footer's Help links resolve on (the customer site, else the console host;
   * `feedOriginOf`). `null` leaves the links out: the bytes host serves no docs.
   */
  helpOrigin?: string | null;
  /**
   * LK-12b: where "Add to my library" goes (`<customer origin>/<slug>`), or `null` for no row.
   * Set only when Identity says a new account would see the product in Discover.
   */
  libraryUrl?: string | null;
}

/** Render the page. */
export function renderDownloadPage(
  model: DownloadModel,
  detected: DetectedPlatform,
  extras: PageExtras = {},
): string {
  const name = model.listing.name;
  const helpOrigin = extras.helpOrigin ?? null;
  const groupOf = (p: PagePlatform | null) =>
    p === null ? undefined : model.platforms.find((g) => g.platform === p);
  const mine = groupOf(detected.platform);
  const ios = groupOf("ios");

  let lead = "";
  if (mine?.primary) {
    const touch =
      detected.touchAmbiguous && detected.platform === "macos" && ios?.primary
        ? primaryBlock(model, ios, detected, "touch-only", true)
        : "";
    lead =
      primaryBlock(model, mine, detected, touch ? "pointer-only" : "", true) +
      touch;
  }
  if (!lead) {
    const items = model.platforms
      .map((g) => primaryBlock(model, g, detected, ""))
      .filter((s) => s !== "")
      .map((s) => `<li>${s}</li>`);
    lead = items.length
      ? `<p class="note">Choose your platform:</p><ul class="choose">${items.join("")}</ul>`
      : `<p class="note">Nothing is available to download right now.</p>`;
  }

  const release = model.release
    ? `<section aria-labelledby="release-title"><h2 id="release-title">${esc(
        model.release.title ?? `Version ${model.release.version}`,
      )}</h2><p class="meta">Version ${esc(model.release.version)}${
        humanDay(model.release.publishedAt)
          ? ` · released ${esc(humanDay(model.release.publishedAt)!)}`
          : ""
      }</p>${
        model.release.summary
          ? `<p class="summary">${esc(model.release.summary)}</p>`
          : ""
      }</section>`
    : "";

  // The visitor's own platform's card leads.
  const ordered = [...model.platforms].sort(
    (x, y) =>
      Number(y.platform === detected.platform) -
      Number(x.platform === detected.platform),
  );
  const ways = ordered
    .map((g) => {
      const items = g.actions
        .map((id) => model.actions.find((a) => a.id === id))
        .filter((a): a is PageAction => a !== undefined)
        .map((a) => way(a, g));
      return items.length
        ? `<article class="card" aria-labelledby="p-${esc(g.platform)}"><h3 id="p-${esc(g.platform)}">${esc(g.label)}</h3><ul class="rows">${items.join("")}</ul></article>`
        : "";
    })
    .join("");

  const library = link(
    extras.libraryUrl ?? null,
    "Add to my library",
    "obtn",
    "Polaris Locker",
  );
  const libraryCard = library
    ? `<ul class="rows card">${row("locker-library", "Polaris Locker", [], [], "", [library], "h3")}</ul>`
    : "";

  const rows = model.platforms
    .flatMap((g) => g.builds)
    .map(
      (b) =>
        `<tr><td>${esc(b.version)}</td><td>${esc(labelOf(b).platform)}</td><td>${esc(archCell(b))}</td><td>${link(
          b.url,
          b.name,
          "",
          labelOf(b).long,
        )}</td><td>${esc(formatSize(b.size) ?? "")}</td><td>${esc(minOsText(b) ?? "")}</td><td class="sha"><code>${esc(b.sha256 ?? "")}</code></td></tr>`,
    );
  const sums = link(
    checksumsUrlOf(model),
    "SHA256SUMS",
    "",
    "Checksums of every file in this release",
  );
  const files = rows.length
    ? `<details class="files"><summary>All files and checksums</summary><div class="scroll" role="region" aria-label="All downloads, scrolls sideways" tabindex="0"><table><thead><tr><th>Version</th><th>Platform</th><th>Arch</th><th>File</th><th>Size</th><th>Minimum OS</th><th>SHA-256</th></tr></thead><tbody>${rows.join(
        "",
      )}</tbody></table></div>${
        sums
          ? `<p class="note">Verify with ${sums}: <code>sha256sum --check SHA256SUMS</code></p>`
          : ""
      }</details>`
    : "";

  const keys = model.keys.length
    ? `<section aria-labelledby="keys-title"><h2 id="keys-title">Signing keys</h2><p class="note">Check a download's signature against these fingerprints (for example with AppVerifier on Android).</p><ul class="rows card">${model.keys
        .map(
          (k) =>
            `<li class="row"><div class="row-text"><span class="row-title">${esc(
              KEY_LABELS[k.purpose] ?? k.purpose,
            )}</span><code class="sha">${esc(k.sha256)}</code></div></li>`,
        )
        .join("")}</ul></section>`
    : "";

  const about =
    model.listing.description || link(model.listing.website, "Website")
      ? `<section aria-labelledby="about-title"><h2 id="about-title">About ${esc(name)}</h2>${
          model.listing.description
            ? `<p class="summary">${esc(model.listing.description)}</p>`
            : ""
        }${
          link(model.listing.website, "Website")
            ? `<p>${link(model.listing.website, "Website")}</p>`
            : ""
        }</section>`
      : "";

  return [
    "<!doctype html>",
    '<html lang="en" data-brand="locker"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>Download ${esc(name)} · Polaris Locker</title>`,
    `<link rel="icon" type="image/svg+xml" href="${lockerFaviconHref()}">`,
    `<style>${PAGE_CSS}</style>`,
    "</head><body>",
    `<div class="topbar"><div class="top">${lockerLockup(BRAND_LOCKUP_HEIGHT.lockerBar, "lockup", true)}</div></div>`,
    `<header><p class="crumbs">${esc(name)} / Download</p>${coverTag(
      extras.coverUrl ?? null,
    )}<div class="identity">${iconTag(
      extras.iconUrl ?? null,
    )}<div><h1>${esc(name)}</h1>${
      model.listing.developerName
        ? `<p class="by">by ${esc(model.listing.developerName)}</p>`
        : ""
    }</div></div>${
      model.listing.subtitle
        ? `<p class="sub">${esc(model.listing.subtitle)}</p>`
        : ""
    }</header>`,
    `<main>${lead}${release}${
      ways || libraryCard
        ? `<section aria-labelledby="ways-title"><h2 id="ways-title">Every way to get ${esc(name)}</h2>${ways}${libraryCard}</section>`
        : ""
    }${files}${keys}${about}</main>`,
    `<footer><p>${
      helpOrigin
        ? `Before you install, <a href="${esc(helpOrigin + WORKER_HELP_LINKS.checkADownload)}">check the download is genuine</a>.`
        : "Verify a download's SHA-256 before you install it."
    }</p><p>Polaris Locker${
      helpOrigin
        ? ` · <a href="${esc(helpOrigin + WORKER_HELP_LINKS.help)}">Help</a>`
        : ""
    } · Questions about ${esc(name)}?${
      model.listing.developerName
        ? ` Contact ${esc(model.listing.developerName)}.`
        : ""
    }${
      link(model.listing.website, "Website")
        ? ` ${link(model.listing.website, "Website")}`
        : ""
    }</p></footer>`,
    "</body></html>",
    "",
  ].join("\n");
}
