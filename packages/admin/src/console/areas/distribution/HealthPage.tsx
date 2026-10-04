/**
 * Distribution → Health (ADMIN.md §6.4, T1): what devices report after an update reaches them,
 * the auto-halt that watches it, and the Sentry halt candidates waiting for an operator. Fixes
 * UHL-1 to UHL-8.
 *
 * - A window control (1 h · 6 h · 24 h · 72 h, up to the server's maximum; UHL-2), in the URL.
 * - Per rollout a `Funnel` (offered → downloaded → applied → confirmed, with step conversion)
 *   and the losses as danger bars, each with "Show as table" (UHL-1). Releases link (UHL-6).
 * - The auto-halt's last reading, trips and alerts (UHL-3); its settings form re-seeds only while
 *   clean, rates are percentages with range checks, and Reset to defaults (UHL-4, UHL-5).
 * - Sentry candidates, Open and Decided (UHL-7). Confirm is L2 ("halts the rollout"); the
 *   unconfigured state links to Outlet credentials.
 */

import * as React from "react";
import type {
  AutoHaltSettings,
  UpdateHealthObject,
  UpdateHealthResponse,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import {
  formatCount,
  formatPercent,
  fromSeconds,
} from "../../../lib/format.js";
import { humanize } from "../../../lib/status.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Funnel } from "../../../ui/charts/Funnel.js";
import { StatTile } from "../../../ui/charts/StatTile.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Form, FormField, useAdminForm } from "../../../ui/form.js";
import { NumberInput, numberRangeError } from "../../../ui/NumberInput.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { Timeline } from "../../../ui/Timeline.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs, TabPanel } from "../../components/PageTabs.js";
import { mutate } from "../../data/mutations.js";
import { Link, useSearchParam } from "../../router.js";
import { r } from "../../routes.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  type AttentionItem,
} from "../../templates/Dashboard.js";
import { HEALTH_WINDOWS, QUERY, updatedAt, useHealth } from "./data.js";
import { rolloutSummary } from "./format.js";

type HealthRollout = UpdateHealthResponse["rollouts"][number];

const describe = (e: unknown) =>
  errorCopy(e, { area: "distribution", thing: "Candidate" });

function rate(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : formatPercent(v, 1);
}

export function HealthPage({ slug }: { slug: string }): React.ReactElement {
  const [windowHours, setWindow] = useSearchParam("window", QUERY.window);
  const health = useHealth(slug, windowHours);
  const data = health.data;
  const maxWindow = data?.autoHalt.maxWindowHours ?? 72;
  const windows = HEALTH_WINDOWS.filter((w) => w <= maxWindow);

  const openCandidates = (data?.sentry.candidates ?? []).filter(
    (c) => c.state === "open",
  );
  const halts = (data?.autoHalt.trips ?? []).filter(
    (t) => t.state === "halted",
  );
  const attention: AttentionItem[] = [
    ...openCandidates.map((c) => ({
      id: `cand:${c.id}`,
      tone: "danger" as const,
      object: (
        <EntityLink
          slug={slug}
          kind="rollout"
          release={c.releaseId ?? ""}
          outlet={c.outletId ?? ""}
          label={`${c.releaseId ?? "A release"} on ${c.outletId ?? "an outlet"}`}
        />
      ),
      reason: `Sentry alert${c.detail.rule ? ` “${String(c.detail.rule)}”` : ""} opened a halt candidate.`,
      action: {
        label: "Review",
        onSelect: () =>
          document
            .getElementById("health-sentry")
            ?.scrollIntoView({ block: "start" }),
      },
      at:
        typeof c.detail.lastAlertAt === "number"
          ? c.detail.lastAlertAt
          : c.updatedAt,
    })),
    ...(data && !data.counting
      ? [
          {
            id: "counting",
            tone: "warning" as const,
            object: "Update telemetry",
            reason:
              "This deployment has no update-health counters bound, so nothing is counted or judged.",
          },
        ]
      : []),
  ];

  return (
    <DashboardTemplate
      header={
        <>
          <PageHeader
            title="Health"
            description={`What devices report after an update reaches them, over the last ${windowHours} ${windowHours === 1 ? "hour" : "hours"}.`}
            freshness={
              data
                ? {
                    updatedAt: updatedAt(health),
                    onRefresh: () => void health.refetch(),
                    refreshing: health.isFetching,
                  }
                : undefined
            }
            refetching={health.isFetching && !health.isPending}
          />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span
              id="health-window"
              className="text-xs font-bold text-fg-muted"
            >
              Window
            </span>
            <SegmentedControl
              aria-labelledby="health-window"
              options={windows.map((w) => ({
                value: String(w),
                label: `${w} h`,
              }))}
              value={String(windowHours)}
              onChange={(v) => setWindow(Number(v))}
            />
          </div>
        </>
      }
      attention={
        attention.length ? <AttentionList items={attention} /> : undefined
      }
      tiles={
        health.isPending ? (
          <>
            <StatTile label="Rollouts watched" loading />
            <StatTile label="Halted by auto-halt" loading />
            <StatTile label="Open Sentry candidates" loading />
            <StatTile label="Auto-halt" loading />
          </>
        ) : data ? (
          <>
            <StatTile
              label="Rollouts watched"
              value={formatCount(data.rollouts.length)}
            />
            <StatTile
              label="Halted by auto-halt"
              value={formatCount(halts.length)}
            />
            <StatTile
              label="Open Sentry candidates"
              value={
                data.sentry.configured
                  ? formatCount(openCandidates.length)
                  : "—"
              }
            />
            <StatTile
              label="Auto-halt"
              value={data.autoHalt.settings.enabled ? "On" : "Off"}
            />
          </>
        ) : undefined
      }
      primary={
        <Panel
          title="Funnels"
          description="Distinct devices per rollout. Conversion is each step over the one before."
        >
          {health.isPending ? (
            <div
              className="space-y-3"
              aria-busy="true"
              aria-label="Loading funnels"
            >
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : health.isError && !data ? (
            <ErrorState
              compact
              error={health.error}
              onRetry={() => void health.refetch()}
              context={{ area: "distribution" }}
            />
          ) : data && data.rollouts.length === 0 ? (
            <EmptyState
              kind="first-run"
              title="No rollouts to watch"
              description="Health follows each staged rollout: how many devices were offered the update, installed it, and kept it. Start a rollout to see its funnel."
              primaryAction={
                <Button variant="outline" asChild>
                  <Link to={r.rollouts(slug)}>Go to Rollouts</Link>
                </Button>
              }
            />
          ) : data ? (
            <div className="space-y-6">
              {data.rollouts.map((h) => (
                <RolloutFunnel
                  key={rolloutKey(h)}
                  slug={slug}
                  h={h}
                  windowHours={data.windowHours}
                />
              ))}
              {data.unknown.length ? (
                <p className="text-xs text-fg-muted">
                  Also reported from outlets this product doesn't declare
                  (counted, never judged):{" "}
                  {data.unknown
                    .map(
                      (u) =>
                        `${u.releaseId}: ${formatCount(u.devices.update_applied)} applied, ${formatCount(u.devices.update_reverted)} reverted`,
                    )
                    .join("; ")}
                  .
                </p>
              ) : null}
            </div>
          ) : null}
        </Panel>
      }
      side={
        data ? (
          <div className="space-y-6">
            <AutoHaltPanel slug={slug} data={data} />
            <TripsPanel data={data} />
          </div>
        ) : health.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : undefined
      }
    >
      {data ? <SentryPanel slug={slug} data={data} /> : null}
    </DashboardTemplate>
  );
}

function rolloutKey(h: HealthRollout): string {
  return `${h.rollout.deliverableId}:${h.rollout.outletId}:${h.rollout.channel}`;
}

function RolloutFunnel({
  slug,
  h,
  windowHours,
}: {
  slug: string;
  h: HealthRollout;
  windowHours: number;
}): React.ReactElement {
  const d = h.devices;
  const ro = h.rollout;
  return (
    <section
      aria-label={`${ro.releaseId} on ${ro.outletId} / ${ro.channel}`}
      className="space-y-2 border-b border-border pb-5 last:border-b-0 last:pb-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <EntityLink slug={slug} kind="release" id={ro.releaseId} />
          <span className="text-fg-muted">
            on{" "}
            <EntityLink
              slug={slug}
              kind="rollout"
              release={ro.releaseId}
              outlet={ro.outletId}
              label={`${ro.outletId} / ${ro.channel}`}
            />
          </span>
        </span>
        <StatusPill domain="rollout" state={ro.state} size="sm">
          {rolloutSummary(ro)}
        </StatusPill>
      </div>
      {d ? (
        <Funnel
          label={`${ro.releaseId} on ${ro.outletId} / ${ro.channel}, last ${windowHours} h`}
          steps={[
            { label: "Offered", value: d.update_offered },
            { label: "Downloaded", value: d.update_downloaded },
            { label: "Applied", value: d.update_applied },
            { label: "Confirmed", value: d.update_confirmed },
          ]}
          failures={[
            { label: "Reverted", value: d.update_reverted },
            { label: "Pack failed", value: d.pack_failed },
            { label: "Boot rollback", value: d.boot_rolled_back },
          ]}
        />
      ) : (
        <p className="text-sm text-fg-muted">
          The counters for this rollout couldn't be read this time.
        </p>
      )}
      <p className="text-xs text-fg-muted">
        Revert rate {rate(h.verdict?.revertRate)} · boot rollback rate{" "}
        {rate(h.verdict?.bootRollbackRate)}
        {h.verdict?.trips.length
          ? ` · over the threshold: ${h.verdict.trips.join("; ")}`
          : ""}
      </p>
      {h.truncated ? (
        <p className="text-xs text-warning">
          The read hit its ceiling, so these sums are incomplete and were not
          judged.
        </p>
      ) : null}
    </section>
  );
}

type AutoHaltDraft = Pick<
  AutoHaltSettings,
  "enabled" | "windowHours" | "minSample"
> & { maxRevertRate: number | null; maxBootRollbackRate: number | null };

function AutoHaltPanel({
  slug,
  data,
}: {
  slug: string;
  data: UpdateHealthResponse;
}): React.ReactElement {
  const s = data.autoHalt.settings;
  const max = data.autoHalt.maxWindowHours;
  const form = useAdminForm<AutoHaltDraft>({
    values: {
      enabled: s.enabled,
      windowHours: s.windowHours,
      minSample: s.minSample,
      maxRevertRate: s.maxRevertRate,
      maxBootRollbackRate: s.maxBootRollbackRate,
    },
    validate: (v) => {
      const e: Record<string, string> = {};
      const w = numberRangeError(v.windowHours, {
        min: 1,
        max,
        required: true,
      });
      if (w) e.windowHours = w;
      const m = numberRangeError(v.minSample, { min: 1, required: true });
      if (m) e.minSample = m;
      for (const k of ["maxRevertRate", "maxBootRollbackRate"] as const) {
        const val = v[k];
        if (val === null) e[k] = "Enter a value.";
        else if (!(val > 0 && val < 1))
          e[k] = "Use more than 0 % and less than 100 %.";
      }
      return e;
    },
    onSubmit: async (v) => {
      await mutate("saveAutoHalt", slug, {
        enabled: v.enabled,
        windowHours: v.windowHours,
        minSample: v.minSample,
        maxRevertRate: v.maxRevertRate!,
        maxBootRollbackRate: v.maxBootRollbackRate!,
      });
      toast.success(v.enabled ? "Auto-halt saved" : "Auto-halt is off", {
        description: v.enabled
          ? "The next tick judges every active rollout against these numbers."
          : "Nothing is halted automatically.",
      });
    },
  });
  const reading = data.autoHalt.lastReading;
  const readAt =
    reading && typeof reading.detail.at === "number" ? reading.detail.at : null;
  const resetToDefaults = () => {
    const d = data.autoHalt.defaults;
    for (const [k, v] of Object.entries(d))
      form.rhf.setValue(k as keyof AutoHaltDraft, v as never, {
        shouldDirty: true,
      });
  };
  return (
    <Panel
      title="Auto-halt"
      description="Every 15 minutes, an active self-hosted rollout over a threshold, on at least the minimum devices, is halted once. A store's rollout only raises an alert."
    >
      <div className="space-y-4">
        <p className="text-xs text-fg-muted">
          {readAt !== null ? (
            <>
              Last reading <Timestamp at={fromSeconds(readAt)} />.
            </>
          ) : (
            "No reading yet."
          )}
          {s.updatedBy ? ` Saved by ${s.updatedBy}.` : ""}
        </p>
        <Form form={form} aria-label="Auto-halt settings" className="space-y-3">
          <FormField<boolean> name="enabled" label="Auto-halt" group>
            {(field) => (
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                aria-labelledby={field["aria-labelledby"]}
                label={field.value ? "On" : "Off"}
              />
            )}
          </FormField>
          <FormField<number | null> name="windowHours" label="Window" required>
            {(field) => (
              <NumberInput {...field} integer min={1} max={max} unit="hours" />
            )}
          </FormField>
          <FormField<number | null>
            name="minSample"
            label="Minimum devices applied"
            required
          >
            {(field) => (
              <NumberInput {...field} integer min={1} unit="devices" />
            )}
          </FormField>
          <FormField<number | null>
            name="maxRevertRate"
            label="Maximum revert rate"
            required
          >
            {(field) => (
              <NumberInput {...field} percent min={0} max={100} step="any" />
            )}
          </FormField>
          <FormField<number | null>
            name="maxBootRollbackRate"
            label="Maximum boot rollback rate"
            required
          >
            {(field) => (
              <NumberInput {...field} percent min={0} max={100} step="any" />
            )}
          </FormField>
          <Button size="sm" variant="ghost" onClick={resetToDefaults}>
            Reset to defaults
          </Button>
          <SaveBar form={form} section="Auto-halt" />
        </Form>
      </div>
    </Panel>
  );
}

function TripsPanel({
  data,
}: {
  data: UpdateHealthResponse;
}): React.ReactElement {
  const items = [
    ...data.autoHalt.trips.map((t) => ({ kind: "trip" as const, o: t })),
    ...data.autoHalt.alerts.map((a) => ({ kind: "alert" as const, o: a })),
  ].sort((a, b) => b.o.updatedAt - a.o.updatedAt);
  return (
    <Panel title="Trips and alerts">
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Nothing tripped: no rollout went over a threshold.
        </p>
      ) : (
        <Timeline
          label="Auto-halt trips and alerts"
          items={items}
          getKey={(i) => `${i.kind}:${i.o.id}`}
          getTime={(i) => fromSeconds(i.o.updatedAt)}
          groupBy="none"
          renderItem={(i) => (
            <span className="space-y-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <StatusPill
                  tone={i.kind === "trip" ? "danger" : "warning"}
                  size="sm"
                >
                  {i.kind === "trip" ? "Halted" : "Store alert"}
                </StatusPill>
                <span className="font-mono text-xs">
                  {i.o.releaseId ?? "—"}
                </span>
                <span className="text-xs text-fg-muted">
                  {i.o.outletId ?? ""}
                </span>
              </span>
              {typeof i.o.detail.reason === "string" && i.o.detail.reason ? (
                <span className="block text-xs text-fg-muted">
                  {i.o.detail.reason}
                </span>
              ) : null}
            </span>
          )}
        />
      )}
    </Panel>
  );
}

function SentryPanel({
  slug,
  data,
}: {
  slug: string;
  data: UpdateHealthResponse;
}): React.ReactElement {
  const [tab, setTab] = React.useState("open");
  const [pending, setPending] = React.useState<{
    c: UpdateHealthObject;
    decision: "confirm" | "dismiss";
  } | null>(null);
  const open = data.sentry.candidates.filter((c) => c.state === "open");
  const decided = data.sentry.candidates.filter((c) => c.state !== "open");
  const where = (c: UpdateHealthObject) =>
    `${c.releaseId ?? "the release"} on ${c.outletId ?? "the outlet"}${c.ref.channel ? ` / ${String(c.ref.channel)}` : ""}`;

  const row = (c: UpdateHealthObject, actions: boolean) => (
    <li
      key={c.id}
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
    >
      <span className="space-y-0.5">
        <span className="flex flex-wrap items-center gap-2">
          {c.releaseId && c.outletId ? (
            <EntityLink
              slug={slug}
              kind="rollout"
              release={c.releaseId}
              outlet={c.outletId}
              label={where(c)}
            />
          ) : (
            <span>{where(c)}</span>
          )}
          {!actions ? (
            <StatusPill
              tone={c.state === "confirmed" ? "danger" : "neutral"}
              size="sm"
            >
              {c.state === "confirmed"
                ? "Halted"
                : humanize(c.state ?? "closed")}
            </StatusPill>
          ) : null}
        </span>
        <span className="block text-xs text-fg-muted">
          {c.detail.rule ? `“${String(c.detail.rule)}”` : "Sentry alert"} ·{" "}
          {formatCount(Number(c.detail.alerts ?? 1))}{" "}
          {Number(c.detail.alerts ?? 1) === 1 ? "alert" : "alerts"} ·{" "}
          <Timestamp at={fromSeconds(c.updatedAt)} />
        </span>
      </span>
      {actions ? (
        <span className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPending({ c, decision: "dismiss" })}
          >
            Dismiss…
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setPending({ c, decision: "confirm" })}
          >
            Halt rollout…
          </Button>
        </span>
      ) : null}
    </li>
  );

  return (
    <div id="health-sentry" className="scroll-mt-20">
      <Panel
        title="Sentry halt candidates"
        description="A Sentry alert on a release opens a candidate. Nothing is halted until you confirm it."
      >
        {!data.sentry.configured ? (
          <Callout
            tone="info"
            title="Sentry isn't connected"
            action={
              <Button size="sm" variant="outline" asChild>
                <Link to={r.credentials(slug)}>Set a Sentry credential</Link>
              </Button>
            }
          >
            Store a Sentry internal integration's client secret as an outlet
            credential to receive alerts here.
          </Callout>
        ) : (
          <>
            <PageTabs
              label="Sentry candidates"
              idPrefix="sentry"
              value={tab}
              onChange={setTab}
              items={[
                { value: "open", label: "Open", count: open.length },
                { value: "decided", label: "Decided", count: decided.length },
              ]}
            />
            <TabPanel idPrefix="sentry" value="open" current={tab}>
              {open.length === 0 ? (
                <p className="pt-3 text-sm text-fg-muted">
                  No open candidates.
                </p>
              ) : (
                <ul className="space-y-2 pt-3">
                  {open.map((c) => row(c, true))}
                </ul>
              )}
            </TabPanel>
            <TabPanel idPrefix="sentry" value="decided" current={tab}>
              {decided.length === 0 ? (
                <p className="pt-3 text-sm text-fg-muted">
                  Nothing decided yet.
                </p>
              ) : (
                <ul className="space-y-2 pt-3">
                  {decided.map((c) => row(c, false))}
                </ul>
              )}
            </TabPanel>
          </>
        )}
      </Panel>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        intent={pending?.decision === "confirm" ? "danger" : "caution"}
        title={
          pending?.decision === "confirm"
            ? `Halt the rollout of ${pending ? where(pending.c) : ""}?`
            : "Dismiss this candidate?"
        }
        consequences={
          pending?.decision === "confirm"
            ? [
                "The rollout is halted as you: the feeds stop offering the release on this outlet.",
                "Only an explicit resume lifts it.",
              ]
            : [
                "The candidate closes without halting anything.",
                "A later alert on the same release does not reopen it.",
              ]
        }
        confirmLabel={
          pending?.decision === "confirm" ? "Halt rollout" : "Dismiss candidate"
        }
        describeError={describe}
        onConfirm={async () => {
          if (!pending) return;
          await mutate("decideCandidate", slug, pending.c.id, pending.decision);
          toast.success(
            pending.decision === "confirm"
              ? "Rollout halted"
              : "Candidate dismissed",
          );
        }}
      />
    </div>
  );
}
