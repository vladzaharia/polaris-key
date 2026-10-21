/**
 * The console's sign-in card (SIGN-IN.md §3.12, EXPERIENCE.md §8): `GET /manage/login` serves it
 * and the IdP redirect starts only when the operator presses Continue. Script-free: Continue is a
 * form that POSTs the same path (SIGN-IN.md §3.13), so the typed address is in a body and not in a
 * URL, and the Worker answers 303. The state flags (`signedOut`, `ended`, `stepUp`) pick
 * static copy and carry nothing else; `returnTo` is re-sanitised before it is written out.
 */
import { escapeHtml } from "../platform/html.js";
import { icon, renderAuthCard } from "../core/brandHtml.js";

/**
 * Help and Privacy under the card: public Polaris Key pages that need no session. Operators are
 * not customers, so these never point at customer Help (`/docs/help/`, which lives on Polaris Locker).
 */
export const CONSOLE_CARD_LINKS = [
  { label: "Help", href: "/docs/" },
  { label: "Privacy", href: "/docs/reference/what-apps-collect/" },
] as const;

export type SigninState = "signin" | "signedOut" | "ended" | "stepUp";

const COPY: Record<SigninState, { h1: string; lede: string; cta: string }> = {
  signin: { h1: "Sign in to the console", lede: "", cta: "Continue" },
  signedOut: { h1: "You’re signed out", lede: "", cta: "Continue" },
  ended: {
    h1: "Your session ended",
    lede: "Sign in again to carry on.",
    cta: "Continue",
  },
  stepUp: {
    h1: "Confirm it’s you",
    lede: "This change needs a fresh sign-in.",
    cta: "Sign in again",
  },
};

export function signinState(url: URL): SigninState {
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

/** The card. `returnTo` is already sanitised; `issuerHost` is the IdP's host, shown once. */
export function renderConsoleSignin(opts: {
  state: SigninState;
  returnTo: string | null;
  issuerHost: string;
  /** The typed address, kept across an error and back. */
  hint?: string | null;
  /** A step-up knows who is signing in again: no field, the address is the IdP's hint. */
  knownEmail?: string | null;
}): string {
  const c = COPY[opts.state];
  const body = [
    c.lede ? `<p>${escapeHtml(c.lede)}</p>` : "",
    `<form method="post" action="/manage/login">`,
    hidden("returnTo", opts.returnTo),
    opts.state === "stepUp" ? hidden("stepUp", "1") : "",
    opts.knownEmail
      ? `${hidden("login_hint", opts.knownEmail)}<p class="fine">Signing in as ${escapeHtml(opts.knownEmail)}</p>`
      : `<div class="field"><label for="email">Email</label>` +
        `<input id="email" type="email" name="login_hint" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254"${opts.hint ? ` value="${escapeHtml(opts.hint)}"` : ""}></div>`,
    `<button class="button" type="submit">${escapeHtml(c.cta)}${icon("arrow-right")}</button>`,
    `</form>`,
    `<p class="fine">Next: sign in at ${escapeHtml(opts.issuerHost)}</p>`,
  ].join("");
  return renderAuthCard({
    brand: "console",
    title: c.h1,
    heading: c.h1,
    body,
    focusHeading: true,
    links: CONSOLE_CARD_LINKS,
  });
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
}): string {
  return renderAuthCard({
    brand: "console",
    title: opts.heading,
    heading: opts.heading,
    body:
      (opts.lede ? `<p>${escapeHtml(opts.lede)}</p>` : "") +
      (opts.action ? renderAction(opts.action) : ""),
    focusHeading: true,
    links: CONSOLE_CARD_LINKS,
  });
}
