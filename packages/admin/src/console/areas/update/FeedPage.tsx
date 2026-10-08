/**
 * Update → Feed (ADMIN.md §2.3, T4): what the update feeds offer and to whom — Update settings
 * minus delivery access (now Distribution → Access). Fixes UPS-1 to UPS-7.
 *
 * Four sections, three of them saved on their own (one form and SaveBar each; UPS-1, UPS-6), all
 * through `PATCH …/update/settings` with only that section's fields:
 *
 * - **Metadata access** (manifest-owned until saved; Revert to manifest while the console owns
 *   it, UPS-7). Needs a release configuration: without one it is read-only and says why.
 * - **Compatibility window** (manifest-owned until saved), validated as versions.
 * - **Artifact policy** (operator-only: no manifest writes it). Turning the Sparkle signature
 *   requirement off is L2.
 * - **Endpoints**: the public feed URLs per channel, with copy. The updater feeds are scoped to
 *   the platforms the product's releases ship (P0-47): Sparkle for macOS, WinSparkle for Windows.
 *   While no release names a platform, every updater feed is listed.
 *
 * Artifact access is shown read-only with a link to Distribution → Access, its one owner.
 */

import * as React from "react";
import type { ReleaseStoreResponse, UpdateSettings } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import {
  ACCESS_DESCRIPTIONS,
  ACCESS_LABELS,
  PLATFORM_LABELS,
} from "../../../lib/labels.js";
import { versionRangeError } from "../../../lib/version.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Form, FormField, useAdminForm } from "../../../ui/form.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { Switch } from "../../../ui/Switch.js";
import { toast } from "../../../ui/toast.js";
import { VersionInput, versionError } from "../../../ui/VersionInput.js";
import { Input } from "../../../ui/Input.js";
import { PageHeader } from "../../components/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../templates/Settings.js";
import { useAccess, useFeed, useReleaseStore } from "../distribution/data.js";
import { publicUrl } from "../distribution/format.js";
import {
  serverFieldErrors,
  SubmitCancelled,
  SubmitError,
} from "../distribution/forms.js";

type Mode = UpdateSettings["metadataAccess"];
const MODES: Mode[] = ["public", "authenticated", "licensed", "entitled"];
const METADATA_DESCRIPTIONS: Record<Mode, string> = {
  public: "Anyone, with no device token.",
  authenticated: ACCESS_DESCRIPTIONS.authenticated!,
  licensed: ACCESS_DESCRIPTIONS.licensed!,
  entitled:
    "Licensed, and the license's own channels and version window decide what the feed offers it.",
};

const SECTIONS = [
  { id: "feed-access", title: "Metadata access" },
  { id: "feed-compat", title: "Compatibility window" },
  { id: "feed-policy", title: "Artifact policy" },
  { id: "feed-endpoints", title: "Endpoints" },
];

export function FeedPage({ slug }: { slug: string }): React.ReactElement {
  const feed = useFeed(slug);
  return (
    <SettingsTemplate
      header={
        <PageHeader
          title="Feed"
          refetching={feed.isFetching && !feed.isPending}
        />
      }
      sections={SECTIONS}
    >
      {feed.isPending ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label="Loading the feed settings"
        >
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : feed.isError || !feed.data ? (
        <ErrorState
          error={feed.error}
          onRetry={() => void feed.refetch()}
          context={{ thing: "Update settings" }}
        />
      ) : (
        <>
          {!feed.data.configured ? (
            <Callout tone="info" title="No release configuration yet">
              The access mode and the artifact policy are stored with the
              product's release configuration, which a linked repo's
              .pkey/release block creates on its next resync. Until then the
              feed serves the defaults shown here; the compatibility window can
              still be changed.{" "}
              <a
                className="text-accent-fg underline-offset-4 hover:underline"
                href={docsUrl("updateAccessNote")}
                target="_blank"
                rel="noreferrer"
              >
                Learn more
              </a>
            </Callout>
          ) : null}
          <AccessSection slug={slug} settings={feed.data} />
          <CompatSection slug={slug} settings={feed.data} />
          <PolicySection slug={slug} settings={feed.data} />
          <EndpointsSection slug={slug} />
        </>
      )}
    </SettingsTemplate>
  );
}

function RevertConfirm({
  slug,
  block,
  open,
  onOpenChange,
}: {
  slug: string;
  block: "access" | "compat";
  open: boolean;
  onOpenChange: (o: boolean) => void;
}): React.ReactElement {
  const name =
    block === "access" ? "metadata access mode" : "compatibility window";
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent="caution"
      title={`Return the ${name} to the manifest?`}
      consequences={[
        "The live value stays as it is until the next resync.",
        "The next resync re-applies the value from .pkey/release.",
      ]}
      confirmLabel="Revert to manifest"
      describeError={(e) => errorCopy(e, { thing: "Update settings" })}
      onConfirm={async () => {
        await mutate("revertUpdateSettings", slug, [block]);
        toast.success(`The ${name} returns to the manifest on the next resync`);
      }}
    />
  );
}

function AccessSection({
  slug,
  settings,
}: {
  slug: string;
  settings: UpdateSettings;
}): React.ReactElement {
  const access = useAccess(slug);
  const [reverting, setReverting] = React.useState(false);
  const form = useAdminForm<{ metadataAccess: Mode }>({
    values: { metadataAccess: settings.metadataAccess },
    mapServerErrors: serverFieldErrors,
    onSubmit: async (v) => {
      await mutate("saveUpdateSettings", slug, {
        metadataAccess: v.metadataAccess,
      });
      toast.success(
        `Metadata access set to ${ACCESS_LABELS[v.metadataAccess] ?? v.metadataAccess}`,
      );
    },
  });
  const admin = settings.accessSource === "admin";
  const locked = !settings.configured;
  return (
    <Form form={form} aria-label="Metadata access">
      <SettingsSection
        id="feed-access"
        title="Metadata access"
        description="The version check, the changelog and the installer page."
        source={
          <SourceBadge
            source={admin ? "admin" : "manifest"}
            path=".pkey/release"
            onRevert={
              admin && settings.configured
                ? () => setReverting(true)
                : undefined
            }
          />
        }
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ thing: "Update settings" }}
            />
            <SaveBar form={form} section="Metadata access" />
          </>
        }
      >
        {/* The section title names the choice; the radio group keeps its own label for AT. */}
        <div className="space-y-3 px-5 py-4">
          {locked || admin ? (
            <p className="text-sm text-fg-muted">
              {locked
                ? "Read-only until the product has a release configuration."
                : "Set in the console: it survives a resync until it is reverted."}
            </p>
          ) : null}
          <FormField<Mode>
            name="metadataAccess"
            label="Who may read it"
            hideLabel
            group
            disabled={locked}
          >
            {(field) => (
              <RadioCards<Mode>
                {...field}
                readOnly={locked}
                columns={4}
                options={MODES.map((m) => ({
                  value: m,
                  label: ACCESS_LABELS[m] ?? m,
                  description: METADATA_DESCRIPTIONS[m],
                }))}
              />
            )}
          </FormField>
        </div>
        <SettingsRow label="Artifact access">
          {access.isPending ? (
            <Skeleton className="h-5 w-40" />
          ) : access.data ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-fg-strong">
                {ACCESS_LABELS[access.data.app.mode] ?? access.data.app.mode}
              </span>
              <Link
                to={r.access(slug)}
                className="text-accent-fg underline-offset-4 hover:underline"
              >
                Change in Distribution → Access
              </Link>
            </span>
          ) : (
            <span className="text-fg-muted">
              {errorCopy(access.error).title}.{" "}
              <Link
                to={r.access(slug)}
                className="text-accent-fg underline-offset-4 hover:underline"
              >
                Open Distribution → Access
              </Link>
            </span>
          )}
        </SettingsRow>
      </SettingsSection>
      <RevertConfirm
        slug={slug}
        block="access"
        open={reverting}
        onOpenChange={setReverting}
      />
    </Form>
  );
}

function CompatSection({
  slug,
  settings,
}: {
  slug: string;
  settings: UpdateSettings;
}): React.ReactElement {
  const [reverting, setReverting] = React.useState(false);
  const form = useAdminForm<{ compatMin: string; compatMax: string }>({
    values: { compatMin: settings.compatMin, compatMax: settings.compatMax },
    mapServerErrors: serverFieldErrors,
    validate: (v) => {
      const e: Record<string, string> = {};
      const min = versionError(v.compatMin, { required: true });
      const max = versionError(v.compatMax, { required: true });
      if (min) e.compatMin = min;
      if (max) e.compatMax = max;
      if (!min && !max) {
        const range = versionRangeError(v.compatMin, v.compatMax);
        if (range)
          e[range.field === "min" ? "compatMin" : "compatMax"] = range.message;
      }
      return e;
    },
    onSubmit: async (v, { server }) => {
      const body: { compatMin?: string; compatMax?: string } = {};
      if (v.compatMin.trim() !== server.compatMin)
        body.compatMin = v.compatMin.trim();
      if (v.compatMax.trim() !== server.compatMax)
        body.compatMax = v.compatMax.trim();
      await mutate("saveUpdateSettings", slug, body);
      toast.success("Compatibility window saved");
    },
  });
  const admin = settings.compatSource === "admin";
  return (
    <Form form={form} aria-label="Compatibility window">
      <SettingsSection
        id="feed-compat"
        title="Compatibility window"
        description="Every license grant is intersected with this window."
        source={
          <SourceBadge
            source={admin ? "admin" : "manifest"}
            path=".pkey/release"
            onRevert={admin ? () => setReverting(true) : undefined}
          />
        }
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ thing: "Update settings" }}
            />
            <SaveBar form={form} section="Compatibility window" />
          </>
        }
      >
        <div className="px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField<string>
              name="compatMin"
              label="Lowest supported"
              required
            >
              {(field) => <VersionInput {...field} placeholder="0.0.0" />}
            </FormField>
            <FormField<string>
              name="compatMax"
              label="Highest supported"
              required
            >
              {(field) => <VersionInput {...field} placeholder="99.0.0" />}
            </FormField>
          </div>
        </div>
      </SettingsSection>
      <RevertConfirm
        slug={slug}
        block="compat"
        open={reverting}
        onOpenChange={setReverting}
      />
    </Form>
  );
}

function PolicySection({
  slug,
  settings,
}: {
  slug: string;
  settings: UpdateSettings;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const decide = React.useRef<((ok: boolean) => void) | null>(null);
  const locked = !settings.configured;
  const form = useAdminForm<{
    minimumSystemVersion: string;
    requireSparkleSignature: boolean;
  }>({
    values: {
      minimumSystemVersion: settings.minimumSystemVersion ?? "",
      requireSparkleSignature: settings.requireSparkleSignature,
    },
    mapServerErrors: serverFieldErrors,
    onSubmit: async (v, { server }) => {
      if (server.requireSparkleSignature && !v.requireSparkleSignature) {
        const ok = await new Promise<boolean>((resolve) => {
          decide.current = resolve;
          setConfirming(true);
        });
        if (!ok) throw new SubmitCancelled();
      }
      const body: {
        minimumSystemVersion?: string | null;
        requireSparkleSignature?: boolean;
      } = {};
      const min = v.minimumSystemVersion.trim();
      if (min !== (server.minimumSystemVersion ?? ""))
        body.minimumSystemVersion = min === "" ? null : min;
      if (v.requireSparkleSignature !== server.requireSparkleSignature)
        body.requireSparkleSignature = v.requireSparkleSignature;
      await mutate("saveUpdateSettings", slug, body);
      toast.success("Artifact policy saved");
    },
  });
  const answer = (ok: boolean) => {
    decide.current?.(ok);
    decide.current = null;
    setConfirming(false);
  };
  return (
    <Form form={form} aria-label="Artifact policy">
      <SettingsSection
        id="feed-policy"
        title="Artifact policy"
        description="Set only here: no manifest writes these, and a resync never changes them."
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ thing: "Update settings" }}
            />
            <SaveBar form={form} section="Artifact policy" />
          </>
        }
      >
        <SettingsRow
          label="Minimum macOS version"
          help="Leave empty for no minimum."
        >
          <FormField<string>
            name="minimumSystemVersion"
            label="Minimum macOS version"
            hideLabel
            disabled={locked}
            className="w-40"
          >
            {(field) => (
              <Input
                {...field}
                mono
                autoComplete="off"
                placeholder="13.0"
                readOnly={locked}
              />
            )}
          </FormField>
        </SettingsRow>
        <SettingsRow
          label="Signatures"
          help="The appcast lists a DMG only with a verified EdDSA signature. Turning this off lets an unsigned build reach every updater."
        >
          <FormField<boolean>
            name="requireSparkleSignature"
            label="Require Sparkle signatures"
            hideLabel
            group
            disabled={locked}
          >
            {(field) => (
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={locked}
                aria-labelledby={field["aria-labelledby"]}
                label={field.value ? "Required" : "Not required"}
              />
            )}
          </FormField>
        </SettingsRow>
      </SettingsSection>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => {
          if (!o) answer(false);
        }}
        intent="danger"
        title="Turn off the Sparkle signature requirement?"
        consequences={[
          "The feed lists builds with no verified EdDSA signature, so an unsigned or tampered DMG can reach every updater.",
          "The change is recorded in the audit log.",
        ]}
        confirmLabel="Turn off signatures"
        closeOnSuccess={false}
        onConfirm={() => answer(true)}
      />
    </Form>
  );
}

/** The platforms the product's releases ship a build or a file for (`RELEASE_PLATFORMS`). */
export function shippedPlatforms(
  store: ReleaseStoreResponse | undefined,
): string[] {
  const set = new Set<string>();
  for (const rel of store?.releases ?? []) {
    for (const b of rel.builds) if (b.platform) set.add(b.platform);
    for (const a of rel.artifacts) if (a.platform) set.add(a.platform);
  }
  return [...set].sort();
}

/**
 * The endpoint rows for these channels and shipped platforms. Discovery, the version check and
 * the signed feed serve every platform; the Sparkle appcasts are listed only when macOS ships and
 * WinSparkle only when Windows does. With no platform known yet, every updater is listed.
 */
export function endpointRows(
  channels: readonly string[],
  platforms: readonly string[],
): { label: string; path: string }[] {
  const known = platforms.length > 0;
  const mac = !known || platforms.includes("macos");
  const win = !known || platforms.includes("windows");
  return [
    { label: "Discovery", path: ".well-known/polaris.json" },
    { label: "Version check", path: "update/version" },
    ...(mac ? [{ label: "Sparkle appcast", path: "update/appcast.xml" }] : []),
    ...channels.flatMap((c) => [
      { label: `Signed feed · ${c}`, path: `update/${c}/feed.jws` },
      ...(mac
        ? [{ label: `Sparkle appcast · ${c}`, path: `update/${c}/appcast.xml` }]
        : []),
      ...(win
        ? [{ label: `WinSparkle · ${c}`, path: `update/${c}/winsparkle.xml` }]
        : []),
    ]),
  ];
}

/** "macOS and Windows". */
function platformList(platforms: readonly string[]): string {
  const names = platforms.map((p) => PLATFORM_LABELS[p] ?? p);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function EndpointsSection({ slug }: { slug: string }): React.ReactElement {
  const store = useReleaseStore(slug);
  const channels = React.useMemo(() => {
    const set = new Set<string>(["stable"]);
    for (const c of store.data?.channels ?? []) set.add(c.channel);
    return [...set].sort((a, b) =>
      a === "stable" ? -1 : b === "stable" ? 1 : a.localeCompare(b),
    );
  }, [store.data]);
  const platforms = React.useMemo(
    () => shippedPlatforms(store.data),
    [store.data],
  );
  const rows = endpointRows(channels, platforms);
  return (
    <SettingsSection
      id="feed-endpoints"
      title="Endpoints"
      description={
        platforms.length > 0
          ? `Point an app at discovery; it finds the rest. Updater feeds are listed for the platforms your releases ship: ${platformList(platforms)}.`
          : "Point an app at discovery; it finds the rest."
      }
    >
      <ul className="space-y-2 px-5 py-4" aria-label="Feed endpoints">
        {rows.map((row) => {
          const url = publicUrl(slug, row.path);
          return (
            <li
              key={row.path}
              className="flex flex-wrap items-center gap-2 sm:flex-nowrap"
            >
              <span className="w-full shrink-0 text-xs font-bold text-fg-muted sm:w-44">
                {row.label}
              </span>
              <code className="min-w-0 flex-1 truncate rounded-sm bg-surface-sunken px-2 py-1 font-mono text-xs">
                {url}
              </code>
              <CopyButton value={url} label={`Copy the ${row.label} URL`} />
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
