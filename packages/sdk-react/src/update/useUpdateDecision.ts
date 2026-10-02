// `useUpdateDecision` — the headless half of wire v4's update decision (WIRE-CONTRACT-V4 §2.5,
// plans/P3-01.md §2.8), beside `useLatestVersion`, which stays for the unsigned
// `/update/version` path.
//
// It asks the active adapter's `decideUpdate()` — the browser transport verifies the signed feed
// and the pinned release record in-page, the desktop bridge forwards to the host's
// `client.update.decide()` — and reports the whole `UpdateCheck` plus what a renderer needs to act
// on it: the decision, its boot value, and whether it is a prompt the player cannot dismiss.
//
// Fail-closed (D-21): a product that does not run the Update service is never asked. A host
// `decider` replaces the adapter, for an app with its own update source.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  bootDecision,
  isUndismissable,
  type BootDecision,
} from "@polaris-key/client-core";
import type {
  StagedUpdate,
  UpdateCheck,
  UpdateDecision,
} from "@polaris-key/protocol/update";
import type { PolarisError, UpdateDecideOptions } from "../core/index.js";
import { useAdapterState, useCtx } from "../react/hooks.js";

export interface UseUpdateDecisionOptions {
  /** The channel to ask about (an alias is fine). Defaults to `stable`. */
  channel?: string;
  /** The update the host staged, under the `UpdateCheck.channel` it was staged on. */
  staged?: StagedUpdate | null;
  /** The version the boot guard rolled back. */
  skipVersion?: string | null;
  /** Re-decide on this interval (seconds). Off by default. */
  intervalSeconds?: number;
  /** Decide once on mount (default true). */
  immediate?: boolean;
  /** Bypass the adapter and ask this instead. */
  decider?: (opts: UpdateDecideOptions) => Promise<UpdateCheck>;
}

export interface UseUpdateDecision {
  /** The last `UpdateCheck`: the canonical channel, the decision, where the feed and record came
   *  from, and the errors the decision survived. */
  check: UpdateCheck | null;
  /** `check.decision`, or null before the first answer. */
  decision: UpdateDecision | null;
  /** The stage machine's `decide.done` for the decision (`bootDecision`). `required` only for
   *  revoked required content (plans/P4-13.md §2.6, decision 4): the boot stops at
   *  `blocked {update-required}`. Floors never give it. */
  boot: BootDecision | null;
  /** The content cause of the decision, for a host's own (localised) copy: `revoked-content`
   *  (the required hard stop) or `content-floor` (a prompt), from `blocked {reason}` or an
   *  answer's `contentBlock`; null otherwise. */
  reason: "revoked-content" | "content-floor" | null;
  /** True for a mandatory `binary`, `store` or `platform` answer and every `blocked` one: a
   *  prompt the player cannot dismiss, over an app that keeps running. */
  undismissable: boolean;
  busy: boolean;
  /** The last decision's error (cleared by the next success). */
  error: PolarisError | Error | null;
  /** False when the product does not run the Update service — nothing is asked. */
  enabled: boolean;
  /** Decide now. Resolves to the check, or null when disabled or on error. */
  decide: () => Promise<UpdateCheck | null>;
}

export function useUpdateDecision(
  opts: UseUpdateDecisionOptions = {},
): UseUpdateDecision {
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  const {
    channel,
    staged,
    skipVersion,
    intervalSeconds,
    immediate = true,
    decider,
  } = opts;
  const enabled = Boolean(decider) || state.capabilities.update.enabled;

  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PolarisError | Error | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // `staged` is an object; key the callback on its fields so a fresh literal each render does
  // not re-decide.
  const stagedVersion = staged?.version;
  const stagedChannel = staged?.channel;
  const decide = useCallback(async (): Promise<UpdateCheck | null> => {
    if (!enabled) return null;
    const args: UpdateDecideOptions = {};
    if (channel !== undefined) args.channel = channel;
    if (stagedVersion !== undefined && stagedChannel !== undefined)
      args.staged = { version: stagedVersion, channel: stagedChannel };
    else if (staged === null) args.staged = null;
    if (skipVersion !== undefined) args.skipVersion = skipVersion;
    setBusy(true);
    try {
      const result = decider
        ? await decider(args)
        : await adapter.decideUpdate(args);
      if (!alive.current) return result;
      setCheck(result);
      setError(null);
      return result;
    } catch (e) {
      if (alive.current) setError(e as Error);
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
    // `staged` itself is read only for its null-ness.
  }, [
    adapter,
    channel,
    decider,
    enabled,
    skipVersion,
    stagedChannel,
    stagedVersion,
    staged === null,
  ]);

  useEffect(() => {
    if (!enabled) return;
    if (immediate) void decide();
    if (!intervalSeconds || intervalSeconds <= 0) return;
    const id = setInterval(() => void decide(), intervalSeconds * 1000);
    return () => clearInterval(id);
  }, [decide, enabled, immediate, intervalSeconds]);

  const decision = check?.decision ?? null;
  return {
    check,
    decision,
    boot: decision ? bootDecision(decision) : null,
    reason: decision ? contentReason(decision) : null,
    undismissable: decision ? isUndismissable(decision) : false,
    busy,
    error,
    enabled,
    decide,
  };
}

/** The decision's content cause (plans/P4-13.md §2.6): `blocked {reason}` for a content reason,
 *  else the answer's `contentBlock`. */
export function contentReason(
  decision: UpdateDecision,
): "revoked-content" | "content-floor" | null {
  if (
    decision.action === "blocked" &&
    (decision.reason === "revoked-content" ||
      decision.reason === "content-floor")
  )
    return decision.reason;
  if ("contentBlock" in decision && decision.contentBlock !== undefined)
    return decision.contentBlock;
  return null;
}
