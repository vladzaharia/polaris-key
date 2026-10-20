/**
 * Sign-in sentences the kit copy catalog does not word yet, each under the key it will take
 * (SIGN-IN.md §3.11, §3.4). They are here, not in `packages/brand/kit-copy/en.json`, because a
 * catalog key is nine locales and every SDK's generated table; one batch adds these with
 * LK-08a's Locker words (P0-38 hand-off). `portalCopy.test.ts` fails a portal file that spells
 * out a sentence the catalog already holds, so a key that lands later moves here by deleting
 * its line.
 */
export const SIGNIN_COPY = {
  "signin.approve.lede":
    "On a phone or computer where you're signed in, scan the code, or open Account → Approve a new device and type it.",
  "signin.approve.other": "Use another way to sign in",
  "signin.approve.minuteLeft": "One minute left on this code.",
  "signin.approve.starting": "Getting your code",
  "signin.approve.disabled":
    "That account can't sign in. Use another way to sign in.",
  "signin.approve.open": "Approve a new device",
  "signin.approve.enter": "Enter the code shown on the other device.",
  "signin.approve.codeLabel": "Code",
  "signin.approve.look": "Find it",
  "signin.approve.askBody": "Code {code} asks to sign in to your account.",
  "signin.approve.device": "Device",
  "signin.approve.where": "Where",
  "signin.approve.when": "When",
  "signin.approve.unknownPlace": "Unknown place",
  "signin.approve.stepUpWhy":
    "It's asking from a different place than you're in now, or from a place we can't tell.",
  "signin.approve.stepUpVerb": "approve it",
  "signin.approve.approved": "Approved. {device} is signed in.",
  "signin.approve.deniedDone": "Denied. Nothing changed.",
  "signin.passkey.cancelled":
    "Your passkey wasn't used. Try again, or use another way.",
  "signin.passkey.unsupported":
    "This browser can't use your passkey here. Use another way.",
  "signin.passkey.failed":
    "Your passkey didn't work. Try again, or use another way.",
  "signin.approve.failed": "That didn't go through. Try again.",
  "signin.gate.stripNoIdentity": "Signed in with {provider}",
  "signin.gate.done": "Done",
  "signin.gate.termsTitle": "One more step",
  "signin.gate.name": "Your name",
  "signin.gate.useEmail": "Use {email}",
  "signin.gate.relay": "Your private Apple address",
  "signin.gate.emailChoice": "Email",
  "signin.gate.pictureInitials": "Use my initials",
  "signin.gate.pictureProvider": "Use my {provider} picture",
  "signin.gate.birthdate": "Add my birth date from {from}",
  "signin.gate.birthdateHelp": "Only you can see it. Apps never get it.",
  "signin.gate.productTerms": "I agree to the {product}",
  "signin.gate.platformTerms": "By continuing you agree to the Polaris Locker",
  "signin.gate.termsLink": "terms",
  "signin.gate.termsRequired": "Agree to the terms to continue.",
  "signin.gate.cancelled": "That sign-in was cancelled.",
  "signin.gate.expired": "That sign-in has expired. Sign in again.",
  "signin.gate.joinTitle": "Join your accounts",
  "signin.gate.joinLede":
    "{email} already belongs to a Polaris Locker account. Join this sign-in to it, or use a different email.",
  "signin.gate.joinProve":
    "To join, sign in to that account in this browser first, then add this sign-in from Account.",
  "signin.gate.emailUsed": "A Polaris Locker account already uses this email.",
  "signin.gate.codeSent": "We sent a code to {email}.",
} as const;

export type SigninCopyKey = keyof typeof SIGNIN_COPY;

export function sc(
  key: SigninCopyKey,
  args?: Record<string, string | number>,
): string {
  let out: string = SIGNIN_COPY[key];
  for (const [k, v] of Object.entries(args ?? {}))
    out = out.replaceAll(`{${k}}`, String(v));
  return out;
}
