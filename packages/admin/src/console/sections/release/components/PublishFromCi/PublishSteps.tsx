/**
 * Publish from CI (A-32.12): the two steps for the person, and Done.
 *   1. Run one command (it makes the release key), or merge the setup pull request Polaris Key
 *      opened. The pull request stands alone only when `.pkey/release` already declares
 *      `releaseKeys`; otherwise the command is the step.
 *   2. Push a tag; `WaitingFor` watches the releases.
 * Both read the world, never their own clicks: step 1 is met when readiness sees `.pkey/release`
 * and the workflow, step 2 when a release arrives that was not there when the drawer opened.
 */

import * as React from "react";
import { Check } from "lucide-react";
import {
  HttpError,
  type CiReadiness,
  type ReleaseDto,
  type SetupPullRequestResult,
} from "../../../../../api.js";
import { formatRelative } from "../../../../../lib/format.js";
import { Button } from "../../../../../ui/Button.js";
import { CodeBlock } from "../../../../../ui/CodeBlock.js";
import { RepoChangeStep, WaitingFor } from "../../../../../ui/wizard/index.js";
import { mutate } from "../../../../data/mutations.js";
import { Link } from "../../../../router.js";
import { r } from "../../../../routes.js";
import { useReleaseStore, useSetupPullRequest } from "../../data.js";
import { REVIEW_PERMISSIONS_URL, githubWords } from "./rows.js";

/** The product comes from `.pkey/product`: `pkey ci init` takes no `--product`. */
export const INIT_COMMAND = "pkey ci init --channel stable";
export const WORKFLOW_FILE = ".github/workflows/release.yml";
const POLL_MS = 5_000;

/** The tag to push: the next patch after `latest`, else the first. */
export function nextVersion(latest: string | null): string {
  const m = latest ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(latest) : null;
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "0.1.0";
}
export const tagCommand = (version: string): string =>
  `git tag v${version} && git push origin v${version}`;

/** The setup pull request, as its refusals tell it. */
interface Refusal {
  text: string;
  permission?: string;
  /** A retry will not help: the command takes over. */
  blocking: boolean;
}

function refusalOf(err: unknown): Refusal {
  if (err instanceof HttpError) {
    const body = (err.body ?? {}) as { permission?: unknown };
    if (err.status === 409 && err.reason === "app_permission") {
      const permission =
        typeof body.permission === "string" ? body.permission : undefined;
      return {
        text: `Needs ${permission ? githubWords(permission) : "write access"}. Run the command instead.`,
        permission,
        blocking: true,
      };
    }
    if (err.status === 409 && err.reason === "action_ref")
      return {
        text: "The publish Action is not pinned yet. Run the command.",
        blocking: true,
      };
    if (err.status === 409 && err.reason === "pull_request_base")
      return {
        text: "The open pull request has changed. Check it on GitHub.",
        blocking: false,
      };
    if (err.status === 502)
      return { text: "GitHub did not answer. Try again.", blocking: false };
    if (err.status === 400)
      return {
        text: "The manifest does not allow this change. Run the command.",
        blocking: true,
      };
    if (err.status === 403)
      return { text: "You need edit access to Ship builds.", blocking: false };
  }
  return {
    text: "Could not open the pull request. Try again.",
    blocking: false,
  };
}

const newestOf = (releases: readonly ReleaseDto[]): ReleaseDto | null =>
  [...releases].sort(
    (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
  )[0] ?? null;

export function PublishSteps({
  slug,
  readiness,
  open,
  canEdit,
  noEditReason,
  onUseOtherCi,
  onRefetchReadiness,
}: {
  slug: string;
  readiness: CiReadiness;
  open: boolean;
  canEdit: boolean;
  noEditReason?: string;
  onUseOtherCi: () => void;
  onRefetchReadiness: () => void;
}): React.ReactElement {
  const missing = readiness.checks.filter(
    (c) =>
      (c.id === "release-manifest" || c.id === "workflow") && c.state !== "ok",
  );
  const ready = missing.length === 0;
  const store = useReleaseStore(slug);
  const prState = useSetupPullRequest(slug);
  const [created, setCreated] = React.useState<SetupPullRequestResult | null>(
    null,
  );
  const [opening, setOpening] = React.useState(false);
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);

  // The releases the drawer found; a release beyond them is the one this flow waits for.
  const baseline = React.useRef<number | null>(null);
  const count = store.data?.releases.length;
  if (baseline.current === null && count !== undefined)
    baseline.current = count;
  const newest =
    store.data && baseline.current !== null && count! > baseline.current
      ? newestOf(store.data.releases)
      : null;
  const latest =
    store.data && !newest && store.data.releases.length > 0
      ? newestOf(store.data.releases)
      : null;

  // Wait out loud: step 1 re-reads readiness, step 2 the releases.
  const { refetch: refetchStore } = store;
  const { refetch: refetchPr } = prState;
  React.useEffect(() => {
    if (!open || newest) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      if (ready) void refetchStore();
      else {
        onRefetchReadiness();
        void refetchPr();
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [open, ready, newest, refetchStore, refetchPr, onRefetchReadiness]);

  const openPr = async (): Promise<void> => {
    setOpening(true);
    setRefusal(null);
    try {
      setCreated(await mutate("openSetupPullRequest", slug, {}));
    } catch (err) {
      setRefusal(refusalOf(err));
    } finally {
      setOpening(false);
    }
  };

  const open_ = created?.pullRequest ?? prState.data?.pullRequest ?? null;
  // The release key is the command's: a pull request stands alone only where it already exists.
  const keyed = readiness.releaseKeys;
  const pullRequest =
    open_ && keyed
      ? {
          number: open_.number,
          url: open_.url,
          compact: true,
          files: (created
            ? created.files.map((f) => f.path)
            : missing.map((c) =>
                c.id === "workflow" ? WORKFLOW_FILE : ".pkey/release",
              )
          ).map((path) => ({ path, change: "added" as const })),
        }
      : null;

  const canOpen = readiness.capabilities.pullRequest && keyed;
  const preview = readiness.workflowPreview;
  const links = readiness.links;
  const stepOne = pullRequest
    ? `Merge pull request #${pullRequest.number}`
    : "Run one command";

  return (
    <>
      <ol className="space-y-6" aria-label="Your steps">
        <li aria-current={ready ? undefined : "step"} className="space-y-3">
          <h3
            data-ci-step
            tabIndex={-1}
            className="text-sm font-semibold text-fg-strong"
          >
            1. {ready ? "Run one command" : stepOne}
          </h3>
          {ready ? (
            <p className="flex items-center gap-2 text-sm text-fg-strong">
              <Check aria-hidden className="size-4 text-success" />
              .pkey/release and the workflow are on main
            </p>
          ) : (
            <>
              <RepoChangeStep
                pullRequest={pullRequest}
                command={INIT_COMMAND}
                commandNote={
                  keyed ? undefined : "It also creates the release key."
                }
                files={
                  preview
                    ? [
                        {
                          id: "workflow",
                          label: "Workflow",
                          filename: WORKFLOW_FILE,
                          language: "yaml",
                          code: preview,
                          where: "Repository root",
                        },
                      ]
                    : []
                }
                permission={
                  readiness.capabilities.pullRequest || !keyed
                    ? undefined
                    : {
                        needs: refusal?.permission
                          ? githubWords(refusal.permission)
                          : "Contents and Pull requests: Read and write",
                        reviewUrl: links.installation ?? REVIEW_PERMISSIONS_URL,
                      }
                }
                onOpenPullRequest={canOpen ? () => void openPr() : undefined}
                opening={opening}
                openDisabledReason={
                  !canEdit
                    ? noEditReason
                    : refusal?.blocking
                      ? "Run the command instead."
                      : undefined
                }
                preferCommand={refusal?.blocking}
                notice={
                  refusal ? (
                    <p role="alert" className="text-sm text-warning">
                      {refusal.text}
                    </p>
                  ) : null
                }
                waiting="Waiting for the change to reach main"
                found={null}
                onCheck={() => {
                  onRefetchReadiness();
                  void refetchPr();
                }}
              />
              {open_ && !keyed ? (
                <p className="text-sm text-fg-muted">
                  <a
                    href={open_.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-fg underline underline-offset-2 hover:no-underline"
                  >
                    Pull request #{open_.number}
                  </a>{" "}
                  is open. The command writes the same files.
                </p>
              ) : null}
            </>
          )}
        </li>
        <li
          aria-current={ready && !newest ? "step" : undefined}
          className="space-y-3"
        >
          <h3
            data-ci-step
            tabIndex={-1}
            className="text-sm font-semibold text-fg-strong"
          >
            2. Push a tag
          </h3>
          {newest ? (
            <Done slug={slug} release={newest} />
          ) : ready ? (
            <>
              {latest ? (
                <p className="text-sm text-fg-muted">
                  Latest release:{" "}
                  <span className="font-mono">{latest.version}</span>
                </p>
              ) : null}
              {store.data ? (
                <CodeBlock
                  code={tagCommand(nextVersion(latest?.version ?? null))}
                  language="sh"
                  filename="Terminal"
                />
              ) : null}
              <WaitingFor
                waiting="Waiting for the release from CI"
                found={null}
                onCheck={() => void refetchStore()}
              />
            </>
          ) : (
            <p className="text-sm text-fg-muted">After step 1.</p>
          )}
        </li>
      </ol>
      {newest ? null : (
        <Button variant="ghost" size="sm" onClick={onUseOtherCi}>
          Use another CI
        </Button>
      )}
    </>
  );
}

function Done({
  slug,
  release,
}: {
  slug: string;
  release: ReleaseDto;
}): React.ReactElement {
  const kid = release.signer?.kid ?? null;
  return (
    <section
      aria-labelledby="ci-done"
      className="space-y-3 rounded-lg border border-success/40 bg-success/5 p-4"
    >
      <div role="status">
        <h4
          id="ci-done"
          className="flex items-center gap-2 text-base font-semibold text-fg-strong"
        >
          <Check aria-hidden className="size-5 text-success" />
          {release.version} is live
          {release.channel ? ` on ${release.channel}` : ""}
        </h4>
        <p className="mt-1 text-sm text-fg-muted">
          {kid ? (
            <>
              Signed by <span className="font-mono">{kid}</span>
              {release.publishedAt ? " · " : null}
            </>
          ) : null}
          {release.publishedAt
            ? `published ${formatRelative(release.publishedAt)}`
            : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <Link to={r.release(slug, release.releaseId, "distribution")}>
            Publish {release.version} everywhere
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={r.storefronts(slug)}>Set up storefronts</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to={r.release(slug, release.releaseId)}>View release</Link>
        </Button>
      </div>
    </section>
  );
}
