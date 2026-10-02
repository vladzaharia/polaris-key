/// <reference types="@cloudflare/workers-types" />

/**
 * Fuzzy asset selection. Release authors are not perfectly consistent about asset
 * names (`djdl-arm64`, `djdl_aarch64`, `MyApp-1.2.3-x86_64.dmg`, …), so we match by
 * *intent* — architecture token, file extension, the product's binary name, and an
 * optional channel suffix — rather than an exact string. An **exact** filename hit
 * always wins; when fuzzy matching leaves two equally-good candidates we return
 * `null` rather than guess (ambiguous-by-design, so a bad upload can't be served).
 */

import type { ReleaseAsset } from "./github.js";

export type Arch = "arm64" | "x86_64";

/** Arch aliases seen in the wild, grouped by canonical arch. Exact-set membership only. */
const ARCH_TOKENS: Record<Arch, Set<string>> = {
  arm64: new Set(["arm64", "aarch64"]),
  x86_64: new Set(["x86_64", "amd64", "x64"]),
};

/**
 * Canonicalise a requested arch token. The router accepts the `aarch64` / `amd64` aliases,
 * but `ARCH_TOKENS` is keyed on the two canonical values only — so an alias used to reach
 * `[...ARCH_TOKENS[alias]]` as `undefined` and throw an unhandled TypeError (500) on a
 * public route. Returns `null` for anything unrecognised so callers 404 instead.
 */
export function normalizeArch(raw: string | undefined): Arch | null {
  if (!raw) return null;
  const token = raw.toLowerCase();
  for (const arch of Object.keys(ARCH_TOKENS) as Arch[]) {
    if (arch === token || ARCH_TOKENS[arch].has(token)) return arch;
  }
  return null;
}

/**
 * Split a filename into lowercase tokens on common delimiters. `x86_64`/`x86-64`
 * fragment into `x86` + `64`, so we re-join that adjacent pair back into the compound
 * `x86_64` alias afterward — letting arch matching stay exact-set membership.
 */
function tokens(name: string): string[] {
  return splitTokens(name.toLowerCase().replace(/\.[a-z0-9]+$/, "")); // extension matched separately
}

/** `tokens` without dropping the extension: every `[a-z0-9]+` run, `x86_64` re-joined. */
function splitTokens(lowered: string): string[] {
  const raw = lowered.split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "x86" && raw[i + 1] === "64") {
      out.push("x86_64");
      i++; // consume the "64"
    } else {
      out.push(raw[i] as string);
    }
  }
  return out;
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m && m[1] ? m[1] : "";
}

/** Does the filename carry a token from the requested arch's alias set (and no other arch's)? */
function archMatches(name: string, arch: Arch): boolean {
  const toks = new Set(tokens(name));
  // Defensive: a non-canonical arch would key an undefined set here (see `normalizeArch`).
  const wanted = ARCH_TOKENS[arch] as Set<string> | undefined;
  if (!wanted) return false;
  const other = arch === "arm64" ? ARCH_TOKENS.x86_64 : ARCH_TOKENS.arm64;
  const hasWanted = [...wanted].some((t) => toks.has(t));
  const hasOther = [...other].some((t) => toks.has(t));
  return hasWanted && !hasOther;
}

/** True when `needle`'s tokens appear as a contiguous run in `hay`. */
function hasTokenRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

/**
 * Does the file name carry `token` (an arch name, a binary name) as whole tokens — split on
 * `[^a-z0-9]+` like the matcher, so `x86` is NOT found in `game-x86_64.zip` and `arm` not in
 * `game-arm64`? Release health uses it for a policy arch it has no alias set for.
 */
export function nameHasToken(name: string, token: string): boolean {
  return hasTokenRun(
    splitTokens(name.toLowerCase()),
    splitTokens(token.toLowerCase()),
  );
}

/**
 * Is this file a CLI binary of `binaryName`? A file that carries the binary name as whole tokens
 * and is a bare executable: no extension, a version-looking numeric "extension"
 * (`djdl-1.2.3`), or `.exe`. Packages, archives, disk images and sidecars are not, and neither
 * is a stray extension-less file that does not name the binary (`LICENSE`).
 *
 * The one definition release health uses for "a CLI asset", with and without a declared arch.
 */
export function isCliBinary(name: string, binaryName: string): boolean {
  if (!nameHasToken(name, binaryName)) return false;
  const ext = extOf(name);
  return ext === "" || /^[0-9]+$/.test(ext) || ext === "exe";
}

/**
 * The architecture an asset name carries, or null when it names none (or names both).
 *
 * Exported for the truth store, which records `release_artifacts.arch`: it must agree with the
 * matcher below, or the portal would offer a build the download route refuses to select.
 */
export function archOf(name: string): Arch | null {
  for (const arch of Object.keys(ARCH_TOKENS) as Arch[]) {
    if (archMatches(name, arch)) return arch;
  }
  return null;
}

export interface MatchSpec {
  /** Required canonical architecture. */
  arch: Arch;
  /** Required file extension (no dot), e.g. `dmg`. Empty string = a bare binary (no ext). */
  ext: string;
  /** The product binary name (e.g. `djdl`); used to disambiguate when present. */
  binaryName?: string;
  /** A channel suffix the asset should carry (e.g. `staging`, `pr-42`), if any. */
  channelSuffix?: string;
}

/**
 * Select the asset best matching `spec`. Strategy:
 *  1. If exactly one asset has the requested extension AND arch token, take it.
 *  2. Otherwise score remaining candidates by binary-name + channel-suffix presence
 *     and keep the strictly-best. A tie returns `null`.
 */
export function matchAsset(
  assets: ReleaseAsset[],
  spec: MatchSpec,
): ReleaseAsset | null {
  // Candidate pool: right extension + right arch (and not the wrong arch).
  const pool = assets.filter(
    (a) => extOf(a.name) === spec.ext && archMatches(a.name, spec.arch),
  );
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0] ?? null;

  const score = (a: ReleaseAsset): number => {
    const toks = new Set(tokens(a.name));
    let s = 0;
    if (spec.binaryName && toks.has(spec.binaryName.toLowerCase())) s += 2;
    if (spec.channelSuffix) {
      // `pr-42` tokenizes to ["pr","42"]; require both to be present.
      const wanted = tokens(spec.channelSuffix);
      if (wanted.length > 0 && wanted.every((t) => toks.has(t))) s += 2;
    } else {
      // No channel requested: prefer assets that DON'T carry a channel-ish token — `beta`, its
      // legacy alias `staging`, or `pr` (WIRE-CONTRACT-V3 §5.1).
      if (!toks.has("beta") && !toks.has("staging") && !toks.has("pr")) s += 1;
    }
    return s;
  };

  let best: ReleaseAsset | null = null;
  let bestScore = -1;
  let tied = false;
  for (const a of pool) {
    const s = score(a);
    if (s > bestScore) {
      best = a;
      bestScore = s;
      tied = false;
    } else if (s === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * Build the conventional binary asset name for a `(binaryName, arch)` pair, used for
 * the exact-match fast path in installers (e.g. `djdl-arm64`). Channel builds get a
 * `-<channel>` infix on the binary name (e.g. `djdl-staging-arm64`).
 */
function conventionalBinaryName(
  binaryName: string,
  arch: Arch,
  channelSuffix?: string,
): string {
  const base = channelSuffix ? `${binaryName}-${channelSuffix}` : binaryName;
  return `${base}-${arch}`;
}

/** Try an exact-name hit first, then fall back to fuzzy `matchAsset`. */
export function findBinaryAsset(
  assets: ReleaseAsset[],
  binaryName: string,
  arch: Arch,
  channelSuffix?: string,
): ReleaseAsset | null {
  const exactName = conventionalBinaryName(binaryName, arch, channelSuffix);
  const exact = assets.find((a) => a.name === exactName);
  if (exact) return exact;
  return matchAsset(assets, { arch, ext: "", binaryName, channelSuffix });
}

/**
 * The conventional sibling-signature asset name for a DMG (`<dmg>.sig`).
 *
 * Asset NAMING is Release's model, not Update's: the release health check reads it to tell an
 * operator which sidecar is missing, and the appcast renderer reads it to find the signature it
 * must verify. It lived next to the renderer until P2.T1 split the feed out; keeping it here is
 * what lets `services/release/health.ts` ask the question without reaching into Update.
 */
export function sigAssetName(dmgName: string): string {
  return `${dmgName}.sig`;
}
