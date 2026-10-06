/**
 * Identity → Sign-in (ADMIN.md §2.3, T3 read-only): the OIDC provider this product's customers
 * sign in with, the group → tier map that decides who a sign-in licenses, and where all of it is
 * authored. Product OIDC is manifest-fed (`.pkey/product`'s `oidc` block), so the page reads and
 * points; its one action is a resync.
 *
 * Fixes IDN-2: the provider, issuer and client come from `config/mint` → `identity`, the same read
 * Edge mint shows. Fixes IDN-1: resync is the console's one resync flow (UX-78), an L1 confirm
 * showing the dry run's plan and a focused result panel, the same verb ("Resync") as everywhere.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import {
  api,
  type EdgeMintIdentity,
  type ProductDetail,
} from "../../../api.js";
import { triggerVariant } from "../../../lib/actions.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { Button } from "../../../ui/Button.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { IdChip } from "../../../ui/IdChip.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { useResyncFlow } from "../../components/ResyncDialog.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import { releaseSourceOf } from "../../../lib/products.js";

/** Resync needs a linked repo: `release/resync.ts` refuses (422) any other release source. */
const isRepoLinked = (product: Pick<ProductDetail, "releaseSource">): boolean =>
  releaseSourceOf(product) === "github";

export interface GroupGrant {
  group: string;
  role: string | null;
  tier: string | null;
}

/**
 * `oidc_config.group_role_map_json`: `{ "<group>": { "role": "…", "tier": "<tierId>" } }`
 * (docs: services/identity/oidc). A bare string value is read as a role. `null` when the JSON is
 * absent; an empty list when it parses to no groups; `"invalid"` when it does not parse.
 */
export function parseGroupMap(json: string | null): GroupGrant[] | "invalid" {
  if (json === null || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "invalid";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return "invalid";
  return Object.entries(parsed as Record<string, unknown>).map(
    ([group, grant]) => {
      if (typeof grant === "string") return { group, role: grant, tier: null };
      const g = (grant ?? {}) as { role?: unknown; tier?: unknown };
      return {
        group,
        role: typeof g.role === "string" ? g.role : null,
        tier: typeof g.tier === "string" ? g.tier : null,
      };
    },
  );
}

const MANIFEST_EXAMPLE = `"oidc": {
  "provider": "custom",
  "issuer": "https://id.example.com",
  "clientId": "polaris-key",
  "groupRoleMap": {
    "studio-pro": { "role": "member", "tier": "pro" }
  }
}`;

export function SignInPage({ slug }: { slug: string }): React.ReactElement {
  const mint = useQuery(
    { queryKey: qk.mint(slug), queryFn: () => api.edgeMintRecipes(slug) },
    queryClient,
  );
  const product = useProduct(slug);
  const linked = product.data ? isRepoLinked(product.data) : false;
  // The console's one resync flow (UX-78): the dry run's plan, then a focused result panel.
  const resync = useResyncFlow();

  const header = (
    <PageHeader
      title="Sign-in"
      description={
        <>
          Authored in <code className="font-mono text-xs">.pkey/product</code>;
          a resync applies a change.
        </>
      }
      primaryAction={
        <Button
          variant={triggerVariant("repo.resync")}
          iconStart={<RefreshCw aria-hidden />}
          disabledReason={
            product.data && !linked
              ? "This product is not linked to a GitHub repo."
              : undefined
          }
          disabled={!product.data}
          onClick={() =>
            resync.start({ slug, name: product.data?.name ?? slug })
          }
        >
          Resync from repo…
        </Button>
      }
      refetching={mint.isFetching && !mint.isPending}
    />
  );

  let body: React.ReactNode;
  if (mint.isPending) {
    body = <PageSkeleton template="record" label="sign-in settings" />;
  } else if (mint.isError) {
    body = (
      <ErrorState error={mint.error} onRetry={() => void mint.refetch()} />
    );
  } else if (
    // Identity off is the services' answer, not an absent identity block: a product with
    // Identity on and nothing configured rides the platform OIDC client.
    product.data?.services?.identity?.enabled === false ||
    (mint.data.identity === null && !product.data?.services)
  ) {
    body = (
      <EmptyState
        kind="service-off"
        service="identity"
        headingLevel={2}
        title="Identity is off for this product"
        description="No one can sign in to this product until Identity is on."
        primaryAction={
          <Link
            to={r.services(slug)}
            className="text-accent-fg underline underline-offset-2"
          >
            Open Services
          </Link>
        }
      />
    );
  } else {
    body = (
      <SignInBody
        slug={slug}
        identity={
          mint.data.identity ?? {
            provider: null,
            issuer: null,
            clientId: null,
            groupRoleMapJson: null,
          }
        }
        oidcDefault={mint.data.oidcDefault}
      />
    );
  }

  return (
    <div className="space-y-6" data-template="record">
      {header}
      {resync.panel}
      {body}
      {resync.dialog}
    </div>
  );
}

function SignInBody({
  slug,
  identity,
  oidcDefault,
}: {
  slug: string;
  identity: EdgeMintIdentity;
  oidcDefault: boolean;
}): React.ReactElement {
  // An unset provider is the platform default (`resolveOidcConfig`).
  const custom = identity.provider === "custom";
  const groups = parseGroupMap(identity.groupRoleMapJson);

  return (
    <div className="space-y-6">
      <SettingsSection
        id="sign-in-provider"
        title="Provider"
        description={
          custom ? undefined : "Shared with the customer portal's sign-in."
        }
      >
        <div className="px-5 py-4">
          <DescriptionList
            columns={3}
            items={[
              {
                term: "Provider",
                detail: custom ? "Custom" : "Platform OIDC",
              },
              {
                term: "Issuer",
                detail: identity.issuer ? (
                  <IdChip
                    value={identity.issuer}
                    noun="issuer"
                    head={28}
                    tail={12}
                  />
                ) : custom ? (
                  <span className="text-fg-muted">Not set</span>
                ) : (
                  <span className="text-fg-muted">The platform issuer</span>
                ),
                help:
                  !identity.issuer && !custom
                    ? "Set by the deployment's PLATFORM_OIDC_ISSUER secret."
                    : undefined,
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
                ) : custom ? (
                  <span className="text-fg-muted">Not set</span>
                ) : (
                  <span className="text-fg-muted">The platform client</span>
                ),
              },
            ]}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        id="sign-in-groups"
        title="Groups and tiers"
        description="The first mapped group that names a tier decides it."
      >
        <div className="px-5 py-4">
          {groups === "invalid" ? (
            <p className="text-sm text-danger">
              The stored group map is not valid JSON. Fix the{" "}
              <code className="font-mono text-xs">groupRoleMap</code> in{" "}
              <code className="font-mono text-xs">.pkey/product</code>, then
              resync.
            </p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-fg-muted">No groups are mapped.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Groups and tiers</caption>
                <thead className="text-xs text-fg-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Group
                    </th>
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Role
                    </th>
                    <th scope="col" className="py-2 font-bold">
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
                          <span className="text-fg-muted">
                            Entitlement only
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-sm text-fg-muted">
            {oidcDefault
              ? "A signed-in account in no mapped group gets the auto-issue default tier."
              : "A signed-in account in no mapped group is refused (not entitled)."}{" "}
            <Link
              to={r.enrollment(slug)}
              className="text-accent-fg underline underline-offset-2"
            >
              Auto-issue in Enrollment
            </Link>
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        id="sign-in-manifest"
        title="Where it is authored"
        description={
          <>
            Edit the <code className="font-mono text-xs">oidc</code> block,
            commit, then resync.{" "}
            <a
              className="text-accent-fg underline underline-offset-2"
              href={docsUrl("identityOidcNote")}
              target="_blank"
              rel="noreferrer"
            >
              Product OIDC
            </a>
          </>
        }
      >
        <div className="px-5 py-4">
          {/* Once a provider is configured the example is reference, not the page's subject. */}
          {custom ? (
            <details>
              <summary className="cursor-pointer text-sm text-accent-fg">
                Show an example oidc block
              </summary>
              <div className="mt-3">
                <CodeBlock
                  code={MANIFEST_EXAMPLE}
                  language="json"
                  filename="Example: a custom provider"
                />
              </div>
            </details>
          ) : (
            <CodeBlock
              code={MANIFEST_EXAMPLE}
              language="json"
              filename="Example: a custom provider"
            />
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
