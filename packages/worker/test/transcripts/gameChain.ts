/// <reference types="@cloudflare/workers-types" />
// The Game Center chain and tokens the transcripts sign in with (I-14.9, WIRE-CONTRACT-V5
// §12.11.7). The Worker runs its real verifier: `gameCenter.ts` fetches the certificate from
// Apple's key host (served here from the fixture, see `withProviders`), checks the chain against
// the pinned anchors and the RSA signature over the signed layout. Only the anchors differ:
// `transcripts.test.ts` swaps the pinned DigiCert roots for the throwaway root of
// `fixtures/signin/gamecenter-transcript-chain.json`. A token is signed with the chain's leaf key
// (RSASSA-PKCS1-v1_5 is deterministic, so a recording is byte-stable). The module must not import
// `jose`.

import { readFileSync } from "node:fs";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { T0 } from "./client.js";
import type { JsonValue } from "./format.js";

interface ChainFile {
  root: string;
  intermediate: string;
  leaf: string;
  leafKeyPkcs8: string;
}

const file = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/signin/gamecenter-transcript-chain.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ChainFile;

const der = (b64: string): Uint8Array =>
  new Uint8Array(Buffer.from(b64, "base64"));

/** The anchors `gameCenterAnchors.ts` is mocked with. */
export function gameCenterAnchors(): {
  GAME_CENTER_ROOTS: Uint8Array[];
  GAME_CENTER_INTERMEDIATES: Uint8Array[];
} {
  return {
    GAME_CENTER_ROOTS: [der(file.root)],
    GAME_CENTER_INTERMEDIATES: [der(file.intermediate)],
  };
}

/** What Apple's key host answers for the fixture key URL. */
export function gameCenterCertificate(): Response {
  return new Response(der(file.leaf), {
    status: 200,
    headers: {
      "content-type": "application/x-x509-ca-cert",
      "cache-control": "max-age=300",
    },
  });
}

export const GC_KEY_URL =
  "https://static.gc.apple.com/public-key/gc-prod-12.cer";
export const GC_TEAM_PLAYER = "T:transcript-team-player-1";

const enc = new TextEncoder();
const b64 = (b: Uint8Array): string => base64UrlEncodeBytes(b);
const b64s = (text: string): string => b64(enc.encode(text));

let leafKey: Promise<CryptoKey> | undefined;
const signingKey = (): Promise<CryptoKey> =>
  (leafKey ??= crypto.subtle.importKey(
    "pkcs8",
    der(file.leafKeyPkcs8),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  ));

/** The structured fields of a Game Center identity-verification token, as an SDK holds them after
 *  `fetchItems(forIdentityVerificationSignature:)` (`signature` and `salt` are base64url). */
export interface GameCenterArgs {
  publicKeyUrl: string;
  signature: string;
  salt: string;
  timestamp: number;
  teamPlayerId: string;
  bundleId: string;
}

/** A token Apple's key would sign: `teamPlayerID || bundleId || u64be(timestamp) || salt`.
 *  `signedBundle` signs another bundle id than the one sent. */
export async function gameCenterArgs(
  over: Partial<Omit<GameCenterArgs, "signature">> & {
    bundleId: string;
    signedBundle?: string;
  },
): Promise<GameCenterArgs> {
  const salt = Uint8Array.of(0x50, 0x4b, 0x65, 0x79, 1, 2, 3, 4);
  const timestamp = over.timestamp ?? T0 * 1000 - 5_000;
  const player = over.teamPlayerId ?? GC_TEAM_PLAYER;
  const a = enc.encode(player);
  const bundle = enc.encode(over.signedBundle ?? over.bundleId);
  const data = new Uint8Array(a.length + bundle.length + 8 + salt.length);
  data.set(a, 0);
  data.set(bundle, a.length);
  new DataView(data.buffer).setBigUint64(
    a.length + bundle.length,
    BigInt(timestamp),
    false,
  );
  data.set(salt, a.length + bundle.length + 8);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      await signingKey(),
      data,
    ),
  );
  return {
    publicKeyUrl: over.publicKeyUrl ?? GC_KEY_URL,
    signature: b64(sig),
    salt: b64(salt),
    timestamp,
    teamPlayerId: player,
    bundleId: over.bundleId,
  };
}

/** The `gc1.` token an SDK sends: six dot-joined fields, every one base64url except the decimal
 *  timestamp (format.ts, "exchange"). */
export function gameCenterToken(a: GameCenterArgs): string {
  return [
    "gc1",
    b64s(a.publicKeyUrl),
    a.signature,
    a.salt,
    String(a.timestamp),
    b64s(a.teamPlayerId),
    b64s(a.bundleId),
  ].join(".");
}

export const asJson = (a: GameCenterArgs): JsonValue =>
  a as unknown as JsonValue;

// ── Play Games ───────────────────────────────────────────────────────────────────────────────

export const PGS_APP = "123456789012";
export const PGS_CLIENT =
  "123456789012-transcriptpgs.apps.googleusercontent.com";
export const PGS_PLAYER = "pgs-player-1";
export const PGS_CODE = "4/transcript-server-auth-code";
/** Not a real secret: the stored server credential the verifier opens to redeem the code. */
export const PGS_SECRET = "FAKE-transcript-secret-0000";
