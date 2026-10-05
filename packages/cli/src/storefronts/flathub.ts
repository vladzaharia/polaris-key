/**
 * The Flathub generators (A-18i; notes/S-15 §4.4).
 *
 *   MetaInfo   `<appId>.metainfo.xml`: name and summary (localized), description, screenshots,
 *              `releases` from the release's store notes, the OARS rating from the listing's
 *              content descriptors, the `developer` id (the app id's reverse-DNS prefix),
 *              `branding` with `tint` (light) and `tintDark` (dark), homepage and help URLs.
 *   skeleton   for the FIRST submission, which a person opens and shepherds to `flathub/flathub`
 *              against `new-pr` (`pkey storefront flathub init`): the manifest `<appId>.yml`, whose
 *              `extra-data` sources carry `x-checker-data` pointing at Polaris Key's checker feed
 *              (`/<p>/distribution/flathub/<channel>.json`), and a desktop entry.
 *   update     for a later version (`pkey storefront flathub pr`): the app repository's existing
 *              manifest with each `extra-data` source's `url`, `sha256` and `size` replaced for
 *              its architecture, comments and everything else kept, plus the regenerated MetaInfo.
 *              Flathub's external-data checker can open the same update PR from the feed.
 *
 * Never closes the app or deletes its repository.
 */

import { parseDocument, YAMLMap, YAMLSeq, isMap, isSeq, Document } from "yaml";
import {
  isoDate,
  needPayload,
  needRelease,
  type GeneratedFile,
  type PrInputBuild,
  type PrInputs,
} from "./prInputs.js";

export interface FlathubOptions {
  /** The MetaInfo `project_license` (SPDX). Default `LicenseRef-proprietary`. */
  projectLicense?: string;
  /** The executable the skeleton's launcher runs, relative to the extracted build. Default: the slug. */
  command?: string;
}

/** Flatpak's architecture for a release build's. */
const FLATPAK_ARCH: Readonly<Record<string, string>> = {
  x86_64: "x86_64",
  arm64: "aarch64",
  aarch64: "aarch64",
};

/** The OARS 1.1 content attributes. */
export const OARS_IDS = [
  "violence-cartoon",
  "violence-fantasy",
  "violence-realistic",
  "violence-bloodshed",
  "violence-sexual",
  "violence-desecration",
  "violence-slavery",
  "violence-worship",
  "drugs-alcohol",
  "drugs-narcotics",
  "drugs-tobacco",
  "sex-nudity",
  "sex-themes",
  "sex-homosexuality",
  "sex-prostitution",
  "sex-adultery",
  "sex-appearance",
  "language-profanity",
  "language-humor",
  "language-discrimination",
  "social-chat",
  "social-info",
  "social-audio",
  "social-location",
  "social-contacts",
  "money-purchasing",
  "money-gambling",
  "money-advertising",
] as const;

/** Descriptor names the listing model uses that are not OARS ids already. */
const OARS_ALIASES: Readonly<Record<string, string>> = {
  chat: "social-chat",
  gambling: "money-gambling",
  ads: "money-advertising",
  advertising: "money-advertising",
  purchases: "money-purchasing",
  inAppPurchases: "money-purchasing",
  profanity: "language-profanity",
};

const OARS_VALUES: Readonly<Record<string, string>> = {
  none: "none",
  mild: "mild",
  moderate: "moderate",
  intense: "intense",
  infrequent: "mild",
  infrequent_or_mild: "mild",
  frequent: "intense",
  frequent_or_intense: "intense",
};

/**
 * The OARS 1.1 attributes the content descriptors map to (`violenceCartoon` or
 * `violence-cartoon` → `violence-cartoon`), sorted, and the descriptors that do not map. The one
 * place the descriptor → OARS mapping lives.
 */
export function oarsAttributes(descriptors: Record<string, unknown> | null): {
  attributes: [string, string][];
  unmapped: string[];
} {
  const attributes = new Map<string, string>();
  const unmapped: string[] = [];
  for (const [key, raw] of Object.entries(descriptors ?? {})) {
    const id =
      OARS_ALIASES[key] ??
      key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/_/g, "-");
    const value =
      typeof raw === "string" ? OARS_VALUES[raw.toLowerCase()] : undefined;
    if (!(OARS_IDS as readonly string[]).includes(id) || !value) {
      unmapped.push(key);
      continue;
    }
    attributes.set(id, value);
  }
  return {
    attributes: [...attributes].sort(([a], [b]) => a.localeCompare(b)),
    unmapped: unmapped.sort(),
  };
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Plain text as MetaInfo description markup: blank-line-separated paragraphs as `<p>`, and runs of
 * `- ` or `* ` lines as a `<ul>`.
 */
export function metainfoMarkup(text: string, indent: string): string[] {
  const out: string[] = [];
  const isItem = (l: string) => /^[-*]\s+/.test(l);
  for (const block of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // Runs of list lines become one <ul>; the lines between them, one <p> each run.
    for (let n = 0; n < lines.length; ) {
      const list = isItem(lines[n]!);
      const run: string[] = [];
      while (n < lines.length && isItem(lines[n]!) === list)
        run.push(lines[n++]!);
      if (list) {
        out.push(`${indent}<ul>`);
        for (const l of run)
          out.push(
            `${indent}  <li>${xmlEscape(l.replace(/^[-*]\s+/, ""))}</li>`,
          );
        out.push(`${indent}</ul>`);
      } else out.push(`${indent}<p>${xmlEscape(run.join(" "))}</p>`);
    }
  }
  return out;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

export function flathubAppId(i: PrInputs): string {
  const id = str(i.outlet.identity.appId);
  if (!id)
    throw new Error(
      `The ${i.outlet.id} outlet declares no appId in .pkey/distribution.`,
    );
  return id;
}

/** The MetaInfo's `developer` id: the app id's reverse-DNS prefix (`gg.vlad.Dice` → `gg.vlad`). */
export function developerId(appId: string): string {
  return appId.split(".").slice(0, -1).join(".");
}

/** The MetaInfo XML, and warnings about what it had to leave out. */
export function generateMetainfo(
  i: PrInputs,
  o: FlathubOptions = {},
): { file: GeneratedFile; warnings: string[] } {
  const appId = flathubAppId(i);
  const release = needRelease(i);
  const payload = needPayload(i, "Flathub");
  const warnings: string[] = [];
  const def = i.app.defaultLocale;
  const dl = payload.locales[def] ?? {};
  const name = str(dl.name) ?? i.app.name;
  const summary = str(dl.summary);
  const description = str(dl.description);
  if (!summary || !description)
    throw new Error(
      `The listing's Flathub projection has no ${summary ? "description" : "summary"} in the default locale ${def}.`,
    );
  const others = Object.keys(payload.locales)
    .filter((l) => l !== def)
    .sort();
  const x: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!-- Created with Polaris Key (pkey storefront flathub) -->",
    '<component type="desktop-application">',
    `  <id>${xmlEscape(appId)}</id>`,
    "  <metadata_license>CC0-1.0</metadata_license>",
    `  <project_license>${xmlEscape(o.projectLicense ?? "LicenseRef-proprietary")}</project_license>`,
    `  <name>${xmlEscape(name)}</name>`,
  ];
  for (const l of others) {
    const v = str(payload.locales[l]?.name);
    if (v && v !== name)
      x.push(`  <name xml:lang="${xmlEscape(l)}">${xmlEscape(v)}</name>`);
  }
  x.push(`  <summary>${xmlEscape(summary)}</summary>`);
  for (const l of others) {
    const v = str(payload.locales[l]?.summary);
    if (v)
      x.push(`  <summary xml:lang="${xmlEscape(l)}">${xmlEscape(v)}</summary>`);
  }
  const developer = str(payload.app.developerName) ?? i.app.developerName;
  if (developer)
    x.push(
      `  <developer id="${xmlEscape(developerId(appId))}">`,
      `    <name>${xmlEscape(developer)}</name>`,
      "  </developer>",
    );
  else warnings.push("no developer name: the MetaInfo has no <developer>");
  x.push("  <description>", ...metainfoMarkup(description, "    "));
  x.push("  </description>");
  x.push(
    `  <launchable type="desktop-id">${xmlEscape(appId)}.desktop</launchable>`,
  );
  const homepage = str(payload.app.homepage) ?? i.app.website;
  if (homepage) x.push(`  <url type="homepage">${xmlEscape(homepage)}</url>`);
  else warnings.push("no website: the MetaInfo has no homepage URL");
  if (i.app.supportUrl)
    x.push(`  <url type="help">${xmlEscape(i.app.supportUrl)}</url>`);
  const keywords = Array.isArray(dl.keywords)
    ? (dl.keywords as unknown[]).filter(
        (k): k is string => typeof k === "string" && k.trim() !== "",
      )
    : [];
  if (keywords.length) {
    x.push("  <keywords>");
    for (const k of keywords) x.push(`    <keyword>${xmlEscape(k)}</keyword>`);
    x.push("  </keywords>");
  }
  if (i.app.screenshots.length) {
    x.push("  <screenshots>");
    i.app.screenshots.forEach((s, n) =>
      x.push(
        `    <screenshot${n === 0 ? ' type="default"' : ""}>`,
        `      <image>${xmlEscape(s)}</image>`,
        "    </screenshot>",
      ),
    );
    x.push("  </screenshots>");
  } else
    warnings.push(
      "no screenshots: Flathub requires at least one (the manifest listing's screenshots)",
    );
  if (i.app.tint && i.app.tintDark)
    x.push(
      "  <branding>",
      `    <color type="primary" scheme_preference="light">${xmlEscape(i.app.tint)}</color>`,
      `    <color type="primary" scheme_preference="dark">${xmlEscape(i.app.tintDark)}</color>`,
      "  </branding>",
    );
  else
    warnings.push(
      "no tint and tintDark: the MetaInfo has no <branding> colours, which Flathub asks for",
    );
  const { attributes, unmapped } = oarsAttributes(i.app.contentDescriptors);
  if (attributes.length) {
    x.push('  <content_rating type="oars-1.1">');
    for (const [id, v] of attributes)
      x.push(`    <content_attribute id="${id}">${v}</content_attribute>`);
    x.push("  </content_rating>");
  } else x.push('  <content_rating type="oars-1.1"/>');
  if (unmapped.length)
    warnings.push(
      `content descriptors with no OARS attribute, left out: ${unmapped.join(", ")}`,
    );
  const date = isoDate(release.publishedAt);
  const notes = str(payload.locales[def]?.releases) ?? i.notes?.[def]?.text;
  x.push(
    "  <releases>",
    `    <release version="${xmlEscape(release.version)}"${date ? ` date="${date}"` : ""}${notes ? "" : "/"}>`,
  );
  if (notes) {
    x.push("      <description>", ...metainfoMarkup(notes, "        "));
    x.push("      </description>", "    </release>");
  }
  x.push("  </releases>", "</component>", "");
  return {
    file: { path: `${appId}.metainfo.xml`, content: x.join("\n") },
    warnings,
  };
}

/** The Linux builds Flatpak can install, by Flatpak architecture. */
function linuxBuilds(i: PrInputs): [string, PrInputBuild][] {
  const release = needRelease(i);
  const out = new Map<string, PrInputBuild>();
  for (const b of release.builds) {
    if (b.platform !== null && b.platform !== "linux") continue;
    const arch = FLATPAK_ARCH[b.arch];
    if (!arch || out.has(arch)) continue;
    if (!b.sha256 || b.size === null)
      throw new Error(
        `${b.name}: an extra-data source needs the build's SHA-256 and size.`,
      );
    out.set(arch, b);
  }
  if (!out.size)
    throw new Error(
      `${release.version} has no Linux x86_64 or arm64 build on the ${i.outlet.id} outlet.`,
    );
  return [...out].sort(([a], [b]) => a.localeCompare(b));
}

/** The archive extension of a build (`tar.gz`, `zip`, …). */
function archiveExt(name: string): string {
  const m = /\.(tar\.gz|tgz|tar\.xz|tar\.zst|zip)$/i.exec(name);
  if (!m)
    throw new Error(
      `${name}: the skeleton extracts a .tar.gz, .tgz, .tar.xz, .tar.zst or .zip build.`,
    );
  return m[1]!.toLowerCase();
}

function extractCommand(file: string, ext: string): string {
  return ext === "zip"
    ? `unzip -q ${file} && rm ${file}`
    : `tar -xf ${file} && rm ${file}`;
}

/** The skeleton for the first, human submission: manifest, desktop entry and MetaInfo. */
export function generateFlathubSkeleton(
  i: PrInputs,
  o: FlathubOptions = {},
): { files: GeneratedFile[]; warnings: string[] } {
  const appId = flathubAppId(i);
  const slug = i.product.slug.toLowerCase();
  const command = o.command ?? slug;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(command) ||
    command.includes("..")
  )
    throw new Error(
      `--command must be a relative path inside the build (got ${command}).`,
    );
  const builds = linuxBuilds(i);
  const sources: unknown[] = [];
  const applyExtra: string[] = [];
  for (const [arch, b] of builds) {
    const ext = archiveExt(b.name);
    const filename = `${slug}-${arch}.${ext}`;
    sources.push({
      type: "extra-data",
      filename,
      "only-arches": [arch],
      url: b.url,
      sha256: b.sha256,
      size: b.size,
      "x-checker-data": {
        type: "json",
        url: i.links.flathubFeed,
        "version-query": ".version",
        "url-query": `.releases[] | select(.arch == "${arch}") | .url`,
      },
    });
    applyExtra.push(
      `if [ -f ${filename} ]; then ${extractCommand(filename, ext)}; fi`,
    );
  }
  sources.push(
    {
      type: "script",
      "dest-filename": "apply_extra",
      commands: applyExtra,
    },
    {
      type: "script",
      "dest-filename": `${slug}.sh`,
      commands: [`exec /app/extra/${command} "$@"`],
    },
    { type: "file", path: `${appId}.metainfo.xml` },
    { type: "file", path: `${appId}.desktop` },
  );
  const manifest = new Document({
    id: appId,
    runtime: "org.freedesktop.Platform",
    "runtime-version": "24.08",
    sdk: "org.freedesktop.Sdk",
    command: slug,
    "finish-args": [
      "--share=ipc",
      "--socket=x11",
      "--socket=pulseaudio",
      "--device=dri",
    ],
    modules: [
      {
        name: slug,
        buildsystem: "simple",
        "build-commands": [
          "install -Dm755 apply_extra -t /app/bin",
          `install -Dm755 ${slug}.sh /app/bin/${slug}`,
          `install -Dm644 ${appId}.metainfo.xml -t /app/share/metainfo`,
          `install -Dm644 ${appId}.desktop -t /app/share/applications`,
        ],
        sources,
      },
    ],
  });
  manifest.commentBefore =
    " Created with Polaris Key (pkey storefront flathub init): the skeleton of the first submission.\n" +
    " Before opening the PR to flathub/flathub (base branch new-pr): add the icon, a 256x256 PNG\n" +
    ` installed as /app/share/icons/hicolor/256x256/apps/${appId}.png, and check finish-args.\n` +
    " Updates after that: Flathub's external-data checker follows x-checker-data, or\n" +
    " pkey storefront flathub pr opens the update PR.";
  const desktop = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${i.app.name}`,
    ...(i.app.subtitle ? [`Comment=${i.app.subtitle}`] : []),
    `Exec=${slug}`,
    `Icon=${appId}`,
    "Categories=Game;",
    "",
  ].join("\n");
  const meta = generateMetainfo(i, o);
  return {
    files: [
      { path: `${appId}.yml`, content: manifest.toString({ lineWidth: 0 }) },
      meta.file,
      { path: `${appId}.desktop`, content: desktop },
    ],
    warnings: meta.warnings,
  };
}

/** Each extra-data source map in a manifest's modules, recursively. */
function extraDataSources(modules: unknown, out: YAMLMap[] = []): YAMLMap[] {
  if (!isSeq(modules)) return out;
  for (const m of (modules as YAMLSeq).items) {
    if (!isMap(m)) continue;
    const sources = m.get("sources");
    if (isSeq(sources))
      for (const s of sources.items)
        if (isMap(s) && s.get("type") === "extra-data") out.push(s);
    extraDataSources(m.get("modules"), out);
  }
  return out;
}

/**
 * The app repository's manifest (YAML or JSON) with each `extra-data` source's `url`, `sha256`
 * and `size` set to the release's build for its `only-arches` architecture (a source without
 * `only-arches` takes the only build). Comments and everything else are kept.
 */
export function updateFlathubManifest(
  text: string,
  path: string,
  i: PrInputs,
): string {
  const builds = new Map(linuxBuilds(i));
  const json = path.endsWith(".json");
  const doc = parseDocument(text);
  if (doc.errors.length)
    throw new Error(`${path} does not parse: ${doc.errors[0]!.message}`);
  const sources = extraDataSources(doc.get("modules"));
  if (!sources.length)
    throw new Error(
      `${path} has no extra-data source to update: edit it by hand, or let Flathub's external-data checker open the PR.`,
    );
  let changed = 0;
  for (const s of sources) {
    const arches = s.get("only-arches");
    const archList = isSeq(arches)
      ? arches.items.map((a) => String((a as { value?: unknown }).value ?? a))
      : null;
    const b = archList
      ? archList.map((a) => builds.get(a)).find((x) => x !== undefined)
      : builds.size === 1
        ? [...builds.values()][0]
        : undefined;
    if (!b) continue;
    s.set("url", b.url);
    s.set("sha256", b.sha256);
    s.set("size", b.size);
    changed++;
  }
  if (!changed)
    throw new Error(
      `${path}'s extra-data sources name no architecture this release has a Linux build for (${[...builds.keys()].join(", ")}).`,
    );
  return json
    ? `${JSON.stringify(doc.toJS(), null, 4)}\n`
    : doc.toString({ lineWidth: 0 });
}
