import * as React from "react";
import { Clock, Info, Package, Plus } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { Input } from "../../../ui/Input.js";
import { CONTROL_INPUT } from "../../../ui/inputBase.js";
import { OneTimeSecretDialog } from "../../../ui/OneTimeSecretPanel.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import { cn } from "../../../lib/cn.js";
import { t } from "../../../lib/copy.js";
import type {
  PortalLegacyToken,
  PortalPersonalToken,
  PortalPersonalTokens,
  PortalReadableFeed,
} from "../../api.js";
import {
  useMintPersonalToken,
  useMintRegistryToken,
  usePersonalTokens,
  useRevokePersonalToken,
  useRevokeRegistryToken,
} from "../../data.js";
import { isStepUpRequired, portalErrorCopy } from "../../errors.js";
import {
  ecosystemLabel,
  feedSnippets,
  formatDate,
  TOKEN_ENV,
  tokenExpiry,
} from "../../model/packageAccess.js";
import { SectionCard } from "../product/Card.js";
import { SetupTabs } from "../product/SetupTabs.js";
import { ErrorPanel } from "../States.js";
import { StepUpInline } from "./StepUpInline.js";

/** Rows shown before "Show all". */
const ROWS_SHOWN = 5;
const DAY = 86_400;
/** A Godot editor URL token lasts this long: it sits in the editor's settings. */
const GODOT_URL_DAYS = 30;

/**
 * Does Account show Packages? Yes while it loads and whenever a feed, a token or a per-app token
 * exists; an account with none of them has nothing to set up, so the section and its nav entry
 * are left out.
 */
export function packagesVisible(d: PortalPersonalTokens | undefined): boolean {
  if (!d) return true;
  return (
    d.feeds.length > 0 ||
    d.tokens.some((x) => x.status !== "revoked") ||
    d.legacy.some((x) => x.status !== "revoked")
  );
}

/** Focus a control once the list has re-rendered (two frames: the refetch lands, then paints). */
function focusLater(find: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => find()?.focus({ preventScroll: false })),
  );
}

/**
 * Account → Packages (portal-11, F-33). A personal token is one read-only credential that installs
 * every package your licenses include, now and for apps you license later. Create asks for a
 * sign-in in the last 5 minutes (`StepUpInline`; the name survives it), shows the token once
 * (`OneTimeSecretDialog`) and lists it by name and last four characters; Revoke is one inline
 * confirmation and takes effect at once. The setup names the token by `PKEY_REGISTRY_TOKEN` and
 * never holds one. The Godot editor sends no credentials, so a private Godot feed gets its own
 * short-lived, per-app URL instead (a personal token is never put in a URL). Tokens made per app
 * before personal tokens are listed in their own group so they can be revoked.
 */
export function PackagesCard(): React.ReactElement | null {
  const q = usePersonalTokens();
  const [creating, setCreating] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const [minted, setMinted] = React.useState<{
    token: string;
    view: PortalPersonalToken;
  } | null>(null);
  const createRef = React.useRef<HTMLButtonElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const pendingFocus = React.useRef<number | null>(null);
  const data = q.data;
  const now = Math.floor(Date.now() / 1000);
  const listed = (data?.tokens ?? []).filter((x) => x.status !== "revoked");
  const live = listed.filter((x) => x.status === "active").length;
  const atLimit = data ? live >= data.limits.perAccount : false;
  const hasFeeds = (data?.feeds.length ?? 0) > 0;
  const shown = showAll ? listed : listed.slice(0, ROWS_SHOWN);
  const legacy = (data?.legacy ?? []).filter((x) => x.status !== "revoked");
  const ids = listed.map((x) => x.id).join(",");

  // After a revoke, the next row's Revoke (or the one before it, or the heading) takes focus.
  React.useEffect(() => {
    const at = pendingFocus.current;
    if (at === null) return;
    pendingFocus.current = null;
    const buttons = document.querySelectorAll<HTMLElement>(
      "#section-packages [data-personal-revoke]",
    );
    (buttons[Math.min(at, buttons.length - 1)] ?? headingRef.current)?.focus();
  }, [ids]);

  if (q.isSuccess && !packagesVisible(data)) return null;
  return (
    <SectionCard
      id="packages"
      title={
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex size-9 items-center justify-center rounded-lg bg-surface-sunken">
            <Package aria-hidden className="size-5 text-fg-strong" />
          </span>
          Packages
        </span>
      }
      subtitle="A personal token is one read-only credential that installs every package your licenses include."
    >
      {q.isPending ? (
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : q.isError || !data ? (
        <ErrorPanel
          error={q.error}
          account
          onRetry={() => void q.refetch()}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="font-semibold text-fg-strong outline-none"
              >
                Your personal tokens
              </h3>
              {hasFeeds ? (
                <Button
                  ref={createRef}
                  className="min-h-11 min-w-11"
                  iconStart={<Plus aria-hidden />}
                  onClick={() => setCreating(true)}
                  disabledReason={
                    atLimit
                      ? `At most ${data.limits.perAccount} personal tokens. Revoke one first`
                      : undefined
                  }
                >
                  Create personal token
                </Button>
              ) : null}
            </div>
            {listed.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No personal tokens yet. Create one for each computer or build
                server.
              </p>
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {shown.map((tok, i) => (
                  <TokenRow
                    key={tok.id}
                    id={tok.id}
                    label={tok.label}
                    mark={`pkeyp_…${tok.hint}`}
                    lastUsedAt={tok.lastUsedAt}
                    expiresAt={tok.expiresAt}
                    now={now}
                    active={tok.status === "active"}
                    personalRevoke
                    useRevoke={() => {
                      const r = useRevokePersonalToken();
                      return {
                        pending: r.isPending,
                        error: r.error,
                        reset: r.reset,
                        run: (done) => r.mutate(tok.id, { onSuccess: done }),
                      };
                    }}
                    onRevoked={() => {
                      pendingFocus.current = i;
                    }}
                  />
                ))}
              </ul>
            )}
            {listed.length > ROWS_SHOWN && !showAll ? (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => setShowAll(true)}
              >
                Show all {listed.length}
              </Button>
            ) : null}
          </div>
          {legacy.length > 0 ? (
            <PerAppTokens tokens={legacy} now={now} />
          ) : null}
          {hasFeeds ? (
            <Setup feeds={data.feeds} registryOrigin={data.registryOrigin} />
          ) : null}
        </div>
      )}
      {data ? (
        <CreateDialog
          open={creating}
          onOpenChange={(o) => {
            setCreating(o);
            if (!o) focusLater(() => createRef.current);
          }}
          title="Create a personal token"
          description="Reads every package your licenses include, now and for apps you license later. Read-only."
          limits={data.limits}
          useMint={() => {
            const m = useMintPersonalToken();
            return {
              pending: m.isPending,
              error: m.error,
              reset: m.reset,
              run: (label, days, cb) =>
                m.mutate(
                  { label, expiresInDays: days },
                  {
                    onSuccess: (res) => {
                      cb.onSuccess();
                      setCreating(false);
                      setMinted({ token: res.token, view: res.view });
                      // The plaintext now lives only in the one-time dialog.
                      m.reset();
                    },
                    onError: cb.onError,
                  },
                ),
            };
          }}
        />
      ) : null}
      {minted && data ? (
        <OneTimeSecretDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            const id = minted.view.id;
            setMinted(null);
            focusLater(
              () =>
                document.querySelector<HTMLElement>(
                  `[data-token-id="${id}"] button`,
                ) ?? createRef.current,
            );
          }}
          size="lg"
          title="Copy your personal token now"
          description="This is the only time you'll see it. If you lose it, revoke it and create another."
          label="Personal token"
          value={minted.token}
          hint={`“${minted.view.label}” · read-only · expires ${formatDate(minted.view.expiresAt)}`}
          onDone={() =>
            announce(`Personal token ${minted.view.label} is ready`)
          }
          acknowledgeLast
          details={
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-fg-strong">
                  Set it in your shell
                </p>
                <CodeBlock
                  code={`export ${TOKEN_ENV}=${minted.token}`}
                  language="sh"
                  filename="Terminal"
                  copy
                  className="[&_button]:min-h-11 [&_button]:min-w-11"
                />
              </div>
              <Setup
                feeds={data.feeds}
                registryOrigin={data.registryOrigin}
                bare
              />
            </div>
          }
        />
      ) : null}
    </SectionCard>
  );
}

/** What a mutation hook hands the shared dialog and row. */
interface Runner<A extends unknown[]> {
  pending: boolean;
  error: unknown;
  reset: () => void;
  run: (...a: A) => void;
}

function TokenRow({
  id,
  label,
  mark,
  app,
  lastUsedAt,
  expiresAt,
  now,
  active,
  personalRevoke,
  useRevoke,
  onRevoked,
}: {
  id: string;
  label: string;
  mark: string;
  app?: string;
  lastUsedAt: number | null;
  expiresAt: number;
  now: number;
  active: boolean;
  personalRevoke?: boolean;
  useRevoke: () => Runner<[() => void]>;
  onRevoked?: () => void;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const revoke = useRevoke();
  const headingRef = React.useRef<HTMLParagraphElement>(null);
  const openerRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (confirming) headingRef.current?.focus();
  }, [confirming]);
  const expiry = tokenExpiry(expiresAt, now);
  const keep = (): void => {
    setConfirming(false);
    revoke.reset();
    focusLater(() => openerRef.current);
  };
  return (
    <li className="py-3" data-token-id={id}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <p className="break-words font-medium text-fg-strong">{label}</p>
          <p className="text-sm text-fg-muted">
            <span className="font-mono">{mark}</span>
            {app ? ` · ${app}` : ""}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
            <span>
              {lastUsedAt
                ? `Last used ${formatRelative(lastUsedAt * 1000)}`
                : "Never used"}
            </span>
            <span aria-hidden>·</span>
            {expiry.soon ? (
              <span
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
                  active
                    ? "border-warning-border bg-warning-subtle text-warning"
                    : "border-border bg-surface-sunken text-fg-muted",
                )}
              >
                <Clock aria-hidden className="size-3.5" />
                {expiry.text}
              </span>
            ) : (
              <span>{expiry.text}</span>
            )}
          </p>
        </div>
        {!confirming ? (
          <Button
            ref={openerRef}
            variant="outline"
            className="min-h-11 min-w-11"
            onClick={() => setConfirming(true)}
            aria-label={`Revoke ${label}`}
            {...(personalRevoke ? { "data-personal-revoke": "" } : {})}
          >
            Revoke
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div
          className="mt-3 space-y-3 rounded-lg border border-danger-border bg-danger-subtle p-3"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              keep();
            }
          }}
        >
          <p
            ref={headingRef}
            tabIndex={-1}
            className="font-medium text-fg-strong outline-none"
          >
            Revoke {label}?
          </p>
          <p className="text-sm text-fg">
            Anything installing with it stops at once. Create a new one and set
            it again to reconnect.
          </p>
          {revoke.error ? (
            <p role="alert" className="text-sm text-danger">
              {portalErrorCopy(revoke.error, { account: true }).description}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="min-h-11" onClick={keep}>
              Keep it
            </Button>
            <Button
              variant="danger"
              className="min-h-11"
              loading={revoke.pending}
              onClick={() =>
                revoke.run(() => {
                  onRevoked?.();
                  toast.success(`${label} was revoked`);
                  setConfirming(false);
                })
              }
            >
              Revoke {label}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Tokens made for one app, before personal tokens (and Godot editor URLs). */
function PerAppTokens({
  tokens,
  now,
}: {
  tokens: readonly PortalLegacyToken[];
  now: number;
}): React.ReactElement {
  return (
    <div className="space-y-3 border-t border-border pt-5">
      <div className="space-y-1">
        <h3 className="font-semibold text-fg-strong">Per-app tokens</h3>
        <p className="text-sm text-fg-muted">
          Made for one app before personal tokens, or as a Godot editor URL.
          They work until they expire.
        </p>
      </div>
      <ul className="divide-y divide-border border-y border-border">
        {tokens.map((tok) => (
          <TokenRow
            key={`${tok.licenseId}-${tok.tokenId}`}
            id={tok.tokenId}
            label={tok.label}
            mark={`pkeyr_…${tok.hint}`}
            app={`${tok.productName}${tok.presentation === "url" ? " · Godot editor URL" : ""}`}
            lastUsedAt={tok.lastUsedAt}
            expiresAt={tok.expiresAt}
            now={now}
            active={tok.status === "active"}
            useRevoke={() => {
              const r = useRevokeRegistryToken();
              return {
                pending: r.isPending,
                error: r.error,
                reset: r.reset,
                run: (done) =>
                  r.mutate(
                    {
                      product: tok.product,
                      licenseId: tok.licenseId,
                      tokenId: tok.tokenId,
                    },
                    { onSuccess: done },
                  ),
              };
            }}
          />
        ))}
      </ul>
    </div>
  );
}

/** A choice of a few values: a segmented control up to four, else a select. */
function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
}): React.ReactElement {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <p id={id} className="text-sm font-medium text-fg-strong">
        {label}
      </p>
      {options.length <= 4 ? (
        <SegmentedControl
          aria-labelledby={id}
          options={options}
          value={value}
          onChange={onChange}
          className="[&_button]:min-h-11 [&_button]:min-w-11"
        />
      ) : (
        <select
          aria-labelledby={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={CONTROL_INPUT}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * Setup for the private feeds: choose the app, the package manager's ecosystem, then the client.
 * It names the token by its environment variable and never holds one. The Godot editor gets its
 * own per-app URL (a personal token never goes in a URL).
 */
function Setup({
  feeds,
  registryOrigin,
  bare = false,
}: {
  feeds: readonly PortalReadableFeed[];
  registryOrigin: string | null;
  /** Inside the shown-once dialog: no heading or footnote. */
  bare?: boolean;
}): React.ReactElement | null {
  const apps = [...new Map(feeds.map((f) => [f.product, f.productName]))];
  const [app, setApp] = React.useState(apps[0]?.[0] ?? "");
  const current = apps.some(([slug]) => slug === app)
    ? app
    : (apps[0]?.[0] ?? "");
  const mine = feeds.filter((f) => f.product === current);
  const [eco, setEco] = React.useState(mine[0]?.ecosystem ?? "");
  const feed = mine.find((f) => f.ecosystem === eco) ?? mine[0];
  if (!feed) return null;
  return (
    <div className={cn("space-y-4", bare ? "" : "border-t border-border pt-5")}>
      {bare ? (
        <p className="text-sm font-medium text-fg-strong">Set up</p>
      ) : (
        <h3 className="font-semibold text-fg-strong">Set up</h3>
      )}
      {apps.length > 1 ? (
        <Choice
          label="App"
          value={current}
          onChange={setApp}
          options={apps.map(([slug, name]) => ({ value: slug, label: name }))}
        />
      ) : null}
      {mine.length > 1 ? (
        <Choice
          label="Package type"
          value={feed.ecosystem}
          onChange={setEco}
          options={mine.map((f) => ({
            value: f.ecosystem,
            label: ecosystemLabel(f.ecosystem),
          }))}
        />
      ) : null}
      {feed.ecosystem === "godot" ? (
        <GodotUrl feed={feed} registryOrigin={registryOrigin} />
      ) : (
        <SetupTabs
          key={`${feed.product}-${feed.ecosystem}`}
          snippets={feedSnippets(feed, {
            product: feed.product,
            registryOrigin,
          }).map((s) => ({ ...s, feed: feed.ecosystem }))}
        />
      )}
      {bare ? null : (
        <p className="flex gap-2 text-sm text-fg-muted">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Set <code className="font-mono text-fg">{TOKEN_ENV}</code> to one of
            your personal tokens.
          </span>
        </p>
      )}
    </div>
  );
}

/** The Godot editor sends no credentials: its feed is a URL made for one app, short-lived. */
function GodotUrl({
  feed,
  registryOrigin,
}: {
  feed: PortalReadableFeed;
  registryOrigin: string | null;
}): React.ReactElement {
  const [creating, setCreating] = React.useState(false);
  const [minted, setMinted] = React.useState<{
    token: string;
    label: string;
  } | null>(null);
  const openerRef = React.useRef<HTMLButtonElement>(null);
  const limits = {
    minDays: 1,
    maxDays: 365,
    defaultDays: GODOT_URL_DAYS,
    labelMax: 64,
    perAccount: 25,
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">
        The Godot editor can't use personal tokens. It reads this feed through a
        URL made for {feed.productName} only, valid for {GODOT_URL_DAYS} days.
      </p>
      <Button
        ref={openerRef}
        variant="outline"
        className="min-h-11"
        iconStart={<Plus aria-hidden />}
        onClick={() => setCreating(true)}
      >
        Create Godot editor URL
      </Button>
      <CreateDialog
        open={creating}
        onOpenChange={(o) => {
          setCreating(o);
          if (!o) focusLater(() => openerRef.current);
        }}
        title="Create a Godot editor URL"
        description={`A read-only URL for ${feed.productName}'s Godot feed. It stops working if the license ends.`}
        limits={limits}
        fixedDays={GODOT_URL_DAYS}
        initialLabel="Godot editor"
        useMint={() => {
          const m = useMintRegistryToken(feed.product, feed.licenseId);
          return {
            pending: m.isPending,
            error: m.error,
            reset: m.reset,
            run: (label, days, cb) =>
              m.mutate(
                {
                  label,
                  ecosystem: "godot",
                  presentation: "url",
                  expiresInDays: days,
                },
                {
                  onSuccess: (res) => {
                    cb.onSuccess();
                    setCreating(false);
                    setMinted({ token: res.token, label });
                    m.reset();
                  },
                  onError: cb.onError,
                },
              ),
          };
        }}
      />
      {minted ? (
        <OneTimeSecretDialog
          open
          onOpenChange={(o) => {
            if (o) return;
            setMinted(null);
            focusLater(() => openerRef.current);
          }}
          size="lg"
          title="Copy your Godot editor URL now"
          description="This is the only time you'll see it. If you lose it, revoke it and create another."
          label="Token in the URL"
          value={minted.token}
          hint={`“${minted.label}” · read-only · Godot only`}
          onDone={() => announce(`Godot editor URL ${minted.label} is ready`)}
          acknowledgeLast
          details={
            <SetupTabs
              snippets={feedSnippets(
                feed,
                { product: feed.product, registryOrigin },
                minted.token,
              ).map((s) => ({ ...s, feed: "godot" }))}
            />
          }
        />
      ) : null}
    </div>
  );
}

const EXPIRY_CHOICES = [30, 90, 180, 365] as const;

function CreateDialog({
  open,
  onOpenChange,
  title,
  description,
  limits,
  fixedDays,
  initialLabel = "",
  useMint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  limits: PortalPersonalTokens["limits"];
  /** A lifetime the person does not choose (the Godot URL's). */
  fixedDays?: number;
  initialLabel?: string;
  useMint: () => Runner<
    [string, number, { onSuccess: () => void; onError: (e: unknown) => void }]
  >;
}): React.ReactElement {
  const mint = useMint();
  const [label, setLabel] = React.useState(initialLabel);
  const [expires, setExpires] = React.useState<number>(
    fixedDays ?? limits.defaultDays,
  );
  const [empty, setEmpty] = React.useState(false);
  const [askStepUp, setAskStepUp] = React.useState(false);
  const labelId = React.useId();
  const errId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (open) {
      setLabel(initialLabel);
      setExpires(fixedDays ?? limits.defaultDays);
      setEmpty(false);
      setAskStepUp(false);
      mint.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const trimmed = label.trim();
  const fieldError = empty
    ? "Give it a name."
    : mint.error && (mint.error as { status?: number }).status === 422
      ? `Give it a name of up to ${limits.labelMax} characters.`
      : null;
  const days = [
    ...new Set(
      [...EXPIRY_CHOICES, limits.defaultDays].filter(
        (d) => d >= limits.minDays && d <= limits.maxDays,
      ),
    ),
  ].sort((a, b) => a - b);
  const expiresOn = formatDate(Math.floor(Date.now() / 1000) + expires * DAY);
  const run = (): void => {
    if (!trimmed) {
      setEmpty(true);
      inputRef.current?.focus();
      return;
    }
    mint.run(trimmed, expires, {
      onSuccess: () => setAskStepUp(false),
      onError: (err) => {
        if (isStepUpRequired(err)) setAskStepUp(true);
      },
    });
  };
  const generic =
    mint.error && !fieldError && !isStepUpRequired(mint.error)
      ? portalErrorCopy(mint.error, { account: true }).description
      : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor={labelId}
              className="text-sm font-medium text-fg-strong"
            >
              Name
            </label>
            <Input
              ref={inputRef}
              id={labelId}
              value={label}
              maxLength={limits.labelMax}
              placeholder="Laptop, CI build server…"
              onValueChange={(v) => {
                setLabel(v);
                setEmpty(false);
              }}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? errId : undefined}
              autoComplete="off"
            />
            {fieldError ? (
              <p id={errId} className="text-sm text-danger">
                {fieldError}
              </p>
            ) : null}
          </div>
          {fixedDays === undefined ? (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-fg-strong">
                Expires after
              </span>
              <select
                value={String(expires)}
                onChange={(e) => setExpires(Number(e.target.value))}
                className={CONTROL_INPUT}
              >
                {days.map((d) => (
                  <option key={d} value={d}>
                    {d === 365 ? "1 year" : `${d} days`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="text-sm text-fg-muted">Expires {expiresOn}.</p>
          {askStepUp ? (
            <StepUpInline
              verb="create it"
              onConfirmed={() => {
                setAskStepUp(false);
                run();
              }}
              onCancel={() => setAskStepUp(false)}
            />
          ) : null}
          {generic ? (
            <p role="alert" className="text-sm text-danger">
              {generic}
            </p>
          ) : null}
        </DialogBody>
        {askStepUp ? null : (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => onOpenChange(false)}
            >
              {t("signin.cancel")}
            </Button>
            <Button type="submit" className="min-h-11" loading={mint.pending}>
              Create
            </Button>
          </DialogFooter>
        )}
      </form>
    </Dialog>
  );
}
