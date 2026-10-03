import * as React from "react";
import { Activity, AlertTriangle, ShieldAlert } from "lucide-react";
import {
  api,
  type AutoHaltSettings,
  type UpdateEventCounts,
  type UpdateHealthObject,
  type UpdateHealthResponse,
} from "../../api.js";
import { invalidate, useResource } from "../../context.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Switch,
  useToast,
} from "../../components/ui/index.js";

/**
 * The Distribution section's UPDATE HEALTH tab (P6-03, README §6.2 item 6).
 *
 * It renders `GET …/distribution/update-health` as it is:
 *
 *   - the FUNNEL per rollout — offered → downloaded → applied → confirmed / reverted, plus pack
 *     failures and boot rollbacks — in distinct devices (what the auto-halt judges), with events
 *     as the tooltip, and the counts on outlets the product does not declare as `unknown`;
 *   - the AUTO-HALT: its settings (off by default; saving them is the ONE audited write), the
 *     last tick's reading, the rollouts it halted and the store rollouts it only alerted on;
 *   - the SENTRY hook: whether a `sentry-integration` credential is stored, and the halt
 *     candidates its alerts opened, each confirmed (halts the rollout, as you) or dismissed
 *     behind a confirmation. An alert never halts anything by itself.
 */

const FUNNEL: { key: keyof UpdateEventCounts; label: string }[] = [
  { key: "update_offered", label: "Offered" },
  { key: "update_downloaded", label: "Downloaded" },
  { key: "update_applied", label: "Applied" },
  { key: "update_confirmed", label: "Confirmed" },
  { key: "update_reverted", label: "Reverted" },
  { key: "pack_failed", label: "Pack failed" },
  { key: "boot_rolled_back", label: "Boot rollback" },
];

const pct = (r: number | null): string =>
  r === null ? "—" : `${(r * 100).toFixed(2)}%`;

export function UpdateHealthView({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const { data, loading, error, reload } = useResource<UpdateHealthResponse>(
    `distribution-update-health:${slug}`,
    () => api.updateHealth(slug),
  );

  return (
    <section aria-labelledby="update-health-title" className="space-y-6">
      <header className="space-y-1">
        <h2
          id="update-health-title"
          className="text-xl font-semibold tracking-tight"
        >
          Update health
        </h2>
        <p className="text-sm text-muted-foreground">
          What devices report after an update reaches them, the automatic halt
          that watches it, and Sentry alerts waiting for you.
        </p>
      </header>
      {loading && !data ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : error && !data ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load update health"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
          }
        />
      ) : !data ? (
        <EmptyState icon={<Activity aria-hidden />} title="No data" />
      ) : (
        <>
          <FunnelCard data={data} />
          <AutoHaltCard slug={slug} data={data} />
          <SentryCard slug={slug} data={data} />
        </>
      )}
    </section>
  );
}

function FunnelCard({ data }: { data: UpdateHealthResponse }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity aria-hidden className="size-4 text-accent-fg" />
          Funnel
        </CardTitle>
        <CardDescription>
          Distinct devices per rollout over the last {data.windowHours} hours.
          Hover a number for the event count.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data.counting ? (
          <p role="note" className="text-sm text-muted-foreground">
            This deployment has no update-health counters bound, so nothing is
            counted yet.
          </p>
        ) : null}
        {data.rollouts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rollouts recorded, so there is no funnel to show.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Rollout</th>
                  {FUNNEL.map((f) => (
                    <th key={f.key} className="py-2 pr-4 font-medium">
                      {f.label}
                    </th>
                  ))}
                  <th className="py-2 pr-4 font-medium">Revert rate</th>
                  <th className="py-2 font-medium">Boot rollback rate</th>
                </tr>
              </thead>
              <tbody>
                {data.rollouts.map((r) => (
                  <tr
                    key={`${r.rollout.deliverableId}:${r.rollout.outletId}:${r.rollout.channel}`}
                    className="border-t"
                  >
                    <td className="py-2 pr-4">
                      <span className="font-mono text-xs">
                        {r.rollout.releaseId}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {r.rollout.outletId}/{r.rollout.channel}
                      </span>{" "}
                      <Badge
                        variant={
                          r.rollout.state === "halted"
                            ? "destructive"
                            : "outline"
                        }
                      >
                        {r.rollout.state}
                      </Badge>
                    </td>
                    {FUNNEL.map((f) => (
                      <td
                        key={f.key}
                        className="py-2 pr-4 tabular-nums"
                        title={
                          r.events ? `${r.events[f.key]} events` : undefined
                        }
                      >
                        {r.devices ? r.devices[f.key] : "—"}
                      </td>
                    ))}
                    <td className="py-2 pr-4 tabular-nums">
                      {pct(r.verdict?.revertRate ?? null)}
                    </td>
                    <td className="py-2 tabular-nums">
                      {pct(r.verdict?.bootRollbackRate ?? null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.unknown.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Reported on outlets this product does not declare (counted as{" "}
            <code>unknown</code>, never judged):{" "}
            {data.unknown
              .map(
                (u) =>
                  `${u.releaseId}: ${u.devices.update_applied} applied, ${u.devices.update_reverted} reverted`,
              )
              .join("; ")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AutoHaltCard({
  slug,
  data,
}: {
  slug: string;
  data: UpdateHealthResponse;
}) {
  const toast = useToast();
  const s = data.autoHalt.settings;
  const [draft, setDraft] = React.useState<AutoHaltSettings>({
    enabled: s.enabled,
    windowHours: s.windowHours,
    minSample: s.minSample,
    maxRevertRate: s.maxRevertRate,
    maxBootRollbackRate: s.maxBootRollbackRate,
  });
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const num = (key: keyof AutoHaltSettings) => ({
    value: String(draft[key]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((d) => ({ ...d, [key]: Number(e.target.value) })),
  });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.saveAutoHalt(slug, draft);
      invalidate(`distribution-update-health:${slug}`);
      toast.success(
        "Auto-halt saved",
        draft.enabled
          ? "The next tick judges every active rollout against these numbers."
          : "Auto-halt is off: nothing is halted automatically.",
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Couldn’t save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert aria-hidden className="size-4 text-accent-fg" />
          Auto-halt
        </CardTitle>
        <CardDescription>
          Every 15 minutes, an active self-hosted rollout whose revert or boot
          rollback rate is over the threshold, on at least the minimum number of
          devices that applied it, is halted once. It never resumes anything,
          and a store’s rollout only raises an alert.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v: boolean) =>
                setDraft((d) => ({ ...d, enabled: v }))
              }
              aria-label="Auto-halt enabled"
            />
            {draft.enabled ? "On" : "Off"}
          </label>
          <Field label="Window (hours)">
            <Input
              type="number"
              min={1}
              max={data.autoHalt.maxWindowHours}
              {...num("windowHours")}
            />
          </Field>
          <Field label="Minimum devices applied">
            <Input type="number" min={1} {...num("minSample")} />
          </Field>
          <Field label="Max revert rate (0–1)">
            <Input type="number" step="0.001" {...num("maxRevertRate")} />
          </Field>
          <Field label="Max boot rollback rate (0–1)">
            <Input type="number" step="0.001" {...num("maxBootRollbackRate")} />
          </Field>
          {formError ? (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {formError}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={saving}>
              Save
            </Button>
          </div>
        </form>
        {s.updatedBy ? (
          <p className="text-xs text-muted-foreground">
            Last saved by {s.updatedBy}.
          </p>
        ) : null}
        <ObjectList
          title="Halted by auto-halt"
          empty="Nothing halted automatically."
          items={data.autoHalt.trips.filter((t) => t.state === "halted")}
        />
        <ObjectList
          title="Store rollouts over the threshold (alert only)"
          empty="No store alerts."
          items={data.autoHalt.alerts}
        />
      </CardContent>
    </Card>
  );
}

function ObjectList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: UpdateHealthObject[];
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((o) => (
            <li key={`${o.type}:${o.id}`}>
              <span className="font-mono text-xs">{o.releaseId}</span>{" "}
              <span className="text-muted-foreground">
                {o.outletId}: {String(o.detail.reason ?? "")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SentryCard({
  slug,
  data,
}: {
  slug: string;
  data: UpdateHealthResponse;
}) {
  const toast = useToast();
  const [pending, setPending] = React.useState<{
    candidate: UpdateHealthObject;
    decision: "confirm" | "dismiss";
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const open = data.sentry.candidates.filter((c) => c.state === "open");

  const decide = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await api.decideCandidate(slug, pending.candidate.id, pending.decision);
      invalidate(`distribution-update-health:${slug}`);
      toast.success(
        pending.decision === "confirm"
          ? "Rollout halted"
          : "Candidate dismissed",
      );
      setPending(null);
    } catch (err) {
      toast.error(
        "Couldn’t apply",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sentry halt candidates</CardTitle>
        <CardDescription>
          {data.sentry.configured
            ? "A Sentry alert on a release opens a candidate here. Nothing is halted until you confirm it."
            : "Store a Sentry internal integration under Platform → Secrets (kind sentry-integration) to receive alerts."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open candidates.</p>
        ) : (
          <ul className="space-y-2">
            {open.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <span>
                  <span className="font-mono text-xs">{c.releaseId}</span> on{" "}
                  {c.outletId}/{String(c.ref.channel ?? "")} —{" "}
                  {String(c.detail.rule ?? "alert")} (
                  {String(c.detail.alerts ?? 1)}×)
                </span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      setPending({ candidate: c, decision: "confirm" })
                    }
                  >
                    Halt
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setPending({ candidate: c, decision: "dismiss" })
                    }
                  >
                    Dismiss
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {pending ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => !busy && !next && setPending(null)}
          title={
            pending.decision === "confirm"
              ? "Halt this rollout?"
              : "Dismiss this candidate?"
          }
          description={
            pending.decision === "confirm"
              ? `Halts the ${pending.candidate.outletId} rollout of ${pending.candidate.releaseId}. Only an explicit resume lifts it.`
              : "Closes the candidate without halting anything. A later alert does not reopen it."
          }
          confirmLabel={pending.decision === "confirm" ? "Halt" : "Dismiss"}
          confirmVariant={
            pending.decision === "confirm" ? "destructive" : "primary"
          }
          loading={busy}
          onConfirm={decide}
        />
      ) : null}
    </Card>
  );
}
