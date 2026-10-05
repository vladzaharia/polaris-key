import * as React from "react";
import { Tabs } from "radix-ui";
import { Clock, Info, Package, Plus } from "lucide-react";
import type { FeedSnippet } from "@polaris-key/manifest";
import { Button } from "../../../ui/Button.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { Input } from "../../../ui/Input.js";
import { CONTROL_INPUT } from "../../../ui/inputBase.js";
import { OneTimeSecretDialog } from "../../../ui/OneTimeSecretPanel.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import { cn } from "../../../lib/cn.js";
import {
  PortalApiError,
  type PortalPackageAccess,
  type PortalPackageFeed,
  type PortalRegistryToken,
} from "../../api.js";
import { useMintRegistryToken, useRevokeRegistryToken } from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import {
  ecosystemLabel,
  feedSnippets,
  formatDate,
  TOKEN_ENV,
  tokenExpiry,
} from "../../model/packageAccess.js";
import { ErrorPanel } from "../States.js";
import { SectionCard } from "./Card.js";

/**
 * Package access (PORTAL.md §4.20, §4.21; PX-11) for the selected licence, on F-21's portal API:
 * the private feeds with their URLs, this account's tokens for the licence (prefix and last four,
 * last used, expiry with the amber pill inside 14 days, Revoke), the copy-paste setup naming the
 * token by `PKEY_REGISTRY_TOKEN`, and **Create token**, which shows the new token once in a dialog
 * that Escape and the scrim cannot close until it is copied or acknowledged
 * (`OneTimeSecretDialog`). Rendered only when the product has a private feed (`available`).
 */
export function PackageAccessCard({
  product,
  productName,
  developer,
  tier,
  licenseId,
  access,
  loading,
  error,
  onRetry,
}: {
  product: string;
  productName: string;
  developer: string | null;
  tier: string | null;
  licenseId: string;
  access: PortalPackageAccess | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const [creating, setCreating] = React.useState(false);
  const [minted, setMinted] = React.useState<{
    token: string;
    view: PortalRegistryToken;
  } | null>(null);
  const now = Math.floor(Date.now() / 1000);
  const listed = (access?.tokens ?? []).filter((t) => t.status !== "revoked");
  const live = listed.filter((t) => t.status === "active").length;
  const atLimit = access ? live >= access.limits.perLicense : false;
  const feeds = access?.feeds ?? [];
  const who = developer ?? "the developer";
  const feedNames = feeds.map((f) => ecosystemLabel(f.ecosystem)).join(", ");

  return (
    <SectionCard
      id="package"
      title={
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex size-9 items-center justify-center rounded-lg bg-surface-sunken">
            <Package aria-hidden className="size-5 text-fg-strong" />
          </span>
          Package access
        </span>
      }
      subtitle={
        access
          ? `Your ${tier ? `${tier} ` : ""}license includes ${who}'s private ${feeds.length === 1 ? `${feedNames} feed` : `feeds (${feedNames})`}. Tokens are read-only and stop working if the license ends.`
          : undefined
      }
    >
      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : error || !access ? (
        <ErrorPanel
          error={error}
          onRetry={onRetry}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <div className="space-y-5">
          <FeedList feeds={feeds} registryOrigin={access.registryOrigin} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <h3 className="font-bold text-fg-strong">Your tokens</h3>
            <Button
              size="sm"
              iconStart={<Plus aria-hidden />}
              onClick={() => setCreating(true)}
              disabledReason={
                !access.licenseUsable
                  ? "Tokens work while your license is active"
                  : atLimit
                    ? `A license has at most ${access.limits.perLicense} tokens. Revoke one first`
                    : undefined
              }
            >
              Create token
            </Button>
          </div>
          {!access.licenseUsable ? (
            <p className="flex gap-2 text-sm text-fg-muted">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              This license isn't active, so its tokens don't work and no new one
              can be made.
            </p>
          ) : null}
          {listed.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No tokens yet. Create one for each computer or build server that
              installs {productName}'s packages.
            </p>
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {listed.map((t) => (
                <TokenRow
                  key={t.tokenId}
                  token={t}
                  now={now}
                  product={product}
                  licenseId={licenseId}
                />
              ))}
            </ul>
          )}
          <SetupTabs
            snippets={feeds.flatMap((f) =>
              feedSnippets(f, {
                product,
                registryOrigin: access.registryOrigin,
              }).map((s) => ({ ...s, feed: f.ecosystem })),
            )}
          />
          <p className="flex gap-2 text-sm text-fg-muted">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              Set <code className="font-mono text-fg">{TOKEN_ENV}</code> to one
              of your tokens. A token is shown once, when you create it.
            </span>
          </p>
        </div>
      )}
      {access ? (
        <CreateTokenDialog
          open={creating}
          onOpenChange={setCreating}
          product={product}
          licenseId={licenseId}
          access={access}
          onMinted={(m) => {
            setCreating(false);
            setMinted(m);
          }}
        />
      ) : null}
      {minted && access ? (
        <OneTimeSecretDialog
          open
          onOpenChange={(open) => {
            if (!open) setMinted(null);
          }}
          size="lg"
          title="Copy your token now"
          description="This is the only time you'll see it. If you lose it, revoke it and create another."
          label="Token"
          value={minted.token}
          hint={`“${minted.view.label}” · read-only · ${
            minted.view.ecosystems
              ? minted.view.ecosystems.map(ecosystemLabel).join(", ")
              : `every ${productName} feed`
          } · expires ${formatDate(minted.view.expiresAt)}`}
          onDone={() => announce(`Token ${minted.view.label} is ready`)}
          details={
            <SetupTabs
              snippets={feeds
                .filter(
                  (f) =>
                    !minted.view.ecosystems ||
                    minted.view.ecosystems.includes(f.ecosystem),
                )
                .flatMap((f) =>
                  feedSnippets(
                    f,
                    { product, registryOrigin: access.registryOrigin },
                    minted.token,
                  ).map((s) => ({ ...s, feed: f.ecosystem })),
                )}
            />
          }
        />
      ) : null}
    </SectionCard>
  );
}

function FeedList({
  feeds,
  registryOrigin,
}: {
  feeds: readonly PortalPackageFeed[];
  registryOrigin: string | null;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      {feeds.map((f) => {
        const url = f.baseUrl ?? registryOrigin;
        return (
          <div key={f.ecosystem} className="space-y-1">
            <p className="text-sm text-fg-muted">
              {feeds.length > 1
                ? `${ecosystemLabel(f.ecosystem)} feed`
                : "Feed"}
            </p>
            {url ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-sm text-fg-strong">
                  {url}
                </code>
                <CopyButton
                  value={url}
                  label={`Copy the ${ecosystemLabel(f.ecosystem)} feed URL`}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TokenRow({
  token,
  now,
  product,
  licenseId,
}: {
  token: PortalRegistryToken;
  now: number;
  product: string;
  licenseId: string;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const revoke = useRevokeRegistryToken(product, licenseId);
  const headingRef = React.useRef<HTMLParagraphElement>(null);
  React.useEffect(() => {
    if (confirming) headingRef.current?.focus();
  }, [confirming]);
  const expiry = tokenExpiry(token.expiresAt, now);
  const active = token.status === "active";
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold text-fg-strong">{token.label}</p>
          <p className="text-sm text-fg-muted">
            <span className="font-mono">pkeyr_…{token.hint}</span> ·{" "}
            {token.lastUsedAt
              ? `last used ${formatRelative(token.lastUsedAt * 1000)}`
              : "never used"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {expiry.soon ? (
            <span
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-bold",
                active
                  ? "border-warning-border bg-warning-subtle text-warning"
                  : "border-border bg-surface-sunken text-fg-muted",
              )}
            >
              <Clock aria-hidden className="size-3.5" />
              {expiry.text}
            </span>
          ) : (
            <span className="text-sm text-fg-muted">{expiry.text}</span>
          )}
          {active && !confirming ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(true)}
              aria-label={`Revoke ${token.label}`}
            >
              Revoke
            </Button>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <div className="mt-3 space-y-3 rounded-lg border border-danger-border bg-danger-subtle p-3">
          <p
            ref={headingRef}
            tabIndex={-1}
            className="font-bold text-fg-strong outline-none"
          >
            Revoke {token.label}?
          </p>
          <p className="text-sm text-fg">
            Anything installing with this token stops at once. You can create a
            new one any time.
          </p>
          {revoke.error ? (
            <p role="alert" className="text-sm text-danger">
              {portalErrorCopy(revoke.error).description}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={revoke.isPending}
              onClick={() =>
                revoke.mutate(token.tokenId, {
                  onSuccess: () => {
                    toast.success(`${token.label} was revoked`);
                    setConfirming(false);
                  },
                })
              }
            >
              Revoke {token.label}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

type TabSnippet = FeedSnippet & { feed: string };

/** The setup snippets as tabs (npm, pnpm, Yarn …), each a copyable code block. */
function SetupTabs({
  snippets,
}: {
  snippets: readonly TabSnippet[];
}): React.ReactElement | null {
  const multiFeed = new Set(snippets.map((s) => s.feed)).size > 1;
  const tabs = snippets.map((s, i) => ({
    key: `${s.feed}-${s.id}-${i}`,
    label: multiFeed ? `${ecosystemLabel(s.feed)}: ${s.clients}` : s.clients,
    snippet: s,
  }));
  const [current, setCurrent] = React.useState(tabs[0]?.key ?? "");
  if (tabs.length === 0) return null;
  return (
    <Tabs.Root
      value={tabs.some((t) => t.key === current) ? current : tabs[0]!.key}
      onValueChange={setCurrent}
      className="min-w-0 space-y-2"
    >
      <Tabs.List
        aria-label="Setup"
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((t) => (
          <Tabs.Trigger
            key={t.key}
            value={t.key}
            className="-mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted hover:text-fg-strong data-[state=active]:border-accent data-[state=active]:font-bold data-[state=active]:text-fg-strong"
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Content key={t.key} value={t.key} className="space-y-1">
          <p className="text-xs text-fg-muted">{t.snippet.title}</p>
          {t.snippet.warning ? (
            <p className="text-xs text-warning">{t.snippet.warning}</p>
          ) : null}
          <CodeBlock
            code={t.snippet.code}
            language={t.snippet.language}
            filename={t.snippet.filename}
            copy
          />
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

const EXPIRY_CHOICES = [30, 90, 180, 365] as const;

function CreateTokenDialog({
  open,
  onOpenChange,
  product,
  licenseId,
  access,
  onMinted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: string;
  licenseId: string;
  access: PortalPackageAccess;
  onMinted: (m: { token: string; view: PortalRegistryToken }) => void;
}): React.ReactElement {
  const mint = useMintRegistryToken(product, licenseId);
  const [label, setLabel] = React.useState("");
  const [feed, setFeed] = React.useState<string>("");
  const days = EXPIRY_CHOICES.filter(
    (d) => d >= access.limits.minDays && d <= access.limits.maxDays,
  );
  const [expires, setExpires] = React.useState<number>(
    access.limits.defaultDays,
  );
  const labelId = React.useId();
  const errId = React.useId();
  React.useEffect(() => {
    if (open) {
      setLabel("");
      setFeed(access.feeds.length === 1 ? access.feeds[0]!.ecosystem : "");
      setExpires(access.limits.defaultDays);
      mint.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const trimmed = label.trim();
  const fieldError =
    mint.error instanceof PortalApiError && mint.error.status === 422
      ? "Give the token a name of up to 64 characters."
      : null;
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!trimmed) return;
    const eco = feed || null;
    mint.mutate(
      {
        label: trimmed,
        ecosystem: eco,
        presentation: eco === "godot" ? "url" : "header",
        expiresInDays: expires,
      },
      {
        onSuccess: (res) => {
          onMinted({ token: res.token, view: res.view });
          // The plaintext now lives only in the one-time dialog: drop the mutation's copy.
          mint.reset();
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create a token"
      description="A read-only token for one computer or build server. It works while your license is active."
    >
      <form onSubmit={submit}>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor={labelId}
              className="text-sm font-bold text-fg-strong"
            >
              Name
            </label>
            <Input
              id={labelId}
              value={label}
              maxLength={64}
              placeholder="Laptop, CI build server…"
              onValueChange={setLabel}
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
          {access.feeds.length > 1 ? (
            <label className="block space-y-1.5">
              <span className="text-sm font-bold text-fg-strong">Feed</span>
              <select
                value={feed}
                onChange={(e) => setFeed(e.target.value)}
                className={CONTROL_INPUT}
              >
                <option value="">Every feed</option>
                {access.feeds.map((f) => (
                  <option key={f.ecosystem} value={f.ecosystem}>
                    {ecosystemLabel(f.ecosystem)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block space-y-1.5">
            <span className="text-sm font-bold text-fg-strong">
              Expires after
            </span>
            <select
              value={String(expires)}
              onChange={(e) => setExpires(Number(e.target.value))}
              className={CONTROL_INPUT}
            >
              {[...new Set([...days, access.limits.defaultDays])]
                .sort((a, b) => a - b)
                .map((d) => (
                  <option key={d} value={d}>
                    {d === 365 ? "1 year" : `${d} days`}
                  </option>
                ))}
            </select>
          </label>
          {mint.error && !fieldError ? (
            <p role="alert" className="text-sm text-danger">
              {portalErrorCopy(mint.error).description}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            loading={mint.isPending}
            disabledReason={trimmed ? undefined : "Give the token a name"}
          >
            Create token
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
