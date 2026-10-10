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

import { BRAND, FONT, SERVICE_ACCENTS, THEME_TOKENS } from "@polaris-key/brand";
import { buildLabel, type BuildLabel } from "@polaris-key/manifest";
import { themedLockup } from "../../../core/brandHtml.js";
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

/** The page's colours for one theme: the brand theme tokens, Distribution's green as the one
 *  accent (BRAND.md §8: the bytes host is a delivery surface), the Star Cut's inks. */
function palette(theme: "dark" | "light"): string {
  const t = THEME_TOKENS[theme];
  const accent = SERVICE_ACCENTS[theme].distribution;
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
    `--accent:${accent.solid}`,
    `--accent-link:${accent.fg}`,
    `--accent-fg:${accent.on}`,
    `--accent-subtle:${accent.subtle}`,
    `--focus:${t.focus}`,
    `--mb:${BRAND.violet[theme]}`,
    `--ms:${BRAND.star[theme]}`,
    `--mt:${BRAND.text[theme]}`,
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
  `body{margin:0;background:var(--bg);color:var(--fg);font-family:${FONT.sans};font-synthesis:none;font-size:16px;line-height:1.5;-webkit-text-size-adjust:100%}`,
  `main,header,footer{max-width:56rem;margin:0 auto;padding:0 1rem}`,
  `header{padding-top:2.5rem}`,
  `.icon{display:block;width:4rem;height:4rem;margin:0 0 1rem;border-radius:22%;object-fit:contain}`,
  `h1{margin:0;color:var(--strong);font-size:2rem;line-height:2.5rem;font-weight:700;letter-spacing:-.01em}`,
  `h2{margin:2rem 0 .75rem;color:var(--strong);font-size:1.25rem;line-height:1.75rem;font-weight:700}`,
  `h3{margin:1.25rem 0 .5rem;color:var(--strong);font-size:1rem;font-weight:700}`,
  `.sub,.by,.meta,.note,footer{color:var(--muted)}`,
  `.sub{margin:.25rem 0 0;font-size:1.125rem}`,
  `.by{margin:.25rem 0 0;font-size:.875rem}`,
  `.primary{margin:1.5rem 0;padding:1.25rem;border:1px solid var(--line);border-radius:10px;background:var(--card)}`,
  `.primary h2{margin-top:0}`,
  `.button{display:inline-flex;align-items:center;min-height:44px;padding:.625rem 1.25rem;border-radius:6px;background:var(--accent);color:var(--accent-fg);font-weight:700;text-decoration:none}`,
  `.meta{margin:.5rem 0 0;font-size:.875rem}`,
  `.touch-only{display:none}`,
  `@media (hover:none) and (pointer:coarse){.touch-only{display:block}.pointer-only{display:none}}`,
  `.choose{list-style:none;padding:0;display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))}`,
  `.choose li{padding:1rem;border:1px solid var(--line);border-radius:10px;background:var(--card)}`,
  `.choose .primary{margin:0;padding:0;border:0;background:none}`,
  `.ways{list-style:none;padding:0;margin:0}`,
  `.way{padding:.75rem 0;border-top:1px solid var(--line);display:grid;gap:.35rem}`,
  `.way-head{color:var(--strong);font-weight:700}`,
  `a{color:var(--accent-link)}`,
  `a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
  `code{font:.85rem/1.4 ${FONT.mono};overflow-wrap:anywhere}`,
  `.cmd{display:block;padding:.5rem .75rem;border-radius:6px;background:var(--sunken);border:1px solid var(--line);color:var(--strong)}`,
  `.qr{width:9rem;height:9rem;border-radius:4px}`,
  `.scroll{overflow-x:auto}`,
  `table{border-collapse:collapse;width:100%;font-size:.875rem;font-variant-numeric:tabular-nums}`,
  `th,td{text-align:left;padding:.5rem .75rem;border-top:1px solid var(--line);vertical-align:top}`,
  `th{color:var(--muted);font-weight:400;font-size:.75rem}`,
  `.sha{word-break:break-all}`,
  `.summary{white-space:pre-line}`,
  `footer{padding:2.5rem 1rem 3rem;font-size:.875rem}`,
  `footer p{margin:0 0 1rem}`,
  `.delivery{display:block;line-height:0}`,
  `.delivery svg{display:block;max-width:100%;height:auto}`,
  `.mb{fill:var(--mb)}.ms{fill:var(--ms)}.mt{fill:var(--mt)}`,
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

function isoDay(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
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
): string {
  const a = model.actions.find((x) => x.id === group.primary);
  if (!a) return "";
  const body = primaryBody(a, group, detected);
  if (!body) return "";
  return `<div class="primary${cls ? ` ${cls}` : ""}" data-platform="${esc(group.platform)}" data-action="${esc(a.kind)}"><h2>${esc(group.label)}</h2>${body}</div>`;
}

/** One entry of "Other ways to get it". */
function way(a: PageAction, group: PagePlatformGroup): string {
  const parts: string[] = [];
  // The `direct` outlet is presented as Polaris Key (S-21 §6.8); its id stays `direct`.
  const head =
    a.kind === "download" && a.build ? `Download from Polaris Key` : a.label;
  parts.push(
    `<span class="way-head">${esc(head)}</span>${
      a.version ? ` <span class="meta">Version ${esc(a.version)}</span>` : ""
    }`,
  );
  const links: string[] = [];
  if (a.kind === "download") {
    for (const b of group.builds.filter(
      (x) => x.releaseId === a.build?.releaseId,
    ))
      links.push(
        link(b.url, b.name, "", labelOf(b).long) +
          ` <span class="meta">${buildMeta(b)}</span>`,
      );
  } else {
    if (a.deepLink) links.push(link(a.deepLink, "Open in the app"));
    if (a.url && a.url !== a.deepLink)
      links.push(
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
        ),
      );
  }
  const shown = links.filter((l) => l !== "");
  if (shown.length) parts.push(shown.join(" · "));
  // The URL to paste by hand into AltStore, SideStore or F-Droid — shown only if it is one the
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
    parts.push(`<code class="cmd">${esc(a.url)}</code>`);
  if (a.command) parts.push(`<code class="cmd">${esc(a.command)}</code>`);
  if (a.kind === "fdroid")
    parts.push(
      a.fingerprint
        ? `<span class="note">Repository fingerprint (SHA-256): <code class="sha">${esc(a.fingerprint)}</code></span>`
        : `<span class="note">No repository fingerprint is published: check it with the developer before trusting the repository.</span>`,
    );
  if (a.qr) {
    const svg = qrSvg(a.qr, esc(`QR code: ${a.label}`));
    if (svg) parts.push(svg);
  }
  return `<li class="way" data-action="${esc(a.kind)}">${parts.join("")}</li>`;
}

/** The header's icon: an `https:` URL only (`safeHref`), never a deep link; decorative. */
function iconTag(url: string | null): string {
  const src = url && url.startsWith("https:") ? safeHref(url) : null;
  return src
    ? `<img class="icon" src="${src}" alt="" width="64" height="64" decoding="async">`
    : "";
}

let delivery: string | null = null;

/**
 * The footer's service mark: the Polaris Key Delivery compact lockup (the Star Cut, BRAND.md
 * §1.1, §7.1) at 48 px tall, so its glyph is the 24 px service cut. Built once, on first use.
 */
function deliveryMark(): string {
  delivery ??= themedLockup("delivery", "compact", 48, "lockup");
  return delivery;
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
}

/** Render the page. */
export function renderDownloadPage(
  model: DownloadModel,
  detected: DetectedPlatform,
  extras: PageExtras = {},
): string {
  const name = model.listing.name;
  const groupOf = (p: PagePlatform | null) =>
    p === null ? undefined : model.platforms.find((g) => g.platform === p);
  const mine = groupOf(detected.platform);
  const ios = groupOf("ios");

  let lead = "";
  if (mine?.primary) {
    const touch =
      detected.touchAmbiguous && detected.platform === "macos" && ios?.primary
        ? primaryBlock(model, ios, detected, "touch-only")
        : "";
    lead =
      primaryBlock(model, mine, detected, touch ? "pointer-only" : "") + touch;
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
        isoDay(model.release.publishedAt)
          ? ` · released ${esc(isoDay(model.release.publishedAt)!)}`
          : ""
      }</p>${
        model.release.summary
          ? `<p class="summary">${esc(model.release.summary)}</p>`
          : ""
      }</section>`
    : "";

  const ways = model.platforms
    .map((g) => {
      const items = g.actions
        .map((id) => model.actions.find((a) => a.id === id))
        .filter((a): a is PageAction => a !== undefined)
        .map((a) => way(a, g));
      return items.length
        ? `<h3>${esc(g.label)}</h3><ul class="ways">${items.join("")}</ul>`
        : "";
    })
    .join("");

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
    ? `<section aria-labelledby="files-title"><h2 id="files-title">All downloads</h2><div class="scroll"><table><thead><tr><th>Version</th><th>Platform</th><th>Arch</th><th>File</th><th>Size</th><th>Minimum OS</th><th>SHA-256</th></tr></thead><tbody>${rows.join(
        "",
      )}</tbody></table></div>${
        sums
          ? `<p class="note">Verify with ${sums}: <code>sha256sum --check SHA256SUMS</code></p>`
          : ""
      }</section>`
    : "";

  const keys = model.keys.length
    ? `<section aria-labelledby="keys-title"><h2 id="keys-title">Signing keys</h2><p class="note">Check a download's signature against these fingerprints (for example with AppVerifier on Android).</p><ul class="ways">${model.keys
        .map(
          (k) =>
            `<li class="way"><span class="way-head">${esc(
              KEY_LABELS[k.purpose] ?? k.purpose,
            )}</span><code class="sha">${esc(k.sha256)}</code></li>`,
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
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>Download ${esc(name)}</title>`,
    `<style>${PAGE_CSS}</style>`,
    "</head><body>",
    `<header>${iconTag(extras.iconUrl ?? null)}<h1>${esc(name)}</h1>${
      model.listing.subtitle
        ? `<p class="sub">${esc(model.listing.subtitle)}</p>`
        : ""
    }${
      model.listing.developerName
        ? `<p class="by">by ${esc(model.listing.developerName)}</p>`
        : ""
    }</header>`,
    `<main>${lead}${release}${
      ways
        ? `<section aria-labelledby="ways-title"><h2 id="ways-title">Other ways to get it</h2>${ways}</section>`
        : ""
    }${files}${keys}${about}</main>`,
    `<footer><p>Verify a download's SHA-256 before you install it.</p><p class="delivery">${deliveryMark()}</p></footer>`,
    "</body></html>",
    "",
  ].join("\n");
}
