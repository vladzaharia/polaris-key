/**
 * New license (LX-29): what each step asks. The wizard (`NewLicenseWizard.tsx`) owns the draft,
 * the step and the create; these are the fields. Copy is plain words (S-24 §8.6): nobody is a
 * "holder", nothing is "claimed", "redeemed" or a "seat".
 */

import * as React from "react";
import { EffectivePolicy } from "../components/EffectivePolicy.js";
import { ChevronRight } from "lucide-react";
import type { ProductDetail, TierSummary } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { ChannelPicker } from "../../../../ui/ChannelPicker.js";
import { DateInput } from "../../../../ui/DateInput.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { VersionInput } from "../../../../ui/VersionInput.js";
import { Callout } from "../../../../ui/Callout.js";
import {
  ChoiceStep,
  AutoList,
  type AutoItem,
} from "../../../../ui/wizard/index.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { InlineFailure } from "../components/InlineFailure.js";
import {
  effectivePolicy,
  resolvedDeviceLimit,
  tierSummary,
} from "../components/shared.js";
import {
  MAX_BATCH,
  MAX_DEVICE_LIMIT,
  deliveriesFor,
  deliveryOf,
  emailsKey,
  isBatch,
  type Delivery,
  type Draft,
  type Errors,
  type ExpiryMode,
  type StepId,
  type Who,
} from "./draft.js";

export interface StepProps {
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  errors: Errors;
}

/** The "No tier" card's value; a real tier id never looks like this. */
const NO_TIER = "-";

export const tierName = (t: TierSummary | undefined): string =>
  t ? t.label || t.id : "";

// ── Tier ───────────────────────────────────────────────────────────────────────────────────────

export function TierStep({
  slug,
  draft,
  set,
  tiers,
  loading,
  error,
  onRetry,
}: StepProps & {
  slug: string;
  tiers: readonly TierSummary[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  if (loading) return <p className="text-sm text-fg-muted">Loading tiers…</p>;
  return (
    <div className="space-y-3">
      {error ? (
        <InlineFailure what="tiers" error={error} onRetry={onRetry} />
      ) : null}
      {tiers.length === 0 && !error ? (
        <Callout tone="info" title="No tiers yet">
          A tier sets a device limit, a term and channels once, for every
          license on it.{" "}
          <Link className="underline underline-offset-2" to={r.tiers(slug)}>
            Create a tier
          </Link>
        </Callout>
      ) : null}
      <ChoiceStep
        legend="Tier"
        columns={1}
        value={draft.tier ?? (draft.noTier ? NO_TIER : null)}
        onChange={(v) => {
          set("tier", v === NO_TIER ? null : v);
          set("noTier", v === NO_TIER);
        }}
        choices={[
          ...tiers.map((t) => ({
            value: t.id,
            label: tierName(t),
            description: tierSummary(t),
          })),
          {
            value: NO_TIER,
            label: "No tier",
            description: "The product's own limits apply.",
          },
        ]}
      />
      {tiers.length > 0 ? (
        <p className="text-sm">
          <Link className="underline underline-offset-2" to={r.tiers(slug)}>
            New tier…
          </Link>
          <span className="text-fg-muted"> Your draft is kept.</span>
        </p>
      ) : null}
    </div>
  );
}

// ── Who it's for ───────────────────────────────────────────────────────────────────────────────

export function HolderStep({
  draft,
  set,
  errors,
}: StepProps): React.ReactElement {
  return (
    <div className="space-y-4">
      <ChoiceStep<Who>
        legend="Who it's for"
        columns={1}
        value={draft.who}
        onChange={(v) => set("who", v)}
        choices={[
          {
            value: "person",
            label: "Someone specific",
            description: "Tied to their email. You can email them the key.",
            recommended: "It stays findable if the key is lost.",
          },
          {
            value: "anyone",
            label: "Anyone with the key",
            description: "Whoever has the key can use it. One key or a batch.",
          },
        ]}
      />
      {draft.who === "person" ? (
        <div className="space-y-4">
          <div data-create-field="email">
            <FormField
              name="email"
              label="Email"
              required
              value={draft.email}
              onChange={(v: string) => set("email", v)}
              error={errors.email}
              announceError
              help="If this email has a verified account, the license joins it."
            >
              {(f) => (
                <Input {...f} type="email" placeholder="name@company.com" />
              )}
            </FormField>
          </div>
          <FormField
            name="name"
            label="Name"
            optional
            value={draft.name}
            onChange={(v: string) => set("name", v)}
          >
            {(f) => <Input {...f} placeholder="Full name" />}
          </FormField>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            Floating keys aren&apos;t emailed: there&apos;s nobody to send them
            to.
          </p>
          <div data-create-field="count">
            <FormField
              name="count"
              label="How many keys"
              value={draft.count}
              onChange={(v: number | null) => set("count", v)}
              error={errors.count ?? errors.tier}
              announceError
              help={`1 to ${MAX_BATCH}.`}
            >
              {(f) => (
                <NumberInput
                  {...f}
                  nullable
                  integer
                  min={1}
                  max={MAX_BATCH}
                  className="sm:max-w-48"
                />
              )}
            </FormField>
          </div>
          {isBatch(draft) ? (
            <div data-create-field="label">
              <FormField
                name="label"
                label="Batch label"
                required
                value={draft.label}
                onChange={(v: string) => set("label", v)}
                error={errors.label}
                announceError
                help="Names the batch in the list, e.g. Steam keys, October."
              >
                {(f) => <Input {...f} maxLength={80} />}
              </FormField>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Limits ─────────────────────────────────────────────────────────────────────────────────────

export function LimitsStep({
  draft,
  set,
  errors,
  tiers,
  product,
  manualChannels,
  moreOpen,
  onMoreOpen,
}: StepProps & {
  tiers: readonly TierSummary[];
  product: ProductDetail | undefined;
  manualChannels: string[];
  moreOpen: boolean;
  onMoreOpen: (open: boolean) => void;
}): React.ReactElement {
  const tier = draft.tier ? tiers.find((t) => t.id === draft.tier) : undefined;
  const inherited = resolvedDeviceLimit(
    {
      tier: draft.tier,
      maxOfflineDays: null,
      channels: [],
      minVersion: null,
      maxVersion: null,
    },
    tiers,
    product,
  );
  const tierTerm = tier?.policyExpiryDays ?? null;
  const owner = tier ? `${tierName(tier)}'s` : "the product's";
  const expiryMode: ExpiryMode =
    draft.expiryMode === "tier" && !draft.tier ? "none" : draft.expiryMode;
  const expiryOptions: { value: ExpiryMode; label: string }[] = [
    ...(draft.tier
      ? [
          {
            value: "tier" as const,
            label: `${tierName(tier)}'s term (${tierTerm !== null ? `${tierTerm} days` : "never"})`,
          },
        ]
      : []),
    // A tier with no term already is "never": one option, not two.
    ...(draft.tier && tierTerm === null
      ? []
      : [{ value: "none" as const, label: "Never" }]),
    { value: "date" as const, label: "On a date" },
  ];
  const policy = effectivePolicy(
    {
      tier: draft.tier,
      deviceLimit: draft.devices === "set" ? draft.deviceLimit : null,
      maxOfflineDays: draft.maxOfflineDays,
      channels: draft.channels,
      minVersion: draft.minVersion.trim() || null,
      maxVersion: draft.maxVersion.trim() || null,
    },
    tiers,
    product,
  );
  const expiryLine = {
    label: "Expires",
    value:
      expiryMode === "none"
        ? "Never"
        : expiryMode === "date"
          ? draft.expiresAt
            ? new Date(draft.expiresAt).toLocaleDateString()
            : "—"
          : tierTerm !== null
            ? `${tierTerm} days from today`
            : "Never",
    source: expiryMode === "tier" ? ("tier" as const) : ("license" as const),
    from: expiryMode === "tier" ? `from ${tierName(tier)}` : "this license",
  };
  const moreErrors = Boolean(errors.minVersion || errors.maxVersion);

  return (
    <div className="space-y-5">
      <div className="space-y-2" data-create-field="deviceLimit">
        <FormField
          name="devices"
          label="Devices"
          group
          value={draft.devices}
          onChange={(v: "inherit" | "set") => set("devices", v)}
        >
          {(f) => (
            <SegmentedControl
              {...f}
              wrap
              className="self-start"
              options={[
                {
                  value: "inherit",
                  label: `Use ${owner} limit (${inherited ?? "none"})`,
                },
                { value: "set", label: "Set for this license" },
              ]}
            />
          )}
        </FormField>
        {draft.devices === "set" ? (
          <FormField
            name="deviceLimit"
            label="Device limit"
            hideLabel
            value={draft.deviceLimit}
            onChange={(v: number | null) => set("deviceLimit", v)}
            error={errors.deviceLimit}
            announceError
            help="Beats the tier. You can change it later from the license."
          >
            {(f) => (
              <NumberInput
                {...f}
                nullable
                integer
                min={1}
                max={MAX_DEVICE_LIMIT}
                unit="devices"
                className="sm:max-w-48"
                autoFocus
              />
            )}
          </FormField>
        ) : null}
      </div>

      <div className="space-y-2" data-create-field="expiresAt">
        <FormField
          name="expiryMode"
          label="Expires"
          group
          value={expiryMode}
          onChange={(v: ExpiryMode) => set("expiryMode", v)}
        >
          {(f) => (
            <SegmentedControl
              {...f}
              wrap
              className="self-start"
              options={expiryOptions}
            />
          )}
        </FormField>
        {expiryMode === "date" ? (
          <FormField
            name="expiresAt"
            label="Expiry date"
            hideLabel
            value={draft.expiresAt}
            onChange={(v: number | null) => set("expiresAt", v)}
            error={errors.expiresAt}
            announceError
          >
            {(f) => <DateInput {...f} resolvedLabel="Ends" />}
          </FormField>
        ) : null}
      </div>

      <div data-create-field="maxOfflineDays">
        <FormField
          name="maxOfflineDays"
          label="Offline days"
          optional
          help="How long a device works without reaching Polaris Key. Blank: the product's."
          value={draft.maxOfflineDays}
          onChange={(v: number | null) => set("maxOfflineDays", v)}
          error={errors.maxOfflineDays}
          announceError
        >
          {(f) => (
            <NumberInput
              {...f}
              nullable
              integer
              unit="days"
              placeholder={`${product?.defaultMaxOfflineDays ?? "—"} · product default`}
              className="sm:max-w-64"
            />
          )}
        </FormField>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={moreOpen || moreErrors}
          aria-controls="new-license-more"
          onClick={() => onMoreOpen(!moreOpen)}
          className="inline-flex min-h-8 items-center gap-1 rounded-md text-sm font-medium text-fg-strong hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 transition-transform",
              (moreOpen || moreErrors) && "rotate-90",
            )}
          />
          More options: channels and versions
        </button>
        {moreOpen || moreErrors ? (
          <div id="new-license-more" className="mt-3 space-y-4">
            <FormField
              name="channels"
              label="Release tracks"
              help="Added to the tier's release tracks. None ticked: the tier's, else stable only."
              group
              value={draft.channels}
              onChange={(v: string[]) => set("channels", v)}
            >
              {(f) => <ChannelPicker {...f} manual={manualChannels} />}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <div data-create-field="minVersion">
                <FormField
                  name="minVersion"
                  label="Minimum version"
                  value={draft.minVersion}
                  onChange={(v: string | null) => set("minVersion", v ?? "")}
                  error={errors.minVersion}
                  announceError
                >
                  {(f) => <VersionInput {...f} placeholder="e.g. 1.2.0" />}
                </FormField>
              </div>
              <div data-create-field="maxVersion">
                <FormField
                  name="maxVersion"
                  label="Maximum version"
                  value={draft.maxVersion}
                  onChange={(v: string | null) => set("maxVersion", v ?? "")}
                  error={errors.maxVersion}
                  announceError
                >
                  {(f) => <VersionInput {...f} placeholder="e.g. 2.0.0" />}
                </FormField>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <EffectivePolicy
        title="What devices receive"
        lines={[expiryLine, ...policy]}
      />
    </div>
  );
}
