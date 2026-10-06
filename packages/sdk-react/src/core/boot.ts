// One-call boot (SDK parity pass §3.4, feature `ui.boot`; drives `ui.stages`): the React side of
// client-core's boot stage machine, end to end, as `@polaris-key/node`'s `client.boot()` drives
// it (packages/sdk-node/src/boot.ts). The transport is a `BootDriver`, so the browser adapter
// (cookie or bearer), the transcript replayer and the stage-matrix test all run this one loop:
//
//   shell    discovery, when it has not answered yet; then, on a fresh install (no token) of a
//            product whose `core.registration` is `open`, the keyless registration, so the sync
//            that follows already carries the token (conformance/transcripts/
//            boot-cold-register.json)
//   guard    the app boot guard, where the transport has one (a page has none: `ok`)
//   sync     one sync pass: trust, the enabled documents, the report
//   gate     reacquire per discovery's `core.registration` (register, then enrol), then status
//   decide   the wire v4 update decision, when the host configured one
//   fetch    the required and essential packs (`packs.bootFetch`), when the host passed a facet
//   mount    done
//
// An activation prompt is never invented: a gate that needs a key, a sign-in or a renewal ends
// the boot `waiting` with the status, and the host renders its activation screen. Every
// transition reaches `onStage` with the machine's emits.

import {
  bootTransition,
  initialBootState,
  isUsable,
  type BootDecision,
  type BootEmit,
  type BootEvent,
  type BootFetchResult,
  type BootGuardResult,
  type BootOptions,
  type BootState,
  type BootSyncResult,
} from "@polaris-key/client-core";
import type { LicenseStatus } from "@polaris-key/protocol/license";
import type { UpdateCheck } from "@polaris-key/protocol/update";

/** One transition, as `onStage` receives it. A desktop boot runs in the host process, so the
 *  renderer receives one step at the end, with every emit and no `event`. */
export interface BootStep {
  state: BootState;
  emits: readonly BootEmit[];
  event?: BootEvent;
}

/** The pack facet a boot fetches through (`createBrowserPacks()`'s `bootOptions`/`bootFetch`). */
export interface BootPacks {
  bootOptions(): {
    requiredPacks: readonly string[];
    essentialPacks: readonly string[];
  };
  bootFetch(opts: {
    send: (event: BootEvent) => void;
    consent: "always" | "metered" | "never";
    metered: boolean;
    answer: (bytes: number, metered: boolean) => Promise<boolean>;
  }): Promise<unknown>;
}

export interface BootRunOptions {
  /** Every accepted transition, with its emits (`stage_changed` first). */
  onStage?: (step: BootStep) => void;
  /** When to ask before downloading required content: `always`, `metered` (default), `never`. */
  consent?: "always" | "metered" | "never";
  /** Whether the network is metered, as the host knows it. */
  metered?: boolean;
  /** The player's answer to `consent_needed`. Default: decline (nothing downloads unasked). Not
   *  carried across a desktop bridge: the host decides with its own default. */
  answer?: (bytes: number, metered: boolean) => Promise<boolean>;
  /** Pack ids that must be present before mount (added to the facet's). */
  requiredPacks?: readonly string[];
  /** The stage machine's `allowOffline` / `allowGrace` (both default true). */
  allowOffline?: boolean;
  allowGrace?: boolean;
  /** Reacquire policy: register and enrol when the gate needs activation (default true; each
   *  runs only where discovery and the product allow it). */
  registration?: boolean;
  /** The page's pack facet (`createBrowserPacks()`). Without one nothing downloads, so a
   *  required pack that is not present ends the boot `error`. Browser only. */
  packs?: BootPacks;
}

/** `adapter.boot()`'s answer. */
export interface BootResult {
  /** `ready`, `waiting` (the gate needs the player), `blocked`, `offline` or `error`. */
  outcome: BootState["outcome"];
  state: BootState;
  /** The gate's status at the end. */
  status: LicenseStatus;
  /** The update decision, when one was made. */
  decision: UpdateCheck | null;
  /** Every emit, in order. */
  emits: BootEmit[];
}

/** What a transport does for each stage. Every method may throw; the loop maps a throw to the
 *  machine's own failure event. */
export interface BootDriver {
  /** Load discovery when it has not answered. */
  discover(): Promise<void>;
  /** Whether this install holds a device credential (a fresh install holds none). */
  hasToken(): boolean;
  /** Discovery's `core.registration`, or null. */
  registrationPolicy(): string | null;
  /** Whether the product runs License (discovery, or the host's expectation). */
  licenseEnabled(): boolean;
  /** The keyless `devices/register`; true when a token arrived. Absent: not on this transport. */
  register?(): Promise<boolean>;
  /** `license/enroll` then a sync; true on success. Absent: not on this transport. */
  enroll?(): Promise<boolean>;
  /** The boot guard's answer. Absent: `ok`. */
  guard?(): Promise<BootGuardResult>;
  /** One sync pass (`force` after a reacquire). */
  sync(force?: boolean): Promise<BootSyncResult>;
  /** The gate's status now. */
  status(): LicenseStatus;
  /** The update decision. Absent: nothing to decide (`none`). */
  decide?(): Promise<{ decision: BootDecision; check: UpdateCheck | null }>;
}

/** `ensureActivated()`'s answer: the status, and which reacquire route got it there. */
export interface ReacquireResult {
  status: LicenseStatus;
  via: "already" | "register" | "enroll" | null;
}

/** Steps 3 of the boot: register on an `open` product, then enrol unless the product requires
 *  an identity, syncing after each. Never prompts. */
export async function reacquire(
  driver: BootDriver,
  allowed: boolean,
): Promise<ReacquireResult> {
  let status = driver.status();
  if (status !== "needs-activation" || !allowed)
    return { status, via: status === "needs-activation" ? null : "already" };
  const registration = driver.registrationPolicy();
  if (registration === "open" && driver.register) {
    const ok = await driver.register().catch(() => false);
    if (ok) {
      await driver.sync(true).catch(() => "offline");
      status = driver.status();
      if (status !== "needs-activation") return { status, via: "register" };
    }
  }
  if (
    driver.licenseEnabled() &&
    registration !== "requires-identity" &&
    driver.enroll
  ) {
    const ok = await driver.enroll().catch(() => false);
    if (ok) return { status: driver.status(), via: "enroll" };
  }
  return { status: driver.status(), via: null };
}

/** Drive the boot stage machine to a stop. See the file header. */
export async function runBoot(
  driver: BootDriver,
  opts: BootRunOptions = {},
): Promise<BootResult> {
  const packs = opts.packs ?? null;
  let stamp: {
    requiredPacks: readonly string[];
    essentialPacks: readonly string[];
  } = { requiredPacks: [], essentialPacks: [] };
  if (packs) {
    try {
      stamp = packs.bootOptions();
    } catch {
      // An invalid content stamp: boot on the host's own list.
    }
  }
  const bootOpts: BootOptions = {
    allowOffline: opts.allowOffline ?? true,
    allowGrace: opts.allowGrace ?? true,
    requiredPacks: [
      ...new Set([...stamp.requiredPacks, ...(opts.requiredPacks ?? [])]),
    ],
    essentialPacks: [...stamp.essentialPacks],
  };
  let state = initialBootState(bootOpts);
  const emits: BootEmit[] = [];
  const send = (event: BootEvent): void => {
    const t = bootTransition(state, event);
    if (t.state === state && t.emits.length === 0) return;
    state = t.state;
    emits.push(...t.emits);
    opts.onStage?.({ state, emits: t.emits, event });
  };
  // `send` reassigns `state`; reading through a function keeps TypeScript from narrowing it.
  const stage = (): BootState["stage"] => state.stage;
  let decision: UpdateCheck | null = null;
  const finish = (): BootResult => ({
    outcome: state.outcome,
    state,
    status: driver.status(),
    decision,
    emits,
  });

  send({ type: "start" });
  // shell
  try {
    await driver.discover();
    if (
      !driver.hasToken() &&
      opts.registration !== false &&
      driver.register &&
      driver.registrationPolicy() === "open"
    )
      await driver.register().catch(() => false);
    send({ type: "shell.done" });
  } catch (e) {
    send({ type: "fail", code: failCode(e, "shell-failed") });
    return finish();
  }

  // guard
  let guard: BootGuardResult = "ok";
  if (driver.guard) guard = await driver.guard().catch(() => "ok" as const);
  send({ type: "guard.done", result: guard });

  // sync
  let synced: BootSyncResult;
  try {
    synced = await driver.sync(false);
  } catch {
    synced = "offline";
  }
  send({ type: "sync.done", result: synced });
  if (stage() !== "gate") return finish();

  // gate
  const { status } = await reacquire(driver, opts.registration !== false);
  send({ type: "gate.status", status });
  if (stage() !== "decide") return finish();

  // decide
  let d: BootDecision = "none";
  if (driver.decide && isUsable(driver.status())) {
    try {
      const r = await driver.decide();
      d = r.decision;
      decision = r.check;
    } catch {
      d = "none";
    }
  }
  send({ type: "decide.done", decision: d });
  if (stage() !== "fetch") return finish();

  // fetch
  if (packs) {
    try {
      await packs.bootFetch({
        send,
        consent: opts.consent ?? "metered",
        metered: opts.metered ?? false,
        answer: opts.answer ?? (async () => false),
      });
    } catch (e) {
      send({ type: "fail", code: failCode(e, "fetch-failed") });
    }
  } else {
    const result: BootFetchResult = "ok";
    send({ type: "fetch.done", result, installed: [] });
  }
  if (stage() === "mount") send({ type: "mount.done" });
  return finish();
}

/** Map a decision onto the machine's: Node's rule (`none`, else `optional`). */
export function bootDecisionOf(check: UpdateCheck): BootDecision {
  return check.decision.action === "none" ? "none" : "optional";
}

function failCode(e: unknown, fallback: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : fallback;
}
