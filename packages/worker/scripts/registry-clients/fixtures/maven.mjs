/**
 * The Maven fixture (F-07): `im.plrs.fixture:demo` in the owner's Maven feed, with
 *
 *   0.9.0         stable, deprecated
 *   1.0.0         stable (with a -sources jar)   ← the stable head: `release`
 *   1.1.0         stable, yanked                  ← gone from maven-metadata.xml
 *   1.2.0-beta.1  beta                            ← the newest: `latest`
 *
 * Each version is what Gradle's `maven-publish` writes: a jar (an empty zip whose comment names
 * it, so every version's bytes differ), a POM carrying Gradle's metadata marker and a `.module`
 * whose variants name the jar with its size and digests. The digests in `files_json` are what
 * the ingest would have streamed (`packages/digests.ts`).
 */

import { createHash } from "node:crypto";

export const MAVEN_GROUP = "im.plrs.fixture";
export const MAVEN_ARTIFACT = "demo";
const NAME = `${MAVEN_GROUP}:${MAVEN_ARTIFACT}`;
const DELIVERABLE = "maven.demo";

const VERSIONS = [
  {
    version: "0.9.0",
    channel: "stable",
    state: "deprecated",
    message: "use 1.0.0",
  },
  { version: "1.0.0", channel: "stable", state: "live", sources: true },
  {
    version: "1.1.0",
    channel: "stable",
    state: "yanked",
    message: "broken build",
  },
  { version: "1.2.0-beta.1", channel: "beta", state: "live" },
];

const hex = (algo, b) => createHash(algo).update(b).digest("hex");
const enc = new TextEncoder();

function emptyJar(comment) {
  const c = enc.encode(comment);
  const eocd = new Uint8Array(22 + c.length);
  eocd.set([0x50, 0x4b, 0x05, 0x06]);
  eocd[20] = c.length & 0xff;
  eocd[21] = c.length >> 8;
  eocd.set(c, 22);
  return eocd;
}

function digests(bytes) {
  return {
    sha512: hex("sha512", bytes),
    sha256: hex("sha256", bytes),
    sha1: hex("sha1", bytes),
    md5: hex("md5", bytes),
  };
}

function versionFiles(version, sources, status) {
  const files = [];
  const jarName = `${MAVEN_ARTIFACT}-${version}.jar`;
  const jar = emptyJar(`${NAME}:${version}`);
  files.push({ name: jarName, extension: "jar", bytes: jar });
  if (sources)
    files.push({
      name: `${MAVEN_ARTIFACT}-${version}-sources.jar`,
      extension: "jar",
      classifier: "sources",
      bytes: emptyJar(`${NAME}:${version}:sources`),
    });
  const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <!-- This module was also published with a richer model, Gradle metadata,  -->
  <!-- which should be used instead. Do not delete the following line which  -->
  <!-- is to indicate to Gradle or any Gradle module metadata file consumer  -->
  <!-- that they should prefer consuming it instead. -->
  <!-- do_not_remove: published-with-gradle-metadata -->
  <modelVersion>4.0.0</modelVersion>
  <groupId>${MAVEN_GROUP}</groupId>
  <artifactId>${MAVEN_ARTIFACT}</artifactId>
  <version>${version}</version>
  <packaging>jar</packaging>
</project>
`;
  files.push({
    name: `${MAVEN_ARTIFACT}-${version}.pom`,
    extension: "pom",
    bytes: enc.encode(pom),
  });
  const jarRef = {
    name: jarName,
    url: jarName,
    size: jar.length,
    ...digests(jar),
  };
  const variant = (name, usage) => ({
    name,
    attributes: {
      "org.gradle.category": "library",
      "org.gradle.dependency.bundling": "external",
      "org.gradle.jvm.version": 8,
      "org.gradle.libraryelements": "jar",
      "org.gradle.usage": usage,
    },
    files: [jarRef],
  });
  const module = {
    formatVersion: "1.1",
    component: {
      group: MAVEN_GROUP,
      module: MAVEN_ARTIFACT,
      version,
      attributes: { "org.gradle.status": status },
    },
    createdBy: { gradle: { version: "8.14" } },
    variants: [
      variant("apiElements", "java-api"),
      variant("runtimeElements", "java-runtime"),
    ],
  };
  files.push({
    name: `${MAVEN_ARTIFACT}-${version}.module`,
    extension: "module",
    bytes: enc.encode(`${JSON.stringify(module, null, 2)}\n`),
  });
  return files;
}

export async function seedFixture(env, { owner, now }) {
  const db = env.DB;
  const run = (sql, ...params) =>
    db
      .prepare(sql)
      .bind(...params)
      .run();
  await run(
    `INSERT OR REPLACE INTO dist_registry_owners (product, enabled, version, updated_at)
     VALUES (?, 1, 1, ?)`,
    owner,
    now,
  );
  await run(
    `INSERT OR REPLACE INTO dist_registry_feeds
       (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, updated_at)
     VALUES (?, 'maven', 1, 'public', ?, 52428800, ?)`,
    owner,
    JSON.stringify({ groupPrefixes: [MAVEN_GROUP] }),
    now,
  );
  await run(
    `INSERT OR REPLACE INTO dist_access (product, deliverable_id, mode, source, modified_at)
     VALUES (?, ?, 'public', 'manifest', ?)`,
    owner,
    DELIVERABLE,
    now,
  );
  const decl = {
    kind: "package",
    id: DELIVERABLE,
    ecosystem: "maven",
    name: NAME,
    artifacts: { publication: { match: "build/repo/**" } },
  };
  await run(
    `INSERT OR REPLACE INTO release_deliverables
       (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at,
        ecosystem, package_name)
     VALUES (?, ?, 'package', NULL, ?, 'manifest', ?, ?, 'maven', ?)`,
    owner,
    DELIVERABLE,
    JSON.stringify(decl),
    now,
    now,
    NAME,
  );
  let seq = 0;
  for (const v of VERSIONS) {
    seq++;
    const at = now - 3600 + seq * 60;
    const releaseId = `${DELIVERABLE}@${v.version}`;
    const rows = [];
    // Gradle's `latest.release` reads the publication's status: a beta is a milestone.
    const status = v.channel === "beta" ? "milestone" : "release";
    for (const f of versionFiles(v.version, v.sources === true, status)) {
      const d = digests(f.bytes);
      await env.BLOBS.put(`blobs/sha256/${d.sha256}`, f.bytes, {
        sha256: d.sha256,
      });
      rows.push({
        name: f.name,
        type: "maven-file",
        sha256: d.sha256,
        size: f.bytes.length,
        extension: f.extension,
        ...(f.classifier ? { classifier: f.classifier } : {}),
        sha1: d.sha1,
        sha512: d.sha512,
        md5: d.md5,
      });
    }
    await run(
      `INSERT OR REPLACE INTO release_metadata
         (product, release_id, version, title, metadata_access, artifacts_access, published_at,
          metadata_json, created_at, modified_at, deliverable_id, seq, channel)
       VALUES (?, ?, ?, ?, 'public', 'public', ?, '{}', ?, ?, ?, ?, ?)`,
      owner,
      releaseId,
      v.version,
      `${NAME} ${v.version}`,
      at,
      at,
      at,
      DELIVERABLE,
      seq,
      v.channel,
    );
    await run(
      `INSERT OR REPLACE INTO release_packages
         (product, ecosystem, name_norm, version, deliverable_id, release_id, name, state,
          state_message, files_json, metadata_json, source_json, published_at)
       VALUES (?, 'maven', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{"kind":"static"}', ?)`,
      owner,
      NAME.toLowerCase(),
      v.version,
      DELIVERABLE,
      releaseId,
      NAME,
      v.state,
      v.message ?? null,
      JSON.stringify(rows),
      JSON.stringify({
        name: NAME,
        version: v.version,
        groupId: MAVEN_GROUP,
        artifactId: MAVEN_ARTIFACT,
        packaging: "jar",
      }),
      at,
    );
    if (v.state === "yanked")
      await run(
        `INSERT OR REPLACE INTO release_yanks (product, release_id, reason, at, by)
         VALUES (?, ?, ?, ?, 'fixture')`,
        owner,
        releaseId,
        v.message,
        at,
      );
  }
}
