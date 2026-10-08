/**
 * Cloud Sync → Data (U-04; S-17 §5.10, plans/U-01.md §3). Read-only: what this product declares
 * for Cloud Sync, all of it authored in `.pkey/schema` (the data shape) and `.pkey/product` (limits
 * and access policy). The page reads the active catalog: its user settings (`config` entries with
 * a `user` block), and its `cloudSync` block's collections, saves and migrations. The platform
 * ceilings every declared limit is held to close the page.
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
  type CatalogCloudSync,
  type UserSettingConflict,
  type UserSettingSync,
} from "@polaris-key/catalog";
import { api, type ProductCatalog } from "../../../api.js";
import { formatBytes, formatCount } from "../../../lib/format.js";
import { Callout } from "../../../ui/Callout.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import { noCatalog, userSettings } from "./data.js";

export const SYNC_LABEL: Record<UserSettingSync, string> = {
  user: "Everywhere the person signs in",
  platform: "Per platform family",
  device: "Per device",
  local: "Never leaves the device",
};

export const CONFLICT_LABEL: Record<UserSettingConflict, string> = {
  lastWrite: "Last write wins",
  max: "Keep the highest",
  min: "Keep the lowest",
  merge: "Merge members",
};

const ACCESS_LABEL: Record<string, string> = {
  owner: "The person's devices",
  ownerRead: "Devices read, the console writes",
  server: "Console and backend only",
};

const muted = (text: string): React.ReactElement => (
  <span className="text-fg-muted">{text}</span>
);

const mono = (text: string): React.ReactElement => (
  <code className="font-mono text-xs text-fg-strong">{text}</code>
);

export function SyncDataPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  const catalog = useQuery(
    {
      queryKey: qk.catalog(slug),
      queryFn: () => api.schema(slug),
      retry: false,
    },
    queryClient,
  );

  const header = (
    <PageHeader
      title="Data"
      description={
        <>
          Declared in <code className="font-mono text-xs">.pkey/schema</code>{" "}
          and <code className="font-mono text-xs">.pkey/product</code>.
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
  const collections = cs.collections ?? [];
  const migrations = cs.migrations ?? [];

  return (
    <div className="space-y-6">
      <Callout title="Only signed-in people sync">
        A device syncs once a person signs in through this product. Devices
        activated with a licence key keep their settings on the device.
      </Callout>

      <SettingsSection
        id="sync-settings"
        title="User settings"
        description={
          <>
            Config keys with a <code className="font-mono text-xs">user</code>{" "}
            block.{" "}
            <Link
              to={r.catalog(slug)}
              className="text-accent-fg underline underline-offset-2"
            >
              Open the catalog
            </Link>
          </>
        }
      >
        <div className="px-5 py-4">
          {settings.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No catalog key is a user setting.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">User settings</caption>
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
                      <td className="py-2 pr-4">{SYNC_LABEL[e.user.sync]}</td>
                      <td className="py-2 pr-4">
                        {CONFLICT_LABEL[e.user.conflict ?? "lastWrite"]}
                      </td>
                      <td className="py-2">
                        {e.user.listed === false ? "Hidden" : "Shown"}
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
        id="sync-collections"
        title="Collections"
        description={
          cs.open
            ? "Undeclared collection names are allowed at the default limits."
            : "Only declared collections accept records."
        }
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
                      Written by
                    </th>
                    <th scope="col" className="py-2 pr-4 font-bold">
                      Conflicts
                    </th>
                    <th scope="col" className="py-2 font-bold">
                      At first sign-in
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {collections.map((c) => (
                    <tr key={c.name}>
                      <td className="py-2 pr-4">{mono(c.name)}</td>
                      <td className="py-2 pr-4">
                        {ACCESS_LABEL[c.access] ?? c.access}
                      </td>
                      <td className="py-2 pr-4">{c.conflict ?? "revision"}</td>
                      <td className="py-2">{c.onAttach ?? "prompt"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection id="sync-saves" title="Saves">
        <div className="px-5 py-4">
          {cs.saves === undefined ? (
            <p className="text-sm text-fg-muted">Saves are not declared.</p>
          ) : (
            <DescriptionList
              columns={3}
              items={[
                {
                  term: "Conflicts",
                  detail: cs.saves.conflict ?? "prompt",
                },
                {
                  term: "Needs entitlement",
                  detail: cs.saves.requiresFlag
                    ? mono(cs.saves.requiresFlag)
                    : muted("None"),
                },
                {
                  term: "Newer formats",
                  detail: cs.saves.format?.refuseNewer ? "Refused" : "Accepted",
                },
              ]}
            />
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
        title="Platform ceilings"
        description={
          <>
            Limits in <code className="font-mono text-xs">.pkey/product</code>{" "}
            stay within these.
          </>
        }
      >
        <div className="px-5 py-4">
          <DescriptionList
            columns={3}
            items={[
              {
                term: "Settings per person",
                detail: formatBytes(
                  CLOUD_SYNC_CEILINGS.perPerson.settingsBytes,
                ),
                help: `Default ${formatBytes(CLOUD_SYNC_DEFAULTS.licensed.settingsBytes)}.`,
              },
              {
                term: "Records per person",
                detail: formatBytes(
                  CLOUD_SYNC_CEILINGS.perPerson.collectionBytes,
                ),
                help: `Default ${formatCount(CLOUD_SYNC_DEFAULTS.licensed.records)} records in ${formatBytes(CLOUD_SYNC_DEFAULTS.licensed.collectionBytes)}.`,
              },
              {
                term: "Saves per person",
                detail: formatBytes(CLOUD_SYNC_CEILINGS.perPerson.saveBytes),
                help: `Default ${formatCount(CLOUD_SYNC_DEFAULTS.licensed.saves.slots)} slots of ${formatBytes(CLOUD_SYNC_DEFAULTS.licensed.saves.maxBytes)}.`,
              },
              {
                term: "Data per product",
                detail: formatBytes(CLOUD_SYNC_CEILINGS.perProduct.bytes),
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
