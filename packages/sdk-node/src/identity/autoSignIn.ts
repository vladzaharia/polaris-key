// `identity.autoSignIn()` (CC-01-auto-sign-in §1; I-47.2) and the state it needs.
//
// The ladder has six rungs; Node runs the first and the last two:
//
//   rung 1  a token a sign-in produced              -> `signedIn` (no network)
//   rung 2  silent restore                          -> I-49 (native clients only)
//   rung 3  the platform provider, silently         -> N/A here (no platform identity)
//   rung 4  the provider's one OS sheet             -> N/A here
//   rung 5  nearby approval                         -> `identity.signIn.start({channel: "nearby"})`
//                                                      (I-47.6); a kit starts it, this call does not
//   rung 6  the regular sign-in                     -> `needsSignIn`
//
// The result is the same six kinds in every SDK (I-46.2); Node answers `signedIn`,
// `needsSignIn` and `unavailable`. It never throws and never touches the network.
//
// Two facts are kept in the state directory, beside the credential, because the token store has
// no room for them:
//  - `signin`: the held token was produced by a sign-in. A key activation, an enrolment or a
//    registration is a device, not a sign-in, and a device that an account sign-out left activated
//    is not one either. A restart keeps the mark; a token this process never saw a sign-in
//    produce is not marked.
//  - `signedOut`: the person signed out on purpose. Set once the Worker accepted the sign-out,
//    cleared by the next sign-in, and it fails closed: a file that exists but does not read counts
//    as set. While it is set nothing signs the device in by itself (rung 5 starts only from the
//    form, never from the ladder).

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "../core/jsonFile.js";
import { Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import type { TokenMarks } from "../core/token.js";
import {
  identityFragmentFrom,
  type ProductDiscoveryDocument,
} from "../discovery.js";
import { readStoredSubject } from "./account.js";

/** What `autoSignIn()` takes. Node has no provider to prompt, so the options only exist so a
 *  call written for another SDK compiles; none changes what Node does. */
export interface AutoSignInOptions {
  prompt?: "none" | "optional";
  licenseChoice?: "app" | "card";
  deviceName?: string;
}

/** Why the ladder ended at the regular sign-in. */
export type AutoSignInReason = "signed_out" | "no_credential";

/** Why the ladder cannot run at all. Node has one cause: this product serves no Identity. */
export type AutoSignInUnavailable = "product";

/** How the ladder ended (the six I-46.2 kinds; Node answers these three). */
export type AutoSignInResult =
  | {
      kind: "signedIn";
      /** Rung 1: this device already held a token from a sign-in. */
      via: "stored";
      /** The pairwise account subject (`ps_…`) last stored here, or null. */
      subject: string | null;
      activation: { licenseId: string | null };
    }
  | { kind: "needsSignIn"; reason: AutoSignInReason }
  | { kind: "unavailable"; code: AutoSignInUnavailable };

interface Marks {
  signin: boolean;
  signedOut: boolean;
}

/** The two facts above, in `sign-in.json` (0600, atomic writes). Never throws. */
export class SignInState implements TokenMarks {
  readonly #file: string;
  /** Writes happen in order, so a late `stored(false)` cannot overtake a `stored(true)`. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = join(stateDir, "sign-in.json");
  }

  async #read(): Promise<Marks> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (e) {
      // No file: a device that never signed out. Any other failure fails closed.
      return (e as NodeJS.ErrnoException).code === "ENOENT"
        ? { signin: false, signedOut: false }
        : { signin: false, signedOut: true };
    }
    try {
      const v: unknown = JSON.parse(text);
      if (v === null || typeof v !== "object" || Array.isArray(v))
        throw new Error("shape");
      const o = v as Record<string, unknown>;
      return { signin: o.signin === true, signedOut: o.signedOut === true };
    } catch {
      return { signin: false, signedOut: true };
    }
  }

  async #write(m: Marks): Promise<void> {
    if (!m.signin && !m.signedOut)
      await rm(this.#file, { force: true }).catch(() => undefined);
    else
      await writeJson(this.#file, {
        ...(m.signin ? { signin: true } : {}),
        ...(m.signedOut ? { signedOut: true } : {}),
      }).catch(() => undefined);
  }

  #update(fn: (m: Marks) => Marks): Promise<void> {
    const run = this.#queue.then(async () =>
      this.#write(fn(await this.#read())),
    );
    this.#queue = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  /** @inheritdoc */
  async loaded(): Promise<boolean> {
    await this.#queue;
    return (await this.#read()).signin;
  }

  /** A sign-in stores its token (and so ends a sign-out); any other token or none is not one. */
  stored(signin: boolean): Promise<void> {
    return this.#update((m) => ({
      signin,
      signedOut: signin ? false : m.signedOut,
    }));
  }

  /** The person signed out on purpose (the Worker accepted it): set the flag, drop the mark. */
  signedOut(): Promise<void> {
    return this.#update(() => ({ signin: false, signedOut: true }));
  }

  /** True while the flag is set. Unreadable counts as set. */
  async explicitSignOut(): Promise<boolean> {
    await this.#queue;
    return (await this.#read()).signedOut;
  }
}

export interface AutoSignInDeps {
  ctx: CoreContext;
  /** A token from a sign-in is held. */
  signedIn: () => boolean;
  state: SignInState;
  licenseId: () => string | null;
}

/** Run the ladder (see the file header). */
export async function runAutoSignIn(
  deps: AutoSignInDeps,
): Promise<AutoSignInResult> {
  try {
    deps.ctx.requireService("identity", Feature.identityAutosignin);
  } catch {
    return { kind: "unavailable", code: "product" };
  }
  if (deps.signedIn()) {
    const subject = await readStoredSubject(deps.ctx.dirs.state).catch(
      () => null,
    );
    return {
      kind: "signedIn",
      via: "stored",
      subject,
      activation: { licenseId: deps.licenseId() },
    };
  }
  return {
    kind: "needsSignIn",
    reason: (await deps.state.explicitSignOut())
      ? "signed_out"
      : "no_credential",
  };
}

/** The sides of nearby approval `available()` asks about. */
export type NearbyRole = "requester" | "approver";

/** Discovery's endpoints each side needs (§12.11.5). */
const ENDPOINTS: Record<NearbyRole, readonly string[]> = {
  requester: ["nearbyStart", "nearbyPoll"],
  approver: ["nearbyApprove"],
};

/** Whether this runtime can browse and advertise on the LAN: the optional `multicast-dns`
 *  dependency loads. The answer is kept; a host may inject its own for a test. */
let runtimeProbe: Promise<boolean> | null = null;
export function lanRuntimeSupported(): Promise<boolean> {
  return (runtimeProbe ??= import("multicast-dns" as string).then(
    () => true,
    () => false,
  ));
}

export interface NearbyAvailableDeps {
  ctx: CoreContext;
  discovery: () => Promise<ProductDiscoveryDocument | null>;
  /** Defaults to {@link lanRuntimeSupported}. */
  runtime?: () => Promise<boolean>;
}

/**
 * `identity.nearby.available({role})`: Identity is on, discovery names `nearby` and the role's
 * endpoints, and this runtime can do mDNS (CC-15 does not answer `nearby-unsupported`). It sends
 * nothing but the discovery read, and never throws: any doubt is false.
 */
export async function nearbyAvailable(
  deps: NearbyAvailableDeps,
  o: { role: NearbyRole },
): Promise<boolean> {
  try {
    const names = ENDPOINTS[o.role];
    if (names === undefined) return false;
    deps.ctx.requireService("identity", Feature.identityNearby);
    const f = identityFragmentFrom(await deps.discovery());
    if (f === null || f.nearby !== true) return false;
    const ep = f.endpoints as unknown as Record<string, string | undefined>;
    if (!names.every((k) => typeof ep[k] === "string" && ep[k] !== ""))
      return false;
    return await (deps.runtime ?? lanRuntimeSupported)();
  } catch {
    return false;
  }
}
