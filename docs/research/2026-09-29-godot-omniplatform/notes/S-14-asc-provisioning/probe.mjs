// S-14 (notes/S-14-asc-provisioning.md). READ-ONLY probe: GET only. Writes the raw body to
// out/<name>.json and prints status, latency and the X-Rate-Limit header.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
const cfg = JSON.parse(
  readFileSync(
    `${homedir()}/.secrets/polaris-key/asc/asc-api-key.json`,
    "utf8",
  ),
);
const keyPath = cfg.key_path.replace(/^~/, homedir());
const b64 = (b) => Buffer.from(b).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: "ES256", kid: cfg.key_id, typ: "JWT" }));
  const p = b64(
    JSON.stringify({
      iss: cfg.issuer_id,
      iat: now,
      exp: now + 600,
      aud: "appstoreconnect-v1",
    }),
  );
  const s = sign("sha256", Buffer.from(`${h}.${p}`), {
    key: createPrivateKey(readFileSync(keyPath)),
    dsaEncoding: "ieee-p1363",
  });
  return `${h}.${p}.${b64(s)}`;
}
mkdirSync("out", { recursive: true });
const [name, path] = process.argv.slice(2);
const t0 = Date.now();
const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
  method: "GET",
  headers: { Authorization: `Bearer ${token()}` },
});
const text = await res.text();
writeFileSync(`out/${name}.json`, text);
console.log(
  JSON.stringify({
    name,
    path,
    status: res.status,
    ms: Date.now() - t0,
    rate: res.headers.get("x-rate-limit"),
    bytes: text.length,
  }),
);
