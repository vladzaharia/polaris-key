/**
 * The App sign-in page's read-mostly cards (I-29): Status, Sign-in methods, Product connection,
 * Terms and Presentation. The saved cards (License keys, Customer portal) live in the page.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lock, RefreshCw } from "lucide-react";
import {
  api,
  type EdgeMintIdentity,
  type PlatformConnectionsPage,
  type ProductDetail,
} from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { IdChip } from "../../../../ui/IdChip.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { EntityLink } from "../../../components/EntityLink.js";
import { useResyncFlow } from "../../../components/ResyncDialog.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { ServiceOffConfirmation } from "../../core/components/ServiceOffConfirmation.js";
import {
  patchFor,
  type OffConfirmation,
} from "../../core/components/serviceFeatures.js";
import { releaseSourceOf } from "../../../../lib/products.js";
import { fetchPlatformConnections } from "../../platform/pages/platformConnections.js";
import { parseGroupMap } from "../model/groups.js";

const linkClass = "text-accent-fg underline underline-offset-2";

/** A fact that is always so: a word and a lock, never a switch. */
function Always({ children }: { children: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
      <Lock className="size-4" aria-hidden />
      {children}
    </span>
  );
}

/** Status: the Sign-in feature switch. Off asks first (it names Cloud Sync, which needs it). */
export function StatusSection({
  slug,
  name,
  enabled,
}: {
  slug: string;
  name: string;
  enabled: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const gate = useWriteGate("signin", slug);
  const [busy, setBusy] = React.useState(false);
  const [off, setOff] = React.useState<OffConfirmation | null>(null);

  const change = (on: boolean) => ({
    feature: "sign-in" as const,
    label: "Sign-in",
    on,
    requested: ["identity" as const],
    body: patchFor(["identity"], on),
  });
  const commit = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      const next = await mutate("updateServices", slug, change(on).body);
      queryClient.setQueryData(qk.services(slug), next);
      void queryClient.invalidateQueries({ queryKey: qk.product(slug) });
      toast.success(`Sign-in turned ${on ? "on" : "off"}`);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (on: boolean): Promise<void> => {
    if (on) {
      await commit(true).catch(() => undefined);
      return;
    }
    setBusy(true);
    try {
      const dryRun = await mutate("servicesDryRun", slug, change(false).body);
      setOff({ change: change(false), dryRun });
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="status" title="Status">
      <SettingsRow label="Sign-in" htmlFor="app-sign-in-status">
        <Switch
          id="app-sign-in-status"
          checked={enabled}
          disabled={busy || !gate.allowed}
          aria-label={`Sign-in for ${name}`}
          onCheckedChange={(on) => void toggle(on)}
        />
      </SettingsRow>
      <ServiceOffConfirmation
        confirmation={off}
        onOpenChange={(open) => {
          if (!open) setOff(null);
        }}
        onConfirm={async () => {
          if (off) await commit(false);
        }}
      />
    </SettingsSection>
  );
}

/** What the platform offers on every card: the built-in providers and the SSO connections. */
export function MethodsSection({ slug }: { slug: string }): React.ReactElement {
  const settings = useQuery({
    queryKey: qk.signInSettings(slug),
    queryFn: () => api.signInSettings(slug).then((res) => res.settings),
  });
  const q = useQuery<PlatformConnectionsPage>({
    queryKey: qk.platformConnections(),
    queryFn: fetchPlatformConnections,
    retry: false,
  });
  const page = q.data;
  const customers = (page?.connections ?? []).filter(
    (c) => c.status === "active" && c.audience !== "operators",
  );
  const domains = customers.reduce(
    (n, c) => n + c.domains.filter((d) => d.verified).length,
    0,
  );
  const names = customers.map((c) => c.label).join(", ");
  const sso =
    customers.length === 0
      ? "No connection signs customers in"
      : `${names} · ${domains} ${domains === 1 ? "domain" : "domains"}`;

  return (
    <SettingsSection id="methods" title="Sign-in methods">
      <SettingsRow label="Email code and passkeys">
        <Always>Always on</Always>
      </SettingsRow>
      {(["apple", "google", "steam"] as const).map((kind) => {
        const built = page?.builtIns.find((b) => b.kind === kind);
        return (
          <SettingsRow key={kind} label={built?.label ?? kind}>
            {built ? (
              <StatusPill tone={built.configured ? "success" : "neutral"}>
                {built.configured ? "On" : "Not set up"}
              </StatusPill>
            ) : (
              <span className="text-sm text-fg-muted">
                {q.isPending ? "Loading" : "Unavailable"}
              </span>
            )}
          </SettingsRow>
        );
      })}
      <SettingsRow label="Single sign-on" help={q.isError ? undefined : sso}>
        <Link to={r.platformConnections()} className={linkClass}>
          Connections
          <ArrowRight className="ml-1 inline size-4" aria-hidden />
        </Link>
      </SettingsRow>
      {settings.data?.appReview48Warning ? (
        <div className="px-5 py-4">
          <Callout tone="warning" title="App Review guideline 4.8">
            iPhone and iPad devices use this app, and it offers no native Sign
            in with Apple. An iOS app that offers another sign-in must also
            offer Sign in with Apple, or App Review may reject it.
          </Callout>
        </div>
      ) : null}
    </SettingsSection>
  );
}

/** The product's own sign-in provider: read from the manifest, changed by a resync. */
export function ProductConnectionSection({
  slug,
  name,
  product,
  identity,
  oidcDefault,
}: {
  slug: string;
  name: string;
  product: ProductDetail | undefined;
  identity: EdgeMintIdentity;
  oidcDefault: boolean;
}): React.ReactElement {
  const resync = useResyncFlow();
  const custom = identity.provider === "custom";
  const groups = parseGroupMap(identity.groupRoleMapJson);
  const linked = product ? releaseSourceOf(product) === "github" : false;
  return (
    <>
      <SettingsSection
        id="product-connection"
        title="Product connection"
        actions={
          <Button
            variant="outline"
            size="sm"
            iconStart={<RefreshCw aria-hidden />}
            disabled={!product || !linked}
            disabledReason={
              product && !linked
                ? "This product is not linked to a GitHub repo."
                : undefined
            }
            onClick={() => resync.start({ slug, name })}
          >
            Resync from repo…
          </Button>
        }
      >
        <SettingsRow
          label={custom ? `${name} accounts` : "Polaris Locker accounts"}
          help={custom ? "Custom provider" : "The platform provider"}
        >
          <ProductLogo
            name={name}
            presentation={product?.presentation}
            size={32}
          />
        </SettingsRow>
        <div className="px-5 py-4">
          <DescriptionList
            columns={2}
            items={[
              {
                term: "Issuer",
                detail: identity.issuer ? (
                  <IdChip
                    value={identity.issuer}
                    noun="issuer"
                    head={28}
                    tail={12}
                  />
                ) : (
                  <span className="text-fg-muted">
                    {custom ? "Not set" : "The platform issuer"}
                  </span>
                ),
              },
              {
                term: "Client ID",
                detail: identity.clientId ? (
                  <IdChip
                    value={identity.clientId}
                    noun="client ID"
                    head={16}
                    tail={6}
                  />
                ) : (
                  <span className="text-fg-muted">
                    {custom ? "Not set" : "The platform client"}
                  </span>
                ),
              },
            ]}
          />
          <GroupsTable slug={slug} groups={groups} />
          <p className="mt-3 text-sm text-fg-muted">
            {oidcDefault
              ? "A signed-in account in no mapped group gets the auto-issue default tier."
              : "A signed-in account in no mapped group is refused (not entitled)."}{" "}
            Auto-issue is set by the{" "}
            <a
              className={linkClass}
              href={`${docsUrl("autoIssue")}#auto-issue`}
              target="_blank"
              rel="noreferrer"
            >
              <code className="font-mono text-xs">autoIssue</code> block
              <span className="sr-only"> (opens a new tab)</span>
            </a>{" "}
            in <code className="font-mono text-xs">.pkey/product</code>.
          </p>
        </div>
      </SettingsSection>
      {resync.panel}
      {resync.dialog}
    </>
  );
}

function GroupsTable({
  slug,
  groups,
}: {
  slug: string;
  groups: ReturnType<typeof parseGroupMap>;
}): React.ReactElement {
  if (groups === "invalid")
    return (
      <p className="mt-4 text-sm text-danger">
        The stored group map is not valid JSON. Fix the{" "}
        <code className="font-mono text-xs">groupRoleMap</code> in{" "}
        <code className="font-mono text-xs">.pkey/product</code>, then resync.
      </p>
    );
  if (groups.length === 0)
    return <p className="mt-4 text-sm text-fg-muted">No groups are mapped.</p>;
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Groups and tiers</caption>
        <thead className="text-xs text-fg-muted">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-4 font-medium">
              Group
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Role
            </th>
            <th scope="col" className="py-2 font-medium">
              Tier
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {groups.map((g) => (
            <tr key={g.group}>
              <td className="py-2 pr-4 font-mono text-xs text-fg-strong">
                {g.group}
              </td>
              <td className="py-2 pr-4">
                {g.role ?? <span className="text-fg-muted">None</span>}
              </td>
              <td className="py-2">
                {g.tier ? (
                  <EntityLink slug={slug} kind="tier" id={g.tier} />
                ) : (
                  <span className="text-fg-muted">Entitlement only</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Terms: Polaris Key's are always on; the product's version comes from the manifest. */
export function TermsSection({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  const area = "identity.signIn";
  const q = useQuery({
    queryKey: qk.productSettings(slug, area),
    queryFn: () => api.productSettings(slug, area),
  });
  const value = q.data?.settings.find((s) => s.key === "identity.terms")
    ?.value as { version?: string; url?: string } | null | undefined;
  return (
    <SettingsSection id="terms" title="Terms">
      <SettingsRow
        label="Polaris Key’s Terms and Privacy Policy"
        help="Once per account"
      >
        <Always>Always</Always>
      </SettingsRow>
      <SettingsRow
        label={
          <>
            {name}’s terms
            {value?.version ? (
              <span className="ml-2 text-xs font-normal text-fg-muted">
                {value.version}
              </span>
            ) : null}
          </>
        }
        help={
          value?.version
            ? "Players accept again when the version changes."
            : "None. Set identity.terms in .pkey/product."
        }
      >
        {value?.url ? (
          <a
            className={linkClass}
            href={value.url}
            target="_blank"
            rel="noreferrer"
          >
            View
            <span className="sr-only"> (opens a new tab)</span>
          </a>
        ) : (
          <span className="text-sm text-fg-muted">Not set</span>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

/** Presentation is Core's: read-only here. */
export function PresentationSection({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail | undefined;
}): React.ReactElement {
  const accent = product?.presentation?.accent ?? null;
  return (
    <SettingsSection
      id="presentation"
      title="Presentation"
      actions={
        <Link to={r.presentation(slug)} className={`${linkClass} text-sm`}>
          Edit in Settings
          <ArrowRight className="ml-1 inline size-4" aria-hidden />
        </Link>
      }
    >
      <SettingsRow label={product?.name ?? slug} help={slug}>
        <span className="flex items-center gap-3 text-sm">
          {accent ? (
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className="size-4 rounded-full border border-border"
                style={{ background: accent }}
              />
              Accent
              <span className="font-mono text-xs uppercase">{accent}</span>
            </span>
          ) : null}
          <ProductLogo
            name={product?.name ?? slug}
            presentation={product?.presentation}
            size={40}
          />
        </span>
      </SettingsRow>
    </SettingsSection>
  );
}
