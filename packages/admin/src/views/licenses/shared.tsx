import * as React from "react";
import { Check, Copy } from "lucide-react";
import { api, type KeyStatus, type LicenseStatus } from "../../api.js";
import { Badge, Button } from "../../components/ui/index.js";
import { useResource } from "../../context.js";
import { channelOptions } from "../../lib/channels.js";

/**
 * Cross-cutting helpers for the licenses views: epoch formatting, status → badge mapping,
 * a release-channel multi-select (shared with the tier dialogs), and the one-time "reveal a
 * freshly-minted secret" panel. Kept presentational so both the list and detail views can share
 * them without prop drilling.
 */

/** Format an epoch-seconds timestamp as a locale date-time, or an em-dash when absent. */
export function formatStamp(epochSeconds?: number | null): string {
  if (!epochSeconds) return "—";
  try {
    return new Date(epochSeconds * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

/** Format an epoch-seconds timestamp as a locale date (no time), or an em-dash when absent. */
export function formatDate(epochSeconds?: number | null): string {
  if (!epochSeconds) return "—";
  try {
    return new Date(epochSeconds * 1000).toLocaleDateString();
  } catch {
    return "—";
  }
}

/** Convert a `<input type="date">` value (YYYY-MM-DD) to epoch seconds, or null when empty. */
export function dateInputToEpoch(value: string): number | null {
  if (!value.trim()) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Convert epoch seconds to a `<input type="date">` value (YYYY-MM-DD), or empty string. */
export function epochToDateInput(epochSeconds?: number | null): string {
  if (!epochSeconds) return "";
  try {
    return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

export function LicenseStatusBadge({
  status,
}: {
  status: LicenseStatus;
}): React.ReactElement {
  return (
    <Badge variant={status === "active" ? "success" : "default"}>
      {status}
    </Badge>
  );
}

export function KeyStatusBadge({
  status,
}: {
  status: KeyStatus;
}): React.ReactElement {
  return (
    <Badge variant={status === "active" ? "success" : "destructive"}>
      {status}
    </Badge>
  );
}

export function DeviceStatusBadge({
  status,
}: {
  status: string;
}): React.ReactElement {
  const variant =
    status === "active" || status === "authorized" ? "success" : "default";
  return <Badge variant={variant}>{status}</Badge>;
}

/**
 * The product's declared channel names, read from the Release truth store
 * (`api.releases(slug).channels`, which holds a row for `stable`, `beta` and every declared manual
 * channel). `channelOptions` filters the built-ins back out. An error or a 404 means there are
 * none: the picker still offers the canonical channels.
 */
export function useManualChannels(slug: string): string[] {
  // `async`, so a synchronous throw from the client is a rejection the cache records.
  const res = useResource(`releases:${slug}`, async () => api.releases(slug));
  return React.useMemo(
    () => (res.data?.channels ?? []).map((c) => c.channel),
    [res.data],
  );
}

/**
 * A small checkbox-grid multi-select for release channels (WIRE-CONTRACT-V3 §5.1). Controlled —
 * emits the next set on every toggle. Each option is an accessible labelled checkbox (named by
 * the channel alone; its hint is a description) so keyboard users can tab + space.
 *
 * The options come from `channelOptions(manual, held)`: the canonical channels, the product's
 * manual channels, and — only when `held` already has them — `staging` and `dev`, labelled.
 * A value the picker does not offer is KEPT on every change, never silently dropped.
 */
export function ChannelMultiSelect({
  value,
  onChange,
  manual = [],
  held = [],
  disabled,
  idPrefix = "channel",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** The product's declared channel names (`useManualChannels`). */
  manual?: readonly string[];
  /** The value the licence or tier had when the editor opened; empty for a create dialog. */
  held?: readonly string[];
  disabled?: boolean;
  idPrefix?: string;
}): React.ReactElement {
  const options = channelOptions(manual, held);
  const set = new Set(value);
  const toggle = (channel: string): void => {
    const next = new Set(set);
    if (next.has(channel)) next.delete(channel);
    else next.add(channel);
    const offered = options.map((o) => o.name);
    onChange([
      ...offered.filter((c) => next.has(c)),
      ...value.filter((c) => !offered.includes(c) && next.has(c)),
    ]);
  };
  return (
    <div
      role="group"
      aria-label="Release channels"
      className="flex flex-wrap gap-3"
    >
      {options.map(({ name: channel, hint }) => {
        const id = `${idPrefix}-${channel}`;
        const hintId = `${id}-hint`;
        return (
          <div
            key={channel}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10"
          >
            <input
              id={id}
              type="checkbox"
              className="size-4 accent-primary"
              checked={set.has(channel)}
              disabled={disabled}
              aria-describedby={hint ? hintId : undefined}
              onChange={() => toggle(channel)}
            />
            <label htmlFor={id} className="cursor-pointer">
              {channel}
            </label>
            {hint ? (
              <span id={hintId} className="text-xs text-muted-foreground">
                {hint}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Render a comma-separated channel list (or an em-dash when none). */
export function ChannelList({
  channels,
}: {
  channels: string[];
}): React.ReactElement {
  if (channels.length === 0)
    return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {channels.map((c) => (
        <Badge key={c} variant="outline">
          {c}
        </Badge>
      ))}
    </span>
  );
}

/**
 * A copy-to-clipboard button with an accessible name and a transient "copied" state. Falls back
 * to a manual select when the async clipboard API is unavailable (e.g. insecure context / tests).
 */
export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = (): void => {
    const done = (): void => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    };
    try {
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard?.writeText)
        void clipboard.writeText(value).then(done, done);
      else done();
    } catch {
      done();
    }
  };
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      aria-label={copied ? "Copied" : label}
      className={className}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * A one-time secret-reveal panel for a freshly-minted license key. The minted key is shown ONCE
 * and never returned again by the API, so we make the gravity of that clear and offer a copy
 * button. `onDismiss` clears the secret from React state (it should not be retained).
 */
export function OneTimeKeyPanel({
  value,
  title = "License key minted",
  description = "Copy it now — for security it is shown only once and cannot be retrieved again.",
  onDismiss,
}: {
  value: string;
  title?: string;
  description?: string;
  onDismiss?: () => void;
}): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-4"
    >
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <code
          aria-label="Minted license key"
          className="flex-1 select-all overflow-x-auto whitespace-nowrap rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        >
          {value}
        </code>
        <CopyButton value={value} label="Copy key" />
      </div>
      {onDismiss ? (
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

/** A labelled key/value pair for the detail header metadata grid. */
export function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}
