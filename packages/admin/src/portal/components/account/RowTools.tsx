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
import { passkeyName, stepUpFresh } from "../../model/methods.js";
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
    if (err.status === 422)
      return err.message && err.message !== `portal api ${err.status}`
        ? err.message
        : t("locker.methods.nameLength");
    if (err.status === 404) return t("locker.methods.alreadyGone");
  }
  return portalErrorCopy(err).line;
}

/** Escape closes an inline panel, as Cancel does. */
function closeOnEscape(close: () => void) {
  return (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
}

const notice = (): string => t("locker.methods.noticeHere");

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
  const errorId = React.useId();
  const text = t("locker.methods.primaryNow", { email });
  const previous = view.emails.find((e) => e.primary)?.methodId ?? null;

  const run = (): void => {
    mutation.mutate(methodId, {
      onSuccess: () => {
        toast.success(text, {
          description: notice(),
          // Undo is a safe inverse: the sign-in is still fresh for 5 minutes.
          action: previous
            ? {
                label: t("toast.undo"),
                onClick: () => mutation.mutate(previous),
              }
            : undefined,
        });
        announce(text);
        focusAfter();
      },
      onError: (err) => {
        if (isStepUpRequired(err)) {
          setNeedsStepUp(true);
          setOpen(true);
          return;
        }
        // The pressed button was disabled while it ran: give focus back.
        requestAnimationFrame(() => buttonRef.current?.focus());
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
      variant="outline"
      className="h-11 font-medium"
      loading={mutation.isPending}
      aria-label={t("locker.methods.makePrimaryName", { email })}
      // A disclosure only when the click opens the panel (a stale sign-in).
      aria-expanded={fresh ? undefined : false}
      aria-controls={fresh ? undefined : panelId}
      aria-describedby={error && !open ? errorId : undefined}
      onClick={() => {
        if (fresh) run();
        else setOpen(true);
      }}
    >
      {t("locker.methods.makePrimary")}
    </Button>
  );
  const panel = (
    <>
      {error && !open ? (
        <p
          id={errorId}
          role="alert"
          className="mt-2 text-sm text-danger sm:ml-13"
        >
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
          <div
            className="max-w-xl space-y-3 rounded-lg border border-border bg-surface-sunken p-4"
            onKeyDown={closeOnEscape(close)}
          >
            <h4
              ref={headingRef}
              tabIndex={-1}
              className="font-medium text-fg-strong outline-none"
            >
              {t("locker.methods.makePrimaryAsk", { email })}
            </h4>
            <p className="text-sm text-fg-muted">{notice()}</p>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <StepUp
              verb={t("locker.verb.makePrimary")}
              view={view}
              accountId={accountId}
              returnTo={returnTo}
              autoFocus={needsStepUp}
              trailing={
                <Button
                  variant="outline"
                  className="max-sm:min-h-11"
                  onClick={close}
                >
                  {t("common.cancel")}
                </Button>
              }
              onConfirmed={() => {
                headingRef.current?.focus({ preventScroll: true });
                setNeedsStepUp(false);
                run();
              }}
            />
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
  fallback,
  what,
  view,
  accountId,
  returnTo,
  children,
}: ToolProps & {
  passkeyId: string;
  /** The name it has now, or "" when unnamed. */
  current: string;
  /** The name an empty field falls back to: "iCloud Keychain". */
  fallback: string;
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

  const done = (said: string | null): void => {
    if (said) {
      toast.success(said);
      announce(said);
    }
    setOpen(false);
    setNeedsStepUp(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  const save = (): void => {
    const name = value.trim();
    // Nothing changed: close without a request or a toast.
    if (name === current.trim()) {
      done(null);
      return;
    }
    mutation.mutate(
      { id: passkeyId, name: name === "" ? null : name },
      {
        onSuccess: () =>
          done(
            name === ""
              ? t("locker.methods.nameCleared")
              : t("locker.methods.renamed"),
          ),
        onError: (err) => {
          if (isStepUpRequired(err)) setNeedsStepUp(true);
        },
      },
    );
  };
  const close = (): void => {
    if (mutation.isPending) return;
    setOpen(false);
    setNeedsStepUp(false);
    setValue(current);
    mutation.reset();
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  const stepUpFailed = mutation.error && isStepUpRequired(mutation.error);
  const error =
    mutation.error && !stepUpFailed ? errorText(mutation.error) : null;
  const invalid =
    mutation.error instanceof PortalApiError && mutation.error.status === 422;

  const action = open ? null : (
    <Button
      ref={buttonRef}
      variant="outline"
      className="h-11 font-medium"
      aria-label={t("locker.methods.renameName", { name: what })}
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
          className="max-w-xl space-y-3 rounded-lg border border-border bg-surface-sunken p-4"
          onKeyDown={closeOnEscape(close)}
          onSubmit={(e) => {
            e.preventDefault();
            if (mutation.isPending || needsStepUp) return;
            // A stale sign-in: Save asks to confirm it's you, and saves once that's done.
            if (!fresh) setNeedsStepUp(true);
            else save();
          }}
        >
          <div className="space-y-2">
            <label
              htmlFor={fieldId}
              className="text-sm font-medium text-fg-strong"
            >
              {t("locker.methods.passkeyName")}
            </label>
            <Input
              id={fieldId}
              value={value}
              maxLength={64}
              autoComplete="off"
              placeholder={fallback}
              readOnly={mutation.isPending}
              className="max-w-sm"
              onValueChange={(v) => {
                setValue(v);
                if (mutation.error) mutation.reset();
              }}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : (
              <p className="text-sm text-fg-muted">
                {t("locker.methods.leaveEmpty", { name: fallback })}
              </p>
            )}
          </div>
          {needsStepUp ? (
            <div className="border-t border-border pt-3">
              <StepUp
                verb={t("locker.verb.rename")}
                view={view}
                accountId={accountId}
                returnTo={returnTo}
                autoFocus
                onConfirmed={() => {
                  setNeedsStepUp(false);
                  save();
                }}
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={close}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={mutation.isPending}
              disabled={needsStepUp}
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      </div>
    </Expand>
  );
  return children({ action, panel });
}
