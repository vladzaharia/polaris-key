/**
 * The account override editor on a user's record (U-03; notes/S-17 §5.12): managed config that
 * an operator writes for ONE account on ONE product, keyed by the product's pairwise subject. It
 * fills I-12's `overrideEditor` slot (`accountOverridesSlot.tsx`), drawn on the record's Overview
 * while Config is on.
 *
 * It is the licence override editor's `ManagedPayloadEditor` over the catalog's `config` and
 * `secret` entries only: entitlement (`flag`) overrides stay on the licence (decision 20), and the
 * Worker refuses one here with a 422. Saving PUTs the batch; a 422's `fields` land on the rows
 * that caused them, and a 409 `conflict` (the row changed between the server's read and its
 * write) reloads the values so the operator can check them and save again.
 *
 * Which devices get these values: every device signed in to this account on this product, and
 * the licence-key devices of licences this account owns. A floating, unowned licence gets none.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type AccountOverridesView,
  type OverrideUpdate,
  type ProductCatalog,
  type RedactedPayload,
} from "../../../api.js";
import { ManagedPayloadEditor } from "../../../ManagedPayloadEditor.js";
import { fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import type { UserSlotProps } from "./userSlots.js";

/**
 * The catalog an account override edits: its `config` and `secret` entries. Entitlements (`flag`)
 * are what a licence sells, so they stay on each licence.
 */
export function accountOverrideCatalog(
  catalog: ProductCatalog,
): ProductCatalog {
  return {
    ...catalog,
    entries: catalog.entries.filter((e) => e.kind !== "flag"),
  };
}

/** The GET as the editor's payload (no entitlements bucket), tolerant of a partial body. */
export function accountPayload(
  view: AccountOverridesView | undefined,
): RedactedPayload {
  return {
    config: view?.overrides?.config ?? {},
    secrets: view?.overrides?.secrets ?? {},
    entitlements: {},
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function AccountOverrideEditor({
  slug,
  subject,
}: UserSlotProps): React.ReactElement {
  const overridesQ = useQuery({
    queryKey: qk.userOverrides(slug, subject),
    queryFn: () => api.productUserOverrides(slug, subject),
  });
  const catalogQ = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
  });
  const [serverFields, setServerFields] = React.useState<
    string[] | undefined
  >();
  const [saving, setSaving] = React.useState(false);

  const catalog = React.useMemo(
    () => (catalogQ.data ? accountOverrideCatalog(catalogQ.data) : null),
    [catalogQ.data],
  );
  const payload = React.useMemo(
    () => accountPayload(overridesQ.data),
    [overridesQ.data],
  );

  const submit = async (updates: OverrideUpdate[]): Promise<void> => {
    if (updates.length === 0) return;
    setSaving(true);
    setServerFields(undefined);
    try {
      await mutate("putProductUserOverrides", slug, subject, updates);
      toast.success("Account overrides saved", {
        description: `${updates.length} ${updates.length === 1 ? "change" : "changes"} applied.`,
      });
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === "conflict"
      ) {
        // Someone else wrote this account's overrides between the server's read and its write.
        // Reloading shows what changed under the draft (Keep mine / Take theirs).
        void overridesQ.refetch();
        toast.error("These account overrides changed in the meantime", {
          description: "They were reloaded. Check the values, then save again.",
        });
      } else if (err instanceof ApiError && err.fields?.length) {
        // A 422 carries catalog-validated `fields`, each prefixed with its dotted key: they land
        // on the rows that caused them.
        setServerFields(err.fields);
        toast.error("Some values were rejected", {
          description: "See the highlighted keys.",
        });
      } else {
        toast.error(err, { context: { thing: "Account overrides" } });
      }
    } finally {
      setSaving(false);
    }
  };

  let body: React.ReactNode;
  if (overridesQ.isPending || catalogQ.isPending) {
    body = (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  } else if (catalogQ.isError && isNotFound(catalogQ.error)) {
    body = (
      <EmptyState
        kind="first-run"
        variant="inline"
        title="This product has no config catalog yet"
        description="Account overrides set the config and secret keys the catalog declares."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link to={r.catalog(slug)}>Open the catalog</Link>
          </Button>
        }
      />
    );
  } else if (!catalog) {
    body = (
      <ErrorState
        compact
        error={catalogQ.error}
        onRetry={() => void catalogQ.refetch()}
        context={{ thing: "Catalog", collectionHref: r.catalog(slug) }}
      />
    );
  } else if (overridesQ.isError) {
    body = (
      <ErrorState
        compact
        error={overridesQ.error}
        onRetry={() => void overridesQ.refetch()}
        context={{ thing: "Account overrides" }}
      />
    );
  } else if (catalog.entries.length === 0) {
    body = (
      <EmptyState
        kind="first-run"
        variant="inline"
        title="No config or secret keys to set"
        description="This product's catalog declares only entitlements, and those stay on each license."
        primaryAction={
          <Button asChild variant="outline" size="sm">
            <Link to={r.catalog(slug)}>Open the catalog</Link>
          </Button>
        }
      />
    );
  } else {
    const updatedAt = overridesQ.data?.updatedAt ?? null;
    body = (
      <div className="space-y-4">
        {updatedAt !== null ? (
          <p className="text-xs text-fg-muted">
            Last changed <Timestamp at={fromSeconds(updatedAt)} />
          </p>
        ) : null}
        <ManagedPayloadEditor
          slug={slug}
          catalog={catalog}
          payload={payload}
          saving={saving}
          serverFields={serverFields}
          submitLabel="Save account overrides"
          onSubmit={submit}
        />
      </div>
    );
  }

  const retired = overridesQ.data?.licenseLayerRetired === true;
  return (
    <SettingsSection
      id="user-overrides"
      title="Account overrides"
      description={
        <>
          These config and secret values reach every device signed in to this
          account on this product, and the license-key devices of licenses this
          account owns. Entitlements stay on each license.
          {retired
            ? null
            : " A value set here wins over the same key on one of their licenses."}
        </>
      }
    >
      <div className="px-5 py-4">{body}</div>
    </SettingsSection>
  );
}

export default AccountOverrideEditor;
