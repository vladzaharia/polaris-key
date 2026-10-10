/**
 * Cloud Sync → Data (U-04; plans/U-01b.md §3.3). Read-only: what this product declares for Cloud
 * Sync, all of it in `.pkey/schema`. The page reads the active catalog: its synced settings (every
 * Editable `config` key, through `syncedSettings`) and its `cloudSync` block's collections and
 * migrations. The platform's limits close the page. Every number on it is a constant from
 * `@polaris-key/catalog`, never typed (R8). A person's quota is the `pkey.cloudSync.bytes`
 * entitlement, set on Tiers, so it is not here.
 *
 * Cloud Sync has no principal without sign-in (plans/U-01.md §0): a device gets one only when a
 * person signs in through the product; a device activated with a licence key keeps its settings
 * on the device. The page says so up front, because it is the first thing an operator asks.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CLOUD_SYNC_CEILINGS,
  CLOUD_SYNC_DEFAULTS,
  CLOUD_SYNC_SAVE_SLOTS,
  CLOUD_SYNC_TEMPLATES,
  resolveCollection,
  type CatalogCloudSync,
  type SyncConflict,
} from "@polaris-key/catalog";
import { api, type ProductCatalog } from "../../../api.js";
import { formatCount } from "../../../lib/format.js";
import { Callout } from "../../../ui/Callout.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { qk } from "../../data/queries.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import { noCatalog, userSettings } from "./data.js";

/** Where a synced setting roams. */
export const SYNC_LABEL: Record<"user" | "platform", string> = {
  user: "Everywhere the person signs in",
  platform: "Per platform family",
};

/** The one conflict vocabulary (plans/U-01b.md §2.2), in the console's words. */
export const CONFLICT_LABEL: Record<SyncConflict, string> = {
  lastWrite: "Last write wins",
  max: "Keep the highest",
  min: "Keep the lowest",
  merge: "Merge members",
  union: "Combine as a set",
  revision: "Ask the player",
};

const KiB = 1024;
const UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB"] as const;

/** Binary bytes, the way the limits are set: 65536 → "64 KiB", 268435456 → "256 MiB". */
export function formatBinaryBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= KiB && unit < UNITS.length - 1) {
    value /= KiB;
    unit++;
  }
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(2));
  return `${new Intl.NumberFormat("en").format(rounded)} ${UNITS[unit]}`;
}

const muted = (text: string): React.ReactElement => (
  <span className="text-fg-muted">{text}</span>
);

const mono = (text: string): React.ReactElement => (
  <code className="font-mono text-xs text-fg-strong">{text}</code>
);

export function SyncDataPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  const catalog = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
    retry: false,
  });

  const header = (
    <PageHeader
      title="Data"
      description={
        <>
          Declared in <code className="font-mono text-xs">.pkey/schema</code>.
        </>
      }
      refetching={catalog.isFetching && !catalog.isPending}
    />
  );

  let body: React.ReactNode;
  if (product.data?.services?.sync?.enabled === false) {
    body = (
      <EmptyState
        kind="service-off"
        service="sync"
        headingLevel={2}
        title="Cloud Sync is off for this product"
        description="Settings stay on each device and nothing syncs until Cloud Sync is on. It needs Config and Identity."
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
  } else if (catalog.isPending) {
    body = <PageSkeleton template="record" label="Cloud Sync data" />;
  } else if (noCatalog(catalog.error)) {
    // No catalog before the first publish: nothing is declared yet.
    body = <SyncDataBody slug={slug} catalog={null} />;
  } else if (catalog.isError) {
    body = (
      <ErrorState
        error={catalog.error}
        onRetry={() => void catalog.refetch()}
      />
    );
  } else {
    body = <SyncDataBody slug={slug} catalog={catalog.data} />;
  }

  return (
    <div className="space-y-6" data-template="record">
      {header}
      {body}
    </div>
  );
}

function SyncDataBody({
  slug,
  catalog,
}: {
  slug: string;
  catalog: ProductCatalog | null;
}): React.ReactElement {
  const settings = userSettings(catalog);
  const cs: CatalogCloudSync = catalog?.cloudSync ?? {};
  const collections = (cs.collections ?? []).map(resolveCollection);
  const migrations = cs.migrations ?? [];
  const saves = CLOUD_SYNC_TEMPLATES.saves;
  return (
    <div className="space-y-6">
      <Callout title="Only signed-in people sync">
        A device syncs once a person signs in through this product. Devices
        activated with a licence key keep their settings on the device.
      </Callout>

      <SettingsSection
        id="sync-settings"
        title="Synced settings"
        description={
          <>
            Every config key people can change. Keys the game adds itself also
            sync.{" "}
            <Link
              to={r.catalog(slug)}
              className="text-accent-fg underline underline-offset-2"
            >
              Open the catalog
            </Link>
          </>
        }
      >
        <div className="space-y-4 px-5 py-4">
          <DescriptionList
            columns={3}
            items={[
              {
                term: "Keys per player",
                detail: `Up to ${formatCount(CLOUD_SYNC_DEFAULTS.settings.maxKeys)}`,
              },
              {
                term: "Size per player",
                detail: `Up to ${formatBinaryBytes(CLOUD_SYNC_DEFAULTS.settings.maxBytes)}`,
              },
              {
                term: "Largest value",
                detail: formatBinaryBytes(
                  CLOUD_SYNC_DEFAULTS.settings.maxValueBytes,
                ),
              },
            ]}
          />
          {settings.length === 0 ? (
            <p className="text-sm text-fg-muted">No catalog key syncs.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Synced settings</caption>
                <thead className="text-xs text-fg-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Key
                    </th>
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Syncs
                    </th>
                    <th scope="col" className="py-2 pr-4 font-bold">
                      When devices disagree
                    </th>
                    <th scope="col" className="py-2 font-bold">
                      In settings panels
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {settings.map((e) => (
                    <tr key={e.key}>
                      <td className="py-2 pr-4">{mono(e.key)}</td>
                      <td className="py-2 pr-4">{SYNC_LABEL[e.scope]}</td>
                      <td className="py-2 pr-4">{CONFLICT_LABEL[e.policy]}</td>
                      <td className="py-2">{e.listed ? "Shown" : "Hidden"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        id="sync-collections"
        title="Collections"
        description="Only declared collections accept records."
      >
        <div className="px-5 py-4">
          {collections.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No collections are declared.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Collections</caption>
                <thead className="text-xs text-fg-muted">
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Name
                    </th>
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Records
                    </th>
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Conflicts
                    </th>
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Files
                    </th>
                    <th scope="col" className="py-2 font-bold">
                      Needs entitlement
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {collections.map((c) => (
                    <tr key={c.name}>
                      <td className="py-2 pr-4">
                        {mono(c.name)}
                        {c.label !== c.name ? (
                          <span className="ml-2 text-fg-muted">{c.label}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4">
                        Up to {formatCount(c.maxRecords)} per player
                      </td>
                      <td className="py-2 pr-4">
                        {CONFLICT_LABEL[c.conflict]}
                        {c.conflictField ? (
                          <> on {mono(c.conflictField)}</>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4">
                        {formatBinaryBytes(c.files.maxBytes)}, last{" "}
                        {formatCount(c.files.keepRevisions)}{" "}
                        {c.files.keepRevisions === 1 ? "version" : "versions"}
                      </td>
                      <td className="py-2">
                        {c.requires ? mono(c.requires) : muted("None")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        id="sync-migrations"
        title="Migrations"
        description="Applied to synced values when the catalog reaches a version."
      >
        <div className="px-5 py-4">
          {migrations.length === 0 ? (
            <p className="text-sm text-fg-muted">No migrations are declared.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {migrations.map((m) => (
                <li key={m.toSchemaVersion}>
                  <span className="font-bold text-fg-strong">
                    Catalog v{m.toSchemaVersion}
                  </span>
                  {": "}
                  {[
                    ...Object.entries(m.rename ?? {}).map(
                      ([from, to]) => `${from} → ${to}`,
                    ),
                    ...(m.drop ?? []).map((k) => `${k} dropped`),
                  ].join(", ") || "values remapped"}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        id="sync-ceilings"
        title="Platform limits"
        description="A person's quota is the pkey.cloudSync.bytes entitlement, set on tiers."
      >
        <div className="px-5 py-4">
          <DescriptionList
            columns={3}
            items={[
              {
                term: "Default quota",
                detail: formatBinaryBytes(CLOUD_SYNC_DEFAULTS.quotaBytes),
                help: `Without a licence: ${formatBinaryBytes(CLOUD_SYNC_DEFAULTS.unlicensedQuotaBytes)}, no files.`,
              },
              {
                term: "Quota per person",
                detail: `Up to ${formatBinaryBytes(CLOUD_SYNC_CEILINGS.perPerson.bytes)}`,
              },
              {
                term: "Saves",
                detail: `Up to ${formatCount(CLOUD_SYNC_SAVE_SLOTS)} per player`,
                help: `${formatBinaryBytes(saves.files.maxBytes)} each, last ${formatCount(saves.files.keepRevisions)} versions kept.`,
              },
              {
                term: "Records per collection",
                detail: `Up to ${formatCount(CLOUD_SYNC_DEFAULTS.records.maxRecords)}`,
                help: `${formatBinaryBytes(CLOUD_SYNC_DEFAULTS.records.maxRecordBytes)} each.`,
              },
              {
                term: "One file",
                detail: `Up to ${formatBinaryBytes(CLOUD_SYNC_CEILINGS.perPerson.fileBytes)}`,
              },
              {
                term: "Data per product",
                detail: formatBinaryBytes(CLOUD_SYNC_CEILINGS.perProduct.bytes),
              },
              {
                term: "People holding data",
                detail: formatCount(CLOUD_SYNC_CEILINGS.perProduct.users),
              },
              {
                term: "Pushes per second",
                detail: formatCount(
                  CLOUD_SYNC_CEILINGS.perProduct.pushesPerSecond,
                ),
              },
            ]}
          />
        </div>
      </SettingsSection>
    </div>
  );
}
