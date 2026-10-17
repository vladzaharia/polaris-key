import * as React from "react";
import { Clock, Info, Package, Plus } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { Input } from "../../../ui/Input.js";
import { CONTROL_INPUT } from "../../../ui/inputBase.js";
import { OneTimeSecretDialog } from "../../../ui/OneTimeSecretPanel.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import { cn } from "../../../lib/cn.js";
import { t } from "../../../lib/copy.js";
import type {
  PortalPersonalToken,
  PortalPersonalTokens,
  PortalReadableFeed,
} from "../../api.js";
import {
  useMintPersonalToken,
  usePersonalTokens,
  useRevokePersonalToken,
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

/**
 * Account → Packages (portal-11, F-33): the person's `pkeyp_` tokens and one setup for every
 * private feed their licenses reach. A token is the account's, read-only, one per computer or
 * build server; it works while a license that reaches a package is active. Create asks for a
 * sign-in in the last 5 minutes (`StepUpInline`, the form survives it), shows the token once
 * (`OneTimeSecretDialog`) and lists it by name and last four characters. Revoke is one inline
 * confirmation and takes effect at once.
 */
export function PackagesCard(): React.ReactElement {
  const q = usePersonalTokens();
  const [creating, setCreating] = React.useState(false);
  const [minted, setMinted] = React.useState<{
    token: string;
    view: PortalPersonalToken;
  } | null>(null);
  const data = q.data;
  const now = Math.floor(Date.now() / 1000);
  const listed = (data?.tokens ?? []).filter((x) => x.status !== "revoked");
  const live = listed.filter((x) => x.status === "active").length;
  const atLimit = data ? live >= data.limits.perAccount : false;
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
      subtitle="One read-only token installs every package your licenses include."
    >
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError || !data ? (
        <ErrorPanel
          error={q.error}
          onRetry={() => void q.refetch()}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-fg-strong">Your tokens</h3>
            <Button
              size="sm"
              iconStart={<Plus aria-hidden />}
              onClick={() => setCreating(true)}
              disabledReason={
                atLimit
                  ? `At most ${data.limits.perAccount} tokens. Revoke one first`
                  : undefined
              }
            >
              Create token
            </Button>
          </div>
          {listed.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No tokens yet. Create one for each computer or build server.
            </p>
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {listed.map((tok) => (
                <TokenRow key={tok.id} token={tok} now={now} />
              ))}
            </ul>
          )}
          <Setup feeds={data.feeds} registryOrigin={data.registryOrigin} />
        </div>
      )}
      {data ? (
        <CreateTokenDialog
          open={creating}
          onOpenChange={setCreating}
          limits={data.limits}
          onMinted={(m) => {
            setCreating(false);
            setMinted(m);
          }}
        />
      ) : null}
      {minted && data ? (
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
          hint={`“${minted.view.label}” · read-only · expires ${formatDate(minted.view.expiresAt)}`}
          onDone={() => announce(`Token ${minted.view.label} is ready`)}
          details={
            <SetupFor
              feeds={data.feeds}
              registryOrigin={data.registryOrigin}
              token={minted.token}
            />
          }
        />
      ) : null}
    </SectionCard>
  );
}

/** Setup for the private feeds, one product at a time (one token serves them all). */
function Setup({
  feeds,
  registryOrigin,
}: {
  feeds: readonly PortalReadableFeed[];
  registryOrigin: string | null;
}): React.ReactElement {
  if (feeds.length === 0)
    return (
      <p className="flex gap-2 text-sm text-fg-muted">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        None of your active licenses include a private package feed.
      </p>
    );
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="font-semibold text-fg-strong">Set up</h3>
      <SetupFor feeds={feeds} registryOrigin={registryOrigin} />
      <p className="flex gap-2 text-sm text-fg-muted">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Set <code className="font-mono text-fg">{TOKEN_ENV}</code> to one of
          your tokens.
        </span>
      </p>
    </div>
  );
}

function SetupFor({
  feeds,
  registryOrigin,
  token,
}: {
  feeds: readonly PortalReadableFeed[];
  registryOrigin: string | null;
  token?: string;
}): React.ReactElement | null {
  const products = [...new Map(feeds.map((f) => [f.product, f.productName]))];
  const [product, setProduct] = React.useState(products[0]?.[0] ?? "");
  const current = products.some(([slug]) => slug === product)
    ? product
    : (products[0]?.[0] ?? "");
  const id = React.useId();
  if (products.length === 0) return null;
  const mine = feeds.filter((f) => f.product === current);
  return (
    <div className="space-y-3">
      {products.length > 1 ? (
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm font-medium text-fg-strong">
            Product
          </label>
          <select
            id={id}
            value={current}
            onChange={(e) => setProduct(e.target.value)}
            className={CONTROL_INPUT}
          >
            {products.map(([slug, name]) => (
              <option key={slug} value={slug}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <SetupTabs
        key={current}
        snippets={mine.flatMap((f) =>
          feedSnippets(f, { product: current, registryOrigin }, token).map(
            (s) => ({ ...s, feed: f.ecosystem }),
          ),
        )}
      />
    </div>
  );
}

function TokenRow({
  token,
  now,
}: {
  token: PortalPersonalToken;
  now: number;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const revoke = useRevokePersonalToken();
  const headingRef = React.useRef<HTMLParagraphElement>(null);
  const openerRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (confirming) headingRef.current?.focus();
  }, [confirming]);
  const expiry = tokenExpiry(token.expiresAt, now);
  const active = token.status === "active";
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-medium text-fg-strong">
            {token.label}
          </p>
          <p className="text-sm text-fg-muted">
            <span className="font-mono">pkeyp_…{token.hint}</span> ·{" "}
            {token.lastUsedAt
              ? `last used ${formatRelative(token.lastUsedAt * 1000)}`
              : "never used"}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            <span className="text-sm text-fg-muted">{expiry.text}</span>
          )}
          {active && !confirming ? (
            <Button
              ref={openerRef}
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
            className="font-medium text-fg-strong outline-none"
          >
            Revoke {token.label}?
          </p>
          <p className="text-sm text-fg">
            Anything installing with this token stops at once.
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
              onClick={() => {
                setConfirming(false);
                revoke.reset();
                requestAnimationFrame(() => openerRef.current?.focus());
              }}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={revoke.isPending}
              onClick={() =>
                revoke.mutate(token.id, {
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

const EXPIRY_CHOICES = [30, 90, 180, 365] as const;

function CreateTokenDialog({
  open,
  onOpenChange,
  limits,
  onMinted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  limits: PortalPersonalTokens["limits"];
  onMinted: (m: { token: string; view: PortalPersonalToken }) => void;
}): React.ReactElement {
  const mint = useMintPersonalToken();
  const [label, setLabel] = React.useState("");
  const [expires, setExpires] = React.useState<number>(limits.defaultDays);
  const [askStepUp, setAskStepUp] = React.useState(false);
  const labelId = React.useId();
  const errId = React.useId();
  React.useEffect(() => {
    if (open) {
      setLabel("");
      setExpires(limits.defaultDays);
      setAskStepUp(false);
      mint.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const trimmed = label.trim();
  const fieldError =
    mint.error && (mint.error as { status?: number }).status === 422
      ? `Give the token a name of up to ${limits.labelMax} characters.`
      : null;
  const days = [
    ...new Set(
      [...EXPIRY_CHOICES, limits.defaultDays].filter(
        (d) => d >= limits.minDays && d <= limits.maxDays,
      ),
    ),
  ].sort((a, b) => a - b);
  const run = (): void => {
    if (!trimmed) return;
    mint.mutate(
      { label: trimmed, expiresInDays: expires },
      {
        onSuccess: (res) => {
          setAskStepUp(false);
          onMinted({ token: res.token, view: res.view });
          // The plaintext now lives only in the one-time dialog: drop the mutation's copy.
          mint.reset();
        },
        onError: (err) => {
          if (isStepUpRequired(err)) setAskStepUp(true);
        },
      },
    );
  };
  const generic =
    mint.error && !fieldError && !isStepUpRequired(mint.error)
      ? portalErrorCopy(mint.error).description
      : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create a token"
      description="Read-only. Use one per computer or build server."
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
              id={labelId}
              value={label}
              maxLength={limits.labelMax}
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
          {askStepUp ? (
            <StepUpInline
              verb="create a token"
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
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("signin.cancel")}
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
