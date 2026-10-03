import * as React from "react";
import { artifactLabel } from "../../lib/buildLabels.js";
import { AlertTriangle, Grid3x3 } from "lucide-react";
import {
  api,
  releasePolicyMessage,
  type DistributionMatrix,
  type MatrixCellDto,
  type MatrixRolloutDto,
  type ReleaseDto,
  type ReleaseStoreResponse,
  type RolloutVerb,
} from "../../api.js";
import { invalidate, useResource } from "../../context.js";
import { docsUrl } from "../../lib/docsLinks.js";
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
  Skeleton,
  useToast,
} from "../../components/ui/index.js";
import {
  ArtifactList,
  Sha256,
  formatBytes,
  isSidecar,
} from "../releases/ReleaseBuilds.js";

/**
 * The distribution MATRIX (P2b-06, README §6.2 item 1): the app's newest releases × the product's
 * live outlets, each cell the release's availability, store submission and rollout on that
 * outlet — "the console shows the release × outlet matrix filling in" (README §6.1).
 *
 * It renders `GET …/distribution/matrix` as it is and never recomputes it: which verbs a rollout
 * allows comes from the worker (`controls`), and a MIRRORED rollout (a store connector owns it)
 * shows its source with every control disabled. Each control is P2b-04's admin rollout route,
 * behind a confirmation that states its effect; the effect note the worker sends is shown above
 * the grid, so a halt is never presented as more than it does. The row header reuses P2-07's
 * build components (payload SHA-256, size, files).
 */

const AVAILABILITY_VARIANT: Record<
  string,
  "success" | "warning" | "destructive" | "outline" | "primary"
> = {
  live: "success",
  approved: "primary",
  "in-review": "warning",
  processing: "warning",
  pending: "outline",
  rejected: "destructive",
  removed: "destructive",
};

const ROLLOUT_VARIANT: Record<
  string,
  "success" | "warning" | "destructive" | "outline"
> = {
  active: "success",
  paused: "warning",
  halted: "destructive",
  complete: "outline",
};

const VERB_LABEL: Record<RolloutVerb, string> = {
  pause: "Pause",
  resume: "Resume",
  halt: "Halt",
  complete: "Complete",
};

const VERB_DONE: Record<RolloutVerb, string> = {
  pause: "Paused",
  resume: "Resumed",
  halt: "Halted",
  complete: "Completed",
};

const VERBS: RolloutVerb[] = ["pause", "resume", "halt", "complete"];

interface PendingAction {
  verb: RolloutVerb;
  rollout: MatrixRolloutDto;
  version: string;
}

/** What each verb does, worded from P2b-04's transitions and the worker's effect note. */
function verbEffect(a: PendingAction): string {
  const where = `${a.rollout.outletId}/${a.rollout.channel}`;
  switch (a.verb) {
    case "pause":
      return `Pause the rollout of ${a.version} on ${where} at ${a.rollout.rolloutBp / 100}%. Devices outside it keep the previous release; the storefront feeds and the download page stop listing ${a.version} there.`;
    case "resume":
      return `Resume the rollout of ${a.version} on ${where} at ${a.rollout.rolloutBp / 100}%.`;
    case "halt":
      return `Halt the rollout of ${a.version} on ${where}. The signed feed tells devices on this outlet to stop offering it; resume to continue.`;
    case "complete":
      return `Offer ${a.version} to every device on ${where} (100%). A completed rollout cannot be paused again; start a new release instead.`;
  }
}

export function DistributionMatrixView({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const { data, loading, error, reload } = useResource<DistributionMatrix>(
    `distribution-matrix:${slug}`,
    () => api.distributionMatrix(slug),
  );
  const store = useResource<ReleaseStoreResponse>(`releases:${slug}`, () =>
    api.releases(slug),
  );
  const toast = useToast();
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const [busy, setBusy] = React.useState(false);

  const confirm = async (): Promise<void> => {
    if (!pending || !data) return;
    setBusy(true);
    try {
      await api.rolloutAction(
        slug,
        pending.rollout.outletId,
        pending.rollout.channel,
        pending.verb,
        {
          deliverable: data.deliverableId,
          releaseId: pending.rollout.releaseId,
        },
      );
      toast.success(
        `${VERB_DONE[pending.verb]} the ${pending.version} rollout on ${pending.rollout.outletId}`,
      );
      invalidate(`distribution-matrix:${slug}`);
      invalidate(`distribution-rollouts:${slug}`);
      setPending(null);
    } catch (err) {
      toast.error(
        `Couldn’t ${pending.verb} the rollout`,
        releasePolicyMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="matrix-title" className="space-y-6">
      <header className="space-y-1">
        <h2 id="matrix-title" className="text-xl font-semibold tracking-tight">
          Distribution matrix
        </h2>
        <p className="text-sm text-muted-foreground">
          Every recent release of{" "}
          <span className="font-medium text-foreground">{slug}</span> on every
          outlet: where it is live, where it is in review, and how far it has
          rolled out.{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href={docsUrl("rolloutControl")}
            target="_blank"
            rel="noreferrer"
          >
            Learn more
          </a>
        </p>
      </header>

      {loading && !data ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ) : error && !data ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load the matrix"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
          }
        />
      ) : !data || data.releases.length === 0 || data.outlets.length === 0 ? (
        <EmptyState
          icon={<Grid3x3 aria-hidden />}
          title={
            !data || data.releases.length === 0
              ? "No releases yet"
              : "No outlets declared"
          }
          description={
            !data || data.releases.length === 0
              ? "Releases appear here once CI publishes one."
              : "Declare outlets in .pkey/distribution to see where each release is."
          }
        />
      ) : (
        <>
          <div
            role="note"
            className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          >
            <AlertTriangle
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
            <p className="text-muted-foreground">{data.effect.note}</p>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Releases × outlets ({data.deliverableId})
              </CardTitle>
              <CardDescription>
                Availability is reported by CI or a store connector, or derived
                for a self-hosted outlet from the bytes Polaris Key serves. The
                public download page lists only what is live and not held back
                here.{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href={docsUrl("downloadPage")}
                  target="_blank"
                  rel="noreferrer"
                >
                  About the download page
                </a>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table
                  className="w-full text-left text-sm"
                  aria-label="Distribution matrix"
                >
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Release
                      </th>
                      {data.outlets.map((o) => (
                        <th
                          key={o.outletId}
                          scope="col"
                          className="py-2 pr-4 font-medium"
                        >
                          <span className="block text-foreground">
                            {o.outletId}
                          </span>
                          <span className="font-normal">{o.kind}</span>
                          {!o.supported && (
                            <span
                              className="block font-normal"
                              title={`${o.transport} is stored; Polaris Key does not deliver by it yet`}
                            >
                              {o.transport}: not supported yet
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.releases.map((r) => (
                      <tr
                        key={r.releaseId}
                        className="border-t align-top"
                        data-release={r.releaseId}
                      >
                        <th scope="row" className="py-3 pr-4 font-normal">
                          <ReleaseHeader
                            release={r}
                            detail={store.data?.releases.find(
                              (x) => x.releaseId === r.releaseId,
                            )}
                          />
                        </th>
                        {data.outlets.map((o) => {
                          const cell = data.cells.find(
                            (c) =>
                              c.releaseId === r.releaseId &&
                              c.outletId === o.outletId,
                          );
                          return (
                            <td
                              key={o.outletId}
                              className="py-3 pr-4"
                              data-outlet={o.outletId}
                            >
                              {cell ? (
                                <Cell
                                  cell={cell}
                                  onAction={(verb, rollout) =>
                                    setPending({
                                      verb,
                                      rollout,
                                      version: r.version,
                                    })
                                  }
                                />
                              ) : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {pending ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => !busy && !next && setPending(null)}
          title={`${VERB_LABEL[pending.verb]} rollout?`}
          description={verbEffect(pending)}
          confirmLabel={VERB_LABEL[pending.verb]}
          confirmVariant={
            pending.verb === "halt" || pending.verb === "pause"
              ? "destructive"
              : "primary"
          }
          loading={busy}
          onConfirm={confirm}
        >
          {pending.verb === "halt" || pending.verb === "pause" ? (
            <p className="text-sm text-muted-foreground">{data?.effect.note}</p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function ReleaseHeader({
  release,
  detail,
}: {
  release: DistributionMatrix["releases"][number];
  detail: ReleaseDto | undefined;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const payloads = (detail?.artifacts ?? []).filter(
    (a) => a.role === "payload",
  );
  const files = (detail?.artifacts ?? []).filter((a) => !isSidecar(a));
  return (
    <div className="min-w-[12rem] space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-foreground">
          {release.version}
        </span>
        {release.channel ? (
          <Badge variant="outline">{release.channel}</Badge>
        ) : null}
        {release.yanked ? <Badge variant="destructive">yanked</Badge> : null}
      </div>
      {payloads.length ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {payloads.slice(0, 3).map((a) => {
            const label = artifactLabel(a);
            return (
              <li key={a.artifactId} className="flex flex-wrap gap-2">
                <span title={label?.long}>{a.buildId ?? a.name}</span>
                {label ? <span>{label.short}</span> : null}
                <span>{formatBytes(a.sizeBytes)}</span>
                {a.sha256 ? <Sha256 value={a.sha256} /> : null}
              </li>
            );
          })}
          {payloads.length > 3 ? <li>and {payloads.length - 3} more</li> : null}
        </ul>
      ) : null}
      {files.length ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide files" : `Files (${files.length})`}
          </Button>
          {open ? <ArtifactList artifacts={files} /> : null}
        </>
      ) : null}
    </div>
  );
}

function Cell({
  cell,
  onAction,
}: {
  cell: MatrixCellDto;
  onAction: (verb: RolloutVerb, rollout: MatrixRolloutDto) => void;
}): React.ReactElement {
  const derived =
    cell.records.length > 0 && cell.records.every((r) => r.derived);
  return (
    <div className="min-w-[9rem] space-y-1.5">
      {cell.availability ? (
        <Badge
          variant={AVAILABILITY_VARIANT[cell.availability] ?? "outline"}
          title={cell.records
            .map(
              (r) =>
                `${r.buildId || "release"}: ${r.state} (${r.derived ? "derived" : r.source})`,
            )
            .join("\n")}
        >
          {cell.availability}
          {derived ? " (derived)" : ""}
        </Badge>
      ) : (
        <span className="text-xs text-muted-foreground">not available</span>
      )}
      {cell.submission ? (
        <p className="text-xs text-muted-foreground">
          Review:{" "}
          <span className="text-foreground">{cell.submission.state}</span>
        </p>
      ) : null}
      {cell.rollouts.map((r) => (
        <div
          key={r.channel}
          className="space-y-1 rounded-md border p-1.5"
          data-rollout={`${r.outletId}:${r.channel}`}
        >
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <span>{r.channel}</span>
            <Badge variant={ROLLOUT_VARIANT[r.state] ?? "outline"}>
              {r.state}
            </Badge>
            <span>{r.rolloutBp / 100}%</span>
          </div>
          {r.mirrored ? (
            <p className="text-xs text-muted-foreground">
              Mirrored from {r.source}: change it in the store.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1">
            {VERBS.map((verb) => (
              <Button
                key={verb}
                variant="outline"
                size="sm"
                disabled={r.mirrored || !r.controls.includes(verb)}
                onClick={() => onAction(verb, r)}
                aria-label={`${VERB_LABEL[verb]} ${r.outletId}/${r.channel}`}
              >
                {VERB_LABEL[verb]}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
