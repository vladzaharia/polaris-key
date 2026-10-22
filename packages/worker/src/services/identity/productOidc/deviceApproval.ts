/// <reference types="@cloudflare/workers-types" />

// I-37: the explicit approval of a device-code sign-in (R1-07 / R8-03, reduced).
//
// The binder cookie proves WHICH BROWSER confirmed the code and signed in. It cannot prove that
// the person in that browser holds the device (a forwarded `verificationUriComplete` makes a
// victim confirm in their own browser). So after sign-in the flow stops here: the person is shown
// the app, the account, the device label, the code and where and when the request started, and
// presses **Sign in on {device}** or **Deny**. Only the approval sets `approvedAt`, the marker
// `/device/poll` requires before it discloses, activates or mints anything.
//
// `GET|POST /<p>/identity/auth/device/approve`, on the API host beside the chooser (the binder is
// set by the confirming browser, there). The URL carries no `state`, code or handle: a reload or
// a forwarded copy reaches the flow only through the binder.

import { normalizeDeviceLabel } from "@polaris-key/client-core";
import { checkDisplayName } from "@polaris-key/manifest";
import { hashKey, randomId } from "../../../platform/crypto.js";
import { type Env } from "../../../platform/env.js";
import { escapeHtmlKeepApostrophe as escapeHtml } from "../../../platform/html.js";
import { parseFlowRecord } from "../../../platform/json.js";
import { randomToken } from "../../../platform/random.js";
import type { Db } from "../../../db/types.js";
import { type Product } from "../../../core/products.js";
import { methodNotAllowed } from "../../../core/errors.js";
import { appendAudit } from "../../../core/audit.js";
import { clientNetwork } from "../../../core/rateLimit.js";
import type { ServiceHooks } from "../../../core/hooks.js";
import {
  appHeader,
  callout,
  note,
  personRow,
  renderAuthCard,
} from "../../../core/brandHtml.js";
import { appForPage, pageApp } from "../../../core/brandPage.js";
import { readBodyText } from "../../../core/cappedBody.js";
import {
  deleteArtefact,
  getArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { binderClearCookie, readBinder } from "../licenseChoice.js";
import { requestLocation } from "../place.js";
import { choiceKey, redirectToChooser, startAgainPage } from "./chooser.js";
import {
  CHOICE_FIELDS,
  FLOW_TTL_SECONDS,
  type FlowRecord,
  flowKey,
  isDeviceCodeFlow,
  rateLimited,
} from "./config.js";
import { sameOriginPost } from "../../../core/accounts/browserRequestGuard.js";
import { deviceHtmlHeaders, listingDeveloper, type PageView } from "./pages.js";

/** A name inside a sentence, isolated so a right-to-left label cannot scramble the line. */
function isolate(name: string): string {
  return `\u2068${name}\u2069`;
}

/** The label the person sees for the device: stored normalised, shown escaped, never trusted. */
export function deviceLabelOf(flow: FlowRecord): string {
  return normalizeDeviceLabel(flow.deviceName) ?? "Unnamed device";
}

/** The flow record's `error` value a denial leaves. The poll never echoes it: a refusal answers
 *  `error` + `reason: "access_denied"` (WIRE-CONTRACT-V4 §12.10), so it is a record marker, not a
 *  wire error code. */
export const FLOW_DENIED = "denied";

/** The fields a decision removes from the flow: the identity and everything account-bound. */
const DENY_UNSET = [
  "identity",
  "claimAccount",
  "approveToken",
  "identityShownAt",
  ...CHOICE_FIELDS,
];

export type ApprovalDecision = "approve" | "deny";

/**
 * THE writer of the decision (PX-14's card route calls it too). One compare-and-set on the flow:
 * the page's single-use token must be the current one, and the flow neither approved nor denied.
 * Of two racing decisions exactly one wins; a spent, stale or foreign token writes nothing.
 */
export async function decideDeviceFlow(
  env: Env,
  db: Db,
  product: Product,
  stateKey: ArtefactRef,
  flow: FlowRecord,
  tokenHash: string,
  decision: ApprovalDecision,
  now: number,
): Promise<boolean> {
  const done = await updateArtefact(env, stateKey, {
    expect: { approveToken: tokenHash, approvedAt: null, error: null },
    ...(decision === "approve"
      ? { set: { approvedAt: now }, unset: ["approveToken"] }
      : { set: { error: FLOW_DENIED }, unset: DENY_UNSET }),
  });
  if (!done.ok) return false;
  await auditDecision(db, product, flow, decision, now);
  return true;
}

/** Deny a device-code flow from the licence chooser's **Cancel** (its own token is spent). */
export async function denyChosenDeviceFlow(
  env: Env,
  db: Db | undefined,
  product: Product,
  stateKey: ArtefactRef,
  flow: FlowRecord,
  now: number,
): Promise<boolean> {
  const done = await updateArtefact(env, stateKey, {
    expect: { approvedAt: null, error: null },
    set: { error: FLOW_DENIED },
    unset: DENY_UNSET,
  });
  if (!done.ok) return false;
  if (db) await auditDecision(db, product, flow, "deny", now);
  return true;
}

/** The summary names the label and nothing else: no place, code or `state`. */
async function auditDecision(
  db: Db,
  product: Product,
  flow: FlowRecord,
  decision: ApprovalDecision,
  now: number,
): Promise<void> {
  const identity = flow.identity;
  const label = deviceLabelOf(flow);
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: identity?.sub ?? null,
    actor_name: identity?.name ?? null,
    actor_email: identity?.email ?? null,
    action:
      decision === "approve"
        ? "identity.signin.device_approved"
        : "identity.signin.device_denied",
    target_kind: "device",
    target_id: null,
    parent_id: null,
    summary:
      decision === "approve"
        ? `Approved the sign-in on ${label}`
        : `Denied the sign-in on ${label}`,
  }).catch(() => undefined);
}

interface Found {
  stateKey: ArtefactRef;
  indexKey: ArtefactRef;
  binderHash: string;
  flow: FlowRecord;
}

/** The flow this browser may decide, or the response that ends the visit. Only the binder cookie
 *  leads to it: its peppered hash → the `oidc-choice` index → `state`. Anything else gets the
 *  generic start-again page and nothing is written (a stale index is dropped). */
async function findFlow(
  req: Request,
  env: Env,
  product: Product,
): Promise<Found | Response> {
  const binder = readBinder(req);
  if (!binder) return startAgainPage();
  const binderHash = await hashKey(binder, env.KEY_HASH_PEPPER);
  const indexKey = choiceKey(product.slug, binderHash);
  const state = await getArtefact(env, indexKey);
  if (!state) return startAgainPage();
  const stateKey = await flowKey(env, product.slug, state);
  const raw = await getArtefact(env, stateKey);
  const flow = raw ? parseFlowRecord<FlowRecord>(raw) : null;
  if (
    !flow ||
    !isDeviceCodeFlow(flow) ||
    !flow.confirmedAt ||
    !flow.consumedAt ||
    !flow.identity ||
    flow.binder !== binderHash ||
    flow.approvedAt !== undefined ||
    flow.error !== undefined
  ) {
    await deleteArtefact(env, indexKey);
    return startAgainPage();
  }
  // The licence chooser is still open: that is the explicit step, not this page.
  if (flow.choiceOpen) return redirectToChooser(req, product);
  return { stateKey, indexKey, binderHash, flow };
}

function approvePath(req: Request, product: Product): string {
  return `${new URL(req.url).origin}/${product.slug}/identity/auth/device/approve`;
}

export function redirectToApprove(
  req: Request,
  product: Product,
  again = false,
): Response {
  return new Response(null, {
    status: 303,
    headers: {
      // `?again=1` carries no state: the page only adds "check and choose again".
      location: approvePath(req, product) + (again ? "?again=1" : ""),
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

/** "14:32": the UTC time of day of a Unix time in seconds. */
function utcClock(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(11, 16);
}

/** "just now", "2 minutes ago" — the age of the request, from the stored start. */
export function agoText(seconds: number): string {
  if (seconds < 60) return "just now";
  const m = Math.floor(seconds / 60);
  return m === 1 ? "1 minute ago" : `${m} minutes ago`;
}

/**
 * `GET`/`POST /<product>/identity/auth/device/approve`.
 *
 *   - `GET` finds the flow by the binder, mints a single-use token (replacing the last) and
 *     renders the decision.
 *   - `POST` (same origin, the token, the binder) records **Sign in on {device}** or **Deny**
 *     (**Not you?** denies too). A missing or unknown decision, or a spent, stale or foreign
 *     token, is a `303` back to the page and writes nothing.
 */
export async function handleAuthDeviceApprove(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  hooks?: ServiceHooks,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
  const limited = await rateLimited(env, product, now, {
    bucket: "authDeviceApprove",
    id: clientNetwork(req),
    limit: 60,
    windowSec: 60,
  });
  if (limited) return limited;
  if (req.method === "POST" && !sameOriginPost(req)) return startAgainPage();

  const found = await findFlow(req, env, product);
  if (found instanceof Response) return found;
  const { stateKey, indexKey, binderHash, flow } = found;
  void binderHash;
  const app = await approvalApp(env, db, product, hooks);
  const view: PageView = { tv: flow.tv === true, app: app.app };

  if (req.method === "GET")
    return renderApproval(
      req,
      env,
      product,
      stateKey,
      flow,
      app,
      now,
      new URL(req.url).searchParams.get("again") === "1",
    );

  const form = new URLSearchParams(await readBodyText(req).catch(() => ""));
  const token = form.get("token") ?? "";
  const decision = form.get("decision");
  if (!token || (decision !== "approve" && decision !== "deny"))
    return redirectToApprove(req, product, true);
  const won = await decideDeviceFlow(
    env,
    db,
    product,
    stateKey,
    flow,
    await hashKey(token, env.KEY_HASH_PEPPER),
    decision,
    now,
  );
  if (!won) return redirectToApprove(req, product, true);
  // Finished with the browser either way: the index and the binder go.
  await deleteArtefact(env, indexKey);
  const cookies = [binderClearCookie()];
  if (decision === "deny") return deniedPage(flow, view, cookies);
  return deviceDonePage(
    deviceLabelOf(flow),
    view,
    cookies,
    undefined,
    flow.identity,
  );
}

/** The done page (SIGN-IN.md §3.13): "{App} is signed in on {device}", and where to look. */
export function deviceDonePage(
  label: string,
  view: PageView,
  cookies: string[],
  replaced?: string,
  /** Who signed in (SIGN-IN.md §3.10): the person row under the heading. */
  person?: { name?: string | null; email?: string | null } | null,
): Response {
  const shown = pageApp(view.app ?? { name: "" });
  const who = person?.name || person?.email || null;
  const heading = view.app?.name
    ? `${isolate(view.app.name)} is signed in on ${isolate(label)}`
    : `Signed in on ${isolate(label)}`;
  const html = renderAuthCard({
    ...(view.tv ? { variant: "tv" as const } : {}),
    title: view.app?.name ? `${view.app.name} is signed in` : "Signed in",
    heading,
    // No app header here (B-105): the heading already names the app, so a header above it said it
    // twice.
    body:
      (who ? personRow({ name: who, email: person?.email ?? null }) : "") +
      callout(
        "check-circle",
        `Look at ${isolate(label)}: it continues by itself.`,
        replaced ? `${isolate(replaced)} was signed out.` : undefined,
      ) +
      `<p class="muted small">You can close this page.</p>`,
  });
  const headers = deviceHtmlHeaders(undefined, shown.imgOrigin);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(html, { status: 200, headers });
}

/** The app as the page draws it: the neutral frame (the slug) when its name fails the display
 *  rules, and no developer when theirs does. */
async function approvalApp(
  env: Env,
  db: Db,
  product: Product,
  hooks: ServiceHooks | undefined,
): Promise<{
  app: { name: string; iconUrl: string | null; artUrl: string | null };
  developer: string | null;
  imgOrigin: string | null;
}> {
  const raw = await appForPage({ product, env, db, hooks }).catch(() => ({
    name: product.name,
    iconUrl: null,
    artUrl: null,
  }));
  const developer = await listingDeveloper(hooks);
  const named = {
    ...raw,
    name:
      checkDisplayName(raw.name, { slug: product.slug }) === null
        ? raw.name
        : product.slug,
  };
  const shown = pageApp(named);
  return {
    app: {
      name: shown.app.name,
      iconUrl: shown.app.iconUrl ?? null,
      artUrl: shown.app.artUrl ?? null,
    },
    developer:
      developer && checkDisplayName(developer, { slug: product.slug }) === null
        ? developer
        : null,
    imgOrigin: shown.imgOrigin,
  };
}

/**
 * The anti-phishing facts the person decides on (SIGN-IN.md §3.13): the signed-in account, the
 * code, "Started {ago} from {place}", and the callout when the start country differs from this
 * request's or either is unknown (D4: shown, never a refusal). Shared by the approval page and
 * the licence chooser, whose choice is an approval too. TRUSTED markup, every value escaped.
 */
export function approvalFacts(
  req: Request,
  flow: FlowRecord,
  now: number,
): string {
  const identity = flow.identity;
  const who = identity?.name || identity?.email || "your account";
  const startedAt = typeof flow.startedAt === "number" ? flow.startedAt : null;
  const place = flow.startPlace?.label ?? null;
  const started =
    startedAt === null
      ? ""
      : place
        ? `${agoText(now - startedAt)} from ${place}`
        : agoText(now - startedAt);
  const rows =
    `<dt>Account</dt><dd>${escapeHtml(who)}${
      identity?.email && identity.email !== who
        ? `<br><span class="muted">${escapeHtml(identity.email).replace(/[@.]/g, "<wbr>$&")}</span>`
        : ""
    }</dd>` +
    (flow.userCode
      ? `<dt>Code</dt><dd><span class="code">${escapeHtml(flow.userCode)}</span></dd>`
      : "") +
    (started ? `<dt>Started</dt><dd>${escapeHtml(started)}</dd>` : "");
  return `<dl>${rows}</dl>${originWarning(req, flow)}`;
}

/** The place callout (D4: shown, never a refusal): where the sign-in started, and "only continue if
 *  the device is with you" when the countries differ or either is unknown. Empty when they match. */
export function originWarning(req: Request, flow: FlowRecord): string {
  const dev = isolate(deviceLabelOf(flow));
  const place = flow.startPlace?.label ?? null;
  const here = requestLocation(req);
  const startCountry = flow.startPlace?.country ?? null;
  const mismatch =
    !startCountry || !here.country || startCountry !== here.country;
  // Both countries known and different: "not where you are". The approver's unknown: just where.
  const title = place
    ? here.country && startCountry && here.country !== startCountry
      ? `This sign-in started in ${place}, not where you are.`
      : `This sign-in started in ${place}.`
    : "We can't tell where this sign-in started.";
  return mismatch
    ? callout("shield", title, `Only continue if ${dev} is with you.`)
    : "";
}

async function renderApproval(
  req: Request,
  env: Env,
  product: Product,
  stateKey: ArtefactRef,
  flow: FlowRecord,
  app: Awaited<ReturnType<typeof approvalApp>>,
  now: number,
  again = false,
): Promise<Response> {
  const token = randomToken(32);
  // A new render replaces the previous token; a flow decided meanwhile renders nothing.
  const minted = await updateArtefact(env, stateKey, {
    expect: { approvedAt: null, error: null },
    set: { approveToken: await hashKey(token, env.KEY_HASH_PEPPER) },
  });
  if (!minted.ok) return startAgainPage();

  const label = deviceLabelOf(flow);
  const dev = isolate(label);
  const who = flow.identity?.name || flow.identity?.email || "your account";
  const startedAt = typeof flow.startedAt === "number" ? flow.startedAt : null;
  const formId = "pk-approve";
  const html = renderAuthCard({
    title: `Sign in on ${label}?`,
    heading: `Sign in on ${dev}?`,
    ...(flow.tv ? { variant: "tv" as const } : {}),
    passport: {
      name: app.app.name,
      iconUrl: app.app.iconUrl,
      artUrl: app.app.artUrl,
      developer: app.developer,
      device: label,
      action: "wants you to sign in",
    },
    // The person row sits above the heading; "Not you?" is a Deny (nothing signs in).
    preface: personRow({
      name: who,
      email: flow.identity?.email ?? null,
      notYouForm: { form: formId, field: "decision", value: "deny" },
    }),
    body:
      (again
        ? `<p class="note">Check the details, then choose again.</p>`
        : "") +
      (flow.userCode
        ? `<p>It showed the code <span class="code">${escapeHtml(flow.userCode)}</span>${
            startedAt === null ? "" : ` ${escapeHtml(agoText(now - startedAt))}`
          }.${
            // A static line, never a ticking countdown (the page has no script; SIGN-IN.md §3.13).
            startedAt === null
              ? ""
              : ` Expires at ${escapeHtml(utcClock(startedAt + FLOW_TTL_SECONDS))} UTC.`
          }</p>`
        : "") +
      originWarning(req, flow) +
      `<form id="${formId}" method="post" action="${escapeHtml(approvePath(req, product))}">` +
      `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
      `<div class="stack"><button class="button" type="submit" name="decision" value="approve"><span>Sign in on <bdi>${escapeHtml(label)}</bdi></span></button>` +
      `<button class="button secondary" type="submit" name="decision" value="deny">Deny</button>` +
      `</div></form>` +
      note("info", "Didn't start this? Deny, and nothing signs in."),
    focusHeading: true,
    footer: {
      icon: "lock",
      text: `Polaris Locker signs you in for ${isolate(app.app.name)}. ${isolate(app.developer ?? app.app.name)} never sees your codes or passkeys.`,
    },
  });
  const headers = deviceHtmlHeaders(undefined, app.imgOrigin);
  return new Response(html, { status: 200, headers });
}

/**
 * A Deny whose compare-and-set lost: show the outcome that actually won, never "denied" over an
 * approval. The flow is read again; approved shows the done page, denied shows the denied page,
 * and a flow that is gone or in neither state gets the generic start-again page. Writes nothing.
 */
export async function lostDenyPage(
  env: Env,
  stateKey: ArtefactRef,
  flow: FlowRecord,
  view: PageView,
  cookies: string[],
): Promise<Response> {
  const raw = await getArtefact(env, stateKey);
  const now = raw ? parseFlowRecord<FlowRecord>(raw) : null;
  if (now && now.approvedAt !== undefined)
    return deviceDonePage(
      deviceLabelOf(now),
      view,
      cookies,
      undefined,
      now.identity,
    );
  if (now && now.error === FLOW_DENIED) return deniedPage(flow, view, cookies);
  return startAgainPage();
}

/** Deny: the device's poll answers `error`, and nothing was signed in. */
export function deniedPage(
  flow: FlowRecord,
  view: PageView,
  cookies: string[],
): Response {
  const shown = pageApp(view.app ?? { name: "" });
  const html = renderAuthCard({
    ...(view.tv ? { variant: "tv" as const } : {}),
    title: "Sign-in denied",
    heading: "Sign-in denied",
    ...(view.app?.name
      ? {
          header: appHeader({
            name: view.app.name,
            iconUrl: shown.app.iconUrl,
          }),
        }
      : {}),
    body: callout(
      "check-circle",
      `Nothing was signed in on ${isolate(deviceLabelOf(flow))}.`,
      "You can close this page.",
    ),
  });
  const headers = deviceHtmlHeaders(undefined, shown.imgOrigin);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(html, { status: 200, headers });
}
