// A-17h: the owner-approved live verification writes (2026-10-04), and nothing else.
//
//   (a) register ONE throwaway bundle id + two harmless capabilities, then repeat each create once
//       to record Apple's duplicate-error shape (the bundle id is left for the owner to delete);
//   (c) one deliberately invalid capability type — records the error shape and, from it, the live
//       capability enum (which answers "does an App Attest capability type exist?");
//   (b) on ONE existing app with no in-app purchases or subscriptions: set the App Store Server
//       Notifications URL (production, V2), confirm, then restore the exact previous values and
//       confirm. Restoration runs in a finally block.
//
// Every request and response is logged to out/a17h-log.json with the Authorization header removed.
// No other endpoint is reachable: `call` refuses any method/path not in ALLOWED.
import { createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.secrets/polaris-key/asc/asc-api-key.json`, "utf8"));
const BUNDLE = "im.plrs.key.pkeyprobe.20261004";
const TARGET_APP_BUNDLE = "com.vladzaharia.HockeyDrills";
const PROBE_URL = "https://key.plrs.im/pkey-probe/distribution/hooks/app-store";

const ALLOWED = [
  ["GET", /^\/v1\/bundleIds\?/],
  ["POST", /^\/v1\/bundleIds$/],
  ["POST", /^\/v1\/bundleIdCapabilities$/],
  ["GET", /^\/v1\/apps\?/],
  ["GET", /^\/v1\/apps\/\d+(\?|$)/],
  ["GET", /^\/v1\/apps\/\d+\/(inAppPurchasesV2|subscriptionGroups)\?/],
  ["PATCH", /^\/v1\/apps\/\d+$/],
];

const b64 = (b) => Buffer.from(b).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "ES256", kid: cfg.key_id, typ: "JWT" }));
  const body = b64(JSON.stringify({ iss: cfg.issuer_id, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey(readFileSync(cfg.key_path)), dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64(sig)}`;
}

const log = [];
async function call(method, path, body) {
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) throw new Error(`refused: ${method} ${path} is outside the approved A-17h set`);
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    redirect: "manual",
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  log.push({ step: log.length + 1, method, path, request: body ?? null, status: res.status, response: json ?? text.slice(0, 2000) });
  console.log(`${method} ${path} -> ${res.status}`);
  return { status: res.status, json };
}

const errSummary = (r) => (r.json?.errors ?? []).map((e) => `${e.code}: ${e.detail ?? e.title}`);
const results = {};
try {
  // (a) bundle id
  const existing = await call("GET", `/v1/bundleIds?filter%5Bidentifier%5D=${encodeURIComponent(BUNDLE)}&limit=5`);
  let bundleId = existing.json?.data?.find((d) => d.attributes?.identifier === BUNDLE)?.id ?? null;
  const create = () => call("POST", "/v1/bundleIds", { data: { type: "bundleIds", attributes: { identifier: BUNDLE, name: "Polaris Key probe - delete me", platform: "IOS" } } });
  if (!bundleId) {
    const c1 = await create();
    bundleId = c1.json?.data?.id ?? null;
    results.bundleCreate = { status: c1.status, id: bundleId, errors: errSummary(c1) };
  } else {
    results.bundleCreate = { status: "pre-existing", id: bundleId };
  }
  const c2 = await create();
  results.bundleDuplicate = { status: c2.status, errors: errSummary(c2) };

  if (bundleId) {
    const cap = (type) => call("POST", "/v1/bundleIdCapabilities", { data: { type: "bundleIdCapabilities", attributes: { capabilityType: type }, relationships: { bundleId: { data: { type: "bundleIds", id: bundleId } } } } });
    const iap = await cap("IN_APP_PURCHASE");
    const push = await cap("PUSH_NOTIFICATIONS");
    const iapDup = await cap("IN_APP_PURCHASE");
    results.capabilities = {
      inAppPurchase: { status: iap.status, id: iap.json?.data?.id ?? null, errors: errSummary(iap) },
      push: { status: push.status, id: push.json?.data?.id ?? null, errors: errSummary(push) },
      duplicate: { status: iapDup.status, errors: errSummary(iapDup) },
    };
    // (c) invalid capability type -> error shape + live enum
    const bad = await cap("PKEY_INVALID_PROBE");
    const detail = errSummary(bad).join(" | ");
    results.invalidCapability = { status: bad.status, errors: errSummary(bad), appAttestInEnum: /APP_ATTEST/.test(detail) };
  }

  // (b) notifications URL on one app with no IAPs/subscriptions
  const apps = await call("GET", `/v1/apps?filter%5BbundleId%5D=${encodeURIComponent(TARGET_APP_BUNDLE)}&fields%5Bapps%5D=name,bundleId,subscriptionStatusUrl,subscriptionStatusUrlVersion,subscriptionStatusUrlForSandbox,subscriptionStatusUrlVersionForSandbox`);
  const app = apps.json?.data?.[0];
  if (!app) {
    results.notificationsUrl = { skipped: `no app with bundle id ${TARGET_APP_BUNDLE}` };
  } else {
    const iaps = await call("GET", `/v1/apps/${app.id}/inAppPurchasesV2?limit=1`);
    const subs = await call("GET", `/v1/apps/${app.id}/subscriptionGroups?limit=1`);
    const hasCommerce = (iaps.json?.data?.length ?? 0) > 0 || (subs.json?.data?.length ?? 0) > 0;
    if (hasCommerce) {
      results.notificationsUrl = { skipped: `${app.attributes.name} has in-app purchases or subscriptions` };
    } else {
      const before = {
        subscriptionStatusUrl: app.attributes.subscriptionStatusUrl ?? null,
        subscriptionStatusUrlVersion: app.attributes.subscriptionStatusUrlVersion ?? null,
      };
      results.notificationsUrl = { app: app.attributes.name, before };
      try {
        const set = await call("PATCH", `/v1/apps/${app.id}`, { data: { type: "apps", id: app.id, attributes: { subscriptionStatusUrl: PROBE_URL, subscriptionStatusUrlVersion: "V2" } } });
        results.notificationsUrl.set = { status: set.status, errors: errSummary(set), echoed: set.json?.data?.attributes?.subscriptionStatusUrl ?? null };
        const check = await call("GET", `/v1/apps/${app.id}?fields%5Bapps%5D=subscriptionStatusUrl,subscriptionStatusUrlVersion`);
        results.notificationsUrl.afterSet = check.json?.data?.attributes ?? null;
      } finally {
        const restore = await call("PATCH", `/v1/apps/${app.id}`, { data: { type: "apps", id: app.id, attributes: before } });
        const verify = await call("GET", `/v1/apps/${app.id}?fields%5Bapps%5D=subscriptionStatusUrl,subscriptionStatusUrlVersion`);
        const after = verify.json?.data?.attributes ?? null;
        results.notificationsUrl.restore = { status: restore.status, errors: errSummary(restore), after, restored: !!after && after.subscriptionStatusUrl === before.subscriptionStatusUrl && (after.subscriptionStatusUrlVersion ?? null) === before.subscriptionStatusUrlVersion };
      }
    }
  }
} finally {
  mkdirSync(join(HERE, "out"), { recursive: true });
  writeFileSync(join(HERE, "out", "a17h-log.json"), JSON.stringify({ ranAt: new Date().toISOString(), results, log }, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
