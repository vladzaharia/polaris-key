#!/usr/bin/env node
// upload_pack.mjs: upload one Apple-hosted asset-pack version through the App Store Connect API
// and poll it until it is ready for internal testing (S-01, steps 3 and 5). Node 22, no deps.
//
//   node upload_pack.mjs --pack-id pkba-essential-c1 --aar build/packs/v1/pkba-essential-c1.aar \
//        [--manifest build/packs/src_v1/pkba-essential-c1/Manifest.json] [--checksum] \
//        [--expect-resource <backgroundAssets id>] [--poll-minutes 120] [--dry-run]
//   node upload_pack.mjs --poll-version <backgroundAssetVersions id> [--poll-minutes 120]
//
// Credentials come from the environment only and are never logged:
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the AuthKey_*.p8 file), ASC_APP_ID (the app's Apple ID).
// Without them, or with --dry-run, it prints the request sequence with placeholders and exits.
//
// Every step prints one JSON line {t, step, ...}; the poll prints a line on every state change,
// which is the raw material for the note's timeline table. Request shapes follow the App Store
// Connect OpenAPI spec 4.5 (BackgroundAssetCreateRequest, BackgroundAssetVersionCreateRequest,
// BackgroundAssetUploadFileCreateRequest/UpdateRequest). Written and dry-run checked in S-01; the
// live run is a human hand-off (no API key in the research environment).
//
// Guards (S-01 §Recommendation, asset-pack id rule): the id must match
// ^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$ and be at most 64 characters. A pack id mapped from a dotted
// Polaris Key id can collide with another pack's (`a.b` and `a-b` both become `a-b-cN`), and a
// collision would upload into the other pack's asset pack; archived ids cannot be reused. The
// cross-pack collision check needs the whole product (P5-08). This tool refuses a found asset pack
// whose resource id differs from --expect-resource, and refuses to create one when
// --expect-resource is given but nothing is found. Only upload data-only packs: never pkba-big-c1,
// which is A6's full-project PCK (scripts, project.binary).
import { createPrivateKey, createHash, sign } from "node:crypto";
import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";

const API = "https://api.appstoreconnect.apple.com";
const { values: a } = parseArgs({
  options: {
    "pack-id": { type: "string" },
    aar: { type: "string" },
    manifest: { type: "string" },
    checksum: { type: "boolean", default: false },
    "poll-minutes": { type: "string", default: "120" },
    "poll-version": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "expect-resource": { type: "string" },
  },
});
const env = process.env;
const live =
  !a["dry-run"] &&
  env.ASC_KEY_ID &&
  env.ASC_ISSUER_ID &&
  env.ASC_KEY_PATH &&
  env.ASC_APP_ID;
const appId = live ? env.ASC_APP_ID : "<ASC_APP_ID>";
const t0 = Date.now();
const log = (step, o = {}) =>
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      s: (Date.now() - t0) / 1000,
      step,
      ...o,
    }),
  );

// ES256 JWT, 20 minutes (the maximum ASC accepts), re-minted per request.
function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "ES256", kid: env.ASC_KEY_ID, typ: "JWT" });
  const body = b64({
    iss: env.ASC_ISSUER_ID,
    iat,
    exp: iat + 1200,
    aud: "appstoreconnect-v1",
  });
  const key = createPrivateKey(readFileSync(env.ASC_KEY_PATH));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${sig.toString("base64url")}`;
}

async function asc(method, path, body) {
  if (!live) {
    log("dry-run", { method, path, body });
    return {
      data: {
        id: `<${path.split("/")[2]}-id>`,
        attributes: { uploadOperations: [] },
      },
    };
  }
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, {
      method,
      headers: {
        authorization: `Bearer ${jwt()}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const rate = r.headers.get("x-rate-limit");
    if (r.status === 429 && attempt < 5) {
      log("rate-limited", { path, rate });
      await new Promise((s) => setTimeout(s, 2 ** attempt * 5000));
      continue;
    }
    if (!r.ok) {
      log("http-error", {
        method,
        path,
        status: r.status,
        body: text.slice(0, 2000),
      });
      throw new Error(`${method} ${path}: ${r.status}`);
    }
    return text ? JSON.parse(text) : {};
  }
}

async function findOrCreatePack(packId) {
  const q = `/v1/apps/${appId}/backgroundAssets?filter[assetPackIdentifier]=${encodeURIComponent(packId)}`;
  const found = live ? (await asc("GET", q)).data?.[0] : null;
  const expect = a["expect-resource"];
  if (found && expect && found.id !== expect)
    throw new Error(
      `asset pack ${packId} is resource ${found.id}, expected ${expect}: refusing to upload into another pack`,
    );
  if (found) return found.id;
  if (live && expect)
    throw new Error(
      `asset pack ${packId} not found, expected resource ${expect}: refusing to create a new one`,
    );
  const r = await asc("POST", "/v1/backgroundAssets", {
    data: {
      type: "backgroundAssets",
      attributes: { assetPackIdentifier: packId },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  });
  return r.data.id;
}

async function uploadFile(versionId, path, assetType, checksum) {
  const size = statSync(path).size;
  const r = await asc("POST", "/v1/backgroundAssetUploadFiles", {
    data: {
      type: "backgroundAssetUploadFiles",
      attributes: { assetType, fileName: basename(path), fileSize: size },
      relationships: {
        backgroundAssetVersion: {
          data: { type: "backgroundAssetVersions", id: versionId },
        },
      },
    },
  });
  const ops = r.data.attributes.uploadOperations ?? [];
  log("upload-reserved", {
    assetType,
    fileName: basename(path),
    size,
    parts: ops.length,
  });
  const fd = openSync(path, "r");
  try {
    for (const op of ops) {
      const buf = Buffer.alloc(op.length);
      readSync(fd, buf, 0, op.length, op.offset);
      const headers = Object.fromEntries(
        (op.requestHeaders ?? []).map((h) => [h.name, h.value]),
      );
      const t = Date.now();
      const put = await fetch(op.url, {
        method: op.method,
        headers,
        body: buf,
      });
      if (!put.ok)
        throw new Error(`part ${op.partNumber ?? op.offset}: ${put.status}`);
      log("part", {
        part: op.partNumber,
        offset: op.offset,
        length: op.length,
        ms: Date.now() - t,
      });
    }
  } finally {
    closeSync(fd);
  }
  const attributes = { uploaded: true };
  if (checksum) {
    // Algorithm per spec enum; the expected hash encoding is not documented (hex assumed).
    attributes.sourceFileChecksums = {
      file: {
        algorithm: "SHA_256",
        hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
      },
    };
  }
  await asc("PATCH", `/v1/backgroundAssetUploadFiles/${r.data.id}`, {
    data: { type: "backgroundAssetUploadFiles", id: r.data.id, attributes },
  });
  log("upload-committed", {
    assetType,
    uploadFileId: live ? r.data.id : "<id>",
  });
}

async function poll(versionId, minutes) {
  if (!live)
    return log("dry-run", {
      method: "GET",
      path: `/v1/backgroundAssetVersions/${versionId}?include=internalBetaRelease,externalBetaRelease,appStoreRelease`,
      note: "polled every 30 s",
    });
  let last = "";
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    const r = await asc(
      "GET",
      `/v1/backgroundAssetVersions/${versionId}?include=internalBetaRelease,externalBetaRelease,appStoreRelease`,
    );
    const inc = Object.fromEntries(
      (r.included ?? []).map((x) => [x.type, x.attributes?.state]),
    );
    const snap = {
      version: r.data.attributes.version,
      state: r.data.attributes.state,
      stateDetails: r.data.attributes.stateDetails,
      ...inc,
    };
    const key = JSON.stringify(snap);
    if (key !== last) log("state", snap);
    last = key;
    if (
      snap.state === "FAILED" ||
      inc.backgroundAssetVersionInternalBetaReleases === "READY_FOR_TESTING"
    )
      return snap;
    await new Promise((s) => setTimeout(s, 30000));
  }
  log("poll-timeout", { minutes });
}

async function main() {
  log("start", {
    live: Boolean(live),
    packId: a["pack-id"],
    aar: a.aar && basename(a.aar),
  });
  if (a["poll-version"])
    return poll(a["poll-version"], Number(a["poll-minutes"]));
  if (!a["pack-id"] || !a.aar)
    throw new Error("need --pack-id and --aar (or --poll-version)");
  if (
    !/^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(a["pack-id"]) ||
    a["pack-id"].length > 64
  )
    throw new Error(
      "asset-pack id: ASC accepts only alphanumerics and single hyphens; at most 64 characters here",
    );
  if (a["pack-id"] === "pkba-big-c1")
    throw new Error(
      "pkba-big-c1 is A6's full-project PCK (scripts, project.binary): upload a data-only rebuild instead",
    );
  const packUuid = await findOrCreatePack(a["pack-id"]);
  log("pack", { id: live ? packUuid : "<id>" });
  const v = await asc("POST", "/v1/backgroundAssetVersions", {
    data: {
      type: "backgroundAssetVersions",
      relationships: {
        backgroundAsset: { data: { type: "backgroundAssets", id: packUuid } },
      },
    },
  });
  log("version", {
    id: live ? v.data.id : "<id>",
    version: v.data.attributes?.version,
  });
  if (a.manifest)
    await uploadFile(v.data.id, a.manifest, "MANIFEST", a.checksum);
  await uploadFile(v.data.id, a.aar, "ASSET", a.checksum);
  await poll(v.data.id, Number(a["poll-minutes"]));
}

main().catch((e) => {
  log("fatal", { error: String(e.message ?? e) });
  process.exit(1);
});
