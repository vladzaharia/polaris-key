// Generated reference pages — tables the docs must never hand-maintain.
//
// Each emitter reads REAL source (validator code, protocol constants, migrations, the
// OpenAPI spec, the conformance corpus) and writes an MDX page under
// src/content/docs/reference/. The pages are committed (reviewable diffs, and the site
// builds without running generators), and test/generated.test.ts re-runs every emitter and
// byte-compares — a hand edit or a source change without regeneration fails CI.
//
//   node scripts/gen-reference.mjs          # write pages
//   node scripts/gen-reference.mjs --check  # exit 1 if any page is stale

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
const repo = join(docsRoot, "..", "..");
const outDir = join(docsRoot, "src", "content", "docs", "reference");

const read = (...segments) => readFileSync(join(repo, ...segments), "utf8");

function page(title, description, intro, body) {
  return `---
title: "${title}"
description: "${description}"
---

{/* GENERATED PAGE — do not edit. Regenerate with \`pnpm --filter @polaris-key/docs gen\`.
    Source of truth and emitter: packages/docs/scripts/gen-reference.mjs. */}

${intro}

${body}
`;
}

const escapeCell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
// MDX evaluates bare {…} in prose as JSX — brace-escape any prose cell that can carry
// template fragments (inside backticked code spans braces are literal and need no escape).
// `<` too: a message naming a placeholder (`blobs/sha256/<sha256>`) would open a JSX tag.
const mdxProse = (s) => String(s).replace(/([{}<])/g, "\\$1");
const table = (headers, rows) =>
  [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");

// ── 1. Manifest validation codes ───────────────────────────────────────────────
function manifestValidationCodes() {
  // `.pkey/distribution`'s rules (P2b-02) and the duplicate-spelling pass (ST-19) live in their
  // own modules of the same validator. Each module is scanned on its own: the helper regex is lazy
  // across lines, so running it over concatenated sources lets a match start in one file and end
  // in the next.
  const sources = ["index.ts", "distribution.ts", "spellings.ts"].map((f) =>
    read("packages", "shared-manifest", "src", f),
  );
  const rows = [];
  // add(errors|warnings, "<file>", <path>, "<code>", <message>)
  const addRe =
    /add\(\s*(errors|warnings),\s*"(product|schema|release|distribution)",\s*(`[^`]*`|"[^"]*")\s*,\s*"([a-z_]+)",\s*(`[^`]*`|"(?:[^"\\]|\\.)*")/g;
  for (const m of sources.flatMap((source) => [...source.matchAll(addRe)])) {
    rows.push([
      `\`${m[4]}\``,
      m[1] === "warnings" ? "warning" : "error",
      m[2],
      `\`${m[3].slice(1, -1)}\``,
      mdxProse(m[5].slice(1, -1).replace(/\\"/g, '"')),
    ]);
  }
  // constrained/constrainedList/boundedText(errors, "<file>", value, <path>, "<code>", …, "<message>")
  const helperRe =
    /(?:constrained|constrainedList|boundedText)\(\s*errors,\s*"(product|schema|release)",\s*[\s\S]*?,\s*(`[^`]*`|"[^"]*")\s*,\s*"([a-z_]+)",\s*[\s\S]*?(`[^`]*`|"(?:[^"\\]|\\.)*")\s*,?\s*\)/g;
  for (const m of sources.flatMap((source) => [...source.matchAll(helperRe)])) {
    rows.push([
      `\`${m[3]}\``,
      "error",
      m[1],
      `\`${m[2].slice(1, -1)}\``,
      mdxProse(m[4].slice(1, -1).replace(/\\"/g, '"')),
    ]);
  }
  const seen = new Set();
  const unique = rows.filter((row) => {
    const key = row.join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a[0].localeCompare(b[0]) || a[3].localeCompare(b[3]));
  const descriptor = releaseDescriptorCodes();
  return page(
    "Manifest validation codes",
    "Every error and warning validateManifestDocuments and validateIngestDocuments can emit, extracted from the validator source.",
    `The \`.pkey/\` validator (\`@polaris-key/manifest\`) aggregates ALL problems instead of
stopping at the first; \`pkey validate\` and the console's link/resync surfaces show these
codes with their JSON-pointer paths. ${unique.length} distinct emit sites.

Interpolated segments (\`\${…}\`) in paths/messages are per-instance values — an array index,
the offending value, or the allowed set.`,
    [
      table(["Code", "Severity", "Document", "Path", "Message"], unique),
      "",
      "## Release descriptor codes",
      "",
      `\`validateReleaseDescriptor\` (\`@polaris-key/manifest\`, P2-04) checks a release descriptor
(\`pkey-release.json\`) against its own shape and the product's declared artifact map. Every
problem is an error; the Worker reports them under the ingest refusal reason
\`invalid_descriptor\`. ${descriptor.length} distinct emit sites.`,
      "",
      table(["Code", "Path", "Message"], descriptor),
    ].join("\n"),
  );
}

/** `err(<path>, "<code>", <message>)` calls in the release-descriptor validator. */
function releaseDescriptorCodes() {
  const source = read("packages", "shared-manifest", "src", "descriptor.ts");
  const errRe =
    /err\(\s*(`[^`]*`|"[^"]*")\s*,\s*"([a-z0-9_]+)",\s*(`[^`]*`|"(?:[^"\\]|\\.)*")/g;
  const rows = [];
  const seen = new Set();
  for (const m of source.matchAll(errRe)) {
    const row = [
      `\`${m[2]}\``,
      `\`${m[1].slice(1, -1)}\``,
      mdxProse(m[3].slice(1, -1).replace(/\\(["\\])/g, "$1")),
    ];
    const key = row.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return rows;
}

// ── 2. ConfigEntry field reference ─────────────────────────────────────────────
function configEntryReference() {
  const source = read("packages", "shared-catalog", "src", "types.ts");
  return page(
    "ConfigEntry — the catalog item shape",
    "The declarable catalog item, verbatim from @polaris-key/catalog's types — the shape every SDK and the console read.",
    `A product's catalog (\`.pkey/schema\`) is an array of these. The type below is the
SOURCE — reproduced verbatim so the docs cannot paraphrase it wrong. The per-entry
\`schema\` field is itself a JSON-Schema fragment (the Draft-07 subset the catalog's
fail-closed validator supports); do not confuse the two schema layers.`,
    "```ts\n" + source.trim() + "\n```",
  );
}

// ── 3. Wire error codes ────────────────────────────────────────────────────────
function errorCodes() {
  const core = read("packages", "shared-protocol", "src", "core.ts");
  const match = core.match(/export type PolarisErrorCode =([\s\S]*?);/);
  const codes = [...(match?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map(
    (m) => m[1],
  );
  const workerErrors = read("packages", "worker", "src", "core", "errors.ts");
  // A const object, not a TS enum: `export const ErrorCode = { Name: "code", … }`.
  const enumMatch =
    workerErrors.match(/export const ErrorCode = \{([\s\S]*?)\n\} as const/) ??
    workerErrors.match(/export const ErrorCode = \{([\s\S]*?)\n\};/);
  const enumRows = [
    ...(enumMatch?.[1] ?? "").matchAll(/([A-Za-z]+):\s*"([a-z_]+)"/g),
  ].map((m) => [`\`${m[2]}\``, `\`ErrorCode.${m[1]}\``]);
  // The registry (P1b-02): every code, wire and client. `pnpm gen:constants` generates each
  // SDK's ErrorCode constants from it; the client codes are listed here because no Worker
  // source names them.
  const registry = JSON.parse(
    read("conformance", "parity", "errors.json"),
  ).codes;
  const clientRows = registry
    .filter((entry) => entry.kind === "client")
    .map((entry) => [
      `\`${entry.code}\``,
      `\`${entry.service}\``,
      mdxProse(entry.description),
    ]);
  return page(
    "Wire error codes",
    "The PolarisErrorCode taxonomy (protocol), the worker's ErrorCode enum, and the client codes the SDKs raise.",
    `Wire-v3 errors are nested — \`{"error":{"code":…}}\` — and the not-found body is ONE
shape for "no such product", "service not enabled", and "no such route" (hide-don't-reveal).
${codes.length} protocol codes; the worker enum maps each to its response site.

Every code, wire and client, is registered in \`conformance/parity/errors.json\`
(${registry.length} codes), and \`pnpm gen:constants\` generates each SDK's \`ErrorCode\` constants
from it. A new code needs an entry there first.`,
    [
      "## Protocol codes (`@polaris-key/protocol/core`)",
      "",
      codes.map((code) => `- \`${code}\``).join("\n"),
      "",
      "## Worker enum (`packages/worker/src/core/errors.ts`)",
      "",
      enumRows.length
        ? table(["Wire code", "Enum member"], enumRows)
        : "_(enum not found)_",
      "",
      "## Client codes (`conformance/parity/errors.json`)",
      "",
      "Raised by an SDK, never sent by the Worker. Hosts match on the exact string.",
      "",
      table(["Code", "Service", "Meaning"], clientRows),
    ].join("\n"),
  );
}

// ── 4. Fingerprint constants ───────────────────────────────────────────────────
function fingerprintConstants() {
  const core = read("packages", "shared-protocol", "src", "core.ts");
  const grab = (re) => core.match(re)?.[1] ?? "?";
  const componentsMatch = core.match(/FINGERPRINT_COMPONENTS = \[([\s\S]*?)\]/);
  const components = [
    ...(componentsMatch?.[1] ?? "").matchAll(/"([a-zA-Z]+)"/g),
  ].map((m) => m[1]);
  const toleranceMatch = core.match(
    /FINGERPRINT_TOLERANCE[\s\S]*?\{([\s\S]*?)\}/,
  );
  const tolerance = [
    ...(toleranceMatch?.[1] ?? "").matchAll(
      /([a-z]+):\s*([A-Za-z0-9._]+(?:\.[A-Z_]+)?),/g,
    ),
  ].map((m) => [
    `\`${m[1]}\``,
    m[2].includes("POSITIVE_INFINITY") ? "∞ (never enforces)" : m[2],
  ]);
  return page(
    "Fingerprint constants",
    "The frozen hardware-fingerprint formulas — component order, hash domains, digest lengths, drift tolerances.",
    `These constants are pinned by the conformance corpus (\`fingerprint.json\`,
\`fingerprintVersion 1\`) across the worker and all three native SDKs — the hash domains are
frozen FOREVER (rebranding them would orphan every stored fingerprint). Every SDK iterates
\`FINGERPRINT_COMPONENTS\` in this canonical order; a language-native map ordering is a
conformance failure.`,
    [
      table(
        ["Constant", "Value"],
        [
          [
            "`FINGERPRINT_HASH_PREFIX`",
            `\`${grab(/FINGERPRINT_HASH_PREFIX = "([^"]+)"/)}\``,
          ],
          [
            "`FINGERPRINT_ANCHOR`",
            `\`${grab(/FINGERPRINT_ANCHOR[^=]*= *"?([a-zA-Z]+)"?/)}\` (a matching anchor widens a non-zero tolerance by one)`,
          ],
          [
            "`FINGERPRINT_COMPONENT_LENGTH`",
            grab(/FINGERPRINT_COMPONENT_LENGTH = (\d+)/),
          ],
          [
            "`FINGERPRINT_HWID_LENGTH`",
            grab(/FINGERPRINT_HWID_LENGTH = (\d+)/),
          ],
        ],
      ),
      "",
      "## Canonical component order",
      "",
      components.map((c, i) => `${i + 1}. \`${c}\``).join("\n"),
      "",
      "## Drift tolerance per mode",
      "",
      table(["Mode", "Tolerated drift (before the anchor bonus)"], tolerance),
    ].join("\n"),
  );
}

// ── 5. Route & alias table ─────────────────────────────────────────────────────
function routeTable() {
  const spec = parseYaml(
    read("packages", "worker", "openapi", "polaris-key.v3.yaml"),
  );
  const rows = [];
  for (const [path, entry] of Object.entries(spec.paths)) {
    // A path-level `servers` override (the registry host, F-02) is shown as the full URL, so a
    // registry path is never read as a console path.
    const shown = entry.servers?.[0]?.url
      ? `${entry.servers[0].url}${path}`
      : path;
    for (const method of ["get", "head", "post", "put", "patch", "delete"]) {
      const op = entry[method];
      if (!op) continue;
      rows.push([
        method.toUpperCase(),
        `\`${shown}\``,
        op.tags?.[0] ?? "",
        // MDX evaluates {…} in prose as JSX — path templates in plain cells must escape
        // their braces (inside the backticked path cell they are literal already).
        (op.summary ?? "").replace(/([{}])/g, "\\$1"),
      ]);
    }
  }
  rows.sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1]));
  return page(
    "Public route table",
    "Every public wire route by owning service, generated from the OpenAPI spec (which the route-coverage test pins to the router).",
    `The public API, one row per operation. The \`aliases\` rows are the permanent alias
spellings — the four pre-namespace paths and Release's old byte paths (moved to Distribution
in P2b-04) — exact rewrites of their canonical routes, kept forever because they are compiled
into shipped app bundles, built by SDKs and printed in published curl lines. Removed v2 spellings
(\`/activate\`, \`/config\`, \`/auth/*\`, \`/cli/*\`, \`/dmg/*\`, …) 404 outright. The \`registry\`
rows answer only on the registry host, \`pkg.plrs.im\`, and are shown with it.`,
    table(["Method", "Path", "Service", "Summary"], rows),
  );
}

// ── 6. D1 data model ───────────────────────────────────────────────────────────
const TABLE_OWNERS = {
  core: [
    "products",
    "product_keys",
    "product_secrets",
    "outlet_credentials",
    "devices",
    "license_refusals",
    "device_fingerprints",
    "device_facts",
    "audit",
    "product_sync_state",
    "product_manifest_snapshot",
    "product_settings",
    "schema_index_assertion",
    "blob_objects",
    "blob_refs",
    "blob_gc_log",
    "hosted_assets",
    "ci_publishers",
    "ci_tokens",
    "ci_upload_tickets",
    "lazy_delta_settings",
    "delta_demand_devices",
    "delta_demand",
    "platform_deploys",
    "platform_credentials",
    "platform_credential_pins",
    "platform_store_settings",
    "platform_audit",
    "registry_render_queue",
    "registry_tokens",
    "platform_settings",
    "platform_job_runs",
    "platform_heartbeats",
    "store_operations",
    "email_suppressions",
    "email_product_caps",
  ],
  license: [
    "licenses",
    "keys_index",
    "tiers",
    "license_profiles",
    "license_store_grants",
  ],
  config: [
    "product_schema",
    "profiles",
    "edge_mint_config",
    "edge_mint_approvals",
  ],
  release: [
    "release_config",
    "release_metadata",
    "release_artifacts",
    "release_channels",
    "release_channel_floors",
    "release_health",
    "release_download_tokens",
    "release_deliverables",
    "release_builds",
    "release_channel_policy",
    "release_yanks",
    "release_records",
    "release_pins",
    "release_sets",
    "release_set_state",
    "release_holds",
    "release_pack_floors",
    "release_revocations",
    "release_delegations",
    "release_delegated_records",
    "release_lazy_deltas",
    "release_packages",
    "release_native_uploads",
    "release_package_prunes",
    "release_package_retention",
  ],
  distribution: [
    "dist_outlets",
    "dist_listing",
    "dist_transports",
    "dist_rollouts",
    "dist_access",
    "dist_availability",
    "dist_submissions",
    "dist_keys",
    "dist_connector_objects",
    "dist_connector_events",
    "dist_feed_files",
    "dist_connector_settings",
    "dist_readiness",
    "dist_store_products",
    "dist_purchase_bindings",
    "dist_purchase_binding_aliases",
    "dist_purchases",
    "dist_registry_owners",
    "dist_registry_feeds",
    "dist_registry_policy",
    "dist_listings",
    "dist_listing_locales",
    "dist_listing_assets",
    "dist_listing_release_notes",
    "dist_listing_overrides",
    "store_edit_leases",
  ],
  update: ["update_feed_state", "update_feed_ceiling", "update_feed_docs"],
  identity: [
    "oidc_config",
    "provisioning_config",
    // I-05 (plans/I-04.md §6.1): the Polaris Key account. Core reads the subject rows through
    // src/core/accountSubjects.ts only; `licenses.account_id` stays License's column and
    // `devices.subject`/`bound_by` Core's.
    "accounts",
    "account_links",
    "account_product_subjects",
    "account_product_subject_aliases",
    "account_tombstones",
    "subject_events",
    "account_sessions",
    "account_product_grants",
    "account_passkeys",
    // PX-W15: terms accepted at the email gate, per account, product and terms version.
    "account_terms_acceptances",
    // I-12: the developer relink tool's history and 72-hour undo.
    "license_relinks",
    "portal_accounts",
    "portal_account_emails",
    "portal_account_identities",
    "portal_license_links",
    "portal_product_settings",
    "portal_audit",
  ],
};

function dataModel() {
  const migrationsDir = join(repo, "packages", "worker", "migrations");
  const columns = new Map(); // table -> [column names]
  const migrationOf = new Map(); // table -> first migration file
  // Statements are replayed IN ORDER so the page shows the LIVE end-state schema: the
  // audit-era migrations rebuild tables via CREATE _v2 → copy → DROP old → RENAME _v2, and
  // 0016 drops the dead `customers`/`identity` tables outright — intermediates and corpses
  // must not read as live tables.
  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const statements = [
      ...sql.matchAll(
        /CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\n\);|ALTER TABLE (\w+) ADD COLUMN (\w+)|DROP TABLE(?: IF EXISTS)? (\w+)|ALTER TABLE (\w+) RENAME TO (\w+)/g,
      ),
    ];
    for (const m of statements) {
      if (m[1]) {
        const cols = m[2]
          .split("\n")
          .map((line) => line.trim().replace(/,$/, ""))
          .filter(
            (line) =>
              line &&
              !line.startsWith("--") &&
              !/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT)/i.test(line),
          )
          .map((line) => line.split(/\s+/)[0]);
        columns.set(m[1], cols);
        if (!migrationOf.has(m[1])) migrationOf.set(m[1], file);
      } else if (m[3]) {
        if (columns.has(m[3]))
          columns.get(m[3]).push(`${m[4]} (${file.slice(0, 4)})`);
      } else if (m[5]) {
        columns.delete(m[5]);
        migrationOf.delete(m[5]);
      } else if (m[6]) {
        if (columns.has(m[6])) {
          columns.set(m[7], columns.get(m[6]));
          migrationOf.set(
            m[7],
            `${migrationOf.get(m[6]) ?? file} (rebuilt ${file.slice(0, 4)})`,
          );
          columns.delete(m[6]);
          migrationOf.delete(m[6]);
        }
      }
    }
  }
  const sections = [];
  const owned = new Set(Object.values(TABLE_OWNERS).flat());
  for (const [owner, tables] of Object.entries(TABLE_OWNERS)) {
    const rows = tables
      .filter((t) => columns.has(t))
      .map((t) => [
        `\`${t}\``,
        migrationOf.get(t) ?? "",
        columns
          .get(t)
          .map((c) => `\`${c}\``)
          .join(", "),
      ]);
    if (rows.length)
      sections.push(
        `## ${owner}\n\n${table(["Table", "Since", "Columns (ALTERs annotated with their migration)"], rows)}`,
      );
  }
  const orphans = [...columns.keys()].filter((t) => !owned.has(t));
  if (orphans.length)
    sections.push(
      `## Unassigned\n\nTables present in migrations but not in the ownership map (fix TABLE_OWNERS in the generator): ${orphans.map((t) => `\`${t}\``).join(", ")}`,
    );
  return page(
    "D1 data model",
    "Every table with its columns, generated from the migrations, grouped by owning service (logical ownership — no physical separation).",
    `Ownership is LOGICAL (suite spec §5.2): tables live in one database; a service may only
touch another's tables through Core-mediated seams, enforced by the worker's boundary test.
Column lists come straight from \`packages/worker/migrations/\`; a new migration regenerates
this page or fails the freshness gate.`,
    sections.join("\n\n"),
  );
}

// ── 7. Conformance corpus inventory ────────────────────────────────────────────
function corpusInventory() {
  const cases = JSON.parse(read("conformance", "corpus", "v2", "cases.json"));
  const gate = JSON.parse(
    read("conformance", "corpus", "v2", "gate-matrix.json"),
  );
  const fp = JSON.parse(
    read("conformance", "corpus", "v2", "fingerprint.json"),
  );
  const stages = JSON.parse(
    read("conformance", "corpus", "v2", "stage-matrix.json"),
  );
  const families = Object.entries(cases)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => [`\`${k}\``, String(v.length)]);
  const headers = JSON.parse(
    read("conformance", "corpus", "v2", "headers.json"),
  );
  const configMatrix = JSON.parse(
    read("conformance", "corpus", "v2", "config-matrix.json"),
  );
  const updateMatrix = JSON.parse(
    read("conformance", "corpus", "v2", "update-matrix.json"),
  );
  const outletMatrix = JSON.parse(
    read("conformance", "corpus", "v2", "outlet-matrix.json"),
  );
  const planMatrix = JSON.parse(
    read("conformance", "corpus", "v2", "plan-matrix.json"),
  );
  const syncScenarios = JSON.parse(
    read("conformance", "corpus", "v2", "sync-scenarios.json"),
  );
  const deviceLabel = JSON.parse(
    read("conformance", "corpus", "v2", "device-label.json"),
  );
  const content = JSON.parse(
    read("conformance", "corpus", "v2", "content", "cases.json"),
  );
  const contentSections = Object.entries(content)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => [`\`${k}\``, String(v.length)]);
  const blobBytes = Object.values(content.blobs ?? {}).reduce(
    (n, b) => n + b.size,
    0,
  );
  return page(
    "Conformance corpus v2",
    "The case families every SDK verifies identically, generated from the corpus files themselves.",
    `One generator (\`tools/sign-corpus.ts\`) signs every vector, and every language runner
verifies them: Node, Python, Swift, React (the gate matrix, the \`web\` rows of
\`headers.json\` and the no-environment answers of \`config-matrix.json\`), Godot (every
\`cases.json\` family and the \`fingerprint.json\` device ids, from an editor and an exported
release template) and Kotlin (every \`cases.json\` family, \`update-matrix.json\`,
\`plan-matrix.json\`, every \`content/\` section, \`headers.json\`, \`fingerprint.json\`,
\`stage-matrix.json\` and \`outlet-matrix.json\`, read in place on both Ed25519 backends). \`pnpm gen:corpus -- --check\` is the CI drift gate,
over the source and both generator-owned mirrors (the Swift test resources and the Godot
\`res://\` mirror at \`sdks/godot/tests/corpus/v2/\`). Corpus v1 is deleted — v2 is the
only corpus. \`corpusVersion ${cases.corpusVersion}\`,
\`gateMatrixVersion ${gate.gateMatrixVersion}\`, \`fingerprintVersion ${fp.fingerprintVersion}\`,
\`stageMatrixVersion ${stages.stageMatrixVersion}\`, \`headersVersion ${headers.headersVersion}\`,
\`configMatrixVersion ${configMatrix.configMatrixVersion}\`,
\`updateMatrixVersion ${updateMatrix.updateMatrixVersion}\`, \`outletMatrixVersion ${outletMatrix.outletMatrixVersion}\`,
\`planMatrixVersion ${planMatrix.planMatrixVersion}\`, \`deviceLabelVersion ${deviceLabel.deviceLabelVersion}\`,
\`contentCorpusVersion ${content.contentCorpusVersion}\`, \`syncScenariosVersion ${syncScenarios.syncScenariosVersion}\`.
Wire contract v4 (\`docs/security/WIRE-CONTRACT-V4.md\`) adds the \`feedCases\` and
\`releaseRecordCases\` families, the strict-verifier \`jwsCases\`, a \`nonWireIntegers\` member
beside \`expect\` on every case whose payload holds a number that cannot be a wire integer, and the
two decision tables below. Packs v1 (\`plans/P4-01.md\` §4.6) adds \`packRecordCases\` (\`kind: pack\`
records and an app record's \`content\` and \`builds[].embeds\`, whose object refs are the content
corpus's own) and \`markerCases\` (embedded-pack markers), two JWS families that the record
runners of SDKs predating packs never read, and the content corpus and \`plan-matrix.json\` below.`,
    [
      "## Case families (`cases.json`)",
      "",
      table(["Family", "Cases"], families),
      "",
      `## Gate matrix (\`gate-matrix.json\`): ${gate.rows?.length ?? gate.cases?.length ?? "?"} rows`,
      "",
      `## Fingerprint corpus (\`fingerprint.json\`): ${fp.vectors?.length ?? "?"} vectors, ${fp.deviceIds?.length ?? "?"} device-id derivations, component order ${fp.componentOrder?.map((c) => `\`${c}\``).join(" → ")}`,
      "",
      `Source-rule sections (WIRE-CONTRACT-V3 §6.1): \`windowsCim\` ${fp.windowsCim?.length ?? "?"}, \`linuxAnchor\` ${fp.linuxAnchor?.length ?? "?"}, \`ramBuckets\` ${fp.ramBuckets?.length ?? "?"}, plus the pinned \`windowsCimCommand\`.`,
      "",
      `## Stage matrix (\`stage-matrix.json\`): ${stages.rows?.length ?? "?"} rows, ${stages.guardCases?.length ?? "?"} guard cases, ${stages.confirmCases?.length ?? 0} confirm cases`,
      "",
      "Client boot behaviour, not a wire-contract section: the boot stage machine of `@polaris-key/client-core/stages`. Every runner replays each row and sends every probe at every state the rows reach. Version 2's confirm cases pin `bootConfirmation(outcome)`, with `bootOkSeconds` " +
        `${stages.bootOkSeconds ?? "?"}. Version 3 (WIRE-CONTRACT-V4 §11.3) adds the pack rows: \`essentialPacks\`, download consent and progress, a declined download as \`blocked\`, and a playable \`offline\` stop.`,
      "",
      `## Header values (\`headers.json\`): ${headers.platformCases?.length ?? "?"} platform and ${headers.archCases?.length ?? "?"} arch spellings`,
      "",
      "WIRE-CONTRACT-V3 §5.2: each runtime spelling and its canonical `X-PKey-Platform` or `X-PKey-Arch` value, or none. Every SDK and the Worker run both sections.",
      "",
      `## Config resolution (\`config-matrix.json\`): ${configMatrix.resolveCases?.length ?? "?"} resolve, ${configMatrix.envValueCases?.length ?? "?"} environment-value and ${configMatrix.listCases?.length ?? "?"} list cases`,
      "",
      "WIRE-CONTRACT-V3 §2.2.1: the precedence, the variable name, the strict environment value and the user-visible list. React runs the no-environment answers.",
      "",
      `## Update decision (\`update-matrix.json\`): ${updateMatrix.versionCases?.length ?? "?"} version, ${updateMatrix.capabilityCases?.length ?? "?"} capability and ${updateMatrix.outletCases?.length ?? "?"} outlet cases, ${updateMatrix.bucketVectors?.length ?? "?"} bucket vectors, ${updateMatrix.rows?.length ?? "?"} decision rows`,
      "",
      "WIRE-CONTRACT-V4 §11.1, client behaviour beside the contract: `compareVersions`, `effectiveCapabilities`, `resolveUpdateOutlet`, `rolloutBucket` and `decideUpdate` with its `bootDecision`. The generator recomputes every case and row with its own reference implementation.",
      "",
      `## Outlets (\`outlet-matrix.json\`): ${Object.keys(outletMatrix.kinds ?? {}).length} kinds (with \`unknown\`), ${outletMatrix.signals?.length ?? "?"} signals, ${outletMatrix.rows?.length ?? "?"} detection rows`,
      "",
      "WIRE-CONTRACT-V4 §11.2: the capability defaults per outlet kind and their narrowing, the listing-URL prefixes, and `detectOutlet`. The generator recomputes every detection row.",
      "",
      `## Install planner (\`plan-matrix.json\`): ${planMatrix.rows?.length ?? "?"} planner rows, ${planMatrix.variantCases?.length ?? "?"} variant and ${planMatrix.targetCases?.length ?? "?"} target cases`,
      "",
      `WIRE-CONTRACT-V4 §11.4: \`plan\` (request weight ${planMatrix.requestWeight ?? "?"}), \`selectVariant\` and \`planTarget\`. Chunk targets are inline, so the planner never parses an index; the \`plan-real-*\` rows are the content set's own menu. The generator recomputes every row and case.`,
      "",
      `## Cloud Sync scenarios (\`sync-scenarios.json\`): ${syncScenarios.scenarios?.length ?? "?"} scenarios over ${syncScenarios.rules?.length ?? "?"} rules`,
      "",
      "WIRE-CONTRACT-V4 §11.5, client behaviour beside the contract: the journal, the debounce, the HLC and pre-contact re-stamping, conflict rebase, one outstanding compare-and-swap per record, the per-subject partitions, the first-sign-in move, sign-out with pending operations, principal changes, `account_required` and a `/sync` 401, each scenario a run of SDK calls, clock moves and scripted server answers. Literal data (`tools/sync-scenarios.ts`), not computed by an implementation; `@polaris-key/client-core/cloud-sync` is checked against it like every SDK, by the Node runner `conformance/runners/node/syncScenarios.test.ts`.",
      "",
      `## Device labels (\`device-label.json\`): ${deviceLabel.cases?.length ?? "?"} cases`,
      "",
      "WIRE-CONTRACT-V4 §12.7.1 (PX-W13): the one normalisation of the device label every SDK sends as `deviceName` and the Worker stores. Every SDK runs every row, and the Worker runs them through `/identity/auth/device/start`. Non-ASCII code points are written escaped.",
      "",
      `## Content corpus (\`content/cases.json\`): ${Object.keys(content.blobs ?? {}).length} blobs, ${blobBytes.toLocaleString("en-US")} bytes`,
      "",
      "WIRE-CONTRACT-V4 §2.6: the files index and its path rules, the binary chunk index (`pkey-chunks/1`, `chunkIndexCases`, P4-10), full, `payload`-delta, `file` and `chunk` apply over a real v1 → v2 pair with negatives and counters, `packSetId`, the content stamp and `frameWindow`. `tools/gen-content-corpus.ts` (called by `pnpm gen:corpus`) rebuilds `cases.json` from the committed blobs, which are inputs hash-checked against its `blobs` table and written only by `--rebuild-content-blobs` (zstd 1.5.7), which may only add blobs (`plans/P4-10.md` decision 15). `content/` is source-only and not mirrored: Node and the browser runners read it today, and the Swift and Godot content runners (P4-07, P4-08) read it from the checkout.",
      "",
      table(["Section", "Cases"], contentSections),
    ].join("\n"),
  );
}

// ── 8. SDK parity matrix ───────────────────────────────────────────────────────
// Reads the feature registry and every SDK's parity manifest directly (this file stays
// dependency-free, so it does not import tools/parity-check.ts, which is what GATES them).
// MDX would read `<p>` in a note as JSX, so prose escapes angle brackets as well as braces.
// mdxProse already escapes `<`; escaping it again here wrote `\\<`, a literal backslash then a bare `<`.
const mdxText = (s) => mdxProse(s).replace(/>/g, "\\>");

function parityMatrix() {
  const registry = JSON.parse(read("conformance", "parity", "features.json"));
  const sdks = registry.sdks.map((sdk) => ({
    ...sdk,
    manifest: JSON.parse(read(...sdk.manifest.split("/"))),
  }));

  // A transcript proof EXISTS once some committed transcript (conformance/transcripts/, written
  // by `pnpm gen:transcripts`) lists the feature; until then it shows its owner, or "not
  // recorded" when it has none.
  const transcriptsDir = join(repo, "conformance", "transcripts");
  const recorded = new Set(
    existsSync(transcriptsDir)
      ? readdirSync(transcriptsDir)
          .filter((f) => f.endsWith(".json"))
          .flatMap(
            (f) => JSON.parse(read("conformance", "transcripts", f)).features,
          )
      : [],
  );

  const runtimeList = (runtime) =>
    (Array.isArray(runtime) ? runtime : [runtime]).join(", ");
  const exceptText = (except) =>
    (except ?? []).map((ex) => `; N/A (${ex.runtime}: ${ex.reason})`).join("");
  const cell = (entry) => {
    if (!entry) return "—";
    if (entry.status === "implemented") return `✓${exceptText(entry.except)}`;
    if (entry.status === "na")
      return `N/A (${runtimeList(entry.runtime)}: ${entry.reason})`;
    const owner = entry.wp ?? "unowned";
    return `planned (${owner})${exceptText(entry.except)}`;
  };
  // A corpus proof EXISTS once its file (and, for a family proof, its family) is in
  // conformance/corpus/v2/; until then it shows the work package that adds it. Once it exists the
  // `wp` is provenance only, as `pnpm parity:check` treats it.
  const corpusProofExists = (p) => {
    const file = join(repo, "conformance", "corpus", "v2", p.file);
    if (!existsSync(file)) return false;
    if (!p.family) return true;
    try {
      return p.family in JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  };
  const proofText = (id, proof) =>
    proof
      .map((p) => {
        const owner = p.wp ? ` (${p.wp})` : "";
        if (p.kind === "corpus")
          return `\`${p.file}\`${p.family ? ` \`${p.family}\`` : ""}${corpusProofExists(p) ? "" : owner}`;
        if (p.kind === "generated") return `\`${p.command}\`${owner}`;
        if (p.kind === "transcript")
          return recorded.has(id)
            ? "transcripts"
            : `transcripts${owner || " (not recorded)"}`;
        if (p.kind === "device") return "device tests";
        if (p.kind === "snapshot") return "snapshot tests";
        return p.kind;
      })
      .join(" + ");
  const allowedText = (allowedNa) => {
    if (!allowedNa.length) return "—";
    const byReason = new Map();
    for (const na of allowedNa) {
      if (!byReason.has(na.reason)) byReason.set(na.reason, []);
      byReason.get(na.reason).push(na.runtime === "*" ? "any" : na.runtime);
    }
    return [...byReason]
      .map(([reason, runtimes]) => `${runtimes.join(", ")}: ${reason}`)
      .join("; ");
  };

  const sections = [];
  for (const family of registry.families) {
    const rows = registry.features
      .filter((f) => f.family === family.id)
      .map((f) => [
        `\`${f.id}\``,
        mdxText(f.title),
        proofText(f.id, f.proof),
        ...sdks.map((sdk) => cell(sdk.manifest.features[f.id])),
        allowedText(f.allowedNa),
      ]);
    sections.push(
      `## ${family.title}\n\n${table(
        [
          "Id",
          "Capability",
          "Proven by",
          ...sdks.map((sdk) => sdk.title),
          "Allowed N/A",
        ],
        rows,
      )}`,
    );
  }

  const counts = sdks.map((sdk) => {
    const entries = Object.values(sdk.manifest.features);
    const n = (status, extra = () => true) =>
      String(entries.filter((e) => e.status === status && extra(e)).length);
    return [
      sdk.title,
      `\`${sdk.manifest.runtimes.join("`, `")}\``,
      n("implemented"),
      n("na"),
      n("planned", (e) => Boolean(e.wp)),
      n("planned", (e) => Boolean(e.unowned)),
    ];
  });

  const unowned = [];
  for (const sdk of sdks)
    for (const f of registry.features) {
      const entry = sdk.manifest.features[f.id];
      if (entry?.status === "planned" && entry.unowned)
        unowned.push([sdk.title, `\`${f.id}\``, mdxText(entry.note ?? "")]);
    }

  const manifestPaths = registry.sdks
    .map((sdk) => `\`${sdk.manifest}\``)
    .join(", ");

  return page(
    "SDK parity matrix",
    "Every feature in the registry against every SDK's parity manifest: implemented, a typed N/A the registry allows, or planned in a named work package.",
    `One row per feature id in \`conformance/parity/features.json\`, one column per SDK manifest
(${manifestPaths}). \`pnpm parity:check\` gates the manifests: an implemented entry
needs a test tagged \`@pkey-feature <id>\`, an N/A must be one the registry allows for that
runtime, and a planned entry names an open work package or is marked unowned. A new feature
starts with its registry entry; a new SDK starts with a manifest in which everything is planned.

Cells: **✓** implemented; **N/A (runtime: reason)** a typed "unsupported here" result;
**planned (P1b-07)** the work package that closes the gap; **planned (unowned)** a gap with no
owner yet (listed below). A proof marked with a work package does not exist yet; "transcripts
(not recorded)" is a transcript proof no work package has taken on.`,
    [
      table(
        [
          "SDK",
          "Runtimes",
          "Implemented",
          "N/A",
          "Planned (owned)",
          "Planned (unowned)",
        ],
        counts,
      ),
      "",
      sections.join("\n\n"),
      "",
      "## Unowned gaps",
      "",
      unowned.length
        ? `Planned entries no work package owns yet. Each needs an owner before the gap can close.\n\n${table(["SDK", "Feature", "Note"], unowned)}`
        : "None.",
    ].join("\n"),
  );
}

// ── driver ─────────────────────────────────────────────────────────────────────
export const EMITTERS = {
  "validation-codes.mdx": manifestValidationCodes,
  "config-entry.mdx": configEntryReference,
  "error-codes.mdx": errorCodes,
  "fingerprint-constants.mdx": fingerprintConstants,
  "routes.mdx": routeTable,
  "data-model.mdx": dataModel,
  "corpus.mdx": corpusInventory,
  "parity.mdx": parityMatrix,
};

const check = process.argv.includes("--check");
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  mkdirSync(outDir, { recursive: true });
  let stale = 0;
  for (const [file, emit] of Object.entries(EMITTERS)) {
    const target = join(outDir, file);
    const next = emit();
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (check) {
      if (current !== next) {
        console.error(`stale: src/content/docs/reference/${file}`);
        stale += 1;
      }
    } else if (current !== next) {
      writeFileSync(target, next);
      console.log(`wrote reference/${file}`);
    }
  }
  if (check && stale) process.exit(1);
  if (check) console.log("gen-reference: all pages current");
}
