#!/usr/bin/env node
/**
 * The feed drift check (F-10 automation, owner decision 2026-10-04): after the SDKs are published,
 * every package the root `.pkey/release` declares must show the lockstep version on its feed, as
 * the newest version of its kind, and fail loudly otherwise.
 *
 *   node tools/feed-drift.mjs --origin https://pkg.plrs.im --version 0.9.1-main.4 \
 *     --pep440 0.9.1.dev4 --channel main [--owner polaris-key] [--root .] [--timeout 600]
 *
 * For each package deliverable it reads the feed's own version listing, over plain HTTP, as a
 * client would:
 *
 *   npm     GET /npm/<owner>/<@scope%2fname>           the packument: `versions`, `dist-tags`
 *   pypi    GET /pypi/<owner>/simple/<name>/            PEP 691 JSON: `versions` (PEP 700)
 *   swift   GET /swift/<owner>/<scope>/<name>           SE-0292 release list
 *   maven   GET /maven/<owner>/<group>/<artifact>/maven-metadata.xml   `<version>`s
 *   godot   GET /godot/<owner>/store/api/v1/releases/<publisher>/<name>/   the 4.7 editor's list
 *   oci     GET /v2/<owner>/<name>/tags/list            the tags
 *
 * and asserts: the expected version is listed; it is the newest listed version of the same kind
 * (a stable release among stable releases, a beta among betas, a main build among main builds,
 * each by its ecosystem's ordering); and where the feed has channel tags (npm's dist-tags, OCI's
 * tags) the channel's tag names it: npm `latest` / `beta` / `main`, OCI `latest` / `beta` /
 * `main`. Feeds render asynchronously (the package render queue), so a miss is retried until
 * `--timeout` seconds have passed; then every remaining mismatch is reported and it exits 1.
 *
 * On a stable build it also warns (never fails) about builds of main at or below the release
 * that the feed still lists: the Worker's feed retention should have pruned them
 * (`staleMainBuilds`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/** The Godot feed's publisher and the Swift scope of the system product (the worker's console/systemProduct.ts). */
const GODOT_PUBLISHER = "polaris-key";

// ── Version ordering ────────────────────────────────────────────────────────────────────────

/** SemVer 2.0.0 precedence (build metadata ignored); `null` for a version that is not SemVer. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const k of ["major", "minor", "patch"])
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length)
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseSemver(v) {
  const m =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** PEP 440 ordering for the forms this repository publishes: X.Y.Z, X.Y.Z{a,b,rc}N, X.Y.Z.devN. */
export function comparePep440(a, b) {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < pa.key.length; i++)
    if (pa.key[i] !== pb.key[i]) return pa.key[i] < pb.key[i] ? -1 : 1;
  return 0;
}

function parsePep440(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?(?:\.dev(\d+))?$/.exec(v);
  if (!m) return null;
  // dev < a < b < rc < final, for one release; a dev of a prerelease sorts before that prerelease.
  const phase = m[4] ? { a: 1, b: 2, rc: 3 }[m[4]] : 4;
  const preN = m[5] ? Number(m[5]) : 0;
  const dev = m[6] !== undefined;
  const key = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (dev && !m[4]) key.push(0, 0, 0, Number(m[6]));
  else key.push(phase, preN, dev ? 0 : 1, dev ? Number(m[6]) : 0);
  return { key };
}

/** Which kind of build a version is: `stable`, `beta` (a tagged prerelease) or `main`. */
export function kindOf(version, ecosystem) {
  if (ecosystem === "pypi") {
    if (/\.dev\d+$/.test(version)) return "main";
    return /(a|b|rc)\d+$/.test(version) ? "beta" : "stable";
  }
  if (/-main\.\d+$/.test(version)) return "main";
  return version.includes("-") ? "beta" : "stable";
}

// ── The feeds ───────────────────────────────────────────────────────────────────────────────

async function get(url, accept) {
  const res = await fetch(url, {
    headers: accept ? { accept } : {},
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res;
}

/** The versions a feed lists for one package, and its channel tags when it has any. */
export async function readFeed(origin, owner, deliverable) {
  const { ecosystem, name } = deliverable;
  const base = origin.replace(/\/+$/, "");
  switch (ecosystem) {
    case "npm": {
      const p = await (
        await get(
          `${base}/npm/${owner}/${name.replace("/", "%2f")}`,
          "application/json",
        )
      ).json();
      return {
        versions: Object.keys(p.versions ?? {}),
        tags: p["dist-tags"] ?? {},
      };
    }
    case "pypi": {
      const p = await (
        await get(
          `${base}/pypi/${owner}/simple/${name}/`,
          "application/vnd.pypi.simple.v1+json",
        )
      ).json();
      return { versions: p.versions ?? [], tags: null };
    }
    case "swift": {
      const [scope, pkg] = name.split(".");
      const p = await (
        await get(
          `${base}/swift/${owner}/${scope}/${pkg}`,
          "application/vnd.swift.registry.v1+json",
        )
      ).json();
      return { versions: Object.keys(p.releases ?? {}), tags: null };
    }
    case "maven": {
      const [group, artifact] = name.split(":");
      const xml = await (
        await get(
          `${base}/maven/${owner}/${group.replaceAll(".", "/")}/${artifact}/maven-metadata.xml`,
        )
      ).text();
      return {
        versions: [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(
          (m) => m[1],
        ),
        tags: null,
      };
    }
    case "godot": {
      const list = await (
        await get(
          `${base}/godot/${owner}/store/api/v1/releases/${GODOT_PUBLISHER}/${name}/`,
          "application/json",
        )
      ).json();
      return { versions: list.map((r) => r.version), tags: null };
    }
    case "oci": {
      const p = await (
        await get(
          `${base}/v2/${owner}/${name}/tags/list?n=10000`,
          "application/json",
        )
      ).json();
      const tags = p.tags ?? [];
      return {
        versions: tags.filter((t) => /^\d+\.\d+\.\d+/.test(t)),
        tags: Object.fromEntries(
          tags.filter((t) => !/^\d/.test(t)).map((t) => [t, true]),
        ),
      };
    }
    default:
      throw new Error(`no drift check for the ${ecosystem} feed`);
  }
}

/** The channel tag a feed with tags must carry for this build, or `null`. */
function channelTag(channel) {
  return channel === "stable" ? "latest" : channel;
}

/** Problems with one package's listing (empty: in step). */
export function checkListing(deliverable, listing, expected) {
  const { ecosystem } = deliverable;
  const want = ecosystem === "pypi" ? expected.pep440 : expected.version;
  const compare = ecosystem === "pypi" ? comparePep440 : compareSemver;
  const problems = [];
  if (!listing.versions.includes(want)) {
    problems.push(
      `${want} is not listed (newest: ${newest(listing.versions, compare) ?? "none"})`,
    );
    return problems;
  }
  const kind = kindOf(want, ecosystem);
  const sameKind = listing.versions.filter(
    (v) => kindOf(v, ecosystem) === kind,
  );
  const top = newest(sameKind, compare);
  if (top !== want)
    problems.push(`the newest ${kind} version is ${top}, not ${want}`);
  if (listing.tags) {
    const tag = channelTag(expected.channel);
    if (ecosystem === "npm" && listing.tags[tag] !== want)
      problems.push(
        `dist-tag ${tag} is ${listing.tags[tag] ?? "unset"}, not ${want}`,
      );
    // `latest` is only ever a stable release: any prerelease there (this build or an older
    // one of any channel) was promoted by nobody.
    const latest = listing.tags.latest;
    if (
      ecosystem === "npm" &&
      expected.channel !== "stable" &&
      latest !== undefined &&
      kindOf(latest, ecosystem) !== "stable"
    )
      problems.push(
        `dist-tag latest names the ${kindOf(latest, ecosystem)} build ${latest}`,
      );
    if (ecosystem === "oci" && !listing.tags[tag])
      problems.push(`the image has no ${tag} tag`);
  }
  return problems;
}

/**
 * Feed retention (the Worker prunes on a stable publish): on a STABLE build, the builds of main
 * the feed still lists at or below the released version (`X-main.N` / PyPI `X.devN`, X <= V).
 * The prune runs after the stable version is committed and never fails the publish, so these are
 * reported as warnings, not drift: the next stable publish, or `pkey feeds prune`, removes them.
 * Empty on any other channel, and for a product that turned retention off they are expected.
 */
export function staleMainBuilds(deliverable, listing, expected) {
  if (expected.channel !== "stable") return [];
  const { ecosystem } = deliverable;
  const want = ecosystem === "pypi" ? expected.pep440 : expected.version;
  const compare = ecosystem === "pypi" ? comparePep440 : compareSemver;
  return listing.versions.filter((v) => {
    if (kindOf(v, ecosystem) !== "main") return false;
    const base =
      ecosystem === "pypi"
        ? v.replace(/\.dev\d+$/, "")
        : v.replace(/-main\.\d+$/, "");
    const c = compare(base, want);
    return c !== null && c <= 0;
  });
}

function newest(versions, compare) {
  let best = null;
  for (const v of versions) {
    const c = best === null ? 1 : compare(v, best);
    if (c !== null && c > 0) best = v;
  }
  return best;
}

/** The package deliverables of the root `.pkey/release`. */
export function packageDeliverables(root) {
  const doc = parseYaml(
    readFileSync(join(root, ".pkey", "release.yaml"), "utf8"),
  );
  return Object.entries(doc.release.deliverables)
    .filter(([, d]) => d.kind === "package")
    .map(([id, d]) => ({ id, ecosystem: d.ecosystem, name: d.name }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Check every package, retrying misses until `timeoutSec`; answer the remaining problems by id. */
export async function checkDrift({
  origin,
  owner,
  root,
  expected,
  timeoutSec,
  only,
  log = () => {},
  sleep,
  warnings,
}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let pending = packageDeliverables(root).filter(
    (d) => !only?.length || only.includes(d.ecosystem),
  );
  const until = Date.now() + timeoutSec * 1000;
  const problems = new Map();
  for (let attempt = 1; ; attempt++) {
    problems.clear();
    for (const d of pending) {
      try {
        const listing = await readFeed(origin, owner, d);
        const p = checkListing(d, listing, expected);
        if (p.length) problems.set(d.id, p);
        else if (warnings) {
          const stale = staleMainBuilds(d, listing, expected);
          if (stale.length) warnings.set(d.id, stale);
          else warnings.delete(d.id);
        }
      } catch (e) {
        problems.set(d.id, [e instanceof Error ? e.message : String(e)]);
      }
    }
    pending = pending.filter((d) => problems.has(d.id));
    if (!pending.length || Date.now() >= until) break;
    log(
      `attempt ${attempt}: ${pending.length} package(s) not in step yet; retrying`,
    );
    await wait(Math.min(15_000, 2_000 * attempt));
  }
  return problems;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(argv) {
  const origin = arg(argv, "--origin");
  const version = arg(argv, "--version");
  const pep440 = arg(argv, "--pep440");
  const channel = arg(argv, "--channel");
  if (!origin || !version || !pep440 || !channel)
    throw new Error(
      "usage: feed-drift.mjs --origin <pkg origin> --version <v> --pep440 <v> --channel <c>",
    );
  const owner = arg(argv, "--owner") ?? "polaris-key";
  const root =
    arg(argv, "--root") ??
    join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const timeoutSec = Number(arg(argv, "--timeout") ?? "600");
  const only = (arg(argv, "--only") ?? "").split(",").filter(Boolean);
  const warnings = new Map();
  const problems = await checkDrift({
    origin,
    owner,
    root,
    expected: { version, pep440, channel },
    timeoutSec,
    only,
    log: (m) => process.stdout.write(`${m}\n`),
    warnings,
  });
  const all = packageDeliverables(root).filter(
    (d) => !only.length || only.includes(d.ecosystem),
  );
  for (const d of all) {
    const p = problems.get(d.id);
    if (p)
      for (const x of p)
        process.stdout.write(`::error::${d.id} (${d.name}): ${x}\n`);
    else
      process.stdout.write(
        `ok   ${d.id} ${d.ecosystem === "pypi" ? pep440 : version}\n`,
      );
    const stale = warnings.get(d.id);
    if (stale?.length)
      process.stdout.write(
        `::warning::${d.id} (${d.name}): ${stale.length} build${stale.length === 1 ? "" : "s"} of main at or below ${version} still listed (${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", …" : ""}); feed retention prunes them after a stable publish: check the product's audit for package.prune.failed, or run pkey feeds prune\n`,
      );
  }
  if (problems.size) {
    process.stdout.write(
      `\nFeed drift: ${problems.size} of ${all.length} packages are not at ${version}.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `\nNo drift: all ${all.length} packages are at ${version} (${channel}).\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(
      `::error::${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
