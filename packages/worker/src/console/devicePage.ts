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
 *   4. same origin (`sameOriginPost`): `Sec-Fetch-Site: same-origin`, or without it a missing
 *      `Origin`, this host's, or `"null"` (the page is served with `referrer-policy: no-referrer`,
 *      under which every browser sends `Origin: null` on a same-origin form post).
 *   5. the CSRF field, compared in constant time with the session's own token.
 *   6. an explicit `decision` of `approve` or `deny`; nothing else is read as an approval.
 *   7. for `approve` only: a step-up no older than five minutes (`isSteppedUp`). Denying ends a
 *      request and mints nothing, so it needs the session but not the step-up.
 *   8. Identity's `cliDeviceLoginDecide`: the code is consumed atomically, then the record moves out
 *      of `pending` by compare-and-set; a reused, expired or unknown code is the expired card.
 *
 * The client name, version and host are the CLI's own words, cleaned in Identity but unverified:
 * the card says so once and escapes all of it. Nothing here prints an account id. A signed-out GET
 * that arrives cross-site (the IdP's redirect back) is answered with a script-free meta refresh,
 * not a 303, so the browser carries the session cookie on the same-site hop (REV-ST34-6 N1).
 */
import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { escapeHtml } from "../platform/html.js";
import { constantTimeEqual } from "../platform/compare.js";
import { resolveConsoleCaller } from "./api.js";
import { CONSOLE_CARD_LINKS } from "./signinPage.js";
import {
  appHeader,
  callout,
  icon,
  note,
  personRow,
  renderAuthCard,
  type AppFacts,
} from "../core/brandHtml.js";
import { brandedHtmlSecurityHeaders } from "../core/securityHeaders.js";
import { imgOrigin, consoleOrigin } from "../core/hosts.js";
import { rateLimitOk } from "../core/rateLimit.js";
import { platformAudit } from "../core/audit.js";
import {
  ADMIN_SESSION_TTL_SECONDS,
  isSteppedUp,
  type AdminSession,
} from "../core/console/session.js";
import { can, PLATFORM, type Grant, type Principal } from "../core/rbac/can.js";
import { AREAS } from "../core/rbac/areas.js";
import { getProduct } from "../core/products/store.js";
import {
  hasFormContentType,
  readTextCapped,
  sameOriginPost,
} from "../core/accounts/browserRequestGuard.js";
import { formatUserCode, normalizeUserCode } from "../core/deviceCodeIndex.js";
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

const RL_SHARD = "_admin";
const BODY_MAX = 2048;
/** The CLI's own caps on what it says about itself (`cleanClient` in Identity): a value that
 *  reaches one was probably cut, and the card says so with an ellipsis. */
const NAME_MAX = 32;
const VERSION_MAX = 32;
const HOST_MAX = 64;
const PHONE_CODE_MAX = 20;

/** One page's worth of card. `header` and `passport` are the strip and the wide pane. */
interface Card {
  heading: string;
  body: string;
  preface?: string;
  header?: string;
  passport?: AppFacts;
  /** The code field takes focus; every other card focuses its heading. */
  focusField?: boolean;
}

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
      focusHeading: !card.focusField,
      links: CONSOLE_CARD_LINKS,
      ...(card.preface ? { preface: card.preface } : {}),
      ...(card.header ? { header: card.header } : {}),
      ...(card.passport ? { passport: card.passport } : {}),
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

/**
 * The signed-out landing from a cross-site navigation (the IdP's redirect): a meta refresh to the
 * same card, so the next hop is a same-site navigation that carries the cookie. No script; a
 * Continue link for a browser that ignores the refresh.
 */
function refreshTo(location: string, env: Env): Response {
  const page = renderAuthCard({
    brand: "console",
    title: "Continuing",
    heading: "Continuing",
    body: `<p>One moment.</p><p class="actions"><a class="button" href="${escapeHtml(location)}">Continue${icon("arrow-right")}</a></p>`,
    focusHeading: true,
    links: CONSOLE_CARD_LINKS,
  }).replace(
    '<meta charset="utf-8">',
    `<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${escapeHtml(location)}">`,
  );
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }),
    { brand: "console", imgOrigin: imgOrigin(env) },
  );
  return new Response(page, { status: 200, headers });
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

interface Typed {
  /** What was typed or linked, before cleaning; null when there was nothing. */
  raw: string | null;
  /** The canonical `QXKM-TPRW`, or null when `raw` cannot be a code. */
  code: string | null;
  /** The request came from the code form (`entered=1`): an error shows under the field. */
  entered: boolean;
}

/** The code in the form, the query or the path (`/device/<code>`). Spaces and case are cleaned
 *  (`normalizeUserCode`) before the shape check; a bad one is never looked up. */
function readCode(path: string, url: URL, form: URLSearchParams | null): Typed {
  const raw =
    form?.get("code") ??
    url.searchParams.get("code") ??
    (path.startsWith("/device/") ? path.slice("/device/".length) : null);
  const entered = url.searchParams.get("entered") === "1";
  if (raw === null) return { raw: null, code: null, entered };
  const n = normalizeUserCode(raw);
  return { raw, code: n ? formatUserCode(n) : null, entered };
}

function signInTo(code: string | null, stepUp: boolean): string {
  // The login's `returnTo` sanitizer allows exactly this query (`sanitizeReturnTo`).
  const returnTo = code ? `/manage/device?code=${code}` : "/manage/device";
  return `/manage/login?${stepUp ? "stepUp=1&" : ""}returnTo=${encodeURIComponent(returnTo)}`;
}

/** Sign in as someone else: the IdP's account chooser, then back to this card. */
function otherAccount(code: string | null): string {
  const returnTo = code ? `/manage/device?code=${code}` : "/manage/device";
  return `/manage/login?go=1&other=1&returnTo=${encodeURIComponent(returnTo)}`;
}

const ROLE_ORDER: Record<Grant["role"], number> = {
  superadmin: 0,
  platform_admin: 1,
  product_admin: 2,
  console_access: 3,
};

const AREA_NAME = new Map<string, string>(AREAS.map((a) => [a.id, a.name]));

/** The roles as the console's `roleLabel` names them: "Superadmin", "Platform admin", the product's
 *  name plus "admin", "All products admin", "Console access"; a narrowed one lists its areas.
 *  Sorted, and one tag per distinct label. */
async function roleTags(db: Db, principal: Principal): Promise<string> {
  const names = new Map<string, string>();
  for (const g of principal.grants) {
    if (g.role !== "product_admin" || !g.scope.startsWith("product:")) continue;
    const slug = g.scope.slice("product:".length);
    if (!names.has(slug))
      names.set(slug, (await getProduct(db, slug))?.name ?? slug);
  }
  const rows = principal.grants.map((g) => {
    let label: string;
    switch (g.role) {
      case "superadmin":
        label = "Superadmin";
        break;
      case "platform_admin":
        label = "Platform admin";
        break;
      case "console_access":
        label = "Console access";
        break;
      case "product_admin":
        label = g.scope.startsWith("product:")
          ? `${names.get(g.scope.slice("product:".length))} admin`
          : "All products admin";
        break;
    }
    const areas =
      g.areas && g.areas.length > 0
        ? g.areas
            .map((a) => AREA_NAME.get(a) ?? a)
            .sort((a, b) => a.localeCompare(b))
            .join(", ")
        : "";
    return { order: ROLE_ORDER[g.role], label, areas };
  });
  rows.sort(
    (a, b) =>
      a.order - b.order ||
      a.label.localeCompare(b.label) ||
      a.areas.localeCompare(b.areas),
  );
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const r of rows) {
    const key = `${r.label}|${r.areas}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(
      `<span class="tag">${escapeHtml(r.label)}${r.areas ? `<span class="muted">· ${escapeHtml(r.areas)} only</span>` : ""}</span>`,
    );
  }
  return `<p class="tags">${tags.join("")}</p>`;
}

/** "Nov 21, 2023", the console's date format. */
function date(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
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

/** The client's own value, with an ellipsis when it reached the cap it was cut at. */
function shown(value: string, max: number): string {
  return Array.from(value).length >= max ? `${value}…` : value;
}

function placeOf(view: CliDeviceLoginView): string | null {
  return view.location.label ? `${view.location.label} (approximate)` : null;
}

function post(
  fields: Record<string, string>,
  label: string,
  cls: string,
): string {
  const f = Object.entries(fields)
    .map(([k, v]) => hidden(k, v))
    .join("");
  return `<form method="post" action="/manage/device">${f}<button class="button${cls ? ` ${cls}` : ""}" type="submit">${escapeHtml(label)}</button></form>`;
}

const SESSION_HOURS = Math.round(ADMIN_SESSION_TTL_SECONDS / 3600);

async function reviewCard(
  db: Db,
  view: CliDeviceLoginView,
  session: AdminSession,
  principal: Principal,
  now: number,
  steppedUp: boolean,
  stepUpNotice: boolean,
): Promise<Card> {
  const client = view.client;
  const name = shown(client.name, NAME_MAX);
  const version = client.version ? shown(client.version, VERSION_MAX) : "";
  const host = shown(client.host, HOST_MAX);
  const place = placeOf(view);
  const onlyRoot =
    principal.grants.length > 0 &&
    principal.grants.every((g) => g.source === "root");
  const fields = { code: view.code, csrf: session.csrf };
  const cancel = post({ ...fields, decision: "deny" }, "Cancel", "secondary");
  const actions = steppedUp
    ? post({ ...fields, decision: "approve" }, "Approve", "") + cancel
    : `<a class="button" href="${escapeHtml(signInTo(view.code, true))}">Sign in again to approve${icon("arrow-right")}</a>` +
      cancel;
  const body = [
    // The step-up message sits where the subtitle does, and is announced when the page loads.
    stepUpNotice
      ? `<p role="alert">Approving needs a sign-in from the last five minutes.</p>`
      : "",
    `<div class="codepanel"><p>Check this matches your terminal</p><p class="code">${escapeHtml(view.code)}</p></div>`,
    `<p class="note">${icon("info", true)}<span><span class="tag">unverified</span> pkey reported its name and host; Polaris Key can’t check them.</span></p>`,
    `<div class="facts"><p class="fine">Limited to your roles</p>${await roleTags(db, principal)}${
      onlyRoot
        ? note(
            "info",
            `Your Superadmin role comes from your sign-in provider, so pkey stops working ${SESSION_HOURS} hours after your last console sign-in.`,
          )
        : ""
    }${note(
      "clock",
      `Ends ${date(now + PERSONAL_TOKEN_DAYS.admin.default * 86_400)}`,
    )}${note("x-circle", "Can’t install packages")}</div>`,
    callout("shield", "Didn’t just run pkey login? Cancel."),
    `<div class="actions stack">${actions}</div>`,
    personRow({
      name: session.name || session.email,
      email: session.email,
      notYouHref: otherAccount(view.code),
    }),
  ].join("");
  return {
    heading: "Let pkey sign in as you?",
    body,
    header: appHeader({
      name,
      ...(version ? { action: version } : {}),
      sub: [host, place, ago(now, view.requestedAt)]
        .filter((p): p is string => !!p)
        .join(" · "),
      glyph: "terminal",
    }),
    passport: {
      name,
      glyph: "terminal",
      ...(version ? { action: version } : {}),
      ...(place ? { developer: place } : {}),
      device: host,
    },
  };
}

const CODE_HINT = "QXKM-TPRW";

function entryCard(opts: { message?: string; value?: string } = {}): Card {
  const err = opts.message
    ? `<p class="field-err" id="code-err" role="alert">${icon("x-circle", true)}<span>${escapeHtml(opts.message)}</span></p>`
    : "";
  return {
    heading: "Enter the code from your terminal",
    focusField: true,
    body:
      `<form method="get" action="/manage/device"><input type="hidden" name="entered" value="1">` +
      `<div class="field"><label for="code">Code</label>` +
      `<input id="code" type="text" name="code" autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="${PHONE_CODE_MAX}" required` +
      `${opts.value ? ` value="${escapeHtml(opts.value)}"` : ""}` +
      `${opts.message ? ` aria-invalid="true"` : ""} aria-describedby="${opts.message ? "code-err " : ""}code-hint">` +
      `<span class="hint" id="code-hint">Like ${CODE_HINT}, as pkey login printed it.</span>${err}</div>` +
      `<button class="button" type="submit">Continue${icon("arrow-right")}</button></form>`,
  };
}

const SHAPE_MESSAGE = `That isn’t a code. It has 8 letters, like ${CODE_HINT}.`;
const UNUSABLE_DETAIL =
  "It’s wrong, expired or already used. Run pkey login for a new code.";

const unusableCard: Card = {
  heading: "This code can’t be used",
  body:
    `<p>${escapeHtml(UNUSABLE_DETAIL)}</p>` +
    `<p class="actions"><a class="button" href="/manage/device">Enter another code</a></p>`,
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
        "End one, then run pkey login again.",
      ) +
      `<p class="actions"><a class="button" href="/manage/#/personal-tokens">Open Personal tokens</a></p>`,
  };
}

function approvedCard(view: CliDeviceLoginView, now: number): Card {
  return {
    heading: "Signed in",
    preface: icon("check-circle").replace('class="ic"', 'class="ic lg"'),
    body: `<p>Go back to your terminal. pkey on ${escapeHtml(shown(view.client.host, HOST_MAX))} can act as you until ${escapeHtml(date(now + PERSONAL_TOKEN_DAYS.admin.default * 86_400))}.</p>`,
  };
}

const deniedCard: Card = {
  heading: "Sign-in canceled",
  body: callout("x-circle", "Nothing was approved", "You can close this tab."),
};

function noAccessCard(session: AdminSession, code: string | null): Card {
  return {
    heading: "You don’t have access",
    body:
      callout(
        "lock",
        "This account has no role in the console",
        "Ask a Superadmin to give you one, then run pkey login again.",
      ) +
      personRow({
        name: session.name || session.email,
        email: session.email,
      }) +
      `<p class="actions"><a class="button" href="${escapeHtml(otherAccount(code))}">Use another account${icon("arrow-right")}</a></p>`,
  };
}

/** A refusal: the heading says what, one line says why, and the one primary is the way back (with
 *  the code kept). */
function refuse(
  status: number,
  heading: string,
  detail: string,
  env: Env,
  code: string | null,
  label = "Back",
): Response {
  const back = code
    ? `/manage/device?code=${encodeURIComponent(code)}`
    : "/manage/device";
  return html(
    status,
    {
      heading,
      body: `<p>${escapeHtml(detail)}</p><p class="actions"><a class="button" href="${escapeHtml(back)}">${escapeHtml(label)}</a></p>`,
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
  const typedInUrl = readCode(path, url, null);
  const pathCode = typedInUrl.code;

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
    // A step-up that lands signed out after a cross-site hop (the IdP's redirect) is answered
    // with a same-site meta refresh, so the browser sends the cookie on the next request.
    if (
      req.method === "GET" &&
      req.headers.get("sec-fetch-site") === "cross-site"
    )
      return refreshTo(
        pathCode ? `/manage/device?code=${pathCode}` : "/manage/device",
        env,
      );
    return redirect(signInTo(pathCode, true));
  }
  const { principal } = caller;

  // 2. A member.
  if (!can(principal, PLATFORM, "console", "view"))
    return html(403, noAccessCard(session, pathCode), env);

  // 4/5. A decision is a same-origin form with the session's CSRF token.
  let form: URLSearchParams | null = null;
  if (req.method === "POST") {
    if (!sameOriginPost(req))
      return refuse(
        403,
        "This page expired",
        "Reload it and try again.",
        env,
        pathCode,
        "Reload",
      );
    if (!hasFormContentType(req))
      return refuse(
        400,
        "Something went wrong",
        "Reload the page and try again.",
        env,
        pathCode,
        "Reload",
      );
    // The cap counts the bytes read, not the declared length.
    const raw = await readTextCapped(req, BODY_MAX);
    if (raw === null)
      return refuse(
        413,
        "Request too large",
        "Reload the page and try again.",
        env,
        pathCode,
        "Reload",
      );
    form = new URLSearchParams(raw);
    const sent = form.get("csrf");
    if (typeof sent !== "string" || !constantTimeEqual(sent, session.csrf))
      return refuse(
        403,
        "This page expired",
        "Reload it and try again.",
        env,
        null,
        "Reload",
      );
  }

  const typed = readCode(path, url, form);
  const code = typed.code;
  if (!code) {
    // Nothing typed: the form. Something typed that is not a code: the form again, with the value
    // kept and the reason under the field.
    if (typed.raw === null) return html(200, entryCard(), env);
    return html(
      200,
      entryCard({
        message: SHAPE_MESSAGE,
        value: typed.raw.trim().slice(0, PHONE_CODE_MAX),
      }),
      env,
    );
  }

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
    return refuse(
      429,
      "Too many tries",
      "Wait a minute and try again.",
      env,
      code,
      "Try again",
    );

  const steppedUp = isSteppedUp(session, now);

  // A code that cannot be used: from the code form, the form again with the reason under the field;
  // from a link, the card that says so.
  const unusable = () =>
    typed.entered && req.method === "GET"
      ? html(200, entryCard({ message: UNUSABLE_DETAIL, value: code }), env)
      : html(410, unusableCard, env);

  if (req.method === "GET") {
    const view = await cliDeviceLoginLookup(env, code, now);
    if (!view) return unusable();
    if (await tokenLimitReached(db, session.aid, now))
      return html(409, limitCard(), env);
    return html(
      200,
      await reviewCard(db, view, session, principal, now, steppedUp, false),
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
      code,
      "Reload",
    );

  const view = await cliDeviceLoginLookup(env, code, now);
  if (!view) return html(410, unusableCard, env);

  // 7. Approving needs a fresh sign-in.
  if (decision === "approve" && !steppedUp) {
    await platformAudit(
      db,
      session,
      now,
      "cli.login.step_up_required",
      { kind: "cli_login", id: view.id },
      `Asked to sign in again before approving pkey on ${view.client.host}`,
    );
    return html(
      403,
      await reviewCard(db, view, session, principal, now, false, true),
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
  if (!result.ok) return html(410, unusableCard, env);

  const where = view.location.label ? ` near ${view.location.label}` : "";
  try {
    // The audit target is the request's id: the token is minted later, by the terminal's poll.
    await platformAudit(
      db,
      session,
      now,
      decision === "approve" ? "cli.login.approve" : "cli.login.deny",
      { kind: "cli_login", id: view.id },
      `${decision === "approve" ? "Approved" : "Denied"} pkey on ${view.client.host}${where}`,
    );
  } finally {
    // The approval is spent: the person is told even if the audit write failed.
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
  }
  return html(
    200,
    decision === "approve" ? approvedCard(view, now) : deniedCard,
    env,
  );
}
