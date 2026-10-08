#!/usr/bin/env node
/**
 * The feed closure check (P0-52): every published version of the platform's npm packages pins only
 * sibling versions the feed lists, so every version installs.
 *
 * The `@polaris-key/*` packages depend on each other at EXACTLY the lockstep version (`pnpm pack`
 * rewrites `workspace:*`). When a publish leg never ran (v0.8.28's `jws`, v0.8.29's `protocol`, both
 * stuck in GitHub's `waiting`) while the packages that depend on it did, those dependents pin a
 * version that does not exist and fail to install, and an age gate (pnpm 11's one-day
 * `minimumReleaseAge`) lands adopters on exactly them.
 *
 *   node tools/feed-closure.mjs [--origin https://pkg.plrs.im] [--owner polaris-key]
 *       [--ecosystem npm,pypi] [--version <v>] [--complete] [--timeout <s>]
 *       [--assume <name@version>,…] [--summary <file>]
 *     The whole feed: every version of every npm package of the root `.pkey/release` (and any
 *     sibling they name), and every pin each one makes. A pin is broken when the feed does not
 *     list that exact version, when the feed has no such package, or when it is a range (the
 *     lockstep pins exactly; a peer dependency may be a range). Every broken pin is an error,
 *     except on a deprecated version, which installers already steer away from (a warning).
 *     For PyPI, the same promise: every listed version has a file to install, and no file
 *     belongs to an unlisted version (the feed serves one project, so there is no sibling pin).
 *     --version <v>  only that version's broken pins are errors (the rest are warnings), and the
 *                    check retries while they last, up to --timeout seconds (the render queue);
 *     --complete     with --version: every npm package must also list <v> (the set is whole);
 *     --assume       treat these versions as listed: what the feed would look like after a
 *                    repair publishes them (their own pins are not known, so not checked);
 *     --summary      append a Markdown report (GITHUB_STEP_SUMMARY).
 *
 *   node tools/feed-closure.mjs requires <dir|.tgz>… [--version <v>] [--origin …] [--owner …]
 *       [--timeout <s>]
 *     The pre-publish gate (publish-package.yml, before every npm publish): read each packed
 *     tarball's package.json, and wait until the feed lists every `@polaris-key/*` version it pins
 *     (dependencies, optionalDependencies, exact peerDependencies). Exits 1, naming the missing
 *     ones, once --timeout passes (0: no wait), or at once for a range pin or a tarball whose
 *     version is not --version. Dependency-free (node builtins only): it runs before any install.
 *
 *   node tools/feed-closure.mjs absent <name@version>… [--origin …] [--owner …]
 *     Exits 1 when the feed already lists any of them (npm-repair.yml's plan: a version is
 *     unique forever, so a backfill can only add one that never landed).
 *
 * Reads only, over plain HTTP, as an installer would: no credential, nothing published, yanked or
 * deprecated. A yanked version is still listed and installable by exact version, so a pin to it
 * resolves.
 */

import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const SCOPE = "@polaris-key/";
export const DEFAULT_ORIGIN = "https://pkg.plrs.im";
export const DEFAULT_OWNER = "polaris-key";

/** An exact SemVer version (what `workspace:*` packs to), not a range. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PIN_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

// ── Pins ────────────────────────────────────────────────────────────────────────────────────

/** The `@polaris-key/*` entries of one manifest (a packument version or a package.json). */
export function siblingPins(manifest, scope = SCOPE) {
  const out = [];
  for (const field of PIN_FIELDS) {
    const deps = manifest?.[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps))
      if (name.startsWith(scope)) out.push({ name, spec: String(spec), field });
  }
  return out;
}

/** `name@version` → its parts (the scope's `@` is not the separator). */
export function splitSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) throw new Error(`${spec} is not name@version`);
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * What is wrong with one pin, or `null`. `listed`: package name → the versions the feed lists, or
 * `null` when the feed has no such package.
 */
export function pinProblem(pin, listed) {
  if (!EXACT.test(pin.spec))
    return pin.field === "peerDependencies"
      ? null
      : `pins the range ${pin.spec}, not an exact version`;
  const have = listed.get(pin.name);
  if (!have) return `the feed has no ${pin.name}`;
  return have.has(pin.spec)
    ? null
    : `${pin.name}@${pin.spec} is not on the feed`;
}

// ── npm ─────────────────────────────────────────────────────────────────────────────────────

/** The versions each packument lists (`null` packument: the feed has no such package). */
export function listedVersions(packuments, assume = []) {
  const listed = new Map();
  for (const [name, p] of packuments)
    listed.set(name, p ? new Set(Object.keys(p.versions ?? {})) : null);
  for (const spec of assume) {
    const { name, version } = splitSpec(spec);
    const have = listed.get(name) ?? new Set();
    have.add(version);
    listed.set(name, have);
  }
  return listed;
}

/**
 * Every broken pin of every version of every package in `packuments` (name → packument, or `null`
 * when the feed has no such package), sorted by package, then version, then dependency.
 */
export function npmClosure(packuments, { assume = [] } = {}) {
  const listed = listedVersions(packuments, assume);
  const broken = [];
  let versions = 0;
  for (const [name, p] of packuments) {
    for (const [version, manifest] of Object.entries(p?.versions ?? {})) {
      versions++;
      const deprecated =
        typeof manifest?.deprecated === "string" && manifest.deprecated !== ""
          ? manifest.deprecated
          : null;
      for (const pin of siblingPins(manifest)) {
        const problem = pinProblem(pin, listed);
        if (problem)
          broken.push({
            name,
            version,
            dep: pin.name,
            spec: pin.spec,
            problem,
            deprecated,
          });
      }
    }
  }
  broken.sort(
    (a, b) =>
      cmp(a.name, b.name) ||
      a.version.localeCompare(b.version, "en", { numeric: true }) ||
      cmp(a.dep, b.dep),
  );
  return { packages: packuments.size, versions, broken };
}

/** Packages of the set that do not list `version` (the set at that version is incomplete). */
export function missingFromSet(packuments, names, version) {
  return names.filter((n) => !packuments.get(n)?.versions?.[version]);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── PyPI ────────────────────────────────────────────────────────────────────────────────────

/** The version a distribution's file name carries (`name-1.2.3.tar.gz`, `name-1.2.3-py3-…whl`). */
export function pypiFileVersion(filename) {
  const wheel = /^[^-]+-([^-]+)-.+\.whl$/.exec(filename);
  if (wheel) return wheel[1];
  const sdist = /^.+-([^-]+)\.(?:tar\.gz|zip)$/.exec(filename);
  return sdist ? sdist[1] : null;
}

/**
 * One PyPI project's PEP 691 page: a listed version with no file cannot be installed, and a file
 * of an unlisted version is one the index forgot. (Every file of a version yanked is a yank, not
 * a gap.)
 */
export function pypiClosure(project) {
  const listed = new Set(project.versions ?? []);
  const byVersion = new Map();
  const broken = [];
  for (const f of project.files ?? []) {
    const v = pypiFileVersion(f.filename);
    if (v === null || !listed.has(v)) {
      broken.push({
        name: project.name,
        version: v ?? f.filename,
        problem: `${f.filename} belongs to no listed version`,
      });
      continue;
    }
    byVersion.set(v, [...(byVersion.get(v) ?? []), f]);
  }
  for (const v of listed)
    if (!byVersion.has(v))
      broken.push({
        name: project.name,
        version: v,
        problem: "is listed with no file to install",
      });
  return { versions: listed.size, broken };
}

// ── The feed ────────────────────────────────────────────────────────────────────────────────

function npmUrl(origin, owner, name) {
  return `${origin.replace(/\/+$/, "")}/npm/${owner}/${name.replace("/", "%2f")}`;
}

/** One packument, or `null` when the feed has no such package. */
export async function readPackument(
  origin,
  owner,
  name,
  fetchImpl = globalThis.fetch,
) {
  const url = npmUrl(origin, owner, name);
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

/**
 * The packuments of `names` and of every sibling any of their versions pins, transitively, so a
 * pin to a package outside the list is still checked against the feed.
 */
export async function readPackuments(origin, owner, names, fetchImpl) {
  const out = new Map();
  const queue = [...names];
  while (queue.length) {
    const batch = queue.splice(0).filter((n) => !out.has(n));
    const docs = await Promise.all(
      batch.map((n) => readPackument(origin, owner, n, fetchImpl)),
    );
    batch.forEach((n, i) => out.set(n, docs[i]));
    for (const doc of docs)
      for (const manifest of Object.values(doc?.versions ?? {}))
        for (const pin of siblingPins(manifest))
          if (!out.has(pin.name) && !queue.includes(pin.name))
            queue.push(pin.name);
  }
  return new Map([...out].sort(([a], [b]) => cmp(a, b)));
}

/** A PyPI project's PEP 691 page. */
export async function readPypiProject(
  origin,
  owner,
  name,
  fetchImpl = globalThis.fetch,
) {
  const url = `${origin.replace(/\/+$/, "")}/pypi/${owner}/simple/${name}/`;
  const res = await fetchImpl(url, {
    headers: { accept: "application/vnd.pypi.simple.v1+json" },
  });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

// ── Packed tarballs ─────────────────────────────────────────────────────────────────────────

/** One file of a (gzipped) tar archive, by its path inside the archive, or `null`. */
export function readTarEntry(tgz, wanted) {
  const tar = tgz[0] === 0x1f && tgz[1] === 0x8b ? gunzipSync(tgz) : tgz;
  let longName = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) =>
      header
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name =
      longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    longName = null;
    if ((type === "0" || type === "" || type === "\0") && name === wanted)
      return Buffer.from(body);
  }
  return null;
}

/** The package.json of a packed npm tarball (`pnpm pack` puts it at `package/package.json`). */
export function tarballManifest(tgz) {
  const body = readTarEntry(tgz, "package/package.json");
  if (!body) throw new Error("no package/package.json in the tarball");
  return JSON.parse(body.toString("utf8"));
}

/** The .tgz files a path names: the file itself, or every .tgz directly in a directory. */
export function tarballsAt(path) {
  if (!statSync(path).isDirectory()) return [path];
  const out = readdirSync(path)
    .filter((f) => f.endsWith(".tgz"))
    .sort()
    .map((f) => join(path, f));
  if (!out.length) throw new Error(`no .tgz in ${path}`);
  return out;
}

// ── The pre-publish gate ────────────────────────────────────────────────────────────────────

/**
 * Wait until the feed lists every pinned version, re-reading only the packages still missing one.
 * Answers the pins still missing when `timeoutSec` has passed (empty: all there).
 */
export async function waitForPins({
  origin,
  owner,
  pins,
  timeoutSec,
  fetchImpl,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  const until = now() + timeoutSec * 1000;
  let pending = pins;
  for (let attempt = 1; ; attempt++) {
    const names = [...new Set(pending.map((p) => p.name))];
    const docs = new Map();
    for (const n of names)
      docs.set(n, await readPackument(origin, owner, n, fetchImpl));
    const listed = listedVersions(docs);
    pending = pending.filter((p) => pinProblem(p, listed) !== null);
    if (!pending.length || now() >= until) return pending;
    log(
      `attempt ${attempt}: ${pending.map((p) => `${p.name}@${p.spec}`).join(", ")} not on the feed yet; retrying`,
    );
    await sleep(Math.min(15_000, 2_000 * attempt));
  }
}

// ── The command line ────────────────────────────────────────────────────────────────────────

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** The positional arguments after the command (anything that is not a flag or a flag's value). */
function positionals(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (!["--complete"].includes(argv[i])) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

const write = (line) => process.stdout.write(`${line}\n`);

async function requires(argv) {
  const origin = arg(argv, "--origin") ?? DEFAULT_ORIGIN;
  const owner = arg(argv, "--owner") ?? DEFAULT_OWNER;
  const version = arg(argv, "--version");
  const timeoutSec = Number(arg(argv, "--timeout") ?? "600");
  const paths = positionals(argv);
  if (!paths.length)
    throw new Error(
      "usage: feed-closure.mjs requires <dir|.tgz>… [--version <v>] [--timeout <s>]",
    );
  const pins = [];
  let failed = false;
  for (const file of paths.flatMap((p) => tarballsAt(resolve(p)))) {
    const pkg = tarballManifest(readFileSync(file));
    const id = `${pkg.name}@${pkg.version}`;
    if (version !== undefined && pkg.version !== version) {
      write(`::error::${id} is not at ${version} (${file}).`);
      failed = true;
    }
    for (const pin of siblingPins(pkg)) {
      if (!EXACT.test(pin.spec)) {
        if (pin.field === "peerDependencies") continue;
        write(
          `::error::${id} pins ${pin.name}@${pin.spec}, a range: the lockstep packages pin each other exactly.`,
        );
        failed = true;
        continue;
      }
      pins.push({ ...pin, of: id });
    }
  }
  if (failed) return 1;
  if (!pins.length) {
    write("No @polaris-key dependency: nothing to wait for.");
    return 0;
  }
  const missing = await waitForPins({
    origin,
    owner,
    pins,
    timeoutSec,
    log: write,
  });
  for (const p of pins)
    if (!missing.includes(p))
      write(`ok   ${p.of} -> ${p.name}@${p.spec} is on the feed`);
  for (const p of missing)
    write(
      `::error::${p.of} pins ${p.name}@${p.spec}, which ${npmUrl(origin, owner, p.name)} does not list${timeoutSec > 0 ? ` after ${timeoutSec} s` : ""}. Nothing was published: publish ${p.name}@${p.spec} first (a stuck or failed leg below this one).`,
    );
  return missing.length ? 1 : 0;
}

async function absent(argv) {
  const origin = arg(argv, "--origin") ?? DEFAULT_ORIGIN;
  const owner = arg(argv, "--owner") ?? DEFAULT_OWNER;
  const specs = positionals(argv);
  if (!specs.length)
    throw new Error("usage: feed-closure.mjs absent <name@version>…");
  let taken = 0;
  for (const spec of specs) {
    const { name, version } = splitSpec(spec);
    const doc = await readPackument(origin, owner, name);
    if (doc?.versions?.[version]) {
      write(
        `::error::${spec} is already on the feed: a version is unique forever, so there is nothing to backfill.`,
      );
      taken++;
    } else write(`ok   ${spec} is not on the feed`);
  }
  return taken ? 1 : 0;
}

/** The root `.pkey/release`'s package names per ecosystem (needs `yaml`: imported here only). */
async function declaredPackages(root) {
  const { packageDeliverables } = await import("./feed-drift.mjs");
  const byEcosystem = new Map();
  for (const d of packageDeliverables(root))
    byEcosystem.set(d.ecosystem, [
      ...(byEcosystem.get(d.ecosystem) ?? []),
      d.name,
    ]);
  return byEcosystem;
}

async function fullCheck(argv) {
  const origin = arg(argv, "--origin") ?? DEFAULT_ORIGIN;
  const owner = arg(argv, "--owner") ?? DEFAULT_OWNER;
  const version = arg(argv, "--version");
  const complete = argv.includes("--complete");
  const timeoutSec = Number(arg(argv, "--timeout") ?? "0");
  const ecosystems = (arg(argv, "--ecosystem") ?? "npm,pypi")
    .split(",")
    .filter(Boolean);
  const assume = (arg(argv, "--assume") ?? "").split(",").filter(Boolean);
  const summary = arg(argv, "--summary");
  const root =
    arg(argv, "--root") ??
    join(fileURLToPath(new URL(".", import.meta.url)), "..");
  if (complete && version === undefined)
    throw new Error("--complete needs --version");
  const declared = await declaredPackages(root);
  const errors = [];
  const warnings = [];
  const report = [];

  if (ecosystems.includes("npm")) {
    const names = declared.get("npm") ?? [];
    const until = Date.now() + timeoutSec * 1000;
    let result;
    let incomplete = [];
    for (let attempt = 1; ; attempt++) {
      const docs = await readPackuments(origin, owner, names);
      result = npmClosure(docs, { assume });
      incomplete = complete ? missingFromSet(docs, names, version) : [];
      const blocking = result.broken.filter(
        (b) =>
          !b.deprecated && (version === undefined || b.version === version),
      );
      if ((!blocking.length && !incomplete.length) || Date.now() >= until)
        break;
      write(
        `attempt ${attempt}: ${blocking.length + incomplete.length} problem(s) at ${version}; retrying`,
      );
      await new Promise((r) =>
        setTimeout(r, Math.min(15_000, 2_000 * attempt)),
      );
    }
    for (const b of result.broken) {
      const line = `${b.name}@${b.version}: ${b.problem}`;
      if (b.deprecated) warnings.push(`${line} (deprecated: ${b.deprecated})`);
      else if (version === undefined || b.version === version)
        errors.push(line);
      else warnings.push(line);
    }
    for (const n of incomplete) errors.push(`${n} does not list ${version}`);
    const affected = new Set(
      result.broken.map((b) => `${b.name}@${b.version}`),
    );
    report.push(
      affected.size
        ? `npm: ${affected.size} of ${result.versions} versions of ${result.packages} packages pin a sibling the feed does not have${assume.length ? ` (assuming ${assume.join(", ")} published)` : ""}:`
        : `npm: every pin of all ${result.versions} versions of ${result.packages} packages resolves${assume.length ? ` (assuming ${assume.join(", ")} published)` : ""}.`,
    );
    for (const b of result.broken)
      report.push(
        `  ${b.name}@${b.version} -> ${b.dep}@${b.spec}${b.deprecated ? " (deprecated)" : ""}`,
      );
  }

  if (ecosystems.includes("pypi")) {
    for (const name of declared.get("pypi") ?? []) {
      const r = pypiClosure(await readPypiProject(origin, owner, name));
      for (const b of r.broken) {
        const line = `${b.name} ${b.version}: ${b.problem}`;
        if (version === undefined) errors.push(line);
        else warnings.push(line);
      }
      report.push(
        r.broken.length
          ? `pypi: ${r.broken.length} problem(s) in ${name}'s ${r.versions} versions:`
          : `pypi: all ${r.versions} versions of ${name} have a file to install.`,
      );
      for (const b of r.broken)
        report.push(`  ${b.name} ${b.version}: ${b.problem}`);
    }
  }

  for (const e of errors) write(`::error::${e}`);
  for (const w of warnings) write(`::warning::${w}`);
  write("");
  for (const line of report) write(line);
  if (summary)
    appendFileSync(
      summary,
      `### Feed closure\n\n\`\`\`\n${report.join("\n")}\n\`\`\`\n`,
    );
  return errors.length ? 1 : 0;
}

export async function main(argv) {
  if (argv[0] === "requires") return requires(argv);
  if (argv[0] === "absent") return absent(argv);
  return fullCheck(["check", ...argv]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(
        `::error::${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exit(1);
    },
  );
}
