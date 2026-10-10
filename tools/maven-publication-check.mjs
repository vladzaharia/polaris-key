#!/usr/bin/env node
/**
 * The Maven publication check (kotlin-build, before anything is uploaded): every `maven.*`
 * deliverable `.pkey/release` declares must find, in the local Gradle repo, exactly the one POM
 * the publisher's extractor (packages/cli/src/package/maven.ts) needs: a non-sidecar `.pom`
 * whose file name matches the deliverable's `artifacts` glob, whose artifactId completes the
 * declared `group:artifactId` and whose version is the release version. A release version whose
 * POM matches nothing therefore fails in the build job, not in the publish job after the other
 * feeds have already published.
 *
 *   node tools/maven-publication-check.mjs --repo sdks/kotlin/build/repo --version 0.9.3 [--release .pkey/release.yaml]
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR = /\.(md5|sha1|sha256|sha512|asc)$/;

/** The artifact-glob dialect of .pkey/release: `*` and `?`, everything else literal. */
export function globMatches(glob, name) {
  const re = [...glob]
    .map((c) =>
      c === "*"
        ? "[\\s\\S]*"
        : c === "?"
          ? "[\\s\\S]"
          : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${re}$`).test(name);
}

/** The maven.* deliverables of a release.yaml text: `{ id, name, match }`. */
export function mavenDeliverables(releaseYaml) {
  const out = [];
  const lines = releaseYaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s{4}(maven\.[A-Za-z0-9._-]+):\s*$/.exec(lines[i]);
    if (!head) continue;
    let name = null;
    let match = null;
    for (let j = i + 1; j < lines.length && !/^\s{4}\S/.test(lines[j]); j++) {
      name ??= /^\s+name:\s*"?([^"\s]+)"?\s*$/.exec(lines[j])?.[1] ?? null;
      match ??= /match:\s*"([^"]+)"/.exec(lines[j])?.[1] ?? null;
    }
    out.push({ id: head[1], name, match });
  }
  return out;
}

function walk(dir) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else if (e.isFile()) files.push({ name: e.name, path: p });
  }
  return files;
}

/** Problems found (empty = fine) for a Gradle repo directory at one release version. */
export function checkPublication(repoDir, version, releaseYaml) {
  const problems = [];
  const deliverables = mavenDeliverables(releaseYaml);
  if (deliverables.length === 0)
    problems.push("no maven.* deliverable in .pkey/release.");
  const all = walk(repoDir).filter((f) => !SIDECAR.test(f.name));
  for (const d of deliverables) {
    if (!d.name || !d.match) {
      problems.push(`${d.id}: no name or artifacts match in .pkey/release.`);
      continue;
    }
    const artifactId = d.name.split(":")[1];
    const poms = all.filter(
      (f) => f.name.endsWith(".pom") && globMatches(d.match, f.name),
    );
    if (poms.length !== 1) {
      problems.push(
        `${d.id}: ${poms.length} POMs under ${repoDir} match "${d.match}" (the publisher needs exactly one).`,
      );
      continue;
    }
    const want = `${artifactId}-${version}.pom`;
    if (poms[0].name !== want) {
      problems.push(`${d.id}: the POM is ${poms[0].name}, expected ${want}.`);
      continue;
    }
    const xml = readFileSync(poms[0].path, "utf8");
    const own = xml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(
        /<(parent|dependencies|dependencyManagement|build|profiles)\b[\s\S]*?<\/\1>/g,
        "",
      );
    const v = /<version>\s*([^<\s]+)\s*<\/version>/.exec(own)?.[1];
    const a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(own)?.[1];
    if (a !== artifactId || v !== version)
      problems.push(
        `${d.id}: the POM says ${a}:${v}, expected ${artifactId}:${version}.`,
      );
  }
  return problems;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i < 0 ? undefined : args[i + 1];
  };
  const repo = opt("--repo");
  const version = opt("--version");
  const release =
    opt("--release") ??
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      ".pkey",
      "release.yaml",
    );
  if (!repo || !version) {
    console.error(
      "usage: maven-publication-check.mjs --repo <dir> --version <v> [--release <file>]",
    );
    process.exit(2);
  }
  const problems = checkPublication(
    repo,
    version,
    readFileSync(release, "utf8"),
  );
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length) process.exit(1);
  console.log(
    `maven publication ok: every maven.* deliverable finds its POM at ${version}.`,
  );
}
