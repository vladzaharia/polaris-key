// The gate's holder flows (UK-42), loaded on demand: a page that never reaches the Done step after a
// license key does not fetch this file, so the gate's entry stays as small as before. It mirrors
// ui-core's `GateDriver` (driver.ts), action for action:
//   - the sign-in a device-code session runs as, in this page's memory (`handleOf`);
//   - AddToAccount's flow: its model over the SDK's primitives, and one drop that cancels both the
//     model and the sign-in (nothing attaches after Cancel);
//   - "Sign in to that account" on a license-owned refusal: complete with the key just entered;
//   - the portal hand-off while Identity is off.
// The key is held by the caller in memory only: it is never persisted, logged, put in a snapshot,
// a view's input or a URL query. It leaves in one place, `openPortal`, as a `#key=` fragment.

import { parsePortal, portalLink } from "@polaris-key/client-core/portal";
import { CUSTOMER_ORIGIN_DEFAULT, ISSUER } from "@polaris-key/protocol/core";
import {
  AddToAccountModel,
  driverOf,
  type ChoiceComplete,
  type SignInPrimitives,
  type SignInSessionHandle,
} from "@polaris-key/ui-core";
import { handleOf } from "@polaris-key/ui-core/browser";
import { primitivesOf } from "@polaris-key/ui-core/browser/sdk/autoPrimitives.js";

import type { DeviceCodeSignInSession, PolarisAdapter } from "../core/index.js";

/** The sign-in currently running in this page, if any (one at a time). */
export interface SessionSlot {
  current: SignInSessionHandle | null;
}

/** The SDK's calls as the form's primitives, with `start` running in this page. */
function primitives(
  adapter: PolarisAdapter,
  slot: SessionSlot,
): SignInPrimitives {
  return {
    ...primitivesOf(
      adapter,
      () => undefined,
      () => false,
    ),
    start: async (o) => {
      const { hints, licenseChoice } = o;
      const flow = await adapter.signIn.start({
        channel: "device-code",
        ...(licenseChoice === "app" && { licenseChoice }),
        ...(hints?.loginHint && { loginHint: hints.loginHint }),
        ...(hints?.nameHint && { nameHint: hints.nameHint }),
        ...(hints?.purpose && { purpose: hints.purpose }),
      });
      void flow.reopen();
      const h = handleOf(flow);
      slot.current = h;
      return h;
    },
  };
}

/** `start` of a sign-in that runs in this page (a device-code session with the hints). The
 *  in-app form uses it for AddToAccount, whose sign-in must not leave the form. */
export function startInPage(
  adapter: PolarisAdapter,
  slot: SessionSlot,
  o: Parameters<SignInPrimitives["start"]>[0],
): Promise<SignInSessionHandle> {
  return primitives(adapter, slot).start(o);
}

/** AddToAccount's flow: the model, and one `drop()` that ends it. */
export interface AddFlow {
  model: AddToAccountModel;
  /** Leave AddToAccount: the model and its sign-in are cancelled, so approving it later attaches
   *  nothing. */
  drop(): void;
}

export function createAddFlow(
  adapter: PolarisAdapter,
  slot: SessionSlot,
  deviceKind: string,
  onChange: () => void,
): AddFlow {
  const model = new AddToAccountModel({
    driver: driverOf(primitives(adapter, slot)),
    deviceKind,
  });
  const unsub = model.store.subscribe(onChange);
  return {
    model,
    drop() {
      unsub();
      const h = slot.current;
      slot.current = null;
      void model.cancel().catch(() => {});
      if (h) void Promise.resolve(h.cancel()).catch(() => {});
    },
  };
}

/** "Sign in to that account" on a license-owned refusal: sign in in this page and complete the
 *  sign-in's license choice with the key that was entered (D17): the license joins the account and
 *  no list is shown. Resolves `"fallback"` when this page cannot run the sign-in itself (the gate's
 *  own sign-in then runs). Whatever ends it, the sign-in is let go. */
export async function ownedSignIn(
  adapter: PolarisAdapter,
  slot: SessionSlot,
  key: string,
): Promise<"fallback" | "signedIn" | "ended"> {
  let p: SignInPrimitives;
  let h: SignInSessionHandle;
  try {
    p = primitives(adapter, slot);
    h = await p.start({ channel: "browser", licenseChoice: "app" });
  } catch {
    return "fallback";
  }
  try {
    return await settle(h, p, key);
  } catch {
    return "ended";
  } finally {
    if (slot.current === h) slot.current = null;
    void Promise.resolve(h.cancel()).catch(() => {});
  }
}

/** Wait the sign-in out; a license choice is completed with the key and never listed. Anything but
 *  signed in leaves the refusal on screen, and the person can try again. */
async function settle(
  h: SignInSessionHandle,
  p: SignInPrimitives,
  key: string,
): Promise<"signedIn" | "ended"> {
  let r = await h.wait();
  while (r.outcome === "pending") r = await h.wait();
  if (r.outcome !== "choose" || !key || !p.choice) return "ended";
  const c: ChoiceComplete = await p.choice.complete(r.grant, {
    kind: "key",
    key,
  });
  return c.outcome === "signedIn" ? "signedIn" : "ended";
}

/** Where Add your name and email goes while Identity is off: the product's page, and whether the
 *  held key may go with it. The caller opens it (`openManage`) with the key as the `#key=`
 *  fragment, the one place the key leaves memory; a fragment never reaches a server or a log.
 *  The link comes from unsigned discovery: the key goes only to the configured API origin or the
 *  default customer origin; any other origin opens without it. */
export async function portalTarget(
  adapter: PolarisAdapter,
  o: { baseUrl?: string; product?: string },
): Promise<{ url: string; withKey: boolean } | null> {
  let core: unknown;
  try {
    core = (await adapter.discovery())?.core;
  } catch {
    core = undefined;
  }
  const base = o.baseUrl ?? `https://${ISSUER}`;
  const url = portalLink({
    portal: parsePortal(core),
    baseUrl: base,
    product: o.product ?? "",
  });
  if (!url) return null;
  let withKey = false;
  try {
    const origin = new URL(url).origin;
    withKey =
      origin === new URL(base).origin || origin === CUSTOMER_ORIGIN_DEFAULT;
  } catch {
    withKey = false;
  }
  return { url, withKey };
}
