import * as React from "react";
import { RadioGroup } from "radix-ui";
import { RefreshCw } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { AuthNotice, AuthTitle } from "../../../ui/auth/index.js";
import { portalErrorCopy } from "../../errors.js";
import { cn } from "../../../lib/cn.js";
import { t } from "../../../lib/copy.js";
import { Avatar } from "../Avatar.js";
import {
  AUTH_LINK_CLASS,
  AUTH_METHOD_CLASS,
  AUTH_PRIMARY_CLASS,
} from "../../../ui/auth/parts.js";
import { firstName } from "../../model/signInRequest.js";

/**
 * The pieces the app card's steps share (PX-14a; SIGN-IN.md §3.6 to §3.9): the person row, a
 * neutral radio group, a neutral callout and the entries meter. Ink states throughout: the
 * selected row and the focus ring are neutral, coral is identity only (D9a), and nothing here
 * ever uses amber or the danger colour for a limit.
 */

/** The step's one primary: the neutral ink button the card uses everywhere. */
export const PRIMARY_CLASS = AUTH_PRIMARY_CLASS;

/** The request is gone (or never existed), or its client was switched off: say so and return to the library. */
export function RequestGone({
  title = t("signin.request.goneTitle"),
  body = t("signin.request.gone"),
}: {
  title?: string;
  body?: string;
}): React.ReactElement {
  return (
    <>
      <div className="space-y-2">
        <AuthTitle>{title}</AuthTitle>
        <p className="text-fg-muted">{body}</p>
      </div>
      <Button asChild variant="neutral" size="xl" className={PRIMARY_CLASS}>
        <a href="/">{t("signin.return.library")}</a>
      </Button>
    </>
  );
}

/** The request could not be reached: the error's own copy and a retry. */
export function Unreachable({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const copy = portalErrorCopy(error, { account: true });
  return (
    <>
      <div className="space-y-2">
        <AuthTitle>{copy.title}</AuthTitle>
        <p className="text-fg-muted">{copy.description}</p>
      </div>
      <Button
        variant="neutral"
        size="xl"
        className={PRIMARY_CLASS}
        iconStart={<RefreshCw aria-hidden />}
        onClick={onRetry}
      >
        {t("signin.retry")}
      </Button>
    </>
  );
}

/** Person row: avatar, name, email and **Not you?**, which ends this account's part of the flow. */
export function PersonRow({
  name,
  email,
  picture,
  onNotYou,
}: {
  name: string | null;
  email: string | null;
  picture: string | null;
  /** Absent where the step's own primary does the same (the account is replaced there). */
  onNotYou?: () => void;
}): React.ReactElement {
  return (
    <div
      data-person-row
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-sunken px-4 py-3"
    >
      <Avatar name={name} email={email} picture={picture} size={40} />
      <div className="min-w-[12ch] flex-[1_1_12ch]">
        <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
          {name ?? email}
        </p>
        {name && email ? (
          <p className="text-sm/5 text-fg-muted [overflow-wrap:anywhere]">
            {email}
          </p>
        ) : null}
      </div>
      {onNotYou ? (
        <button
          type="button"
          onClick={onNotYou}
          className={cn(AUTH_LINK_CLASS, "shrink-0")}
        >
          {t("signin.notYou")}
        </button>
      ) : null}
    </div>
  );
}

/** A neutral callout (UI-KITS DL6): a limit the person can fix, never a warning or an error. */
export function NeutralCallout({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      data-callout
      className="flex items-start gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-fg"
    >
      <span
        aria-hidden
        className="mt-0.5 shrink-0 text-fg-muted [&_svg]:size-5"
      >
        {icon}
      </span>
      <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  );
}

export interface ChoiceOption {
  value: string;
  /** The row's content: lines and tags, no controls. */
  children: React.ReactNode;
  /** Names the row for a screen reader (the title and its facts). */
  label: string;
}

/**
 * One radio group of rows, nothing selected unless `value` says so (a choice is never silent).
 * The error sits under the group, linked with `aria-describedby`; the primary stays enabled.
 */
export const ChoiceGroup = React.forwardRef<
  HTMLDivElement,
  {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: readonly ChoiceOption[];
    error?: string | null;
    id: string;
  }
>(function ChoiceGroup({ label, value, onChange, options, error, id }, ref) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <RadioGroup.Root
        ref={ref}
        id={id}
        value={value}
        onValueChange={onChange}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="space-y-2"
      >
        {options.map((o) => {
          const checked = value === o.value;
          return (
            <RadioGroup.Item
              key={o.value}
              value={o.value}
              aria-label={o.label}
              data-checked={checked ? "" : undefined}
              className={cn(
                "@container/choice relative flex min-h-14 w-full items-start gap-3 overflow-hidden rounded-lg border px-4 py-3 text-start max-[22.5rem]:px-3",
                "before:absolute before:inset-y-0 before:start-0 before:w-[3px]",
                "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2",
                checked
                  ? "border-border-strong bg-hover before:bg-state-context-edge forced-colors:border-[Highlight] forced-colors:outline forced-colors:outline-2 forced-colors:outline-[Highlight] forced-colors:before:bg-[Highlight]"
                  : "border-border-strong bg-surface-raised hover:bg-hover",
              )}
            >
              <span
                aria-hidden
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full outline-2 -outline-offset-2 outline-fg-muted data-[on]:outline-fg-strong"
                data-on={checked ? "" : undefined}
              >
                {checked ? (
                  <svg
                    viewBox="0 0 10 10"
                    className="size-2.5 text-fg-strong"
                    aria-hidden
                  >
                    <circle cx="5" cy="5" r="5" fill="currentColor" />
                  </svg>
                ) : null}
              </span>
              <span className="min-w-0 flex-1 space-y-1">{o.children}</span>
            </RadioGroup.Item>
          );
        })}
      </RadioGroup.Root>
      {error ? (
        <p id={errorId} role="alert" className="text-sm/5 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});

/** A neutral pill: a tier, a tag. Text, never colour alone. */
export function Pill({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="inline-flex items-center rounded-full border border-border-strong px-2 py-0.5 text-xs/4 font-medium text-fg">
      {children}
    </span>
  );
}

/**
 * A seat or entry meter in ink: `used` segments in muted, the one `next` (if any) in strong ink,
 * the rest outlined. Never amber, never red: a full meter is a limit, not an error (auth-10).
 */
export function InkMeter({
  used,
  limit,
  next = false,
  label,
}: {
  used: number;
  limit: number;
  /** Mark the segment after the used ones (this entry, this seat). */
  next?: boolean;
  label: string;
}): React.ReactElement | null {
  if (!(limit > 0)) return null;
  const segments = Math.min(limit, 10);
  const share = (n: number): number => Math.round((n / limit) * segments);
  const filled = Math.min(segments, share(Math.min(used, limit)));
  return (
    <div
      role="img"
      aria-label={label}
      className="flex gap-1 forced-color-adjust-none"
      data-ink-meter
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full forced-colors:border forced-colors:border-[CanvasText]",
            i < filled
              ? "bg-fg-muted forced-colors:bg-[CanvasText]"
              : next && i === filled
                ? "bg-fg-strong forced-colors:bg-[Highlight]"
                : "bg-surface-sunken ring-1 ring-inset ring-border-strong forced-colors:bg-[Canvas]",
          )}
        />
      ))}
    </div>
  );
}

/**
 * A device row's content, shared by sign-in's Replace a device and the portal's Free a device:
 * the glyph, the name (16, weight 400), its tags, and the meta line (14).
 */
export function DeviceChoiceBody({
  glyph,
  name,
  tags,
  meta,
}: {
  glyph: React.ReactNode;
  name: React.ReactNode;
  tags?: React.ReactNode;
  meta: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="flex items-start gap-2">
      {/* The glyph goes when the row is under 14 rem (320 px with text at 200 %): it would leave
          the name and the meta line a few letters wide. */}
      <span className="mt-0.5 shrink-0 text-fg-muted @max-[14rem]/choice:hidden [&_svg]:size-4">
        {glyph}
      </span>
      <span className="min-w-0 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-fg-strong [overflow-wrap:anywhere]">
            {name}
          </span>
          {tags}
        </span>
        <span className="block text-sm/5 text-fg-muted">{meta}</span>
      </span>
    </span>
  );
}

/** The consent steps' top: who is signing in, and "Continue to <App> as <first name>?". */
export function ConsentHead({
  person,
  app,
  onNotYou,
}: {
  person: {
    displayName: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  app: string;
  onNotYou: () => void;
}): React.ReactElement {
  return (
    <>
      <PersonRow
        name={person.displayName}
        email={person.email}
        picture={person.avatarUrl}
        onNotYou={onNotYou}
      />
      <AuthTitle>
        {t("signin.consent.title", {
          app,
          name: firstName(person.displayName, person.email),
        })}
      </AuthTitle>
    </>
  );
}

/** The consent steps' pair: **Continue to <App>** and **Don't allow**, the same width and height. */
export function ConsentActions({
  app,
  busy,
  onContinue,
  onDeny,
}: {
  app: string;
  busy: "continue" | "deny" | null;
  onContinue: () => void;
  onDeny: () => void;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <Button
        variant="neutral"
        size="xl"
        className={PRIMARY_CLASS}
        loading={busy === "continue"}
        aria-disabled={busy === "deny" || undefined}
        onClick={onContinue}
      >
        {t("signin.consent.continue", { app })}
      </Button>
      <Button
        variant="outline"
        size="xl"
        className={AUTH_METHOD_CLASS}
        loading={busy === "deny"}
        aria-disabled={busy === "continue" || undefined}
        onClick={onDeny}
      >
        {t("signin.consent.deny")}
      </Button>
    </div>
  );
}

/** What closes a consent step: the terms check, a refusal, then Continue and Don't allow. */
export function ConsentFoot({
  terms,
  error,
  ...actions
}: {
  terms: React.ReactNode;
  error: string | null;
  app: string;
  busy: "continue" | "deny" | null;
  onContinue: () => void;
  onDeny: () => void;
}): React.ReactElement {
  return (
    <>
      {terms}
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      <ConsentActions {...actions} />
    </>
  );
}
