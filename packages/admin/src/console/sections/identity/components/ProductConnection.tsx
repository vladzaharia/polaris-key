/** Product connection: the product's own sign-in provider, read from the manifest, changed by a resync. */

import * as React from "react";
import { RefreshCw } from "lucide-react";
import type { EdgeMintIdentity, ProductDetail } from "../../../../api.js";
import { releaseSourceOf } from "../../../../lib/products.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { IdChip } from "../../../../ui/IdChip.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { EntityLink } from "../../../components/EntityLink.js";
import { useResyncFlow } from "../../../components/ResyncDialog.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { parseGroupMap } from "../model/groups.js";
import { linkClass, Tiled } from "./SignInSections.js";

/** What the card knows: the mint read, an error, or no access to it. */
export type ConnectionState =
  | { kind: "loading" }
  | { kind: "no-access" }
  | { kind: "error"; error: unknown; retry: () => void }
  | { kind: "ready"; identity: EdgeMintIdentity | null; oidcDefault: boolean };

function Fact({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid min-h-10 grid-cols-1 items-center gap-x-4 gap-y-0.5 py-1.5 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <dt className="text-sm text-fg-muted">{term}</dt>
      <dd className="min-w-0 text-end text-sm text-fg-strong [&>*]:justify-end">
        {children}
      </dd>
    </div>
  );
}

export function ProductConnectionSection({
  slug,
  name,
  product,
  state,
}: {
  slug: string;
  name: string;
  product: ProductDetail | undefined;
  state: ConnectionState;
}): React.ReactElement {
  const resync = useResyncFlow();
  const linked = product ? releaseSourceOf(product) === "github" : false;
  const ready = state.kind === "ready";
  const identity =
    state.kind === "ready"
      ? (state.identity ?? {
          provider: null,
          issuer: null,
          clientId: null,
          groupRoleMapJson: null,
        })
      : null;
  const custom = identity?.provider === "custom";
  return (
    <>
      <SettingsSection
        id="product-connection"
        title="Product connection"
        actions={
          ready ? (
            <Button
              variant="outline"
              size="sm"
              className="max-w-full whitespace-normal"
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
          ) : undefined
        }
      >
        {state.kind === "no-access" ? (
          <p className="px-5 py-4 text-sm text-fg-muted">
            Needs Managed config access. Ask an admin of this product.
          </p>
        ) : state.kind === "error" ? (
          <div className="px-5 py-4">
            <ErrorState error={state.error} onRetry={state.retry} compact />
          </div>
        ) : state.kind === "loading" ? (
          <p className="px-5 py-4 text-sm text-fg-muted" aria-busy="true">
            Loading
          </p>
        ) : (
          <>
            <SettingsRow
              label={
                <Tiled
                  tile={
                    <ProductLogo
                      name={name}
                      presentation={product?.presentation}
                      size={32}
                    />
                  }
                >
                  {custom ? `${name} accounts` : "Polaris Locker accounts"}
                </Tiled>
              }
              help={custom ? "Custom provider" : "The platform provider"}
            >
              {null}
            </SettingsRow>
            <div className="px-5 py-3">
              <dl className="divide-y divide-border">
                <Fact term="Issuer">
                  {identity!.issuer ? (
                    <IdChip
                      value={identity!.issuer}
                      noun="issuer"
                      head={28}
                      tail={12}
                    />
                  ) : (
                    <span className="text-fg-muted">
                      {custom ? "Not set" : "The platform issuer"}
                    </span>
                  )}
                </Fact>
                <Fact term="Client ID">
                  {identity!.clientId ? (
                    <IdChip
                      value={identity!.clientId}
                      noun="client ID"
                      head={16}
                      tail={6}
                    />
                  ) : (
                    <span className="text-fg-muted">
                      {custom ? "Not set" : "The platform client"}
                    </span>
                  )}
                </Fact>
              </dl>
              <GroupsTable
                slug={slug}
                groups={parseGroupMap(identity!.groupRoleMapJson)}
              />
              <p className="mt-3 text-sm text-fg-muted">
                {state.oidcDefault
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
          </>
        )}
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
    <div
      className="mt-4 overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label="Groups and tiers"
    >
      <table className="w-full text-start text-sm">
        <caption className="sr-only">Groups and tiers</caption>
        <thead className="text-xs text-fg-muted">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pe-4 font-medium">
              Group
            </th>
            <th scope="col" className="py-2 pe-4 font-medium">
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
              <td className="py-2 pe-4 font-mono text-xs text-fg-strong">
                {g.group}
              </td>
              <td className="py-2 pe-4">
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
