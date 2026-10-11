import * as React from "react";
import { Button } from "../../../ui/Button.js";
import { t } from "../../../lib/copy.js";
import { Input } from "../../../ui/Input.js";
import { Expand } from "../../../ui/motion/index.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { PortalApiError, type PortalMethods } from "../../api.js";
import { useMakePrimary, useRenamePasskey } from "../../data.js";
import { isStepUpRequired, portalErrorCopy } from "../../errors.js";
import { stepUpFresh } from "../../model/methods.js";
import { scrollBehavior } from "../../router.js";
import { StepUp } from "./StepUp.js";

/**
 * The two row actions that sit beside **Remove** (PORTAL.md §4.26; PX-W19's API): **Make primary**
 * on a verified email and **Rename** on a passkey. Each is a render prop: it owns the action's
 * state and hands the row its button and its panel.
 *
 * - **Make primary** runs at once with a fresh sign-in, and asks "Confirm it's you first" in a
 *   panel when the session is stale (or the Worker says it is). The row moves to the top of the
 *   list, so focus goes to the group's heading, as after a removal.
 * - **Rename** expands a one-field form in place. Save with an empty field clears the name. The
 *   input survives a failed save; a stale sign-in asks to confirm and then saves.
 */
export interface ToolSlots {
  action: React.ReactNode;
  panel: React.ReactNode;
}

interface ToolProps {
  view: PortalMethods;
  accountId: string;
  returnTo: string;
  children: (slots: ToolSlots) => React.ReactElement;
}

function errorText(err: unknown): string {
  if (err instanceof PortalApiError) {
    if (err.status === 422 && err.message) return err.message;
    if (err.status === 404)
      return "It's already gone. The list is up to date now.";
  }
  const copy = portalErrorCopy(err);
  return `${copy.title}. ${copy.description}`;
}

export function MakePrimaryTool({
  methodId,
  email,
  focusAfter,
  view,
  accountId,
  returnTo,
  children,
}: ToolProps & {
  methodId: string;
  email: string;
  focusAfter: () => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [needsStepUp, setNeedsStepUp] = React.useState(false);
  const mutation = useMakePrimary();
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const panelId = `primary-${methodId}`;
  const text = `${email} is now your primary email`;

  const run = (): void => {
    mutation.mutate(methodId, {
      onSuccess: () => {
        toast.success(text);
        announce(text);
        focusAfter();
      },
      onError: (err) => {
        if (isStepUpRequired(err)) {
          setNeedsStepUp(true);
          setOpen(true);
        }
      },
    });
  };
  const close = (): void => {
    setOpen(false);
    setNeedsStepUp(false);
    mutation.reset();
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  const fresh = stepUpFresh(view.stepUp, Math.floor(Date.now() / 1000));
  const error =
    mutation.error && !isStepUpRequired(mutation.error)
      ? errorText(mutation.error)
      : null;

  const action = open ? null : (
    <Button
      ref={buttonRef}
      variant="ghost"
      className="h-10 font-medium"
      loading={mutation.isPending}
      aria-label={`Make ${email} primary`}
      aria-expanded={false}
      aria-controls={panelId}
      onClick={() => {
        if (fresh) run();
        else setOpen(true);
      }}
    >
      Make primary
    </Button>
  );
  const panel = (
    <>
      {error && !open ? (
        <p role="alert" className="mt-2 text-sm text-danger sm:ml-13">
          {error}
        </p>
      ) : null}
      <Expand
        id={panelId}
        open={open}
        onOpen={() => headingRef.current?.focus({ preventScroll: true })}
        onOpened={(region) =>
          region.scrollIntoView?.({
            block: "nearest",
            behavior: scrollBehavior(),
          })
        }
      >
        <div className="pt-3 sm:ml-13">
          <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4">
            <h4
              ref={headingRef}
              tabIndex={-1}
              className="font-medium text-fg-strong outline-none"
            >
              Make {email} primary?
            </h4>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <StepUp
              verb="make it primary"
              view={view}
              accountId={accountId}
              returnTo={returnTo}
              autoFocus={needsStepUp}
              onConfirmed={() => {
                headingRef.current?.focus({ preventScroll: true });
                setNeedsStepUp(false);
                run();
              }}
            />
            <Button variant="outline" onClick={close}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      </Expand>
    </>
  );
  return children({ action, panel });
}

export function RenamePasskeyTool({
  passkeyId,
  current,
  what,
  view,
  accountId,
  returnTo,
  children,
}: ToolProps & {
  passkeyId: string;
  /** The name it has now, or "" when unnamed. */
  current: string;
  /** For the button's name: "the iCloud Keychain passkey". */
  what: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState(current);
  const [needsStepUp, setNeedsStepUp] = React.useState(false);
  const mutation = useRenamePasskey();
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const fieldId = React.useId();
  const errorId = React.useId();
  const panelId = `rename-${passkeyId}`;
  const fresh = stepUpFresh(view.stepUp, Math.floor(Date.now() / 1000));

  const save = (): void => {
    const name = value.trim();
    mutation.mutate(
      { id: passkeyId, name: name === "" ? null : name },
      {
        onSuccess: () => {
          const said = name === "" ? "The name was cleared" : "Renamed";
          toast.success(said);
          announce(said);
          setOpen(false);
          setNeedsStepUp(false);
          requestAnimationFrame(() => buttonRef.current?.focus());
        },
        onError: (err) => {
          if (isStepUpRequired(err)) setNeedsStepUp(true);
        },
      },
    );
  };
  const close = (): void => {
    setOpen(false);
    setNeedsStepUp(false);
    setValue(current);
    mutation.reset();
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  const error =
    mutation.error && !isStepUpRequired(mutation.error)
      ? errorText(mutation.error)
      : null;
  const askFirst = needsStepUp || (open && !fresh);

  const action = open ? null : (
    <Button
      ref={buttonRef}
      variant="ghost"
      className="h-10 font-medium"
      aria-label={`Rename ${what}`}
      aria-expanded={false}
      aria-controls={panelId}
      onClick={() => {
        setValue(current);
        setOpen(true);
      }}
    >
      {t("devices.rename")}
    </Button>
  );
  const panel = (
    <Expand
      id={panelId}
      open={open}
      onOpen={() => document.getElementById(fieldId)?.focus()}
      onOpened={(region) =>
        region.scrollIntoView?.({
          block: "nearest",
          behavior: scrollBehavior(),
        })
      }
    >
      <div className="pt-3 sm:ml-13">
        <form
          noValidate
          className="space-y-2 rounded-lg border border-border bg-surface-sunken p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!askFirst) save();
          }}
        >
          <label
            htmlFor={fieldId}
            className="text-sm font-medium text-fg-strong"
          >
            Name
          </label>
          <Input
            id={fieldId}
            value={value}
            maxLength={64}
            autoComplete="off"
            onValueChange={(v) => {
              setValue(v);
              if (mutation.error) mutation.reset();
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : (
            <p className="text-sm text-fg-muted">
              Leave it empty to use the browser's name.
            </p>
          )}
          {askFirst ? (
            <StepUp
              verb="rename it"
              view={view}
              accountId={accountId}
              returnTo={returnTo}
              autoFocus={needsStepUp}
              onConfirmed={() => {
                setNeedsStepUp(false);
                save();
              }}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={close}>
              {t("common.cancel")}
            </Button>
            {askFirst ? null : (
              <Button type="submit" loading={mutation.isPending}>
                {t("common.save")}
              </Button>
            )}
          </div>
        </form>
      </div>
    </Expand>
  );
  return children({ action, panel });
}
