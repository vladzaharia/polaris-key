/**
 * Distribution → Listing (A-18j; notes/S-15 §8.2, T3): the shared listing model outside the flow.
 * Tabs in the URL (`?tab=`): **Text** (the app's fields and each locale's, with a locale switcher
 * and import), **Fit report** (per store, with per-store overrides), **Images** (the slot board),
 * **Release notes** (per release and locale) and **Push** ("Push listing" per store whose adapter
 * performs it: a plain confirm, never a review submission; Google Play can stage only; the
 * Microsoft Store keeps its pending submission uncommitted).
 *
 * Settings controls sit on the right of their label (T4); listing text is data and is shown
 * escaped, never as HTML. A store's push appears here as soon as its adapter registers one (A-18m's
 * Apple listing push included), with no console change.
 */

import * as React from "react";
import type {
  ListingLocaleDto,
  ListingResponse,
  StorefrontDto,
  StorefrontFollowUp,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Form, FormField, useAdminForm } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { Select } from "../../../../ui/Select.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { mutate } from "../../../data/mutations.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { PageTabs } from "../../../components/PageTabs.js";
import { useSearchParam } from "../../../router.js";
import { codecs, r } from "../../../routes.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { useReleaseStore } from "../../distribution/data.js";
import {
  newIdempotencyKey,
  useListing,
  useReleaseNotes,
  useStorefronts,
} from "../data.js";
import { FitReport } from "../components/FitReport.js";
import { FollowUpNote } from "../components/FollowUpNote.js";
import { followUpOf } from "../components/StepDialog.js";
import { ImportPanel } from "../components/ImportPanel.js";
import { SlotBoard } from "../components/SlotBoard.js";

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
const releaseCodec = codecs.string("");
const storeCodec = codecs.string("");

export function ListingPage({ slug }: { slug: string }): React.ReactElement {
  const [tab] = useSearchParam("tab", tabCodec);
  const q = useListing(slug);
  return (
    <div className="space-y-6" data-template="record">
      <PageHeader
        title="Listing"
        tabs={
          <PageTabs
            label="Listing"
            value={tab}
            items={LISTING_TABS.map((t) => ({
              value: t,
              label: TAB_LABELS[t],
              to: r.listing(slug, t === "text" ? {} : { tab: t }),
            }))}
          />
        }
      />
      {q.isPending ? (
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
        <FitTab slug={slug} />
      ) : tab === "images" ? (
        <SlotBoard slug={slug} />
      ) : tab === "notes" ? (
        <NotesTab slug={slug} data={q.data} />
      ) : (
        <PushTab slug={slug} />
      )}
    </div>
  );
}

/** The fit report with its store switcher, the store in the URL (`?store=`, PS-06). */
function FitTab({ slug }: { slug: string }): React.ReactElement {
  const [store, setStore] = useSearchParam("store", storeCodec);
  return (
    <FitReport slug={slug} storeFilter={{ value: store, onChange: setStore }} />
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

// ── Release notes ────────────────────────────────────────────────────────────────────────────

function NotesTab({
  slug,
  data,
}: {
  slug: string;
  data: ListingResponse;
}): React.ReactElement {
  const releases = useReleaseStore(slug);
  const [releaseRaw, setRelease] = useSearchParam("release", releaseCodec);
  const list = (releases.data?.releases ?? []).filter(
    (x) => x.deliverable === "app",
  );
  const release = releaseRaw || list[0]?.releaseId || "";
  const notes = useReleaseNotes(slug, release || null);
  if (releases.isPending) return <Skeleton className="h-48 w-full" />;
  if (list.length === 0)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="No releases yet"
        description="Each release's store notes are edited here once it is published."
        docs="/docs/admin/storefront-listing/"
      />
    );
  return (
    <SettingsSection
      id="listing-notes"
      title="Store notes"
      actions={
        <Select
          aria-label="Release"
          options={list.map((x) => ({ value: x.releaseId, label: x.version }))}
          value={release}
          onChange={(v) => v && setRelease(v)}
        />
      }
    >
      {notes.isPending ? (
        <div className="p-5">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : notes.isError ? (
        <div className="p-5">
          <ErrorState
            error={notes.error}
            onRetry={() => void notes.refetch()}
            context={{ area: "distribution", thing: "Release notes" }}
          />
        </div>
      ) : (
        [
          ...notes.data.notes.locales,
          ...data.locales
            .map((l) => l.locale)
            .filter(
              (l) => !notes.data.notes.locales.some((n) => n.locale === l),
            )
            .map((l) => ({
              locale: l,
              text: "",
              short: null,
              source: "none",
              proposedShort: null,
              modifiedAt: null,
              modifiedBy: null,
            })),
        ].map((n) => (
          <NoteRow
            key={`${release}:${n.locale}`}
            slug={slug}
            release={release}
            note={n}
            limits={notes.data.limits}
          />
        ))
      )}
    </SettingsSection>
  );
}

function NoteRow({
  slug,
  release,
  note,
  limits,
}: {
  slug: string;
  release: string;
  note: {
    locale: string;
    text: string;
    short: string | null;
    source: string;
    proposedShort: string | null;
  };
  limits: { short: number; text: number };
}): React.ReactElement {
  const [text, setText] = React.useState(note.text);
  const [short, setShort] = React.useState(note.short ?? "");
  const [busy, setBusy] = React.useState(false);
  const dirty = text !== note.text || short !== (note.short ?? "");
  const save = async () => {
    setBusy(true);
    try {
      await mutate("putListingReleaseNotes", slug, release, {
        locale: note.locale,
        text: text.trim() === "" ? null : text,
        short: short.trim() === "" ? null : short,
      });
      toast.success(`Notes saved for ${note.locale}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      label={note.locale}
      help={
        note.source === "default"
          ? "From the release's own notes until you save it."
          : `Up to ${limits.text} characters; the short form, for Google Play and F-Droid, up to ${limits.short}.`
      }
      align="stretch"
    >
      <div className="space-y-2">
        <Textarea
          aria-label={`Notes in ${note.locale}`}
          value={text}
          onValueChange={setText}
          maxLength={limits.text}
        />
        <Textarea
          aria-label={`Short notes in ${note.locale}`}
          value={short}
          placeholder={note.proposedShort ?? undefined}
          onValueChange={setShort}
          maxLength={limits.short}
        />
        <div className="flex justify-end gap-2">
          {note.proposedShort && short === "" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShort(note.proposedShort!)}
            >
              Use the proposed short form
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={!dirty}
            loading={busy}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}

// ── Push ─────────────────────────────────────────────────────────────────────────────────────

function PushTab({ slug }: { slug: string }): React.ReactElement {
  const q = useStorefronts(slug);
  const [pushing, setPushing] = React.useState<StorefrontDto | null>(null);
  // What each store's last push left to finish in its console (decision 6), by store id.
  const [followUps, setFollowUps] = React.useState<
    Record<string, StorefrontFollowUp>
  >({});
  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.isError)
    return (
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        context={{ area: "distribution", thing: "Storefronts" }}
      />
    );
  const stores = q.data.stores.filter((s) => s.pushListing !== null);
  if (stores.length === 0)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="No store takes a listing push"
        description="Stores whose listing Polaris Key can write appear here."
        docs="/docs/admin/storefronts/"
      />
    );
  return (
    <>
      <SettingsSection id="listing-push" title="Push listing">
        {stores.map((s) => (
          <SettingsRow
            key={s.id}
            label={s.label}
            help={
              s.readOnly ??
              (s.app
                ? `Text and accepted images go to ${s.app.name ?? s.app.id}.`
                : "Assign the product's app in Platform → Store connections first.")
            }
          >
            <Button
              size="sm"
              disabled={s.readOnly !== null || s.app === null}
              onClick={() => setPushing(s)}
            >
              Push listing
            </Button>
          </SettingsRow>
        ))}
      </SettingsSection>
      {stores
        .filter((s) => followUps[s.id])
        .map((s) => (
          <FollowUpNote
            key={s.id}
            followUp={followUps[s.id]!}
            storeLabel={s.label}
          />
        ))}
      <PushDialog
        slug={slug}
        store={pushing}
        onClose={() => setPushing(null)}
        onDone={(store, result) =>
          setFollowUps((s) => {
            const { [store]: _, ...rest } = s;
            const f = followUpOf(result);
            return f ? { ...rest, [store]: f } : rest;
          })
        }
      />
    </>
  );
}

function PushDialog({
  slug,
  store,
  onClose,
  onDone,
}: {
  slug: string;
  store: StorefrontDto | null;
  onClose: () => void;
  onDone: (store: string, result: unknown) => void;
}): React.ReactElement | null {
  const key = React.useMemo(() => (store ? newIdempotencyKey() : ""), [store]);
  if (!store) return null;
  const canStage = store.pushListing?.stageOnly === true;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Push the listing to ${store.label}?`}
      consequences={[
        `${store.label} receives every locale's listing text and the accepted images.`,
        canStage
          ? "The change is staged: nothing is sent for review until you submit."
          : "The pending submission stays uncommitted: nothing goes to certification.",
        "No image is deleted: older ones stay until you remove them in the store's console. The result counts them and links the page.",
      ]}
      confirmLabel="Push listing"
      describeError={(e) =>
        errorCopy(e, { area: "distribution", thing: "Listing push" })
      }
      onConfirm={async () => {
        const result = await mutate(
          "pushListing",
          slug,
          store.id,
          {},
          { idempotencyKey: key },
        );
        toast.success(`Listing pushed to ${store.label}`);
        onDone(store.id, result);
      }}
    />
  );
}
