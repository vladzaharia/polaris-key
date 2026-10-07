/**
 * The browser half of passkeys (I-16) for the account page (PX-13): adding one, and confirming
 * it's you with one before an account change (step-up). The Worker sends WebAuthn options as JSON
 * with base64url strings (SimpleWebAuthn's shape) and reads the credential back as
 * `PublicKeyCredential.toJSON()` would write it. Browsers that lack those JSON helpers get the
 * same conversion here, so nothing depends on them.
 */

export type PasskeyFailure =
  /** The person closed the prompt, or it timed out (`NotAllowedError`). */
  | "cancelled"
  /** This authenticator already holds a passkey for the account (`InvalidStateError`). */
  | "exists"
  /** This browser can't use passkeys here. */
  | "unsupported"
  | "failed";

export class PasskeyError extends Error {
  constructor(public readonly reason: PasskeyFailure) {
    super(`passkey ${reason}`);
    this.name = "PasskeyError";
  }
}

/** Whether this browser can create and use passkeys at all. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    navigator.credentials != null
  );
}

function toBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toB64url(buf: ArrayBuffer | ArrayBufferView | null): string {
  if (!buf) return "";
  const bytes =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Descriptor = { id: string; type?: string; transports?: string[] };

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] {
  if (!Array.isArray(list)) return [];
  return (list as Descriptor[]).map((d) => ({
    id: toBuffer(d.id),
    type: "public-key",
    ...(d.transports
      ? { transports: d.transports as AuthenticatorTransport[] }
      : {}),
  }));
}

function failure(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError")
    return new PasskeyError("cancelled");
  if (name === "InvalidStateError") return new PasskeyError("exists");
  if (name === "NotSupportedError" || name === "SecurityError")
    return new PasskeyError("unsupported");
  return new PasskeyError("failed");
}

/** Add a passkey: the registration options in, the attestation (as JSON) out. */
export async function createPasskey(
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!passkeysSupported()) throw new PasskeyError("unsupported");
  const user = options.user as {
    id: string;
    name: string;
    displayName: string;
  };
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: toBuffer(options.challenge as string),
    user: { ...user, id: toBuffer(user.id) },
    excludeCredentials: descriptors(options.excludeCredentials),
  };
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey,
    })) as PublicKeyCredential | null;
  } catch (err) {
    throw failure(err);
  }
  if (!cred) throw new PasskeyError("cancelled");
  const res = cred.response as AuthenticatorAttestationResponse;
  const transports =
    typeof res.getTransports === "function" ? res.getTransports() : [];
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(res.clientDataJSON),
      attestationObject: toB64url(res.attestationObject),
      transports,
    },
    clientExtensionResults: {},
    authenticatorAttachment: cred.authenticatorAttachment ?? null,
  };
}

/**
 * Sign in with a passkey: the request options in, the assertion (as JSON) out. `allow` limits
 * the browser's choice to this account's own passkeys, so a step-up cannot sign in to another
 * account by mistake.
 */
export async function passkeyAssertion(
  options: Record<string, unknown>,
  allow: readonly { id: string; transports: readonly string[] }[] = [],
): Promise<Record<string, unknown>> {
  if (!passkeysSupported()) throw new PasskeyError("unsupported");
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: toBuffer(options.challenge as string),
    allowCredentials: allow.length
      ? descriptors(
          allow.map((a) => ({ id: a.id, transports: [...a.transports] })),
        )
      : descriptors(options.allowCredentials),
  };
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey,
    })) as PublicKeyCredential | null;
  } catch (err) {
    throw failure(err);
  }
  if (!cred) throw new PasskeyError("cancelled");
  const res = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(res.clientDataJSON),
      authenticatorData: toB64url(res.authenticatorData),
      signature: toB64url(res.signature),
      ...(res.userHandle ? { userHandle: toB64url(res.userHandle) } : {}),
    },
    clientExtensionResults: {},
    authenticatorAttachment: cred.authenticatorAttachment ?? null,
  };
}
