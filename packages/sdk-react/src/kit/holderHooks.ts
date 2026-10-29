"use client";
// The headless half of the two screens activation without an account adds (UK-42): the Done step
// after a license key, and Add your name and email. ui-core's views (`activateDoneView`,
// `addToAccountView`) say what each shows; these hooks hold what the person typed and which step
// the attach is at, and hand a host the input to draw them with. No DOM, no stylesheet: this file
// stays small, so a host that draws its own screens does not load the styled ones (holders.tsx).
//
// Name and email live in this hook's state only: in no view, no input, no URL and no log.

import { useCallback, useMemo, useRef, useState } from "react";
import {
  activateDoneView,
  addToAccountView,
  contextOf,
  reasonsOf,
  type AddToAccountInput,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";

// ── ActivateDone ─────────────────────────────────────────────────────────────────────────────

export interface UseActivateDoneOptions {
  /** What the views read: `activateDone` (the license line) and, when an email holds the license,
   *  `licenseHolder`. Without `activateDone` the screen is hidden. */
  input?: UiInput;
  /** Start using the product: the one primary. */
  onStart?: () => void;
  /** Add your name and email: the recommendation's action opens AddToAccount. */
  onAddToAccount?: () => void;
  /** Sign in as the email the license was sent to (the waiting state). */
  onSignIn?: () => void;
}

export interface UseActivateDone {
  view: View<"ActivateDone", "ready" | "waiting" | "hidden">;
  input: UiInput;
  /** The reason lines the product has, as copy keys, in the order they show. */
  reasons: string[];
  start(): void;
  addToAccount(): void;
  signIn(): void;
}

/** The Done step after a license key, headless. */
export function useActivateDone(
  o: UseActivateDoneOptions = {},
): UseActivateDone {
  const input = useMemo<UiInput>(() => o.input ?? {}, [o.input]);
  const view = useMemo(
    () => activateDoneView(contextOf({ elapsedMs: 60_000, ...input })),
    [input],
  );
  const reasons = useMemo(() => reasonsOf(contextOf(input)), [input]);
  const handlers = useRef(o);
  handlers.current = o;
  return {
    view,
    input,
    reasons,
    start: useCallback(() => handlers.current.onStart?.(), []),
    addToAccount: useCallback(() => handlers.current.onAddToAccount?.(), []),
    signIn: useCallback(() => handlers.current.onSignIn?.(), []),
  };
}

// ── AddToAccount ─────────────────────────────────────────────────────────────────────────────

/** How the attach ended. `owned`: someone attached the license meanwhile; `email-bound`: the
 *  license's email is not the account's (it keeps working); `failed`: nothing changed, try again. */
export type AttachOutcome = "added" | "owned" | "email-bound" | "failed";

export interface AddToAccountValues {
  name: string;
  email: string;
}

export interface UseAddToAccountOptions {
  /** Confirm the email in the browser and attach the license. Resolves with the outcome; a
   *  rejection is `failed`. Without it the hook only validates (the host handles the press). */
  attach?: (who: AddToAccountValues) => Promise<AttachOutcome>;
  /** What the views read besides the step (identity, services, `licenseHolder`). A snapshot
   *  carrying `addToAccount` hands the step to the host: the hook then only holds the fields. */
  input?: UiInput;
  /** The device kind already worded ("computer", "phone"). */
  deviceKind?: string;
  /** The person pressed Add and the fields are valid (`attach` is absent). */
  onSubmit?: (who: AddToAccountValues) => void;
}

export interface UseAddToAccount {
  view: View<"AddToAccount">;
  /** The views' input: `input` with this hook's step on top. */
  input: UiInput;
  step: AddToAccountInput["step"];
  name: string;
  email: string;
  setName(v: string): void;
  setEmail(v: string): void;
  /** Validate, then attach. The first wrong field is returned (for focus), or null. */
  submit(): "name" | "email" | null;
  /** From `failed`, again. */
  retry(): void;
  /** Back to the form, fields kept. */
  reset(): void;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The fields that are wrong: a name needs a character, an email its shape. */
export function wrongFields(v: AddToAccountValues): ("name" | "email")[] {
  return [
    ...(v.name.trim() === "" ? (["name"] as const) : []),
    ...(EMAIL.test(v.email.trim()) ? [] : (["email"] as const)),
  ];
}

/** Add your name and email, headless: the fields, their check and the attach's step. */
export function useAddToAccount(
  o: UseAddToAccountOptions = {},
): UseAddToAccount {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [own, setOwn] = useState<AddToAccountInput>({
    step: "form",
    ...(o.deviceKind ? { deviceKind: o.deviceKind } : {}),
  });
  const held = useRef(o);
  held.current = o;
  const alive = useRef(0);

  const run = useCallback(async (who: AddToAccountValues) => {
    const attach = held.current.attach;
    if (!attach) {
      held.current.onSubmit?.(who);
      return;
    }
    const turn = ++alive.current;
    setOwn((s) => ({ ...s, step: "busy" }));
    let outcome: AttachOutcome;
    try {
      outcome = await attach(who);
    } catch {
      outcome = "failed";
    }
    if (turn === alive.current) setOwn((s) => ({ ...s, step: outcome }));
  }, []);

  const submit = useCallback((): "name" | "email" | null => {
    const who = { name: name.trim(), email: email.trim() };
    const wrong = wrongFields(who);
    if (wrong.length > 0) {
      setOwn((s) => ({
        ...s,
        step: "invalid",
        field: wrong.length === 2 ? "both" : wrong[0]!,
      }));
      return wrong[0]!;
    }
    void run(who);
    return null;
  }, [name, email, run]);

  const reset = useCallback(() => {
    alive.current++;
    setOwn((s) => ({
      step: "form",
      ...(s.deviceKind ? { deviceKind: s.deviceKind } : {}),
    }));
  }, []);

  const retry = useCallback(() => {
    void run({ name: name.trim(), email: email.trim() });
  }, [name, email, run]);

  const host = o.input?.addToAccount;
  const addToAccount: AddToAccountInput = host ?? {
    ...own,
    ...(o.deviceKind && !own.deviceKind ? { deviceKind: o.deviceKind } : {}),
  };
  const input = useMemo<UiInput>(
    () => ({ ...(o.input ?? {}), addToAccount }),
    // The step is plain data: compare by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [o.input, JSON.stringify(addToAccount)],
  );
  const view = useMemo(
    () => addToAccountView(contextOf({ elapsedMs: 60_000, ...input })),
    [input],
  );
  return {
    view,
    input,
    step: addToAccount.step,
    name,
    email,
    setName,
    setEmail,
    submit,
    retry,
    reset,
  };
}
