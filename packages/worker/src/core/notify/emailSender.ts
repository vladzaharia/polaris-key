/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../../platform/env.js";

// Who sign-in email is FROM (I-18, S-16 §5.2 "Branding" and §5.4 item 7).
//
// Every message leaves ONE shared sender address on the dedicated auth sending subdomain
// (`AUTH_EMAIL_DOMAIN`), so its reputation is shared by every product (S-16 §9 risk 9). Two
// display names exist, and nothing else may appear in the `From` header:
//
//   - platform mail (the login card's own codes and links, account notices, the dormant-account
//     warning, merge and join notices): exactly "Polaris Key", never " via";
//   - passthrough mail (sign-in started through a product): "<App> via Polaris Key", where
//     <App> is the product's display name AFTER `checkSenderAppName` accepts it and the suffix is
//     fixed text a tenant cannot change.
//
// The address and the name travel as the binding's structured `{ name, email }`, never as a
// hand-built "Name <addr>" string, so the header is encoded by the runtime; the validator still
// refuses every character that could break or spoof a header if some path ever did build one.

/** The dedicated auth sending subdomain of plrs.im (the owner onboards it on Email Sending). */
export const AUTH_EMAIL_DOMAIN = "auth.plrs.im";
/** The one shared sender address on it. */
export const AUTH_EMAIL_ADDRESS = `noreply@${AUTH_EMAIL_DOMAIN}`;
/**
 * The address used while `EMAIL_SENDER_ADDRESS` is unset: today's onboarded sender, so a deploy
 * before the owner onboards the auth subdomain keeps the portal's mail working. Production
 * switches to `AUTH_EMAIL_ADDRESS` by setting the var (RUNBOOK "Sign-in email").
 */
export const LEGACY_EMAIL_ADDRESS = "noreply@plrs.im";

/** The platform's own display name. */
export const PLATFORM_SENDER_NAME = "Polaris Key";
/** The fixed suffix of every passthrough display name. */
export const PASSTHROUGH_SENDER_SUFFIX = " via Polaris Key";
/** The longest product display name (in code points) accepted into a sender name. */
export const SENDER_APP_NAME_MAX = 40;

/**
 * Whole names that may never be a sender's <App>, compared after folding (`foldForReserve`).
 * The S-16 list (portal, console, admin) plus the mailbox roles a recipient reads as the
 * platform speaking ("Support via Polaris Key", "Security via Polaris Key").
 */
const RESERVED_WHOLE_NAMES = new Set([
  "portal",
  "console",
  "admin",
  "administrator",
  "support",
  "security",
  "noreply",
  "donotreply",
  "postmaster",
  "abuse",
  "mailerdaemon",
  "billing",
  "account",
  "accounts",
]);

/**
 * Fragments that may appear NOWHERE in a sender's <App> after folding: the platform's own names
 * (S-16 §5.4 item 7: "Polaris", "Polaris Key", "plrs"), so "Polaris Key Security" or
 * "P0LARIS" is refused.
 */
const RESERVED_FRAGMENTS = ["polaris", "plrs"];

/**
 * Look-alikes folded to one skeleton letter before the reserved-name comparison. Not a full
 * confusables table: it covers the Cyrillic and Greek letters that render like the Latin ones in
 * the reserved names, and the digit and symbol swaps. The ambiguous strokes (`i`, `l`, `1`, `|`,
 * dotless `ı`, Cyrillic `і` and `ӏ`, Greek `ι`) all fold to `i`, and the reserved names are folded
 * the same way, so "P0LAR1S" and "Pоlarls" both meet "polaris".
 */
const LOOKALIKES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  ј: "j",
  ѕ: "s",
  к: "k",
  м: "m",
  н: "h",
  т: "t",
  в: "b",
  α: "a",
  ο: "o",
  ρ: "p",
  κ: "k",
  ν: "v",
  τ: "t",
  υ: "u",
  l: "i",
  "1": "i",
  "|": "i",
  ı: "i",
  і: "i",
  ӏ: "i",
  ι: "i",
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  $: "s",
};

/**
 * Characters that may never appear in a sender's <App>:
 *   - every control, format (bidi overrides, zero-width joiners, BOM), line and paragraph
 *     separator, private-use and surrogate code point;
 *   - the header specials that quote, open an address or escape: `"` `<` `>` `@` `\`.
 * Checked on the NFKC form as well, so a full-width `＜` cannot stand in for `<`.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}"<>@\\]/u;

const CONFUSABLE_MIX_LATIN = /\p{Script=Latin}/u;
const CONFUSABLE_MIX_OTHER =
  /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Coptic}\p{Script=Lisu}]/u;

const FOLDED_WHOLE_NAMES = new Set(
  [...RESERVED_WHOLE_NAMES].map(foldForReserve),
);
const FOLDED_FRAGMENTS = RESERVED_FRAGMENTS.map(foldForReserve);

export type SenderNameRefusal =
  | "empty"
  | "too_long"
  | "forbidden_character"
  | "reserved";

export type SenderNameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: SenderNameRefusal };

/** The comparison form for the reserved names: decomposed, marks stripped, lower case,
 *  look-alikes folded to their skeleton letter, then only ASCII letters and the digits no
 *  look-alike folds kept ("Portal 2" is not "portal"). */
export function foldForReserve(name: string): string {
  const decomposed = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  let out = "";
  for (const ch of decomposed) out += LOOKALIKES[ch] ?? ch;
  return out.replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a product display name may become the <App> of "<App> via Polaris Key", and the
 * canonical form it is used in (NFC, trimmed, inner whitespace runs collapsed to one space).
 * Refuses an empty name, one longer than `SENDER_APP_NAME_MAX` code points, any forbidden
 * character (before any whitespace is collapsed, so an embedded CR/LF is refused, never
 * flattened), and any reserved name.
 */
export function checkSenderAppName(raw: unknown): SenderNameCheck {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  if (FORBIDDEN.test(raw) || FORBIDDEN.test(raw.normalize("NFKC")))
    return { ok: false, reason: "forbidden_character" };
  const name = raw.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (name === "") return { ok: false, reason: "empty" };
  if ([...name].length > SENDER_APP_NAME_MAX)
    return { ok: false, reason: "too_long" };
  const folded = foldForReserve(name);
  if (
    FOLDED_WHOLE_NAMES.has(folded) ||
    FOLDED_FRAGMENTS.some((f) => folded.includes(f))
  )
    return { ok: false, reason: "reserved" };
  // Latin mixed with a script whose letters imitate Latin ones is a skeleton the fold table
  // cannot be trusted to cover (UTS #39 mixed-script restriction).
  if (CONFUSABLE_MIX_LATIN.test(name) && CONFUSABLE_MIX_OTHER.test(name))
    return { ok: false, reason: "forbidden_character" };
  return { ok: true, name };
}

/** A plain `local@domain` with no display part, whitespace or header specials. */
function bareAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v)
    ? v.toLowerCase()
    : null;
}

/**
 * The shared sender address: `EMAIL_SENDER_ADDRESS` when it is a bare address, else the address
 * part of the older `PORTAL_EMAIL_FROM` ("Name <addr>"), else `LEGACY_EMAIL_ADDRESS`. Only the
 * address is honoured from `PORTAL_EMAIL_FROM`: the display name is never configurable.
 */
export function senderAddress(env: Env): string {
  const explicit = bareAddress(env.EMAIL_SENDER_ADDRESS);
  if (explicit) return explicit;
  const legacy =
    typeof env.PORTAL_EMAIL_FROM === "string"
      ? (/<([^<>]+)>\s*$/.exec(env.PORTAL_EMAIL_FROM)?.[1] ??
        env.PORTAL_EMAIL_FROM)
      : null;
  return bareAddress(legacy) ?? LEGACY_EMAIL_ADDRESS;
}

/** The `From` of platform mail: "Polaris Key", never " via". */
export function platformSender(env: Env): EmailAddress {
  return { name: PLATFORM_SENDER_NAME, email: senderAddress(env) };
}

/**
 * The `From` of passthrough mail for a product: "<App> via Polaris Key" from its display name,
 * or, when that is refused, from its slug (slugs are `[a-z0-9-]`, so only the reserved check can
 * refuse one). Null when both are refused: such a product sends no passthrough mail, because
 * borrowing the platform's own name would let tenant mail pass as Polaris Key's.
 */
export function passthroughSender(
  env: Env,
  displayName: string | null | undefined,
  slug: string,
): EmailAddress | null {
  for (const candidate of [displayName, slug]) {
    const check = checkSenderAppName(candidate);
    if (check.ok)
      return {
        name: `${check.name}${PASSTHROUGH_SENDER_SUFFIX}`,
        email: senderAddress(env),
      };
  }
  return null;
}
