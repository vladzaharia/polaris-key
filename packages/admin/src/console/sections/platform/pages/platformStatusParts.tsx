/**
 * Platform → Status: the cards under the Checks table (admin.platform-status): health by area,
 * queues, scheduled jobs, storage and schema, deploys. Every row is a fact the snapshot already
 * carries (`GET /platform/deployment`, `GET /platform/operations`); a fact the Worker does not
 * serve is not drawn.
 */

import * as React from "react";
import { Clock, Rocket, TriangleAlert, type LucideIcon } from "lucide-react";
import type {
  PlatformDeploy,
  PlatformDeployment,
  PlatformOperations,
  ServiceSlug,
} from "../../../../api.js";
import {
  formatBytes,
  formatCount,
  fromSeconds,
} from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { ServiceGlyph, serviceLabel } from "../../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { Panel } from "../../../templates/Dashboard.js";
import {
  CRON_HELP,
  SCRIPT_LABEL,
  heartbeatState,
  jobLabel,
  queueHealth,
  type Health,
  type OperationsAssessment,
} from "./platformOperationsAssess.js";
import { buildLabel } from "./platformDeployParts.js";
import { Hash } from "../../../../ui/Hash.js";
import { useListCap } from "./useListCap.js";

const HEALTH_WORD: Record<Health, string> = {
  healthy: "OK",
  degraded: "Degraded",
  failed: "Failed",
};
const HEALTH_TONE = {
  healthy: "success",
  degraded: "warning",
  failed: "danger",
} as const;

/** A row of a card: a divided list, no padding of its own (the card pads the body). */
export function CardRows({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}): React.ReactElement {
  return (
    <ul aria-label={label} className="-my-2 divide-y divide-border">
      {children}
    </ul>
  );
}

function Skeleton(): React.ReactElement {
  return (
    <div aria-hidden className="pk-skeleton-group space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="pk-skeleton h-5 rounded-md" />
      ))}
    </div>
  );
}

/**
 * A card whose snapshot has not landed (a skeleton) or failed, else the body. A failed read is
 * said once, by the Checks row (with Try again); the card only says it did not read.
 */
function Loaded({
  data,
  error,
  children,
}: {
  data: unknown;
  error: unknown;
  onRetry?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  if (data) return <>{children}</>;
  if (error) return <p className="text-sm text-fg-muted">Not read</p>;
  return <Skeleton />;
}

function IconTile({ icon: Icon }: { icon: LucideIcon }): React.ReactElement {
  return (
    <span
      aria-hidden
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted"
    >
      <Icon className="size-4" />
    </span>
  );
}

function ListRow({
  icon,
  children,
  meta,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  meta?: React.ReactNode;
}): React.ReactElement {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <IconTile icon={icon} />
      <span className="min-w-0 flex-[1_1_10rem] break-words text-fg">
        {children}
      </span>
      {meta ? (
        <span className="text-xs text-fg-muted tabular-nums">{meta}</span>
      ) : null}
    </li>
  );
}

// ── Health by area ──────────────────────────────────────────────────────────────

interface Area {
  id: string;
  label: string;
  service: ServiceSlug | "core";
  health: Health;
}

export function areasOf(a: OperationsAssessment): Area[] {
  const worst = (x: Health, y: Health): Health =>
    x === "failed" || y === "failed"
      ? "failed"
      : x === "degraded" || y === "degraded"
        ? "degraded"
        : "healthy";
  const s = a.sections;
  return [
    {
      id: "probes",
      label: "Database and files",
      service: "core",
      health: s.probes,
    },
    { id: "cron", label: "Scheduled jobs", service: "core", health: s.cron },
    {
      id: "delivery",
      label: "Update delivery",
      service: "update",
      health: worst(s.consumers, s.queues),
    },
    {
      id: "connectors",
      label: "Store connections",
      service: "release",
      health: s.connectors,
    },
    {
      id: "storage",
      label: "Storage and indexes",
      service: "core",
      health: s.storage,
    },
  ];
}

export function HealthByArea({
  assessment,
  error,
  onRetry,
}: {
  assessment: OperationsAssessment | null;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <Panel title="Health by area">
      <Loaded data={assessment} error={error} onRetry={onRetry}>
        <CardRows label="Health by area">
          {(assessment ? areasOf(assessment) : []).map((area) => (
            <li key={area.id} className="flex items-center gap-3 py-2 text-sm">
              <ServiceGlyph id={area.service} />
              <span className="min-w-0 flex-1 break-words text-fg">
                {area.label}
              </span>
              <StatusPill tone={HEALTH_TONE[area.health]} size="sm">
                {HEALTH_WORD[area.health]}
              </StatusPill>
            </li>
          ))}
        </CardRows>
      </Loaded>
    </Panel>
  );
}

// ── Queues ──────────────────────────────────────────────────────────────────────

function QueueRow({
  title,
  q,
  dead,
  waiting,
}: {
  title: string;
  q: PlatformOperations["queues"]["deltas"];
  dead: boolean;
  waiting: string;
}): React.ReactElement {
  const h = queueHealth(q, dead);
  const n = q.backlogCount ?? 0;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <div className="min-w-0 flex-[1_1_10rem]">
        <div className="font-medium text-fg-strong">{title}</div>
        <div className="text-xs text-fg-muted">
          {!q.bound ? (
            "Not bound"
          ) : q.ok === false ? (
            (q.error ?? "Its backlog could not be read.")
          ) : dead && n === 0 ? (
            "Empty"
          ) : (
            <>
              {formatCount(n)} {waiting}
              {n > 0 && q.oldestMessageAt !== null ? (
                <>
                  {" "}
                  · oldest{" "}
                  <Timestamp
                    at={fromSeconds(q.oldestMessageAt)}
                    format="relative"
                  />
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
      {h === "degraded" ? (
        <StatusPill tone="warning" size="sm">
          {q.ok === false ? "Unreadable" : "Waiting"}
        </StatusPill>
      ) : null}
    </li>
  );
}

export function QueuesCard({
  op,
  error,
  onRetry,
}: {
  op: PlatformOperations | undefined;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const failed =
    op?.connectors?.items.reduce((sum, c) => sum + c.failedEvents24h, 0) ?? 0;
  return (
    <Panel title="Queues">
      <Loaded data={op} error={error} onRetry={onRetry}>
        {op ? (
          <CardRows label="Queues">
            <QueueRow
              title="Delta queue"
              q={op.queues.deltas}
              dead={false}
              waiting="waiting"
            />
            <QueueRow
              title="Dead-letter queue"
              q={op.queues.deadLetter}
              dead
              waiting="in dead letters"
            />
            {failed > 0 ? (
              <li className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-fg-strong">
                    Webhook deliveries
                  </div>
                  <div className="text-xs text-fg-muted">
                    {formatCount(failed)} failed in the last day
                  </div>
                </div>
                <StatusPill tone="warning" size="sm">
                  Failing
                </StatusPill>
              </li>
            ) : null}
          </CardRows>
        ) : null}
      </Loaded>
    </Panel>
  );
}

// ── Scheduled jobs ──────────────────────────────────────────────────────────────

export function JobsCard({
  op,
  error,
  onRetry,
}: {
  op: PlatformOperations | undefined;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const runs = op?.jobs
    ? [op.jobs.latest.maintenance, op.jobs.latest.connectorPoll].filter(
        (r) => r !== null,
      )
    : [];
  const backlog = op?.queues.deltas.bound
    ? op.queues.deltas.backlogCount
    : null;
  return (
    <Panel title="Scheduled jobs">
      <Loaded data={op} error={error} onRetry={onRetry}>
        {op ? (
          <CardRows label="Scheduled jobs">
            {op.jobs === null ? (
              <ListRow icon={TriangleAlert}>
                The run history could not be read.
              </ListRow>
            ) : null}
            {runs.map((run) => (
              <ListRow
                key={run.runId}
                icon={Clock}
                meta={
                  run.outcome === "ok" ? (
                    <Timestamp at={run.startedAt} format="relative" />
                  ) : (
                    <StatusPill tone="danger" size="sm">
                      Failed
                    </StatusPill>
                  )
                }
              >
                <strong className="font-medium text-fg-strong">
                  {(run.cron && CRON_HELP[run.cron]) ?? jobLabel(run.job)}
                </strong>
                : {jobLabel(run.job)}, {formatCount(run.steps.length)}{" "}
                {run.steps.length === 1 ? "step" : "steps"}
                {run.outcome === "failed"
                  ? run.steps
                      .filter((st) => st.outcome === "failed")
                      .map((st) => (
                        <span
                          key={st.step}
                          className="mt-1 block text-xs text-danger"
                        >
                          <span className="font-mono">{st.step}</span>:{" "}
                          {st.error ?? "No message recorded"}
                        </span>
                      ))
                  : null}
              </ListRow>
            ))}
            {(op.heartbeats ?? []).map((beat) => {
              const state = heartbeatState(
                beat,
                beat.script,
                op.generatedAt,
                beat.script === "deltas"
                  ? (backlog ?? beat.backlogCount)
                  : null,
              );
              return (
                <ListRow
                  key={beat.script}
                  icon={Clock}
                  meta={
                    <Timestamp at={fromSeconds(beat.at)} format="relative" />
                  }
                >
                  <strong className="font-medium text-fg-strong">
                    {SCRIPT_LABEL[beat.script] ?? beat.script}
                  </strong>
                  : {state.label.toLowerCase()}
                </ListRow>
              );
            })}
            {(op.jobs?.failures ?? [])
              .filter(
                (f) =>
                  !runs.some(
                    (run) =>
                      run.runId === f.runId &&
                      run.steps.some(
                        (st) => st.step === f.step && st.outcome === "failed",
                      ),
                  ),
              )
              .slice(0, 3)
              .map((f) => (
                <ListRow
                  key={`${f.runId}:${f.step}`}
                  icon={TriangleAlert}
                  meta={<Timestamp at={f.startedAt} format="relative" />}
                >
                  <span className="font-mono text-xs">{f.step}</span>:{" "}
                  {f.error ?? "No message recorded"}
                </ListRow>
              ))}
          </CardRows>
        ) : null}
      </Loaded>
    </Panel>
  );
}

// ── Storage and schema ──────────────────────────────────────────────────────────

function Fact({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
      <dt className="text-fg-muted">{term}</dt>
      <dd className="min-w-0 break-words text-end text-fg">{children}</dd>
    </div>
  );
}

export function StorageCard({
  op,
  deployment,
  error,
  onRetry,
}: {
  op: PlatformOperations | undefined;
  deployment: PlatformDeployment | undefined;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const mig = deployment?.migrations;
  const missing = deployment?.indexes.missing ?? op?.indexes.missing;
  const known = op !== undefined || deployment !== undefined;
  return (
    <Panel title="Storage and schema">
      <Loaded data={known || undefined} error={error} onRetry={onRetry}>
        <dl className="-my-2 divide-y divide-border">
          {op ? (
            <>
              <Fact term="D1">
                {op.storage.d1.sizeBytes !== null
                  ? formatBytes(op.storage.d1.sizeBytes)
                  : "Not reported"}
              </Fact>
              <Fact term="R2">
                {op.storage.r2
                  ? `${formatBytes(op.storage.r2.committedBytes)} · ${formatCount(op.storage.r2.objects)} objects`
                  : "Not reported"}
              </Fact>
            </>
          ) : null}
          {mig ? (
            <Fact term="Migrations">
              {mig.upToDate === true ? (
                <>
                  <span className="font-mono">{mig.latest}</span> applied · none
                  pending
                </>
              ) : mig.upToDate === false ? (
                <>
                  <span className="font-mono">{mig.latest}</span> not applied
                </>
              ) : (
                "Could not be read"
              )}
            </Fact>
          ) : null}
          {missing !== undefined ? (
            <Fact term="Indexes">
              {missing === null
                ? "Could not be checked"
                : missing.length === 0
                  ? "All required present"
                  : `${formatCount(missing.length)} missing: ${missing.join(", ")}`}
            </Fact>
          ) : null}
        </dl>
      </Loaded>
    </Panel>
  );
}

// ── Services ────────────────────────────────────────────────────────────────────

export function ServicesCard({
  op,
  error,
  onRetry,
}: {
  op: PlatformOperations | undefined;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const rows = op?.services;
  return (
    <Panel title="Services">
      <Loaded data={op ? true : undefined} error={error} onRetry={onRetry}>
        {rows == null ? (
          <p className="text-sm text-fg-muted">Could not be read.</p>
        ) : (
          <CardRows label="Services">
            {rows.map((s) => (
              <li
                key={s.slug}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
              >
                <ServiceGlyph id={s.slug as ServiceSlug} />
                <div className="min-w-0 flex-[1_1_10rem]">
                  <div className="font-medium text-fg-strong">
                    {serviceLabel(s.slug as ServiceSlug)}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {s.productsEnabled === 0
                      ? "No products"
                      : `${formatCount(s.productsEnabled)} ${s.productsEnabled === 1 ? "product" : "products"}`}
                    {s.lastError ? (
                      <>
                        {" "}
                        · {s.lastError.error ?? "failed"}{" "}
                        <Timestamp at={s.lastError.at} format="relative" />
                      </>
                    ) : null}
                  </div>
                </div>
                {s.lastError ? (
                  <StatusPill tone="danger" size="sm">
                    Failed
                  </StatusPill>
                ) : null}
              </li>
            ))}
          </CardRows>
        )}
      </Loaded>
    </Panel>
  );
}

// ── Deploys ─────────────────────────────────────────────────────────────────────

export function DeploysCard({
  deployment,
  deploys,
  error,
  onRetry,
}: {
  deployment: PlatformDeployment | undefined;
  deploys: {
    items: PlatformDeploy[];
    hasMore: boolean;
    loading: boolean;
    error: unknown;
    loadMore: () => void;
  };
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const capped = useListCap(deploys);
  return (
    <Panel title="Deploys">
      <Loaded data={deployment} error={error} onRetry={onRetry}>
        {deploys.items.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No deploys recorded. A hand deploy or wrangler dev records none.
          </p>
        ) : (
          <CardRows label="Deploys">
            {capped.items.map((d) => (
              <ListRow
                key={d.id}
                icon={Rocket}
                meta={<Timestamp at={fromSeconds(d.at)} />}
              >
                <strong className="font-medium text-fg-strong">
                  {d.tag ?? buildLabel({ releaseTag: null, gitSha: d.gitSha })}
                </strong>{" "}
                {d.gitSha && d.tag ? (
                  <Hash
                    value={d.gitSha}
                    label="commit"
                    chars={7}
                    className="whitespace-nowrap"
                  />
                ) : null}
                {d.smoke === "failure" ? (
                  <>
                    {" "}
                    <StatusPill tone="danger" size="sm">
                      Smoke check failed
                    </StatusPill>
                  </>
                ) : null}
                {d.runUrl ? (
                  <>
                    {" "}
                    <a
                      href={d.runUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="whitespace-nowrap text-accent-fg underline-offset-4 hover:underline"
                    >
                      View run
                      <span className="sr-only"> (opens GitHub Actions)</span>
                    </a>
                  </>
                ) : null}
              </ListRow>
            ))}
          </CardRows>
        )}
        {deploys.error ? (
          <ErrorState
            compact
            error={deploys.error}
            onRetry={deploys.loadMore}
          />
        ) : null}
        {capped.hasMore ? (
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              loading={deploys.loading}
              onClick={capped.loadMore}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Loaded>
    </Panel>
  );
}
