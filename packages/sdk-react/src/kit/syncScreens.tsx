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
  /** This device now holds the key: unlocked, or started over and the new code saved. */
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

function DrivenUnlock(
  props: UnlockSyncProps & {
    ring: NonNullable<ReturnType<typeof useRing>>;
  },
): ReactNode {
  const { ring, onUnlocked, onCancel, ...rest } = props;
  const [step, setStep] = useState<Step>("code");
  const [fresh, setFresh] = useState<RingCode | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (f: () => Promise<RingStatus | RingCode>) => {
      setStep("working");
      try {
        const out = await f();
        if (!alive.current) return;
        if ("recoveryCode" in out) setFresh(out);
        else if (out.state === "unlocked") onUnlocked?.();
        else setStep("failed");
      } catch (e) {
        if (!alive.current) return;
        const code = (e as { code?: string })?.code;
        // No recovery code on the account (`not_found`): trying again cannot help, so the screen
        // goes to the way forward, Start over, instead of "Try again later".
        setStep(
          code === "recovery-code-invalid"
            ? "invalid"
            : code === "not_found"
              ? "start-over"
              : "failed",
        );
      }
    },
    [onUnlocked],
  );

  // The new code after Start over: shown once, then this device holds the key.
  if (fresh)
    return (
      <RecoveryCode
        {...rest}
        code={fresh.recoveryCode}
        onDone={() => {
          setFresh(null);
          onUnlocked?.();
        }}
      />
    );
  return (
    <UnlockSync_
      {...rest}
      input={{ ...rest.input, unlockSync: { step } }}
      onInput={(field, value) => {
        rest.onInput?.(field, value);
        // Editing the code clears "That code isn't right".
        if (field === "recoveryEdited")
          setStep((s) => (s === "invalid" ? "code" : s));
      }}
      onAction={(a) => {
        rest.onAction?.(a);
        switch (a.key) {
          case "unlockSync.unlock":
            void run(() => ring.recover(String(a.value ?? "")));
            break;
          case "unlockSync.startOver":
            setStep("start-over");
            break;
          case "unlockSync.startOverConfirm":
            void run(() => ring.reset());
            break;
          case "common.tryAgain":
            setStep("code");
            break;
          case "common.cancel":
            if (step === "start-over") setStep("code");
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
  /** Use recovery code: open UnlockSync. */
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
  return <DrivenRing {...props} />;
}

function DrivenRing(props: RingChangeProps): ReactNode {
  const { onAccepted, onUseCode, onCancel, ...rest } = props;
  const sdk = useContext(PolarisContext)!;
  const lock = useSyncLock();
  const changed = lock.status?.changed;
  if (lock.state !== "ring-changed" || !changed) return null;
  const served: RingIdentity = changed.served;
  return (
    <RingChange_
      {...rest}
      input={{ ringChange: { by: changed.by, served } }}
      onAction={(a) => {
        rest.onAction?.(a);
        switch (a.key) {
          case "ringChange.accept":
            // The ring the person was shown, never a fresh read (S5).
            void sdk.adapter.keyring
              .acceptRingChange(served)
              .then((s) => {
                if (s.state === "unlocked") onAccepted?.();
              })
              .catch(() => {
                // A refused accept leaves the confirmation up: the recovery code is the way in.
              });
            break;
          case "ringChange.useCode":
            onUseCode?.();
            break;
          case "common.cancel":
            onCancel?.();
            break;
        }
      }}
    />
  );
}
