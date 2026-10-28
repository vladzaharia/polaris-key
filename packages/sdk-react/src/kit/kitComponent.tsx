"use client";
// One §4.1 component as a React component (`kitComponent`), and the update dialog that wraps the
// optional prompt. Its own module: the web gate's entry never calls it, and a module only the
// drop-in parts (drive.tsx) and the per-component exports use stays out of the gate's chunk.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  MODELS,
  type ComponentName,
  type SyncScreenName,
} from "@polaris-key/ui-core";
import { platformVariant } from "@polaris-key/ui-core/theme";

import { KitRoot, useKit, type KitProps } from "./component.js";
import { adaptPane, adaptUpdate, oneVerb, withoutLede } from "./adapt.js";
import { withChoice } from "./licenseRows.js";
import { renderView } from "./views.js";
import { SYNC_LAYOUTS, syncContent } from "./syncParts.js";

/** One §4.1 component as a React component: its view, drawn in the kit's look. */
/** States of an update that own the window; every other is a dialog over the running app (DL2). */
const UPDATE_BLOCKING: ReadonlySet<string> = new Set([
  "mandatory",
  "blocked",
  "revoked-required-content",
]);

/** An optional update prompt: a modal `<dialog>` over the host on the scrim (a bottom sheet on a
 *  phone), the host inert. Escape and the scrim answer Later; focus returns to what held it. It
 *  stays closed until the state changes. */
function UpdateDialog(props: {
  state: string;
  hasLater: boolean;
  later: () => void;
  dismissed: string | null;
  close: () => void;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = props.dismissed !== props.state;
  useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    opener.current ??=
      document.activeElement && document.activeElement !== document.body
        ? (document.activeElement as HTMLElement)
        : null;
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  });
  const giveBack = () => {
    const o = opener.current;
    opener.current = null;
    if (o?.isConnected) o.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) giveBack();
  }, [open]);
  // A host that unmounts the dialog on close (onDismiss) gets the same focus return.
  useEffect(() => giveBack, []);
  if (!open) return null;
  const dismiss = () => (props.hasLater ? props.later() : props.close());
  return (
    <dialog
      ref={ref}
      className="sheet"
      data-part="sheet"
      aria-labelledby="pk-title"
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      {props.children}
    </dialog>
  );
}

/** What a Cloud Sync screen takes besides a kit component's props. */
export interface SyncScreenProps extends KitProps {
  /** RecoveryCode: the new recovery code, handed over once. It is drawn as text, held in no
   *  input or view, and never an input's value. */
  code?: string;
}

const isSyncScreen = (c: ComponentName): c is SyncScreenName =>
  c in SYNC_LAYOUTS;

export function kitComponent(component: ComponentName) {
  function KitComponent(props: SyncScreenProps): ReactNode {
    // The state the person dismissed: the update dialog stays closed until the state changes.
    const [dismissed, setDismissed] = useState<string | null>(null);
    const stateRef = useRef("");
    const kit = useKit(
      component,
      MODELS[component],
      component === "UpdatePrompt"
        ? {
            ...props,
            onAction: (a) => {
              if (a.key === "update.later") setDismissed(stateRef.current);
              props.onAction?.(a);
            },
          }
        : component === "Settings" && props.onDismiss
          ? {
              ...props,
              onAction: (a) => {
                if (a.key === "common.done") {
                  setDismissed(stateRef.current);
                  props.onDismiss?.();
                }
                props.onAction?.(a);
              },
            }
          : props,
    );
    stateRef.current = kit.view.state;
    useEffect(() => {
      if (dismissed !== null && dismissed !== kit.view.state)
        setDismissed(null);
    });
    if (kit.view.state === "hidden") return null;
    // A host that handles input keeps a pane's title and rows through its transient states.
    let view =
      props.onInput !== undefined ? adaptPane(kit.view, kit.input) : kit.view;
    // The driven prompt on the web: one Download action (the page cannot install), and Later.
    // A desktop host installs in place: its prompt keeps "Update now" (Install and Relaunch).
    const desktop =
      kit.hostFacts !== null || platformVariant(kit.resolved.theme) !== "web";
    const download = props.driven && component === "UpdatePrompt" && !desktop;
    const version = kit.input.update?.version;
    view = oneVerb(view);
    if (download) view = adaptUpdate(view);
    view = withoutLede(view);
    const labels =
      download &&
      version &&
      view.state === "available" &&
      kit.copy.has("common.updateDownload")
        ? {
            "update.install": kit.copy.format("common.updateDownload", {
              version,
            }),
          }
        : undefined;
    const asDialog =
      (component === "UpdatePrompt" &&
        !props.embedded &&
        props.asWindow !== true &&
        !UPDATE_BLOCKING.has(view.state)) ||
      (component === "Settings" && props.onDismiss !== undefined) ||
      // A Cloud Sync screen the host opened over its page (`onDismiss`) is a modal dialog too.
      (isSyncScreen(component) && props.onDismiss !== undefined);
    const base = {
      ...withChoice(kit.ctxFor(view, labels ? { labels } : undefined)),
      dialog: asDialog,
      ...(asDialog && props.account ? { account: props.account } : {}),
    };
    // A Cloud Sync screen draws its own fields and actions on its own layout.
    const ctx = isSyncScreen(component)
      ? {
          ...base,
          layout: SYNC_LAYOUTS[component],
          content: syncContent(base, props.code ?? ""),
        }
      : base;
    const body = renderView(ctx);
    return (
      <KitRoot
        kit={kit}
        bare={props.bare}
        fill={props.fill}
        className={props.className}
        onEscape={
          isSyncScreen(component) && view.copy.includes("common.cancel")
            ? () => ctx.act("common.cancel")
            : undefined
        }
      >
        {asDialog ? (
          <UpdateDialog
            state={view.state}
            hasLater={view.copy.includes("update.later")}
            later={() => ctx.act("update.later")}
            dismissed={dismissed}
            close={() => {
              // A step with no Cancel (working, the recovery code) cannot be dismissed.
              if (
                isSyncScreen(component) &&
                !view.copy.includes("common.cancel")
              )
                return;
              setDismissed(view.state);
              props.onDismiss?.();
            }}
          >
            {body}
          </UpdateDialog>
        ) : (
          body
        )}
      </KitRoot>
    );
  }
  KitComponent.displayName = component;
  return KitComponent;
}
