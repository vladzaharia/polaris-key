/**
 * The console's sign-in card (SIGN-IN.md §3.12, EXPERIENCE.md §8): `GET /manage/login` serves it
 * and the IdP redirect starts only when the operator presses Continue. Script-free: Continue is a
 * form that POSTs the same path (SIGN-IN.md §3.13), so the typed address is in a body and not in a
 * URL, and the Worker answers 303. The state flags (`signedOut`, `ended`, `stepUp`) pick
 * static copy and carry nothing else; `returnTo` is re-sanitised before it is written out.
 */
import { escapeHtml } from "../platform/html.js";
import { callout, icon, renderAuthCard } from "../core/brandHtml.js";
import { SIGNIN_SCRIPT } from "./signinScript.js";

/**
 * Help and Privacy under the card: public Polaris Key pages that need no session. Operators are
 * not customers, so these never point at customer Help (`/docs/help/`, which lives on Polaris Locker).
 */
export const CONSOLE_CARD_LINKS = [
  { label: "Help", href: "/docs/" },
  { label: "Privacy", href: "/docs/reference/what-apps-collect/" },
] as const;

export type SigninState =
  | "signin"
  | "signedOut"
  | "ended"
  | "stepUp"
  | "breakGlass";

const COPY: Record<SigninState, { h1: string; lede: string }> = {
  // Signed out and ended are the plain card (ended adds a notice): Polaris Locker's states.
  signin: { h1: "Sign in to the console", lede: "" },
  signedOut: { h1: "Sign in to the console", lede: "" },
  ended: { h1: "Sign in to the console", lede: "" },
  stepUp: {
    h1: "Confirm it’s you",
    lede: "This change needs a fresh sign-in.",
  },
  // ST-30c.2: the break-glass start card (ST-28 §2.6). It starts the PKCE flow with `breakGlass=1`.
  breakGlass: {
    h1: "Emergency sign-in",
    lede: "For when your account can’t sign in. Superadmins only.",
  },
};

export function signinState(url: URL): SigninState {
  if (url.searchParams.get("breakGlass") === "1") return "breakGlass";
  if (url.searchParams.get("stepUp") === "1") return "stepUp";
  if (url.searchParams.get("ended") === "1") return "ended";
  if (url.searchParams.get("signedOut") === "1") return "signedOut";
  return "signin";
}

function hidden(name: string, value: string | null | undefined): string {
  return value
    ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
    : "";
}

/** A method button's label: its glyph beside the words (the glyph hides under large text). */
function methodLabel(glyph: "fingerprint" | "building", text: string): string {
  return `${icon(glyph)}<span>${escapeHtml(text)}</span>`;
}

/**
 * The passkey button, `hidden` until the script finds WebAuthn (so the no-JS card is unchanged).
 * A step-up has no "or" above it: it is the primary, with "or" before single sign-on. `returnTo`
 * is sanitised. On the sign-in card the script also owns the returning-person step (`hintView`).
 */
function passkeyBlock(state: SigninState, returnTo: string | null): string {
  const stepUp = state === "stepUp";
  const button =
    `<button class="${stepUp ? "button" : "button secondary"}" type="button" id="pk-go" aria-describedby="pk-err">` +
    `${methodLabel("fingerprint", stepUp ? "Use your passkey" : "Sign in with a passkey")}</button>`;
  const err = `<div class="pk-err" id="pk-err" role="alert"><p class="field-err" id="pk-msg" hidden></p></div>`;
  const or = `<div class="or" aria-hidden="true">or</div>`;
  return (
    `<div class="pk" id="pk" hidden${stepUp ? ` data-step-up="1"` : ""}${returnTo ? ` data-return-to="${escapeHtml(returnTo)}"` : ""}>` +
    // Sign-in: "or", then the ghost. Step-up: the primary, its message, then "or" before single sign-on.
    (stepUp ? button + err + or : or + button + err) +
    `<script>${SIGNIN_SCRIPT}</script></div>`
  );
}

/**
 * The returning-person step (Polaris Locker's HintStep): rendered `hidden` with literal copy; the
 * script fills the first name, address, initial and "last time" from what this browser remembers
 * and swaps it in for the email step. Nothing here comes from a request.
 */
function hintView(): string {
  return (
    `<div class="ac-body" id="pk-hint" hidden>` +
    `<div class="chip"><span class="ac-mono" id="h-ini" aria-hidden="true"></span><span class="chip-email" id="h-email"></span>` +
    `<button class="chip-change" id="h-change" type="button">Change</button></div>` +
    `<h1 id="h-title" tabindex="-1">Welcome back</h1>` +
    `<div class="usual">${icon("fingerprint")}<div><p class="usual-1">You usually sign in with a passkey</p><p class="usual-2" id="h-when"></p></div></div>` +
    `<button class="button" type="button" id="h-go">${methodLabel("fingerprint", "Use a passkey")}</button>` +
    `<div class="or" aria-hidden="true">or</div>` +
    `<button class="button secondary" type="button" id="h-sso">${methodLabel("building", "Continue with single sign-on")}</button>` +
    `<div class="pk-err pk-err-start" role="alert"><p class="field-err" id="h-msg" hidden></p></div>` +
    `<p class="tertiary"><button class="quiet" type="button" id="h-other">Other ways to sign in</button></p>` +
    `</div>`
  );
}

/** The card. `returnTo` is already sanitised. */
export function renderConsoleSignin(opts: {
  state: SigninState;
  returnTo: string | null;
  /** The typed address, kept across an error and back. */
  hint?: string | null;
  /** A step-up knows who is signing in again: no field, the address is the IdP's hint. */
  knownEmail?: string | null;
  /** The address check refused what was typed: the field says so, keeps it and takes focus. */
  invalid?: boolean;
  /**
   * The passkey button and its script (ST-30c.6). The caller decides: the console RP resolves for
   * this request and, on a step-up, the signed-in account holds a console passkey. Never on the
   * emergency card.
   */
  passkey?: boolean;
}): string {
  const c = COPY[opts.state];
  const bg = opts.state === "breakGlass";
  const stepUp = opts.state === "stepUp";
  const ctxQuery = (extra: Record<string, string>) => {
    const q = new URLSearchParams(extra);
    if (opts.returnTo) q.set("returnTo", opts.returnTo);
    return `/manage/login?${q.toString()}`;
  };
  const offerPasskey = opts.passkey === true && !bg;
  const identifier = bg
    ? ""
    : opts.knownEmail
      ? hidden("login_hint", opts.knownEmail)
      : `<div class="field"><label for="email">Email</label>` +
        `<input id="email" type="email" name="login_hint" autofocus placeholder="you@example.com" autocomplete="${offerPasskey ? "username webauthn" : "username"}" autocapitalize="none" spellcheck="false" maxlength="254"${opts.hint ? ` value="${escapeHtml(opts.hint)}"` : ""}${opts.invalid ? ` aria-invalid="true" aria-describedby="email-err"` : ""}>` +
        (opts.invalid
          ? `<p class="field-err" id="email-err" role="alert">Enter a full email address, like name@example.com.</p>`
          : "") +
        `</div>`;
  const submit = stepUp
    ? `<button class="button" type="submit">${methodLabel("building", "Continue with single sign-on")}</button>`
    : `<button class="button" type="submit">Continue</button>`;
  const body = [
    opts.state === "ended"
      ? `<p class="sn" role="alert">Your session ended.</p>`
      : "",
    c.lede ? `<p>${escapeHtml(c.lede)}</p>` : "",
    // The path is elevated, so it reads that way: the one fact an operator must weigh sits in a
    // callout with a glyph, not in a line of lede.
    bg
      ? callout(
          "shield",
          "Every use is recorded and every Superadmin is emailed.",
        )
      : "",
    // On a step-up the passkey leads (the primary), so its block sits before the form; elsewhere it follows.
    offerPasskey && stepUp ? passkeyBlock(opts.state, opts.returnTo) : "",
    `<form method="post" action="/manage/login" novalidate>`,
    hidden("returnTo", opts.returnTo),
    stepUp ? hidden("stepUp", "1") : "",
    bg ? hidden("breakGlass", "1") : "",
    identifier,
    submit,
    `</form>`,
    offerPasskey && !stepUp ? passkeyBlock(opts.state, opts.returnTo) : "",
    // The card's last line (SIGNIN-REDESIGN §5, §6): a door to another start, not a way to sign in.
    stepUp
      ? ""
      : bg
        ? `<p class="tertiary"><a href="${escapeHtml(ctxQuery({}))}">Back to sign in</a></p>`
        : `<p class="tertiary"><a href="${escapeHtml(ctxQuery({ breakGlass: "1" }))}">Emergency sign-in</a></p>`,
  ].join("");
  const returning = offerPasskey && !stepUp;
  return renderAuthCard({
    brand: "console",
    title: c.h1,
    heading: c.h1,
    body,
    // A step-up's title takes focus; so does an Emergency card's. The address field otherwise (autofocus).
    focusHeading: bg || Boolean(opts.knownEmail),
    // The identity pill: who is signing in, above the title. A step-up's is fixed: no Change.
    preface: stepUp && opts.knownEmail ? identityPill(opts.knownEmail) : "",
    ...(returning ? { alt: hintView() } : {}),
    links: CONSOLE_CARD_LINKS,
  });
}

/**
 * The identity pill, the Locker hint step's: an initial avatar, the address (it breaks at "@" and
 * "."). A step-up's identity is fixed, so it has no Change; the returning-person step's pill
 * (`hintView`) has one.
 */
function identityPill(email: string): string {
  return (
    `<div class="chip"><span class="ac-mono" aria-hidden="true">${escapeHtml((email[0] ?? "?").toUpperCase())}</span>` +
    `<span class="chip-email">${escapeHtml(email).replace(/[@.]/g, "<wbr>$&")}</span></div>`
  );
}

/** A way forward on a notice: a link, or a POST that carries the context as hidden fields. */
export type NoticeAction =
  | { label: string; href: string }
  | {
      label: string;
      post: { action: string; fields: Readonly<Record<string, string>> };
    };

function renderAction(a: NoticeAction): string {
  if ("href" in a)
    return `<p class="actions"><a class="button" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a></p>`;
  const fields = Object.entries(a.post.fields)
    .map(([k, v]) => hidden(k, v))
    .join("");
  return `<form class="actions" method="post" action="${escapeHtml(a.post.action)}">${fields}<button class="button" type="submit">${escapeHtml(a.label)}</button></form>`;
}

/** A sign-in refusal or failure on the same card: a heading, one line, an optional way forward. */
export function renderConsoleNotice(opts: {
  heading: string;
  lede?: string;
  action?: NoticeAction;
  /** The tertiary line: a way back to the card. */
  back?: { label: string; href: string };
}): string {
  return renderAuthCard({
    brand: "console",
    title: opts.heading,
    heading: opts.heading,
    body:
      (opts.lede ? `<p>${escapeHtml(opts.lede)}</p>` : "") +
      (opts.action ? renderAction(opts.action) : "") +
      (opts.back
        ? `<p class="tertiary"><a href="${escapeHtml(opts.back.href)}">${escapeHtml(opts.back.label)}</a></p>`
        : ""),
    focusHeading: true,
    links: CONSOLE_CARD_LINKS,
  });
}
