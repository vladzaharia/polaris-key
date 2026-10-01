// Generates Ed25519 test vectors with Node 22's OpenSSL-backed crypto (the same verifier family
// as WebCrypto in @polaris-key/jws). RFC 8032 §7.1 vectors are checked for sign-equality first.
import crypto from "node:crypto";
import fs from "node:fs";

const P8 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const priv = (seedHex) => crypto.createPrivateKey({ key: Buffer.concat([P8, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
const pubRaw = (k) => crypto.createPublicKey(k).export({ format: "der", type: "spki" }).subarray(12);
const nodeVerify = (pkHex, msgHex, sigHex) => {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pkHex, "hex")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(msgHex, "hex"), pub, Buffer.from(sigHex, "hex"));
  } catch (e) { return "throws:" + e.code; }
};

const rfc = [
  { name: "RFC8032 TEST 1", sk: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", pk: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", msg: "", sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" },
  { name: "RFC8032 TEST 2", sk: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", pk: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", msg: "72", sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00" },
  { name: "RFC8032 TEST 3", sk: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", pk: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", msg: "af82", sig: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a" },
  { name: "RFC8032 TEST SHA(abc)", sk: "833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42", pk: "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf", msg: "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", sig: "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704" },
];
const vectors = [];
for (const v of rfc) {
  const k = priv(v.sk);
  const pk = pubRaw(k).toString("hex");
  const sig = crypto.sign(null, Buffer.from(v.msg, "hex"), k).toString("hex");
  if (pk !== v.pk || sig !== v.sig) throw new Error("RFC vector mismatch (transcription?) " + v.name);
  vectors.push({ name: v.name, pk: v.pk, msg: v.msg, sig: v.sig, expect: true });
}
// Random-length vectors across SHA-512 block boundaries.
let seedCounter = 1;
for (const n of [0, 1, 31, 32, 63, 64, 111, 112, 127, 128, 200, 1023, 4000]) {
  const seed = crypto.createHash("sha256").update("seed" + seedCounter++).digest();
  const k = priv(seed.toString("hex"));
  const msg = crypto.randomBytes(n);
  const sig = crypto.sign(null, msg, k);
  vectors.push({ name: `node-rand-${n}`, pk: pubRaw(k).toString("hex"), msg: msg.toString("hex"), sig: sig.toString("hex"), expect: true });
}
// Negative vectors, each checked against Node so "expect" is Node's verdict, not ours.
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const le2n = (b) => BigInt("0x" + Buffer.from(b).reverse().toString("hex"));
const n2le = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();
const base = vectors[1]; // TEST 2
const sigB = Buffer.from(base.sig, "hex");
const neg = [];
{ const s = Buffer.from(sigB); s[0] ^= 1; neg.push({ name: "R bit flip", sig: s }); }
{ const s = Buffer.from(sigB); s[40] ^= 0x10; neg.push({ name: "S bit flip", sig: s }); }
{ const s = Buffer.from(sigB); const S = le2n(s.subarray(32)); n2le(S + L).copy(s, 32); neg.push({ name: "S + L (malleable, non-canonical S)", sig: s }); }
{ const s = Buffer.from(sigB); n2le(L).copy(s, 32); neg.push({ name: "S == L", sig: s }); }
{ const s = Buffer.from(sigB); s.fill(0xff, 32); neg.push({ name: "S all 0xff", sig: s }); }
for (const t of neg) vectors.push({ name: "neg: " + t.name, pk: base.pk, msg: base.msg, sig: t.sig.toString("hex"), expect: nodeVerify(base.pk, base.msg, t.sig.toString("hex")) });
vectors.push({ name: "neg: wrong message", pk: base.pk, msg: "73", sig: base.sig, expect: nodeVerify(base.pk, "73", base.sig) });
vectors.push({ name: "neg: wrong key", pk: vectors[0].pk, msg: base.msg, sig: base.sig, expect: nodeVerify(vectors[0].pk, base.msg, base.sig) });
// Non-canonical public key encoding: y = p + 1 (== 1 mod p) etc.
const p = (1n << 255n) - 19n;
const ncA = n2le(p + 1n).toString("hex");
vectors.push({ name: "neg: pk y non-canonical (p+1)", pk: ncA, msg: base.msg, sig: base.sig, expect: nodeVerify(ncA, base.msg, base.sig) });
// pk not on curve: y=2 is not a valid point (x^2 non-square)
const offA = n2le(2n).toString("hex");
vectors.push({ name: "neg: pk not on curve (y=2)", pk: offA, msg: base.msg, sig: base.sig, expect: nodeVerify(offA, base.msg, base.sig) });
for (const v of vectors) if (v.expect !== true && v.expect !== false) throw new Error("node threw on " + v.name + ": " + v.expect);
fs.writeFileSync(new URL("./ed25519.json", import.meta.url), JSON.stringify(vectors, null, 1));
console.log(vectors.map((v) => `${v.expect ? "ACCEPT" : "reject"}  ${v.name}`).join("\n"));
