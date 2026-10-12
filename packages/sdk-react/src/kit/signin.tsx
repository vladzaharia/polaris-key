"use client";
// The one sign-in form (SIGN-IN.md §3.17, UI-KITS.md §1.3) in React: `<SignIn>` owns every in-app
// step and morphs its body in place (methods → handoff | code → finishing → choose ↔ replace |
// key → done). The step parts `<SignInMethods>`, `<ReplaceDevice>` and `<SignInDone>` draw one
// step each, beside `<SignInHandoff>`, `<LicenseChoice>` and `<Activate>`; `useSignIn()` is the
// headless half. The React twin of `@polaris-key/elements` src/signin.ts: the same steps (one
// `formStep` in the shared contract), the same DOM, the same controls.
//
// Inputs: the host's `input` (a snapshot, the fixtures' way), or `primitives` (the SDK's sign-in
// primitives, plans/I-04.md §G.9), which the form drives through ui-core's `SignInModel` from its
// own controls. `presentation="inline|sheet|browser"` and `replace="inline|browser"` are the same
// option in every kit (D-79); `sheet` puts the form in a modal `<dialog>` over the scrim (DL2:
// the page behind is inert, Escape backs out, focus returns to the opener).
//
// Motion (SIGN-IN.md §3.18): the card's height morphs between steps and the new body enters from
// the side of travel, through the Web Animations API (CSP-safe: no style attribute, no injected
// sheet). Reduced motion, or `theme.motion: "none"`, swaps instantly.

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  SignInModel,
  type ReplaceMode,
  type SignInPresentation,
  type SignInPrimitives,
  type UiInput,
} from "@polaris-key/ui-core";

import { KitRoot, useKit, type KitProps } from "./component.js";
import {
  FORM_ORDER,
  formStep,
  type FormInput,
  type FormStep,
} from "./contract.js";
import { text } from "./parts.js";
import { renderView } from "./views.js";

export type { FormInput, FormStep } from "./contract.js";

const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** What `useSignIn()` takes: the form's options and what the views read besides it. */
export interface UseSignInOptions {
  /** The SDK's sign-in primitives (plans/I-04.md §G.9). Absent: the form draws `input` only. */
  primitives?: SignInPrimitives;
  /** Where the form lives (D-79): in the page, in a modal sheet, or on the hosted card. */
  presentation?: SignInPresentation;
  /** Where Replace a device runs: in the form, or on the card. */
  replace?: ReplaceMode;
  /** Everything else the views read (identity, platform, capabilities, services), or a whole
   *  snapshot when there are no primitives. */
  input?: UiInput;
}

/** The form's headless state: the live model, the input its views read, and the step drawn. */
export interface UseSignIn {
  /** ui-core's `SignInModel` once `primitives` are set; null without them. */
  model: SignInModel | null;
  /** The views' input: `input` with the form's own state on top. */
  input: FormInput;
  /** The step the card draws now (`step.body` is its view). */
  step: FormStep;
}

/** The input the form's views read: the host's, the model's state over it, the options applied. */
function formInput(o: UseSignInOptions, model: SignInModel | null): FormInput {
  const base: FormInput = model
    ? { ...(o.input ?? {}), ...model.input() }
    : { ...(o.input ?? {}) };
  if (base.signIn && (o.presentation || o.replace))
    base.signIn = {
      ...base.signIn,
      ...(o.presentation ? { presentation: o.presentation } : {}),
      ...(o.replace ? { replace: o.replace } : {}),
    };
  return base;
}

/**
 * The one sign-in form, headless (layer c): ui-core's `SignInModel` over the SDK's primitives,
 * re-rendering on every change. StrictMode-safe: a model is created in an effect and disposed with
 * it (the sign-in itself stays open on the server, `SignInModel.dispose()`).
 */
export function useSignIn(o: UseSignInOptions = {}): UseSignIn {
  const [model, setModel] = useState<SignInModel | null>(null);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const base = o.input ?? {};
  const baseRef = useRef<UiInput>(base);
  baseRef.current = base;
  useEffect(() => {
    if (!o.primitives) {
      setModel(null);
      return;
    }
    const m = new SignInModel({
      primitives: o.primitives,
      presentation: o.presentation ?? "inline",
      replace: o.replace ?? "inline",
      base: baseRef.current,
      deliver: (fn) => queueMicrotask(fn),
    });
    setModel(m);
    const stop = m.subscribe(() => force());
    return () => {
      stop();
      m.dispose();
    };
  }, [o.primitives, o.presentation, o.replace]);
  // What the views read besides the form follows the host (idempotent: keyed by value).
  const baseKey = JSON.stringify(base);
  const lastBase = useRef<string | null>(null);
  if (model && lastBase.current !== baseKey) {
    lastBase.current = baseKey;
    model.setBase(base);
  }
  const input = formInput(o, model);
  return { model, input, step: formStep(input) };
}

/** The props of `<SignIn>`: a kit component's, the form's options, and the sheet's state. */
export interface SignInProps extends KitProps {
  /** The SDK's sign-in primitives; the form drives them from its own controls. */
  primitives?: SignInPrimitives;
  /** Where the form lives (D-79). `sheet` draws it in a modal dialog while `open`. */
  presentation?: SignInPresentation;
  /** Where Replace a device runs. */
  replace?: ReplaceMode;
  /** `sheet` only: the dialog is open. */
  open?: boolean;
  /** The person pressed Done's Start. */
  onDone?: () => void;
  /** `sheet` only: the dialog closed (Escape, Cancel before a sign-in starts, Done). */
  onClose?: () => void;
}

/** Steps a step part draws; the form draws all of them. */
type Steps = readonly string[] | null;

const reducedMotion = (motion: string): boolean =>
  motion !== "full" ||
  (typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches);

/** The step morph: the card's height from the old step's to the new, the body entering from the
 *  side of travel (forward from the inline end, Back from the inline start; mirrored in RTL). */
function morph(card: HTMLElement, fromHeight: number, forward: boolean): void {
  if (typeof card.animate !== "function") return;
  const to = card.getBoundingClientRect().height;
  const css = getComputedStyle(card);
  const ms = (name: string, fallback: number) =>
    Number.parseFloat(css.getPropertyValue(name)) || fallback;
  const moderate = ms("--pk-duration-moderate", 260);
  const base = ms("--pk-duration-base", 200);
  const micro = ms("--pk-duration-micro", 80);
  const standard =
    css.getPropertyValue("--pk-ease-standard").trim() || "ease-out";
  const enter = css.getPropertyValue("--pk-ease-enter").trim() || "ease-out";
  const shift =
    css.getPropertyValue("--pk-motion-distance-lg").trim() || "12px";
  const sign = (forward ? 1 : -1) * (css.direction === "rtl" ? -1 : 1);
  if (Math.abs(to - fromHeight) > 1)
    card.animate([{ blockSize: `${fromHeight}px` }, { blockSize: `${to}px` }], {
      duration: moderate,
      easing: standard,
    });
  for (const n of card.children) {
    if (n.classList.contains("split") || n.classList.contains("shimmer"))
      continue;
    n.animate(
      [
        { opacity: 0, translate: `calc(${sign} * ${shift}) 0` },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: base, delay: micro, easing: enter, fill: "backwards" },
    );
  }
}

function SignInForm(props: SignInProps & { steps: Steps }): ReactNode {
  const form = useSignIn({
    primitives: props.primitives,
    presentation: props.presentation,
    replace: props.replace,
    input: props.input,
  });
  const model = form.model;
  // The device picked in the Replace step (kit-side, as in the elements).
  const [replacePick, setReplacePick] = useState<string | undefined>();
  const input: FormInput =
    replacePick !== undefined ? { ...form.input, replacePick } : form.input;
  const sheet = (props.presentation ?? input.signIn?.presentation) === "sheet";

  const close = () => {
    if (model && model.snapshot.session.outcome !== undefined)
      void model.cancel();
    props.onClose?.();
  };

  /** One control of the form, applied to the live model (plans/I-04.md §G.9's primitives). */
  const drive = async (
    key: string,
    detail: Record<string, unknown>,
  ): Promise<void> => {
    if (key === "signin.done.start") {
      props.onDone?.();
      if (sheet) props.onClose?.();
      return;
    }
    if (!model) return;
    const s = model.snapshot;
    switch (key) {
      case "signin.desktop.continue":
      case "signin.provider.continue":
      case "signin.email.continue":
      case "signin.passkey":
        return model.start({ channel: "browser" });
      case "signin.link.deviceCode":
      case "signin.handoff.useCode":
        return model.useCode();
      case "signin.handoff.again":
      case "signin.handoff.openBrowser":
        return model.reopen();
      case "signin.handoff.copyLink":
        return model.copyLink();
      case "signin.again":
      case "signInHandoff.newCode":
        return model.retry();
      case "common.cancel":
        if (s.session.outcome === undefined && sheet) return close();
        return model.cancel();
      case "signin.choice.continue":
        return model.continue();
      case "signin.choice.keyInstead":
        return model.haveKey();
      case "activate.submit":
        return model.submitKey(s.keyField?.text ?? "");
      case "signin.replace.open":
      case "signin.replace.openSystem": {
        const id = s.selected ?? s.choices?.preselected;
        return id ? model.openReplace(id) : undefined;
      }
      case "signin.replace.confirm":
        return typeof detail.deviceId === "string"
          ? model.confirmReplace(detail.deviceId)
          : undefined;
      case "signin.replace.back":
        setReplacePick(undefined);
        return model.back();
    }
  };

  const kit = useKit(
    "SignIn",
    {
      ...props,
      input,
      onAction: (a) => {
        props.onAction?.(a);
        void drive(a.key, a);
      },
      onInput: (field, value) => {
        if (model && field === "key")
          model.store.set((s) => ({ ...s, keyField: { text: value } }));
        props.onInput?.(field, value);
      },
      onSelect: (id) => {
        model?.select(id);
        props.onSelect?.(id);
      },
    },
    (_view, i) => formStep(i).body,
    {
      // Replace and continue carries the picked device; Use this license, the license.
      detail: (key, i) => {
        const f = i as FormInput;
        if (key === "signin.replace.confirm") {
          const devices = f.replaceView?.devices ?? [];
          const pick =
            devices.find((d) => d.id === f.replacePick) ??
            devices.find((d) => d.leastRecent) ??
            devices[0];
          return pick ? { deviceId: pick.id } : {};
        }
        if (key === "signin.choice.continue") {
          const id = f.selected ?? f.choices?.preselected ?? null;
          return id ? { licenseId: id } : {};
        }
        return {};
      },
      // In the Replace step a row picks the device to replace, never a license.
      pick: (id, view) => {
        if (view.state !== "replace-open") return false;
        setReplacePick(id);
        props.onSelect?.(id);
        return true;
      },
    },
  );

  const step = formStep(kit.input as FormInput);
  const stepKey = `${step.body.component}.${step.body.state}`;

  // The morph: measured after every commit, so a step change animates from the last height.
  const last = useRef<{ key: string; height: number; index: number } | null>(
    null,
  );
  const motion = kit.resolved.theme.motion;
  useIsoLayoutEffect(() => {
    const card = kit.rootRef.current?.querySelector<HTMLElement>(".card");
    const index = FORM_ORDER.indexOf(kit.view.state);
    const prev = last.current;
    const height = card?.getBoundingClientRect().height ?? 0;
    last.current = { key: stepKey, height, index };
    if (!card || !prev || prev.key === stepKey || reducedMotion(motion)) return;
    morph(card, prev.height, index >= prev.index);
  });

  // `sheet`: the dialog follows `open` (showModal makes the page behind inert).
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (props.open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!props.open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  });

  if (kit.view.state === "hidden") return null;
  if (props.steps && !props.steps.includes(kit.view.state)) return null;

  const c = kit.ctxFor(step.body);
  const announce = step.announce.length ? (
    <p className="visually-hidden" role="status">
      {step.announce.map((k) => (
        <span key={k} data-key={k}>
          {text(c, k)}
        </span>
      ))}
    </p>
  ) : null;
  const body = renderView(c);
  return (
    <KitRoot
      kit={kit}
      bare={props.bare}
      fill={props.fill && !sheet}
      className={props.className}
      onEscape={
        sheet
          ? undefined
          : model && kit.view.state !== "methods"
            ? () => void drive("common.cancel", {})
            : undefined
      }
    >
      {sheet ? (
        <dialog
          ref={dialogRef}
          className="sheet"
          data-part="sheet"
          aria-labelledby="pk-title"
          onCancel={(e) => {
            // Escape backs out (DL2): the form cancels its sign-in and the sheet closes.
            e.preventDefault();
            close();
          }}
        >
          {announce}
          {body}
        </dialog>
      ) : (
        <>
          {announce}
          {body}
        </>
      )}
    </KitRoot>
  );
}

/**
 * `<SignIn>`: the one sign-in form. With `primitives` it runs the sign-in itself; with only
 * `input` it draws the snapshot it is given and reports every control through `onAction`.
 */
export function SignIn(props: SignInProps): ReactNode {
  return <SignInForm {...props} steps={null} />;
}

function stepPart(name: string, steps: readonly string[]) {
  function StepPart(props: SignInProps): ReactNode {
    return <SignInForm {...props} steps={steps} />;
  }
  StepPart.displayName = name;
  return StepPart;
}

/** Step 1 alone (the methods, and their error), for an app that lays out its own form. */
export const SignInMethods = stepPart("SignInMethods", ["methods", "error"]);
/** Replace a device alone (§3.7). */
export const ReplaceDevice = stepPart("ReplaceDevice", ["replace"]);
/** Done alone. */
export const SignInDone = stepPart("SignInDone", ["done"]);
