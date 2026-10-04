/**
 * A feed's Settings tab (T4 nested in the feed's T3; notes/S-12 §10.1). One settings model with
 * per-ecosystem extensions, saved section by section: each section is its own form and SaveBar
 * over `PUT …/feeds/:eco/settings` with the version it read (`expectedVersion`, 409 when someone
 * saved first). Never one Save across two endpoints: the platform policy (platform scope only) is
 * its own resource and its own section.
 *
 * - **General:** enabled. Turning a feed off is L1.
 * - **Access:** public, token, licensed or entitled (F-21). Leaving public is L1: anonymous
 *   clients get the native 401 within 30 seconds and need a registry token (the Tokens page).
 *   Entitled lists the feed's packages with no delivery gate, which licence tokens are refused.
 * - **Namespace:** the dependency-confusion rule ingest enforces (scope, prefixes, groups,
 *   publisher). OCI's namespace is the owner itself.
 * - **Limits:** the size ceiling, at most the platform's.
 * - **Yank policy:** what a yank does to clients; Maven's "hide yanked versions" where it applies.
 * - **Upstream:** none, the only option.
 * - **The ecosystem panel:** `FEED_PANELS`, which F-12 fills per ecosystem.
 * - **Platform policy** (platform scope): the ecosystem's kill switch and ceiling. Off is L2.
 */

import * as React from "react";
import type {
  FeedDetailDto,
  FeedEcosystem,
  FeedSettingsWrite,
} from "../../../api.js";
import {
  BadgeCheck,
  Globe,
  KeyRound,
  Package,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Form, FormField, useAdminForm } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";
import { intentOf } from "../../pages/core/confirmGate.js";
import { SaveCancelled, useConfirmGate } from "../../pages/core/confirmGate.js";
import { SettingsRow, SettingsSection } from "../../templates/Settings.js";
import { serverFieldErrors, SubmitError } from "../distribution/forms.js";
import {
  ECOSYSTEM_LABELS,
  FEED_ACCESS_DESCRIPTIONS,
  FEED_ACCESS_LABELS,
  YANK_EFFECTS,
  bytesToMiB,
  mibToBytes,
  tokensHref,
  type FeedScope,
} from "./model.js";
import { Link } from "../../router.js";

/** What an ecosystem panel receives (F-12 adds one per ecosystem to `FEED_PANELS`). */
export interface FeedPanelProps {
  scope: FeedScope;
  eco: FeedEcosystem;
  detail: FeedDetailDto;
  /** Save a patch of the feed's settings at the version this tab read. */
  save: (patch: Omit<FeedSettingsWrite, "expectedVersion">) => Promise<void>;
}

/**
 * The per-ecosystem settings panels, rendered after the common sections. Empty until F-12, which
 * registers PyPI's HTML fallback, Swift signing, OCI retention, Godot's category and support level.
 */
export const FEED_PANELS: Partial<
  Record<FeedEcosystem, React.ComponentType<FeedPanelProps>>
> = {};

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
      <GeneralSection eco={eco} detail={detail} save={save} />
      <AccessSection eco={eco} scope={scope} detail={detail} save={save} />
      <NamespaceSection eco={eco} detail={detail} save={save} />
      <LimitsSection detail={detail} save={save} />
      <YankSection eco={eco} detail={detail} save={save} />
      <SettingsSection id="feed-upstream" title="Upstream">
        <SettingsRow
          label="Upstream registry"
          help="The feed never proxies or mirrors another registry: a name it does not hold answers not-found, so a public package can never stand in for one of yours."
        >
          <StatusPill tone="neutral" icon={null}>
            None
          </StatusPill>
        </SettingsRow>
      </SettingsSection>
      {Panel ? (
        <Panel scope={scope} eco={eco} detail={detail} save={save} />
      ) : null}
      {scope.kind === "platform" && detail.policy ? (
        <PolicySection eco={eco} detail={detail} />
      ) : null}
    </div>
  );
}

type Save = FeedPanelProps["save"];

function GeneralSection({
  eco,
  detail,
  save,
}: {
  eco: FeedEcosystem;
  detail: FeedDetailDto;
  save: Save;
}): React.ReactElement {
  const gate = useConfirmGate<true>();
  const form = useAdminForm<{ enabled: boolean }>({
    values: { enabled: detail.settings.enabled },
    resetOn: [detail.settings.version],
    mapServerErrors: serverFieldErrors,
    onSubmit: async (v) => {
      if (detail.settings.enabled && !v.enabled && !(await gate.ask(true)))
        throw new SaveCancelled();
      await save({ enabled: v.enabled });
      toast.success(
        `${ECOSYSTEM_LABELS[eco]} feed ${v.enabled ? "enabled" : "switched off"}`,
      );
    },
  });
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
          help="Off, every client gets the registry's not-found, the same answer as a feed that does not exist."
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
      </SettingsSection>
      <ConfirmDialog
        open={gate.open}
        onOpenChange={(open) => {
          if (!open) gate.cancel();
        }}
        intent={intentOf("feed.disable")}
        title={`Switch off the ${ECOSYSTEM_LABELS[eco]} feed?`}
        consequences={[
          "Every client install and update from this feed gets not-found within 30 seconds.",
          "Packages, versions and settings are kept and answer again when the feed is enabled.",
        ]}
        confirmLabel="Switch off feed"
        onConfirm={gate.confirm}
      />
    </Form>
  );
}

/** One icon per access mode (every option carries one). */
const FEED_ACCESS_ICONS: Record<string, LucideIcon> = {
  public: Globe,
  authenticated: KeyRound,
  licensed: BadgeCheck,
  entitled: ShieldCheck,
};

function AccessSection({
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
  const gate = useConfirmGate<string>();
  const form = useAdminForm<{ accessMode: string }>({
    values: { accessMode: detail.settings.accessMode },
    resetOn: [detail.settings.version],
    mapServerErrors: serverFieldErrors,
    onSubmit: async (v) => {
      if (
        detail.settings.accessMode === "public" &&
        v.accessMode !== "public" &&
        !(await gate.ask(v.accessMode))
      )
        throw new SaveCancelled();
      await save({ accessMode: v.accessMode });
      toast.success("Access saved");
    },
  });
  const options = detail.accessModes
    .filter((m) => m.available)
    .map((m) => {
      const Icon = FEED_ACCESS_ICONS[m.mode] ?? Globe;
      return {
        value: m.mode,
        label: FEED_ACCESS_LABELS[m.mode] ?? m.mode,
        description: FEED_ACCESS_DESCRIPTIONS[m.mode],
        icon: <Icon aria-hidden className="size-4" />,
      };
    });
  const chosen = form.rhf.watch("accessMode");
  const ungated = detail.ungatedPackages ?? [];
  return (
    <Form form={form} aria-label="Access">
      <SettingsSection
        id="feed-access"
        title="Access"
        description="Who may install from this feed. The stricter of this and each package's delivery access applies."
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ area: "distribution", thing: "Feed" }}
            />
            <SaveBar form={form} section="Access" />
          </>
        }
      >
        <SettingsRow label="Who may install" align="block">
          <FormField<string>
            name="accessMode"
            label="Who may install"
            hideLabel
            group
          >
            {(field) => (
              <RadioCards<string>
                {...field}
                columns={options.length >= 4 ? 4 : 2}
                options={options}
              />
            )}
          </FormField>
        </SettingsRow>
        {chosen !== "public" ? (
          <SettingsRow
            label="Registry tokens"
            help="Clients authenticate with a registry token, minted on the Tokens page, or by a licensee in the portal."
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
        {chosen === "entitled" && ungated.length > 0 ? (
          <SettingsRow label="Packages without a gate" align="block">
            <Callout tone="warning" title="Licence tokens are refused these packages">
              <p>
                Entitled admits a licence-bound token only for a package whose
                delivery access names an entitlement flag the licence holds.
                These {ECOSYSTEM_LABELS[eco]} packages have none:
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
        intent={intentOf("feed.tighten")}
        title={`Require a token for the ${ECOSYSTEM_LABELS[eco]} feed?`}
        consequences={[
          "Clients without a registry token get the registry's 401 within 30 seconds.",
          "Each client then needs the authenticated setup from the Tokens page.",
          "Bytes already installed or cached by clients stay where they are.",
        ]}
        confirmLabel={`Switch to ${FEED_ACCESS_LABELS[gate.payload ?? ""] ?? "this mode"}`}
        onConfirm={gate.confirm}
      />
    </Form>
  );
}

/** A list field as one entry per line (commas also split). */
function linesOf(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface NamespaceDraft {
  scope: string;
  publisher: string;
  groupPrefixes: string;
  prefixes: string;
  names: string;
}

function namespaceDraft(ns: Record<string, unknown>): NamespaceDraft {
  const list = (v: unknown) =>
    Array.isArray(v) ? (v as string[]).join("\n") : "";
  return {
    scope: typeof ns.scope === "string" ? ns.scope : "",
    publisher: typeof ns.publisher === "string" ? ns.publisher : "",
    groupPrefixes: list(ns.groupPrefixes),
    prefixes: list(ns.prefixes),
    names: list(ns.names),
  };
}

function namespaceOf(
  eco: FeedEcosystem,
  d: NamespaceDraft,
): Record<string, unknown> {
  switch (eco) {
    case "npm":
    case "swift":
      return { scope: d.scope.trim() };
    case "godot":
      return { publisher: d.publisher.trim() };
    case "maven":
      return { groupPrefixes: linesOf(d.groupPrefixes) };
    case "pypi":
      return { prefixes: linesOf(d.prefixes), names: linesOf(d.names) };
    case "oci":
      return {};
  }
}

const NAMESPACE_HELP: Record<FeedEcosystem, string> = {
  npm: "Every package name must be in this scope, like @acme. Clients route only this scope here.",
  pypi: "A published name must equal one of the names or start with one of the prefixes (PEP 503 normalised).",
  oci: "",
  swift: "Every package identity must be in this scope, like acme in acme.Kit.",
  maven:
    "Every groupId must equal or sit under one of these prefixes, like gg.acme.",
  godot: "The publisher every addon is listed under.",
};

function NamespaceSection({
  eco,
  detail,
  save,
}: {
  eco: FeedEcosystem;
  detail: FeedDetailDto;
  save: Save;
}): React.ReactElement {
  const form = useAdminForm<NamespaceDraft>({
    values: namespaceDraft(detail.settings.namespace),
    resetOn: [detail.settings.version],
    mapServerErrors: (e) => {
      const map = serverFieldErrors(e);
      if (!map?.namespace) return map;
      const field =
        eco === "npm" || eco === "swift"
          ? "scope"
          : eco === "godot"
            ? "publisher"
            : eco === "maven"
              ? "groupPrefixes"
              : "names";
      return { [field]: map.namespace };
    },
    onSubmit: async (v) => {
      await save({ namespace: namespaceOf(eco, v) });
      toast.success("Namespace saved");
    },
  });
  const owner = detail.owner ?? "owner";
  return (
    <Form form={form} aria-label="Namespace">
      <SettingsSection
        id="feed-namespace"
        title="Namespace"
        description="The names this feed may hold. Ingest refuses anything outside it, which is the defence against dependency confusion."
        footer={
          eco === "oci" ? undefined : (
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
        {eco === "oci" ? (
          <SettingsRow
            label="Repositories"
            help="Every repository sits under the owner's path; there is nothing else to claim."
          >
            <span className="font-mono text-sm">{owner}/…</span>
          </SettingsRow>
        ) : eco === "npm" || eco === "swift" ? (
          <SettingsRow label="Package scope" help={NAMESPACE_HELP[eco]}>
            <FormField<string>
              name="scope"
              label="Scope"
              hideLabel
              className="w-full sm:w-64"
            >
              {(field) => (
                <Input
                  {...field}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={eco === "npm" ? "@acme" : "acme"}
                />
              )}
            </FormField>
          </SettingsRow>
        ) : eco === "godot" ? (
          <SettingsRow label="Addon publisher" help={NAMESPACE_HELP[eco]}>
            <FormField<string>
              name="publisher"
              label="Publisher"
              hideLabel
              className="w-full sm:w-64"
            >
              {(field) => (
                <Input
                  {...field}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="acme"
                />
              )}
            </FormField>
          </SettingsRow>
        ) : eco === "maven" ? (
          <SettingsRow
            align="stretch"
            label="Maven groups"
            help={NAMESPACE_HELP[eco]}
          >
            <FormField<string>
              name="groupPrefixes"
              label="Group prefixes"
              hideLabel
            >
              {(field) => (
                <Textarea
                  {...field}
                  mono
                  rows={3}
                  spellCheck={false}
                  placeholder="gg.acme"
                />
              )}
            </FormField>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow
              align="stretch"
              label="Project names"
              help={NAMESPACE_HELP.pypi}
            >
              <FormField<string> name="names" label="Names" hideLabel>
                {(field) => (
                  <Textarea
                    {...field}
                    mono
                    rows={3}
                    spellCheck={false}
                    placeholder="acme-sdk"
                  />
                )}
              </FormField>
            </SettingsRow>
            <SettingsRow
              align="stretch"
              label="Name prefixes"
              help="One per line."
            >
              <FormField<string> name="prefixes" label="Prefixes" hideLabel>
                {(field) => (
                  <Textarea
                    {...field}
                    mono
                    rows={2}
                    spellCheck={false}
                    placeholder="acme-"
                  />
                )}
              </FormField>
            </SettingsRow>
          </>
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

function YankSection({
  eco,
  detail,
  save,
}: {
  eco: FeedEcosystem;
  detail: FeedDetailDto;
  save: Save;
}): React.ReactElement {
  const hides = detail.settings.ext.yankHidesFromIndex === true;
  const form = useAdminForm<{ hide: boolean }>({
    values: { hide: hides },
    resetOn: [detail.settings.version],
    mapServerErrors: serverFieldErrors,
    onSubmit: async (v) => {
      await save({ ext: { yankHidesFromIndex: v.hide } });
      toast.success("Yank policy saved");
    },
  });
  const caps = detail.capabilities;
  return (
    <Form form={form} aria-label="Yank policy">
      <SettingsSection
        id="feed-yank"
        title="Yank policy"
        description={YANK_EFFECTS[eco]}
        footer={
          caps.yankPolicy ? (
            <>
              <SubmitError
                error={form.submitError}
                context={{ area: "distribution", thing: "Feed" }}
              />
              <SaveBar form={form} section="Yank policy" />
            </>
          ) : undefined
        }
      >
        <SettingsRow
          label="Version states"
          help="Shown on each version of the package record, where they are set."
        >
          <span className="flex flex-wrap gap-1.5">
            <StatusPill tone={caps.yank ? "success" : "neutral"} size="sm">
              {caps.yank ? "Yank" : "No yank"}
            </StatusPill>
            <StatusPill tone={caps.deprecate ? "success" : "neutral"} size="sm">
              {caps.deprecate ? "Deprecate" : "No deprecation"}
            </StatusPill>
          </span>
        </SettingsRow>
        {caps.yankPolicy ? (
          <SettingsRow
            label="Hide yanked versions"
            help="Leave a yanked version out of maven-metadata.xml, so version ranges stop resolving to it. Exact coordinates still download."
          >
            <FormField<boolean> name="hide" label="Hide" hideLabel>
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
        ) : null}
      </SettingsSection>
    </Form>
  );
}

function PolicySection({
  eco,
  detail,
}: {
  eco: FeedEcosystem;
  detail: FeedDetailDto;
}): React.ReactElement {
  const policy = detail.policy!;
  const gate = useConfirmGate<true>();
  const form = useAdminForm<{ enabled: boolean; mib: number | null }>({
    values: {
      enabled: policy.enabled,
      mib: bytesToMiB(policy.maxPackageBytesCeiling),
    },
    resetOn: [policy.version],
    mapServerErrors: (e) => {
      const map = serverFieldErrors(e);
      return map?.maxPackageBytesCeiling
        ? { mib: map.maxPackageBytesCeiling }
        : map;
    },
    validate: (v): Record<string, string> =>
      v.mib === null || v.mib < 0.01 ? { mib: "Enter a size above zero." } : {},
    onSubmit: async (v) => {
      if (policy.enabled && !v.enabled && !(await gate.ask(true)))
        throw new SaveCancelled();
      await mutate("saveFeedPolicy", eco, {
        expectedVersion: policy.version,
        enabled: v.enabled,
        maxPackageBytesCeiling: mibToBytes(v.mib!),
      });
      toast.success("Platform policy saved");
    },
  });
  return (
    <Form form={form} aria-label="Platform policy">
      <SettingsSection
        id="feed-policy"
        title="Platform policy"
        description={`Applies to every product's ${ECOSYSTEM_LABELS[eco]} feed, above its own settings.`}
        footer={
          <>
            <SubmitError
              error={form.submitError}
              context={{ area: "distribution", thing: "Platform policy" }}
            />
            <SaveBar form={form} section="Platform policy" />
          </>
        }
      >
        <SettingsRow
          label="Serve this ecosystem"
          help="Off, every owner's feed of this ecosystem answers not-found, whatever its own settings say."
        >
          <FormField<boolean> name="enabled" label="Served" hideLabel>
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
          label="Size ceiling"
          help="No feed of this ecosystem may accept a larger package, whatever its own limit."
        >
          <FormField<number | null>
            name="mib"
            label="Ceiling"
            hideLabel
            className="w-44"
          >
            {(field) => (
              <NumberInput {...field} unit="MiB" min={0.01} step="any" />
            )}
          </FormField>
        </SettingsRow>
      </SettingsSection>
      <ConfirmDialog
        open={gate.open}
        onOpenChange={(open) => {
          if (!open) gate.cancel();
        }}
        intent={intentOf("feed.policyOff")}
        title={`Stop serving ${ECOSYSTEM_LABELS[eco]} for every product?`}
        consequences={[
          `Every product's ${ECOSYSTEM_LABELS[eco]} feed, the platform's included, answers not-found within 30 seconds.`,
          "Settings, packages and versions are kept; the feeds answer again when the ecosystem is served.",
        ]}
        confirmLabel={`Stop serving ${ECOSYSTEM_LABELS[eco]}`}
        onConfirm={gate.confirm}
      />
    </Form>
  );
}
