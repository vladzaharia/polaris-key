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
import { t, tParts } from "../../../lib/copy.js";
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
import { AccountCard as SectionCard } from "./AccountCard.js";
import { SetupTabs, type TabSnippet } from "../product/SetupTabs.js";
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
  // Personal tokens read every feed but Godot's: the editor sends no credentials, so a Godot feed
  // has its own per-app URL (`GodotUrl`).
  const personalFeeds = (data?.feeds ?? []).filter(
    (f) => f.ecosystem !== "godot",
  );
  const hasPersonal = personalFeeds.length > 0;
  const godotOnly = (data?.feeds.length ?? 0) > 0 && !hasPersonal;
  const shown = showAll ? listed : listed.slice(0, ROWS_SHOWN);
  const legacy = (data?.legacy ?? []).filter((x) => x.status !== "revoked");
  const ids = listed.map((x) => x.id).join(",");
  const legacyIds = legacy.map((x) => x.tokenId).join(",");
  const pendingLegacyFocus = React.useRef<number | null>(null);

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
  // The same for a per-app revoke: the next per-app Revoke, else the group's heading, else the
  // personal group's (the group goes away with its last token).
  React.useEffect(() => {
    const at = pendingLegacyFocus.current;
    if (at === null) return;
    pendingLegacyFocus.current = null;
    const buttons = document.querySelectorAll<HTMLElement>(
      "#section-packages [data-perapp-revoke]",
    );
    (
      buttons[Math.min(at, buttons.length - 1)] ??
      document.getElementById("per-app-heading") ??
      headingRef.current
    )?.focus();
  }, [legacyIds]);

  if (q.isSuccess && !packagesVisible(data)) return null;
  return (
    <SectionCard
      id="packages"
      title={
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex size-9 items-center justify-center rounded-lg bg-surface-sunken">
            <Package aria-hidden className="size-5 text-fg-strong" />
          </span>
          {t("locker.account.packages")}
        </span>
      }
      subtitle={t("locker.packages.subtitle")}
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
          {hasPersonal || listed.length > 0 ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3
                  ref={headingRef}
                  tabIndex={-1}
                  className="font-semibold text-fg-strong outline-none"
                >
                  {t("locker.packages.tokensTitle")}
                </h3>
                {hasPersonal ? (
                  <Button
                    ref={createRef}
                    className="min-h-11 min-w-11"
                    iconStart={<Plus aria-hidden />}
                    onClick={() => setCreating(true)}
                    disabledReason={
                      atLimit
                        ? t("locker.packages.atLimit", {
                            count: data.limits.perAccount,
                          })
                        : undefined
                    }
                  >
                    {t("locker.packages.create")}
                  </Button>
                ) : null}
              </div>
              {listed.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  {t("locker.packages.none")}
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
                      group="personal"
                      reconnect={t("locker.packages.reconnectPersonal")}
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
                  onClick={() => {
                    setShowAll(true);
                    // The first row that was hidden takes focus: Show all itself goes away.
                    focusLater(
                      () =>
                        document.querySelectorAll<HTMLElement>(
                          "#section-packages [data-personal-revoke]",
                        )[ROWS_SHOWN],
                    );
                  }}
                >
                  {t("locker.packages.showAll", { count: listed.length })}
                </Button>
              ) : null}
            </div>
          ) : null}
          {legacy.length > 0 ? (
            <PerAppTokens
              tokens={legacy}
              now={now}
              onRevoked={(i) => {
                pendingLegacyFocus.current = i;
              }}
            />
          ) : null}
          {data.feeds.length > 0 ? (
            <Setup
              feeds={data.feeds}
              registryOrigin={data.registryOrigin}
              godotOnly={godotOnly}
            />
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
          title={t("locker.packages.createTitle")}
          description={t("locker.packages.createBody")}
          limits={data.limits}
          describeError={(err) =>
            (err as { status?: number }).status === 409
              ? t("locker.packages.mostTokens", {
                  count: data.limits.perAccount,
                })
              : null
          }
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
                  `[data-token-id="${id}"]`,
                ) ?? createRef.current,
            );
          }}
          size="lg"
          title={t("locker.packages.copyTitle")}
          description={t("locker.packages.onceNote")}
          label={t("locker.packages.tokenLabel")}
          value={minted.token}
          hint={t("locker.packages.mintedHint", {
            name: minted.view.label,
            date: formatDate(minted.view.expiresAt),
          })}
          onDone={() =>
            announce(t("locker.packages.ready", { name: minted.view.label }))
          }
          acknowledgeLast
          details={
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-fg-strong">
                  {t("locker.packages.setShell")}
                </p>
                <CodeBlock
                  code={`export ${TOKEN_ENV}=${minted.token}`}
                  language="sh"
                  filename={t("locker.packages.terminal")}
                  copy
                  className="[&_button]:min-h-11 [&_button]:min-w-11"
                />
              </div>
              {hasPersonal ? (
                <Setup
                  feeds={personalFeeds}
                  registryOrigin={data.registryOrigin}
                  bare
                />
              ) : null}
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
  group,
  reconnect,
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
  /** Which list the row is in: the focus after a revoke finds its Revoke buttons by it. */
  group: "personal" | "perapp";
  /** The one line that says how to get back, after the revoke. */
  reconnect: string;
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
    <li className="py-3 outline-none" data-token-id={id} tabIndex={-1}>
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
                ? t("locker.packages.lastUsed", {
                    when: formatRelative(lastUsedAt * 1000),
                  })
                : t("locker.packages.neverUsed")}
              <span aria-hidden className="ms-2">
                ·
              </span>
            </span>
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
            aria-label={t("locker.packages.revokeName", { name: label })}
            {...(group === "personal"
              ? { "data-personal-revoke": "" }
              : { "data-perapp-revoke": "" })}
          >
            {t("locker.packages.revoke")}
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
            {t("locker.packages.revokeAsk", { name: label })}
          </p>
          <p className="text-sm text-fg">
            {t("locker.packages.revokeNote")} {reconnect}
          </p>
          {revoke.error ? (
            <p role="alert" className="text-sm text-danger">
              {portalErrorCopy(revoke.error).line}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="min-h-11" onClick={keep}>
              {t("locker.methods.keepIt")}
            </Button>
            <Button
              variant="danger"
              className="min-h-11"
              loading={revoke.pending}
              onClick={() =>
                revoke.run(() => {
                  onRevoked?.();
                  toast.success(t("locker.packages.revoked", { name: label }));
                  setConfirming(false);
                })
              }
            >
              {t("locker.packages.revokeName", { name: label })}
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
  onRevoked,
}: {
  tokens: readonly PortalLegacyToken[];
  now: number;
  onRevoked: (index: number) => void;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3
          id="per-app-heading"
          tabIndex={-1}
          className="font-semibold text-fg-strong outline-none"
        >
          {t("locker.packages.perAppTitle")}
        </h3>
        <p className="text-sm text-fg-muted">
          {t("locker.packages.perAppBody")}
        </p>
      </div>
      <ul className="divide-y divide-border border-y border-border">
        {tokens.map((tok, i) => (
          <TokenRow
            key={`${tok.licenseId}-${tok.tokenId}`}
            id={tok.tokenId}
            label={tok.label}
            mark={`pkeyr_…${tok.hint}`}
            app={`${tok.productName}${tok.presentation === "url" ? ` · ${t("locker.packages.godotUrl")}` : ""}`}
            lastUsedAt={tok.lastUsedAt}
            expiresAt={tok.expiresAt}
            now={now}
            active={tok.status === "active"}
            group="perapp"
            reconnect={
              tok.presentation === "url"
                ? t("locker.packages.reconnectGodot")
                : t("locker.packages.reconnectUse")
            }
            onRevoked={() => onRevoked(i)}
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
  godotOnly = false,
}: {
  feeds: readonly PortalReadableFeed[];
  registryOrigin: string | null;
  /** Inside the shown-once dialog: no heading or footnote. */
  bare?: boolean;
  /** Every feed is Godot's: its URL button is the section's primary action. */
  godotOnly?: boolean;
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
    <div className="space-y-4">
      {bare ? (
        <p className="text-sm font-medium text-fg-strong">
          {t("locker.packages.setUp")}
        </p>
      ) : (
        <h3 className="font-semibold text-fg-strong">
          {t("locker.packages.setUp")}
        </h3>
      )}
      {apps.length > 1 ? (
        <Choice
          label={t("locker.packages.app")}
          value={current}
          onChange={setApp}
          options={apps.map(([slug, name]) => ({ value: slug, label: name }))}
        />
      ) : null}
      {mine.length > 1 ? (
        <Choice
          label={t("locker.packages.type")}
          value={feed.ecosystem}
          onChange={setEco}
          options={mine.map((f) => ({
            value: f.ecosystem,
            label: ecosystemLabel(f.ecosystem),
          }))}
        />
      ) : null}
      {feed.ecosystem === "godot" ? (
        <GodotUrl
          feed={feed}
          registryOrigin={registryOrigin}
          primary={godotOnly}
        />
      ) : (
        <SetupTabs
          key={`${feed.product}-${feed.ecosystem}`}
          snippets={feedSnippets(feed, {
            product: feed.product,
            registryOrigin,
          }).map((s) => ({ ...s, feed: feed.ecosystem }))}
        />
      )}
      {bare || feed.ecosystem === "godot" ? null : (
        <p className="flex gap-2 text-sm text-fg-muted">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {tParts("locker.packages.setEnv", ["name"]).map((part, i) =>
              typeof part === "string" ? (
                part
              ) : (
                <code
                  key={i}
                  className="font-mono text-fg [overflow-wrap:anywhere]"
                >
                  {TOKEN_ENV}
                </code>
              ),
            )}
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
  primary,
}: {
  feed: PortalReadableFeed;
  registryOrigin: string | null;
  /** Every feed is Godot's: this is the section's one primary action. */
  primary: boolean;
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
  const steps = minted
    ? godotPasteSteps(
        feedSnippets(
          feed,
          { product: feed.product, registryOrigin },
          minted.token,
        ).map((s) => ({ ...s, feed: "godot" })),
      )
    : [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">
        {t("locker.packages.godotNote", {
          product: feed.productName,
          days: GODOT_URL_DAYS,
        })}
      </p>
      <Button
        ref={openerRef}
        variant={primary ? "primary" : "outline"}
        className="min-h-11"
        iconStart={<Plus aria-hidden />}
        onClick={() => setCreating(true)}
      >
        {t("locker.packages.createGodot")}
      </Button>
      <CreateDialog
        open={creating}
        onOpenChange={(o) => {
          setCreating(o);
          if (!o) focusLater(() => openerRef.current);
        }}
        title={t("locker.packages.createGodotTitle")}
        description={t("locker.packages.createGodotBody", {
          product: feed.productName,
        })}
        limits={limits}
        fixedDays={GODOT_URL_DAYS}
        initialLabel={t("locker.packages.godotLabel")}
        describeError={(err) => {
          const e = err as { status?: number; reason?: string };
          if (e.status === 409)
            return t("locker.packages.errPerApp", {
              product: feed.productName,
            });
          if (e.status === 403)
            return t("locker.packages.errInactive", {
              product: feed.productName,
            });
          if (e.status === 422 && e.reason === undefined)
            return t("locker.packages.errGodot");
          return null;
        }}
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
      {minted && steps[0] ? (
        <OneTimeSecretDialog
          open
          onOpenChange={(o) => {
            if (o) return;
            setMinted(null);
            focusLater(() => openerRef.current);
          }}
          size="lg"
          title={t("locker.packages.godotCopyTitle")}
          description={t("locker.packages.onceNote")}
          label={t("locker.packages.godotValueLabel")}
          copyLabel={t("locker.packages.godotCopy")}
          value={steps[0].code}
          hint={t("locker.packages.godotHint", { name: minted.label })}
          onDone={() =>
            announce(t("locker.packages.godotReady", { name: minted.label }))
          }
          acknowledgeLast
          details={<SetupTabs snippets={steps} />}
        />
      ) : null}
    </div>
  );
}

/**
 * Where to paste each Godot URL. The generator's caption for Godot 4.4 to 4.6 reads "4.6 and
 * earlier": say the same range as its tab.
 */
function godotPasteSteps(snippets: readonly TabSnippet[]): TabSnippet[] {
  return snippets.map((s) =>
    s.id === "editor-4.6"
      ? {
          ...s,
          title: t("locker.packages.godotStep"),
        }
      : s,
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
  describeError,
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
  /** Copy for a refusal this dialog knows (the limit, an inactive license); else the generic. */
  describeError?: (err: unknown) => string | null;
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
    ? t("locker.packages.needName")
    : mint.error &&
        (mint.error as { status?: number; reason?: string }).status === 422 &&
        (mint.error as { reason?: string }).reason !== undefined
      ? t("locker.packages.nameMax", { max: limits.labelMax })
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
      ? (describeError?.(mint.error) ?? portalErrorCopy(mint.error).line)
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
              {t("locker.packages.name")}
            </label>
            <Input
              ref={inputRef}
              id={labelId}
              value={label}
              maxLength={limits.labelMax}
              className="max-sm:min-h-11"
              placeholder={t("locker.packages.namePlaceholder")}
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
                {t("locker.packages.expiresAfter")}
              </span>
              <select
                value={String(expires)}
                onChange={(e) => setExpires(Number(e.target.value))}
                className={cn(CONTROL_INPUT, "max-sm:min-h-11")}
              >
                {days.map((d) => (
                  <option key={d} value={d}>
                    {d === 365
                      ? t("locker.packages.oneYear")
                      : t("locker.packages.days", { count: d })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="text-sm text-fg-muted">
            {t("locker.packages.expiresOn", { date: expiresOn })}
          </p>
          {askStepUp ? (
            <StepUpInline
              verb={t("locker.verb.createIt")}
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
              {t("locker.packages.createConfirm")}
            </Button>
          </DialogFooter>
        )}
      </form>
    </Dialog>
  );
}
