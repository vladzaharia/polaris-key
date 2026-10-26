// admitPeer: a certificate of another account is not judged by the held ring's epoch.
import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes, signJws, type TrustSet } from "@polaris-key/jws";
import { admitPeer } from "../src/peer/index.js";

const KID = "peer-test-2026";
const SUB_A = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const SUB_B = "ps_BBBBBBBBBBBBBBBBBBBBBB";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const NOW = 1_700_001_000;

let PEM = "";
let trust: TrustSet = {};
let signKey = "";
let agreeKey = "";

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  PEM = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----`;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  signKey = base64UrlEncodeBytes(new Uint8Array(raw));
  trust = { [KID]: signKey };
  agreeKey = base64UrlEncodeBytes(new Uint8Array(32).fill(7));
});

const cert = (sub: string, ringEpoch: number) =>
  signJws(
    {
      iss: "key.plrs.im",
      aud: "djdl",
      sub,
      deviceId: DEVICE,
      signKey,
      agreeKey,
      ringEpoch,
      issuedAt: NOW - 10,
      expiresAt: NOW + 1000,
    },
    PEM,
    KID,
    "pkey-peer+jws",
  );
const ring = (sub: string, epoch: number) =>
  signJws(
    {
      iss: "key.plrs.im",
      aud: "djdl",
      sub,
      epoch,
      issuedAt: NOW - 10,
      expiresAt: NOW + 1000,
      devices: [{ deviceId: DEVICE, signKey, agreeKey }],
    },
    PEM,
    KID,
    "pkey-ring+jws",
  );

describe("admitPeer and the held ring's account", () => {
  const opts = () => ({ trust, expectedAud: "djdl", now: NOW });

  it("admits a certificate of the ring's account", async () => {
    const r = await admitPeer(
      await cert(SUB_A, 3),
      await ring(SUB_A, 3),
      opts(),
    );
    expect(r).toMatchObject({ admit: true, ringSync: "none" });
  });

  it("refuses a certificate of another account, whatever its epoch", async () => {
    for (const epoch of [1, 3, 9]) {
      const r = await admitPeer(
        await cert(SUB_B, epoch),
        await ring(SUB_A, 3),
        opts(),
      );
      expect(r).toEqual({ admit: false, reason: "cert-invalid" });
    }
  });

  it("admits it when no ring is held", async () => {
    const r = await admitPeer(await cert(SUB_B, 1), null, opts());
    expect(r).toMatchObject({ admit: true });
  });
});
