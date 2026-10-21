#!/usr/bin/env node
/**
 * The host-side approver for a device-code sign-in on a running `pkey dev` (SP-41).
 *
 * An SDK's `beginSignIn` hands the app a verification URL and a user code. A person opens the URL,
 * checks the code, presses "Continue to sign in" and presses Approve at the identity provider. This
 * does the same over loopback HTTP, with a cookie jar standing in for the browser, so a live SDK
 * test can drive begin, poll and wait to `ready` with no browser and no endpoint the product does
 * not already serve:
 *
 *   node packages/cli/scripts/dev-approve.mjs <verificationUri | verificationUriComplete> <userCode>
 *
 * The URL may or may not carry `?user_code=`; when it does, that code must be the one given.
 * Exit 0: approved, the callback answered with the signed-in page (stdout: `approved <code>`).
 * Exit 1: refused or a check failed (stderr: `dev-approve: <step>: <why>`). Exit 2: usage.
 * `--verbose` narrates each hop on stderr. Cookie and CSRF values are never printed.
 *
 * What it checks, because an approver that clicks whatever it is handed would prove nothing:
 * - the URL is plain `http:` on loopback and names the device page, and, when
 *   `PKEY_DEV_BASE_URL` is set, is that server's origin;
 * - every redirect stays on that origin, and the sign-in leg goes to the dev IdP (`/__idp/`);
 * - the confirmation page shows the code it was given, and its form posts to the device page;
 * - cookies follow the rules a browser applies (`Path` matching, `__Host-`/`__Secure-` prefixes),
 *   so a cookie the Worker sets that a browser would drop fails here too, rather than as an
 *   unexplained "unknown state" at the callback;
 * - the last answer is the "Signed in" page, not an error page or a licence chooser.
 *
 * The server may run with or without `--auto-approve`: without it the IdP shows its Approve page
 * and this presses the button.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REQUEST_TIMEOUT_MS = 15_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEVICE_PAGE = /\/identity\/auth\/device\/?$/;
const CALLBACK_PAGE = /\/identity\/auth\/callback$/;

const USAGE = [
  "Usage: node dev-approve.mjs [--verbose] <verificationUri | verificationUriComplete> <userCode>",
  "Approves a device-code sign-in on a running `pkey dev` (loopback only). Exit 0: approved.",
].join("\n");

export class ApproveError extends Error {}

const fail = (message) => {
  throw new ApproveError(message);
};

// ── the code and the URL ─────────────────────────────────────────────────────────────────────

/** `bcdf-ghjk`, ` BCDF GHJK ` and `BCDFGHJK` are one code. Anything that cannot be one is refused. */
export function normalizeUserCode(raw) {
  const code = String(raw ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{6,16}$/.test(code))
    fail(
      `${JSON.stringify(String(raw ?? "").slice(0, 40))} is not a user code (the short code the app shows, like BCDF-GHJK; not the device code)`,
    );
  return code;
}

/** The code the way the app shows it: `BCDF-GHJK` for the eight-character codes the Worker issues. */
const displayCode = (code) =>
  code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

/** The device page to open: loopback, plain http, this server's origin, this code. */
function entryUrl(raw, code, baseUrl) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${JSON.stringify(String(raw).slice(0, 80))} is not a URL`);
  }
  if (url.protocol !== "http:")
    fail(
      `the verification URL must be http: (pkey dev serves plain HTTP); got ${url.protocol}`,
    );
  if (!LOOPBACK.has(url.hostname))
    fail(
      `${url.hostname} is not loopback: this approver only talks to a pkey dev on this machine`,
    );
  if (url.username || url.password)
    fail("the verification URL must not carry credentials");
  if (!DEVICE_PAGE.test(url.pathname))
    fail(
      `${url.pathname} is not a device verification page (.../identity/auth/device)`,
    );
  if (baseUrl) {
    let expected;
    try {
      expected = new URL(baseUrl).origin;
    } catch {
      return fail(`PKEY_DEV_BASE_URL (${baseUrl}) is not a URL`);
    }
    if (url.origin !== expected)
      fail(
        `the verification URL is at ${url.origin} but PKEY_DEV_BASE_URL is ${expected}: wrong server`,
      );
  }
  const given = url.searchParams.get("user_code");
  if (given !== null && normalizeUserCode(given) !== code)
    fail(
      `the verification URL carries code ${given}, not the code given (${code})`,
    );
  if (given === null) url.searchParams.set("user_code", displayCode(code));
  return url;
}

// ── the browser stand-in: a cookie jar and an HTML form reader ───────────────────────────────

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (whole, dec, hex, name) => {
      try {
        if (dec) return String.fromCodePoint(Number(dec));
        if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return whole;
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    },
  );
}

function parseAttrs(source) {
  const out = new Map();
  const attr =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;
  for (const m of source.matchAll(attr))
    out.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  return out;
}

/** Every `<form>`: its method, action, hidden fields in order, and named buttons. */
export function readForms(html) {
  const forms = [];
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = parseAttrs(form[1]);
    const fields = [];
    const buttons = [];
    for (const control of form[2].matchAll(/<(input|button)\b([^>]*)>/gi)) {
      const c = parseAttrs(control[2]);
      const name = c.get("name");
      if (!name) continue;
      if (control[1].toLowerCase() === "button")
        buttons.push([name, c.get("value") ?? ""]);
      else if ((c.get("type") ?? "text").toLowerCase() === "hidden")
        fields.push([name, c.get("value") ?? ""]);
    }
    forms.push({
      method: (attrs.get("method") ?? "get").toLowerCase(),
      action: attrs.get("action") ?? "",
      fields,
      buttons,
    });
  }
  return forms;
}

/** RFC 6265 §5.1.4. */
function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function defaultPath(pathname) {
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash);
}

/** One origin's cookies, kept and sent the way a browser would on a secure loopback origin. */
class Jar {
  #cookies = new Map();

  names() {
    return [...this.#cookies.keys()];
  }

  store(url, response) {
    for (const line of response.headers.getSetCookie()) {
      const parts = line.split(";").map((p) => p.trim());
      const eq = parts[0].indexOf("=");
      if (eq <= 0) continue;
      const name = parts[0].slice(0, eq);
      const value = parts[0].slice(eq + 1);
      const attrs = new Map();
      for (const p of parts.slice(1)) {
        const i = p.indexOf("=");
        attrs.set(
          (i < 0 ? p : p.slice(0, i)).toLowerCase(),
          i < 0 ? "" : p.slice(i + 1),
        );
      }
      const declared = attrs.get("path");
      const cookiePath = declared?.startsWith("/")
        ? declared
        : defaultPath(url.pathname);
      if (
        name.startsWith("__Host-") &&
        !(attrs.has("secure") && cookiePath === "/" && !attrs.has("domain"))
      )
        fail(
          `${url.pathname}: the server set ${name} without Secure, Path=/ and no Domain; a browser would drop it`,
        );
      if (name.startsWith("__Secure-") && !attrs.has("secure"))
        fail(
          `${url.pathname}: the server set ${name} without Secure; a browser would drop it`,
        );
      const gone = attrs.has("max-age")
        ? Number(attrs.get("max-age")) <= 0
        : attrs.has("expires") &&
          Date.parse(attrs.get("expires")) <= Date.now();
      if (gone) this.#cookies.delete(name);
      else this.#cookies.set(name, { value, path: cookiePath });
    }
  }

  header(url) {
    return [...this.#cookies]
      .filter(([, c]) => pathMatches(url.pathname, c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join("; ");
  }
}

/** One request, never following a redirect itself, with the jar's cookies in and out. */
async function send(jar, label, url, init = {}) {
  const headers = new Headers(init.headers);
  const cookie = jar.header(url);
  if (cookie) headers.set("cookie", cookie);
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const why =
      e?.cause?.code ??
      e?.cause?.errors?.[0]?.code ??
      e?.cause?.message ??
      e?.name ??
      "error";
    return fail(
      `${label}: ${url.origin} did not answer (${why}); is pkey dev still running?`,
    );
  }
  jar.store(url, res);
  return res;
}

/** Where a redirect goes: absolute, and never off the origin this approval started at. */
function redirectTarget(res, from, label) {
  if (!REDIRECTS.has(res.status)) return null;
  const location = res.headers.get("location");
  if (!location) return fail(`${label}: ${res.status} with no Location`);
  let to;
  try {
    to = new URL(location, from);
  } catch {
    return fail(`${label}: ${res.status} with an unusable Location`);
  }
  if (to.origin !== from.origin)
    fail(
      `${label}: redirected to ${to.origin}, off the dev server (${from.origin})`,
    );
  return to;
}

/** A readable one-liner of what an unexpected page said, for the failure message. */
function digest(text) {
  return decodeEntities(
    text
      .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const FORM_HEADERS = (origin) => ({
  "content-type": "application/x-www-form-urlencoded",
  // A form submitted from the page it is served from: what the Worker's same-origin POST check reads.
  "sec-fetch-site": "same-origin",
  origin,
});

/** The code the confirmation page shows: `<dd class="code">` (before I-38a) or `<span class="code">`. */
export function readShownCode(html) {
  return /<(?:dd|span)\b[^>]*\bclass="code"[^>]*>([^<]*)<\/(?:dd|span)>/i.exec(
    html,
  )?.[1];
}

/** The approval page's form (I-37): a hidden single-use token and a `decision=approve` button. */
export function readApprovalForm(html) {
  return readForms(html).find(
    (f) =>
      f.method === "post" &&
      f.fields.some(([name, v]) => name === "token" && v) &&
      f.buttons.some(([n, v]) => n === "decision" && v === "approve"),
  );
}

/** The done page: "Signed in on …" (I-38a) or "{App} is signed in" (I-37). */
export function isSignedInPage(html) {
  return /<title>\s*(?:Signed in\b|[^<]*\bis signed in\b)/i.test(html);
}

const APPROVE_PAGE = /\/identity\/auth\/device\/approve$/;

// ── the approval ─────────────────────────────────────────────────────────────────────────────

/**
 * Approve the device-code sign-in `userCode` at `verificationUrl`.
 *
 * @param {string} verificationUrl the SDK's `verificationUri` or `verificationUriComplete`
 * @param {string} userCode        the code the SDK shows
 * @param {{ baseUrl?: string, log?: (line: string) => void }} [opts]
 *        `baseUrl`: the server the URL must belong to (the harness's `PKEY_DEV_BASE_URL`)
 * @returns {Promise<{ origin: string, userCode: string }>}
 * @throws {ApproveError} on any refusal or failed check; nothing is left half-approved to retry
 */
export async function approveDeviceCode(verificationUrl, userCode, opts = {}) {
  const say = opts.log ?? (() => {});
  const code = normalizeUserCode(userCode);
  const entry = entryUrl(verificationUrl, code, opts.baseUrl);
  const jar = new Jar();

  // 1. The confirmation page, as the person sees it after opening the link.
  say(`open ${entry.pathname}`);
  const opened = await send(jar, "confirmation page", entry);
  const openedText = await opened.text();
  if (opened.status === 404)
    fail(
      "confirmation page: 404, the code is not valid, has expired or was already used",
    );
  if (opened.status !== 200)
    fail(`confirmation page: ${opened.status} ${digest(openedText)}`);
  const shown = readShownCode(openedText);
  if (shown === undefined)
    fail(
      "confirmation page: it shows no code, so it is not the confirmation page",
    );
  if (normalizeUserCode(decodeEntities(shown)) !== code)
    fail(
      `confirmation page: it shows code ${decodeEntities(shown)}, not ${code}`,
    );
  const confirm = readForms(openedText).find(
    (f) => f.method === "post" && f.fields.some(([name]) => name === "csrf"),
  );
  if (!confirm) return fail("confirmation page: no form carrying a CSRF token");
  const csrf = confirm.fields.find(([name]) => name === "csrf")[1];
  if (!csrf) fail("confirmation page: the CSRF token is empty");
  const posted = confirm.fields.find(([name]) => name === "user_code")?.[1];
  if (posted !== undefined && normalizeUserCode(posted) !== code)
    fail(`confirmation page: its form posts code ${posted}, not ${code}`);
  const action = new URL(confirm.action || entry.pathname, entry);
  if (action.origin !== entry.origin || !DEVICE_PAGE.test(action.pathname))
    fail(
      `confirmation page: its form posts to ${action.origin}${action.pathname}, not the device page`,
    );

  // 2. "Continue to sign in": the POST that confirms the flow and binds it to this browser.
  say("confirm");
  const confirmed = await send(jar, "confirmation", action, {
    method: "POST",
    headers: FORM_HEADERS(entry.origin),
    body: new URLSearchParams([...confirm.fields, ["decision", "approve"]]),
  });
  const confirmedText = await confirmed.text();
  const toIdp = redirectTarget(confirmed, action, "confirmation");
  if (!toIdp) {
    const why =
      confirmed.status === 403
        ? "refused: the CSRF token or the same-origin check failed"
        : `${confirmed.status} ${digest(confirmedText)}`;
    fail(
      `confirmation: expected a redirect to the identity provider, got ${why}`,
    );
  }
  if (!toIdp.pathname.startsWith("/__idp/"))
    fail(
      `confirmation: the sign-in leg goes to ${toIdp.pathname}, not the dev identity provider (/__idp/)`,
    );

  // 3. The identity provider: --auto-approve answers with the callback redirect at once; without
  //    it the page has an Approve button.
  say(`identity provider ${toIdp.pathname}`);
  const atIdp = await send(jar, "identity provider", toIdp);
  let callback = redirectTarget(atIdp, toIdp, "identity provider");
  const idpText = await atIdp.text();
  if (!callback) {
    if (atIdp.status !== 200)
      fail(
        `identity provider: expected a redirect or its Approve page, got ${atIdp.status} ${digest(idpText)}`,
      );
    const approve = readForms(idpText).find(
      (f) =>
        f.method === "post" &&
        f.buttons.some(([n, v]) => n === "result" && v === "approve"),
    );
    if (!approve)
      fail(
        "identity provider: neither a redirect nor a form with an Approve button",
      );
    const approveUrl = new URL(approve.action || toIdp.pathname, toIdp);
    if (
      approveUrl.origin !== entry.origin ||
      !approveUrl.pathname.startsWith("/__idp/")
    )
      fail(
        `identity provider: its Approve form posts to ${approveUrl.origin}${approveUrl.pathname}`,
      );
    say("approve at the identity provider");
    const approved = await send(jar, "identity provider approval", approveUrl, {
      method: "POST",
      headers: FORM_HEADERS(entry.origin),
      body: new URLSearchParams([...approve.fields, ["result", "approve"]]),
    });
    const approvedText = await approved.text();
    callback = redirectTarget(
      approved,
      approveUrl,
      "identity provider approval",
    );
    if (!callback)
      fail(
        `identity provider approval: expected the callback redirect, got ${approved.status} ${digest(approvedText)}`,
      );
  }
  const denied = callback.searchParams.get("error");
  if (denied) fail(`identity provider: it refused the sign-in (${denied})`);
  if (
    !CALLBACK_PAGE.test(callback.pathname) ||
    !callback.searchParams.has("code") ||
    !callback.searchParams.has("state")
  )
    fail(
      `identity provider: it redirected to ${callback.pathname}, not the product callback with a code and state`,
    );

  // 4. The callback, in the browser the flow was confirmed in: the binder cookie must come along.
  say(`callback ${callback.pathname}`);
  let done = await send(jar, "callback", callback);
  let doneText = await done.text();
  // I-37: the callback hands over to the explicit approval page (a 303 to .../device/approve),
  // which shows the request and posts the decision. The person presses "Sign in on <device>".
  const toApprove = redirectTarget(done, callback, "callback");
  if (toApprove) {
    if (
      toApprove.origin !== entry.origin ||
      !APPROVE_PAGE.test(toApprove.pathname)
    )
      fail(
        `callback: it redirected to ${toApprove.origin}${toApprove.pathname}, not the approval page`,
      );
    say(`approval ${toApprove.pathname}`);
    const page = await send(jar, "approval page", toApprove);
    const pageText = await page.text();
    if (page.status !== 200)
      fail(`approval page: ${page.status} ${digest(pageText)}`);
    const form = readApprovalForm(pageText);
    if (!form) fail("approval page: no form with a token and a Sign in button");
    const target = new URL(form.action || toApprove.pathname, toApprove);
    if (target.origin !== entry.origin || !APPROVE_PAGE.test(target.pathname))
      fail(
        `approval page: its form posts to ${target.origin}${target.pathname}, not the approval page`,
      );
    say("approve the sign-in");
    done = await send(jar, "approval", target, {
      method: "POST",
      headers: FORM_HEADERS(entry.origin),
      body: new URLSearchParams([...form.fields, ["decision", "approve"]]),
    });
    doneText = await done.text();
  }
  if (done.status !== 200)
    fail(
      `${toApprove ? "approval" : "callback"}: ${done.status} ${digest(doneText)} (cookies held: ${jar.names().join(", ") || "none"})`,
    );
  if (!isSignedInPage(doneText))
    fail(`callback: 200 but not the signed-in page: ${digest(doneText)}`);
  say("signed in");
  return { origin: entry.origin, userCode: displayCode(code) };
}

async function main(argv) {
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const args = argv.filter((a) => a !== "--verbose" && a !== "-v");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (args.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await approveDeviceCode(args[0], args[1], {
      baseUrl: process.env.PKEY_DEV_BASE_URL || undefined,
      ...(verbose
        ? { log: (line) => console.error(`dev-approve: ${line}`) }
        : {}),
    });
    console.log(`approved ${result.userCode}`);
    return 0;
  } catch (e) {
    console.error(
      `dev-approve: ${e instanceof ApproveError ? e.message : (e?.stack ?? e)}`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  process.exitCode = await main(process.argv.slice(2));
