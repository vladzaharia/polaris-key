/**
 * The Homebrew cask generator (A-18i; notes/S-15 §4.4): `Casks/<homebrewCask>.rb` for the
 * product's OWN tap (`direct.homebrewTap`), never `homebrew/cask`, which has notability rules and
 * needs the owner. The cask carries `version`, `sha256`, `url` (the release's immutable HTTPS
 * delivery URL), `name`, `desc`, `homepage`, `livecheck` (the public `download.json`, the stable
 * channel's newest release, so only a stable-channel cask follows it), `auto_updates` (when the
 * outlet's binaries update themselves) and `app`. A universal build is one `url`; separate arm64
 * and x86_64 builds are `on_arm` and `on_intel` blocks.
 */

import {
  isHttps,
  needRelease,
  type GeneratedFile,
  type PrInputBuild,
  type PrInputs,
} from "./prInputs.js";

export interface HomebrewOptions {
  /** The `.app` bundle inside the dmg or zip. Default `<listing name>.app`. */
  app?: string;
}

/** A Ruby double-quoted string literal: `\`, `"` and `#{` escaped. */
export function rubyString(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/#\{/g, "\\#{")
    .replace(/\n/g, "\\n")}"`;
}

function checkBuild(b: PrInputBuild): { url: string; sha256: string } {
  if (!isHttps(b.url))
    throw new Error(`${b.name}: a cask needs an HTTPS URL (got ${b.url}).`);
  if (!b.sha256)
    throw new Error(`${b.name}: the release records no SHA-256 for it.`);
  if (!/\.(dmg|zip)$/i.test(b.name))
    throw new Error(
      `${b.name}: the cask installs an app from a .dmg or .zip build.`,
    );
  return { url: b.url, sha256: b.sha256 };
}

/** Generate the cask for the inputs' release. */
export function generateCask(
  i: PrInputs,
  o: HomebrewOptions = {},
): GeneratedFile {
  const cask = i.outlet.identity.homebrewCask;
  if (typeof cask !== "string" || !cask)
    throw new Error(
      `The ${i.outlet.id} outlet declares no homebrewCask in .pkey/distribution.`,
    );
  const release = needRelease(i);
  const builds = release.builds.filter(
    (b) => b.platform === null || b.platform === "macos",
  );
  const universal = builds.find(
    (b) => b.arch === "universal" || b.arch === "neutral",
  );
  const arm = builds.find((b) => b.arch === "arm64" || b.arch === "aarch64");
  const intel = builds.find((b) => b.arch === "x86_64" || b.arch === "x64");
  if (!universal && !arm && !intel)
    throw new Error(
      `${release.version} has no macOS build on the ${i.outlet.id} outlet.`,
    );
  const app = o.app ?? `${i.app.name}.app`;
  if (!/\.app$/.test(app) || app.includes("/") || app.includes(".."))
    throw new Error(`--app must name a .app bundle (got ${app}).`);
  const desc = (i.app.shortDescription ?? i.app.subtitle ?? i.app.name)
    .trim()
    .replace(/\.$/, "");

  const lines = [
    `cask ${rubyString(cask)} do`,
    `  version ${rubyString(release.version)}`,
  ];
  if (universal || !(arm && intel)) {
    const b = checkBuild((universal ?? arm ?? intel)!);
    if (!universal && arm) lines.push(`  depends_on arch: :arm64`);
    if (!universal && intel) lines.push(`  depends_on arch: :x86_64`);
    lines.push(
      `  sha256 ${rubyString(b.sha256)}`,
      "",
      `  url ${rubyString(b.url)}`,
    );
  } else {
    const a = checkBuild(arm!);
    const x = checkBuild(intel!);
    lines.push(
      "",
      "  on_arm do",
      `    sha256 ${rubyString(a.sha256)}`,
      `    url ${rubyString(a.url)}`,
      "  end",
      "  on_intel do",
      `    sha256 ${rubyString(x.sha256)}`,
      `    url ${rubyString(x.url)}`,
      "  end",
      "",
    );
  }
  lines.push(`  name ${rubyString(i.app.name)}`, `  desc ${rubyString(desc)}`);
  if (i.app.website) lines.push(`  homepage ${rubyString(i.app.website)}`);
  lines.push("");
  if (i.channel === "stable")
    lines.push(
      "  livecheck do",
      `    url ${rubyString(i.links.downloadJson)}`,
      "    strategy :json do |json|",
      '      json.dig("release", "version")',
      "    end",
      "  end",
    );
  else
    lines.push(
      "  livecheck do",
      `    skip ${rubyString(`follows the ${i.channel} channel through pkey storefront homebrew pr`)}`,
      "  end",
    );
  lines.push("");
  if (i.selfUpdates) lines.push("  auto_updates true", "");
  lines.push(`  app ${rubyString(app)}`, "end", "");
  return { path: `Casks/${cask}.rb`, content: lines.join("\n") };
}
