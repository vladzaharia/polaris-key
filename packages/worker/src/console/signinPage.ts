/**
 * The console's sign-in card (SIGN-IN.md §3.12, EXPERIENCE.md §8): `GET /manage/login` serves it
 * and the IdP redirect starts only when the operator presses Continue. Script-free: Continue is a
 * form that POSTs the same path (SIGN-IN.md §3.13), so the typed address is in a body and not in a
 * URL, and the Worker answers 303. The state flags (`signedOut`, `ended`, `stepUp`) pick
 * static copy and carry nothing else; `returnTo` is re-sanitised before it is written out.
 */
import { escapeHtml } from "../platform/html.js";
import { callout, icon, renderAuthCard } from "../core/brandHtml.js";

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
  // ST-30c.2: the break-glass start card (ST-28 §2.6). It starts the PKCE flow with `breakGlass=1`.
  breakGlass: {
    h1: "Emergency sign-in",
    lede: "For when your account can’t sign in. Superadmins only.",
    cta: "Continue",
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

/** The card. `returnTo` is already sanitised; `issuerHost` is the IdP's host, shown once. */
export function renderConsoleSignin(opts: {
  state: SigninState;
  returnTo: string | null;
  issuerHost: string;
  /** The typed address, kept across an error and back. */
  hint?: string | null;
  /** A step-up knows who is signing in again: no field, the address is the IdP's hint. */
  knownEmail?: string | null;
  /**
   * ST-30c.2 (D-S5): the last operator's address from the hint cookie, validated by the caller.
   * It shows as "email · Change" in place of the empty field, carried as the hidden `login_hint`.
   */
  chip?: string | null;
  /** After Change: the empty field takes focus (the card is script-free, so `autofocus`). */
  focusEmail?: boolean;
}): string {
  const c = COPY[opts.state];
  const bg = opts.state === "breakGlass";
  const ctxQuery = (extra: Record<string, string>) => {
    const q = new URLSearchParams(extra);
    if (opts.returnTo) q.set("returnTo", opts.returnTo);
    return `/manage/login?${q.toString()}`;
  };
  const stateFlag: Record<string, string> =
    opts.state === "signedOut"
      ? { signedOut: "1" }
      : opts.state === "ended"
        ? { ended: "1" }
        : {};
  const chip = !bg && opts.state !== "stepUp" && opts.chip ? opts.chip : null;
  const identifier = bg
    ? ""
    : opts.knownEmail
      ? `${hidden("login_hint", opts.knownEmail)}<p class="fine">Signing in as ${escapeHtml(opts.knownEmail)}</p>`
      : chip
        ? `${hidden("login_hint", chip)}<div class="field"><span class="field-label" id="email-label">Email</span>` +
          `<div class="chip" role="group" aria-labelledby="email-label"><span class="ac-mono" aria-hidden="true">${escapeHtml(initialsOf(chip))}</span>` +
          `<span class="chip-email">${escapeHtml(chip).replace(/[@.]/g, "<wbr>$&")}</span>` +
          `<a class="chip-change" href="${escapeHtml(ctxQuery({ change: "1", ...stateFlag }))}">Change</a></div></div>`
        : `<div class="field"><label for="email">Email</label>` +
          `<input id="email" type="email" name="login_hint"${opts.focusEmail ? " autofocus" : ""} autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254"${opts.hint ? ` value="${escapeHtml(opts.hint)}"` : ""}></div>`;
  const body = [
    c.lede ? `<p>${escapeHtml(c.lede)}</p>` : "",
    // The path is elevated, so it reads that way: the one fact an operator must weigh sits in a
    // callout with a glyph, not in a line of lede.
    bg
      ? callout(
          "shield",
          "Every use is recorded and every Superadmin is emailed.",
        )
      : "",
    `<form method="post" action="/manage/login" novalidate>`,
    hidden("returnTo", opts.returnTo),
    opts.state === "stepUp" ? hidden("stepUp", "1") : "",
    bg ? hidden("breakGlass", "1") : "",
    identifier,
    `<button class="button" type="submit">${escapeHtml(c.cta)}${icon("arrow-right")}</button>`,
    `</form>`,
    `<p class="fine">Next: sign in at ${escapeHtml(opts.issuerHost)}</p>`,
  ].join("");
  // The emergency link is quiet: one more item under the card, on the states that start a sign-in.
  const links =
    opts.state === "stepUp"
      ? CONSOLE_CARD_LINKS
      : bg
        ? [
            ...CONSOLE_CARD_LINKS,
            { label: "Back to sign in", href: ctxQuery({}) },
          ]
        : [
            ...CONSOLE_CARD_LINKS,
            {
              label: "Emergency sign-in",
              href: ctxQuery({ breakGlass: "1" }),
            },
          ];
  return renderAuthCard({
    brand: "console",
    title: c.h1,
    heading: c.h1,
    body,
    focusHeading: !(opts.focusEmail && !chip && !opts.knownEmail && !bg),
    links,
    linksLabel: "Help and links",
  });
}

/**
 * The chip's avatar letters, by the console's own rule (the shell's initials): the first code
 * point of the first two words of the address's local part ("vlad.zaharia" gives "VZ"), else "?".
 */
function initialsOf(email: string): string {
  const words = (email.split("@")[0] ?? "").split(/[._+\-\s]+/).filter(Boolean);
  const out = words
    .slice(0, 2)
    .map((w) => [...w][0] ?? "")
    .join("")
    .toUpperCase();
  return out || "?";
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
