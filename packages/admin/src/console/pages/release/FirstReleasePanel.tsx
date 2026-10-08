/**
 * Release → Releases, before the first release (EXPERIENCE.md §0.4 S2, AS 2.2): a guided panel
 * instead of a dead-end empty table.
 *
 *   Left:  Ship your first release · what happens · [Copy workflow step] [Release docs]
 *   Right: the checks that let CI publish, each with its fix inline, then a live
 *          "Waiting for the first release…" row, then the workflow step with the slug filled in.
 *
 * - A linked product shows whether the Polaris Key GitHub App can read its repository (the repo
 *   sync health's `github` check) and the trusted publisher.
 * - A manual product offers Link a repository (the same drawer as Settings → Repository) or a
 *   trusted publisher and a CI token, either of which lets CI publish.
 * - CI publishing lives in Keys & secrets, but it is edited from here through the same drawer
 *   and dialog (`PublisherDrawer`, `IssueCiTokenFlow`).
 * - The store is polled while the panel is up; ReleasesPage announces the release that ends it.
 */

import * as React from "react";
import { BookOpen, Check, Copy, Pencil, Plus } from "lucide-react";
import type { ReleaseHealth } from "../../../api.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { toSeconds } from "../../../lib/format.js";
import { markPartPath } from "../../../ui/markPath.js";
import { Button } from "../../../ui/Button.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { useCopy } from "../../../ui/CopyButton.js";
import { CheckRow } from "../../components/CheckRow.js";
import { qk } from "../../data/queries.js";
import { useQueryClient } from "@tanstack/react-query";
import {
  IssueCiTokenFlow,
  PublisherDrawer,
  tokenState,
  useCiPublisher,
  useCiTokens,
} from "../core/KeysCi.js";
import { LinkRepositoryDrawer } from "../core/LinkRepository.js";

/** How often the store is re-read while the panel waits for the first release. */
export const FIRST_RELEASE_POLL_MS = 10_000;

/** The default workflow file, as `.pkey/release`'s trusted publisher defaults it. */
const DEFAULT_WORKFLOW = ".github/workflows/release.yml";

/**
 * The publish step for a release job, with the product's slug filled in. It follows the CI guide
 * (`/docs/build/ci/`): the Action is referenced by commit until it is listed as `@v1`.
 */
export function workflowStep(slug: string): string {
  return [
    "# In the release job, after the steps that build your files.",
    "# The job needs `permissions: id-token: write` (and `release-key` if .pkey/release declares releaseKeys).",
    "- uses: vladzaharia/polaris-key/actions/publish@<commit-sha>",
    "  with:",
    `    product: ${slug}`,
    "    tag: ${{ github.ref_name }}",
    "    channel: stable",
    "    dir: dist",
  ].join("\n");
}

const STAR = markPartPath("star", { kind: "key", size: 48, theme: "mono" });

export interface FirstReleasePanelProps {
  slug: string;
  productName: string;
  /** The product is linked to a GitHub repository (`releaseSource`). */
  linked: boolean;
  /** The repo sync health (linked products only): its `github` check is the App row. */
  health: {
    data: ReleaseHealth | undefined;
    isPending: boolean;
    isError: boolean;
    refetch: () => unknown;
  };
}

export function FirstReleasePanel({
  slug,
  productName,
  linked,
  health,
}: FirstReleasePanelProps): React.ReactElement {
  const queryClient = useQueryClient();
  const publisher = useCiPublisher(slug);
  const tokens = useCiTokens(slug);
  const [editingPublisher, setEditingPublisher] = React.useState(false);
  const [issuing, setIssuing] = React.useState(false);
  const [linking, setLinking] = React.useState(false);
  const { copy, state: copyState } = useCopy();
  const policy = publisher.data ?? null;
  const step = workflowStep(slug);

  // Wait out loud: re-read the store until the first release lands (ReleasesPage announces it).
  React.useEffect(() => {
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void queryClient.invalidateQueries({ queryKey: qk.releases(slug) });
    }, FIRST_RELEASE_POLL_MS);
    return () => window.clearInterval(id);
  }, [slug]);

  const rows: React.ReactNode[] = [];

  if (linked) {
    const github = health.data?.checks.find((c) => c.id === "github");
    rows.push(
      health.isPending ? (
        <CheckRow
          key="app"
          state="checking"
          title="Polaris Key app"
          detail="Checking access to the repository…"
        />
      ) : health.isError || !github ? (
        <CheckRow
          key="app"
          state="todo"
          title="Polaris Key app"
          detail="Couldn't check access to the repository."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void health.refetch()}
            >
              Check again
            </Button>
          }
        />
      ) : github.status === "ok" ? (
        <CheckRow
          key="app"
          state="done"
          title="Polaris Key app installed"
          detail={
            policy?.repository ? (
              <span className="font-mono">{policy.repository}</span>
            ) : (
              "Reads the repository's releases"
            )
          }
        />
      ) : (
        <CheckRow
          key="app"
          state="failed"
          title="Polaris Key app can't read the repository"
          detail="Install the Polaris Key GitHub App on the repository, then check again."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void health.refetch()}
            >
              Check again
            </Button>
          }
        />
      ),
    );
  }

  if (!linked) {
    rows.push(
      <CheckRow
        key="link"
        state="todo"
        title="Link a repository"
        detail="Its .pkey/ manifest then sets up the product, and every push re-applies it"
        action={
          <Button variant="outline" size="sm" onClick={() => setLinking(true)}>
            Link repository…
          </Button>
        }
      />,
    );
  }

  rows.push(
    publisher.isPending ? (
      <CheckRow
        key="publisher"
        state="checking"
        title="Trusted publisher"
        detail="Checking…"
      />
    ) : publisher.isError ? (
      <CheckRow
        key="publisher"
        state="todo"
        title="Trusted publisher"
        detail="Couldn't load the trusted publisher."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void publisher.refetch()}
          >
            Try again
          </Button>
        }
      />
    ) : policy ? (
      <CheckRow
        key="publisher"
        state="done"
        title="Trusted publisher"
        detail={
          <>
            <span className="font-mono">{policy.workflow}</span> in{" "}
            <span className="font-mono">{policy.repository}</span>
          </>
        }
        action={
          <Button
            variant="outline"
            size="sm"
            iconStart={<Pencil aria-hidden />}
            onClick={() => setEditingPublisher(true)}
          >
            Edit…
          </Button>
        }
      />
    ) : (
      <CheckRow
        key="publisher"
        state="todo"
        title="Trusted publisher"
        detail="Lets the release workflow publish without a token"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditingPublisher(true)}
          >
            Allow workflow…
          </Button>
        }
      />
    ),
  );

  if (!linked) {
    const nowSec = toSeconds(Date.now());
    const active = (tokens.data ?? []).filter(
      (t) => tokenState(t, nowSec) === "active",
    ).length;
    rows.push(
      <CheckRow
        key="token"
        state={active ? "done" : "todo"}
        title={active ? "CI token issued" : "Or a CI token"}
        detail={
          active
            ? `${active} active ${active === 1 ? "token" : "tokens"}, for a CI that is not GitHub Actions`
            : "For a CI that is not GitHub Actions"
        }
        action={
          <Button
            variant="outline"
            size="sm"
            iconStart={active ? <Plus aria-hidden /> : undefined}
            onClick={() => setIssuing(true)}
          >
            {active ? "Issue another…" : "Issue a CI token…"}
          </Button>
        }
      />,
    );
  }

  rows.push(
    <CheckRow
      key="waiting"
      state="waiting"
      title="Waiting for the first release…"
      detail="This page updates when CI publishes"
    />,
  );

  const description = linked
    ? `Releases come from CI, signed with ${productName}'s key. Two checks and one workflow step, then this page fills itself in.`
    : `Releases come from CI, signed with ${productName}'s key. Link a repository or let CI publish, add one workflow step, then this page fills itself in.`;

  return (
    <section
      aria-labelledby="first-release-title"
      data-first-release
      className="grid gap-8 rounded-xl border border-border bg-surface-raised p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
    >
      <div className="flex flex-col items-start gap-4">
        <span
          aria-hidden
          className="inline-flex size-14 items-center justify-center rounded-full bg-accent-subtle text-accent-fg"
        >
          <svg
            width={28}
            height={28}
            viewBox={STAR.viewBox}
            className="fill-current"
          >
            <path d={STAR.d} />
          </svg>
        </span>
        <div className="space-y-2">
          <h2
            id="first-release-title"
            className="text-xl font-bold text-fg-strong"
          >
            Ship your first release
          </h2>
          <p className="max-w-prose text-sm text-fg-muted">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            iconStart={
              copyState === "copied" ? (
                <Check aria-hidden />
              ) : (
                <Copy aria-hidden />
              )
            }
            onClick={() => void copy(step)}
          >
            {copyState === "copied" ? "Copied" : "Copy workflow step"}
          </Button>
          <Button variant="ghost" asChild>
            <a href={docsUrl("ciPublishing")} target="_blank" rel="noreferrer">
              <BookOpen aria-hidden />
              Release docs
            </a>
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <ul
          aria-label="Before the first release"
          className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-page"
        >
          {rows}
        </ul>
        <CodeBlock
          code={step}
          language="yaml"
          filename={policy?.workflow || DEFAULT_WORKFLOW}
        />
      </div>
      <PublisherDrawer
        slug={slug}
        open={editingPublisher}
        policy={policy}
        onClose={() => setEditingPublisher(false)}
      />
      <IssueCiTokenFlow slug={slug} open={issuing} onOpenChange={setIssuing} />
      {!linked ? (
        <LinkRepositoryDrawer
          slug={slug}
          productName={productName}
          open={linking}
          onClose={() => setLinking(false)}
        />
      ) : null}
    </section>
  );
}
