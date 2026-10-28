"use client";
// The Cloud Sync screens as parts and as drop-ins (U-42.2), loaded on demand (`syncLazy.tsx`):
// UnlockSync (a browser unlocks only with the recovery code, or starts over), RecoveryCode (the new
// code, shown once) and RingChange (confirm a changed ring). Given an `input` each is the plain
// part and the host drives it; given none, inside `<PolarisKeyProvider>`, it runs the key ring
// itself (`adapter.keyring`): recover, reset, acceptRingChange.
//
// The recovery code is never kept: the field's text is read at the press and handed to
// `ring.recover`; a code from `ring.reset()` is held in this component's state while it is shown
// and dropped on Done. No path logs a code or puts one in an input or a view (S13).

import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { UiInput } from "@polaris-key/ui-core";

import { PolarisContext } from "../react/context.js";
import type { RingCode, RingIdentity, RingStatus } from "../core/keyring.js";
import type { KitAction } from "./component.js";
import { kitComponent, type SyncScreenProps } from "./kitComponent.js";
import { useSyncLock } from "../react/useKeyring.js";

export type { SyncScreenProps };

const UnlockSync_ = kitComponent("UnlockSync");
const RecoveryCode_ = kitComponent("RecoveryCode");
const RingChange_ = kitComponent("RingChange");

type Step = NonNullable<UiInput["unlockSync"]>["step"];

// ── RecoveryCode ─────────────────────────────────────────────────────────────────────────────

export interface RecoveryCodeProps extends SyncScreenProps {
  /** Done, once the person confirmed they saved the code. */
  onDone?: () => void;
}

/** The new recovery code, shown once: it takes the code from `code`, holds the "I've saved it"
 *  box itself, and offers Done once it is checked. With an `input` it is the plain part. */
export function RecoveryCode(props: RecoveryCodeProps): ReactNode {
  const { onDone, ...rest } = props;
  const [saved, setSaved] = useState(false);
  const input: UiInput = {
    ...rest.input,
    recoveryCode: { saved: rest.input?.recoveryCode?.saved ?? saved },
  };
  return (
    <RecoveryCode_
      {...rest}
      input={input}
      onInput={(field, value) => {
        if (field === "recoverySaved") setSaved(value !== "");
        rest.onInput?.(field, value);
      }}
      onAction={(a) => {
        rest.onAction?.(a);
        if (a.key === "common.done") onDone?.();
      }}
    />
  );
}

// ── UnlockSync ───────────────────────────────────────────────────────────────────────────────

export interface UnlockSyncProps extends SyncScreenProps {
  /** This device now holds the key: unlocked, or started over and the new code saved. Without it
   *  the drop-in simply leaves the screen. */
  onUnlocked?: () => void;
  /** Cancel (or Escape). */
  onCancel?: () => void;
}

/** Unlock with the recovery code, or start over. */
export function UnlockSync(props: UnlockSyncProps): ReactNode {
  const sdk = useContext(PolarisContext);
  if (props.input !== undefined || !sdk)
    return <UnlockSync_ {...props} onAction={hostAction(props)} />;
  return <DrivenUnlock {...props} ring={sdk.adapter.keyring} />;
}

function hostAction(
  props: UnlockSyncProps | RingChangeProps,
): (a: KitAction) => void {
  return (a) => {
    props.onAction?.(a);
    if (a.key === "common.cancel") props.onCancel?.();
  };
}

type Ring = NonNullable<ReturnType<typeof useRing>>;

function DrivenUnlock(props: UnlockSyncProps & { ring: Ring }): ReactNode {
  const { ring, onUnlocked, onCancel, ...rest } = props;
  const [step, setStep] = useState<Step>("code");
  const [busy, setBusy] = useState<"unlock" | "start-over">("unlock");
  // Where Cancel on the Start over warning goes back to.
  const [from, setFrom] = useState<Step>("code");
  const [fresh, setFresh] = useState<RingCode | null>(null);
  const [done, setDone] = useState(false);
  const failedAt = useRef<"unlock" | "reset">("unlock");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const finish = useCallback(() => {
    setDone(true);
    onUnlocked?.();
  }, [onUnlocked]);

  // Start over and the new code are not interrupted: Cancel and Escape are ignored while they run
  // (the working step offers neither), so a ring is never half replaced.
  const reset = useCallback(async () => {
    failedAt.current = "reset";
    setBusy("start-over");
    setStep("working");
    try {
      const code = await ring.reset();
      if (alive.current) setFresh(code);
    } catch {
      if (alive.current) setStep("failed");
    }
  }, [ring]);

  const unlock = useCallback(
    async (code: string) => {
      failedAt.current = "unlock";
      setBusy("unlock");
      setStep("working");
      try {
        const s = await ring.recover(code);
        if (!alive.current) return;
        if (s.state === "unlocked") finish();
        else setStep("failed");
      } catch (e) {
        if (!alive.current) return;
        const c = (e as { code?: string })?.code;
        // No recovery code on the account (`not_found`): trying again cannot help, so the screen
        // says so and offers Start over.
        if (c === "not_found") {
          setFrom("no-code");
          setStep("no-code");
        } else setStep(c === "recovery-code-invalid" ? "invalid" : "failed");
      }
    },
    [ring, finish],
  );

  if (done) return null;
  // The new code after Start over: shown once, then this device holds the key.
  if (fresh)
    return (
      <RecoveryCode
        {...rest}
        code={fresh.recoveryCode}
        onDone={() => {
          setFresh(null);
          finish();
        }}
      />
    );
  return (
    <UnlockSync_
      {...rest}
      input={{ ...rest.input, unlockSync: { step, busy } }}
      onInput={(field, value) => {
        rest.onInput?.(field, value);
        // Editing the code clears "That code isn't right".
        if (field === "recoveryEdited")
          setStep((s) => (s === "invalid" ? "code" : s));
      }}
      onAction={(a) => {
        rest.onAction?.(a);
        if (step === "working") return;
        switch (a.key) {
          case "unlockSync.unlock":
            void unlock(String(a.value ?? ""));
            break;
          case "unlockSync.startOver":
            setFrom(step === "no-code" ? "no-code" : "code");
            setStep("start-over");
            break;
          case "unlockSync.startOverConfirm":
            void reset();
            break;
          case "common.tryAgain":
            if (failedAt.current === "reset") void reset();
            else setStep("code");
            break;
          case "common.cancel":
            if (step === "start-over") setStep(from);
            else onCancel?.();
            break;
        }
      }}
    />
  );
}

/** The adapter's key ring, or null outside the provider. */
function useRing() {
  return useContext(PolarisContext)?.adapter.keyring ?? null;
}

// ── RingChange ───────────────────────────────────────────────────────────────────────────────

export interface RingChangeProps extends SyncScreenProps {
  /** That was me: this device now holds the key of the ring it was shown. */
  onAccepted?: () => void;
  /** Use recovery code. Without it the drop-in opens UnlockSync itself. */
  onUseCode?: () => void;
  onCancel?: () => void;
}

/** Confirm a changed ring: it names the device that set it up and passes the ring that was
 *  shown to `acceptRingChange`. Without a ring change to confirm it draws nothing. */
export function RingChange(props: RingChangeProps): ReactNode {
  const sdk = useContext(PolarisContext);
  if (props.input !== undefined || !sdk)
    return (
      <RingChange_
        {...props}
        onAction={(a) => {
          hostAction(props)(a);
          if (a.key === "ringChange.useCode") props.onUseCode?.();
        }}
      />
    );
  return <DrivenRing {...props} ring={sdk.adapter.keyring} />;
}

function DrivenRing(props: RingChangeProps & { ring: Ring }): ReactNode {
  const { ring, onAccepted, onUseCode, onCancel, ...rest } = props;
  const lock = useSyncLock();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [useCode, setUseCode] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const changed = lock.status?.changed;
  // Use recovery code with no host handler: this screen hands over to UnlockSync.
  if (useCode)
    return (
      <UnlockSync
        {...rest}
        onCancel={() => setUseCode(false)}
        onUnlocked={onAccepted}
      />
    );
  if (lock.state !== "ring-changed" || !changed) return null;
  const served: RingIdentity = changed.served;
  const accept = () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    // The ring the person was shown, never a fresh read (S5).
    ring
      .acceptRingChange(served)
      .then((s) => {
        if (!alive.current) return;
        if (s.state === "unlocked") onAccepted?.();
        else {
          // The ring moved again, or its wrap did not open: show the new ring and say so.
          setFailed(true);
          void lock.refresh();
        }
      })
      .catch(() => alive.current && setFailed(true))
      .finally(() => alive.current && setBusy(false));
  };
  return (
    <RingChange_
      {...rest}
      input={{
        ringChange: { by: changed.by, served, failed, busy },
      }}
      onAction={(a) => {
        rest.onAction?.(a);
        switch (a.key) {
          case "ringChange.accept":
            accept();
            break;
          case "ringChange.useCode":
            if (onUseCode) onUseCode();
            else setUseCode(true);
            break;
          case "common.cancel":
            if (!busy) onCancel?.();
            break;
        }
      }}
    />
  );
}
