#!/usr/bin/env node
/**
 * The SDK version, derived from git (F-10 automation, owner decision 2026-10-04).
 *
 * Every SDK this repository ships is versioned in LOCKSTEP with the server: one version, derived
 * here from the ref being built, stamped into every SDK's version file by CI, never committed and
 * never chosen by hand (no Changesets, no hand-edited version files).
 *
 *   a release tag  v1.4.0       every SDK is 1.4.0 (stable channel; npm `latest`)
 *                  v1.4.0-rc.1  every SDK is 1.4.0-rc.1 (beta channel; PyPI 1.4.0rc1)
 *   a push to main              a prerelease of the NEXT version, in each ecosystem's native form:
 *                               semver `<next>-main.<N>` (npm under the `main` dist-tag, never
 *                               `latest`; Swift, Maven, Godot and the OCI image) and PEP 440
 *                               `<next>.dev<N>` (PyPI), on the `main` channel
 *
 * `<next>` follows the newest release tag reachable from the commit: the patch after a stable tag
 * (v1.4.0 → 1.4.1), the version itself after a prerelease tag (v1.5.0-rc.1 → 1.5.0). `<N>` is the
 * number of commits since that tag (all commits when there is none, from 0.0.1), so it only grows
 * along main and every push publishes a version none before it took.
 *
 *   node tools/sdk-version.mjs derive [--ref <git ref>] [--github-output]
 *       print (or append to $GITHUB_OUTPUT) kind, version, pep440, channel, npm_tag; the ref
 *       defaults to $GITHUB_REF, and git answers the newest tag and the distance
 *   node tools/sdk-version.mjs stamp --version <semver> --pep440 <pep 440> [--root <dir>]
 *       write that version into every SDK's version file (the list is STAMP_TARGETS); each
 *       pattern must match exactly once, so a moved or renamed version line fails loudly
 *
 * A prerelease tag must be one PyPI can express too: `-alpha.N`, `-beta.N` or `-rc.N` (or `-a.N`,
 * `-b.N`). Any other suffix is refused, because the lockstep is all SDKs or none.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A release tag: `vMAJOR.MINOR.PATCH[-prerelease]` (deploy.yml's own rule). */
export const RELEASE_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** The tags a deploy accepts (deploy.yml's "Select target"): prerelease only -alpha|beta|rc|a|b.N. */
export const STRICT_RELEASE_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta|rc|a|b)\.(0|[1-9]\d*))?$/;

/** Semver precedence of two strict release tags (a prerelease sorts below its release). */
export function compareReleaseTags(x, y) {
  const p = (t) => {
    const m = STRICT_RELEASE_TAG.exec(t);
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1, m[4] ?? ""];
  };
  const a = p(x);
  const b = p(y);
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a[4].localeCompare(b[4], "en", { numeric: true });
}

/** The git glob `git describe` looks for release tags with. */
export const RELEASE_TAG_GLOB = "v[0-9]*.[0-9]*.[0-9]*";

const PEP440_PRE = { alpha: "a", a: "a", beta: "b", b: "b", rc: "rc" };

/** A release tag's parts, or `null`. */
export function parseReleaseTag(tag) {
  const m = RELEASE_TAG.exec(tag);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/** The PEP 440 spelling of a release version (`1.4.0-rc.1` → `1.4.0rc1`); throws when it has none. */
export function toPep440(version) {
  const m = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) throw new Error(`${version} is not MAJOR.MINOR.PATCH[-prerelease]`);
  if (!m[2]) return m[1];
  const pre = /^(alpha|beta|rc|a|b)\.(0|[1-9]\d*)$/.exec(m[2]);
  if (pre) return `${m[1]}${PEP440_PRE[pre[1]]}${pre[2]}`;
  const dev = /^main\.(0|[1-9]\d*)$/.exec(m[2]);
  if (dev) return `${m[1]}.dev${dev[1]}`;
  throw new Error(
    `${version}: a prerelease is -alpha.N, -beta.N or -rc.N, so that every ecosystem (PyPI too) can carry it`,
  );
}

/** The version a push to main is a prerelease of: the patch after a stable tag, else its core. */
export function nextVersion(latestTag) {
  if (latestTag === null) return "0.0.1";
  const t = parseReleaseTag(latestTag);
  if (!t)
    throw new Error(`${latestTag} is not a release tag (vMAJOR.MINOR.PATCH)`);
  return t.prerelease === null
    ? `${t.major}.${t.minor}.${t.patch + 1}`
    : `${t.major}.${t.minor}.${t.patch}`;
}

/**
 * The lockstep version of one build.
 *
 * @param {{ ref: string, latestTag: string | null, distance: number }} input
 *   `ref` the full git ref being built; for a push to main, `latestTag` the newest release tag
 *   reachable from it (or null) and `distance` the commits since that tag (or since the root).
 */
export function deriveVersion({ ref, latestTag, distance }) {
  const tagRef = /^refs\/tags\/(.+)$/.exec(ref);
  if (tagRef) {
    const tag = tagRef[1];
    const t = parseReleaseTag(tag);
    if (!t)
      throw new Error(
        `${tag} is not a release tag (vMAJOR.MINOR.PATCH[-prerelease])`,
      );
    const version = tag.slice(1);
    const pep440 = toPep440(version);
    const stable = t.prerelease === null;
    return {
      kind: "release",
      version,
      pep440,
      channel: stable ? "stable" : "beta",
      npmTag: stable ? "latest" : "beta",
    };
  }
  if (ref === "refs/heads/main") {
    if (!Number.isSafeInteger(distance) || distance < 0)
      throw new Error(
        `distance must be a non-negative integer (got ${distance})`,
      );
    const next = nextVersion(latestTag);
    return {
      kind: "main",
      version: `${next}-main.${distance}`,
      pep440: `${next}.dev${distance}`,
      channel: "main",
      npmTag: "main",
    };
  }
  throw new Error(
    `SDKs are published from main and from v* release tags only (got ${ref})`,
  );
}

/** Ask git for the newest reachable release tag and the commits since it (or since the root). */
export function gitDescribe(cwd = process.cwd()) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  // `git describe` returns the NEAREST glob match, so one malformed tag
  // (v1.2.3x) made the whole derivation fall back to 0.0.1. Take the highest STRICT release
  // tag reachable from HEAD instead; a tag that is not a deployable release tag is ignored.
  let latestTag = null;
  try {
    const tags = git("tag", "--merged", "HEAD", "--list", RELEASE_TAG_GLOB)
      .split("\n")
      .filter((t) => STRICT_RELEASE_TAG.test(t));
    tags.sort(compareReleaseTags);
    latestTag = tags.length ? tags[tags.length - 1] : null;
  } catch {
    latestTag = null;
  }
  const range = latestTag === null ? "HEAD" : `${latestTag}..HEAD`;
  const distance = Number(git("rev-list", "--count", range));
  return { latestTag, distance };
}

// ── Stamping ────────────────────────────────────────────────────────────────────────────────

/**
 * Every version file of every SDK, and the one line in each that carries the version. `pep440`
 * targets take the PEP 440 spelling. The npm packages are every public `packages/*` package
 * (`publicPackageJsons`); `pnpm pack` then rewrites their `workspace:*` ranges to this version.
 */
export const STAMP_TARGETS = [
  {
    file: "sdks/python/pyproject.toml",
    pattern: /^(version = ")[^"]*(")$/m,
    pep440: true,
  },
  {
    file: "sdks/swift/Sources/PolarisKeyCore/Models.swift",
    pattern: /^(public let POLARIS_SDK_VERSION = ")[^"]*(")$/m,
  },
  {
    file: "sdks/kotlin/build.gradle.kts",
    pattern: /^(\s*version = ")[^"]*(")$/m,
  },
  {
    file: "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Models.kt",
    pattern: /^(public const val POLARIS_SDK_VERSION: String = ")[^"]*(")$/m,
  },
  {
    file: "sdks/godot/addons/polaris_key/plugin.cfg",
    pattern: /^(version=")[^"]*(")$/m,
  },
  {
    file: "sdks/godot/addons/polaris_key/polaris_key.gd",
    pattern: /^(const SDK_VERSION := ")[^"]*(")$/m,
  },
  // The browser bundle cannot read package.json, so @polaris-key/react carries its version as a
  // literal (sdk-node reads package.json at runtime and needs no target).
  {
    file: "packages/sdk-react/src/version.ts",
    pattern: /^(export const SDK_VERSION = ")[^"]*(";)$/m,
  },
];

/** The public npm packages' package.json paths (relative to `root`), sorted. */
export function publicPackageJsons(root) {
  const out = [];
  for (const d of readdirSync(join(root, "packages")).sort()) {
    const file = join("packages", d, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch {
      continue;
    }
    if (
      !pkg.private &&
      typeof pkg.name === "string" &&
      pkg.name.startsWith("@polaris-key/")
    )
      out.push(file);
  }
  return out;
}

/** Replace the one version in `text`; throws unless `pattern` matches exactly once. */
export function stampText(text, pattern, version, file) {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  const count = [...text.matchAll(global)].length;
  if (count !== 1)
    throw new Error(
      `${file}: expected exactly one version line matching ${pattern}, found ${count}`,
    );
  return text.replace(pattern, (_m, pre, post) => `${pre}${version}${post}`);
}

/** Write `version` (and `pep440` for PyPI) into every SDK under `root`; answer the files written. */
export function stampVersions(root, { version, pep440 }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`${version} is not a semantic version`);
  if (pep440 !== toPep440(version))
    throw new Error(
      `${pep440} is not ${version}'s PEP 440 spelling (${toPep440(version)})`,
    );
  const written = [];
  for (const t of STAMP_TARGETS) {
    const path = join(root, t.file);
    const next = stampText(
      readFileSync(path, "utf8"),
      t.pattern,
      t.pep440 ? pep440 : version,
      t.file,
    );
    writeFileSync(path, next);
    written.push(t.file);
  }
  for (const file of publicPackageJsons(root)) {
    const path = join(root, file);
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.version = version;
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    written.push(file);
  }
  return written;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv) {
  const [cmd] = argv;
  if (cmd === "derive") {
    const ref = arg(argv, "--ref") ?? process.env.GITHUB_REF;
    if (!ref) throw new Error("no ref: pass --ref or set GITHUB_REF");
    const d = ref.startsWith("refs/heads/")
      ? gitDescribe()
      : { latestTag: null, distance: 0 };
    const v = deriveVersion({ ref, ...d });
    const lines = [
      `kind=${v.kind}`,
      `version=${v.version}`,
      `pep440=${v.pep440}`,
      `channel=${v.channel}`,
      `npm_tag=${v.npmTag}`,
    ];
    if (argv.includes("--github-output")) {
      const out = process.env.GITHUB_OUTPUT;
      if (!out) throw new Error("--github-output needs GITHUB_OUTPUT");
      appendFileSync(out, `${lines.join("\n")}\n`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (cmd === "stamp") {
    const version = arg(argv, "--version");
    const pep440 = arg(argv, "--pep440");
    if (!version || !pep440)
      throw new Error("stamp needs --version and --pep440");
    const root =
      arg(argv, "--root") ??
      join(fileURLToPath(new URL(".", import.meta.url)), "..");
    for (const f of stampVersions(root, { version, pep440 }))
      process.stdout.write(`stamped ${f}\n`);
    return;
  }
  throw new Error(
    "usage: sdk-version.mjs derive [--ref <ref>] [--github-output] | stamp --version <v> --pep440 <v> [--root <dir>]",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(
      `::error::${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }
}
