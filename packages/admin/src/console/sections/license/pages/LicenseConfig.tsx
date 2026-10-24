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
 * merged payload is only assembled at signing time (`core/licensing/payload.ts`) and no admin endpoint
 * exposes it. So the console rebuilds the layers below, in the server's order and with its
 * precedence rule, from data it can fetch:
 *
 *     catalog default  <  the tier's profile  <  the license's profiles, in order  <  (this row)
 *
 * with `mergePayloads`' one exception: a lower `enforced`/`hidden` entry is NOT demoted by a
 * higher `default` one.
 *
 * ── The account layer above ────────────────────────────────────────────────────────────────
 *
 * Every key is editable on every licence: the licence layer is always read (U-27). The owner's
 * account overrides (U-03) sit above it and win for the same key, so an owned licence says so
 * and links the owner's record. An unowned licence has no account layer: "No account: managed
 * config for this customer needs an account", with the portal's sign-up link to send the
 * customer (an offer, never forced).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ApiError,
  type ConfigEntry,
  type LicenseConfigOverrides,
  type LicenseDetail,
  type ManagementState,
  type OverrideUpdate,
  type RedactedPayload,
} from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { profileStackQuery } from "../data.js";
import { catalogQuery } from "../../config/data.js";
import { r } from "../../../routes.js";
import { Link } from "../../../router.js";
import { ManagedPayloadEditor } from "../../../../ManagedPayloadEditor.js";
import {
  entryDefault,
  isSecretEntry,
  type InheritedValue,
} from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { toast } from "../../../../ui/toast.js";
import { useTiers } from "../components/shared.js";

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
      // A lower `enforced`/`hidden` entry wins over a higher `default` one whole: its value and
      // its source, not only its state (the Worker's `mergeMap`, `merge.ts`). Devices get the
      // locked value, so the console shows it.
      const locked =
        current !== null &&
        current.state !== "default" &&
        found.state === "default";
      if (locked) continue;
      current = {
        source: layer.source,
        value: found.value,
        state: found.state,
      };
    }
    if (current) out[entry.key] = current;
  }
  return out;
}

export function configOverridesOf(
  license: LicenseDetail,
): LicenseConfigOverrides {
  return license.configOverrides;
}

/** The portal link the operator can send the customer: shown as text, with a copy button. */
function SignUpOffer({ url }: { url: string }): React.ReactElement {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="py-1 break-all font-mono text-xs text-accent-fg underline underline-offset-2"
      >
        {url}
      </a>
      <CopyButton value={url} label="Copy the sign-up link" />
    </span>
  );
}

/**
 * What sits above this licence's overrides: the owner's account overrides, or nothing, with the
 * sign-up link to offer the customer.
 */
export function LicenseOverridesNotice({
  slug,
  co,
}: {
  slug: string;
  co: LicenseConfigOverrides;
}): React.ReactElement {
  if (co.owned) {
    return (
      <Callout
        tone="info"
        title="Account overrides win over these"
        action={
          co.ownerSubject ? (
            <Button size="sm" variant="outline" asChild>
              <Link to={r.user(slug, co.ownerSubject)}>
                Open the owner's record
              </Link>
            </Button>
          ) : undefined
        }
      >
        The owner's account overrides apply above this license's: where both set
        a key, the account's value wins.
      </Callout>
    );
  }
  return (
    <Callout
      tone="info"
      title="No account: managed config for this customer needs an account"
    >
      {co.signUpUrl ? (
        <>
          <p>
            If the customer wants account-wide config, send them this link to
            add the license to a Polaris Locker account:
          </p>
          <SignUpOffer url={co.signUpUrl} />
        </>
      ) : (
        <p>No account owns this license, so only its own overrides apply.</p>
      )}
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
        title="Managed config is off for this product"
        description="Turn on Managed config to give this license its own configuration values."
        primaryAction={
          <Button variant="outline" asChild>
            <Link to={r.services(slug)}>Open Features</Link>
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
  const catalogQ = useQuery(catalogQuery(slug));
  const tiers = useTiers(slug).data?.tiers;
  const [serverFields, setServerFields] = React.useState<
    string[] | undefined
  >();
  const [saving, setSaving] = React.useState(false);

  // The tier's profile, then the license's own profiles in order: `core/licensing/payload.ts`'s order.
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
  const stackQ = useQuery(profileStackQuery(slug, stackKey, profileIds));

  const co = configOverridesOf(license);
  const catalog = catalogQ.data;
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
              Try again
            </Button>
          }
        >
          A profile this license inherits from couldn't be loaded, so the values
          shown as inherited may be missing that profile's.
        </Callout>
      ) : null}
      <ManagedPayloadEditor
        slug={slug}
        catalog={catalog}
        payload={license.overrides}
        inherited={inherited}
        saving={saving}
        serverFields={serverFields}
        submitLabel="Save overrides"
        onSubmit={submit}
      />
    </div>
  );
}
