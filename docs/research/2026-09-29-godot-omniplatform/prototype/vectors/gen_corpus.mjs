// Extract Polaris Key corpus v2 JWS material for the GDScript runner (read-only use of the repo).
//  corpus_jws.json   : every jwsCases entry + a canonical rendering of expect.doc
//  corpus_sigs.json  : every distinct compact JWS string anywhere in cases.json, with the RAW
//                      Ed25519 verdict from Node (OpenSSL) over the signing input, keyed by kid
import crypto from "node:crypto";
import fs from "node:fs";
// Repo-relative: prototype/vectors -> repo root is five levels up.
const CASES = new URL("../../../../../conformance/corpus/v2/cases.json", import.meta.url);
const cases = JSON.parse(fs.readFileSync(CASES, "utf8"));
const canon = (v) => {
  if (v === null) return "N";
  if (typeof v === "boolean") return v ? "T" : "F";
  if (typeof v === "number") { if (!Number.isInteger(v)) throw new Error("float in doc"); return "n" + v; }
  if (typeof v === "string") return "s" + Buffer.from(v, "utf8").toString("hex");
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const ks = Object.keys(v).map((k) => [Buffer.from(k, "utf8").toString("hex"), k]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return "{" + ks.map(([h, k]) => h + ":" + canon(v[k])).join(",") + "}";
};
const jws = cases.jwsCases.map((c) => ({ id: c.id, jws: c.jws, trust: c.trust, typ: c.typ, maxPayloadBytes: c.maxPayloadBytes ?? 0, expect: c.expect.verify, kid: c.expect.kid ?? null, docCanon: c.expect.doc ? canon(c.expect.doc) : null }));
fs.writeFileSync(new URL("./corpus_jws.json", import.meta.url), JSON.stringify(jws));

const keys = Object.fromEntries(cases.keys.map((k) => [k.kid, k.publicKeyRaw]));
const text = fs.readFileSync(CASES, "utf8");
const toks = [...new Set(text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g))];
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const sigs = [];
for (const t of toks) {
  const [h, p, s] = t.split(".");
  let hdr; try { hdr = JSON.parse(Buffer.from(h, "base64url").toString("utf8")); } catch { continue; }
  const pk = keys[hdr.kid];
  if (!pk) continue;
  const sig = Buffer.from(s, "base64url");
  if (sig.length !== 64 || Buffer.from(sig).toString("base64url") !== s) continue; // only well-formed sig segments
  const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pk, "base64url")]), format: "der", type: "spki" });
  const ok = crypto.verify(null, Buffer.from(h + "." + p, "ascii"), pub, sig);
  sigs.push({ kid: hdr.kid, typ: hdr.typ ?? null, pk: Buffer.from(pk, "base64url").toString("hex"), sig: sig.toString("hex"), signingInput: h + "." + p, expect: ok });
}
fs.writeFileSync(new URL("./corpus_sigs.json", import.meta.url), JSON.stringify(sigs));
console.log(`jwsCases: ${jws.length}; raw signature vectors: ${sigs.length} (valid ${sigs.filter((s) => s.expect).length}, invalid ${sigs.filter((s) => !s.expect).length}); max signing input ${Math.max(...sigs.map((s) => s.signingInput.length))} B`);
