/**
 * The license record's **Limits** (licenses.detail; LX-32, LX-33): one row per limit the Worker's
 * resolver reports (`LicenseDetail.terms`), with the layer each value came from (the license, the
 * tier, the platform default) and a per-row **Override** that sets it on this license only. A row
 * the license sets itself is marked, says what the tier gives instead, and offers **Use X's** to
 * go back to it.
 *
 * Offline days, Release tracks and Versions are edited in the dialog below; Devices opens the
 * device-limit sheet, and Fingerprint mode is the tier's (**Open tier**). A license on an older
 * Worker, without `terms`, is resolved here with the same resolver.
 */

import * as React from "react";
import {
  GitBranch,
  Fingerprint,
  MonitorSmartphone,
  Tag,
  WifiOff,
} from "lucide-react";
import type {
  LicenseDetail,
  ProductDetail,
  TierSummary,
} from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ChannelPicker } from "../../../../ui/ChannelPicker.js";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  useDismissGuard,
} from "../../../../ui/Dialog.js";
import { Form, FormField, useAdminForm } from "../../../../ui/form.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { Section } from "../../../../ui/Section.js";
import { toast } from "../../../../ui/toast.js";
import { VersionInput } from "../../../../ui/VersionInput.js";
import {
  termsPatch,
  termsOf as licenseTermsValues,
  validateTerms,
  type TermsValues,
} from "../pages/LicenseTerms.js";
import {
  MAX_OFFLINE_DAYS,
  MIN_OFFLINE_DAYS,
  termsOnTier,
  useManualChannels,
} from "./shared.js";

export type LimitKind =
  | "devices"
  | "offline"
  | "tracks"
  | "versions"
  | "fingerprint";

export interface LimitRow {
  kind: LimitKind;
  label: string;
  value: string;
  /** The source in words: "Education", "Set on this license", "Platform default". */
  from: string;
  /** Under `from` on an overridden row: "Education gives 7". */
  gives?: string;
  /** The license sets this itself. */
  overridden: boolean;
  /** What "Use X's" falls back to ("Education's", "the platform default"). */
  inherits: string;
  /** Fingerprint mode is the tier's: the row links to it. */
  tierId?: string;
}

const PLATFORM = "Platform default";

const tierName = (t: TierSummary | undefined): string =>
  t ? t.label || t.id : "the tier";

function modeText(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function versionsText(min: string | null, max: string | null): string {
  if (!min && !max) return "Any";
  return [min ? `≥ ${min}` : null, max ? `≤ ${max}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** The rows, from the Worker's `terms` (else the same resolver run here). */
export function limitRows(
  license: LicenseDetail,
  tiers: readonly TierSummary[],
  product: Pick<
    ProductDetail,
    "defaultDeviceLimit" | "defaultMaxOfflineDays"
  > | null,
): LimitRow[] {
  const tier = license.tier
    ? tiers.find((t) => t.id === license.tier)
    : undefined;
  const t =
    license.terms ??
    termsOnTier(license, license.tier ?? null, tiers, product ?? undefined);
  const name = tierName(tier);
  const fromTier = tier ? name : "the tier";

  const dev = t.deviceLimit;
  const inh = t.inheritedDeviceLimit;
  const inhFrom =
    inh.source === "tier"
      ? name
      : inh.source === "entitlement"
        ? "An entitlement"
        : PLATFORM;
  const devText = (n: number) => (n > 0 ? String(n) : "Unlimited");
  const rows: LimitRow[] = [
    {
      kind: "devices",
      label: "Devices",
      value: devText(dev.value),
      from:
        dev.source === "license"
          ? "Set on this license"
          : dev.source === "tier"
            ? name
            : dev.source === "entitlement"
              ? "An entitlement"
              : PLATFORM,
      ...(dev.source === "license"
        ? { gives: `${inhFrom} gives ${devText(inh.value)}` }
        : {}),
      overridden: dev.source === "license",
      inherits: inh.source === "tier" ? `${name}'s` : "the inherited limit",
    },
  ];

  const off = t.maxOfflineDays;
  rows.push({
    kind: "offline",
    label: "Offline days",
    value: `${off.value} days`,
    from: off.source === "license" ? "Set on this license" : PLATFORM,
    ...(off.source === "license" && product
      ? { gives: `${PLATFORM} gives ${product.defaultMaxOfflineDays}` }
      : {}),
    overridden: off.source === "license",
    inherits: "the platform default",
  });

  const ch = t.channels;
  rows.push({
    kind: "tracks",
    label: "Release tracks",
    value: ch.value.length ? ch.value.join(", ") : "stable",
    from:
      ch.source === "none"
        ? PLATFORM
        : ch.source === "tier"
          ? name
          : ch.source === "both"
            ? `This license and ${fromTier}`
            : "Set on this license",
    ...(ch.source === "license" || ch.source === "both"
      ? {
          gives: tier?.channels.length
            ? `${name} gives ${tier.channels.join(", ")}`
            : `${PLATFORM} gives stable`,
        }
      : {}),
    overridden: ch.source === "license" || ch.source === "both",
    inherits: tier?.channels.length ? `${name}'s` : "the platform default",
  });

  const { minVersion: min, maxVersion: max } = t;
  const own = min.source === "license" || max.source === "license";
  const viaTier = min.source === "tier" || max.source === "tier";
  rows.push({
    kind: "versions",
    label: "Versions",
    value: versionsText(min.value, max.value),
    from:
      own && viaTier
        ? `This license and ${fromTier}`
        : own
          ? "Set on this license"
          : viaTier
            ? name
            : PLATFORM,
    ...(own
      ? {
          gives: `${
            tier && (tier.minVersion || tier.maxVersion) ? name : PLATFORM
          } gives ${versionsText(tier?.minVersion ?? null, tier?.maxVersion ?? null)}`,
        }
      : {}),
    overridden: own,
    inherits: viaTier ? `${name}'s` : "the platform default",
  });

  const fp = t.fingerprintMode;
  rows.push({
    kind: "fingerprint",
    label: "Fingerprint mode",
    value: modeText(fp.value),
    from: fp.source === "tier" ? name : fp.source === "off" ? "Off" : PLATFORM,
    overridden: false,
    inherits: "",
    ...(fp.source === "tier" && tier ? { tierId: tier.id } : {}),
  });
  return rows;
}

const ICONS: Record<LimitKind, React.ReactElement> = {
  devices: <MonitorSmartphone aria-hidden className="size-4" />,
  offline: <WifiOff aria-hidden className="size-4" />,
  tracks: <GitBranch aria-hidden className="size-4" />,
  versions: <Tag aria-hidden className="size-4" />,
  fingerprint: <Fingerprint aria-hidden className="size-4" />,
};

export function LimitsTable({
  slug,
  license,
  tiers,
  product,
  onDeviceLimit,
}: {
  slug: string;
  license: LicenseDetail;
  tiers: readonly TierSummary[];
  product: ProductDetail | undefined;
  /** Devices opens the device-limit sheet. */
  onDeviceLimit: () => void;
}): React.ReactElement {
  const rows = limitRows(license, tiers, product ?? null);
  const [editing, setEditing] = React.useState<LimitKind | null>(null);
  const [busy, setBusy] = React.useState<LimitKind | null>(null);

  const reset = async (row: LimitRow): Promise<void> => {
    setBusy(row.kind);
    try {
      if (row.kind === "devices")
        await mutate("patchLicense", slug, license.id, { deviceLimit: null });
      else if (row.kind === "offline")
        await mutate("patchLicense", slug, license.id, {
          maxOfflineDays: null,
        });
      else if (row.kind === "tracks")
        await mutate("patchLicense", slug, license.id, { channels: [] });
      else
        await mutate("patchLicense", slug, license.id, {
          minVersion: null,
          maxVersion: null,
        });
      toast.success(`${row.label} uses ${row.inherits}`);
    } catch (e) {
      toast.error(`${row.label} wasn't changed`, {
        description: errorCopy(e, { thing: "License" }).description,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section id="limits" title="Limits" headingLevel={2} variant="settings">
      <table className="w-full text-sm max-sm:block">
        <caption className="sr-only">Limits and where each comes from</caption>
        <thead className="max-sm:sr-only">
          <tr className="[&>th]:h-9 [&>th]:px-5 [&>th]:text-left [&>th]:text-xs [&>th]:font-medium [&>th]:text-fg-muted">
            <th scope="col">Limit</th>
            <th scope="col">Value</th>
            <th scope="col">From</th>
            <th scope="col" className="!text-right">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {rows.map((row) => (
            <tr
              key={row.kind}
              data-limit={row.kind}
              data-service={row.kind === "tracks" ? "release" : undefined}
              data-marked={row.overridden ? "" : undefined}
              className={
                "border-t border-border align-middle max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-5 max-sm:py-3 [&>td]:px-5 [&>td]:py-3 max-sm:[&>td]:p-0" +
                (row.overridden
                  ? " bg-surface-sunken shadow-[inset_3px_0_0_var(--pk-fg-strong,currentColor)]"
                  : "")
              }
            >
              <td className="max-sm:col-start-1 max-sm:row-start-1">
                <span className="inline-flex items-center gap-2 font-medium text-fg-strong">
                  {ICONS[row.kind]}
                  {row.label}
                </span>
              </td>
              <td className="max-sm:col-start-2 max-sm:row-start-1 max-sm:text-right">
                <strong className="font-semibold tabular-nums text-fg-strong">
                  {row.value}
                </strong>
              </td>
              <td className="max-sm:col-start-1 max-sm:row-start-2">
                <span className="flex flex-col">
                  <span
                    className={
                      row.overridden ? "font-medium text-fg-strong" : undefined
                    }
                  >
                    {row.from}
                  </span>
                  {row.gives ? (
                    <span className="text-xs text-fg-muted">{row.gives}</span>
                  ) : null}
                </span>
              </td>
              <td className="text-right max-sm:col-start-2 max-sm:row-start-2 max-sm:self-end">
                <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
                  {row.kind === "fingerprint" ? (
                    row.tierId ? (
                      <Button asChild variant="link" size="sm">
                        <Link to={r.tier(slug, row.tierId)}>Open tier</Link>
                      </Button>
                    ) : null
                  ) : (
                    <>
                      {row.overridden ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busy === row.kind}
                          onClick={() => void reset(row)}
                          aria-label={`${row.label}: use ${row.inherits}`}
                        >
                          {`Use ${row.inherits}`}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${row.overridden ? "Edit" : "Override"} ${row.label.toLowerCase()}`}
                        onClick={() =>
                          row.kind === "devices"
                            ? onDeviceLimit()
                            : setEditing(row.kind)
                        }
                      >
                        {row.overridden ? "Edit" : "Override"}
                      </Button>
                    </>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <LimitOverrideDialog
        slug={slug}
        license={license}
        product={product}
        kind={editing}
        onClose={() => setEditing(null)}
      />
    </Section>
  );
}

const DIALOG_TITLES: Record<"offline" | "tracks" | "versions", string> = {
  offline: "Offline days",
  tracks: "Release tracks",
  versions: "Versions",
};

/** Sets Offline days, Release tracks or Versions on this license only. */
export function LimitOverrideDialog({
  slug,
  license,
  product,
  kind,
  onClose,
}: {
  slug: string;
  license: LicenseDetail;
  product: ProductDetail | undefined;
  kind: LimitKind | null;
  onClose: () => void;
}): React.ReactElement {
  const shown = kind === "offline" || kind === "tracks" || kind === "versions";
  return (
    <Dialog
      open={shown}
      onOpenChange={(o) => !o && onClose()}
      title={shown ? `Override ${DIALOG_TITLES[kind].toLowerCase()}` : ""}
      description="Applies to this license only. Devices pick it up at their next license refresh."
    >
      {shown ? (
        <OverrideForm
          slug={slug}
          license={license}
          product={product}
          kind={kind}
          onDone={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function OverrideForm({
  slug,
  license,
  product,
  kind,
  onDone,
}: {
  slug: string;
  license: LicenseDetail;
  product: ProductDetail | undefined;
  kind: "offline" | "tracks" | "versions";
  onDone: () => void;
}): React.ReactElement {
  const manual = useManualChannels(slug);
  const values = React.useMemo(() => licenseTermsValues(license), [license]);
  const form = useAdminForm<TermsValues>({
    values,
    validate: validateTerms,
    onSubmit: async (draft, { server }) => {
      const body = termsPatch(server, draft);
      if (Object.keys(body).length) {
        await mutate("patchLicense", slug, license.id, body);
        toast.success(`${DIALOG_TITLES[kind]} saved`);
      }
      onDone();
    },
  });
  useDismissGuard(form.isDirty && !form.isSubmitting);
  return (
    <Form form={form} aria-label={DIALOG_TITLES[kind]} className="contents">
      <DialogBody className="space-y-4">
        {kind === "offline" ? (
          <FormField
            name="maxOfflineDays"
            label="Offline days"
            help={`Blank uses the platform default (${product?.defaultMaxOfflineDays ?? "—"} days).`}
          >
            {(f) => (
              <NumberInput
                {...f}
                nullable
                integer
                min={MIN_OFFLINE_DAYS}
                max={MAX_OFFLINE_DAYS}
                unit="days"
                className="sm:max-w-48"
                autoFocus
              />
            )}
          </FormField>
        ) : null}
        {kind === "tracks" ? (
          <FormField
            name="channels"
            label="Release tracks"
            help="Added to the tier's release tracks."
            group
          >
            {(f) => (
              <ChannelPicker {...f} manual={manual} held={values.channels} />
            )}
          </FormField>
        ) : null}
        {kind === "versions" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="minVersion" label="Minimum version">
              {(f) => <VersionInput {...f} placeholder="None" autoFocus />}
            </FormField>
            <FormField name="maxVersion" label="Maximum version">
              {(f) => <VersionInput {...f} placeholder="None" />}
            </FormField>
          </div>
        ) : null}
        {form.submitError && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="This wasn't saved" live>
            {errorCopy(form.submitError, { thing: "License" }).description}
          </Callout>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={form.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.isSubmitting}>
          Save
        </Button>
      </DialogFooter>
    </Form>
  );
}
