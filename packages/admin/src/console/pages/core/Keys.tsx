/**
 * Core → Keys & secrets (T4; docs/design/ADMIN.md §6.7). Signing keys, write-only product
 * secrets and CI publishing credentials, one section each (SEC-1).
 *
 * - **Signing keys** (gold: this is where it means the most). The full lifecycle from A-4:
 *   Prepare (L1) → a staged row with a live countdown to its trust window → Activate (L1) → the
 *   old key retires → Revoke (L3, type the kid). Activating before the window is break-glass:
 *   behind a disclosure, L3, with the trust-cache risk stated (SET-1, OVR-3).
 * - **Secrets**: the union of what is stored (A-5) and what the configuration requires (SEC-2).
 * - **CI publishing**: the trusted publisher and static CI tokens.
 * - Edge mint and store credentials keep a section at the end until their own pages exist under
 *   Config and Distribution; each shows only while its service is on.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, KeyRound, Plus } from "lucide-react";
import {
  api,
  type ProductDetail,
  type SigningKeyDto,
  type SigningKeysResponse,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatSpan, fromSeconds } from "../../../lib/format.js";
import { ActionMenu } from "../../../ui/ActionMenu.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { KeyDisplay } from "../../../ui/KeyDisplay.js";
import { SignedGlyph } from "../../../ui/SignedBadge.js";
import { PageSkeleton, Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { EdgeMintRecipes } from "../../../views/EdgeMintRecipes.js";
import { OutletCredentials } from "../../../views/OutletCredentials.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection, SettingsTemplate } from "../../templates/Settings.js";
import { intentOf } from "./confirmGate.js";
import { CiPublishingSection } from "./KeysCi.js";
import { SecretsSection } from "./KeysSecrets.js";

export function fetchSigningKeys(slug: string): Promise<SigningKeysResponse> {
  return api.productKeys(slug);
}

export function KeysPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  useLoadingAnnouncement("keys and secrets", product.isPending);
  const name = product.data?.name ?? slug;
  const header = (
    <PageHeader
      title="Keys & secrets"
      description={`Signing keys, write-only product secrets and CI publishing credentials for ${name}.`}
      refetching={product.isFetching && !product.isPending}
    />
  );
  if (product.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="keys and secrets" />
      </div>
    );
  }
  if (product.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={product.error}
          onRetry={() => void product.refetch()}
        />
      </div>
    );
  }
  const p = product.data;
  const configOn = p.services?.config?.enabled ?? false;
  const distributionOn = p.services?.distribution?.enabled ?? false;
  const elsewhere = configOn || distributionOn;
  return (
    <SettingsTemplate
      header={header}
      sections={[
        { id: "keys-signing", title: "Signing keys" },
        { id: "keys-secrets", title: "Secrets" },
        { id: "keys-ci", title: "CI publishing" },
        ...(elsewhere
          ? [{ id: "keys-services", title: "Edge mint and store credentials" }]
          : []),
      ]}
    >
      <SigningKeysSection slug={slug} product={p} />
      <SecretsSection slug={slug} product={p} />
      <CiPublishingSection slug={slug} />
      {elsewhere ? (
        <section
          id="keys-services"
          tabIndex={-1}
          aria-labelledby="keys-services-heading"
          className="scroll-mt-20 space-y-4 outline-hidden"
        >
          <div className="space-y-1">
            <h2
              id="keys-services-heading"
              className="text-base font-bold text-fg-strong"
            >
              Edge mint and store credentials
            </h2>
            <p className="text-sm text-fg-muted">
              {configOn && distributionOn
                ? "Edge-mint approvals are a Config decision; store credentials are how Distribution reaches each store."
                : configOn
                  ? "Edge-mint approvals are a Config decision: a recipe mints only once approved as it stands."
                  : "Store credentials are how Distribution reaches each store on this product's behalf."}
            </p>
          </div>
          {configOn ? <EdgeMintRecipes slug={slug} /> : null}
          {distributionOn ? <OutletCredentials slug={slug} /> : null}
        </section>
      ) : null}
    </SettingsTemplate>
  );
}

// ── Signing keys ───────────────────────────────────────────────────────────────────────────────

/** Server time now, in seconds: the server's clock at fetch plus local elapsed time. */
function useServerNow(
  data: SigningKeysResponse | undefined,
  fetchedAt: number,
): number {
  const [tick, setTick] = React.useState(() => Date.now());
  const waiting =
    data?.keys.some(
      (k) =>
        k.status === "staged" &&
        k.activateAfter !== null &&
        k.activateAfter > data.now + (tick - fetchedAt) / 1000,
    ) ?? false;
  React.useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  if (!data) return Math.floor(tick / 1000);
  return data.now + Math.max(0, (tick - fetchedAt) / 1000);
}

type KeyAction = "activate" | "breakGlass" | "retire" | "revoke";

function SigningKeysSection({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const keys = useQuery(
    { queryKey: qk.keys(slug), queryFn: () => fetchSigningKeys(slug) },
    queryClient,
  );
  const now = useServerNow(keys.data, keys.dataUpdatedAt || Date.now());
  const [prepare, setPrepare] = React.useState(false);
  const [action, setAction] = React.useState<{
    kind: KeyAction;
    key: SigningKeyDto;
  } | null>(null);
  const jwks =
    typeof window !== "undefined" && product.jwksUrl
      ? new URL(product.jwksUrl, window.location.origin).toString()
      : product.jwksUrl;
  const releaseOn = product.services?.release?.enabled ?? false;

  return (
    <SettingsSection
      id="keys-signing"
      title="Signing keys"
      description="The active key signs every document this product hands a client."
      source={<SignedGlyph size={12} />}
      actions={
        <Button
          size="sm"
          iconStart={<Plus aria-hidden />}
          onClick={() => setPrepare(true)}
        >
          Prepare signing key
        </Button>
      }
    >
      <div className="px-5 py-4">
        {keys.isPending ? (
          <div className="space-y-2" aria-label="signing keys">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : keys.isError ? (
          <ErrorState
            compact
            error={keys.error}
            onRetry={() => void keys.refetch()}
          />
        ) : keys.data.keys.length === 0 ? (
          <EmptyState
            kind="first-run"
            headingLevel={3}
            title="No signing key"
            description="Without an active key this product can sign nothing. Prepare one, then activate it."
          />
        ) : (
          <ul className="divide-y divide-border" aria-label="Signing keys">
            {keys.data.keys.map((k) => (
              <SigningKeyRow
                key={k.kid}
                k={k}
                now={now}
                onAction={(kind) => setAction({ kind, key: k })}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2 px-5 py-4 text-sm">
        {jwks ? (
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-fg-muted">JWKS</span>
            <code className="break-all font-mono text-xs text-fg-strong">
              {jwks}
            </code>
            <CopyButton value={jwks} label="Copy the JWKS URL" />
          </p>
        ) : null}
        {releaseOn ? (
          <p className="text-fg-muted">
            App release records are signed by your CI release key, and content
            keys are delegated per pack.{" "}
            <Link
              to={r.contentKeys(slug)}
              className="inline-flex items-center gap-1 text-accent-fg underline-offset-4 hover:underline"
            >
              Content keys
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={prepare}
        onOpenChange={setPrepare}
        intent={intentOf("signing.prepare")}
        title="Prepare a signing key?"
        consequences={[
          "A new Ed25519 key is created as staged and published for trust discovery.",
          "Nothing is signed with it until you activate it.",
          "It can be activated once clients have had the trust window to refresh.",
        ]}
        confirmLabel="Prepare signing key"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          const res = await mutate("rotateProductKey", slug);
          toast.success(`Signing key ${res.kid} prepared`, {
            description:
              "It is staged; activate it once its trust window ends.",
          });
        }}
      />
      <KeyActionDialog
        slug={slug}
        action={action}
        onClose={() => setAction(null)}
      />
    </SettingsSection>
  );
}

const KEY_STATUS_TEXT: Record<string, string> = {
  active: "Active",
  staged: "Staged",
  retired: "Retired",
  revoked: "Revoked",
};

function SigningKeyRow({
  k,
  now,
  onAction,
}: {
  k: SigningKeyDto;
  now: number;
  onAction: (kind: KeyAction) => void;
}): React.ReactElement {
  const ready =
    k.status === "staged" &&
    (k.activateAfter === null || k.activateAfter <= now);
  const wait =
    k.status === "staged" && k.activateAfter !== null
      ? Math.max(0, k.activateAfter - now)
      : 0;
  const status = k.status as "active" | "staged" | "retired" | "revoked";
  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {k.status === "active" || k.status === "staged" ? (
            <SignedGlyph size={12} />
          ) : (
            <KeyRound aria-hidden className="size-3 text-fg-subtle" />
          )}
          <span className="font-mono text-sm font-bold text-fg-strong">
            {k.kid}
          </span>
          <StatusPill
            tone={
              status === "active"
                ? "success"
                : status === "staged"
                  ? "info"
                  : "neutral"
            }
          >
            {KEY_STATUS_TEXT[k.status] ?? k.status}
          </StatusPill>
          <span className="text-xs text-fg-muted">{k.alg}</span>
        </div>
        <p className="text-xs text-fg-muted">
          {status === "active" && k.activatedAt ? (
            <>
              Active since{" "}
              <Timestamp at={fromSeconds(k.activatedAt)} format="date" />
            </>
          ) : status === "staged" ? (
            ready ? (
              "Ready to activate: its trust window has ended."
            ) : (
              <span aria-live="off">
                Activatable in {formatSpan(Math.ceil(wait) * 1000)}, after
                clients refresh their trust.
              </span>
            )
          ) : status === "retired" && k.retiredAt ? (
            <>
              Retired <Timestamp at={fromSeconds(k.retiredAt)} format="date" />
            </>
          ) : status === "revoked" && k.revokedAt ? (
            <>
              Revoked <Timestamp at={fromSeconds(k.revokedAt)} format="date" />
            </>
          ) : (
            <>
              Created <Timestamp at={fromSeconds(k.createdAt)} format="date" />
            </>
          )}
        </p>
        <KeyDisplay label="Public key" kind="public" value={k.publicKey} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {status === "staged" ? (
          <>
            <Button
              size="sm"
              variant={ready ? "primary" : "outline"}
              disabledReason={
                ready ? undefined : "Its trust window has not ended yet."
              }
              onClick={() => onAction("activate")}
            >
              Activate…
            </Button>
            <ActionMenu
              label={`More actions for ${k.kid}`}
              items={[
                ...(ready
                  ? []
                  : [
                      {
                        label: "Activate now (break-glass)…",
                        onSelect: () => onAction("breakGlass"),
                        tone: "danger" as const,
                      },
                    ]),
                {
                  label: "Retire…",
                  onSelect: () => onAction("retire"),
                  tone: "danger" as const,
                },
              ]}
            />
          </>
        ) : status === "retired" ? (
          <ActionMenu
            label={`More actions for ${k.kid}`}
            items={[
              {
                label: "Revoke…",
                onSelect: () => onAction("revoke"),
                tone: "danger" as const,
              },
            ]}
          />
        ) : status === "active" ? (
          <ActionMenu
            label={`More actions for ${k.kid}`}
            items={[
              {
                label: "Retire…",
                onSelect: () => undefined,
                disabledReason:
                  "Retire is unavailable for the active key. Activate another key first.",
              },
            ]}
          />
        ) : null}
      </div>
    </li>
  );
}

function KeyActionDialog({
  slug,
  action,
  onClose,
}: {
  slug: string;
  action: { kind: KeyAction; key: SigningKeyDto } | null;
  onClose: () => void;
}): React.ReactElement {
  const kid = action?.key.kid ?? "";
  const kind = action?.kind;
  const common = {
    open: action !== null,
    onOpenChange: (o: boolean) => {
      if (!o) onClose();
    },
    describeError: (e: unknown) => errorCopy(e),
  };
  if (kind === "breakGlass") {
    return (
      <ConfirmDialog
        {...common}
        intent={intentOf("signing.breakGlassActivate")}
        title={`Activate ${kid} before its trust window ends?`}
        description="Break-glass activation is for a compromised active key. Clients that have not refreshed their trust reject documents signed with a key they do not know yet."
        consequences={[
          `${kid} signs everything from now on; the current key retires.`,
          "Clients still caching the old trust set fail to verify until they refresh (up to the trust cache window).",
        ]}
        typedConfirmation={{ value: kid, label: `Type ${kid} to confirm` }}
        confirmLabel="Activate now"
        onConfirm={async () => {
          await mutate("activateProductKey", slug, kid, true);
          toast.success(`Signing key ${kid} is active`);
        }}
      />
    );
  }
  if (kind === "retire") {
    return (
      <ConfirmDialog
        {...common}
        intent={intentOf("signing.retire")}
        title={`Retire ${kid}?`}
        consequences={[
          "The key can no longer be activated.",
          "It stays listed in the trust set until it ages out, so documents it signed keep verifying.",
        ]}
        confirmLabel="Retire"
        onConfirm={async () => {
          await mutate("retireProductKey", slug, kid);
          toast.success(`Signing key ${kid} retired`);
        }}
      />
    );
  }
  if (kind === "revoke") {
    return (
      <ConfirmDialog
        {...common}
        intent={intentOf("signing.revoke")}
        title={`Revoke ${kid}?`}
        description="Revoke a key you believe was compromised."
        consequences={[
          "The trust manifest lists the key as revoked: clients reject anything it signed.",
          "This cannot be undone.",
        ]}
        typedConfirmation={{ value: kid, label: `Type ${kid} to confirm` }}
        confirmLabel="Revoke"
        onConfirm={async () => {
          await mutate("revokeProductKey", slug, kid);
          toast.success(`Signing key ${kid} revoked`);
        }}
      />
    );
  }
  return (
    <ConfirmDialog
      {...common}
      intent={intentOf("signing.activate")}
      title={`Activate ${kid}?`}
      consequences={[
        `${kid} signs every document from now on.`,
        "The current active key retires; documents it signed keep verifying.",
      ]}
      confirmLabel="Activate"
      onConfirm={async () => {
        await mutate("activateProductKey", slug, kid);
        toast.success(`Signing key ${kid} is active`);
      }}
    >
      {action && action.key.activateAfter ? (
        <Callout tone="signed">
          Clients have had the trust window to pick this key up from the trust
          manifest.
        </Callout>
      ) : null}
    </ConfirmDialog>
  );
}
