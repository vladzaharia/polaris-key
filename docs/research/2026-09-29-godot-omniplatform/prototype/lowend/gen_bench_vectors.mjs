// Picks the three Ed25519 timing inputs from corpus_sigs.json (itself derived from conformance corpus v2
// by ../vectors/gen_corpus.mjs): the smallest valid signing input, the 87 KB license payload at the cap
// and the 350 KB bundle at the cap. Node's verdict (OpenSSL) travels with each one.
// usage: node gen_bench_vectors.mjs <corpus_sigs.json> <out.json>
import fs from "node:fs";
const [src, out] = process.argv.slice(2);
const sigs = JSON.parse(fs.readFileSync(src, "utf8")).filter(
  (s) => s.expect === true,
);
const by = (pred) =>
  sigs
    .filter(pred)
    .sort((a, b) => a.signingInput.length - b.signingInput.length);
const small = by(() => true)[0];
const lic = by(
  (s) => s.typ === "pkey-license+jws" && s.signingInput.length > 80000,
).at(-1);
const bundle = by(
  (s) => s.typ === "pkey-bundle+jws" && s.signingInput.length > 300000,
).at(-1);
if (!small || !lic || !bundle)
  throw new Error("corpus_sigs.json lacks one of the three inputs");
const pick = (name, s) => ({
  name,
  typ: s.typ,
  bytes: s.signingInput.length,
  pk: s.pk,
  sig: s.sig,
  signingInput: s.signingInput,
});
fs.writeFileSync(
  out,
  JSON.stringify([
    pick("small", small),
    pick("payload87k", lic),
    pick("bundle350k", bundle),
  ]),
);
console.log(
  `ed25519_bench.json: ${small.signingInput.length} / ${lic.signingInput.length} / ${bundle.signingInput.length} B`,
);
