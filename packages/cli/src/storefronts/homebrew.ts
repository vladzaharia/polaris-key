/**
 * The Homebrew cask generator (A-18i; notes/S-15 §4.4): `Casks/<homebrewCask>.rb` for the
 * product's OWN tap (`direct.homebrewTap`), never `homebrew/cask`, which has notability rules and
 * needs the owner. The cask carries `version`, `sha256`, `url` (the release's immutable HTTPS
 * delivery URL), `name`, `desc`, `homepage`, `livecheck` (the public `download.json`, the stable
 * channel's newest release, so only a stable-channel cask follows it), `auto_updates` (when the
 * outlet's binaries update themselves) and `app`. A universal build is one `url`; separate arm64
 * and x86_64 builds are `on_arm` and `on_intel` blocks.
 *
 * A-29.3: `Formula/<homebrewFormula>.rb` for a command-line tool shipped as a `.tar.gz` or `.zip`
 * archive on macOS and Linux (`on_macos` / `on_linux`, each universal or `on_arm` / `on_intel`),
 * installing one executable (`--command`, default the formula's name). Every value reaches the
 * Ruby through `rubyString` after its own check; nothing is ever interpolated unquoted.
 */

import {
  isHttps,
  needRelease,
  type GeneratedFile,
  type PrInputBuild,
  type PrInputs,
} from "./prInputs.js";
import { UsageError } from "../errors.js";

export interface HomebrewOptions {
  /** The `.app` bundle inside the dmg or zip. Default `<listing name>.app`. */
  app?: string;
  /** The formula's executable inside the archive: a bare file name. Default the formula's name. */
  command?: string;
  /** The formula's SPDX `license`. Omitted from the formula when not given. */
  projectLicense?: string;
}

/** Which file of the tap a pull request writes. */
export type HomebrewKind = "cask" | "formula";

/** What the outlet declares, the cask first: the pull requests a run opens. */
export function homebrewKinds(i: PrInputs): HomebrewKind[] {
  const id = i.outlet.identity;
  const kinds: HomebrewKind[] = [];
  if (typeof id.homebrewCask === "string" && id.homebrewCask)
    kinds.push("cask");
  if (typeof id.homebrewFormula === "string" && id.homebrewFormula)
    kinds.push("formula");
  if (!kinds.length)
    throw new Error(
      `The ${i.outlet.id} outlet declares neither homebrewCask nor homebrewFormula in .pkey/distribution.`,
    );
  return kinds;
}

/**
 * A Ruby double-quoted string literal. Escaped: `\`, `"`, every `#` that Ruby would read as
 * interpolation (`#{`, `#@ivar`, `#$gvar`) and every control character (a newline, a NUL).
 */
export function rubyString(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/#(?=[{@$])/g, "\\#")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // Unicode format characters (bidi controls, zero-width marks) could spoof the PR diff.
    .replace(/\p{Cf}/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u001f\u007f]/g,
      (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
    )}"`;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Whether a URL is plain https: URL-safe characters only, and no user name, password or `@`. */
function plainHttps(u: string): boolean {
  if (!isHttps(u) || !URL_SAFE.test(u)) return false;
  const url = new URL(u);
  const authority = u.slice(u.indexOf("//") + 2).split(/[/?#]/)[0]!;
  return !url.username && !url.password && !authority.includes("@");
}
/** A URL a formula or cask may carry: https, no userinfo, only URL-safe characters. */
const URL_SAFE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

function checkBuild(b: PrInputBuild): { url: string; sha256: string } {
  if (!plainHttps(b.url))
    throw new Error(
      `${b.name}: a cask needs a plain HTTPS URL (got ${b.url}).`,
    );
  if (!b.sha256 || !SHA256.test(b.sha256))
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
    throw new UsageError(`--app must name a .app bundle (got ${app}).`);
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

const ARCHIVE = /\.(tar\.gz|zip)$/i;
const FORMULA_NAME = /^(?!.*\.\.)[a-z0-9][a-z0-9.@+_-]{0,99}$/;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const SPDX =
  /^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$/;

/** The Ruby class of a formula name (Homebrew's rule: `foo-bar` is `FooBar`, `@` is `AT`). */
export function formulaClass(name: string): string {
  const cls = name
    .replace(/@/g, "-AT-")
    .replace(/\+/g, "-x")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  if (!/^[A-Z][A-Za-z0-9]*$/.test(cls))
    throw new Error(
      `${name}: no Ruby class name for the formula (it must start with a letter).`,
    );
  return cls;
}

/** The formula's url and sha256, checked: https, URL-safe characters, 64 hex digits. */
function formulaSource(b: PrInputBuild): { url: string; sha256: string } {
  if (!plainHttps(b.url))
    throw new Error(
      `${b.name}: a formula needs a plain HTTPS URL without credentials (got ${b.url}).`,
    );
  if (!b.sha256 || !SHA256.test(b.sha256))
    throw new Error(`${b.name}: the release records no SHA-256 for it.`);
  return { url: b.url, sha256: b.sha256 };
}

const ARM = ["arm64", "aarch64"];
const INTEL = ["x86_64", "x64"];
const ANY = ["universal", "neutral"];

/** Generate the formula for the inputs' release: `Formula/<homebrewFormula>.rb`. */
export function generateFormula(
  i: PrInputs,
  o: HomebrewOptions = {},
): GeneratedFile {
  const name = i.outlet.identity.homebrewFormula;
  if (typeof name !== "string" || !name)
    throw new Error(
      `The ${i.outlet.id} outlet declares no homebrewFormula in .pkey/distribution.`,
    );
  if (!FORMULA_NAME.test(name))
    throw new Error(`homebrewFormula ${name} is not a Homebrew formula name.`);
  const command = o.command ?? name;
  if (
    command.includes("/") ||
    command.includes("\\") ||
    command.includes("..") ||
    !COMMAND_NAME.test(command)
  )
    throw new UsageError(
      `--command must be a bare file name, the executable in the archive (got ${command}).`,
    );
  if (o.projectLicense !== undefined && !SPDX.test(o.projectLicense))
    throw new UsageError(
      `--project-license must be an SPDX expression (got ${o.projectLicense}).`,
    );
  const release = needRelease(i);
  const candidates = release.builds.filter(
    (b) => b.platform === "macos" || b.platform === "linux",
  );
  if (!candidates.length)
    throw new Error(
      `${release.version} has no macOS or Linux build on the ${i.outlet.id} outlet.`,
    );
  const archives = candidates.filter((b) => ARCHIVE.test(b.name));
  if (!archives.length)
    throw new Error(
      `${candidates.map((b) => b.name).join(", ")}: a formula installs a .tar.gz or .zip archive (a .dmg or .pkg is the cask's).`,
    );
  // One archive per (platform, arch): a .tar.gz before a .zip.
  const pick = (platform: string, archs: string[]) =>
    archives
      .filter((b) => b.platform === platform && archs.includes(b.arch))
      .sort(
        (a, b) =>
          Number(/\.zip$/i.test(a.name)) - Number(/\.zip$/i.test(b.name)),
      )[0];
  const stanza = (indent: string, b: PrInputBuild): string[] => {
    const src = formulaSource(b);
    return [
      `${indent}url ${rubyString(src.url)}`,
      `${indent}sha256 ${rubyString(src.sha256)}`,
    ];
  };
  const blocks: string[] = [];
  for (const [platform, block] of [
    ["macos", "on_macos"],
    ["linux", "on_linux"],
  ] as const) {
    const any = pick(platform, ANY);
    const arm = pick(platform, ARM);
    const intel = pick(platform, INTEL);
    if (!any && !arm && !intel) continue;
    // `brew style` allows url and sha256 only inside on_arm / on_intel, so a universal archive
    // is written under both.
    const body: string[] = [];
    const a = any ?? arm;
    const x = any ?? intel;
    if (a) body.push("    on_arm do", ...stanza("      ", a), "    end");
    if (x) body.push("    on_intel do", ...stanza("      ", x), "    end");
    blocks.push(`  ${block} do`, ...body, "  end", "");
  }
  // Homebrew's audit: no leading article, a capital first letter, no final full stop.
  const raw = (i.app.shortDescription ?? i.app.subtitle ?? i.app.name)
    .trim()
    .replace(/\.$/, "")
    .replace(/^(?:a|an|the)\s+/i, "");
  const desc = raw.charAt(0).toUpperCase() + raw.slice(1);
  const lines = [
    `class ${formulaClass(name)} < Formula`,
    `  desc ${rubyString(desc)}`,
  ];
  if (i.app.website) {
    if (!isHttps(i.app.website))
      throw new Error(`The listing's website is not an HTTPS URL.`);
    lines.push(`  homepage ${rubyString(i.app.website)}`);
  }
  lines.push(`  version ${rubyString(release.version)}`);
  if (o.projectLicense) lines.push(`  license ${rubyString(o.projectLicense)}`);
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
  lines.push("", ...blocks.slice(0, -1));
  lines.push(
    "",
    "  def install",
    `    bin.install ${rubyString(command)}`,
    "  end",
    "",
    "  test do",
    `    assert_path_exists bin/${rubyString(command)}`,
    "  end",
    "end",
    "",
  );
  return { path: `Formula/${name}.rb`, content: lines.join("\n") };
}
