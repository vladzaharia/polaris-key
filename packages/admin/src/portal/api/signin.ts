import { returnUrl } from "../carriedKey.js";
import type { KeyPreview } from "@polaris-key/protocol/identity";
import { call, readSsoNext, type PortalSsoNext } from "./transport.js";

/** A WebAuthn ceremony's options, as the Worker sends them (base64url strings). */
export interface PortalPasskeyOptions {
  options: Record<string, unknown>;
  expiresIn: number;
}

/** `GET /api/signin/confirm-email` (I-27, I-33): the finish step's state. No account id in it. */
export interface PortalGate {
  status: "gate";
  /** PX-21: a new account; false for an existing account that only owes terms. */
  newAccount?: boolean;
  /** `google`, `apple`, `steam`, `email`, … */
  provider: string;
  stage: "choose" | "code_sent" | "join_offer";
  expiresAt: number;
  /** False when the account has an email and only the profile and terms are asked. */
  emailRequired: boolean;
  email: {
    provider: string | null;
    providerVerified: boolean;
    relay: boolean;
    pending: string | null;
    confirmed: string | null;
  };
  profile: {
    name: string | null;
    nameExplicit: boolean;
    suggestions?: { name: string; source: string }[];
    /** Same-origin proxy path, or null. */
    picture: string | null;
    initials?: boolean;
    birthdate?: { value: string; offered: string; from: string } | null;
  };
  terms: { url: string; version: string } | null;
  platformTerms?: { url: string; version: string } | null;
  product: { slug: string; name: string | null } | null;
  join?: { email: string | null; proven: boolean };
}

/** What a gate POST sends: only what the step asked. */
export interface PortalGateChoice {
  choice?: "provider" | "typed";
  email?: string;
  name?: string;
  picture?: "provider" | "initials";
  birthdate?: string;
  termsVersion?: string;
  platformTermsVersion?: string;
}

/**
 * The email start's and the resend's one answer (I-07, PX-W4), the same whether or not mail went
 * out. The numbers are optional so an older Worker's bare `{ ok: true }` still reads.
 */
export interface PortalEmailSent {
  ok: true;
  /** Seconds the code and the link work. */
  expiresIn?: number;
  codeLength?: number;
  /** Seconds before "Send a new code" is accepted (the card's countdown). */
  resendIn?: number;
  /** I-30: the address's domain routes to a connection; nothing was sent. */
  next?: PortalSsoNext;
}

/**
 * `GET /api/signin/flow` (PX-12): this browser's email sign-in flow, read by the sign-in page after
 * the Worker's expired-link page sent a new code (`/?signin=code`). The address is masked
 * (`a•••@example.com`): it names the inbox, nothing more. `next` is a routed start that sent nothing.
 */
export interface PortalSignInFlow {
  email: string;
  expiresIn: number;
  codeLength: number;
  resendIn: number;
  next?: PortalSsoNext;
}

/** This tab started an email sign-in that has not finished yet (I-07). */
let signInPending = false;

export const signinApi = {
  /**
   * I-07's identifier-first email start: one email with a 6-digit code and a sign-in link
   * (SIGN-IN.md §3.4). `/api/magic/start` is the older alias of the same route.
   */
  startEmailSignIn: async (email: string): Promise<PortalEmailSent> => {
    const out = await call<PortalEmailSent>("/api/signin/email/start", {
      method: "POST",
      // Never the carried license key (carriedKey.ts).
      body: JSON.stringify({ email, returnTo: returnUrl() }),
    });
    // I-30: a routed start sent nothing, so this tab has no code to wait for yet.
    const next = readSsoNext(out?.next);
    if (next) return { ...out, next };
    if (out && "next" in out) delete out.next;
    signInPending = true;
    return out;
  },

  /**
   * PX-W4: "Send a new code" for this tab's email sign-in. The Worker mails the same address
   * (and keeps where the sign-in was headed), asks for no new security check, and retires the
   * previous code and link; starting again would need a fresh Turnstile token and leave the old
   * link alive.
   */
  resendSignInCode: async () => {
    const out = await call<PortalEmailSent>("/api/signin/email/resend", {
      method: "POST",
    });
    signInPending = true;
    return out;
  },

  /**
   * PX-12: this browser's sign-in flow, for the page the expired-link page's "Send a new code"
   * form lands on. `signin_expired` (no live flow) is the way back to the email step.
   */
  readSignInFlow: async (): Promise<PortalSignInFlow> => {
    const out = await call<PortalSignInFlow>("/api/signin/flow");
    const next = readSsoNext(out?.next);
    if (next) return { ...out, next };
    if (out && "next" in out) delete out.next;
    signInPending = true;
    return out;
  },

  /** Redeems the emailed code for this browser's sign-in (the Worker sets the session cookie). */
  verifySignInCode: async (code: string) => {
    const out = await call<{ status: string; next?: string; nudge?: boolean }>(
      "/api/signin/email/verify",
      { method: "POST", body: JSON.stringify({ code }) },
    );
    signInPending = false;
    return out;
  },

  /**
   * I-07: a sign-in link opened on another device only confirms THIS tab's sign-in; this tab
   * finishes it here (the Worker sets the session cookie). Asked only after this tab started
   * an email sign-in.
   */
  finishPendingSignIn: async (): Promise<boolean> => {
    if (!signInPending) return false;
    try {
      const out = await call<{ status: string }>("/api/signin/flow", {
        method: "POST",
      });
      if (out.status !== "pending") signInPending = false;
      return out.status === "signed_in";
    } catch {
      return false;
    }
  },

  /**
   * A passkey sign-in's challenge: the card's **Sign in with a passkey**, and how the account page
   * confirms it's you (step-up). `returnTo` is where a signed-out sign-in carries on.
   */
  passkeySignInOptions: (returnTo?: string) =>
    call<PortalPasskeyOptions>("/api/signin/passkey/options", {
      method: "POST",
      body: JSON.stringify(returnTo ? { returnTo } : {}),
    }),

  passkeySignInVerify: (response: unknown) =>
    call<{ status: string; next?: string; nudge?: boolean }>(
      "/api/signin/passkey/verify",
      {
        method: "POST",
        body: JSON.stringify({ response }),
      },
    ),

  /** The email gate's state (the finish step); a 400 means it expired or was never opened. */
  gate: () => call<PortalGate>("/api/signin/confirm-email"),

  /** Confirm the provider's email or a typed one, with the profile and terms choices. */
  gateChoose: (body: PortalGateChoice) =>
    call<
      | { status: "signed_in"; next: string; nudge: boolean }
      | {
          status: "code_sent";
          email: string;
          expiresIn: number;
          codeLength: number;
        }
    >("/api/signin/confirm-email", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  gateVerify: (code: string) =>
    call<{ status: "signed_in"; next: string; nudge: boolean }>(
      "/api/signin/confirm-email/verify",
      { method: "POST", body: JSON.stringify({ code }) },
    ),

  gateJoin: () =>
    call<{ status: "signed_in"; next: string; nudge: boolean }>(
      "/api/signin/confirm-email/join",
      { method: "POST", body: JSON.stringify({}) },
    ),

  gateCancel: () =>
    call<{ status: "cancelled" }>("/api/signin/confirm-email/cancel", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /** PX-W9: what a key would do, before anyone signs in. Read-only, never counted. */
  previewKeySignedOut: (key: string) =>
    call<KeyPreview>("/api/key/preview", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
};
