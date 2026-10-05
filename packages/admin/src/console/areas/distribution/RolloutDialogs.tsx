/**
 * The rollout write dialogs, shared by the Matrix cell drawer and the Rollouts page (ADMIN.md
 * §6.4): a verb (pause, resume, halt, complete) behind its §5.2 level, **Set percentage…** with
 * the stepped control (MTX-5), and **Start rollout…** (deliverable, outlet, channel, release and
 * the initial percentage).
 *
 * Only the verbs the server allows are offered (`controls`); a mirrored rollout offers none and
 * names the store that owns it (MTX-1, §5.10).
 *
 * **Halt everywhere…** (UX-08, EXPERIENCE.md O2) halts every rollout of one release in one L2
 * confirm. A rollout that cannot be halted here (already halted, complete, or a store's mirror) is
 * listed as a disabled row with the reason, never a checked box (EXPERIENCE.md §7.1).
 */

import * as React from "react";
import { Lock, Pause } from "lucide-react";
import type {
  DistributionMatrix,
  MatrixRolloutDto,
  Rollout,
  RolloutVerb,
} from "../../../api.js";
import { confirmFor, type ActionId } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatBasisPoints } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Combobox } from "../../../ui/Combobox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { FormField } from "../../../ui/form.js";
import { NumberInput, numberRangeError } from "../../../ui/NumberInput.js";
import { Select } from "../../../ui/Select.js";
import { toast } from "../../../ui/toast.js";
import { Callout } from "../../../ui/Callout.js";
import { mutate } from "../../data/mutations.js";
import {
  useDeliverables,
  useMatrix,
  useOutlets,
  useReleaseStore,
} from "./data.js";
import {
  outletKindLabel,
  rolloutSummary,
  SOURCE_NAMES,
  VERB_DONE,
  VERB_LABEL,
} from "./format.js";

const describe = (e: unknown): { title: string; description?: string } =>
  errorCopy(e, { area: "distribution", thing: "Rollout" });

/** What a rollout is about, for dialog copy: "2.4.0 on App Store / stable". */
export function rolloutWhere(
  r: Pick<Rollout, "outletId" | "channel" | "releaseId">,
  version?: string,
): string {
  return `${version ?? r.releaseId} on ${r.outletId} / ${r.channel}`;
}

const VERB_CONSEQUENCES: Record<
  RolloutVerb,
  (r: Rollout, version: string) => string[]
> = {
  pause: (r, v) => [
    `Devices outside the ${formatBasisPoints(r.rolloutBp)} already offered ${v} keep the previous release.`,
    `The storefront feeds and the download page stop listing ${v} on ${r.outletId}.`,
    "Resume continues from the same percentage.",
  ],
  resume: (r, v) => [
    `${v} is offered again on ${r.outletId} / ${r.channel} at ${formatBasisPoints(r.rolloutBp)}.`,
  ],
  halt: (r, v) => [
    `The signed feed, the updater feeds, the storefront feeds and the download page stop offering ${v} on ${r.outletId}.`,
    "Devices that already installed it keep it.",
    "Only an explicit resume lifts a halt.",
  ],
  complete: (r, v) => [
    `${v} is offered to every device on ${r.outletId} / ${r.channel} (100 %).`,
    "A completed rollout cannot be paused or halted again; publish a newer release instead.",
  ],
};

/** A verb's confirmation (L1 pause/resume, L2 halt/complete). */
export function RolloutVerbDialog({
  slug,
  target,
  onClose,
}: {
  slug: string;
  target: { rollout: Rollout; verb: RolloutVerb; version?: string } | null;
  onClose: () => void;
}): React.ReactElement | null {
  if (!target) return null;
  const { rollout, verb } = target;
  const version = target.version ?? rollout.releaseId;
  const policy = confirmFor(`rollout.${verb}` as ActionId);
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      intent={policy.intent === "none" ? "neutral" : policy.intent}
      title={`${VERB_LABEL[verb]} the rollout of ${version}?`}
      description={`${rollout.outletId} / ${rollout.channel} · ${rolloutSummary(rollout)}`}
      consequences={VERB_CONSEQUENCES[verb](rollout, version)}
      confirmLabel={`${VERB_LABEL[verb]} ${version}`}
      describeError={describe}
      onConfirm={async () => {
        await mutate(
          "rolloutAction",
          slug,
          rollout.outletId,
          rollout.channel,
          verb,
          { deliverable: rollout.deliverableId, releaseId: rollout.releaseId },
        );
        toast.success(
          `${VERB_DONE[verb]} the rollout of ${rolloutWhere(rollout, version)}`,
        );
        onClose();
      }}
    />
  );
}

/** The verbs a rollout offers, in order, as the server allows them. */
export function allowedVerbs(r: Rollout | MatrixRolloutDto): RolloutVerb[] {
  if (r.mirrored) return [];
  if ("controls" in r) return r.controls;
  // The rollouts list carries no `controls`: the transition table (worker `rollouts.ts`).
  switch (r.state) {
    case "active":
      return ["pause", "halt", "complete"];
    case "paused":
      return ["resume", "halt"];
    case "halted":
      return ["resume"];
    default:
      return [];
  }
}

/** Can the percentage be set? Not on a halted or complete rollout, nor a mirrored one. */
export function canSetPercentage(r: Rollout): boolean {
  return !r.mirrored && (r.state === "active" || r.state === "paused");
}

const PRESETS = [1, 5, 10, 25, 50, 100] as const;

/** The stepped percentage control: presets plus a custom value (a fraction, shown as a percent). */
function PercentPicker({
  id,
  value,
  onChange,
  error,
  label,
}: {
  id: string;
  value: number | null;
  onChange: (v: number | null) => void;
  error?: string;
  label: string;
}): React.ReactElement {
  return (
    <FormField<number | null>
      name={id}
      label={label}
      required
      value={value}
      onChange={onChange}
      error={error}
      announceError
      help="Devices are bucketed by a stable hash, so raising the percentage only adds devices; lowering it takes the release away from the devices above the new line that have not installed it."
    >
      {(field) => (
        <div className="space-y-2">
          <div
            role="group"
            aria-label="Presets"
            className="flex flex-wrap gap-1.5"
          >
            {PRESETS.map((p) => {
              const on = value !== null && Math.round(value * 100) === p;
              return (
                <Button
                  key={p}
                  size="xs"
                  variant={on ? "primary" : "outline"}
                  aria-pressed={on}
                  onClick={() => onChange(p / 100)}
                >
                  {p} %
                </Button>
              );
            })}
          </div>
          <NumberInput
            id={field.id}
            value={value}
            onChange={onChange}
            percent
            min={0}
            max={100}
            step="any"
            aria-describedby={field["aria-describedby"]}
            aria-invalid={field["aria-invalid"]}
            aria-required
          />
        </div>
      )}
    </FormField>
  );
}

/** A fraction (0–1) as basis points, or `null` when out of range. */
function toBp(fraction: number | null): number | null {
  if (fraction === null || Number.isNaN(fraction)) return null;
  const bp = Math.round(fraction * 10_000);
  return bp < 0 || bp > 10_000 ? null : bp;
}

/** **Set percentage…** (L1): `POST …/rollouts/:outlet/:channel {releaseId, bp}`. */
export function SetPercentageDialog({
  slug,
  rollout,
  version,
  onClose,
}: {
  slug: string;
  rollout: Rollout | null;
  version?: string;
  onClose: () => void;
}): React.ReactElement | null {
  const [value, setValue] = React.useState<number | null>(
    rollout ? rollout.rolloutBp / 10_000 : null,
  );
  const [error, setError] = React.useState<string | undefined>();
  const [failure, setFailure] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  if (!rollout) return null;
  const v = version ?? rollout.releaseId;
  const bp = toBp(value);
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const range = numberRangeError(value, {
      min: 0,
      max: 100,
      percent: true,
      required: true,
    });
    if (range || bp === null) {
      setError(range ?? "Use a percentage from 0 to 100.");
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await mutate("setRollout", slug, rollout.outletId, rollout.channel, {
        deliverable: rollout.deliverableId,
        releaseId: rollout.releaseId,
        bp,
      });
      toast.success(
        `Set the rollout of ${rolloutWhere(rollout, v)} to ${formatBasisPoints(bp)}`,
      );
      onClose();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = failure ? describe(failure) : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      dismissible={!busy}
      title={`Set the percentage of ${v}`}
      description={`${rollout.outletId} / ${rollout.channel} · now ${rolloutSummary(rollout)}`}
    >
      <form
        noValidate
        onSubmit={(e) => void submit(e)}
        aria-label="Set percentage"
      >
        <DialogBody className="space-y-4">
          <PercentPicker
            id="rollout-percent"
            label="Percentage of devices"
            value={value}
            onChange={(next) => {
              setValue(next);
              setError(undefined);
            }}
            error={error}
          />
          {copy ? (
            <Callout tone="danger" title={copy.title} live>
              {copy.description}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {bp === null ? "Set percentage" : `Set to ${formatBasisPoints(bp)}`}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * **Start rollout…** (L1, MTX-5): deliverable, outlet, channel, release and the initial
 * percentage. Starting on a channel that already rolls out another release replaces it there.
 */
export function StartRolloutDialog({
  slug,
  open,
  initial,
  onClose,
}: {
  slug: string;
  open: boolean;
  initial: {
    deliverable: string;
    outlet?: string;
    releaseId?: string;
    channel?: string;
  };
  onClose: () => void;
}): React.ReactElement | null {
  if (!open) return null;
  return <StartRolloutForm slug={slug} initial={initial} onClose={onClose} />;
}

function StartRolloutForm({
  slug,
  initial,
  onClose,
}: {
  slug: string;
  initial: {
    deliverable: string;
    outlet?: string;
    releaseId?: string;
    channel?: string;
  };
  onClose: () => void;
}): React.ReactElement {
  const [deliverable, setDeliverable] = React.useState(initial.deliverable);
  const [outlet, setOutlet] = React.useState<string | null>(
    initial.outlet ?? null,
  );
  const [channel, setChannel] = React.useState<string | null>(
    initial.channel ?? null,
  );
  const [releaseId, setReleaseId] = React.useState<string | null>(
    initial.releaseId ?? null,
  );
  const [percent, setPercent] = React.useState<number | null>(0.05);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);

  const deliverables = useDeliverables(slug);
  const outlets = useOutlets(slug);
  const store = useReleaseStore(slug);
  const matrix = useMatrix(slug, deliverable, 50);

  const releases: DistributionMatrix["releases"] = matrix.data?.releases ?? [];
  const release = releases.find((r) => r.releaseId === releaseId);
  const channels = React.useMemo(() => {
    const set = new Set<string>();
    for (const c of store.data?.channels ?? []) set.add(c.channel);
    for (const r of releases) if (r.channel) set.add(r.channel);
    if (set.size === 0) set.add("stable");
    return [...set].sort();
  }, [store.data, releases]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!outlet) next.outlet = "Choose an outlet.";
    if (!channel) next.channel = "Choose a channel.";
    if (!releaseId) next.release = "Choose a release.";
    const bp = toBp(percent);
    const range = numberRangeError(percent, {
      min: 0,
      max: 100,
      percent: true,
      required: true,
    });
    if (range || bp === null) next.percent = range ?? "Use 0 to 100 %.";
    setErrors(next);
    if (Object.keys(next).length || bp === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await mutate("setRollout", slug, outlet!, channel!, {
        deliverable,
        releaseId: releaseId!,
        bp,
      });
      toast.success(
        `Started the rollout of ${release?.version ?? releaseId} on ${outlet} / ${channel} at ${formatBasisPoints(bp)}`,
      );
      onClose();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  const copy = failure ? describe(failure) : null;
  const deliverableOptions = (deliverables.data?.deliverables ?? []).map(
    (d) => ({
      value: d.id,
      label: d.id === "app" ? "App" : d.id,
      description: d.kind === "pack" ? "Pack" : undefined,
    }),
  );
  if (!deliverableOptions.some((o) => o.value === deliverable))
    deliverableOptions.unshift({
      value: deliverable,
      label: deliverable === "app" ? "App" : deliverable,
      description: undefined,
    });

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && !busy && onClose()}
      dismissible={!busy}
      title="Start a rollout"
      description="Offer a release to a share of the devices on one outlet's channel. Raise the share as it proves itself."
    >
      <form
        noValidate
        onSubmit={(e) => void submit(e)}
        aria-label="Start a rollout"
      >
        <DialogBody className="grid gap-4 sm:grid-cols-2">
          <FormField<string | null>
            name="deliverable"
            label="Deliverable"
            required
            value={deliverable}
            onChange={(v) => {
              setDeliverable(v ?? "app");
              setReleaseId(null);
            }}
          >
            {(field) => (
              <Select {...field} ref={undefined} options={deliverableOptions} />
            )}
          </FormField>
          <FormField<string | null>
            name="outlet"
            label="Outlet"
            required
            value={outlet}
            onChange={setOutlet}
            error={errors.outlet}
            announceError
          >
            {(field) => (
              <Select
                {...field}
                ref={undefined}
                placeholder={
                  outlets.isPending ? "Loading…" : "Choose an outlet"
                }
                options={(outlets.data?.outlets ?? [])
                  .filter((o) => o.removedAt === null)
                  .map((o) => ({
                    value: o.outletId,
                    label: o.outletId,
                    description: outletKindLabel(o.kind),
                  }))}
              />
            )}
          </FormField>
          <FormField<string | null>
            name="channel"
            label="Channel"
            required
            value={channel}
            onChange={setChannel}
            error={errors.channel}
            announceError
          >
            {(field) => (
              <Select
                {...field}
                ref={undefined}
                placeholder="Choose a channel"
                options={channels.map((c) => ({ value: c, label: c }))}
              />
            )}
          </FormField>
          <FormField<string | null>
            name="release"
            label="Release"
            required
            value={releaseId}
            onChange={setReleaseId}
            error={errors.release}
            announceError
          >
            {(field) => (
              <Combobox
                id={field.id}
                value={releaseId}
                onChange={(v) => {
                  setReleaseId(v);
                  const r = releases.find((x) => x.releaseId === v);
                  if (r?.channel && !channel) setChannel(r.channel);
                }}
                aria-describedby={field["aria-describedby"]}
                aria-invalid={field["aria-invalid"]}
                placeholder={matrix.isPending ? "Loading…" : "Choose a release"}
                searchPlaceholder="Search versions"
                emptyText="No release matches."
                options={releases.map((r) => ({
                  value: r.releaseId,
                  label: r.version,
                  secondary: [r.channel, r.yanked ? "yanked" : null]
                    .filter(Boolean)
                    .join(" · "),
                  searchText: `${r.version} ${r.channel ?? ""}`,
                  disabled: r.yanked,
                }))}
              />
            )}
          </FormField>
          <div className="sm:col-span-2">
            <PercentPicker
              id="start-percent"
              label="Initial percentage"
              value={percent}
              onChange={(v) => {
                setPercent(v);
                setErrors((e) => ({ ...e, percent: "" }));
              }}
              error={errors.percent || undefined}
            />
          </div>
          {copy ? (
            <div className="sm:col-span-2">
              <Callout tone="danger" title={copy.title} live>
                {copy.description}
              </Callout>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Start rollout
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// ── Halt everywhere (UX-08) ──────────────────────────────────────────────────────────────────

/** One rollout of the release, with the outlet's display name ("Google Play"). */
export interface HaltRow {
  rollout: Rollout | MatrixRolloutDto;
  outletName: string;
}

const rowKey = (r: Pick<Rollout, "outletId" | "channel">): string =>
  `${r.outletId}/${r.channel}`;

/** True when this console may halt the rollout (the server's own transition table). */
export function canHalt(r: Rollout | MatrixRolloutDto): boolean {
  return allowedVerbs(r).includes("halt");
}

/** Why a row is not offered: "Already halted", "Complete", "Halt it in Google Play". */
export function haltBlocker(r: Rollout | MatrixRolloutDto): string | null {
  if (canHalt(r)) return null;
  if (r.state === "halted") return "Already halted";
  if (r.state === "complete") return "Complete";
  if (r.mirrored) return `Halt it in ${SOURCE_NAMES[r.source] ?? r.source}`;
  return "Can't be halted";
}

/** The share a row shows on the right: "20 %", "5 % · paused". */
function rowShare(r: Rollout | MatrixRolloutDto): string {
  const pct = formatBasisPoints(r.rolloutBp);
  return r.state === "paused" ? `${pct} · paused` : pct;
}

/** Some of the halts were refused: the dialog stays open and names them. */
export class PartialHaltError extends Error {
  constructor(
    readonly halted: string[],
    readonly refused: { where: string; error: unknown }[],
  ) {
    super(`${refused.length} of ${halted.length + refused.length} not halted`);
  }
}

/**
 * **Halt everywhere…**: every haltable rollout of one release, preselected, in one danger
 * confirm. Each halt is the same `rolloutAction` the per-rollout dialog sends, one after the other;
 * a refusal leaves the dialog open with the outlets that were not halted, while the rest stay
 * halted (and become "Already halted" rows when the matrix refetches).
 */
export function HaltEverywhereDialog({
  slug,
  open,
  version,
  previous,
  rows,
  onClose,
}: {
  slug: string;
  open: boolean;
  version: string;
  /** The release devices fall back to, when there is one ("2.3.2"). */
  previous?: string | null;
  rows: HaltRow[];
  onClose: () => void;
}): React.ReactElement | null {
  if (!open) return null;
  return (
    <HaltEverywhereConfirm
      slug={slug}
      version={version}
      previous={previous ?? null}
      rows={rows}
      onClose={onClose}
    />
  );
}

function HaltEverywhereConfirm({
  slug,
  version,
  previous,
  rows,
  onClose,
}: {
  slug: string;
  version: string;
  previous: string | null;
  rows: HaltRow[];
  onClose: () => void;
}): React.ReactElement {
  // Opened with every haltable rollout chosen; rows the server refuses never enter the set.
  const [chosen, setChosen] = React.useState<Set<string>>(
    () =>
      new Set(
        rows.filter((r) => canHalt(r.rollout)).map((r) => rowKey(r.rollout)),
      ),
  );
  const targets = rows.filter(
    (r) => canHalt(r.rollout) && chosen.has(rowKey(r.rollout)),
  );
  const where = (r: HaltRow): string =>
    `${r.outletName} · ${r.rollout.channel}`;
  const n = targets.length;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      intent="danger"
      title={`Halt ${version} everywhere?`}
      description={
        previous
          ? `Devices that haven't updated stay on ${previous}. Devices already on ${version} keep it.`
          : `Devices already on ${version} keep it.`
      }
      consequences={[
        "Takes effect on each device's next feed check.",
        previous
          ? `Resume per outlet from Rollouts, or roll back to ${previous}.`
          : "Resume per outlet from Rollouts.",
      ]}
      confirmLabel={n === 1 ? "Halt 1 rollout" : `Halt ${n} rollouts`}
      confirmDisabled={n === 0}
      describeError={(e) => {
        if (e instanceof PartialHaltError) {
          const first = e.refused[0]!;
          return {
            title:
              e.refused.length === 1
                ? `${first.where} was not halted`
                : `${e.refused.length} rollouts were not halted`,
            description: `${e.refused.map((x) => x.where).join(", ")}: ${describe(first.error).title}`,
          };
        }
        return describe(e);
      }}
      onConfirm={async () => {
        const halted: string[] = [];
        const refused: { where: string; error: unknown }[] = [];
        for (const row of targets) {
          const r = row.rollout;
          try {
            await mutate("rolloutAction", slug, r.outletId, r.channel, "halt", {
              deliverable: r.deliverableId,
              releaseId: r.releaseId,
            });
            halted.push(where(row));
          } catch (error) {
            refused.push({ where: where(row), error });
          }
        }
        if (halted.length)
          toast.success(`Halted ${version} on ${halted.join(", ")}`);
        if (refused.length) throw new PartialHaltError(halted, refused);
        onClose();
      }}
    >
      <ul
        aria-label="Rollouts"
        className="divide-y divide-border overflow-hidden rounded-lg border border-border"
      >
        {rows.map((row) => {
          const r = row.rollout;
          const key = rowKey(r);
          const blocker = haltBlocker(r);
          if (blocker)
            return (
              <li
                key={key}
                aria-disabled="true"
                className="flex min-h-11 items-center justify-between gap-3 bg-surface-sunken px-3 py-2 text-fg-muted"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {r.state === "halted" ? (
                    <Pause aria-hidden className="size-4 shrink-0" />
                  ) : (
                    <Lock aria-hidden className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 break-words">{where(row)}</span>
                </span>
                <span className="max-w-[50%] text-right">{blocker}</span>
              </li>
            );
          return (
            <li
              key={key}
              className="flex min-h-11 items-center justify-between gap-3 px-3 py-2"
            >
              <Checkbox
                checked={chosen.has(key)}
                onCheckedChange={(on) =>
                  setChosen((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
                label={where(row)}
              />
              <span className="shrink-0 text-right tabular-nums text-fg-muted">
                {rowShare(r)}
              </span>
            </li>
          );
        })}
      </ul>
    </ConfirmDialog>
  );
}
