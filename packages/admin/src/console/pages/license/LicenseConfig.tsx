/**
 * The license's Config overrides tab (ADMIN.md §6.5.2): the payload editor over the license's own
 * overrides, with each inherited value's source. Every failure state is explicit (LDT-5, LDT-6):
 *
 * | Failure       | Shows                                                |
 * | ------------- | ---------------------------------------------------- |
 * | Config off    | the service-off state                                |
 * | Catalog fails | `ErrorState`                                         |
 * | Profile fails | a warning: "Inherited values may be incomplete"      |
 *
 * ── What "inherited" means here ────────────────────────────────────────────────────────────
 *
 * `GET …/license/licenses/<id>` returns the license row's own overrides and nothing else; the
 * merged payload is only assembled at signing time (`core/payload.ts`) and no admin endpoint
 * exposes it. So the console rebuilds the layers below, in the server's order and with its
 * precedence rule, from data it can fetch:
 *
 *     catalog default  <  the tier's profile  <  the license's profiles, in order  <  (this row)
 *
 * with `mergePayloads`' one exception: a lower `enforced`/`hidden` entry is NOT demoted by a
 * higher `default` one.
 *
 * ── The account override migration (U-03) ────────────────────────────────────────────────────
 *
 * Config and secret overrides are moving from the licence to the account override (one account
 * on one product); entitlement (`flag`) overrides stay here. `configOverrides.phase` says where
 * this licence's live:
 *
 * | Phase    | Editor                 | Says                                                     |
 * | -------- | ---------------------- | -------------------------------------------------------- |
 * | license  | every key              | nothing                                                  |
 * | notice   | every key              | the run date: they move to the owner, or are dropped     |
 * | moving   | entitlements only      | config and secrets are moving (frozen here)              |
 * | moved    | entitlements only      | config and secrets moved to the owner's account          |
 *
 * An unowned licence has no account layer: "No account: managed config for this customer needs
 * an account", with the portal's sign-up link to send the customer (an offer, never forced).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ConfigEntry,
  type LicenseConfigOverrides,
  type LicenseDetail,
  type ManagementState,
  type OverrideUpdate,
  type ProductCatalog,
  type RedactedPayload,
} from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { upcomingRunDate } from "../../data/overrideMigration.js";
import { qk } from "../../data/queries.js";
import { r } from "../../routes.js";
import { Link } from "../../router.js";
import { ManagedPayloadEditor } from "../../../ManagedPayloadEditor.js";
import {
  entryDefault,
  isSecretEntry,
  type InheritedValue,
} from "../../../schema/index.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { toast } from "../../../ui/toast.js";
import { useTiers } from "./shared.js";

/** One layer of the stack, lowest first. */
export interface PayloadLayer {
  /** Human source, e.g. `profile “base”`. */
  source: string;
  payload: RedactedPayload;
}

function readLayer(
  entry: ConfigEntry,
  payload: RedactedPayload,
): { value: unknown; state: ManagementState } | null {
  if (entry.kind === "secret") {
    const s = payload.secrets[entry.key];
    // A secret's value never crosses the wire; a lower layer only says there is one.
    return s
      ? { value: s.configured ? "(configured)" : undefined, state: s.state }
      : null;
  }
  const bucket = entry.kind === "flag" ? payload.entitlements : payload.config;
  const m = bucket[entry.key];
  if (!m) return null;
  return {
    value: isSecretEntry(entry) ? "(configured)" : m.value,
    state: m.state,
  };
}

/** The layers below one license collapsed into "what you get without an override", per key. */
export function resolveInherited(
  entries: readonly ConfigEntry[],
  layers: PayloadLayer[],
): Record<string, InheritedValue> {
  const out: Record<string, InheritedValue> = {};
  for (const entry of entries) {
    const fallback = entryDefault(entry);
    let current: InheritedValue | null =
      fallback === undefined
        ? null
        : {
            source: "the catalog default",
            value: fallback,
            state: entry.managementDefault ?? "default",
          };
    for (const layer of layers) {
      const found = readLayer(entry, layer.payload);
      if (!found) continue;
      const locked =
        current !== null &&
        current.state !== "default" &&
        found.state === "default";
      current = {
        source: layer.source,
        value: found.value,
        state: locked ? current!.state : found.state,
      };
    }
    if (current) out[entry.key] = current;
  }
  return out;
}

/** Before U-03 the Worker sent no `configOverrides`: that is phase `license`. */
const LICENSE_PHASE: LicenseConfigOverrides = {
  phase: "license",
  owned: false,
  ownerSubject: null,
  runNotBefore: null,
  signUpUrl: null,
};

export function configOverridesOf(
  license: LicenseDetail,
): LicenseConfigOverrides {
  return license.configOverrides ?? LICENSE_PHASE;
}

/** From the run's start, this tab edits entitlements only: config and secrets left the licence. */
export function entitlementsOnly(co: LicenseConfigOverrides): boolean {
  return co.phase === "moving" || co.phase === "moved";
}

/** The catalog this tab edits: every entry, or (`flagsOnly`) the `flag` entries alone. */
export function licenseEditorCatalog(
  catalog: ProductCatalog,
  flagsOnly: boolean,
): ProductCatalog {
  return flagsOnly
    ? { ...catalog, entries: catalog.entries.filter((e) => e.kind === "flag") }
    : catalog;
}

/** The portal link the operator can send the customer: shown as text, with a copy button. */
function SignUpOffer({ url }: { url: string }): React.ReactElement {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="break-all font-mono text-xs text-accent-fg underline underline-offset-2"
      >
        {url}
      </a>
      <CopyButton value={url} label="Copy the sign-up link" />
    </span>
  );
}

/** Where this licence's config and secret overrides go, or went (U-03). Nothing in `license`. */
export function LicenseOverridesNotice({
  slug,
  co,
  now,
}: {
  slug: string;
  co: LicenseConfigOverrides;
  now?: number;
}): React.ReactElement | null {
  if (co.phase === "license") return null;
  const ownerLink =
    co.owned && co.ownerSubject ? (
      <Button size="sm" variant="outline" asChild>
        <Link to={r.user(slug, co.ownerSubject)}>Open the owner's record</Link>
      </Button>
    ) : undefined;
  const offer = co.signUpUrl ? (
    <>
      <p>
        If the customer wants to keep managed config, send them this link to add
        the license to a Polaris Key account:
      </p>
      <SignUpOffer url={co.signUpUrl} />
    </>
  ) : null;

  if (co.phase === "notice") {
    const date = upcomingRunDate(co.runNotBefore, now);
    const when = date ? `On ${date}` : "When the migration runs";
    return co.owned ? (
      <Callout
        tone="info"
        title="Config and secrets move to account overrides"
        action={ownerLink}
      >
        {when}, this license's config and secret overrides move to its owner's
        account overrides. Entitlements stay on this license.
      </Callout>
    ) : (
      <Callout
        tone="warning"
        title="No account: managed config for this customer needs an account"
      >
        <p>
          {when}, these config and secret overrides are dropped. Entitlements
          stay on this license.
        </p>
        {offer}
      </Callout>
    );
  }

  const moving = co.phase === "moving";
  return co.owned ? (
    <Callout
      tone="info"
      title={
        moving
          ? "Config and secrets are moving to account overrides"
          : "Config and secrets moved to account overrides"
      }
      action={ownerLink}
    >
      This license's config and secret overrides{" "}
      {moving ? "are moving" : "moved"} to its owner's account overrides: edit
      them on the owner's record. Entitlements stay here.
    </Callout>
  ) : (
    <Callout
      tone="warning"
      title="No account: managed config for this customer needs an account"
    >
      <p>
        {moving
          ? "The migration is running: this license's config and secret overrides are dropped, because no account owns it."
          : "This license's config and secret overrides were dropped by the migration, because no account owns it."}{" "}
        Entitlements stay here.
      </p>
      {offer}
    </Callout>
  );
}

export function LicenseConfig({
  slug,
  license,
  configOn,
}: {
  slug: string;
  license: LicenseDetail;
  configOn: boolean;
}): React.ReactElement {
  if (!configOn) {
    return (
      <EmptyState
        kind="service-off"
        service="config"
        title="Config is off for this product"
        description="Turn on Config to give this license its own configuration values."
        primaryAction={
          <Button variant="outline" asChild>
            <Link to={r.services(slug)}>Open Services</Link>
          </Button>
        }
      />
    );
  }
  return <ConfigEditor slug={slug} license={license} />;
}

function ConfigEditor({
  slug,
  license,
}: {
  slug: string;
  license: LicenseDetail;
}): React.ReactElement {
  const catalogQ = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
  });
  const tiers = useTiers(slug).data?.tiers;
  const [serverFields, setServerFields] = React.useState<
    string[] | undefined
  >();
  const [saving, setSaving] = React.useState(false);

  // The tier's profile, then the license's own profiles in order: `core/payload.ts`'s order.
  const profileIds = React.useMemo(() => {
    const ids: string[] = [];
    const tierProfile = tiers?.find((t) => t.id === license.tier)?.profile;
    if (tierProfile) ids.push(tierProfile);
    const own = license.profiles ?? (license.profile ? [license.profile] : []);
    for (const id of own) if (id && !ids.includes(id)) ids.push(id);
    return ids;
  }, [tiers, license]);
  const stackKey = profileIds.join("|");
  // One query for the whole stack, so the hook count never depends on the profile count.
  const stackQ = useQuery({
    queryKey: qk.profileStack(slug, stackKey),
    queryFn: () =>
      stackKey === ""
        ? Promise.resolve([])
        : Promise.all(
            profileIds.map((profileId) =>
              api.profile(slug, profileId).then((profile) => ({
                source: `profile “${profile.name || profile.id}”`,
                payload: profile.payload,
              })),
            ),
          ),
  });

  const co = configOverridesOf(license);
  const scopedOnly = entitlementsOnly(co);
  // Keyed on the boolean, not the phase object: a refetch of the licence must not hand the
  // editor a new catalog (and re-seed it) while the scope is unchanged.
  const catalog = React.useMemo(
    () =>
      catalogQ.data
        ? licenseEditorCatalog(catalogQ.data, scopedOnly)
        : undefined,
    [catalogQ.data, scopedOnly],
  );
  const inherited = React.useMemo(
    () =>
      catalog
        ? resolveInherited(
            catalog.entries,
            (stackQ.data as PayloadLayer[]) ?? [],
          )
        : {},
    [catalog, stackQ.data],
  );

  if (catalogQ.isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!catalog) {
    return (
      <ErrorState
        error={catalogQ.error}
        onRetry={() => void catalogQ.refetch()}
        context={{ thing: "Catalog", collectionHref: r.catalog(slug) }}
      />
    );
  }

  const submit = async (updates: OverrideUpdate[]): Promise<void> => {
    if (updates.length === 0) return;
    setSaving(true);
    setServerFields(undefined);
    try {
      await mutate("putLicenseOverrides", slug, license.id, updates);
      toast.success("Overrides saved", {
        description: `${updates.length} ${updates.length === 1 ? "change" : "changes"} applied.`,
      });
    } catch (err) {
      // A 422 carries catalog-validated `fields`, each prefixed with its dotted key: they land
      // on the rows that caused them.
      if (err instanceof ApiError && err.fields?.length) {
        setServerFields(err.fields);
        toast.error("Some values were rejected", {
          description: "See the highlighted keys.",
        });
      } else {
        toast.error(err, { context: { thing: "License" } });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <LicenseOverridesNotice slug={slug} co={co} />
      {stackQ.isError ? (
        <Callout
          tone="warning"
          title="Inherited values may be incomplete"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void stackQ.refetch()}
            >
              Retry
            </Button>
          }
        >
          A profile this license inherits from couldn't be loaded, so the values
          shown as inherited may be missing that profile's.
        </Callout>
      ) : null}
      {scopedOnly && catalog.entries.length === 0 ? (
        <EmptyState
          kind="first-run"
          variant="inline"
          title="No entitlements to override"
          description="This product's catalog declares no entitlements, so this license has nothing of its own to set."
        />
      ) : (
        <ManagedPayloadEditor
          slug={slug}
          catalog={catalog}
          payload={license.overrides}
          inherited={inherited}
          saving={saving}
          serverFields={serverFields}
          submitLabel={scopedOnly ? "Save entitlements" : "Save overrides"}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
