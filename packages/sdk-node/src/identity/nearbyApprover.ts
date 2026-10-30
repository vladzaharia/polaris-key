// `identity.nearby.onRequest(handler, opts)` (I-47.7; WIRE-CONTRACT-V5 §12.11.5, §15.6.1): the
// approving device M. CC-15 carries the LAN half (the advert, three codes, number matching, the
// verified `VOUCH_REQ`); this module is the Identity half on top of it: what the person is asked,
// the `nearby/approve` call, the licence choice and the answer given back to the LAN session.
//
//   const approver = await client.identity.nearby.onRequest(
//     (ask) => {
//       show(ask.device, ask.platform, ask.codes);       // three codes, the person taps one
//       const step = await ask.pick(tapped);             // or `await ask.deny()` for none of them
//       // step.kind: approved | mismatch | not-nearby | denied | expired | device-limit | choose
//       //            | account-required | rate-limited
//     },
//     { prompt: true, label: "Ana's laptop" },
//   );
//
// The steps are the ui-matrix `NearbyApproval` states one to one. A `choose` step carries the
// licences and two ways on: `choose(c)` (`{kind: "license", licenseId}` or `{kind: "create"}`) and
// `cancel()`, which denies on the Worker.
//
// Rules this module keeps (SR-47):
//  - no silent approval: `nearby/approve` is reached only from a `pick()` that matched on that
//    session and whose `VOUCH_REQ` verified (CC-15 checks both and refuses `finish()` otherwise),
//    and it carries exactly that request's `request`, `deviceId`, `signKey` and `agreeKey`;
//  - `decision: "deny"` goes out only after a matched code (the licence choice cancelled). "None of
//    these match" (`ask.deny()`) and a wrong pick close the session and call no route;
//  - one pick per session: asking twice gives the first answer, never a second approve;
//  - the answer is given to the LAN session (`finish`), which sends the one `VOUCH_RESULT`;
//    M's 409 keys registration retries once inside the route client and never loops here, and a
//    licence choice is asked at most as often as the Worker asks;
//  - the approver stops on sign-out and with `stop()`: nothing is left listening (CC-15, G18);
//  - the wrap (V5 §13.11.3): once the Worker answered `approved`, and only if this device holds
//    the root, M wraps it to the new device's `agreeKey` from the verified `VOUCH_REQ` (and to no
//    other key), stores that wrap (`PUT .../wraps/{deviceId}`: the server copy is the fallback) and
//    sends the same wrap once as `KEYRING_WRAP`. A failure of either leaves the approval as it
//    is: the new device is signed in, and unlocks with the normal route.

import { PolarisError } from "@polaris-key/client-core";
import { cleanLabel } from "@polaris-key/client-core/peer";
import type { NearbyChoiceInput } from "@polaris-key/protocol/identity";
import { ErrorCode } from "../constants.generated.js";
import type {
  NearbyApproval,
  NearbyApproverHandle,
  NearbyApproverOptions,
} from "../connect/nearbyApprover.js";
import { LanError } from "../connect/session.js";
import type { LicenseChoiceView } from "./choice.js";
import {
  grantApproval,
  type NearbyApproveAnswer,
  type NearbyRoutes,
  type VerifiedVouch,
} from "./nearby.js";

/** What happens after the person taps a code, or a choice. */
export type NearbyApprovalStep =
  | { kind: "approved" }
  /** The tapped code was not the one the new device shows: it was not signed in. */
  | { kind: "mismatch" }
  | { kind: "not-nearby" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "device-limit" }
  | { kind: "account-required" }
  | { kind: "rate-limited" }
  | {
      kind: "choose";
      /** The licences the person may give the new device. */
      choices: LicenseChoiceView;
      /** Give it this one (`{kind: "license", licenseId}`) or a new one (`{kind: "create"}`). */
      choose(c: NearbyChoiceInput): Promise<NearbyApprovalStep>;
      /** Decline: the Worker records a denial and the new device is told. */
      cancel(): Promise<NearbyApprovalStep>;
    };

/** One session asking for approval, as the host's handler sees it. */
export interface NearbyAsk {
  /** The new device's name, as it reports it (unverified: show it as reported by the device). */
  readonly device: string | null;
  readonly platform: string;
  /** The three codes in the order to show, each like `123 456`. */
  readonly codes: readonly [string, string, string];
  /** The person tapped this code. */
  pick(code: string): Promise<NearbyApprovalStep>;
  /** "None of these match": the session closes, nothing is approved and no route is called. */
  deny(): Promise<void>;
}

/** The LAN half, as the approver reads it (`cloudConnect.nearby`). */
export interface NearbyApproverLan {
  onRequest(
    handler: (a: NearbyApproval) => void,
    o: NearbyApproverOptions,
  ): Promise<NearbyApproverHandle>;
}

/** The key ring, as the approver uses it: it holds the root or it does not. */
export interface NearbyApproverKeyring {
  readonly unlocked: boolean;
  wrapTo(deviceId: string, agreeKey: string): Promise<object>;
}

export interface NearbyApproverDeps {
  routes: NearbyRoutes;
  lan: () => NearbyApproverLan;
  /** Absent, or locked: no wrap is sent, and the new device unlocks by another route. */
  keyring?: NearbyApproverKeyring;
}

/** `KEYRING_WRAP`, the Sync record that carries a wrap of the root over the nearby channel. */
const KEYRING_WRAP = 0x0030;

/** A licence choice is asked again (a lost mint) at most this often in one pick. */
const MAX_ASKS = 3;

/** The step a Worker answer is, once `finish()` has sent what it sends. */
function stepOf(a: NearbyApproveAnswer): NearbyApprovalStep {
  switch (a.kind) {
    case "approved":
      return { kind: "approved" };
    case "denied":
      return { kind: "denied" };
    case "unavailable":
    case "choose":
      return { kind: "expired" };
    case "refused":
      switch (a.code) {
        case ErrorCode.notNearby:
          return { kind: "not-nearby" };
        case ErrorCode.deviceLimit:
          return { kind: "device-limit" };
        case ErrorCode.accountRequired:
        case ErrorCode.unauthorized:
          return { kind: "account-required" };
        case ErrorCode.rateLimited:
          return { kind: "rate-limited" };
        default:
          return { kind: "expired" };
      }
  }
}

class Decision {
  #wrapped = false;

  constructor(
    private readonly routes: NearbyRoutes,
    private readonly a: NearbyApproval,
    private readonly r: VerifiedVouch,
    private readonly keyring: NearbyApproverKeyring | undefined,
  ) {}

  /** Once, after `approved`: store the wrap for the new device and send it over the channel. */
  async #wrap(): Promise<void> {
    const ring = this.keyring;
    if (this.#wrapped || ring === undefined || !ring.unlocked) return;
    this.#wrapped = true;
    try {
      // The ids and the key are the verified request's, which `approve` just confirmed.
      const body = await ring.wrapTo(this.r.deviceId, this.r.agreeKey);
      await this.a
        .sendRecord(
          KEYRING_WRAP,
          new TextEncoder().encode(JSON.stringify(body)),
        )
        .catch(() => undefined);
    } catch {
      // No wrap (a conflict, a locked ring, the network): the approval stands.
    }
  }

  /** One `nearby/approve` for the verified request, then the answer to the LAN session. */
  async run(
    decision: "approve" | "deny",
    choice?: NearbyChoiceInput,
    asks = 1,
  ): Promise<NearbyApprovalStep> {
    const { r, a } = this;
    let answer: NearbyApproveAnswer;
    try {
      answer = await this.routes.approve(r, {
        decision,
        ...(choice !== undefined ? { choice } : {}),
      });
    } catch (e) {
      // Nothing to answer with: the session closes and the person is told what it was.
      await a.close().catch(() => undefined);
      if (e instanceof PolarisError && e.code === ErrorCode.accountRequired)
        return { kind: "account-required" };
      if (e instanceof PolarisError) return { kind: "expired" };
      throw e;
    }
    let out: Awaited<ReturnType<NearbyApproval["finish"]>>;
    try {
      out = await a.finish(answer.finish);
    } catch (e) {
      // The LAN session ended meanwhile. The Worker's answer stands: an approval is an approval,
      // and the new device's own poll signs it in.
      if (e instanceof LanError) {
        // The Worker's `approved` stands; the stored wrap is the fallback for the lost channel.
        if (answer.kind === "approved") await this.#wrap();
        return stepOf(answer);
      }
      throw e;
    }
    if ("wait" in out) {
      if (out.wait === "choice" && asks < MAX_ASKS) {
        if (answer.kind === "choose")
          return this.choose(answer.choices as LicenseChoiceView, asks);
        // A lost mint (409): ask again for the licences, with no choice, to show them afresh.
        if (decision === "approve")
          return this.run("approve", undefined, asks + 1);
      }
      // A choice nobody can show, or a retry the route client already spent: end it.
      await a.close().catch(() => undefined);
      return { kind: "expired" };
    }
    if (answer.kind === "approved") await this.#wrap();
    return stepOf(answer);
  }

  private choose(choices: LicenseChoiceView, asks: number): NearbyApprovalStep {
    let used = false;
    const once = <T>(f: () => Promise<T>): Promise<T> => {
      if (used)
        return Promise.reject(
          new PolarisError(
            ErrorCode.invalidOptions,
            "This choice was already answered.",
          ),
        );
      used = true;
      return f();
    };
    return {
      kind: "choose",
      choices,
      choose: (c) => once(() => this.run("approve", c, asks + 1)),
      // The right code was tapped on this session, so the Worker may be told "deny".
      cancel: () => once(() => this.run("deny", undefined, asks + 1)),
    };
  }
}

function askOf(
  routes: NearbyRoutes,
  a: NearbyApproval,
  keyring: NearbyApproverKeyring | undefined,
): NearbyAsk {
  const codes = a.codes as unknown as [string, string, string];
  let picked: Promise<NearbyApprovalStep> | null = null;
  let declined = false;
  return {
    device: a.label === null ? null : cleanLabel(a.label),
    platform: a.platform,
    codes,
    pick: (code) =>
      (picked ??= (async () => {
        if (declined)
          throw new PolarisError(ErrorCode.invalidOptions, "Already denied.");
        const r = await a.pick(code);
        if (r === "mismatch") return { kind: "mismatch" } as const;
        // The request did not verify: nothing was approved, and the session is closed.
        if (r === "invalid") return { kind: "expired" } as const;
        // The matched code and the verified request earn the permit; nothing else does.
        return new Decision(routes, a, grantApproval(r), keyring).run(
          "approve",
        );
      })()),
    deny: async () => {
      if (picked !== null || declined) return;
      declined = true;
      await a.decline();
    },
  };
}

/**
 * Advertise this device as an approver while the host's "Approve a nearby device" screen is open
 * (`prompt: true`) or background approval is allowed (`prompt: false` with `background: true`),
 * and hand each session that reaches the code to `handler`. Returns CC-15's handle (`stop`,
 * `pause`, `resume`, `setPrompt`, `reopen`, `status`). Throws `account_required` when the device
 * is signed out and the typed N/A when the product serves no nearby approval.
 */
export function onNearbyRequest(
  deps: NearbyApproverDeps,
  handler: (ask: NearbyAsk) => void,
  o: NearbyApproverOptions,
): Promise<NearbyApproverHandle> {
  return deps
    .lan()
    .onRequest((a) => handler(askOf(deps.routes, a, deps.keyring)), o);
}
