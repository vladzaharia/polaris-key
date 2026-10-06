// One-call boot (SDK parity pass §3.4, proposed id `ui.boot`; drives `ui.stages`): the host side of
// client-core's boot stage machine, end to end.
//
//   shell    discovery, when the host pinned no `expectedServices` or holds no token; then, on a
//            fresh install (no token) of a product whose `core.registration` is `open`, the
//            keyless registration, so the sync pass that follows already carries the token
//            (conformance/transcripts/boot-cold-register.json)
//   guard    the app boot guard (`update.markBootAttempt`, §3.15)
//   sync     `client.sync()`
//   gate     reacquire per discovery's `core.registration` (`ensureActivated`), then the status
//   decide   `update.decide()` when release keys are pinned
//   fetch    the content stamp's required/essential packs (`packs.bootFetch`)
//   mount    done; the launch confirms per `bootConfirmation`
//
// An activation prompt is never invented: a gate that needs a key, a sign-in or a renewal ends the
// boot `waiting` with the status, and the host renders its activation screen. Every transition is
// reported through `onStage` with the machine's emits, so a terminal or an Electron renderer shows
// the same progress Godot's PKeyBoot does.

import {
  BOOT_OK_SECONDS,
  bootConfirmation,
  bootTransition,
  initialBootState,
  isUsable,
  type BootDecision,
  type BootEmit,
  type BootEvent,
  type BootOptions,
  type BootState,
  type BootSyncResult,
  type LicenseState,
} from "@polaris-key/client-core";
import type { UpdateCheck } from "@polaris-key/protocol/update";
import type { PolarisKeyClient } from "./client.js";
import type { BootAttempt } from "./update/bootguard.js";

/** One transition, as `onStage` receives it. */
export interface BootStep {
  state: BootState;
  emits: readonly BootEmit[];
  event: BootEvent;
}

export interface ClientBootOptions {
  /** Every accepted transition, with its emits (`stage_changed` first). */
  onStage?: (step: BootStep) => void;
  /** When to ask before downloading required content: `always`, `metered` (default), `never`. */
  consent?: "always" | "metered" | "never";
  /** Whether the network is metered, as the host knows it. */
  metered?: boolean;
  /** The player's answer to `consent_needed`. Default: decline (nothing downloads unasked). */
  answer?: (bytes: number, metered: boolean) => Promise<boolean>;
  /** Pack ids that must be present before mount (added to the content stamp's). */
  requiredPacks?: readonly string[];
  /** The stage machine's `allowOffline` / `allowGrace` (both default true). */
  allowOffline?: boolean;
  allowGrace?: boolean;
  /** Reacquire policy: try `devices/register` and `license/enroll` when the gate needs
   *  activation (default true; each runs only where discovery and the product allow it). */
  registration?: boolean;
  /** Confirm a `ready` launch after BOOT_OK_SECONDS (default true). */
  autoConfirm?: boolean;
}

/** `client.boot()`'s answer. */
export interface BootOutcome {
  /** `ready`, `waiting` (the gate needs the player), `blocked`, `offline` or `error`. */
  outcome: BootState["outcome"];
  state: BootState;
  /** The gate's status at the end. */
  license: LicenseState;
  /** The update decision, when one was made. */
  decision: UpdateCheck | null;
  /** The boot guard's launch decision. */
  guard: BootAttempt | null;
  /** Every emit, in order. */
  emits: BootEmit[];
}

/** `ensureActivated()`'s answer: the status, and which reacquire route got it there. */
export interface EnsureActivatedResult {
  license: LicenseState;
  via: "already" | "register" | "enroll" | null;
}

/**
 * Steps 1–3 of the boot: discovery (when no services are pinned), sync, then reacquire per
 * `core.registration` — `devices/register` on an `open` product, then `license/enroll` when the
 * product offers a free tier — and sync again. Never prompts: a device that still needs a key or
 * a sign-in comes back `needs-activation`.
 */
export async function ensureActivated(
  client: PolarisKeyClient,
  opts: { discover?: boolean; registration?: boolean } = {},
): Promise<EnsureActivatedResult> {
  if (opts.discover) await client.discover().catch(() => null);
  await client.sync().catch(() => null);
  return reacquire(client, opts.registration !== false);
}

async function reacquire(
  client: PolarisKeyClient,
  allowed: boolean,
): Promise<EnsureActivatedResult> {
  let license = client.status();
  if (license.status !== "needs-activation" || !allowed)
    return {
      license,
      via: license.status === "needs-activation" ? null : "already",
    };
  const registration = client.discovery()?.core?.registration;
  if (registration === "open") {
    const r = await client.devices.register().catch(() => null);
    if (r?.kind === "ok") {
      await client.sync({ force: true }).catch(() => null);
      license = client.status();
      if (license.status !== "needs-activation")
        return { license, via: "register" };
    }
  }
  if (client.core.enabled("license") && registration !== "requires-identity") {
    const r = await client.license.enroll().catch(() => null);
    if (r?.kind === "ok") return { license: client.status(), via: "enroll" };
  }
  return { license: client.status(), via: null };
}

function syncResult(
  r: Awaited<ReturnType<PolarisKeyClient["sync"]>>,
): BootSyncResult {
  const outcomes = Object.values(r.documents).filter(
    (d) => d && d.kind !== "skipped",
  );
  if (outcomes.length > 0 && outcomes.every((d) => d!.kind === "error"))
    return "offline";
  return "ok";
}

/** Drive the boot stage machine to a stop. See the file header. */
export async function runBoot(
  client: PolarisKeyClient,
  opts: ClientBootOptions = {},
): Promise<BootOutcome> {
  const packs = client.update.packs;
  const stampPacks = packs.configured
    ? await packs.bootOptions().catch(() => ({
        requiredPacks: [] as string[],
        essentialPacks: [] as string[],
      }))
    : { requiredPacks: [] as string[], essentialPacks: [] as string[] };
  const bootOpts: BootOptions = {
    allowOffline: opts.allowOffline ?? true,
    allowGrace: opts.allowGrace ?? true,
    requiredPacks: [
      ...new Set([...stampPacks.requiredPacks, ...(opts.requiredPacks ?? [])]),
    ],
    essentialPacks: stampPacks.essentialPacks,
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
  let guard: BootAttempt | null = null;

  send({ type: "start" });
  // shell: discovery, when the build did not pin what the product runs or this is a fresh
  // install (its registration policy decides whether it may register before it syncs).
  const fresh = !client.hasToken;
  if (!client.servicesPinned || fresh)
    await client.discover().catch(() => null);
  if (
    fresh &&
    opts.registration !== false &&
    client.discovery()?.core?.registration === "open"
  )
    await client.devices.register().catch(() => null);
  send({ type: "shell.done" });

  // guard
  try {
    guard = await client.update.markBootAttempt();
    send({ type: "guard.done", result: guard.result });
  } catch {
    send({ type: "guard.done", result: "ok" });
  }

  // sync
  try {
    send({ type: "sync.done", result: syncResult(await client.sync()) });
  } catch {
    send({ type: "sync.done", result: "offline" });
  }
  if (stage() !== "gate") return finish();

  // gate
  const { license } = await reacquire(client, opts.registration !== false);
  send({ type: "gate.status", status: license.status });
  if (stage() !== "decide") return finish();

  // decide
  let d: BootDecision = "none";
  if (client.update.decidable && isUsable(client.status())) {
    try {
      const skipVersion = await client.update.guard.skipVersion();
      decision = await client.update.decide({ skipVersion });
      d = decision.decision.action === "none" ? "none" : "optional";
    } catch {
      d = "none";
    }
  }
  send({ type: "decide.done", decision: d });
  if (stage() !== "fetch") return finish();

  // fetch
  if (packs.configured) {
    try {
      await packs.bootFetch({
        send,
        consent: opts.consent ?? "metered",
        metered: opts.metered ?? false,
        answer: opts.answer ?? (async () => false),
      });
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      send({
        type: "fail",
        code: typeof code === "string" ? code : "fetch-failed",
      });
    }
  } else {
    send({ type: "fetch.done", result: "ok", installed: [] });
  }
  if (stage() === "mount") send({ type: "mount.done" });
  return finish();

  function finish(): Promise<BootOutcome> {
    const confirmation = bootConfirmation(state.outcome);
    if (confirmation === "now")
      void client.update.confirmBoot().catch(() => undefined);
    else if (
      confirmation === "after-ok-seconds" &&
      opts.autoConfirm !== false
    ) {
      const t = setTimeout(() => {
        void client.update.confirmBoot().catch(() => undefined);
      }, BOOT_OK_SECONDS * 1000);
      t.unref?.();
    }
    return Promise.resolve({
      outcome: state.outcome,
      state,
      license: client.status(),
      decision,
      guard,
      emits,
    });
  }
}
