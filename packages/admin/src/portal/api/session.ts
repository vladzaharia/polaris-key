import { call, enc, http, type PortalConnection } from "./transport.js";

export interface PortalAccount {
  id: string;
  name: string;
  email: string;
  /** A soft account deletion, until its 14-day due time; absent on a Worker before I-11. */
  deletion?: { requestedAt: number; dueAt: number } | null;
  /**
   * The picture in use (PX-W16): a same-origin `/media/avatar/<asset>` URL (256 px; `-96` names
   * the small one), or null for initials. Absent on an older Worker, which means initials.
   */
  avatarUrl?: string | null;
  /**
   * ST-30: the console's address, for an operator's account only (else null or absent). It decides
   * whether the account menu offers "Open console"; the console checks access itself.
   */
  console?: string | null;
}

export interface PortalMe {
  account: PortalAccount;
  csrf: string;
}

/** The sign-in providers the login card can show (PORTAL.md §4.1), in display order. */
export type PortalProvider = "apple" | "google" | "steam";

export interface PortalCapabilities {
  auth: {
    oidc: boolean;
    magic: boolean;
    /**
     * The single sign-on provider's display name. Not sent by today's Worker (G11): the card
     * falls back to "Continue with single sign-on".
     */
    oidcName?: string;
    /**
     * Apple, Google and Steam for this context (G11, S-16). Not sent by today's Worker: the
     * provider row renders only when the list is present and non-empty.
     */
    providers?: PortalProvider[];
    /**
     * I-30: the platform connections for customers besides the seeded one (that one is `oidc`),
     * each a "Continue with <label>" button to `/login/sso/<id>`. Absent on an older Worker.
     */
    connections?: PortalConnection[];
    /** I-16: passkeys are an account sign-in method (platform-level; absent on an older Worker). */
    passkey?: boolean;
  };
  /**
   * The product named by `?product=`, for the login card's context header (G1/G28). Not sent by
   * today's Worker: without it the card shows no header rather than a slug.
   */
  product?: {
    slug: string;
    name: string;
    developerName?: string | null;
    /** The product's art for the landscape passport (PX-33); same-origin, display data only. */
    artUrl?: string | null;
  };
  /**
   * I-07: the public Turnstile site key the email start asks a token for; null (or absent on an
   * older Worker) when the deploy has Turnstile off and no token is asked for.
   */
  turnstileSiteKey?: string | null;
  modules: {
    licensing: boolean;
    claim: boolean;
    releases: boolean;
  };
}

/** One live session of the account (`GET /api/sessions`, I-07), newest first. */
export interface PortalSession {
  /** The row key (a hash, never a cookie): the path segment that ends it. */
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** "Firefox on Windows", when known. */
  browser?: string | null;
  /** How it signed in (`passkey`, `email`, `google`, …). */
  methods: string[];
  /** This browser. */
  current: boolean;
}

/** `GET /api/storefront/<slug>` (LK-12d): a Discover-visible product's name and icon. */
export interface PortalStorefrontName {
  name: string;
  iconUrl: string | null;
}

export const sessionApi = {
  /** Signed out; a product Discover would not offer is a 404, the same as an unknown one. */
  storefrontName: (slug: string) =>
    call<PortalStorefrontName>(`/api/storefront/${enc(slug)}`),

  capabilities: (product?: string | null) =>
    call<PortalCapabilities>(
      product
        ? `/api/capabilities?product=${enc(product)}`
        : "/api/capabilities",
    ),

  me: () => call<PortalMe>("/api/me"),

  deleteMe: () =>
    call<{ ok: true; scheduled: true; deletionDueAt: number }>("/api/me", {
      method: "DELETE",
    }),

  cancelDeletion: () =>
    call<{ ok: true }>("/api/me/deletion/cancel", { method: "POST" }),

  /** Where you're signed in (I-07): the account's live sessions. */
  sessions: () => call<{ sessions: PortalSession[] }>("/api/sessions"),

  endSession: (id: string) =>
    call<{ ok: true; current: boolean }>(`/api/sessions/${enc(id)}`, {
      method: "DELETE",
    }),

  /** "Not you?": ends this browser's session and stays on the card. */
  signOutHere: async (): Promise<void> => {
    // No CSRF binder here, and the redirect is not followed: only "the request was made" matters.
    await http.send(
      "/logout",
      { method: "POST", redirect: "manual" },
      { raw: true, csrf: false },
    );
  },

  /** Every session and app of the account, this browser's included. */
  signOutEverywhere: () =>
    call<{ ok: true; ended: number; devices?: number }>(
      "/api/sessions/sign-out-everywhere",
      { method: "POST" },
    ),
};
