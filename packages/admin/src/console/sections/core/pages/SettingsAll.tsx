/**
 * Settings → All settings (ST-08, S-18 §4.9): every product-scope entry of the settings registry
 * the member can see and the product's services make real, in one filterable table. The value and
 * source come from the settings API where it serves the key (`GET …/settings/effective`, the
 * row-backed slice until ST-05b widens it). Every other row names where its key is edited, by
 * the key and not by its area (`SETTING_HOMES`): a link to the page that has the control, or,
 * where the console has none, the `.pkey/` file or the admin API that does. Nothing is edited in
 * this table: a value has one home (S-18 §4.9 principles).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { api, type AreaId, type ProductSetting } from "../../../../api.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Input } from "../../../../ui/Input.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { ScrollTable } from "../../../../ui/ScrollTable.js";
import { Select } from "../../../../ui/Select.js";
import { serviceLabel } from "../../../../ui/ServiceBadge.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { SourceBadge, type Source } from "../../../../ui/SourceBadge.js";
import { formatSettingValue } from "../../../../ui/settings/model.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { canIn } from "../../../access/can.js";
import { useMe, useProduct } from "../../../data/hooks.js";
import { qk } from "../../../data/queries.js";
import { pageOf, sectionOf, type ProductPageId } from "../../../nav.js";
import { Link } from "../../../router.js";
import { productPage } from "../../../routes.js";
import {
  SETTINGS_INDEX,
  type SettingsIndexEntry,
} from "../../../settings.generated.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { SETTING_HOMES, type SettingHome } from "../model/settingHomes.js";
import { SETTINGS_AREAS } from "./SettingsHub.js";

/** A page as the console words it elsewhere: `Settings → Features`, `License → Enrollment`. */
function destination(page: ProductPageId): string {
  // The product's own settings unfold from Features' last row.
  const area = SETTINGS_AREAS.find(
    (a) => a.page === (page === "settings" ? "services" : page),
  );
  if (area) return `Settings → ${area.label}`;
  const section = sectionOf(page);
  return section
    ? `${section.label} → ${pageOf(page).label}`
    : pageOf(page).label;
}

/**
 * The "Edit in" cell: a link to the page whose control writes the key, with the section that
 * holds it when the page has several; or, for a key the console cannot edit, the file or API that
 * can (no link: there is no page to send the operator to).
 */
function EditIn({
  slug,
  entry,
  home,
}: {
  slug: string;
  entry: SettingsIndexEntry;
  home: SettingHome | undefined;
}): React.ReactElement {
  if (home?.kind === "page")
    return (
      <>
        <Link
          to={productPage(slug, home.page, { id: home.id })}
          className="inline-flex min-h-6 items-center gap-1 text-accent-fg underline-offset-4 hover:underline"
        >
          {destination(home.page)}
          <ArrowRight aria-hidden className="size-3.5" />
          <span className="sr-only"> for {entry.label}</span>
        </Link>
        {home.section ? (
          <span className="block text-xs text-fg-muted">{home.section}</span>
        ) : null}
      </>
    );
  return (
    <span className="text-fg-muted">
      {home?.kind === "manifest" ? (
        <>
          <code className="text-xs">.pkey/{home.file}</code> in the repository
        </>
      ) : home?.kind === "api" ? (
        "Admin API only"
      ) : (
        "No editor listed"
      )}
    </span>
  );
}

const OWNER: Record<SettingsIndexEntry["ownership"], string> = {
  operator: "Console",
  manifest: "Manifest",
  claimable: "Manifest or console",
  "narrow-only": "Narrowed only",
  "read-only": "Read-only",
};

const API_SOURCE: Record<ProductSetting["source"], Source> = {
  manifest: "manifest",
  console: "admin",
  default: "default",
};

const ALL = "all";

export function SettingsAllPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const product = useProduct(slug).data;
  const me = useMe().data;
  const values = useQuery({
    queryKey: qk.productSettingsEvery(slug),
    queryFn: () => api.productSettings(slug),
  });
  useLoadingAnnouncement("all settings", values.isPending);
  const [text, setText] = React.useState("");
  const [service, setService] = React.useState<string>(ALL);

  const entries = React.useMemo(
    () =>
      SETTINGS_INDEX.filter(
        (e) =>
          e.scope === "product" &&
          e.pending === null &&
          e.deprecated === null &&
          canIn(me, e.rbacArea as AreaId, slug) &&
          (e.service === "core" ||
            (
              product?.services as
                | Record<string, { enabled?: boolean }>
                | undefined
            )?.[e.service]?.enabled !== false),
      ),
    [me, slug, product?.services],
  );
  const byKey = React.useMemo(
    () => new Map((values.data?.settings ?? []).map((s) => [s.key, s])),
    [values.data],
  );
  const services = [...new Set(entries.map((e) => e.service))];
  const needle = text.trim().toLowerCase();
  const rows = entries.filter(
    (e) =>
      (service === ALL || e.service === service) &&
      (needle === "" ||
        [e.label, e.key, ...e.keywords].some((w) =>
          w.toLowerCase().includes(needle),
        )),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="All settings"
        description="Every setting this product has. Edit one where it lives."
        refetching={values.isFetching && !values.isPending}
      />
      <SettingsSection id="all-settings" title="Settings">
        <div className="flex flex-wrap items-end gap-3 px-5 pt-4">
          <label className="min-w-0 flex-1 basis-56 space-y-1 text-sm text-fg-muted">
            <span>Find a setting</span>
            <Input
              clearable
              value={text}
              onValueChange={setText}
              placeholder="Device limit, origins…"
            />
          </label>
          <div className="w-full space-y-1 text-sm text-fg-muted sm:w-48">
            <span id="all-settings-service">Service</span>
            <Select
              aria-labelledby="all-settings-service"
              value={service}
              onChange={(v) => setService(v ?? ALL)}
              options={[
                { value: ALL, label: "All services" },
                ...services.map((s) => ({
                  value: s,
                  label: serviceLabel(s as never),
                })),
              ]}
            />
          </div>
        </div>
        {values.isError ? (
          <div className="px-5 pt-3">
            <ErrorState
              error={values.error}
              onRetry={() => void values.refetch()}
              compact
            />
          </div>
        ) : null}
        {values.isPending && !values.isError ? (
          <div className="space-y-3 p-5" aria-busy="true">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            kind="no-results"
            variant="inline"
            title="No settings match"
            filters={[
              needle,
              service === ALL ? "" : serviceLabel(service as never),
            ]
              .filter(Boolean)
              .join(", ")}
            onClearFilters={() => {
              setText("");
              setService(ALL);
            }}
          />
        ) : (
          <ScrollTable
            label="All settings"
            caption="Every setting of this product"
            className="w-full min-w-[40rem] text-left text-sm"
          >
            <thead className="text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">
                  Setting
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Value
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Source
                </th>
                <th scope="col" className="px-5 py-2 font-medium">
                  Edit in
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((e) => {
                const live = byKey.get(e.key);
                const home = SETTING_HOMES[e.key];
                return (
                  <tr key={e.key}>
                    <th scope="row" className="px-5 py-3 font-normal">
                      <span className="block font-medium text-fg-strong">
                        {e.label}
                      </span>
                      <code className="text-xs text-fg-muted [overflow-wrap:anywhere]">
                        {e.key}
                      </code>
                    </th>
                    <td className="px-3 py-3">
                      {live ? (
                        formatSettingValue(live.spec, live.value)
                      ) : (
                        <span className="text-fg-muted">
                          {home?.kind === "page"
                            ? "On its page"
                            : "Not shown here"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {live ? (
                        <SourceBadge source={API_SOURCE[live.source]} />
                      ) : (
                        <span className="text-fg-muted">
                          {OWNER[e.ownership]}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <EditIn slug={slug} entry={e} home={home} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </ScrollTable>
        )}
      </SettingsSection>
    </div>
  );
}
