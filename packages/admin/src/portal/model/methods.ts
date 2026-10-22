import { t } from "../../lib/copy.js";
import { passkeyName as sharedPasskeyName } from "../../lib/methodNames.js";
/**
 * Account → Sign-in methods and Where you're signed in (PX-13; PORTAL.md §4.26): the words the
 * page builds from `GET /api/me/methods` and `GET /api/sessions`. Pure.
 */
import type {
  PortalMethod,
  PortalMethods,
  PortalPasskey,
  PortalProvider,
} from "../api.js";

export { PASSKEY_PROVIDERS, passkeyProvider } from "../../lib/methodNames.js";

/** A passkey's name (PORTAL.md §4.26), with the Locker's own default. */
export function passkeyName(
  p: Pick<PortalPasskey, "aaguid" | "addedFrom" | "name">,
): string {
  return sharedPasskeyName(p, t("locker.methods.passkeyDefault"));
}

/** The account's providers by name, in the provider row's order. */
export const PROVIDER_NAME: Record<PortalProvider, string> = {
  apple: "Apple",
  google: "Google",
  steam: "Steam",
};

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return t("locker.list.and", {
    first: parts.slice(0, -1).join(", "),
    rest: parts[parts.length - 1]!,
  });
}

/**
 * What stays after removing `id` ("Google, 2 emails and 2 passkeys"), or null when nothing would
 * (the Worker refuses that removal anyway).
 */
export function remainingAfter(
  methods: readonly PortalMethod[],
  id: string,
): string | null {
  const left = methods.filter((m) => m.id !== id);
  if (left.length === 0) return null;
  const accounts = [
    ...new Set(left.filter((m) => m.group === "accounts").map((m) => m.label)),
  ];
  const emails = left.filter((m) => m.group === "email").length;
  const passkeys = left.filter((m) => m.group === "passkeys").length;
  return list([
    ...accounts,
    ...(emails ? [t("locker.methods.emailsCount", { count: emails })] : []),
    ...(passkeys
      ? [t("locker.methods.passkeysCount", { count: passkeys })]
      : []),
  ]);
}

/** How a session signed in, in words (`GET /api/sessions` `methods`): unknown kinds are left out. */
const SESSION_METHOD: Record<string, string> = {
  passkey: t("signin.hint.method.passkey"),
  email: t("signin.hint.method.email"),
  google: "Google",
  apple: "Apple",
  steam: "Steam",
  device: t("locker.methods.anotherDevice"),
  oidc: t("signin.sso.name"),
};

export function sessionMethodText(methods: readonly string[]): string | null {
  const named = [
    ...new Set(
      methods
        .map((m) => SESSION_METHOD[m])
        .filter((m): m is string => Boolean(m)),
    ),
  ];
  return named.length
    ? t("signin.gate.stripNoIdentity", { provider: list(named) })
    : null;
}

/**
 * Whether a change can go ahead without confirming it's you first: the Worker says the session's
 * sign-in is fresh and it stays so for a little longer than a click takes. The Worker checks again
 * as the change lands; a `step_up_required` then asks after all.
 */
export function stepUpFresh(
  stepUp: PortalMethods["stepUp"] | undefined,
  nowSeconds: number,
): boolean {
  if (!stepUp) return false;
  return stepUp.fresh && stepUp.freshUntil - nowSeconds > 15;
}

/** The provider kinds the person can sign in again with to confirm it's them. */
export function stepUpProviders(view: PortalMethods): PortalProvider[] {
  return view.providers
    .filter((p) => p.connected && p.available)
    .map((p) => p.kind);
}

/** An account method's row label: the connected identity ("Sam's Apple Account · Hide My Email"). */
export function methodIdentity(m: PortalMethod): string | null {
  const shown = m.display?.trim() || null;
  if (m.relay) {
    const relay = t("locker.methods.hideMyEmail");
    return shown ? `${shown} · ${relay}` : relay;
  }
  return shown;
}
