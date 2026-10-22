/**
 * The console's approval card for `pkey login` (ST-34.6): `GET|POST /manage/device`.
 *
 * Server-rendered and script-free, on the console sign-in card's CSP (ST-34 D-7). The decision is a
 * plain form POST. Every gate on the way to a decision, in order:
 *
 *   1. a console COOKIE session, read by the console's one reader (`resolveConsoleCaller`). An
 *      `Authorization` header, a portal cookie and a v1 cookie never reach this far: none of them
 *      resolves to a v2 session (account id + session row), so each is sent to sign in.
 *   2. a member: the principal holds at least one grant, else the no-access card.
 *   3. a per-member budget (`DEVICE_LOGIN_APPROVE_LIMIT` a minute, fail closed), before any code is
 *      looked up, so the budget bounds guessing someone else's code.
 *   4. same origin: a present `Origin` must be this host's.
 *   5. the CSRF field, compared in constant time with the session's own token.
 *   6. an explicit `decision` of `approve` or `deny`; nothing else is read as an approval.
 *   7. for `approve` only: a step-up no older than five minutes (`isSteppedUp`). Denying ends a
 *      request and mints nothing, so it needs the session but not the step-up.
 *   8. Identity's `cliDeviceLoginDecide`: the code is consumed atomically, then the record moves out
 *      of `pending` by compare-and-set; a reused, expired or unknown code is the expired card.
 *
 * The client name, version and host are the CLI's own words, cleaned in Identity but unverified:
 * the card says so and escapes all of it. Nothing here prints an account id.
 */
import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { escapeHtml } from "../platform/html.js";
import { constantTimeEqual } from "../platform/compare.js";
import { resolveConsoleCaller } from "./api.js";
import { CONSOLE_CARD_LINKS } from "./signinPage.js";
import {
  callout,
  icon,
  note,
  personRow,
  renderAuthCard,
} from "../core/brandHtml.js";
import { brandedHtmlSecurityHeaders } from "../core/securityHeaders.js";
import { imgOrigin, consoleOrigin } from "../core/hosts.js";
import { rateLimitOk } from "../core/rateLimit.js";
import { platformAudit } from "../core/audit.js";
import { isSteppedUp } from "../core/console/session.js";
import { can, PLATFORM, type Grant, type Principal } from "../core/rbac/can.js";
import {
  MAX_LIVE_PERSONAL_TOKENS,
  listAccountTokens,
  PERSONAL_TOKEN_DAYS,
} from "../core/accounts/personalTokens.js";
import { cliSignInNotice } from "../core/notify/templates.js";
import { sendSecurityNotice } from "../core/notify/send.js";
import {
  DEVICE_LOGIN_APPROVE_LIMIT,
  cliDeviceLoginDecide,
  cliDeviceLoginLookup,
  type CliDeviceLoginView,
} from "../services/identity/public.js";
import type { AdminSession } from "../core/console/session.js";

const RL_SHARD = "_admin";
/** A code as the CLI prints it: letters and a dash, short. Anything else is not put in a URL. */
const CODE_SHAPE = /^[A-Za-z0-9-]{4,20}$/;
const BODY_MAX = 2048;

type Card = { heading: string; body: string };

function html(status: number, card: Card, env: Env): Response {
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }),
    { brand: "console", imgOrigin: imgOrigin(env) },
  );
  return new Response(
    renderAuthCard({
      brand: "console",
      title: card.heading,
      heading: card.heading,
      body: card.body,
      focusHeading: true,
      links: CONSOLE_CARD_LINKS,
    }),
    { status, headers },
  );
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

/** The code in the path (`/device/<code>`) or the query, or null. Shape-checked, not trusted. */
function codeOf(path: string, url: URL, form: FormData | null): string | null {
  const raw =
    (form?.get("code") as string | null) ??
    url.searchParams.get("code") ??
    (path.startsWith("/device/") ? path.slice("/device/".length) : null);
  if (typeof raw !== "string") return null;
  const code = raw.trim();
  return CODE_SHAPE.test(code) ? code : null;
}

function signInTo(code: string | null, stepUp: boolean): string {
  // The login's `returnTo` sanitizer allows exactly this query (`sanitizeReturnTo`).
  const returnTo = code ? `/manage/device?code=${code}` : "/manage/device";
  return `/manage/login?${stepUp ? "stepUp=1&" : ""}returnTo=${encodeURIComponent(returnTo)}`;
}

const ROLE_NAME: Record<Grant["role"], string> = {
  superadmin: "Superadmin",
  platform_admin: "Platform admin",
  product_admin: "Product admin",
  console_access: "Console access",
};

function roleTag(g: Grant): string {
  let label = ROLE_NAME[g.role];
  if (g.role === "product_admin") {
    if (g.scope.startsWith("product:"))
      label = `${g.scope.slice("product:".length)} admin`;
    else if (g.scope === "products:*") label = "Product admin, all products";
  }
  return `<span class="tag">${escapeHtml(label)}</span>`;
}

function date(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function ago(now: number, then: number): string {
  const s = Math.max(0, now - then);
  if (s < 60) return "just now";
  return `${Math.floor(s / 60)} min ago`;
}

function machine(view: CliDeviceLoginView, now: number): string {
  const parts = [view.client.host, ago(now, view.requestedAt)].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  return parts.join(" · ");
}

function post(
  action: string,
  fields: Record<string, string>,
  label: string,
  cls: string,
): string {
  const f = Object.entries(fields)
    .map(([k, v]) => hidden(k, v))
    .join("");
  return `<form method="post" action="${escapeHtml(action)}">${f}<button class="button ${cls}" type="submit">${escapeHtml(label)}</button></form>`;
}

function reviewCard(
  view: CliDeviceLoginView,
  session: AdminSession,
  principal: Principal,
  now: number,
  steppedUp: boolean,
  notice: string,
): Card {
  const client = view.client;
  const clientLine = `${client.name}${client.version ? ` ${client.version}` : ""}`;
  const onlyRoot =
    principal.grants.length > 0 &&
    principal.grants.every((g) => g.source === "root");
  const tags = principal.grants.map(roleTag).join("");
  const fields = { code: view.code, csrf: session.csrf };
  const actions = steppedUp
    ? post(
        "/manage/device",
        { ...fields, decision: "approve" },
        "Approve",
        "",
      ) +
      post(
        "/manage/device",
        { ...fields, decision: "deny" },
        "Cancel",
        "secondary",
      )
    : `<a class="button" href="${escapeHtml(signInTo(view.code, true))}">Sign in again to approve${icon("arrow-right")}</a>` +
      post(
        "/manage/device",
        { ...fields, decision: "deny" },
        "Cancel",
        "secondary",
      );
  const body = [
    notice,
    `<p>${escapeHtml(machine(view, now))}</p>`,
    callout(
      "info",
      "Check this matches your terminal",
      "The program, host and device are what the terminal said about itself, so Polaris Key can’t verify them. The place is approximate.",
    ),
    `<dl><dt>Code</dt><dd><strong>${escapeHtml(view.code)}</strong></dd>` +
      `<dt>Program</dt><dd>${escapeHtml(clientLine)} <span class="tag">unverified</span></dd>` +
      `<dt>Host</dt><dd>${escapeHtml(client.host)} <span class="tag">unverified</span></dd>` +
      (view.device.label
        ? `<dt>Device</dt><dd>${escapeHtml(view.device.label)} <span class="tag">unverified</span></dd>`
        : "") +
      (view.location.label
        ? `<dt>Place</dt><dd>About ${escapeHtml(view.location.label)}</dd>`
        : "") +
      `</dl>`,
    `<p class="fine">Limited to your roles</p><p>${tags}</p>`,
    onlyRoot
      ? note(
          "info",
          "Your access is the root rule only, so the token works while your console sign-in is recent.",
        )
      : "",
    note(
      "clock",
      `Ends ${date(now + PERSONAL_TOKEN_DAYS.admin.default * 86_400)}`,
    ),
    note("x-circle", "Can’t install packages"),
    note("shield", "Only approve a sign-in you started yourself, just now."),
    `<div class="actions stack">${actions}</div>`,
    personRow({ name: session.name || session.email, email: session.email }),
  ].join("");
  return { heading: "Let pkey sign in as you?", body };
}

function entryCard(message?: string): Card {
  return {
    heading: "Sign in the pkey command line",
    body:
      (message ? callout("x-circle", message) : "") +
      `<form method="get" action="/manage/device"><div class="field"><label for="code">Code from your terminal</label>` +
      `<input id="code" type="text" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" required></div>` +
      `<button class="button" type="submit">Continue${icon("arrow-right")}</button></form>`,
  };
}

const expiredCard: Card = {
  heading: "This code has expired",
  body:
    callout(
      "clock",
      "Nothing was approved",
      "Run pkey login in your terminal to get a new code.",
    ) +
    `<p class="actions"><a class="button secondary" href="/manage/device">Enter another code</a></p>`,
};

/** The account already holds as many live personal tokens as it may (`token_limit`). */
async function tokenLimitReached(
  db: Db,
  accountId: string,
  now: number,
): Promise<boolean> {
  const tokens = await listAccountTokens(db, accountId, now);
  return (
    tokens.filter((t) => t.status === "active").length >=
    MAX_LIVE_PERSONAL_TOKENS
  );
}

function limitCard(): Card {
  return {
    heading: "Too many tokens",
    body:
      callout(
        "x-circle",
        `You already have ${MAX_LIVE_PERSONAL_TOKENS} personal tokens`,
        "End one under Personal tokens in the console, then reload this page. Nothing was approved.",
      ) +
      `<p class="actions"><a class="button secondary" href="/manage/">Open the console</a></p>`,
  };
}

const approvedCard: Card = {
  heading: "Signed in",
  body: callout("check-circle", "Go back to your terminal"),
};

const deniedCard: Card = {
  heading: "Sign-in cancelled",
  body: callout("x-circle", "Nothing was approved", "You can close this tab."),
};

const noAccessCard: Card = {
  heading: "You don’t have access",
  body: callout(
    "lock",
    "This account has no role in the console",
    "Ask a Superadmin to give you one, then run pkey login again.",
  ),
};

function refuse(
  status: number,
  heading: string,
  detail: string,
  env: Env,
): Response {
  return html(
    status,
    {
      heading,
      body:
        callout("lock", heading, detail) +
        `<p class="actions"><a class="button secondary" href="/manage/device">Back</a></p>`,
    },
    env,
  );
}

export async function handleDevicePage(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  now: number,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, POST", "cache-control": "no-store" },
    });
  }
  const url = new URL(req.url);
  const pathCode = codeOf(path, url, null);

  // 1. The cookie session, from the one reader. A header token is not read here.
  const caller = await resolveConsoleCaller(env, db, req, now);
  const session = caller?.session;
  if (
    !caller ||
    !session ||
    !session.aid ||
    !session.sid ||
    !session.sub.startsWith("mbr_")
  ) {
    return redirect(signInTo(pathCode, false));
  }
  const { principal } = caller;

  // 2. A member.
  if (!can(principal, PLATFORM, "console", "view"))
    return html(403, noAccessCard, env);

  // 4/5. A decision is a same-origin form with the session's CSRF token.
  let form: FormData | null = null;
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== url.origin)
      return refuse(403, "This page expired", "Reload it and try again.", env);
    const len = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > BODY_MAX)
      return refuse(
        413,
        "Request too large",
        "Reload the page and try again.",
        env,
      );
    try {
      form = await req.formData();
    } catch {
      return refuse(
        400,
        "Something went wrong",
        "Reload the page and try again.",
        env,
      );
    }
    const sent = form.get("csrf");
    if (typeof sent !== "string" || !constantTimeEqual(sent, session.csrf))
      return refuse(403, "This page expired", "Reload it and try again.", env);
  }

  const code = codeOf(path, url, form);
  if (!code) return html(200, entryCard(), env);

  // 3. The budget, before the code is looked up.
  if (
    !(await rateLimitOk(
      env,
      RL_SHARD,
      {
        bucket: "adminDeviceApprove",
        id: principal.memberId,
        limit: DEVICE_LOGIN_APPROVE_LIMIT,
        windowSec: 60,
      },
      now,
    ))
  )
    return refuse(429, "Too many tries", "Wait a minute and try again.", env);

  const steppedUp = isSteppedUp(session, now);

  if (req.method === "GET") {
    const view = await cliDeviceLoginLookup(env, code, now);
    if (!view) return html(410, expiredCard, env);
    if (await tokenLimitReached(db, session.aid, now))
      return html(409, limitCard(), env);
    return html(
      200,
      reviewCard(view, session, principal, now, steppedUp, ""),
      env,
    );
  }

  // 6. An explicit decision.
  const decision = form!.get("decision");
  if (decision !== "approve" && decision !== "deny")
    return refuse(
      400,
      "Something went wrong",
      "Reload the page and try again.",
      env,
    );

  const view = await cliDeviceLoginLookup(env, code, now);
  if (!view) return html(410, expiredCard, env);

  // 7. Approving needs a fresh sign-in.
  if (decision === "approve" && !steppedUp) {
    await platformAudit(
      db,
      session,
      now,
      "cli.login.step_up_required",
      { kind: "cli_login", id: String(view.requestedAt) },
      `Asked to sign in again before approving pkey on ${view.client.host}`,
    );
    return html(
      403,
      reviewCard(
        view,
        session,
        principal,
        now,
        false,
        callout(
          "lock",
          "Sign in again to approve",
          "Approving needs a sign-in from the last five minutes.",
        ),
      ),
      env,
    );
  }

  // A full token list would make the poll's mint fail after "approved": say so now, and keep the
  // code live (nothing is consumed) so ending one token lets the same request go ahead.
  if (decision === "approve" && (await tokenLimitReached(db, session.aid, now)))
    return html(409, limitCard(), env);

  // 8. Identity decides: single use, compare-and-set.
  const result = await cliDeviceLoginDecide(
    env,
    { code, accountId: session.aid, decision },
    now,
  );
  if (!result.ok) return html(410, expiredCard, env);

  const where = view.location.label ? ` near ${view.location.label}` : "";
  await platformAudit(
    db,
    session,
    now,
    decision === "approve" ? "cli.login.approve" : "cli.login.deny",
    { kind: "cli_login", id: String(view.requestedAt) },
    `${decision === "approve" ? "Approved" : "Denied"} pkey on ${view.client.host}${where}`,
  );
  if (decision === "approve") {
    await sendSecurityNotice(
      env,
      db,
      session.aid,
      session.email,
      cliSignInNotice({
        deviceLabel: `pkey on ${view.client.host}`,
        location: view.location.label,
        at: now,
        origin: consoleOrigin(env, req) ?? url.origin,
      }),
      now,
    );
  }
  return html(200, decision === "approve" ? approvedCard : deniedCard, env);
}
