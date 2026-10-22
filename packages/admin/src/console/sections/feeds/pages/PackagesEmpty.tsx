/**
 * Packages, nothing declared (F-34.7; mockup `packages.feeds-empty`) and a feed the product has
 * not declared. One guided panel in two panes (the shape of `FirstReleasePanel`): the sentence
 * and the docs link on the left, the `.pkey/release` declaration with the publish command at its
 * foot on the right. A feed exists because a package is declared: nothing here creates one.
 */

import * as React from "react";
import { BookOpen } from "lucide-react";
import { PACKAGE_ECOSYSTEMS } from "@polaris-key/manifest";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Button } from "../../../../ui/Button.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { markPartPath } from "../../../../ui/markPath.js";
import { Link } from "../../../router.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { overviewHref, type FeedScope } from "../model/model.js";

const STAR = markPartPath("star", { kind: "key", size: 48, theme: "mono" });

/** The deliverable the snippet and the command name: the ecosystem's, `<eco>.sourcekit`. */
function deliverableOf(eco: string): string {
  return `${eco}.sourcekit`;
}

/** The publish command for a deliverable (CI's step). */
export function publishCommand(deliverable: string, dir: string): string {
  return `pkey release publish --deliverable ${deliverable} --dir ${dir}`;
}

/** The `.pkey/release` declaration the panel shows, in the product's own scope. */
export function declarationSnippet(slug: string, eco = "npm"): string {
  return [
    "deliverables:",
    `  ${deliverableOf(eco)}:`,
    "    kind: package",
    `    ecosystem: ${eco} # ${PACKAGE_ECOSYSTEMS.join(" | ")}`,
    `    name: "${eco === "npm" ? `@${slug}/source-kit` : `${slug}-source-kit`}"`,
    "    artifacts:",
    `      tarball: { match: "dist/${eco}/*" }`,
  ].join("\n");
}

/** The publish command behind a `$`, one line that scrolls sideways, copy pinned. */
export function CommandLine({
  command,
  className,
}: {
  command: string;
  className?: string;
}): React.ReactElement {
  return (
    <div
      data-publish-command=""
      className={`flex items-center gap-2 border-border bg-surface-page px-3 py-2 ${className ?? ""}`}
    >
      <span
        aria-hidden
        className="select-none font-mono text-xs text-fg-subtle"
      >
        $
      </span>
      <div
        role="region"
        aria-label="Publish command"
        tabIndex={0}
        className="pk-scroll min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1 font-mono text-xs"
      >
        {command}
      </div>
      <CopyButton value={command} label="Copy the publish command" size="xs" />
    </div>
  );
}

/** The code pane: the declaration, with the command at its foot. */
function CodePane({
  slug,
  eco,
}: {
  slug: string;
  eco: string;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <CodeBlock
        code={declarationSnippet(slug, eco)}
        language="yaml"
        filename=".pkey/release"
        className="rounded-b-none border-b-0"
      />
      <CommandLine
        command={publishCommand(deliverableOf(eco), `dist/${eco}`)}
        className="rounded-b-lg border"
      />
    </div>
  );
}

function GuidedPanel({
  titleId,
  title,
  slug,
  eco,
  extra,
}: {
  titleId: string;
  title: string;
  slug: string;
  eco: string;
  extra?: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      aria-labelledby={titleId}
      data-guided-panel=""
      className="grid gap-6 rounded-xl border border-border bg-surface-raised p-5 sm:p-8 lg:grid-cols-2 lg:items-center lg:gap-8"
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
          <h2 id={titleId} className="text-xl font-semibold text-fg-strong">
            {title}
          </h2>
          <p className="max-w-prose text-sm text-fg-muted">
            Declare a package in <code>.pkey/release</code>; its feed appears
            here on the next resync.
          </p>
        </div>
        <Button variant="ghost" asChild>
          <a href={docsUrl("declarePackage")} target="_blank" rel="noreferrer">
            <BookOpen aria-hidden />
            Declaring a package
          </a>
        </Button>
        {extra}
      </div>
      <CodePane slug={slug} eco={eco} />
    </section>
  );
}

/** Nothing declared: the panel, and nothing to turn on. */
export function PackagesEmpty({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  return (
    <GuidedPanel
      titleId="packages-empty-title"
      title={`${name} declares no packages yet`}
      slug={slug}
      eco="npm"
    />
  );
}

/** A deep link to a feed the product has not declared (`…/feeds/swift`). */
export function UndeclaredFeed({
  scope,
  slug,
  name,
  eco,
  ecoLabel,
}: {
  scope: FeedScope;
  slug: string;
  name: string;
  eco: string;
  ecoLabel: string;
}): React.ReactElement {
  return (
    <div className="space-y-6">
      <PageHeader title={ecoLabel} />
      <GuidedPanel
        titleId="feed-undeclared-title"
        title={`${name} declares no ${ecoLabel} package`}
        slug={slug}
        eco={eco}
        extra={
          <Button variant="outline" asChild>
            <Link to={overviewHref(scope)}>All packages</Link>
          </Button>
        }
      />
    </div>
  );
}
