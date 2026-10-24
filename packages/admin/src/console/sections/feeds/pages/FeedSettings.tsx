/**
 * A feed's Settings tab (T4 nested in the feed's T3; notes/S-12 §10.1), in four sections. One
 * settings model with per-ecosystem extensions, saved section by section: each section is its own
 * form and SaveBar over `PUT …/feeds/:eco/settings` with the version it read (`expectedVersion`,
 * 409 when someone saved first). Never one Save across two endpoints: the platform policy
 * (platform scope only) is its own resource and its own section.
 *
 * - **General:** enabled, and Access: Public or Licensed (F-34; `ACCESS_LABELS`). An old
 *   `entitled` feed reads "Licensed, packages gated individually" and is not
 *   rewritten unless the operator picks again. Turning a feed off, and moving access either way,
 *   is L1: Public to Licensed refuses anonymous clients within 30 seconds; Licensed to Public
 *   opens the feed to everyone.
 * - **Namespace:** the dependency-confusion rule ingest enforces, one row per namespace field
 *   the ecosystem's ingest rules declare (scope, prefixes, groups, publisher). A namespace the
 *   `.pkey/release` provisioning derived reads "Derived from .pkey/release" with Override. OCI
 *   declares none: its namespace is the owner itself.
 * - **Limits:** the size ceiling, at most the platform's.
 * - **The ecosystem panel:** `FEED_PANELS` (F-12): the extension settings the feed's adapter
 *   declares, edited by name from `FEED_EXTENSION_FIELDS` (HTML pages, signing, repository URLs),
 *   saved into `ext_json`. Godot's asset listing is not shown: its stored values stay the
 *   server's fallback (F8).
 * - **Platform policy** (platform scope): moved to Platform settings (ST-09); a pointer remains.
 *
 * Gone: Yank policy (Maven always hides yanked versions), Untagged manifests (OCI keeps every
 * manifest) and the Godot category (stored values stay the fallback).
 */

import * as React from "react";
import {
  HttpError,
  type FeedDetailDto,
  type FeedEcosystem,
  type FeedSettingsWrite,
} from "../../../../api.js";
import { AlertTriangle, Globe, Lock, Package } from "lucide-react";
import { WriteLock } from "../../../../ui/WriteLock.js";
import { useWriteGate } from "../../../access/useCan.js";
import { r } from "../../../routes.js";
import { NamespaceSection } from "./FeedNamespace.js";
import {
  ConflictNotice,
  FeedSubmitError,
  FeedSyncContext,
  focusSection,
} from "./feedForm.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { Form, FormField, useAdminForm } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { Select } from "../../../../ui/Select.js";
import { Switch } from "../../../../ui/Switch.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { invalidateAfter, mutate } from "../../../data/mutations.js";
import { intentOf } from "../../core/pages/confirmGate.js";
import { useConfirmGate } from "../../core/pages/confirmGate.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import {
  serverFieldErrors,
  SubmitCancelled,
} from "../../distribution/components/forms.js";
import {
  ECOSYSTEMS,
  ECOSYSTEM_LABELS,
  FEED_ACCESS_DESCRIPTIONS,
  FEED_EXTENSION_FIELDS,
  FEED_PANEL_TITLES,
  feedAccessLabel,
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
  const gate = useWriteGate(
    scope.kind === "platform" ? "platform" : "ship",
    scope.kind === "platform" ? null : scope.slug,
  );
  // The versions this tab wrote: a sibling form's draft rebases silently onto them.
  const own = React.useRef(new Set<number>());
  const [tick, setTick] = React.useState(0);
  const sync = React.useMemo(() => ({ own, tick }), [tick]);
  const save = React.useCallback(
    async (patch: Omit<FeedSettingsWrite, "expectedVersion">) => {
      const body = { expectedVersion: settings.version, ...patch };
      try {
        const done = await mutate("saveFeedSettings", scope, eco, body);
        own.current.add(done.settings.version);
        setTick((t) => t + 1);
      } catch (e) {
        // Someone saved first: fetch their version, so each form offers to review it and the next
        // save carries the fresh version (a stale one would be refused again).
        if (e instanceof HttpError && e.reason === "version_conflict")
          invalidateAfter("saveFeedSettings", [scope, eco, body]);
        throw e;
      }
    },
    [scope, eco, settings.version],
  );
  const Panel = FEED_PANELS[eco];
  return (
    <WriteLock locked={!gate.allowed} reason={gate.disabledReason}>
      <FeedSyncContext.Provider value={sync}>
        <div className="space-y-6">
          {settings.version === 0 ? (
            <p className="text-sm text-fg-muted">
              This feed has no settings yet. Saving any section creates them;
              give it a namespace before enabling it.
            </p>
          ) : null}
          <GeneralSection eco={eco} scope={scope} detail={detail} save={save} />
          <NamespaceSection eco={eco} detail={detail} save={save} />
          <LimitsSection detail={detail} save={save} />
          {Panel ? (
            <Panel scope={scope} eco={eco} detail={detail} save={save} />
          ) : null}
          {scope.kind === "platform" && detail.policy ? (
            <PolicyPointer eco={eco} />
          ) : null}
        </div>
      </FeedSyncContext.Provider>
    </WriteLock>
  );
}

type Save = FeedPanelProps["save"];

/** What one General save asks the operator to confirm: switching off, and moving access. */
interface GeneralAsk {
  off: boolean;
  access: "widen" | "tighten" | null;
}

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
  const gate = useConfirmGate<GeneralAsk>();
  const stored = detail.settings.accessMode;
  const storedChoice = feedAccessChoice(stored);
  const label = ECOSYSTEM_LABELS[eco];
  const form = useAdminForm<{ enabled: boolean; accessMode: string }>({
    values: { enabled: detail.settings.enabled, accessMode: storedChoice },
    resetOn: [detail.settings.version],
    mapServerErrors: (e) => {
      if (e instanceof HttpError && e.reason === "access_mode_unavailable")
        return {
          accessMode: "This page is out of date. Reload it, then choose again.",
        };
      return serverFieldErrors(e);
    },
    onSubmit: async (v) => {
      const off = detail.settings.enabled && !v.enabled;
      const moved = v.accessMode !== storedChoice;
      const access = !moved
        ? null
        : v.accessMode === "public"
          ? "widen"
          : "tighten";
      // One confirm per save, naming every change in it.
      if ((off || access) && !(await gate.ask({ off, access })))
        throw new SubmitCancelled();
      // Only what changed: an untouched Access row never rewrites the stored mode.
      await save({
        ...(v.enabled !== detail.settings.enabled
          ? { enabled: v.enabled }
          : {}),
        ...(moved ? { accessMode: feedAccessMode(v.accessMode) } : {}),
      });
      toast.success(
        off
          ? `${label} feed switched off`
          : access === "widen"
            ? `${label} feed is public`
            : access === "tighten"
              ? `${label} feed now needs a token`
              : v.enabled !== detail.settings.enabled
                ? `${label} feed switched on`
                : "General saved",
      );
      focusSection("feed-general");
    },
  });
  const serving = form.rhf.watch("enabled");
  const chosen = form.rhf.watch("accessMode");
  const gated = stored === "entitled";
  const options = [
    ...new Set(
      detail.accessModes
        .filter((m) => m.available)
        .map((m) => feedAccessChoice(m.mode)),
    ),
  ].map((choice) => {
    const Icon = choice === "public" ? Globe : Lock;
    return {
      value: choice,
      label: feedAccessLabel(choice),
      description:
        choice === "customers" && gated
          ? "Packages gated individually: a customer's token gets a package only when their license holds its entitlement."
          : FEED_ACCESS_DESCRIPTIONS[choice],
      icon: <Icon aria-hidden className="size-4" />,
    };
  });
  const ungated = detail.ungatedPackages ?? [];
  const owner = detail.owner;
  return (
    <Form form={form} aria-label="General">
      <SettingsSection
        id="feed-general"
        title="General"
        footer={
          <>
            <FeedSubmitError error={form.submitError} />
            <SaveBar form={form} section="General" />
          </>
        }
      >
        <ConflictNotice form={form} version={detail.settings.version} />
        <SettingsRow
          label="Serving"
          help={
            serving
              ? "On: clients install and update from this feed."
              : "Off: every client gets the registry's not-found, the same answer as a feed that does not exist."
          }
        >
          <FormField<boolean> name="enabled" label="Serving" hideLabel>
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
          {chosen !== "public" ? (
            <p className="mt-2 text-sm text-fg-muted">
              Customers mint tokens in Polaris Locker; yours and CI&rsquo;s are
              on{" "}
              <Link
                to={tokensHref(scope)}
                className="text-accent-fg underline underline-offset-4"
              >
                Tokens
              </Link>
              .
            </p>
          ) : null}
        </SettingsRow>
        {gated && chosen !== "public" && ungated.length > 0 && owner ? (
          <SettingsRow label="Packages without a gate" align="block">
            <div
              data-tone="warning"
              className="rounded-lg border border-warning-border bg-warning-subtle px-4 py-3 text-sm"
            >
              <p className="font-semibold text-warning">
                <AlertTriangle
                  aria-hidden
                  className="me-2 inline size-4 align-text-bottom"
                />
                Customers' tokens are refused these packages
              </p>
              <p className="mt-1 text-fg">
                A customer's token gets a package only when its delivery access
                names an entitlement. Give each of these {label} packages one:
              </p>
              <ul className="mt-2 space-y-1">
                {ungated.map((p) => (
                  <li key={p.id} className="flex items-center gap-1.5">
                    <Package
                      aria-hidden
                      className="size-4 shrink-0 text-fg-muted"
                    />
                    <Link
                      to={r.deliverable(owner, p.id, "delivery")}
                      className="min-w-0 font-mono text-xs underline underline-offset-4 [overflow-wrap:anywhere]"
                    >
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsSection>
      <ConfirmDialog
        open={gate.open}
        onOpenChange={(open) => {
          if (!open) gate.cancel();
        }}
        intent={intentOf(
          gate.payload?.off
            ? "feed.disable"
            : gate.payload?.access === "widen"
              ? "feed.widen"
              : "feed.tighten",
        )}
        title={confirmTitle(label, gate.payload)}
        consequences={confirmConsequences(gate.payload)}
        confirmLabel={confirmLabelOf(gate.payload)}
        onConfirm={gate.confirm}
      />
    </Form>
  );
}

const OFF_LINES = [
  "Every client install and update from this feed gets not-found within 30 seconds.",
  "Packages, versions and settings are kept and answer again when the feed is enabled.",
];
const WIDEN_LINES = [
  "Within 30 seconds anyone can install its packages with no credentials, unless a package's own access is stricter.",
  "Package names and versions become readable to everyone.",
  "Anything installed while it is public stays installed.",
];
const TIGHTEN_LINES = [
  "Clients without a registry token are refused within 30 seconds.",
  "Each client then needs the authenticated setup from the Tokens page.",
  "Bytes already installed or cached by clients stay where they are.",
];
// Switched off in the same save, the access change takes effect when the feed is on again.
const OFF_WIDEN_LINES = [
  "Every client install and update gets not-found within 30 seconds; nothing is deleted.",
  "When it is switched on again, anyone can install with no credentials, unless a package's own access is stricter.",
  "Anything installed while it is public stays installed.",
];
const OFF_TIGHTEN_LINES = [
  "Every client install and update gets not-found within 30 seconds; nothing is deleted.",
  "When it is switched on again, clients without a registry token are refused.",
  "Each client then needs the authenticated setup from the Tokens page.",
];

function confirmTitle(label: string, ask: GeneralAsk | null): string {
  if (ask?.off && ask.access === "widen")
    return `Switch off the ${label} feed and make it public?`;
  if (ask?.off && ask.access === "tighten")
    return `Switch off the ${label} feed and switch it to Licensed?`;
  if (ask?.off) return `Switch off the ${label} feed?`;
  if (ask?.access === "widen") return `Make the ${label} feed public?`;
  return `Switch the ${label} feed to Licensed?`;
}

function confirmConsequences(ask: GeneralAsk | null): string[] {
  if (ask?.off && ask.access === "widen") return OFF_WIDEN_LINES;
  if (ask?.off && ask.access === "tighten") return OFF_TIGHTEN_LINES;
  if (ask?.off) return OFF_LINES;
  return ask?.access === "widen" ? WIDEN_LINES : TIGHTEN_LINES;
}

function confirmLabelOf(ask: GeneralAsk | null): string {
  if (ask?.off && ask.access === "widen") return "Switch off and make public";
  if (ask?.off && ask.access === "tighten")
    return "Switch off and use Licensed";
  if (ask?.off) return "Switch off feed";
  if (ask?.access === "widen") return "Make feed public";
  return "Switch to Licensed";
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
      focusSection("feed-limits");
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
            <FeedSubmitError error={form.submitError} />
            <SaveBar form={form} section="Limits" />
          </>
        }
      >
        <ConflictNotice form={form} version={detail.settings.version} />
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
function PolicyPointer({ eco }: { eco: FeedEcosystem }): React.ReactElement {
  return (
    <p className="text-sm text-fg-muted">
      The {ECOSYSTEM_LABELS[eco]} switch and ceiling apply to every product.
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
      focusSection(`feed-${eco}`);
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
            <FeedSubmitError error={form.submitError} />
            <SaveBar form={form} section={title} />
          </>
        }
      >
        <ConflictNotice form={form} version={detail.settings.version} />
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
