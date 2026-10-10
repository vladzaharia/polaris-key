/**
 * Who can reach an outlet credential (P5-01).
 *
 * `core/outletCredentials.ts` is the one accessor for `outlet_credentials`, and it is Core so
 * that the Distribution service may import it — which means `boundaries.test.ts` would let EVERY
 * service import it too. This suite narrows that for this one module, in five directions:
 *
 *   1. **Importers.** Only the Distribution service (`src/services/distribution/**`), the token
 *      helpers (`src/core/outletTokens.ts`) and the Core admin handler
 *      (`src/console/handlers/outletCredentials.ts`) may import `core/outletCredentials`. Config —
 *      edge-mint's home — may not, nor may `core/products.ts`, home of `openProductSecret`.
 *   2. **The table name.** No file outside the owner, the KEK re-seal sweep
 *      (`src/console/handlers/products.ts`, `SEALED_TABLES`) and `deleteProduct`
 *      (`src/core/console/repo.ts`) names `outlet_credentials` — so no manifest ingest, resync or
 *      service hook can write it, and nothing can read the sealed column around the audited
 *      accessor.
 *   3. **The AAD kind.** No file outside the vault, the owner, the token helpers and the sweep
 *      spells the `"outlet-credential"` seal kind — so no other code can open a value with
 *      `keyvault.open` directly.
 *   4. **The writers.** No file outside the owner and the Core admin handler names
 *      `putOutletCredential`, `pinOutletCredential` or `deleteOutletCredential` — so although the
 *      Distribution service may import the module (to open, and to CHECK a pin), no connector,
 *      webhook handler or public route in it can write, re-pin or delete a credential. "Written
 *      only by a platform admin" is enforced here, and so is "the pin is the operator's" (P5-02f).
 *   5. **The token helpers.** `core/outletTokens.ts` hands out a cached store bearer token on a
 *      cache hit WITHOUT an audited open, so it is a custody boundary of its own: only the
 *      Distribution service (`src/services/distribution/**`) and Core's device attestation
 *      (`src/core/trust/attestation.ts`, P6-02) may import it.
 *
 * A-16 adds the platform's TEAM-level store credentials (`core/platformCredentials.ts`, tables
 * `platform_credentials` and `platform_credential_pins`, seal kind `"platform-credential"`) and
 * guards them the same way, in five more directions:
 *
 *   6. **Importers.** Only the Distribution service, the token helpers and the two Core admin
 *      handlers that write or check pins (`platformStoreConnections.ts`, `outletCredentials.ts`)
 *      may import `core/platformCredentials`. It imports `core/outletCredentials` itself (reviewed:
 *      it reuses the kinds' validators and pin specs, and neither writes nor opens a product
 *      credential), and so does the store-connections handler (to read who holds an app).
 *   7. **The tables.** Only the owner, the KEK re-seal sweep and `deleteProduct` name them.
 *   8. **The AAD kind.** Only the vault, the owner and the sweep spell `"platform-credential"`.
 *   9. **The writers.** Only the owner and the store-connections handler name
 *      `putPlatformCredential`, `deletePlatformCredential`, `setPlatformPin` or `clearPlatformPin`.
 *  10. **The opener.** Only the owner, the token helpers and two reviewed Distribution files (the
 *      Microsoft Store token, the Steam commerce key) name `openPlatformCredential`; every other
 *      path gets a token, minted after the product's pin is checked — and the open itself refuses
 *      a product whose pin does not match.
 *
 * UX-69 adds the TRANSIENT path (`TransientOutletCredential`: an unsaved value held for one
 * request, for the live check a connect form runs on paste) and guards it in one more direction:
 *
 *  11. **The transient path.** Only the owner and the store-connections handler name
 *      `transientOutletCredential` (the one place an unsaved value becomes a credential); only the
 *      owner, the token helpers and the Distribution service call `.reveal()` (the checks that send
 *      it to its store); and the `transient…Token` minters are named only there too. Nothing on the
 *      path seals, caches or writes: `credentialCheck.test.ts` proves no row, no KV key and no
 *      audit row survives a check, and that the value never appears in a response or a log.
 *
 * Adding an entry to any allowlist is a custody decision: it needs a review that says why, and
 * the threat model's review trigger (§9) applies. P6-02 added one reviewed entry: see
 * `TOKENS_IMPORT_ALLOW_FILES`.
 *
 * Like `boundaries.test.ts`, this is a regex over source and errs toward false positives: a
 * match inside a string or comment fails the test rather than slipping through.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..");
const SRC = join(WORKER_ROOT, "src");

const TARGET = "src/core/outletCredentials";
const TOKENS_TARGET = "src/core/outletTokens";

const IMPORT_ALLOW_PREFIXES = ["src/services/distribution/"];
const IMPORT_ALLOW_FILES = [
  "src/core/outletTokens.ts",
  "src/console/handlers/outletCredentials.ts",
  // A-16 (reviewed): validators and pin specs only; neither file writes or opens a product key.
  "src/core/platformCredentials.ts",
  "src/console/handlers/platformStoreConnections.ts",
];
const TABLE_ALLOW_FILES = [
  "src/core/outletCredentials.ts",
  "src/console/handlers/products.ts",
  "src/core/console/repo.ts",
];
const WRITER_ALLOW_FILES = [
  "src/core/outletCredentials.ts",
  "src/console/handlers/outletCredentials.ts",
];
const TOKENS_IMPORT_ALLOW_PREFIXES = ["src/services/distribution/"];
/**
 * P6-02 (reviewed): Core's attest route decodes a device's Play Integrity token with Google's
 * `decodeIntegrityToken`, which needs an OAuth token for the product's `google-service-account`
 * credential at the Play Integrity scope. It calls `googleAccessToken` ONLY — never
 * `openOutletCredential` (it is not in `IMPORT_ALLOW_FILES`), so it never sees the key — and only
 * for the credential Distribution's own pin check chose (`Delivery.attestationTargets`). The
 * attest route is device-authenticated and rate-limited per device BEFORE the token is asked for,
 * so an unauthenticated caller cannot make it open (and audit) the credential.
 */
const TOKENS_IMPORT_ALLOW_FILES = ["src/core/trust/attestation.ts"];
const KIND_ALLOW_FILES = [
  "src/platform/keyvault.ts",
  "src/core/outletCredentials.ts",
  "src/core/outletTokens.ts",
  "src/console/handlers/products.ts",
];

// ── A-16: the platform's team-level store credentials ─────────────────────────────────────────
const PLATFORM_TARGET = "src/core/platformCredentials";
const PLATFORM_IMPORT_ALLOW_PREFIXES = ["src/services/distribution/"];
const PLATFORM_IMPORT_ALLOW_FILES = [
  "src/core/outletTokens.ts",
  "src/console/handlers/platformStoreConnections.ts",
  "src/console/handlers/outletCredentials.ts",
];
const PLATFORM_TABLE_ALLOW_FILES = [
  "src/core/platformCredentials.ts",
  "src/console/handlers/products.ts",
  "src/core/console/repo.ts",
];
const PLATFORM_KIND_ALLOW_FILES = [
  "src/platform/keyvault.ts",
  "src/core/platformCredentials.ts",
  "src/console/handlers/products.ts",
];
const PLATFORM_WRITER_ALLOW_FILES = [
  "src/core/platformCredentials.ts",
  "src/console/handlers/platformStoreConnections.ts",
];
/** Where a TEAM-WIDE purpose (`{ team: actor }`, no product, no pin) may be built: the platform
 *  apps listers only. Everywhere else a platform credential is used for a product and its pin. */
const PLATFORM_TEAM_PURPOSE_ALLOW_FILES = [
  "src/core/platformCredentials.ts", // the type itself
  "src/services/distribution/connectors/asc/platform.ts",
  "src/services/distribution/connectors/play/platform.ts",
  "src/services/distribution/connectors/msstore/platform.ts",
  "src/services/distribution/commerce/steam.ts", // inside fetchSteamApps only (checked below)
];
const PLATFORM_OPENER_ALLOW_FILES = [
  "src/core/platformCredentials.ts",
  "src/core/outletTokens.ts",
  // Reviewed (A-16): the Entra exchange lives beside P5-04's own token code; it checks the
  // product's pin before its cache, and the open checks it again.
  "src/services/distribution/connectors/msstore/token.ts",
  // Reviewed (A-16): Steam uses the raw key per call (no token); the open checks the pin.
  "src/services/distribution/commerce/steam.ts",
];

// ── UX-69: the transient path ─────────────────────────────────────────────────────────────────
const TRANSIENT_MAKER_ALLOW_FILES = [
  "src/core/outletCredentials.ts",
  "src/console/handlers/platformStoreConnections.ts",
];
const REVEAL_ALLOW_PREFIXES = ["src/services/distribution/"];
const REVEAL_ALLOW_FILES = [
  "src/core/outletCredentials.ts",
  "src/core/outletTokens.ts",
];

interface Source {
  /** Worker-relative POSIX path, e.g. `src/core/outletTokens.ts`. */
  file: string;
  text: string;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function loadSources(): Source[] {
  return walkTs(SRC).map((full) => ({
    file: relative(WORKER_ROOT, full).split(sep).join("/"),
    text: readFileSync(full, "utf8"),
  }));
}

const SPECIFIER_RE =
  /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Every relative specifier of `src`, resolved to a worker-relative path without extension. */
function resolvedImports(src: Source): string[] {
  const out: string[] = [];
  for (const m of src.text.matchAll(SPECIFIER_RE)) {
    const spec = m[1] ?? m[2];
    if (!spec || !spec.startsWith(".")) continue;
    out.push(
      posix
        .normalize(posix.join(posix.dirname(src.file), spec))
        .replace(/\.(js|ts)$/, ""),
    );
  }
  return out;
}

/** Source with comments removed, so a doc comment that mentions the table is not a match. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function reachViolations(sources: Source[]): string[] {
  const out: string[] = [];
  for (const src of sources) {
    const importOk =
      IMPORT_ALLOW_FILES.includes(src.file) ||
      IMPORT_ALLOW_PREFIXES.some((p) => src.file.startsWith(p)) ||
      src.file === `${TARGET}.ts`;
    if (!importOk && resolvedImports(src).includes(TARGET))
      out.push(`${src.file} imports core/outletCredentials`);
    const body = code(src.text);
    if (
      !TABLE_ALLOW_FILES.includes(src.file) &&
      /\boutlet_credentials\b/.test(body)
    )
      out.push(`${src.file} names the outlet_credentials table`);
    if (
      !KIND_ALLOW_FILES.includes(src.file) &&
      /["'`]outlet-credential["'`]/.test(body)
    )
      out.push(`${src.file} spells the "outlet-credential" seal kind`);
    if (
      !WRITER_ALLOW_FILES.includes(src.file) &&
      /\b(?:putOutletCredential|pinOutletCredential|deleteOutletCredential|planOutletCredentialRepin)\b/.test(
        body,
      )
    )
      out.push(`${src.file} names an outlet-credential writer`);
    const tokensOk =
      TOKENS_IMPORT_ALLOW_PREFIXES.some((p) => src.file.startsWith(p)) ||
      TOKENS_IMPORT_ALLOW_FILES.includes(src.file) ||
      src.file === `${TOKENS_TARGET}.ts`;
    if (!tokensOk && resolvedImports(src).includes(TOKENS_TARGET))
      out.push(`${src.file} imports core/outletTokens`);

    const platformImportOk =
      PLATFORM_IMPORT_ALLOW_FILES.includes(src.file) ||
      PLATFORM_IMPORT_ALLOW_PREFIXES.some((p) => src.file.startsWith(p)) ||
      src.file === `${PLATFORM_TARGET}.ts`;
    if (!platformImportOk && resolvedImports(src).includes(PLATFORM_TARGET))
      out.push(`${src.file} imports core/platformCredentials`);
    if (
      !PLATFORM_TABLE_ALLOW_FILES.includes(src.file) &&
      /\bplatform_credential(?:s|_pins)\b/.test(body)
    )
      out.push(`${src.file} names a platform credential table`);
    if (
      !PLATFORM_KIND_ALLOW_FILES.includes(src.file) &&
      /["'`]platform-credential["'`]/.test(body)
    )
      out.push(`${src.file} spells the "platform-credential" seal kind`);
    if (
      !PLATFORM_WRITER_ALLOW_FILES.includes(src.file) &&
      /\b(?:putPlatformCredential|deletePlatformCredential|setPlatformPin|clearPlatformPin|platformPinWrites)\b/.test(
        body,
      )
    )
      out.push(`${src.file} names a platform-credential writer`);
    if (
      !PLATFORM_OPENER_ALLOW_FILES.includes(src.file) &&
      /\bopenPlatformCredential\b/.test(body)
    )
      out.push(`${src.file} names the platform-credential opener`);
    if (
      !TRANSIENT_MAKER_ALLOW_FILES.includes(src.file) &&
      /\btransientOutletCredential\b/.test(body)
    )
      out.push(`${src.file} makes a transient credential`);
    const revealOk =
      REVEAL_ALLOW_FILES.includes(src.file) ||
      REVEAL_ALLOW_PREFIXES.some((p) => src.file.startsWith(p));
    if (
      !revealOk &&
      /\.reveal\s*\(|\btransient(?:Asc|Google|MsStore)\w*Token\b/.test(body)
    )
      out.push(`${src.file} reveals a transient credential`);
    const team = /\{\s*team\s*:/;
    if (
      !PLATFORM_TEAM_PURPOSE_ALLOW_FILES.includes(src.file) &&
      team.test(body)
    )
      out.push(`${src.file} builds a team-wide platform purpose`);
    if (src.file === "src/services/distribution/commerce/steam.ts") {
      const start = body.indexOf("async function fetchSteamApps(");
      const end = start < 0 ? -1 : body.indexOf("\n}\n", start);
      const outside =
        start < 0 ? body : body.slice(0, start) + body.slice(end + 3);
      if (team.test(outside))
        out.push(
          `${src.file} builds a team-wide platform purpose outside fetchSteamApps`,
        );
    }
  }
  return out;
}

describe("outlet-credential reach", () => {
  it("only the allowlisted files import core/outletCredentials or core/outletTokens, name its table, its writers or its AAD kind", () => {
    expect(reachViolations(loadSources())).toEqual([]);
  });

  it("every allowlisted file exists (a stale allowlist would widen silently on a re-add)", () => {
    for (const f of [
      ...IMPORT_ALLOW_FILES,
      ...TABLE_ALLOW_FILES,
      ...KIND_ALLOW_FILES,
      ...WRITER_ALLOW_FILES,
      ...PLATFORM_IMPORT_ALLOW_FILES,
      ...PLATFORM_TABLE_ALLOW_FILES,
      ...PLATFORM_KIND_ALLOW_FILES,
      ...PLATFORM_WRITER_ALLOW_FILES,
      ...PLATFORM_OPENER_ALLOW_FILES,
      ...TOKENS_IMPORT_ALLOW_FILES,
      ...TRANSIENT_MAKER_ALLOW_FILES,
      ...REVEAL_ALLOW_FILES,
    ])
      expect(existsSync(join(WORKER_ROOT, f)), f).toBe(true);
  });

  it("the guard actually fires: Config (edge-mint) importing the accessor fails", () => {
    const mint: Source = {
      file: "src/services/config/mint.ts",
      text: 'import { openOutletCredential } from "../../core/outletCredentials.js";\n',
    };
    expect(reachViolations([mint])).toEqual([
      "src/services/config/mint.ts imports core/outletCredentials",
    ]);
    // …and so does a dynamic import, a type-only import, and Core's own product-secret module.
    expect(
      reachViolations([
        {
          file: "src/services/config/routes.ts",
          text: 'const m = await import("../../core/outletCredentials.js");',
        },
        {
          file: "src/core/products.ts",
          text: 'import type { OpenedOutletCredential } from "./outletCredentials.js";',
        },
      ]),
    ).toHaveLength(2);
  });

  it("the P6-02 entry is narrow: the attestation module may take a token but not open a credential, and its neighbours may do neither", () => {
    expect(
      reachViolations([
        {
          file: "src/core/trust/attestation.ts",
          text: 'import { openOutletCredential } from "../outletCredentials.js";\n',
        },
        {
          file: "src/core/trust/deviceTrust.ts",
          text: 'import { googleAccessToken } from "../outletTokens.js";\n',
        },
        {
          file: "src/services/config/mint.ts",
          text: 'import { googleAccessToken } from "../../core/outletTokens.js";\n',
        },
      ]),
    ).toEqual([
      "src/core/trust/attestation.ts imports core/outletCredentials",
      "src/core/trust/deviceTrust.ts imports core/outletTokens",
      "src/services/config/mint.ts imports core/outletTokens",
    ]);
  });

  it("the guard fires on a manifest path naming the table or opening with the AAD kind", () => {
    expect(
      reachViolations([
        {
          file: "src/services/release/sync.ts",
          text: 'await db.run("INSERT INTO outlet_credentials (product) VALUES (?)", slug);',
        },
        {
          file: "src/core/ingest.ts",
          text: 'await open(env, blob, { product, kind: "outlet-credential", id });',
        },
      ]),
    ).toEqual([
      "src/services/release/sync.ts names the outlet_credentials table",
      'src/core/ingest.ts spells the "outlet-credential" seal kind',
    ]);
  });

  it("the guard fires on a Distribution connector that writes or deletes a credential", () => {
    expect(
      reachViolations([
        {
          file: "src/services/distribution/connectors/x.ts",
          text: 'import { putOutletCredential } from "../../../core/outletCredentials.js";\nawait putOutletCredential(env, db, input);',
        },
        {
          file: "src/services/distribution/routes.ts",
          text: 'import * as oc from "../../core/outletCredentials.js";\nawait oc.deleteOutletCredential(db, p, id);',
        },
        {
          file: "src/services/distribution/connectors/asc/setup.ts",
          text: 'import { pinOutletCredential } from "../../../../core/outletCredentials.js";\nawait pinOutletCredential(db, { product, credentialId, kind, pin: appleId });',
        },
      ]),
    ).toEqual([
      "src/services/distribution/connectors/x.ts names an outlet-credential writer",
      "src/services/distribution/routes.ts names an outlet-credential writer",
      "src/services/distribution/connectors/asc/setup.ts names an outlet-credential writer",
    ]);
  });

  it("the guard fires on anything outside Distribution importing core/outletTokens", () => {
    expect(
      reachViolations([
        {
          file: "src/services/config/mint.ts",
          text: 'import { googleAccessToken } from "../../core/outletTokens.js";',
        },
        {
          file: "src/console/handlers/outletCredentials.ts",
          text: 'import { ascToken } from "../../core/outletTokens.js";',
        },
        {
          file: "src/services/distribution/connectors/play.ts",
          text: 'import { googleAccessToken } from "../../../core/outletTokens.js";',
        },
      ]),
    ).toEqual([
      "src/services/config/mint.ts imports core/outletTokens",
      "src/console/handlers/outletCredentials.ts imports core/outletTokens",
    ]);
  });

  it("the distribution service is allowed (it is the one consumer)", () => {
    expect(
      reachViolations([
        {
          file: "src/services/distribution/connectors/asc.ts",
          text: 'import { openOutletCredential } from "../../../core/outletCredentials.js";',
        },
      ]),
    ).toEqual([]);
  });

  it("A-16: the guard fires on the platform credentials' tables, kind, writers, opener and importers", () => {
    expect(
      reachViolations([
        {
          file: "src/services/config/mint.ts",
          text: 'import { resolvePlatformCredential } from "../../core/platformCredentials.js";',
        },
        {
          file: "src/services/release/sync.ts",
          text: 'await db.run("UPDATE platform_credential_pins SET pin = ?", x);',
        },
        {
          file: "src/core/ingest.ts",
          text: 'await open(env, blob, { product: "_platform", kind: "platform-credential", id });',
        },
        {
          file: "src/services/distribution/connectors/asc/setup.ts",
          text: 'import { setPlatformPin } from "../../../../core/platformCredentials.js";\nawait setPlatformPin(db, input);',
        },
        {
          file: "src/services/distribution/commerce/apple.ts",
          text: 'import { openPlatformCredential } from "../../../core/platformCredentials.js";\nawait openPlatformCredential(env, db, id, use, p, now);',
        },
      ]),
    ).toEqual([
      "src/services/config/mint.ts imports core/platformCredentials",
      "src/services/release/sync.ts names a platform credential table",
      'src/core/ingest.ts spells the "platform-credential" seal kind',
      "src/services/distribution/connectors/asc/setup.ts names a platform-credential writer",
      "src/services/distribution/commerce/apple.ts names the platform-credential opener",
    ]);
  });

  it("A-16: a team-wide purpose is built only by the apps listers", () => {
    expect(
      reachViolations([
        {
          file: "src/services/distribution/connectors/play/run.ts",
          text: "platformGoogleAccessToken(env, db, { team: actor }, scopes, use, now);",
        },
        {
          file: "src/services/distribution/commerce/steam.ts",
          text: "async function publisherKey() {\n  return open({ team: x });\n}\nasync function fetchSteamApps(o) {\n  return open({ team: o.actor });\n}\n",
        },
      ]),
    ).toEqual([
      "src/services/distribution/connectors/play/run.ts builds a team-wide platform purpose",
      "src/services/distribution/commerce/steam.ts builds a team-wide platform purpose outside fetchSteamApps",
    ]);
  });

  it("UX-69: the transient path is made by the store-connections handler and revealed only by Distribution and the token helpers", () => {
    expect(
      reachViolations([
        {
          file: "src/console/handlers/outletCredentials.ts",
          text: 'const t = await transientOutletCredential("asc-api-key", raw);',
        },
        {
          file: "src/console/handlers/platformStoreConnections.ts",
          text: "const key = t.credential.reveal().p8;",
        },
        {
          file: "src/core/trust/attestation.ts",
          text: "await transientGoogleAccessToken(cred, scopes, now);",
        },
        {
          file: "src/services/distribution/connectors/asc/platform.ts",
          text: "const { p8 } = o.cred.reveal();",
        },
      ]),
    ).toEqual([
      "src/console/handlers/outletCredentials.ts makes a transient credential",
      "src/console/handlers/platformStoreConnections.ts reveals a transient credential",
      "src/core/trust/attestation.ts reveals a transient credential",
    ]);
  });
});
