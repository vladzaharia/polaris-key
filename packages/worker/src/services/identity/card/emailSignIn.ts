/**
 * Email sign-in on the login card (I-07; S-16 §5.4 item 4; PORTAL.md §4.1, §4.4): one email
 * carrying a 6-digit code and a magic link, both bound to the browser that asked.
 *
 * ── THE FLOW ────────────────────────────────────────────────────────────────────────────────
 *
 *   `POST /api/signin/email/start {email, turnstileToken?, returnTo?}` opens a flow: a random
 *   secret in a host-only cookie (`__Host-pkey_signin`, 10 minutes) names a record in I-02's
 *   single-use store. If every send limit passes, a code (on the same store, bound to the
 *   recipient AND the flow) and a magic link go out in one email.
 *
 *   `POST /api/signin/email/verify {code}` redeems the code for the flow in this browser. Right:
 *   the flow is consumed (atomically: one completion only) and the account session opens.
 *
 *   `POST /api/signin/email/resend` (PX-W4; PORTAL.md §4.4 "Resend") retires this browser's flow
 *   atomically and opens a new one for the same address and `returnTo`: a new code and link go out,
 *   and the previous ones stop working. It needs no new Turnstile token (the flow passed one); it
 *   waits `EMAIL_RESEND_AFTER_SECONDS` after the last code and sends at most `EMAIL_SENDS_PER_FLOW`
 *   emails per flow, its start included, so one Turnstile pass buys at most one hour's
 *   per-recipient budget.
 *
 *   `GET /magic/verify?token=` is a landing page that consumes NOTHING (link prefetchers and
 *   mail scanners cannot burn the link); its button `POST`s the token back. In the browser that
 *   asked, that completes the sign-in. Anywhere else it shows "Confirm sign-in, requested at
 *   <time> from <place>" and, on `POST`, only marks the flow confirmed; the asking browser picks
 *   that up with `POST /api/signin/flow` and signs in there. A link opened on another device
 *   never signs THAT device in (relay phishing yields at most the attacker's own flow, item 14).
 *
 * ── ENUMERATION SAFETY ──────────────────────────────────────────────────────────────────────
 *
 * The start never looks the address up. Known address, unknown address, a refused send (a
 * locked-out recipient, any limit) and a suppressed recipient all answer the same bytes; only a
 * deploy that cannot send mail at all answers `503 email_unavailable`, a fact about the platform
 * that names no one. The address-specific answer (a join offer) comes only after the code proved
 * the address.
 *
 * The resend answers the start's bytes too, whether or not mail went out; its other answers (wait,
 * too many for this flow, expired) are facts about this browser's own flow, never the address.
 *
 * Limits and lifetimes are I-02's (`core/emailLimits.ts`), scoped to the platform bucket
 * `_portal`: 6 digits, 10 minutes, 5 wrong attempts per code, lockout after 10 an hour, 5 sends
 * an hour and 20 a day per recipient, per-IP and per-network hourly caps.
 */

import { hashKey, type Db, type Env } from "../../../core/platform.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import {
  artefactRef,
  consumeArtefact,
  deleteArtefact,
  getArtefact,
  putArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import {
  checkEmailSend,
  EMAIL_CODE_DIGITS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_SECONDS,
  EMAIL_SEND_PER_RECIPIENT_HOUR,
  issueEmailCode,
  verifyEmailCode,
} from "../../../core/emailLimits.js";
import {
  SIGNIN_FLOW_COOKIE,
  accountRealmCookie,
  clearAccountRealmCookie,
  readCookie,
} from "../../../core/accountCookies.js";
import { escapeHtml } from "../../../core/brandHtml.js";
import { signIn } from "../accounts/signIn.js";
import { EMAIL_ISSUER } from "../accounts/repo.js";
import { portalAuthCapabilities } from "../portal/repo.js";
import { portalEmailConfigured, sendSignInEmail } from "../portal/email.js";
import { randomSecret } from "../portal/accountSessions.js";
import { finishSignIn } from "./finish.js";
import {
  cardJson,
  cardPage,
  cardRedirect,
  parseEmail,
  readJsonObject,
  requestPlace,
  safeReturnTo,
  signInAgainAction,
  utcLabel,
  wrongCodeMessage,
} from "./http.js";
import { verifyTurnstile } from "./turnstile.js";

/** The rate-limit and email-limit scope of platform (account) sign-in. */
export const PORTAL_EMAIL_SCOPE = "_portal";
/** Email starts from one client address per minute (the existing `portalMagic` bucket). */
export const EMAIL_START_PER_IP_MINUTE = 8;
/** Code verifications from one client address per minute, across flows. */
export const CODE_VERIFY_PER_IP_MINUTE = 30;
/** Seconds after a code before this browser may ask for another (the card's resend countdown). */
export const EMAIL_RESEND_AFTER_SECONDS = 60;
/**
 * Emails one email sign-in may send, its start included: one hour of the per-recipient budget.
 * The resend asks for no new Turnstile token, so this is what one Turnstile pass can buy.
 */
export const EMAIL_SENDS_PER_FLOW = EMAIL_SEND_PER_RECIPIENT_HOUR;

interface FlowRecord {
  v: 1;
  email: string;
  createdAt: number;
  place: string;
  returnTo?: string;
  status: "pending" | "confirmed";
  attempts: number;
  confirmedAt?: number;
  /** Emails this sign-in has asked for, its start included (PX-W4; absent on older flows: 1). */
  sends?: number;
  /** The store id of the magic link minted with the current code (PX-W4), so a resend retires it. */
  link?: string;
}

interface MagicRecord {
  email: string;
  /** The flow this link completes (absent on a link minted before I-07). */
  flow?: string;
  requestedAt?: number;
  place?: string;
  returnTo?: string;
}

/** The single-use address of a flow, from the secret in its browser's cookie. */
export async function signinFlowRef(
  env: Env,
  secret: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "signin-flow",
    await hashKey(`signin-flow:${secret}`, env.KEY_HASH_PEPPER),
  );
}

/** The single-use address of a magic link, from its token (R12-04: never the token itself). */
export async function portalMagicKey(
  env: Env,
  token: string,
): Promise<ArtefactRef> {
  return artefactRef("portal-magic", await hashKey(token, env.KEY_HASH_PEPPER));
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** This browser's live flow, if any. */
async function currentFlow(
  env: Env,
  req: Request,
): Promise<{ ref: ArtefactRef; record: FlowRecord } | null> {
  const secret = readCookie(req.headers.get("cookie"), SIGNIN_FLOW_COOKIE);
  if (!secret) return null;
  const ref = await signinFlowRef(env, secret);
  const record = parse<FlowRecord>(await getArtefact(env, ref));
  return record ? { ref, record } : null;
}

const clearFlow = (): string => clearAccountRealmCookie(SIGNIN_FLOW_COOKIE);

function expired(cookies: string[] = [clearFlow()]): Response {
  return cardJson(
    {
      error: "signin_expired",
      message: "This sign-in has expired. Start again.",
    },
    400,
    cookies,
  );
}

/** `POST /api/signin/email/start` (and the older `POST /api/magic/start`). */
export async function handleSigninEmailStart(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  if (req.method !== "POST")
    return cardJson({ error: "method_not_allowed" }, 405);
  const allowed = await rateLimitOk(
    env,
    PORTAL_EMAIL_SCOPE,
    {
      bucket: "portalMagic",
      id: clientIp(req),
      limit: EMAIL_START_PER_IP_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return cardJson({ error: "rate_limited" }, 429);
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.magicEnabled) {
    return cardJson(
      { error: "auth_method_disabled", message: "email sign-in is disabled" },
      404,
    );
  }
  const body = await readJsonObject(req);
  if (!body)
    return cardJson({ error: "bad_request", message: "invalid json" }, 400);
  const email = parseEmail(body.email);
  if (!email) {
    return cardJson(
      { error: "bad_request", message: "valid email required" },
      422,
    );
  }
  const returnTo = safeReturnTo(req, body.returnTo);
  if (body.returnTo !== undefined && body.returnTo !== null && !returnTo) {
    return cardJson(
      { error: "bad_request", message: "invalid return URL" },
      400,
    );
  }
  if (!(await verifyTurnstile(env, req, body.turnstileToken))) {
    return cardJson(
      {
        error: "turnstile_failed",
        message: "The security check did not pass. Try again.",
      },
      403,
    );
  }
  if (!portalEmailConfigured(env)) return emailUnavailable();
  return openFlow(req, env, db, { email, returnTo, sends: 1 }, now);
}

/**
 * Open a flow for `email` bound to a fresh browser secret and, if every send limit passes, mail its
 * code and link. The answer is the same bytes whether or not mail went out (enumeration safety);
 * only a sender that cannot send at all answers `503 email_unavailable`.
 */
async function openFlow(
  req: Request,
  env: Env,
  db: Db,
  input: { email: string; returnTo?: string; sends: number },
  now: number,
): Promise<Response> {
  const { email, returnTo } = input;
  const secret = randomSecret(32);
  const ref = await signinFlowRef(env, secret);
  const place = requestPlace(req);
  // The link's address is minted first so the flow can name it: a resend retires it.
  const token = randomSecret(24);
  const magicRef = await portalMagicKey(env, token);
  const record: FlowRecord = {
    v: 1,
    email,
    createdAt: now,
    place,
    ...(returnTo ? { returnTo } : {}),
    status: "pending",
    attempts: 0,
    sends: input.sends,
    link: magicRef.id,
  };
  await putArtefact(env, ref, JSON.stringify(record), EMAIL_CODE_TTL_SECONDS);

  // Every refusal past this point answers exactly like a send (enumeration safety).
  const { send } = await checkEmailSend(
    env,
    { product: PORTAL_EMAIL_SCOPE, recipient: email, req },
    now,
  );
  if (send) {
    const { code } = await issueEmailCode(
      env,
      { product: PORTAL_EMAIL_SCOPE, recipient: email, flowId: ref.id },
      JSON.stringify({ flow: ref.id }),
    );
    const magic: MagicRecord = {
      email,
      flow: ref.id,
      requestedAt: now,
      place,
      ...(returnTo ? { returnTo } : {}),
    };
    await putArtefact(
      env,
      magicRef,
      JSON.stringify(magic),
      EMAIL_CODE_TTL_SECONDS,
    );
    const link = new URL("/magic/verify", new URL(req.url).origin);
    link.searchParams.set("token", token);
    const sent = await sendSignInEmail(
      env,
      db,
      email,
      { code, link: link.toString(), purpose: "signin" },
      now,
    );
    if (sent === "unavailable") {
      await deleteArtefact(env, magicRef);
      await deleteArtefact(env, ref);
      return emailUnavailable();
    }
  }
  return cardJson(
    {
      ok: true,
      expiresIn: EMAIL_CODE_TTL_SECONDS,
      codeLength: EMAIL_CODE_DIGITS,
      resendIn: EMAIL_RESEND_AFTER_SECONDS,
    },
    200,
    [accountRealmCookie(SIGNIN_FLOW_COOKIE, secret, EMAIL_CODE_TTL_SECONDS)],
  );
}

/** A resend asked for too early (or lost a race to another): this browser's own state. */
function resendLater(retryAfter: number): Response {
  const res = cardJson(
    {
      error: "rate_limited",
      message: "Wait a minute, then send a new code.",
      retryAfter,
    },
    429,
  );
  res.headers.set("retry-after", String(retryAfter));
  return res;
}

/** `POST /api/signin/email/resend`: a new code and link for this browser's flow (PX-W4). */
export async function handleSigninEmailResend(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  if (req.method !== "POST")
    return cardJson({ error: "method_not_allowed" }, 405);
  // One budget with the start: both ask for mail. Its refusal carries a wait (the minute
  // window's upper bound), so a 429 without `retryAfter` means only the per-flow cap below.
  const allowed = await rateLimitOk(
    env,
    PORTAL_EMAIL_SCOPE,
    {
      bucket: "portalMagic",
      id: clientIp(req),
      limit: EMAIL_START_PER_IP_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return resendLater(60);
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.magicEnabled) {
    return cardJson(
      { error: "auth_method_disabled", message: "email sign-in is disabled" },
      404,
    );
  }
  const flow = await currentFlow(env, req);
  // The cookie is left alone: on a double click, the second request still carries the flow the
  // first one just retired, and clearing it here would drop the new flow's cookie the first
  // answer set.
  if (!flow) return expired([]);
  const sends = flow.record.sends ?? 1;
  if (sends >= EMAIL_SENDS_PER_FLOW) {
    // The flow stays: its latest code and link still work.
    return cardJson(
      {
        error: "rate_limited",
        message: "Too many codes for this sign-in. Start again.",
      },
      429,
    );
  }
  const wait = flow.record.createdAt + EMAIL_RESEND_AFTER_SECONDS - now;
  if (wait > 0) return resendLater(wait);
  if (!portalEmailConfigured(env)) return emailUnavailable();
  // Retire the flow atomically: of two racing resends (or a resend and a completion) one wins,
  // and the previous code and link die with it (both are bound to its id).
  if (!(await consumeArtefact(env, flow.ref)))
    return resendLater(EMAIL_RESEND_AFTER_SECONDS);
  if (flow.record.link) {
    await deleteArtefact(env, artefactRef("portal-magic", flow.record.link));
  }
  return openFlow(
    req,
    env,
    db,
    {
      email: flow.record.email,
      ...(flow.record.returnTo ? { returnTo: flow.record.returnTo } : {}),
      sends: sends + 1,
    },
    now,
  );
}

/** Mail cannot leave at all (no binding, the sender capped or failing): a platform fact. */
export function emailUnavailable(): Response {
  return cardJson(
    {
      error: "email_unavailable",
      message: "We can't send email right now. Try another way to sign in.",
    },
    503,
  );
}

/** `POST /api/signin/email/verify {code}`. */
export async function handleSigninEmailVerify(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  if (req.method !== "POST")
    return cardJson({ error: "method_not_allowed" }, 405);
  const allowed = await rateLimitOk(
    env,
    PORTAL_EMAIL_SCOPE,
    {
      bucket: "portalCodeVerify",
      id: clientIp(req),
      limit: CODE_VERIFY_PER_IP_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return cardJson({ error: "rate_limited" }, 429);
  const flow = await currentFlow(env, req);
  if (!flow) return expired();
  const body = await readJsonObject(req);
  const code = typeof body?.code === "string" ? body.code : "";
  const result = await verifyEmailCode(env, {
    product: PORTAL_EMAIL_SCOPE,
    recipient: flow.record.email,
    flowId: flow.ref.id,
    code,
  });
  if (!result.ok) {
    const attempts = flow.record.attempts + 1;
    await updateArtefact(env, flow.ref, {
      expect: { attempts: flow.record.attempts },
      set: { attempts },
    });
    return cardJson(
      {
        error: "invalid_code",
        message: wrongCodeMessage(
          Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - attempts),
        ),
        triesLeft: Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - attempts),
      },
      400,
    );
  }
  // One completion only: of two racing verifications (or a code and a link), one wins. A loser
  // leaves the cookie alone: the winner may be a resend that just set the new flow's (PX-W4).
  if (!(await consumeArtefact(env, flow.ref))) return expired([]);
  return completeEmailSignIn(req, env, db, flow.record, now, "json");
}

/** `POST /api/signin/flow`: the asking browser's poll after a link was confirmed elsewhere. */
export async function handleSigninFlowPoll(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  if (req.method !== "POST")
    return cardJson({ error: "method_not_allowed" }, 405);
  const flow = await currentFlow(env, req);
  if (!flow) return cardJson({ status: "expired" }, 200, [clearFlow()]);
  if (flow.record.status !== "confirmed") {
    return cardJson({
      status: "pending",
      expiresAt: flow.record.createdAt + EMAIL_CODE_TTL_SECONDS,
    });
  }
  if (!(await consumeArtefact(env, flow.ref)))
    return cardJson({ status: "expired" }, 200, [clearFlow()]);
  return completeEmailSignIn(req, env, db, flow.record, now, "json");
}

/** The account behind a proven address, signed in. JSON for the card, a redirect for a link. */
async function completeEmailSignIn(
  req: Request,
  env: Env,
  db: Db,
  record: { email: string; returnTo?: string },
  now: number,
  answer: "json" | "redirect",
): Promise<Response> {
  const result = await signIn(
    db,
    { issuerKey: EMAIL_ISSUER, subject: record.email, kind: "email" },
    now,
  );
  if (result.status !== "signed_in" || result.account.status !== "active") {
    const inUse = result.status === "join_offer";
    const message = inUse
      ? "A Polaris Key account already uses this email address, but not as a way to sign in. Sign in with the method you used before; you can add this email to that account afterwards."
      : "This account can't sign in. Contact Polaris Key support.";
    return answer === "json"
      ? cardJson(
          inUse
            ? { error: "email_in_use", message }
            : { error: "forbidden", message },
          inUse ? 409 : 403,
          [clearFlow()],
        )
      : cardPage(
          inUse ? 409 : 403,
          inUse
            ? { title: "Sign in", heading: message }
            : {
                title: "Sign in",
                heading: "This account can't sign in",
                body: "<p>Contact Polaris Key support.</p>",
              },
          [clearFlow()],
        );
  }
  const finished = await finishSignIn(
    env,
    db,
    req,
    result.account,
    {
      amr: ["email"],
      action: "portal.login.email",
      summary: "Signed in with an email code or link",
    },
    now,
  );
  const next = record.returnTo ?? "/";
  return answer === "json"
    ? cardJson({ status: "signed_in", next, nudge: finished.nudge }, 200, [
        finished.cookie,
        clearFlow(),
      ])
    : cardRedirect(next, [finished.cookie, clearFlow()]);
}

/**
 * The expired or used code/link page (SIGN-IN.md §3.13, frame 15). The spec's **Send a new code**
 * (a POST to the masked address) is the resend route's, but a flow lives exactly as long as its
 * link, so by the time a link has expired this page knows no address to send to: it takes the
 * spec's "without a known address" branch and offers **Sign in again**, back to where the sign-in
 * was headed when the link's record still says so.
 */
function expiredLinkPage(returnTo?: string): Response {
  return cardPage(400, {
    title: "Sign in",
    heading: "That code or link has expired", // signin.expired.title
    body: `<p>Codes and links work once, for 10 minutes.</p>${signInAgainAction(returnTo ?? "/")}`, // signin.expired.body
  });
}

/** Email sign-in is off: `signin.off.any` (the card has no product context here). */
function signInOffPage(): Response {
  return cardPage(404, {
    title: "Sign in",
    heading: "Sign-in is unavailable. Try again later.", // signin.off.any
  });
}

/** Whether this request comes from the browser that started `flowId`. */
async function isAskingBrowser(
  env: Env,
  req: Request,
  flowId: string | undefined,
): Promise<boolean> {
  if (!flowId) return true; // a link minted before I-07 has no flow to bind to
  const secret = readCookie(req.headers.get("cookie"), SIGNIN_FLOW_COOKIE);
  return secret !== null && (await signinFlowRef(env, secret)).id === flowId;
}

/** `GET /magic/verify?token=`: the landing page. Consumes nothing. */
export async function handleMagicLanding(
  req: Request,
  env: Env,
  db: Db,
): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return expiredLinkPage();
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.magicEnabled) {
    return signInOffPage();
  }
  const record = parse<MagicRecord>(
    await getArtefact(env, await portalMagicKey(env, token)),
  );
  if (!record) return expiredLinkPage();
  const form = (label: string) =>
    `<form method="post" action="/magic/verify"><input type="hidden" name="token" value="${escapeHtml(token)}"><p class="actions"><button class="button" type="submit">${escapeHtml(label)}</button></p></form>`;
  if (await isAskingBrowser(env, req, record.flow)) {
    return cardPage(200, {
      title: "Sign in",
      heading: "Sign in to Polaris Key",
      body: `<p>Continue as ${escapeHtml(record.email)}.</p>${form("Sign in")}`,
    });
  }
  const when =
    typeof record.requestedAt === "number"
      ? utcLabel(record.requestedAt)
      : "a few minutes ago";
  return cardPage(200, {
    title: "Confirm sign-in",
    // signin.confirmLink.title
    heading: `Confirm sign-in, requested at ${when} from ${record.place ?? "an unknown location"}`,
    body:
      `<p>Polaris Key account ${escapeHtml(record.email)}. Confirm only if you started it.</p>` +
      `<p>The device that asked signs in, not this one.</p>` + // signin.confirmLink.note
      form("Confirm"),
  });
}

/** `POST /magic/verify` (form `token=`): completes here, or confirms the asking browser's flow. */
export async function handleMagicConfirm(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.magicEnabled) {
    return signInOffPage();
  }
  let token: string | null = null;
  try {
    const form = new URLSearchParams(await req.text());
    token = form.get("token");
  } catch {
    token = null;
  }
  if (!token) return expiredLinkPage();
  // Atomic and single-use: two submissions (or a code and a link) cannot both complete.
  const record = parse<MagicRecord>(
    await consumeArtefact(env, await portalMagicKey(env, token)),
  );
  if (!record) return expiredLinkPage();

  if (await isAskingBrowser(env, req, record.flow)) {
    if (record.flow) {
      const taken = await consumeArtefact(
        env,
        artefactRef("signin-flow", record.flow),
      );
      if (!taken) return expiredLinkPage(record.returnTo);
    }
    return completeEmailSignIn(req, env, db, record, now, "redirect");
  }
  const confirmed = await updateArtefact(
    env,
    artefactRef("signin-flow", record.flow!),
    {
      expect: { status: "pending" },
      set: { status: "confirmed", confirmedAt: now },
    },
  );
  if (!confirmed.ok) return expiredLinkPage(record.returnTo);
  // signin.confirmLink.done
  return cardPage(200, {
    title: "Sign-in confirmed",
    heading: "Sign-in confirmed",
    body: "<p>Go back to the device where you started. It signs in by itself.</p>",
  });
}
