import * as React from "react";
import { Lock } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Expand } from "../../../ui/motion/index.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import {
  PortalApiError,
  type PortalMethods,
  type PortalRemoveRefusal,
} from "../../api.js";
import { useRemoveMethod } from "../../data.js";
import { isStepUpRequired, portalErrorCopy } from "../../errors.js";
import { stepUpFresh } from "../../model/methods.js";
import { focusPageHeading, scrollBehavior } from "../../router.js";
import { StepUp } from "./StepUp.js";

/**
 * One sign-in method (PORTAL.md §4.26): its glyph, the method, the connected identity, when it
 * was connected and last used, and **Disconnect** (or **Remove**).
 *
 * - **The last method can't be removed.** Its row says **Only method**, the button stays in the
 *   tab order but is disabled (`aria-disabled`, described by the reason), and a `warning` line
 *   says why and what to do. The account's only email address is guarded the same way.
 * - **Removing asks for step-up.** The button expands the row in place (S-23's expand pattern;
 *   instant under reduced motion) into a `danger-subtle` panel: "Disconnect Steam?", the
 *   consequences, then either the confirm (a sign-in from the last 5 minutes) or "Confirm it's you
 *   first" (`StepUp`), which removes it as soon as the person has. Focus moves to the panel's
 *   heading as it opens; **Keep Steam** closes it and hands focus back to the button.
 * - **After a removal** focus goes to the group's heading (`focusAfter`), never to `body`: the
 *   row is about to leave the list. The result is said in a toast and announced.
 */
export interface MethodRowProps {
  /** The method's id: what DELETE /api/me/methods/<id> names. */
  id: string;
  icon: React.ReactNode;
  title: React.ReactNode;
  /** The method in the panel's heading and its button: "Steam", "mara.f@proton.me", "the 1Password passkey". */
  name: string;
  /** The button that leaves the panel: "Keep Steam", or "Keep it". */
  keepLabel: string;
  /** The method in the guard's sentence: "Apple", "this email". */
  guardName: string;
  /** Beside the title ("Only method"), or under it. */
  badge?: React.ReactNode;
  identity?: React.ReactNode;
  meta?: React.ReactNode;
  /** A warning about the method itself (a provider's flag). */
  notice?: React.ReactNode;
  canRemove: boolean;
  reason: PortalRemoveRefusal | null;
  /** "Disconnect" for an account; "Remove" for an email address or a passkey. */
  verb: "Disconnect" | "Remove";
  /** The consequences, as list items. */
  consequences: React.ReactNode[];
  view: PortalMethods;
  accountId: string;
  /** Where a provider sign-in returns to (`StepUp`). */
  returnTo: string;
  /** Open the panel at once (the page came back from a step-up sign-in to finish this). */
  initiallyOpen?: boolean;
  /** Where focus goes once the method is removed. */
  focusAfter: () => void;
  /** What to call the method when it's gone ("Steam was disconnected"). */
  doneText: string;
}

export function MethodRow({
  id,
  icon,
  title,
  name,
  keepLabel,
  guardName,
  badge,
  identity,
  meta,
  notice,
  canRemove,
  reason,
  verb,
  consequences,
  view,
  accountId,
  returnTo,
  initiallyOpen = false,
  focusAfter,
  doneText,
}: MethodRowProps): React.ReactElement {
  const [open, setOpen] = React.useState(initiallyOpen);
  const [needsStepUp, setNeedsStepUp] = React.useState(false);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const remove = useRemoveMethod();
  // Back from a provider's sign-in to finish this removal (`?remove=<id>`): the panel mounts open,
  // which runs no opening, so it takes focus and comes into view itself, after the page's own
  // heading focus.
  React.useEffect(() => {
    if (!initiallyOpen) return;
    focusPageHeading(() => headingRef.current);
    headingRef.current?.scrollIntoView?.({
      block: "center",
      behavior: scrollBehavior(),
    });
    // Once, as it mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const panelId = `method-${id}`;
  const reasonId = `method-${id}-reason`;
  const guarded = !canRemove && reason !== null;
  const fresh = stepUpFresh(view.stepUp, Math.floor(Date.now() / 1000));
  const askFirst = needsStepUp || !fresh;
  const lowerVerb = verb.toLowerCase();

  const close = (): void => {
    setOpen(false);
    setNeedsStepUp(false);
    remove.reset();
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const doRemove = (): void => {
    remove.mutate(id, {
      onSuccess: () => {
        toast.success(doneText);
        announce(doneText);
        // The row leaves with the refetch: focus moves first, so it never falls to `body`.
        focusAfter();
      },
      onError: (err) => {
        if (isStepUpRequired(err)) setNeedsStepUp(true);
      },
    });
  };

  const error =
    remove.error && !isStepUpRequired(remove.error)
      ? removeErrorText(remove.error)
      : null;

  return (
    <li className="py-3" data-method={id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong [&_svg]:size-5">
          {icon}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex flex-wrap items-center gap-x-2 font-bold text-fg-strong">
            <span className="min-w-0 break-words">{title}</span>
            {badge}
          </p>
          {identity ? (
            <p className="break-words text-sm text-fg">{identity}</p>
          ) : null}
          {meta ? <p className="text-sm text-fg-muted">{meta}</p> : null}
        </div>
        {open ? null : (
          <Button
            ref={buttonRef}
            variant="ghost"
            className="ml-auto h-10 font-bold"
            aria-disabled={guarded || undefined}
            aria-describedby={guarded ? reasonId : undefined}
            aria-expanded={guarded ? undefined : false}
            aria-controls={guarded ? undefined : panelId}
            aria-label={`${verb} ${name}`}
            onClick={() => {
              if (guarded) return;
              setOpen(true);
            }}
          >
            {verb}
          </Button>
        )}
      </div>
      {notice ? (
        <p className="mt-2 text-sm text-warning sm:pl-13">{notice}</p>
      ) : null}
      {guarded ? (
        <p
          id={reasonId}
          className="mt-2 flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-fg sm:ml-13"
        >
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          {reason === "last_link"
            ? `This is your only way to sign in. Connect another one first, then you can remove ${guardName}.`
            : "This is your account's only email address. Add another one first, then you can remove it."}
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
        <div className="pt-3">
          <div className="space-y-3 rounded-lg border border-danger-border bg-danger-subtle p-4">
            <h4
              ref={headingRef}
              tabIndex={-1}
              className="font-bold text-fg-strong outline-none"
            >
              {verb} {name}?
            </h4>
            <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
              {consequences.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            {askFirst ? (
              <>
                <StepUp
                  verb={lowerVerb}
                  tone="danger"
                  view={view}
                  accountId={accountId}
                  returnTo={returnTo}
                  autoFocus={needsStepUp}
                  onConfirmed={() => {
                    // The prompt is about to give way to the confirm: focus waits on the panel's
                    // heading while the removal runs, never on `body`.
                    headingRef.current?.focus({ preventScroll: true });
                    setNeedsStepUp(false);
                    doRemove();
                  }}
                />
                <div className="flex">
                  <Button variant="outline" onClick={close}>
                    {keepLabel}
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={close}>
                  {keepLabel}
                </Button>
                <Button
                  variant="danger"
                  loading={remove.isPending}
                  onClick={doRemove}
                >
                  {verb} {name}
                </Button>
              </div>
            )}
          </div>
        </div>
      </Expand>
    </li>
  );
}

function removeErrorText(err: unknown): string {
  if (err instanceof PortalApiError) {
    // The Worker's own sentence for its two guards ("This is your only way to sign in. …").
    if (
      (err.code === "last_link" || err.reason === "only_email") &&
      err.message
    )
      return err.message;
    if (err.status === 404)
      return "It's already gone. The list is up to date now.";
  }
  const copy = portalErrorCopy(err);
  return `${copy.title}. ${copy.description}`;
}
