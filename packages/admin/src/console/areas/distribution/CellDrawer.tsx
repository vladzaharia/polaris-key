/**
 * The Matrix cell drawer (ADMIN.md §6.4): everything about one release on one outlet, and every
 * action the cell has (MTX-1). Routed through `?cell=<release>:<outlet>`, so it is linkable and
 * Back closes it.
 *
 * - **Availability:** per-build records with their source and `since` (MTX-3).
 * - **Submission:** the store review timeline.
 * - **Readiness:** blockers as links to their pack releases, **Override…** (L2, reason required)
 *   and **Clear override** (L1) (MTX-2).
 * - **Rollouts:** per channel, a `Meter` and only the verbs the server allows; **Set
 *   percentage…** (MTX-5). A mirrored rollout is read-only and names its store.
 * - **Store controls:** the configured connector's rollout verbs for a store-owned rollout.
 */

import * as React from "react";
import type {
  ConnectorStatusDto,
  DistributionMatrix,
  MatrixCellDto,
  MatrixRolloutDto,
  RolloutVerb,
} from "../../../api.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import { humanize } from "../../../lib/status.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Meter } from "../../../ui/charts/Meter.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Drawer, DrawerBody } from "../../../ui/Drawer.js";
import { FormField } from "../../../ui/form.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Textarea } from "../../../ui/Textarea.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { EntityLink } from "../../components/EntityLink.js";
import { mutate } from "../../data/mutations.js";
import { useConnectors } from "./data.js";
import {
  outletKindLabel,
  READINESS_LABEL,
  rolloutSummary,
  sourceLabel,
  VERB_LABEL,
} from "./format.js";
import {
  allowedVerbs,
  canSetPercentage,
  RolloutVerbDialog,
  SetPercentageDialog,
  StartRolloutDialog,
} from "./RolloutDialogs.js";
import { StoreRolloutControls } from "./StoreControls.js";

const describe = (e: unknown) =>
  errorCopy(e, { area: "distribution", thing: "Readiness" });

function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): React.ReactElement {
  const id = React.useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-3 border-b border-border pb-5 last:border-b-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-sm font-semibold text-fg-strong">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function CellDrawer({
  slug,
  matrix,
  cell,
  target,
  onClose,
}: {
  slug: string;
  matrix: DistributionMatrix;
  cell: MatrixCellDto | undefined;
  target: { releaseId: string; outletId: string } | null;
  onClose: () => void;
}): React.ReactElement {
  const release = target
    ? matrix.releases.find((r) => r.releaseId === target.releaseId)
    : undefined;
  const outlet = target
    ? matrix.outlets.find((o) => o.outletId === target.outletId)
    : undefined;
  const open = target !== null;
  const title =
    release && outlet
      ? `${release.version} on ${outlet.outletId}`
      : "Cell not found";
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={title}
      description={
        outlet
          ? `${outletKindLabel(outlet.kind)} · ${release?.channel ?? "no channel"}`
          : undefined
      }
    >
      <DrawerBody className="space-y-5">
        {target && (!release || !outlet) ? (
          <Callout tone="warning" title="This cell isn't in the matrix">
            The release or the outlet is not among the rows shown. It may be
            older than the newest {matrix.limit} releases, or the outlet was
            removed.
          </Callout>
        ) : target && release && outlet ? (
          <CellBody
            slug={slug}
            matrix={matrix}
            cell={cell}
            version={release.version}
            outletKind={outlet.kind}
            target={target}
          />
        ) : null}
      </DrawerBody>
    </Drawer>
  );
}

function CellBody({
  slug,
  matrix,
  cell,
  version,
  outletKind,
  target,
}: {
  slug: string;
  matrix: DistributionMatrix;
  cell: MatrixCellDto | undefined;
  version: string;
  outletKind: string;
  target: { releaseId: string; outletId: string };
}): React.ReactElement {
  const [verb, setVerb] = React.useState<{
    rollout: MatrixRolloutDto;
    verb: RolloutVerb;
  } | null>(null);
  const [setting, setSetting] = React.useState<MatrixRolloutDto | null>(null);
  const [starting, setStarting] = React.useState(false);
  const connectors = useConnectors(slug);
  const connector: ConnectorStatusDto | undefined =
    connectors.data?.connectors.find((c) => c.outletKinds.includes(outletKind));

  return (
    <>
      <Section title="Availability">
        {cell && cell.records.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {cell.availability ? (
                <StatusPill domain="availability" state={cell.availability} />
              ) : null}
            </div>
            <ul
              className="divide-y divide-border rounded-md border border-border"
              aria-label="Per build"
            >
              {cell.records.map((r) => (
                <li
                  key={`${r.buildId}:${r.transport}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-xs text-fg-strong">
                      {r.buildId || "Whole release"}
                    </span>
                    <span className="text-xs text-fg-muted">
                      {r.derived
                        ? "Derived: Polaris Key serves these bytes"
                        : `Reported by ${sourceLabel(r.source)}`}
                      {r.since !== null ? (
                        <>
                          {" · since "}
                          <Timestamp
                            at={fromSeconds(r.since)}
                            format="detail"
                          />
                        </>
                      ) : null}
                    </span>
                  </span>
                  <StatusPill domain="availability" state={r.state} size="sm" />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            Not available here: no report from CI or a store connector, and
            Polaris Key does not serve this release on this outlet.
          </p>
        )}
      </Section>

      <Section title="Submission">
        {cell?.submission ? (
          <DescriptionList
            columns={2}
            items={[
              {
                term: "State",
                detail: (
                  <StatusPill tone="neutral">
                    {humanize(cell.submission.state)}
                  </StatusPill>
                ),
              },
              { term: "Source", detail: sourceLabel(cell.submission.source) },
              {
                term: "Submitted",
                detail:
                  cell.submission.submittedAt !== null ? (
                    <Timestamp
                      at={fromSeconds(cell.submission.submittedAt)}
                      format="detail"
                    />
                  ) : (
                    "—"
                  ),
              },
              {
                term: "Reviewed",
                detail:
                  cell.submission.reviewedAt !== null ? (
                    <Timestamp
                      at={fromSeconds(cell.submission.reviewedAt)}
                      format="detail"
                    />
                  ) : (
                    "Not yet"
                  ),
              },
            ]}
          />
        ) : (
          <p className="text-sm text-fg-muted">No store submission recorded.</p>
        )}
      </Section>

      {cell?.readiness ? (
        <ReadinessSection
          slug={slug}
          readiness={cell.readiness}
          releaseId={target.releaseId}
          outletId={target.outletId}
          version={version}
        />
      ) : null}

      <Section
        title="Rollouts"
        actions={
          <Button size="sm" variant="outline" onClick={() => setStarting(true)}>
            Start rollout…
          </Button>
        }
      >
        {cell && cell.rollouts.length > 0 ? (
          <ul className="space-y-3">
            {cell.rollouts.map((r) => {
              const verbs = allowedVerbs(r);
              return (
                <li
                  key={r.channel}
                  data-rollout={`${r.outletId}:${r.channel}`}
                  // A card of its own (rounded-lg): its rows end at its padding, not the section's.
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-fg-strong">
                      {r.channel}
                    </span>
                    <StatusPill domain="rollout" state={r.state} size="sm" />
                  </div>
                  <Meter
                    label={`Rollout of ${version} on ${r.channel}`}
                    value={r.state === "complete" ? 10_000 : r.rolloutBp}
                    max={10_000}
                    format="bp"
                    tone={
                      r.state === "halted"
                        ? "danger"
                        : r.state === "paused"
                          ? "warning"
                          : "accent"
                    }
                  />
                  <p className="text-xs text-fg-muted">
                    {rolloutSummary(r)} · {sourceLabel(r.source)} ·{" "}
                    <Timestamp at={fromSeconds(r.updatedAt)} />
                  </p>
                  {r.mirrored ? (
                    <>
                      <p className="text-sm text-fg-muted">
                        {sourceLabel(r.source)} owns this rollout; it is
                        read-only here.
                      </p>
                      {connector ? (
                        <StoreRolloutControls
                          slug={slug}
                          connector={connector}
                          rollout={r}
                          version={version}
                        />
                      ) : null}
                    </>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {verbs.map((v) => (
                        <Button
                          key={v}
                          size="sm"
                          variant={
                            confirmFor(`rollout.${v}`).level >= 2
                              ? "danger"
                              : "outline"
                          }
                          aria-label={`${VERB_LABEL[v]} ${r.outletId} / ${r.channel}`}
                          onClick={() => setVerb({ rollout: r, verb: v })}
                        >
                          {VERB_LABEL[v]}…
                        </Button>
                      ))}
                      {canSetPercentage(r) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSetting(r)}
                        >
                          Set percentage…
                        </Button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            No rollout: each channel offers its release to every device on this
            outlet.
          </p>
        )}
      </Section>

      <RolloutVerbDialog
        slug={slug}
        target={verb ? { ...verb, version } : null}
        onClose={() => setVerb(null)}
      />
      {setting ? (
        <SetPercentageDialog
          slug={slug}
          rollout={setting}
          version={version}
          onClose={() => setSetting(null)}
        />
      ) : null}
      <StartRolloutDialog
        slug={slug}
        open={starting}
        initial={{
          deliverable: matrix.deliverableId,
          outlet: target.outletId,
          releaseId: target.releaseId,
          channel:
            matrix.releases.find((r) => r.releaseId === target.releaseId)
              ?.channel ?? undefined,
        }}
        onClose={() => setStarting(false)}
      />
    </>
  );
}

function ReadinessSection({
  slug,
  readiness,
  releaseId,
  outletId,
  version,
}: {
  slug: string;
  readiness: NonNullable<MatrixCellDto["readiness"]>;
  releaseId: string;
  outletId: string;
  version: string;
}): React.ReactElement {
  const [overriding, setOverriding] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const overridden = readiness.state === "overridden";
  const canOverride =
    !overridden && readiness.holdable && readiness.state !== "ready";
  return (
    <Section
      title="Readiness"
      actions={
        overridden ? (
          <Button size="sm" variant="outline" onClick={() => setClearing(true)}>
            Clear override…
          </Button>
        ) : canOverride ? (
          // An escape hatch, not the drawer's headline action: outlined, danger text; the
          // reason-required confirm is the safety.
          <Button
            size="sm"
            variant="outline"
            className="text-danger"
            onClick={() => setOverriding(true)}
          >
            Override…
          </Button>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          tone={
            readiness.state === "ready" || overridden
              ? "success"
              : readiness.state === "pending"
                ? "neutral"
                : "warning"
          }
        >
          {readiness.holds
            ? "Held"
            : (READINESS_LABEL[readiness.state] ?? humanize(readiness.state))}
        </StatusPill>
        {readiness.holds ? (
          <span className="text-sm text-fg-muted">
            Polaris Key holds {version} here until its packs are ready.
          </span>
        ) : null}
      </div>
      {readiness.warning ? (
        <Callout tone="warning" title="This store can't be held">
          {readiness.warning}
        </Callout>
      ) : null}
      {readiness.pendingReason ? (
        <p className="text-sm text-fg-muted">{readiness.pendingReason}</p>
      ) : null}
      {readiness.override ? (
        <p className="text-sm text-fg-muted">
          Overridden by {readiness.override.by}
          {readiness.override.reason
            ? `: “${readiness.override.reason}”`
            : ""}{" "}
          (<Timestamp at={fromSeconds(readiness.override.at)} />
          ).
        </p>
      ) : null}
      {readiness.blockers.length > 0 ? (
        <ul className="space-y-2" aria-label="Blockers">
          {readiness.blockers.map((b, i) => (
            <li
              key={`${b.pack}:${i}`}
              className="rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="flex flex-wrap items-center gap-2">
                {b.packReleaseId ? (
                  <EntityLink
                    slug={slug}
                    kind="pack-release"
                    deliverable={b.pack}
                    id={b.packReleaseId}
                    label={`${b.pack} ${b.version ?? ""}`.trim()}
                  />
                ) : (
                  <EntityLink
                    slug={slug}
                    kind="deliverable"
                    id={b.pack}
                    label={b.pack}
                  />
                )}
                <StatusPill tone="warning" size="sm">
                  {humanize(b.reason)}
                </StatusPill>
              </span>
              <span className="mt-1 block text-xs text-fg-muted">
                {b.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={overriding}
        onOpenChange={(o) => {
          setOverriding(o);
          if (!o) setReason("");
        }}
        intent="danger"
        title={`Override the hold of ${version} on ${outletId}?`}
        consequences={[
          `${version} is offered on ${outletId} although its packs are not ready there.`,
          "Devices that install it may miss content until the packs arrive.",
          "The override and its reason are audited; a later refresh keeps it.",
        ]}
        confirmLabel={`Override ${version}`}
        confirmDisabled={reason.trim() === ""}
        describeError={describe}
        onConfirm={async () => {
          await mutate(
            "overrideReadiness",
            slug,
            releaseId,
            outletId,
            reason.trim(),
          );
          toast.success(`Overrode the hold of ${version} on ${outletId}`);
          setReason("");
        }}
      >
        <FormField<string>
          name="override-reason"
          label="Reason"
          required
          help="Why it is safe to offer this release now. Up to 500 characters."
          value={reason}
          onChange={setReason}
        >
          {(field) => (
            <Textarea
              id={field.id}
              value={reason}
              maxLength={500}
              rows={3}
              onValueChange={setReason}
              aria-describedby={field["aria-describedby"]}
              aria-required
            />
          )}
        </FormField>
      </ConfirmDialog>

      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        intent="caution"
        title={`Clear the override of ${version} on ${outletId}?`}
        consequences={[
          "The hold is computed again from the packs.",
          `If its packs are still not ready, ${version} stops being offered on ${outletId}.`,
        ]}
        confirmLabel="Clear override"
        describeError={describe}
        onConfirm={async () => {
          await mutate("clearReadinessOverride", slug, releaseId, outletId);
          toast.success(`Cleared the override of ${version} on ${outletId}`);
        }}
      />
    </Section>
  );
}
