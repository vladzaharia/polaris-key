/**
 * I-16: a software WebAuthn authenticator for the passkey tests, in both lanes (Node and workerd:
 * WebCrypto only, no `node:` imports). It answers the options the Worker hands out the way a real
 * platform authenticator and browser would: `navigator.credentials.create` (a `none` attestation
 * over ES256 or Ed25519) and `navigator.credentials.get` (a signed assertion), returned in the
 * `PublicKeyCredential.toJSON()` shape the card posts. Every knob a test needs to forge a bad
 * response (origin, RP id, flags, counter, user handle, challenge) is an option.
 */
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

type Alg = "ES256" | "Ed25519";
/** Bytes backed by a plain `ArrayBuffer` (what WebCrypto and the base64url helpers take). */
type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const utf8 = (text: string): Bytes => new Uint8Array(enc.encode(text));

async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer),
  );
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

/** An ECDSA P1363 (r || s) signature as DER, the form WebAuthn's ES256 carries. */
function derFromRaw(raw: Bytes): Bytes {
  const int = (x: Bytes): Bytes => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = x.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface CeremonyOverrides {
  /** The origin the "browser" reports (default `https://key.plrs.im`). */
  origin?: string;
  /** The RP id the authenticator hashes (default the options' `rpId` / `rp.id`). */
  rpId?: string;
  /** The challenge the client data carries (default the options'). */
  challenge?: string;
  /** Authenticator-data flags (default UP | UV, plus BE | BS for a synced passkey). */
  flags?: number;
  /** The client data `type` (default `webauthn.create` / `webauthn.get`). */
  type?: string;
}

export interface AssertionOverrides extends CeremonyOverrides {
  /** The signature counter to report (default: the authenticator's, advanced if it counts). */
  counter?: number;
  /** The user handle to return; `null` omits it (default the one registered). */
  userHandle?: string | null;
  /** Sign with this other authenticator's key instead (a forgery). */
  signWith?: SoftAuthenticator;
}

export class SoftAuthenticator {
  readonly credentialId: Bytes;
  userHandle: string | null = null;
  /** The signature counter; 0 forever for a synced passkey. */
  counter: number;

  private constructor(
    readonly alg: Alg,
    private readonly keys: CryptoKeyPair,
    readonly synced: boolean,
  ) {
    this.credentialId = crypto.getRandomValues(new Uint8Array(32));
    this.counter = 0;
  }

  /** `synced: true` (the default) never counts, like iCloud Keychain or Google Password Manager;
   *  `synced: false` counts up on every use, like a hardware key. */
  static async create(
    opts: { alg?: Alg; synced?: boolean } = {},
  ): Promise<SoftAuthenticator> {
    const alg = opts.alg ?? "ES256";
    const keys = (await crypto.subtle.generateKey(
      alg === "ES256"
        ? { name: "ECDSA", namedCurve: "P-256" }
        : { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return new SoftAuthenticator(alg, keys, opts.synced ?? true);
  }

  get id(): string {
    return isoBase64URL.fromBuffer(this.credentialId);
  }

  private async coseKey(): Promise<Bytes> {
    const jwk = (await crypto.subtle.exportKey(
      "jwk",
      this.keys.publicKey,
    )) as JsonWebKey;
    const x = isoBase64URL.toBuffer(jwk.x!);
    const key = new Map<number, number | Uint8Array>();
    if (this.alg === "ES256") {
      key.set(1, 2); // kty: EC2
      key.set(3, -7); // alg: ES256
      key.set(-1, 1); // crv: P-256
      key.set(-2, x);
      key.set(-3, isoBase64URL.toBuffer(jwk.y!));
    } else {
      key.set(1, 1); // kty: OKP
      key.set(3, -8); // alg: EdDSA
      key.set(-1, 6); // crv: Ed25519
      key.set(-2, x);
    }
    return isoCBOR.encode(key);
  }

  private defaultFlags(): number {
    return FLAG_UP | FLAG_UV | (this.synced ? FLAG_BE | FLAG_BS : 0);
  }

  private clientData(type: string, challenge: string, origin: string): Bytes {
    return utf8(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  private async sign(data: Bytes): Promise<Bytes> {
    if (this.alg === "ES256") {
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          this.keys.privateKey,
          data as unknown as ArrayBuffer,
        ),
      );
      return derFromRaw(raw);
    }
    return new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        this.keys.privateKey,
        data as unknown as ArrayBuffer,
      ),
    );
  }

  /** `navigator.credentials.create(options).toJSON()`. */
  async register(
    options: {
      challenge: string;
      rp: { id?: string };
      user: { id: string };
    },
    o: CeremonyOverrides = {},
  ): Promise<Record<string, unknown>> {
    this.userHandle = options.user.id;
    const rpId = o.rpId ?? options.rp.id ?? "key.plrs.im";
    const authData = concat(
      await sha256(utf8(rpId)),
      new Uint8Array([(o.flags ?? this.defaultFlags()) | FLAG_AT]),
      u32(this.counter),
      new Uint8Array(16), // AAGUID: zeroes, as a browser that withholds it sends
      new Uint8Array([
        this.credentialId.length >> 8,
        this.credentialId.length & 0xff,
      ]),
      this.credentialId,
      await this.coseKey(),
    );
    const attestation = new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]);
    const clientData = this.clientData(
      o.type ?? "webauthn.create",
      o.challenge ?? options.challenge,
      o.origin ?? "https://key.plrs.im",
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        attestationObject: isoBase64URL.fromBuffer(
          isoCBOR.encode(attestation as never),
        ),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** `navigator.credentials.get(options).toJSON()`. */
  async assert(
    options: { challenge: string; rpId?: string },
    o: AssertionOverrides = {},
  ): Promise<Record<string, unknown>> {
    if (!this.synced && o.counter === undefined) this.counter += 1;
    const counter = o.counter ?? this.counter;
    const rpId = o.rpId ?? options.rpId ?? "key.plrs.im";
    const authData = concat(
      await sha256(utf8(rpId)),
      new Uint8Array([o.flags ?? this.defaultFlags()]),
      u32(counter),
    );
    const clientData = this.clientData(
      o.type ?? "webauthn.get",
      o.challenge ?? options.challenge,
      o.origin ?? "https://key.plrs.im",
    );
    const signer = o.signWith ?? this;
    const signature = await signer.sign(
      concat(authData, await sha256(clientData)),
    );
    const handle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(signature),
        ...(handle ? { userHandle: handle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
