// Generate the cross-language conformance corpus. ONE signer produces the canonical signed
// vectors; every SDK's runner (Node, Python, Swift, React, Godot) verifies the SAME files,
// proving byte-identical JWS verification + identical gate transitions. Ed25519 is
// deterministic, so re-signing is reproducible — `--check` re-emits in memory and fails if a
// committed file drifted.
//
// This file is the driver: it builds each file through its family module and reconciles the
// result. The families live in `tools/corpus/<family>.ts` (one per corpus file or `cases.json`
// section, plus the shared fixtures in `common.ts`, `release-records.ts`, `pack-records.ts` and
// `content-fixture.ts`), and the generator's independent reference implementations, which
// recompute every verdict, in `tools/corpus/reference/`. `tools/sync-scenarios.ts`,
// `tools/presentation-matrix.ts` and `tools/gen-content-corpus.ts` build their files the same way.
//
// ONE corpus, from four committed test keys (two product keys, two release keys) and fixed clocks:
//
//   conformance/corpus/v2/  wire contract v4 (docs/security/WIRE-CONTRACT-V4.md; v3's documents
//                           are unchanged, so the directory and `corpusVersion: 2` stay). Consumed
//                           in place by conformance/runners/node/corpusV2.test.ts via
//                           @polaris-key/client-core and by the Python, Swift (`CorpusLocator`,
//                           P0-44) and Kotlin runners. One generator-owned mirror keeps the path
//                           `…/v2/` one-for-one: `sdks/godot/tests/corpus/v2/` (the Godot runner,
//                           which reads it from `res://` in the editor and in an exported pack).
//                           Every file is written into every target in `CORPUS_TARGETS`.
//
// Thirteen files and one directory: `cases.json` (signed vectors, the v4 feed, release-record and
// pack families included), `gate-matrix.json` (§5, with SP-00's `entitlementRows` family),
// `fingerprint.json` (the hardware-hash
// formulas), `stage-matrix.json` (the boot stage machine of `@polaris-key/client-core/stages`,
// client boot behaviour outside the wire contract, read by
// conformance/runners/node/stageMatrix.test.ts and the Python, Swift and Godot runners; version
// 2 adds boot confirmation, version 3 adds packs, plans/P4-01.md §2.10), `headers.json` (the
// client metadata header values, §5.2), `config-matrix.json` (config resolution and environment
// values, §2.2.1), `update-matrix.json` (the update decision, plans/P3-01.md §2.8),
// `outlet-matrix.json` (outlet kinds, capabilities and detection, plans/P3-01.md §2.9),
// `plan-matrix.json` (the pack plan, plans/P4-01.md), `feed-url-matrix.json` (the app-updater
// feed URLs out of discovery's `update.endpoints`, plans/SP-00.md D5), `sync-scenarios.json` (the
// Cloud Sync client scenario corpus, literal data from tools/sync-scenarios.ts, plans/U-01.md
// §4.1, U-18), `device-label.json` (the device label every SDK sends as `deviceName`,
// WIRE-CONTRACT-V4 §12.7.1, plans/PX-W13.md §4), `presentation-matrix.json` (discovery's unsigned
// `core.presentation`: the parse rule, the icon size choice and the hash check, WIRE-CONTRACT-V4
// §5.5, plans/HA-12.md §4; rows and a generator-local reference in tools/presentation-matrix.ts)
// and `content/` (the content corpus:
// `cases.json` plus `blobs/`, plans/P4-01.md §4.4, P4-04).
//
// `corpus/v1` (wire contract v2) is GONE: its fifteen gate-matrix rows were inlined into
// `CARRIED_MATRIX_ROWS` (tools/corpus/gate.ts) before deletion. Fourteen are still emitted; one,
// the pre-R3-01 dev-build bypass, was retired by P0-04 through `RETIRED_CARRIED_ROWS`, with a
// named successor.
//
//   pnpm gen:corpus            # write the corpus
//   pnpm gen:corpus -- --check # CI drift guard (exit 1 if any file is stale)

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { format } from "prettier";
import {
  CONTENT_CASES_NAME,
  CONTENT_DIR,
  contentStrays,
  rebuildContentBlobs,
} from "./gen-content-corpus.js";
import { buildSyncScenarios } from "./sync-scenarios.js";
import { buildPresentationMatrix } from "./presentation-matrix.js";
import { buildV2 } from "./corpus/cases.js";
import { asciiJson, REPO_ROOT } from "./corpus/common.js";
import { buildConfigMatrix } from "./corpus/config.js";
import { buildContent } from "./corpus/content.js";
import { buildDeviceLabelCorpus } from "./corpus/device-label.js";
import { buildFeedUrlMatrixV1 } from "./corpus/feed-url.js";
import { buildFingerprintCorpus } from "./corpus/fingerprint.js";
import { buildGateMatrixV2 } from "./corpus/gate.js";
import { buildHeadersCorpus } from "./corpus/headers.js";
import { buildOutletMatrixV1 } from "./corpus/outlet.js";
import { buildStageMatrix } from "./corpus/stage.js";
import { buildUpdateMatrixV1 } from "./corpus/update.js";
import { REF_JSON } from "./corpus/reference/content.js";

/** The Godot project's generator-owned mirror. An exported Godot pack can read only `res://`
 *  (the project directory), never `../../conformance/`, so the editor and release-template
 *  runs both load the corpus from here. Guarded by `--check` exactly like the source. */
const GODOT_V2_RESOURCES = join(
  REPO_ROOT,
  "sdks",
  "godot",
  "tests",
  "corpus",
  "v2",
);
const V2_DIR = join(REPO_ROOT, "conformance", "corpus", "v2");
const V2_OUT = join(V2_DIR, "cases.json");
const V2_GATE_MATRIX_OUT = join(V2_DIR, "gate-matrix.json");
const V2_FINGERPRINT_OUT = join(V2_DIR, "fingerprint.json");
const V2_STAGE_MATRIX_OUT = join(V2_DIR, "stage-matrix.json");
const V2_HEADERS_OUT = join(V2_DIR, "headers.json");
const V2_CONFIG_MATRIX_OUT = join(V2_DIR, "config-matrix.json");
const V2_UPDATE_MATRIX_OUT = join(V2_DIR, "update-matrix.json");
const V2_OUTLET_MATRIX_OUT = join(V2_DIR, "outlet-matrix.json");
const V2_PLAN_MATRIX_OUT = join(V2_DIR, "plan-matrix.json");
const V2_FEED_URL_MATRIX_OUT = join(V2_DIR, "feed-url-matrix.json");
const V2_SYNC_SCENARIOS_OUT = join(V2_DIR, "sync-scenarios.json");
const V2_DEVICE_LABEL_OUT = join(V2_DIR, "device-label.json");
const V2_PRESENTATION_MATRIX_OUT = join(V2_DIR, "presentation-matrix.json");
/** Every directory that receives the corpus: the source, then each generator-owned mirror. */
const CORPUS_TARGETS = [V2_DIR, GODOT_V2_RESOURCES];

/** The Swift test bundle's former mirror, retired by P0-44: the Swift tests read
 *  `conformance/corpus/v2/` in place through `CorpusLocator`. A branch cut before then can merge
 *  a file back into it, so the directory is stray in both modes and never deleted automatically. */
const RETIRED_SWIFT_V2 = join(
  REPO_ROOT,
  "sdks",
  "swift",
  "Tests",
  "PolarisKeyTests",
  "Resources",
  "v2",
);

/** Reconcile one generated/source file against its on-disk copy. In `--check` mode a drift
 *  is fatal (returns true so the caller can exit 1); otherwise it's written. */
function reconcile(path: string, content: string, check: boolean): boolean {
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === content) {
    console.log(`up to date: ${path}`);
    return false;
  }
  if (check) {
    console.error(`stale: ${path} — run \`pnpm gen:corpus\``);
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${path}`);
  return false;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  // plans/P4-01.md §4.2: the explicit blob rebuild, never in the gate. It writes only
  // `content/blobs/` (refs.json included); run `pnpm gen:corpus` afterwards. `--blobs <dir>`
  // points it at another blob directory (gen-content-corpus.test.ts passes a temporary copy).
  if (process.argv.includes("--rebuild-content-blobs")) {
    const flag = (name: string): string | undefined => {
      const at = process.argv.indexOf(name);
      if (at < 0) return undefined;
      const value = process.argv[at + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${name} needs a directory`);
      return value;
    };
    rebuildContentBlobs(REF_JSON, {
      payloadsDir: flag("--payloads"),
      blobsDir: flag("--blobs"),
    });
    return;
  }

  // The fingerprint + device-id vectors. Unsigned (they pin hash formulas, not signatures),
  // but guarded by the same drift gate and mirrored alongside the rest.
  const fingerprint = await format(JSON.stringify(buildFingerprintCorpus()), {
    parser: "json",
  });

  // ── corpus v2 (wire contract v3) ───────────────────────────────────────────
  // Ten files and the `content/` directory in one place so a runner can point at `corpus/v2/`
  // and find everything it needs, and so `--check` guards the whole set. The `fingerprint.json` formulas are
  // unchanged across the wire revisions (`fingerprintVersion` stays 1) and deliberately NOT
  // rebranded — the `pkey-hw:`/`pkey-device:` prefixes are hash domains baked into every
  // enrolled digest, not user-visible identifiers. `stage-matrix.json` pins client boot
  // behaviour, which is outside the wire contract but shares the directory and the gate.
  const v2Content = await format(JSON.stringify(await buildV2()), {
    parser: "json",
  });
  const v2GateMatrix = await format(JSON.stringify(buildGateMatrixV2()), {
    parser: "json",
  });
  const v2StageMatrix = await format(JSON.stringify(buildStageMatrix()), {
    parser: "json",
  });
  // Client metadata header values (§5.2) and config resolution (§2.2.1): unsigned behaviour
  // tables, guarded by the same gate and mirrored alongside the rest.
  const v2Headers = await format(JSON.stringify(buildHeadersCorpus()), {
    parser: "json",
  });
  const v2ConfigMatrix = await format(JSON.stringify(buildConfigMatrix()), {
    parser: "json",
  });
  // §12.7.1 (PX-W13): the device label every SDK sends and the Worker stores. Unsigned, ASCII-only.
  const v2DeviceLabel = await format(asciiJson(buildDeviceLabelCorpus()), {
    parser: "json",
  });
  // Wire contract v4's two decision tables (plans/P3-01.md §4.6, §4.7): unsigned client
  // behaviour, recomputed by the generator's reference implementations, mirrored like the rest.
  // `buildV2` above has built the record vectors their rows pin.
  const v2UpdateMatrix = await format(JSON.stringify(buildUpdateMatrixV1()), {
    parser: "json",
  });
  const v2OutletMatrix = await format(JSON.stringify(buildOutletMatrixV1()), {
    parser: "json",
  });
  // SP-00 (plans/SP-00.md D5): the app-updater feed URLs out of discovery's `update.endpoints`.
  const v2FeedUrlMatrix = await format(JSON.stringify(buildFeedUrlMatrixV1()), {
    parser: "json",
  });
  // plans/P4-01.md §4.1–§4.5 (P4-04): the content corpus and `plan-matrix.json`, rebuilt from
  // the committed inputs after `buildV2` has signed the pack records they join by hash.
  const content = await buildContent();
  const contentCases = await format(JSON.stringify(content.cases), {
    parser: "json",
  });
  const planMatrix = await format(JSON.stringify(content.planMatrix), {
    parser: "json",
  });
  // plans/U-01.md §4.1 (U-18): the Cloud Sync client scenario corpus. Literal data with its own
  // self-check (tools/sync-scenarios.ts); unsigned, mirrored like the rest.
  const syncScenarios = await format(JSON.stringify(buildSyncScenarios()), {
    parser: "json",
  });
  // plans/HA-12.md §4: product presentation, recomputed by the generator-local reference in
  // tools/presentation-matrix.ts (which imports nothing it checks). ASCII only.
  const v2PresentationMatrix = await format(
    asciiJson(buildPresentationMatrix()),
    { parser: "json" },
  );

  // One map from file name to content, reconciled into the source directory and into every
  // generator-owned mirror, so a file added here reaches each mirror by construction.
  const files = new Map<string, string>([
    [basename(V2_OUT), v2Content],
    [basename(V2_GATE_MATRIX_OUT), v2GateMatrix],
    [basename(V2_FINGERPRINT_OUT), fingerprint],
    [basename(V2_STAGE_MATRIX_OUT), v2StageMatrix],
    [basename(V2_HEADERS_OUT), v2Headers],
    [basename(V2_CONFIG_MATRIX_OUT), v2ConfigMatrix],
    [basename(V2_UPDATE_MATRIX_OUT), v2UpdateMatrix],
    [basename(V2_OUTLET_MATRIX_OUT), v2OutletMatrix],
    [basename(V2_PLAN_MATRIX_OUT), planMatrix],
    [basename(V2_FEED_URL_MATRIX_OUT), v2FeedUrlMatrix],
    [basename(V2_SYNC_SCENARIOS_OUT), syncScenarios],
    [basename(V2_DEVICE_LABEL_OUT), v2DeviceLabel],
    [basename(V2_PRESENTATION_MATRIX_OUT), v2PresentationMatrix],
  ]);
  let stale = false;
  // `content/` is source-only (§4.1): its cases are reconciled in the source tree alone, its
  // blobs are inputs nothing here writes, and a `content/` directory in a mirror is stray.
  stale =
    reconcile(join(CONTENT_DIR, CONTENT_CASES_NAME), contentCases, check) ||
    stale;
  for (const path of contentStrays([GODOT_V2_RESOURCES])) {
    console.error(`stray: ${path} is not written by the generator`);
    stale = true;
  }
  for (const dir of CORPUS_TARGETS) {
    for (const [name, content] of files)
      stale = reconcile(join(dir, name), content, check) || stale;
    // Stray-file guard: a top-level JSON file the generator does not write fails both modes
    // and is never deleted automatically, so a dropped or renamed file cannot linger in a
    // mirror. Subdirectories belong to their owners.
    for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
      if (!entry.endsWith(".json") || files.has(entry)) continue;
      const path = join(dir, entry);
      if (!statSync(path).isFile()) continue;
      console.error(`stray: ${path} is not written by the generator`);
      stale = true;
    }
  }
  if (existsSync(RETIRED_SWIFT_V2)) {
    console.error(
      `stray: ${RETIRED_SWIFT_V2} is the retired Swift mirror (P0-44): delete it`,
    );
    stale = true;
  }

  if (stale) process.exit(1);
}

await main();
