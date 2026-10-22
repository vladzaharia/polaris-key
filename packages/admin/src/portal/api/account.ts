import type { PortalProvider } from "./session.js";
import { call, enc } from "./transport.js";
import type { PortalPasskeyOptions } from "./signin.js";

// ── Account → Profile (PX-W16; PORTAL.md §4.30, G32, G33) ──────────────────────────────────

/** A stored picture: same-origin URLs only, WebP or PNG by the browser's `Accept`. */
export interface PortalAvatar {
  asset: string;
  /** 256 px. */
  url: string;
  /** 96 px. */
  url96: string;
}

/**
 * Where a profile value came from. `provider` is a sign-in method's import; its `provider` is null
 * once that method was disconnected (the value stays and follows nothing).
 */
export type PortalProfileSource =
  | { kind: "provider"; linkId: string; provider: string | null }
  | { kind: "typed" }
  | { kind: "upload" }
  | { kind: "initials" };

/** One sign-in method that supplied a name or a picture: the editor's chips and tiles. */
export interface PortalProfileSourceOption {
  linkId: string;
  /** `google`, `apple`, `steam`, later the platform identities. */
  provider: string;
  /** The connected identity (an address or a persona), as Sign-in methods shows it. */
  label: string | null;
  name: string | null;
  picture: PortalAvatar | null;
}

/** Where the birth date came from (I-33): typed here, or accepted from a connection's claim. */
export type PortalBirthdateSource =
  | { kind: "user" }
  | { kind: "connection"; connectionId: string };

/** `GET /api/me/profile`. */
export interface PortalProfile {
  /** The screen name. */
  displayName: string | null;
  displayNameSource: PortalProfileSource | null;
  explicitName: boolean;
  /** The picture in use; null shows initials. */
  picture: PortalAvatar | null;
  pictureSource: PortalProfileSource | null;
  explicitPicture: boolean;
  locale: string | null;
  sources: PortalProfileSourceOption[];
  /**
   * I-33: the optional birth date, `YYYY-MM-DD`, private to the person (no app or developer ever
   * receives it). Absent from a Worker before I-33.
   */
  birthdate?: string | null;
  birthdateSource?: PortalBirthdateSource | null;
}

/** `PATCH /api/me/profile`: every value it sets is an explicit choice that sticks. */
export interface PortalProfileChange {
  /** A typed name. */
  name?: string;
  /** A sign-in method's name, by the method's id. */
  nameFrom?: string;
  picture?: "initials" | { from: string } | { upload: string };
  /** I-33: a birth date (`YYYY-MM-DD`), or `null` to remove it. */
  birthdate?: string | null;
}

// ── Account → Sign-in methods (PX-W12, I-16; PORTAL.md §4.26, G27) ─────────────────────────

/** Why a method cannot be removed now: the account's only method, or its only email address. */
export type PortalRemoveRefusal = "last_link" | "only_email";

/** One sign-in method (`GET /api/me/methods` `methods[]`). */
export interface PortalMethod {
  /** The method's id: the path segment that disconnects it. */
  id: string;
  /** `google`, `apple`, `steam`, `email`, `passkey`, `gamecenter`, `pgs`, `eos`, `oidc` … */
  kind: string;
  group: "accounts" | "email" | "passkeys";
  /** The method by its own name ("Google", "Game Center"). */
  label: string;
  /** The connected identity: an address, a persona, a passkey's browser. */
  display: string | null;
  connectedAt: number;
  lastUsedAt: number | null;
  canRemove: boolean;
  reason: PortalRemoveRefusal | null;
  /** What the provider reported since linking (`consent_revoked`, …). */
  flag?: string | null;
  /** Apple only: a Hide My Email relay address. */
  relay?: boolean;
  /** Recognised only inside one developer's products (Game Center, Play Games). */
  tenantScoped?: boolean;
}

/** One verified address (`emails[]`), the primary first. */
export interface PortalMethodEmail {
  methodId: string;
  email: string;
  primary: boolean;
  /** Products this address brought in (PX-W19); absent on an older Worker. */
  productCount?: number;
  connectedAt: number;
  lastUsedAt: number | null;
  canRemove: boolean;
  reason: PortalRemoveRefusal | null;
}

/** One passkey (I-16's `PasskeyView`, plus what the methods list adds). */
export interface PortalPasskey {
  /** The credential id (base64url): what a sign-in names it by. */
  id: string;
  /** Its sign-in method's id. */
  methodId: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string[];
  synced: boolean | null;
  /** The authenticator model, when the browser disclosed it. */
  aaguid: string | null;
  /** The browser it was added from ("Safari on macOS"). */
  addedFrom: string | null;
  /** The name its holder gave it (PX-W19), or null; absent on an older Worker. */
  name?: string | null;
  canRemove?: boolean;
  reason?: PortalRemoveRefusal | null;
}

/** One side of the join screen (`GET /api/me/link`): never an account id. */
export interface PortalLinkAccount {
  role: "started" | "other";
  /** The account this browser is signed in to now. */
  current: boolean;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  methods: string[];
  products: number;
  proven: { by: string | null; at: number; fresh: boolean };
}

export type PortalLinkReason =
  | "sign_in_other"
  | "step_up_required"
  | "merge_pending"
  | "unavailable";

/** `GET /api/me/link`: the join screen, and the joins this account can still undo. */
export interface PortalLinkView {
  flow: {
    expiresAt: number;
    started: PortalLinkAccount | null;
    other: PortalLinkAccount | null;
    canJoin: boolean;
    reason: PortalLinkReason | null;
    keep: "other" | "started";
    result: { products: number; primaryEmail: string | null } | null;
  } | null;
  undoable: {
    id: string;
    mergedAt: number;
    undoUntil: number;
    joined?: { email: string | null; name: string | null };
  }[];
}

/** `GET /api/me/methods`. */
export interface PortalMethods {
  methods: PortalMethod[];
  emails: PortalMethodEmail[];
  passkeys: PortalPasskey[];
  /** Apple, Google and Steam, always; `available` says whether this deploy can connect it. */
  providers: {
    kind: PortalProvider;
    connected: boolean;
    available: boolean;
  }[];
  /** Whether a passkey can be added now, and why not. */
  passkey: { canAdd: boolean; reason: "email_unverified" | "limit" | null };
  primaryEmail: string | null;
  /** The primary email is an Apple Hide My Email relay. */
  hideMyEmail: boolean;
  /** Whether this session signed in recently enough (5 minutes) for a change. */
  stepUp: {
    authenticatedAt: number;
    freshUntil: number;
    fresh: boolean;
    maxAgeSeconds: number;
  };
}

/** `POST /api/me/methods/email/start`: a code went out, or the address is already this account's. */
export type PortalEmailMethodStart =
  | {
      status: "code_sent";
      email: string;
      expiresIn: number;
      codeLength: number;
    }
  | { status: "connected"; already: true; email: string };

export const accountApi = {
  /** Account → Profile (PX-W16): the profile, its sources and what each method supplied. */
  profile: () => call<{ profile: PortalProfile }>("/api/me/profile"),

  /** An explicit choice (a typed or picked name; Initials, a method's picture or an upload). */
  updateProfile: (change: PortalProfileChange) =>
    call<{ profile: PortalProfile }>("/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify(change),
    }),

  /**
   * A picture upload (PNG or JPEG, at most 5 MB; the Worker judges by the bytes, re-encodes and
   * crops it square). It stays unused until a PATCH picks it.
   */
  uploadPicture: (file: Blob) =>
    call<{ upload: PortalAvatar }>("/api/me/profile/picture", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }),

  /** Link an existing account (PX-W12): the join screen and the joins still undoable. */
  linkView: () => call<PortalLinkView>("/api/me/link"),

  /** Start a join (step-up first); `next` is where to sign in to the other account. */
  linkStart: () =>
    call<{ status: "started"; expiresAt: number; next: string }>(
      "/api/me/link/start",
      { method: "POST" },
    ),

  linkConfirm: () =>
    call<{
      status: "joined";
      kept: "other" | "started";
      merge?: { id: string; undoUntil: number };
    }>("/api/me/link/confirm", { method: "POST", body: "{}" }),

  linkCancel: () =>
    call<{ status: "cancelled" }>("/api/me/link/cancel", { method: "POST" }),

  linkUndo: (merge: string) =>
    call<{ status: string }>("/api/me/link/undo", {
      method: "POST",
      body: JSON.stringify({ merge }),
    }),

  /** Account → Sign-in methods (PX-W12): every method, grouped, and what each allows. */
  methods: () => call<PortalMethods>("/api/me/methods"),

  /** Connect Apple, Google or Steam: the provider URL to open (step-up first). */
  startProviderMethod: (kind: PortalProvider) =>
    call<{ redirect: string; expiresIn: number }>(
      `/api/me/methods/${enc(kind)}/start`,
      { method: "POST" },
    ),

  /** Add an email: a code to the address (the same answer whoever holds it). */
  startEmailMethod: (email: string) =>
    call<PortalEmailMethodStart>("/api/me/methods/email/start", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  verifyEmailMethod: (code: string) =>
    call<{ status: "connected"; already: boolean; email: string }>(
      "/api/me/methods/email/verify",
      { method: "POST", body: JSON.stringify({ code }) },
    ),

  /** Add a passkey, step 1: the registration challenge (I-16, through PX-W12's start). */
  passkeyRegistrationOptions: () =>
    call<PortalPasskeyOptions>("/api/me/methods/passkey/start", {
      method: "POST",
    }),

  /** Add a passkey, step 2: the browser's attestation. */
  addPasskey: (response: unknown) =>
    call<{ ok: true; passkey: { id: string; methodId: string } }>(
      "/api/me/passkeys",
      { method: "POST", body: JSON.stringify({ response }) },
    ),

  /** Disconnect a method (step-up; never the last one). */
  removeMethod: (id: string) =>
    call<{ ok: true; removed: { id: string; kind: string } }>(
      `/api/me/methods/${enc(id)}`,
      { method: "DELETE" },
    ),

  /** Make a verified email the primary (PX-W19; step-up). The answer is the methods list. */
  makePrimary: (methodId: string) =>
    call<PortalMethods>(`/api/me/methods/${enc(methodId)}/primary`, {
      method: "POST",
    }),

  /** Name a passkey, or clear its name with `null` (PX-W19; step-up). */
  renamePasskey: (passkeyId: string, name: string | null) =>
    call<{ passkeys: PortalPasskey[] }>(`/api/me/passkeys/${enc(passkeyId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
};
