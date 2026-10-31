// What the desktop adapter hands `bridge.beginSignIn`, and the renderer-side check of it. Loaded
// on demand by `DesktopAdapter.startSignIn` (SIZE-5): a sign-in is rare and the adapter ships in
// every provider.
import type { SignInOptions } from "../core/signIn.js";
import type { BridgeSignInBegin } from "./bridge.js";

/** The renderer-side check of `beginSignIn`'s hints (UK-42.17), mirroring the host's: a message,
 *  or null when they are fine. A wrong hint is an error, never a quiet drop. */
function badHint(o: SignInOptions): string | null {
  const text = (v: unknown, max: number): boolean =>
    v === undefined ||
    (typeof v === "string" &&
      v.length <= max &&
      !/[\u0000-\u001f\u007f]/.test(v));
  if (!text(o.loginHint, 254)) return "loginHint is too long or not text.";
  if (!text(o.nameHint, 200)) return "nameHint is too long or not text.";
  if (o.purpose !== undefined && (o.purpose as string) !== "attach")
    return 'purpose must be "attach" on the desktop bridge.';
  if (
    o.licenseChoice !== undefined &&
    (o.licenseChoice as string) !== "app" &&
    (o.licenseChoice as string) !== "card"
  )
    return 'licenseChoice must be "app" or "card".';
  return null;
}

/** The bag for `beginSignIn` (undefined when empty), or the message of a wrong hint. */
export function signInBag(
  opts: SignInOptions,
): BridgeSignInBegin | undefined | string {
  const bad = badHint(opts);
  if (bad) return bad;
  const bag: BridgeSignInBegin = {
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
    ...(opts.loginHint ? { loginHint: opts.loginHint } : {}),
    ...(opts.nameHint ? { nameHint: opts.nameHint } : {}),
    ...(opts.purpose === "attach" ? { purpose: "attach" as const } : {}),
    ...(opts.licenseChoice === "app" ? { licenseChoice: "app" as const } : {}),
  };
  return Object.keys(bag).length > 0 ? bag : undefined;
}
