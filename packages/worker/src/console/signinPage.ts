/**
 * The console's sign-in card (SIGN-IN.md §3.12, EXPERIENCE.md §8): `GET /manage/login` serves it
 * and the IdP redirect starts only when the operator presses Continue. Script-free: Continue is a
 * form that GETs the same path with `go=1`. The state flags (`signedOut`, `ended`, `stepUp`) pick
 * static copy and carry nothing else; `returnTo` is re-sanitised before it is written out.
 */
import { escapeHtml } from "../platform/html.js";
import { icon, renderAuthCard } from "../core/brandHtml.js";

export type SigninState = "signin" | "signedOut" | "ended" | "stepUp";

const COPY: Record<SigninState, { h1: string; lede: string; cta: string }> = {
  signin: { h1: "Sign in to the console", lede: "", cta: "Continue" },
  signedOut: { h1: "You're signed out", lede: "", cta: "Continue" },
  ended: {
    h1: "Your session ended",
    lede: "Sign in again to carry on.",
    cta: "Continue",
  },
  stepUp: {
    h1: "Confirm it's you",
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
}): string {
  const c = COPY[opts.state];
  const body = [
    c.lede ? `<p>${escapeHtml(c.lede)}</p>` : "",
    `<form method="get" action="/manage/login">`,
    hidden("go", "1"),
    hidden("returnTo", opts.returnTo),
    opts.state === "stepUp" ? hidden("stepUp", "1") : "",
    `<div class="field"><label for="email">Email</label>`,
    `<input id="email" type="email" name="login_hint" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254"></div>`,
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
  });
}

/** A sign-in refusal or failure on the same card: one heading, an optional way forward. */
export function renderConsoleNotice(opts: {
  heading: string;
  action?: { label: string; href: string };
}): string {
  return renderAuthCard({
    brand: "console",
    title: opts.heading,
    heading: opts.heading,
    body: opts.action
      ? `<p class="actions"><a class="button" href="${escapeHtml(opts.action.href)}">${escapeHtml(opts.action.label)}</a></p>`
      : "",
    focusHeading: true,
  });
}
