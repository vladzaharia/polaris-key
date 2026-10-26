/**
 * Publish from CI (A-32.12): the two steps for the person, and Done.
 *   1. Run one command, or merge the setup pull request Polaris Key opened (`RepoChangeStep`).
 *   2. Push your first tag; `WaitingFor` watches the releases.
 * Both read the world, never their own clicks: step 1 is met when readiness sees `.pkey/release`
 * and the workflow, step 2 when a release arrives that was not there when the drawer opened.
 */

import * as React from "react";
import { Check } from "lucide-react";
import {
  HttpError,
  type CiReadiness,
  type SetupPullRequestResult,
} from "../../../../../api.js";
import { formatDetailTime } from "../../../../../lib/format.js";
import { Button } from "../../../../../ui/Button.js";
import { CodeBlock } from "../../../../../ui/CodeBlock.js";
import { RepoChangeStep, WaitingFor } from "../../../../../ui/wizard/index.js";
import { mutate } from "../../../../data/mutations.js";
import { Link } from "../../../../router.js";
import { r } from "../../../../routes.js";
import { useReleaseStore, useSetupPullRequest } from "../../data.js";
import { REVIEW_PERMISSIONS_URL } from "./rows.js";

export const INIT_COMMAND = "pkey ci init --channel stable";
export const TAG_COMMAND = "git tag v0.1.0 && git push origin v0.1.0";
export const WORKFLOW_FILE = ".github/workflows/release.yml";
const POLL_MS = 5_000;

const FILES: Record<string, string> = {
  "release-manifest": ".pkey/release",
  workflow: WORKFLOW_FILE,
};

/** The setup pull request, as its refusals tell it. */
interface Refusal {
  text: string;
  permission?: string;
}

function refusalOf(err: unknown): Refusal {
  if (err instanceof HttpError) {
    const body = (err.body ?? {}) as { permission?: unknown };
    if (err.status === 409 && err.reason === "app_permission") {
      const permission =
        typeof body.permission === "string" ? body.permission : undefined;
      return {
        text: `Needs ${permission ?? "write access"}. Run the command instead.`,
        permission,
      };
    }
    if (err.status === 409 && err.reason === "action_ref")
      return { text: "The publish Action is not pinned yet. Run the command." };
    if (err.status === 409 && err.reason === "pull_request_base")
      return { text: "The open pull request has changed. Check it on GitHub." };
    if (err.status === 502)
      return { text: "GitHub did not answer. Try again." };
    if (err.status === 400)
      return {
        text: "The manifest does not allow this change. Run the command.",
      };
  }
  return { text: "Could not open the pull request. Try again." };
}

export function PublishSteps({
  slug,
  readiness,
  open,
  onUseOtherCi,
  onRefetchReadiness,
}: {
  slug: string;
  readiness: CiReadiness;
  open: boolean;
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
      ? ([...store.data.releases].sort(
          (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
        )[0] ?? null)
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

  const filePaths = missing.map((c) => FILES[c.id]!);
  const open_ = created?.pullRequest ?? prState.data?.pullRequest ?? null;
  const pullRequest = open_
    ? {
        number: open_.number,
        url: open_.url,
        summary: `Merging it adds ${
          (created ? created.files.map((f) => f.path) : filePaths).join(
            " and ",
          ) || "the setup files"
        }.`,
        files: created
          ? created.files.map((f) => ({
              path: f.path,
              change: "added" as const,
            }))
          : filePaths.map((path) => ({ path, change: "added" as const })),
      }
    : null;

  const canOpen = readiness.capabilities.pullRequest;
  const preview = readiness.workflowPreview;

  return (
    <ol className="space-y-6" aria-label="Your steps">
      <li aria-current={ready ? undefined : "step"} className="space-y-3">
        <h3 className="text-sm font-semibold text-fg-strong">
          1.{" "}
          {pullRequest && !ready ? "Merge the pull request" : "Run one command"}
        </h3>
        {ready ? (
          <p className="flex items-center gap-2 text-sm text-fg-strong">
            <Check aria-hidden className="size-4 text-success" />
            {FILES["release-manifest"]} and the workflow are on main
          </p>
        ) : (
          <RepoChangeStep
            pullRequest={pullRequest}
            command={INIT_COMMAND}
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
              canOpen
                ? undefined
                : {
                    needs:
                      refusal?.permission ??
                      "contents and pull requests: write",
                    reviewUrl: REVIEW_PERMISSIONS_URL,
                  }
            }
            onOpenPullRequest={canOpen ? () => void openPr() : undefined}
            opening={opening}
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
        )}
      </li>
      <li
        aria-current={ready && !newest ? "step" : undefined}
        className="space-y-3"
      >
        <h3 className="text-sm font-semibold text-fg-strong">
          2. Push your first tag
        </h3>
        {newest ? (
          <Done
            slug={slug}
            version={newest.version}
            signer={newest.signer?.kid ?? null}
            at={newest.publishedAt}
          />
        ) : ready ? (
          <>
            <CodeBlock code={TAG_COMMAND} language="sh" filename="Terminal" />
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
      <li>
        <Button variant="ghost" size="sm" onClick={onUseOtherCi}>
          Use another CI
        </Button>
      </li>
    </ol>
  );
}

function Done({
  slug,
  version,
  signer,
  at,
}: {
  slug: string;
  version: string;
  signer: string | null;
  at: number | null;
}): React.ReactElement {
  return (
    <section
      aria-labelledby="ci-done"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <h4
        id="ci-done"
        role="status"
        className="flex items-center gap-2 text-sm font-semibold text-fg-strong"
      >
        <Check aria-hidden className="size-4 text-success" />
        Done. {version} is published.
      </h4>
      <p className="text-sm text-fg-muted">
        {signer ? (
          <>
            Signed by <span className="font-mono">{signer}</span>
            {at ? " · " : null}
          </>
        ) : null}
        {at ? formatDetailTime(at) : null}
      </p>
      <Button asChild size="sm" variant="outline">
        <Link to={r.releases(slug)}>View release</Link>
      </Button>
    </section>
  );
}
