/**
 * Settings → Presentation → Listing (A-18j, moved here by A-27.11; notes/S-15 §8.2, T3): the shared listing model outside the flow.
 * Tabs in the URL (`?tab=`): **Text** (the app's fields and each locale's, with a locale switcher
 * and import), **Fit report** (per store, with per-store overrides), **Images** (the slot board),
 * **Release notes** (per release and locale) and **Push** ("Push listing" per store whose adapter
 * performs it: a plain confirm, never a review submission; Google Play can stage only; the
 * Microsoft Store keeps its pending submission uncommitted).
 *
 * Settings controls sit on the right of their label (T4); listing text is data, shown escaped,
 * never as HTML. A store's push appears here once its adapter registers one (no console change).
 */

import * as React from "react";
import type {
  ListingLocaleDto,
  ListingResponse,
  StorefrontDto,
} from "../../../../../api.js";
import { Button } from "../../../../../ui/Button.js";
import { ErrorState } from "../../../../../ui/ErrorState.js";
import { Form, FormField, useAdminForm } from "../../../../../ui/form.js";
import { Input } from "../../../../../ui/Input.js";
import { SaveBar } from "../../../../../ui/SaveBar.js";
import { Select } from "../../../../../ui/Select.js";
import { Skeleton } from "../../../../../ui/Skeleton.js";
import { Textarea } from "../../../../../ui/Textarea.js";
import { toast } from "../../../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../../../ui/useUnsavedChangesGuard.js";
import { mutate } from "../../../../data/mutations.js";
import { PageHeader } from "../../../../../ui/PageHeader.js";
import { PageTabs } from "../../../../components/PageTabs.js";
import { useSearchParam } from "../../../../router.js";
import { codecs, r } from "../../../../routes.js";
import {
  SettingsRow,
  SettingsSection,
} from "../../../../templates/Settings.js";
import { useListing, useStorefronts } from "../../../storefronts/data.js";
import { FitReport } from "../../../storefronts/components/FitReport.js";
import { ImportPanel } from "../../../storefronts/components/ImportPanel.js";
import { SlotBoard } from "../../../storefronts/components/SlotBoard.js";
import { NotesTab } from "./ListingNotes.js";
import { PushTab } from "./ListingPush.js";

export const LISTING_TABS = ["text", "fit", "images", "notes", "push"] as const;
type ListingTab = (typeof LISTING_TABS)[number];
const TAB_LABELS: Record<ListingTab, string> = {
  text: "Text",
  fit: "Fit report",
  images: "Images",
  notes: "Release notes",
  push: "Push",
};
const tabCodec = codecs.oneOf(LISTING_TABS, "text");
const localeCodec = codecs.string("");

export type { StorefrontId } from "./ListingPush.js";
import type { StorefrontId } from "./ListingPush.js";

/** The line under the header: where an edit shows. */
export const LISTING_SCOPE_NOTE =
  "Changes here show in Polaris Locker, on the download page and on every channel.";

/**
 * The listing editor (A-27.10). Unscoped it is the Listing page: the shared model's text, the fit
 * report of every store, the slot board, release notes and each store's push. With `store` it is
 * that store's view of the same model: its projection and fit row (with its overrides), its image
 * slots and its Push. The text and the release notes are the shared model's either way.
 */
export function ListingEditor({
  slug,
  store,
}: {
  slug: string;
  store?: StorefrontId;
}): React.ReactElement {
  const [tab] = useSearchParam("tab", tabCodec);
  const q = useListing(slug);
  const sf = useStorefronts(slug);
  const scoped =
    store === undefined
      ? null
      : sf.data?.stores.find((s) => s.id === store || s.listingStore === store);
  // The store's listing column (`play`, `ms-store`…); `""` matches no fit row or slot group.
  const column = store === undefined ? undefined : (scoped?.listingStore ?? "");
  return (
    <div className="space-y-6" data-template="record">
      <PageHeader
        title="Listing"
        description={LISTING_SCOPE_NOTE}
        tabs={
          <PageTabs
            label="Listing"
            value={tab}
            items={LISTING_TABS.map((t) => ({
              value: t,
              label: TAB_LABELS[t],
              to: r.listing(slug, {
                ...(t === "text" ? {} : { tab: t }),
                ...(store === undefined ? {} : { store }),
              }),
            }))}
          />
        }
      />
      <div className="pk-vt-tabpanel" data-scope={store ?? "all"}>
        {q.isPending || (store !== undefined && sf.isPending) ? (
          <Skeleton className="h-64 w-full" />
        ) : q.isError ? (
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ area: "distribution", thing: "Listing" }}
          />
        ) : tab === "text" ? (
          <TextTab slug={slug} data={q.data} />
        ) : tab === "fit" ? (
          <FitTab slug={slug} column={column} />
        ) : tab === "images" ? (
          <SlotBoard
            slug={slug}
            {...(column === undefined ? {} : { groups: ["masters", column] })}
          />
        ) : tab === "notes" ? (
          <NotesTab slug={slug} data={q.data} />
        ) : (
          <PushTab slug={slug} store={store} />
        )}
      </div>
    </div>
  );
}

/**
 * The fit report: every store's row, or the scoped store's alone with its overrides. The store
 * switcher is the page's (`PresentationListingPage`), not the report's.
 */
function FitTab({
  slug,
  column,
}: {
  slug: string;
  column: string | undefined;
}): React.ReactElement {
  return (
    <FitReport
      slug={slug}
      {...(column === undefined ? {} : { stores: [column] })}
    />
  );
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────

interface Draft {
  defaultLocale: string;
  appName: string;
  developerName: string;
  category: string;
  contactEmail: string;
  copyright: string;
  website: string;
  support: string;
  privacy: string;
  marketing: string;
  name: string;
  subtitle: string;
  shortDescription: string;
  description: string;
  keywords: string;
  features: string;
  promotionalText: string;
}

const APP_KEYS = [
  ["appName", "name"],
  ["developerName", "developerName"],
  ["category", "category"],
  ["contactEmail", "contactEmail"],
  ["copyright", "copyright"],
] as const;
const URL_KEYS = ["website", "support", "privacy", "marketing"] as const;
const TEXT_KEYS = [
  "name",
  "subtitle",
  "shortDescription",
  "description",
  "promotionalText",
] as const;

function draftOf(data: ListingResponse, locale: string): Draft {
  const app = data.listing?.app;
  const l: Partial<ListingLocaleDto> =
    data.locales.find((x) => x.locale === locale) ?? {};
  return {
    defaultLocale: app?.defaultLocale ?? locale,
    appName: app?.name ?? "",
    developerName: app?.developerName ?? "",
    category: app?.category ?? "",
    contactEmail: app?.contactEmail ?? "",
    copyright: app?.copyright ?? "",
    website: app?.urls?.website ?? "",
    support: app?.urls?.support ?? "",
    privacy: app?.urls?.privacy ?? "",
    marketing: app?.urls?.marketing ?? "",
    name: l.name ?? "",
    subtitle: l.subtitle ?? "",
    shortDescription: l.shortDescription ?? "",
    description: l.description ?? "",
    keywords: (l.keywords ?? []).join(", "),
    features: (l.features ?? []).join("\n"),
    promotionalText: l.promotionalText ?? "",
  };
}

const orNull = (v: string): string | null =>
  v.trim() === "" ? null : v.trim();

/** The PUT body: only what changed (an edit owns only the fields it changed, A-18c). */
export function listingPatch(
  server: Draft,
  draft: Draft,
  locale: string,
  creating: boolean,
): Record<string, unknown> {
  const app: Record<string, unknown> = {};
  if (creating || draft.defaultLocale !== server.defaultLocale)
    app.defaultLocale = draft.defaultLocale.trim();
  for (const [k, f] of APP_KEYS)
    if (draft[k] !== server[k]) app[f] = orNull(draft[k]);
  if (URL_KEYS.some((k) => draft[k] !== server[k])) {
    const urls = Object.fromEntries(
      URL_KEYS.filter((k) => draft[k].trim() !== "").map((k) => [
        k,
        draft[k].trim(),
      ]),
    );
    app.urls = Object.keys(urls).length ? urls : null;
  }
  const loc: Record<string, unknown> = {};
  for (const k of TEXT_KEYS)
    if (draft[k] !== server[k])
      loc[k] =
        k === "description"
          ? draft[k] === ""
            ? null
            : draft[k]
          : orNull(draft[k]);
  if (draft.keywords !== server.keywords) {
    const list = draft.keywords
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    loc.keywords = list.length ? list : null;
  }
  if (draft.features !== server.features) {
    const list = draft.features
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
    loc.features = list.length ? list : null;
  }
  return {
    ...(Object.keys(app).length ? { app } : {}),
    ...(Object.keys(loc).length ? { locales: { [locale]: loc } } : {}),
  };
}

function TextTab({
  slug,
  data,
}: {
  slug: string;
  data: ListingResponse;
}): React.ReactElement {
  const fallback = data.listing?.app.defaultLocale ?? "en-US";
  const [localeRaw, setLocale] = useSearchParam("locale", localeCodec);
  const locale = localeRaw || fallback;
  const [newLocale, setNewLocale] = React.useState("");
  const values = React.useMemo(() => draftOf(data, locale), [data, locale]);
  const creating = data.listing === null;
  const form = useAdminForm<Draft>({
    values,
    resetOn: [data.listing?.modifiedAt ?? 0, locale, data.locales.length],
    onSubmit: async (draft, { server }) => {
      const body = listingPatch(server, draft, locale, creating);
      if (Object.keys(body).length === 0) return;
      await mutate("putListing", slug, body);
      toast.success("Listing saved");
    },
  });
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard your changes to the listing?",
    onDiscard: form.discard,
  });
  const locales = [
    ...new Set([fallback, ...data.locales.map((l) => l.locale), locale]),
  ];
  const limit = (k: string): number | undefined => {
    const v = data.limits[k];
    return typeof v === "number" ? v : undefined;
  };
  const text = (
    name: keyof Draft,
    label: string,
    help?: string,
    opts: { long?: boolean; max?: number; mono?: boolean } = {},
  ) => (
    <SettingsRow label={label} help={help}>
      <FormField
        className={opts.long ? "w-full sm:w-[32rem]" : "w-full sm:w-80"}
        hideLabel
        name={name}
        label={label}
      >
        {(f) =>
          opts.long ? (
            <Textarea {...f} maxLength={opts.max} />
          ) : (
            <Input
              {...f}
              maxLength={opts.max}
              mono={opts.mono}
              autoComplete="off"
            />
          )
        }
      </FormField>
    </SettingsRow>
  );

  return (
    <div className="space-y-6">
      <Form form={form} aria-label="Listing text" className="space-y-6">
        <SettingsSection id="listing-app" title="App">
          {text(
            "defaultLocale",
            "Default locale",
            "The locale every store falls back to.",
            {
              mono: true,
              max: 35,
            },
          )}
          {text("appName", "Name", undefined, { max: limit("name") })}
          {text("developerName", "Developer name", undefined, {
            max: limit("developerName"),
          })}
          {text(
            "category",
            "Category id",
            "Lowercase with hyphens, such as games-puzzle.",
            {
              mono: true,
              max: limit("category"),
            },
          )}
          {text("contactEmail", "Contact email", undefined, {
            max: limit("contactEmail"),
          })}
          {text("copyright", "Copyright", undefined, {
            max: limit("copyright"),
          })}
          {text("website", "Website", "https only.", { mono: true })}
          {text("support", "Support URL", undefined, { mono: true })}
          {text("privacy", "Privacy policy URL", undefined, { mono: true })}
          {text("marketing", "Marketing URL", undefined, { mono: true })}
        </SettingsSection>
        <SettingsSection
          id="listing-locale"
          title={`Text in ${locale}`}
          actions={
            <Select
              aria-label="Locale"
              options={locales.map((l) => ({ value: l, label: l }))}
              value={locale}
              onChange={(v) => v && setLocale(v === fallback ? "" : v)}
            />
          }
          footer={<SaveBar form={form} saveLabel="Save listing" />}
        >
          {text(
            "name",
            "Name in this locale",
            "Overrides the app's name here.",
            {
              max: limit("name"),
            },
          )}
          {text("subtitle", "Subtitle", undefined, { max: limit("subtitle") })}
          {text("shortDescription", "Short description", undefined, {
            max: limit("shortDescription"),
          })}
          {text("description", "Description", undefined, {
            long: true,
            max: limit("description"),
          })}
          {text("keywords", "Keywords", "Comma-separated.", { long: false })}
          {text("features", "Features", "One per line.", { long: true })}
          {text("promotionalText", "Promotional text", undefined, {
            max: limit("promotionalText"),
          })}
          <SettingsRow label="Add a locale" help="A code such as de-DE.">
            <div className="flex items-center gap-2">
              <Input
                aria-label="New locale"
                value={newLocale}
                onValueChange={setNewLocale}
                mono
                className="w-32"
                autoComplete="off"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(newLocale)
                }
                onClick={() => {
                  setLocale(newLocale);
                  setNewLocale("");
                }}
              >
                Add
              </Button>
            </div>
          </SettingsRow>
        </SettingsSection>
      </Form>
      <SettingsSection id="listing-import" title="Import">
        <div className="px-5 py-4">
          <ImportPanel slug={slug} />
        </div>
      </SettingsSection>
      {guard.dialog}
    </div>
  );
}
