/**
 * A feed's Settings tab (T4 nested in the feed's T3; notes/S-12 §10.1), in four sections. One
 * settings model with per-ecosystem extensions, saved section by section: each section is its own
 * form and SaveBar over `PUT …/feeds/:eco/settings` with the version it read (`expectedVersion`,
 * 409 when someone saved first). Never one Save across two endpoints: the platform policy
 * (platform scope only) is its own resource and its own section.
 *
 * - **General:** enabled, and Access: Public or Customers (F-34). Customers is the stored
 *   `licensed`; an old `entitled` feed reads "Customers, packages gated individually" and is not
 *   rewritten unless the operator picks again. Turning a feed off, and moving access either way,
 *   is L1: Public to Customers refuses anonymous clients within 30 seconds; Customers to Public
 *   opens the feed to everyone.
 * - **Namespace:** the dependency-confusion rule ingest enforces, one row per namespace field
 *   the ecosystem's ingest rules declare (scope, prefixes, groups, publisher). A namespace the
 *   `.pkey/release` provisioning derived reads "Derived from .pkey/release" with Override. OCI
 *   declares none: its namespace is the owner itself.
 * - **Limits:** the size ceiling, at most the platform's.
 * - **The ecosystem panel:** `FEED_PANELS` (F-12): the extension settings the feed's adapter
 *   declares, edited by name from `FEED_EXTENSION_FIELDS` (HTML pages, signing, repository URLs,
 *   the asset listing), saved into `ext_json`.
 * - **Platform policy** (platform scope): moved to Platform settings (ST-09); a pointer remains.
 *
 * Gone: Yank policy (Maven always hides yanked versions), Untagged manifests (OCI keeps every
 * manifest) and the Godot category (stored values stay the fallback).
 */

import * as React from "react";
import { PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import {
  ApiError,
  type FeedDetailDto,
  type FeedEcosystem,
  type FeedSettingsWrite,
} from "../../../../api.js";
import {
  Globe,
  KeyRound,
  Package,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { Form, FormField, useAdminForm } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { Select } from "../../../../ui/Select.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { intentOf } from "../../core/pages/confirmGate.js";
import { SaveCancelled, useConfirmGate } from "../../core/pages/confirmGate.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import {
  serverFieldErrors,
  SubmitError,
} from "../../distribution/components/forms.js";
import {
  ECOSYSTEMS,
  accessDisplayLabel,
  ECOSYSTEM_LABELS,
  FEED_ACCESS_DESCRIPTIONS,
  FEED_EXTENSION_FIELDS,
  FEED_PANEL_TITLES,
  FEED_ACCESS_LABELS,
  bytesToMiB,
  feedAccessChoice,
  feedAccessMode,
  mibToBytes,
  tokensHref,
  type FeedScope,
} from "../model/model.js";
import { Link } from "../../../router.js";

/** What an ecosystem panel receives (F-12 adds one per ecosystem to `FEED_PANELS`). */
export interface FeedPanelProps {
  scope: FeedScope;
  eco: FeedEcosystem;
  detail: FeedDetailDto;
  /** Save a patch of the feed's settings at the version this tab read. */
  save: (patch: Omit<FeedSettingsWrite, "expectedVersion">) => Promise<void>;
}

/**
 * The per-ecosystem settings panels, rendered after the common sections (F-12). One component
 * serves every ecosystem: it renders the extension settings the feed's adapter declares
 * (`detail.extensions`) from `FEED_EXTENSION_FIELDS`, and nothing for a feed that has none.
 */
export const FEED_PANELS: Partial<
  Record<FeedEcosystem, React.ComponentType<FeedPanelProps>>
> = Object.fromEntries(ECOSYSTEMS.map((e) => [e, EcosystemPanel]));

export function FeedSettingsTab({
  scope,
  eco,
  detail,
}: {
  scope: FeedScope;
  eco: FeedEcosystem;
  detail: FeedDetailDto;
}): React.ReactElement {
  const settings = detail.settings;
  const save = React.useCallback(
    async (patch: Omit<FeedSettingsWrite, "expectedVersion">) => {
      await mutate("saveFeedSettings", scope, eco, {
        expectedVersion: settings.version,
        ...patch,
      });
    },
    [scope, eco, settings.version],
  );
  const Panel = FEED_PANELS[eco];
  return (
    <div className="space-y-6">
      {settings.version === 0 ? (
        <p className="text-sm text-fg-muted">
          This feed has no settings yet. Saving any section creates them; give
          it a namespace before enabling it.
        </p>
      ) : null}
      <GeneralSection eco={eco} scope={scope} detail={detail} save={save} />
      <NamespaceSection eco={eco} detail={detail} save={save} />
      <LimitsSection detail={detail} save={save} />
      {Panel ? (
        <Panel scope={scope} eco={eco} detail={detail} save={save} />
      ) : null}
      {scope.kind === "platform" && detail.policy ? (
        <PolicyPointer eco={eco} detail={detail} />
      ) : null}
    </div>
  );
}

type Save = FeedPanelProps["save"];

type GeneralGate = "off" | "tighten" | "widen";

function GeneralSection({
  eco,
  scope,
  detail,
  save,
}: {
  eco: FeedEcosystem;
  scope: FeedScope;
  detail: FeedDetailDto;
  save: Save;
}): React.ReactElement {
  const gate = useConfirmGate<GeneralGate>();
  const stored = detail.settings.accessMode;
  const storedChoice = feedAccessChoice(stored);
  const form = useAdminForm<{ enabled: boolean; accessMode: string }>({
    values: { enabled: detail.settings.enabled, accessMode: storedChoice },
    resetOn: [detail.settings.version],
    mapServerErrors: (e) => {
      if (e instanceof ApiError && e.reason === "access_mode_unavailable")
        return { accessMode: "Only Public and Customers can be set." };
      return serverFieldErrors(e);
    },
    onSubmit: async (v) => {
      const switchedOff = detail.settings.enabled && !v.enabled;
      const moved = v.accessMode !== storedChoice;
      if (switchedOff && !(await gate.ask("off"))) throw new SaveCancelled();
      if (moved) {
        const direction = v.accessMode === "public" ? "widen" : "tighten";
        if (!(await gate.ask(direction))) throw new SaveCancelled();
      }
      // Only what changed: an untouched Access row never rewrites the stored mode.
      await save({
        ...(v.enabled !== detail.settings.enabled
          ? { enabled: v.enabled }
          : {}),
        ...(moved ? { accessMode: feedAccessMode(v.accessMode) } : {}),
      });
      toast.success(
        switchedOff
          ? `${ECOSYSTEM_LABELS[eco]} feed switched off`
          : "General saved",
      );
    },
  });
  const serving = form.rhf.watch("enabled");
  const chosen = form.rhf.watch("accessMode");
  const options = [
    ...new Set(
      detail.accessModes
        .filter((m) => m.available)
        .map((m) => feedAccessChoice(m.mode)),
    ),
  ].map((choice) => {
    const Icon = choice === "public" ? Globe : UsersRound;
    return {
      value: choice,
      label: FEED_ACCESS_LABELS[choice] ?? choice,
      description: FEED_ACCESS_DESCRIPTIONS[choice],
      icon: <Icon aria-hidden className="size-4" />,
    };
  });
  const gated = stored === "entitled";
  const ungated = detail.ungatedPackages ?? [];
  return (
    <Form form={form} aria-label="General">
      <SettingsSection
        id="feed-general"
        title="General"
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ area: "distribution", thing: "Feed" }}
            />
            <SaveBar form={form} section="General" />
          </>
        }
      >
        <SettingsRow
          label="Serving"
          help={
            serving
              ? "On: clients install and update from this feed."
              : "Off: every client gets the registry's not-found, the same answer as a feed that does not exist."
          }
        >
          <FormField<boolean> name="enabled" label="Enabled" hideLabel>
            {(field) => (
              <Switch
                id={field.id}
                checked={field.value}
                onCheckedChange={field.onChange}
                aria-describedby={field["aria-describedby"]}
              />
            )}
          </FormField>
        </SettingsRow>
        <SettingsRow
          label="Access"
          help="Who may install. The stricter of this and each package's delivery access applies."
          align="block"
        >
          <FormField<string> name="accessMode" label="Access" hideLabel group>
            {(field) => (
              <RadioCards<string> {...field} columns={2} options={options} />
            )}
          </FormField>
          {gated && chosen === storedChoice ? (
            <p className="mt-2 text-sm text-fg-muted" data-testid="access-now">
              Now:{" "}
              {accessDisplayLabel(
                detail.settings.accessDisplay ??
                  "customers, packages gated individually",
              )}
              . Picking Customers again gates every package with the feed.
            </p>
          ) : null}
        </SettingsRow>
        {chosen !== "public" ? (
          <SettingsRow
            label="Registry tokens"
            help="Clients authenticate with a registry token, minted on the Tokens page, or by a licensee in Polaris Locker."
          >
            <Link
              to={tokensHref(scope)}
              className="inline-flex items-center gap-1.5 text-sm text-accent-fg underline-offset-4 hover:underline"
            >
              <KeyRound aria-hidden className="size-4" />
              Open Tokens
            </Link>
          </SettingsRow>
        ) : null}
        {gated && ungated.length > 0 ? (
          <SettingsRow label="Packages without a gate" align="block">
            <Callout
              tone="warning"
              title="License tokens are refused these packages"
            >
              <p>
                A license-bound token gets a package only when its delivery
                access names an entitlement flag the license holds. These{" "}
                {ECOSYSTEM_LABELS[eco]} packages have none:
              </p>
              <ul className="mt-2 space-y-1">
                {ungated.map((p) => (
                  <li key={p.id} className="flex items-center gap-1.5">
                    <Package aria-hidden className="size-4 text-fg-muted" />
                    <span className="font-mono text-xs">{p.name}</span>
                  </li>
                ))}
              </ul>
            </Callout>
          </SettingsRow>
        ) : null}
      </SettingsSection>
      <ConfirmDialog
        open={gate.open}
        onOpenChange={(open) => {
          if (!open) gate.cancel();
        }}
        intent={intentOf(GATE_ACTION[gate.payload ?? "off"])}
        title={
          gate.payload === "widen"
            ? `Make the ${ECOSYSTEM_LABELS[eco]} feed public?`
            : gate.payload === "tighten"
              ? `Require a token for the ${ECOSYSTEM_LABELS[eco]} feed?`
              : `Switch off the ${ECOSYSTEM_LABELS[eco]} feed?`
        }
        consequences={
          gate.payload === "widen"
            ? [
                "Anyone can install from this feed, with no credentials, within 30 seconds.",
                "Package names and versions become readable to everyone.",
                "Switching back to Customers refuses anonymous clients again.",
              ]
            : gate.payload === "tighten"
              ? [
                  "Clients without a registry token get the registry's 401 within 30 seconds.",
                  "Each client then needs the authenticated setup from the Tokens page.",
                  "Bytes already installed or cached by clients stay where they are.",
                ]
              : [
                  "Every client install and update from this feed gets not-found within 30 seconds.",
                  "Packages, versions and settings are kept and answer again when the feed is enabled.",
                ]
        }
        confirmLabel={
          gate.payload === "widen"
            ? "Make public"
            : gate.payload === "tighten"
              ? "Switch to Customers"
              : "Switch off feed"
        }
        onConfirm={gate.confirm}
      />
    </Form>
  );
}

const GATE_ACTION = {
  off: "feed.disable",
  tighten: "feed.tighten",
  widen: "feed.widen",
} as const;

/** A list field as one entry per line (commas also split). */
function linesOf(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** How the Namespace section names one namespace field, per protocol (display copy only). */
interface NamespaceFieldCopy {
  row: string;
  label: string;
  help: string;
  placeholder: string;
}

const NAMESPACE_COPY: Record<
  FeedEcosystem,
  Record<string, NamespaceFieldCopy>
> = {
  npm: {
    scope: {
      row: "Package scope",
      label: "Scope",
      help: "Every package name must be in this scope, like @acme. Clients route only this scope here.",
      placeholder: "@acme",
    },
  },
  pypi: {
    names: {
      row: "Project names",
      label: "Names",
      help: "A published name must equal one of the names or start with one of the prefixes (PEP 503 normalised).",
      placeholder: "acme-sdk",
    },
    prefixes: {
      row: "Name prefixes",
      label: "Prefixes",
      help: "One per line.",
      placeholder: "acme",
    },
  },
  oci: {},
  swift: {
    scope: {
      row: "Package scope",
      label: "Scope",
      help: "Every package identity must be in this scope, like acme in acme.Kit.",
      placeholder: "acme",
    },
  },
  maven: {
    groupPrefixes: {
      row: "Maven groups",
      label: "Group prefixes",
      help: "Every groupId must equal or sit under one of these prefixes, like gg.acme.",
      placeholder: "gg.acme",
    },
  },
  godot: {
    publisher: {
      row: "Addon publisher",
      label: "Publisher",
      help: "The publisher every addon is listed under.",
      placeholder: "acme",
    },
  },
  cargo: {},
  go: {
    modulePrefixes: {
      row: "Module paths",
      label: "Module prefixes",
      help: "Every module path must equal or sit under one of these prefixes, like go.acme.dev. Clients name the same prefixes in GONOSUMDB.",
      placeholder: "go.acme.dev",
    },
  },
};

/** How the Namespace section names a feed whose namespace is the owner itself (no fields). */
const OWNER_NAMESPACE_COPY: Partial<
  Record<FeedEcosystem, { label: string; help: string }>
> = {
  oci: {
    label: "Repositories",
    help: "Every repository sits under the owner's path; there is nothing else to claim.",
  },
  cargo: {
    label: "Crates",
    help: "Every crate sits in the owner's own index, and Cargo takes a crate from it only for a dependency that names it with registry =. There is nothing else to claim.",
  },
};

/**
 * The namespace fields of `eco`, as its ingest rules declare them (`@polaris-key/manifest`
 * PACKAGE_ECOSYSTEM_RULES), in the copy table's order; a declared field the table lacks still
 * shows, under its own key.
 */
function namespaceFields(
  eco: FeedEcosystem,
): { key: string; kind: "string" | "list"; copy: NamespaceFieldCopy }[] {
  const fields = PACKAGE_ECOSYSTEM_RULES[eco].namespace.fields;
  const copy = NAMESPACE_COPY[eco];
  const keys = [
    ...Object.keys(copy).filter((k) => Object.hasOwn(fields, k)),
    ...Object.keys(fields).filter((k) => !Object.hasOwn(copy, k)),
  ];
  return keys.map((key) => ({
    key,
    kind: fields[key]!.kind,
    copy: copy[key] ?? { row: key, label: key, help: "", placeholder: "" },
  }));
}

type NamespaceDraft = Record<string, string>;

/** The provisioning actor that writes a derived row (worker `FEED_PROVISION_ACTOR`). */
const FEED_PROVISION_ACTOR = "manifest";

/** A stored namespace value as one line of text. */
function derivedValue(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "Not set";
  return typeof v === "string" && v ? v : "Not set";
}

function NamespaceSection({
  eco,
  detail,
  save,
}: {
  eco: FeedEcosystem;
  detail: FeedDetailDto;
  save: Save;
}): React.ReactElement {
  const fields = namespaceFields(eco);
  const ns = detail.settings.namespace;
  const form = useAdminForm<NamespaceDraft>({
    values: Object.fromEntries(
      fields.map((f) => {
        const v = ns[f.key];
        return [
          f.key,
          f.kind === "list"
            ? Array.isArray(v)
              ? (v as string[]).join("\n")
              : ""
            : typeof v === "string"
              ? v
              : "",
        ];
      }),
    ),
    resetOn: [detail.settings.version],
    mapServerErrors: (e) => {
      const map = serverFieldErrors(e);
      if (!map?.namespace || fields.length === 0) return map;
      return { [fields[0]!.key]: map.namespace };
    },
    onSubmit: async (v) => {
      await save({
        namespace: Object.fromEntries(
          fields.map((f) => [
            f.key,
            f.kind === "list"
              ? linesOf(v[f.key] ?? "")
              : (v[f.key] ?? "").trim(),
          ]),
        ),
      });
      toast.success("Namespace saved");
    },
  });
  const owner = detail.owner ?? "owner";
  // A row the `.pkey/release` provisioning wrote and no operator has saved since: its namespace
  // is derived, shown as it is until the operator overrides it.
  const derived =
    fields.length > 0 &&
    detail.settings.version > 0 &&
    detail.settings.updatedBy === FEED_PROVISION_ACTOR;
  const [overriding, setOverriding] = React.useState(false);
  const readOnly = derived && !overriding;
  return (
    <Form form={form} aria-label="Namespace">
      <SettingsSection
        id="feed-namespace"
        title="Namespace"
        description="The names this feed may hold. Ingest refuses anything outside it, which is the defence against dependency confusion."
        footer={
          fields.length === 0 || readOnly ? undefined : (
            <>
              <SubmitError
                error={form.submitError}
                context={{ area: "distribution", thing: "Feed" }}
              />
              <SaveBar form={form} section="Namespace" />
            </>
          )
        }
      >
        {derived ? (
          <SettingsRow
            label="Source"
            help={
              readOnly
                ? "Written from your .pkey/release when the feed was created. Override to set your own."
                : "Saving replaces the derived namespace with yours."
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill tone="neutral" icon={null}>
                {readOnly ? "Derived from .pkey/release" : "Overridden"}
              </StatusPill>
              {readOnly ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOverriding(true)}
                >
                  Override
                </Button>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
        {fields.length === 0 ? (
          <SettingsRow
            label={OWNER_NAMESPACE_COPY[eco]?.label ?? "Packages"}
            help={
              OWNER_NAMESPACE_COPY[eco]?.help ??
              "Every package sits under the owner's path; there is nothing else to claim."
            }
          >
            <span className="font-mono text-sm">{owner}/…</span>
          </SettingsRow>
        ) : (
          fields.map((f) =>
            readOnly ? (
              <SettingsRow key={f.key} label={f.copy.row} help={f.copy.help}>
                <span className="font-mono text-sm break-all">
                  {derivedValue(ns[f.key])}
                </span>
              </SettingsRow>
            ) : f.kind === "list" ? (
              <SettingsRow
                key={f.key}
                align="stretch"
                label={f.copy.row}
                help={f.copy.help}
              >
                <FormField<string> name={f.key} label={f.copy.label} hideLabel>
                  {(field) => (
                    <Textarea
                      {...field}
                      mono
                      rows={3}
                      spellCheck={false}
                      placeholder={f.copy.placeholder}
                    />
                  )}
                </FormField>
              </SettingsRow>
            ) : (
              <SettingsRow key={f.key} label={f.copy.row} help={f.copy.help}>
                <FormField<string>
                  name={f.key}
                  label={f.copy.label}
                  hideLabel
                  className="w-full sm:w-64"
                >
                  {(field) => (
                    <Input
                      {...field}
                      mono
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={f.copy.placeholder}
                    />
                  )}
                </FormField>
              </SettingsRow>
            ),
          )
        )}
      </SettingsSection>
    </Form>
  );
}

function LimitsSection({
  detail,
  save,
}: {
  detail: FeedDetailDto;
  save: Save;
}): React.ReactElement {
  const ceiling = detail.policy?.maxPackageBytesCeiling ?? 0;
  const form = useAdminForm<{ mib: number | null }>({
    values: { mib: bytesToMiB(detail.settings.maxPackageBytes) },
    resetOn: [detail.settings.version, ceiling],
    mapServerErrors: (e) => {
      const map = serverFieldErrors(e);
      return map?.maxPackageBytes ? { mib: map.maxPackageBytes } : map;
    },
    validate: (v): Record<string, string> =>
      v.mib === null || v.mib <= 0
        ? { mib: "Enter a size above zero." }
        : mibToBytes(v.mib) > ceiling
          ? {
              mib: `At most the platform's ceiling, ${bytesToMiB(ceiling)} MiB.`,
            }
          : {},
    onSubmit: async (v) => {
      await save({ maxPackageBytes: mibToBytes(v.mib!) });
      toast.success("Limits saved");
    },
  });
  return (
    <Form form={form} aria-label="Limits">
      <SettingsSection
        id="feed-limits"
        title="Limits"
        description="Ingest refuses a version whose largest file is over this size."
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ area: "distribution", thing: "Feed" }}
            />
            <SaveBar form={form} section="Limits" />
          </>
        }
      >
        <SettingsRow
          label="Largest package"
          help={`The platform's ceiling for this ecosystem is ${bytesToMiB(ceiling)} MiB.`}
        >
          <FormField<number | null>
            name="mib"
            label="Size"
            hideLabel
            className="w-44"
          >
            {(field) => (
              <NumberInput
                {...field}
                unit="MiB"
                min={0.01}
                max={bytesToMiB(ceiling)}
                step="any"
              />
            )}
          </FormField>
        </SettingsRow>
      </SettingsSection>
    </Form>
  );
}

/** The platform policy lives in Platform settings (ST-09); this feed points to it. */
function PolicyPointer({
  eco,
  detail,
}: {
  eco: FeedEcosystem;
  detail: FeedDetailDto;
}): React.ReactElement {
  const mib = detail.policy
    ? `${bytesToMiB(detail.policy.maxPackageBytesCeiling)} MiB`
    : null;
  return (
    <p className="text-sm text-fg-muted">
      {mib
        ? `The platform's ${ECOSYSTEM_LABELS[eco]} ceiling is ${mib}, and its switch applies to every product. `
        : `The platform's ${ECOSYSTEM_LABELS[eco]} switch and ceiling apply to every product. `}
      Change them in{" "}
      <Link
        to={`#/platform/settings?setting=feeds.policy.${eco}.enabled`}
        className="underline underline-offset-4"
      >
        Platform settings
      </Link>
      .
    </p>
  );
}

type ExtDraft = Record<string, boolean | number | string | null>;

/** A stored `repositoryUrls` map as one `identity url` line per URL. */
function repositoryLines(v: unknown): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  return Object.entries(v as Record<string, unknown>)
    .flatMap(([id, urls]) =>
      Array.isArray(urls) ? urls.map((u) => `${id} ${String(u)}`) : [],
    )
    .join("\n");
}

/** `identity url [url …]` lines as the stored map; `null` for no lines, a string for a bad line. */
function repositoryMap(text: string): Record<string, string[]> | null | string {
  const map: Record<string, string[]> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.length < 2) return `Line ${i + 1} needs an identity and a URL.`;
    const [id, ...urls] = parts as [string, ...string[]];
    map[id] = [
      ...(map[id] ?? []),
      ...urls.filter((u) => !map[id]?.includes(u)),
    ];
  }
  return Object.keys(map).length ? map : null;
}

function extDraftOf(
  keys: readonly string[],
  ext: Record<string, unknown>,
): ExtDraft {
  const draft: ExtDraft = {};
  for (const key of keys) {
    const input = FEED_EXTENSION_FIELDS[key]!.input;
    const v = ext[key];
    switch (input.kind) {
      case "switch":
        draft[key] = typeof v === "boolean" ? v : input.default;
        break;
      case "number":
        draft[key] = typeof v === "number" ? v : null;
        break;
      case "select":
        draft[key] =
          (typeof v === "string" || typeof v === "number") &&
          input.options.some((o) => o.value === String(v))
            ? String(v)
            : input.default;
        break;
      case "text":
        draft[key] = typeof v === "string" ? v : "";
        break;
      case "repositoryMap":
        draft[key] = repositoryLines(v);
        break;
    }
  }
  return draft;
}

/** The ext patch a draft saves: an emptied setting is `null`, which removes it. */
function extPatchOf(keys: readonly string[], draft: ExtDraft) {
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const input = FEED_EXTENSION_FIELDS[key]!.input;
    const v = draft[key];
    if (input.kind === "select") patch[key] = v;
    else if (input.kind === "text")
      patch[key] = typeof v === "string" && v.trim() ? v.trim() : null;
    else if (input.kind === "repositoryMap") {
      const map = repositoryMap(typeof v === "string" ? v : "");
      patch[key] = typeof map === "string" ? null : map;
    } else patch[key] = v ?? null;
  }
  return patch;
}

/**
 * The ecosystem panel: one section, one SaveBar, over the extension settings the feed's adapter
 * declares and `FEED_EXTENSION_FIELDS` can edit. Saves `{ext}` with the version the tab read.
 */
function EcosystemPanel({
  eco,
  detail,
  save,
}: FeedPanelProps): React.ReactElement | null {
  const keys = (detail.extensions ?? []).filter((k) =>
    Object.hasOwn(FEED_EXTENSION_FIELDS, k),
  );
  const form = useAdminForm<ExtDraft>({
    values: extDraftOf(keys, detail.settings.ext),
    resetOn: [detail.settings.version, keys.join(",")],
    mapServerErrors: (e) => {
      const map = serverFieldErrors(e);
      if (!map) return map;
      return Object.fromEntries(
        Object.entries(map).map(([k, m]) => [k.replace(/^ext\./, ""), m]),
      );
    },
    validate: (v): Record<string, string> => {
      const errors: Record<string, string> = {};
      for (const key of keys) {
        const input = FEED_EXTENSION_FIELDS[key]!.input;
        const value = v[key];
        if (
          input.kind === "number" &&
          value !== null &&
          (typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < input.min ||
            value > input.max)
        )
          errors[key] =
            `A whole number from ${input.min} to ${input.max}, or empty.`;
        if (
          input.kind === "text" &&
          typeof value === "string" &&
          value.trim() &&
          input.pattern &&
          !input.pattern.test(value.trim())
        )
          errors[key] = `Like ${input.placeholder}.`;
        if (input.kind === "repositoryMap") {
          const map = repositoryMap(typeof value === "string" ? value : "");
          if (typeof map === "string") errors[key] = map;
        }
      }
      return errors;
    },
    onSubmit: async (v) => {
      await save({ ext: extPatchOf(keys, v) });
      toast.success(`${FEED_PANEL_TITLES[eco]} saved`);
    },
  });
  if (keys.length === 0) return null;
  const title = FEED_PANEL_TITLES[eco];
  return (
    <Form form={form} aria-label={title}>
      <SettingsSection
        id={`feed-${eco}`}
        title={title}
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ area: "distribution", thing: "Feed" }}
            />
            <SaveBar form={form} section={title} />
          </>
        }
      >
        {keys.map((key) => {
          const field = FEED_EXTENSION_FIELDS[key]!;
          const input = field.input;
          if (input.kind === "repositoryMap")
            return (
              <SettingsRow
                key={key}
                align="stretch"
                label={field.label}
                help={field.help}
              >
                <FormField<string> name={key} label={field.label} hideLabel>
                  {(f) => (
                    <Textarea
                      {...f}
                      mono
                      rows={3}
                      spellCheck={false}
                      placeholder={input.placeholder}
                    />
                  )}
                </FormField>
              </SettingsRow>
            );
          return (
            <SettingsRow key={key} label={field.label} help={field.help}>
              {input.kind === "switch" ? (
                <FormField<boolean> name={key} label={field.label} hideLabel>
                  {(f) => (
                    <Switch
                      id={f.id}
                      checked={f.value}
                      onCheckedChange={f.onChange}
                      aria-describedby={f["aria-describedby"]}
                    />
                  )}
                </FormField>
              ) : input.kind === "number" ? (
                <FormField<number | null>
                  name={key}
                  label={field.label}
                  hideLabel
                  className="w-44"
                >
                  {(f) => (
                    <NumberInput
                      {...f}
                      unit={input.unit}
                      min={input.min}
                      max={input.max}
                      step={1}
                    />
                  )}
                </FormField>
              ) : input.kind === "select" ? (
                <FormField<string>
                  name={key}
                  label={field.label}
                  hideLabel
                  className="w-full sm:w-48"
                >
                  {(f) => <Select {...f} options={input.options} />}
                </FormField>
              ) : (
                <FormField<string>
                  name={key}
                  label={field.label}
                  hideLabel
                  className="w-full sm:w-48"
                >
                  {(f) => (
                    <Input
                      {...f}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={input.maxLength}
                      placeholder={input.placeholder}
                    />
                  )}
                </FormField>
              )}
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </Form>
  );
}
