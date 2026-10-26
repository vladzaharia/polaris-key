import * as React from "react";
import { ExternalLink, FileText } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../Button.js";
import { CodeBlock } from "../CodeBlock.js";
import { StatusPill } from "../StatusPill.js";
import { WaitingFor } from "./WaitingFor.js";
import type { SnippetTab } from "./steps.js";

interface RepoChangePullRequest {
  number: number;
  /** The pull request on GitHub. */
  url: string;
  /** What merging it changes, in one line. */
  summary: string;
  files: readonly { path: string; change?: "added" | "changed" }[];
}

interface RepoChangePermission {
  /** The permission the App needs, in GitHub's words ("Contents: write"). */
  needs: string;
  /** Where the owner reviews the App's permissions on GitHub. */
  reviewUrl: string;
}

type TabId = "command" | "hand" | "app";

/**
 * A step that changes the product's repository (A-32). When Polaris Key opened the pull request
 * (`pullRequest`), it shows what merging does. Otherwise the person makes the change: tabs for the
 * One command (default), By hand, and Let Polaris Key open pull requests. Either way a
 * `WaitingFor` below it watches for the change to arrive.
 */
export function RepoChangeStep({
  pullRequest,
  command,
  files,
  permission,
  waiting,
  found,
  onCheck,
  checking,
  timeoutMs,
  onOpenPullRequest,
  opening,
  notice,
}: {
  pullRequest?: RepoChangePullRequest | null;
  /** The `pkey` line with every value filled in. */
  command?: string;
  /** Each file's block, for the By hand tab. */
  files?: readonly SnippetTab[];
  /** Shown on the third tab; omit when Polaris Key cannot open pull requests here. */
  permission?: RepoChangePermission;
  /** "Waiting for the change to reach main". */
  waiting: string;
  /** The event, once seen. */
  found: string | null;
  onCheck?: () => void;
  checking?: boolean;
  timeoutMs?: number;
  /** Adds an "Open the pull request" button to the third tab. */
  onOpenPullRequest?: () => void;
  opening?: boolean;
  /** A refusal or note, shown above the tabs. */
  notice?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      {notice}
      {pullRequest ? (
        <PullRequestView pr={pullRequest} />
      ) : (
        <ByYourself
          command={command}
          files={files ?? []}
          permission={permission}
          onOpenPullRequest={onOpenPullRequest}
          opening={opening}
        />
      )}
      <WaitingFor
        waiting={waiting}
        found={found}
        onCheck={onCheck}
        checking={checking}
        timeoutMs={timeoutMs}
      />
    </div>
  );
}

function PullRequestView({
  pr,
}: {
  pr: RepoChangePullRequest;
}): React.ReactElement {
  return (
    <section
      aria-labelledby={`pr-${pr.number}`}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <h3
        id={`pr-${pr.number}`}
        className="text-sm font-semibold text-fg-strong"
      >
        Merge pull request #{pr.number}
      </h3>
      <p className="text-sm text-fg">{pr.summary}</p>
      <ul className="space-y-1 text-sm" aria-label="Files">
        {pr.files.map((f) => (
          <li key={f.path} className="flex min-w-0 items-center gap-2">
            <FileText aria-hidden className="size-4 shrink-0 text-fg-muted" />
            <code className="min-w-0 break-all font-mono text-xs text-fg">
              {f.path}
            </code>
            {f.change ? (
              <StatusPill tone="neutral" size="sm">
                {f.change === "added" ? "Added" : "Changed"}
              </StatusPill>
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        asChild
        variant="outline"
        size="sm"
        iconEnd={<ExternalLink aria-hidden />}
      >
        <a href={pr.url} target="_blank" rel="noreferrer">
          Open on GitHub
        </a>
      </Button>
    </section>
  );
}

function ByYourself({
  command,
  files,
  permission,
  onOpenPullRequest,
  opening,
}: {
  command?: string;
  files: readonly SnippetTab[];
  permission?: RepoChangePermission;
  onOpenPullRequest?: () => void;
  opening?: boolean;
}): React.ReactElement {
  const uid = React.useId();
  const tabs = [
    command ? { id: "command", label: "One command" } : null,
    files.length > 0 ? { id: "hand", label: "By hand" } : null,
    permission || onOpenPullRequest
      ? { id: "app", label: "Let Polaris Key open pull requests" }
      : null,
  ].filter(Boolean) as { id: TabId; label: string }[];
  const [selected, setSelected] = React.useState<TabId>(
    tabs[0]?.id ?? "command",
  );
  const current = tabs.find((t) => t.id === selected) ?? tabs[0];
  const refs = React.useRef(new Map<TabId, HTMLButtonElement>());
  if (!current) return <></>;

  const move = (e: React.KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % n
        : e.key === "ArrowLeft"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    const t = tabs[to]!;
    setSelected(t.id);
    refs.current.get(t.id)?.focus();
  };

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="How to make the change"
        className="flex flex-wrap gap-1 border-b border-border"
      >
        {tabs.map((t, i) => {
          const on = t.id === current.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) refs.current.set(t.id, el);
                else refs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={`${uid}-${t.id}-tab`}
              aria-selected={on}
              aria-controls={`${uid}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => setSelected(t.id)}
              onKeyDown={(e) => move(e, i)}
              className={cn(
                "-mb-px min-h-11 border-b-2 px-3 text-sm font-medium",
                on
                  ? "border-accent text-fg-strong"
                  : "border-transparent text-fg-muted hover:text-fg",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${uid}-panel`}
        aria-labelledby={`${uid}-${current.id}-tab`}
        className="space-y-3"
      >
        {current.id === "command" && command ? (
          <>
            <p className="text-sm text-fg-muted">
              Run it in the repository root.
            </p>
            <CodeBlock code={command} language="sh" filename="Terminal" />
          </>
        ) : null}
        {current.id === "hand" ? (
          <div className="space-y-4">
            {files.map((f) => (
              <div key={f.id} className="space-y-2">
                {f.where ? (
                  <p className="text-sm text-fg-muted">{f.where}.</p>
                ) : null}
                <CodeBlock
                  code={f.code}
                  language={f.language ?? "text"}
                  filename={f.filename}
                />
              </div>
            ))}
          </div>
        ) : null}
        {current.id === "app" ? (
          <>
            {onOpenPullRequest ? (
              <Button size="sm" loading={opening} onClick={onOpenPullRequest}>
                Open the pull request
              </Button>
            ) : null}
            {permission ? (
              <p className="text-sm text-fg">
                Needs{" "}
                <strong className="font-medium">{permission.needs}</strong> on
                this repository.
              </p>
            ) : null}
            {permission ? (
              <Button
                asChild
                variant="outline"
                size="sm"
                iconEnd={<ExternalLink aria-hidden />}
              >
                <a href={permission.reviewUrl} target="_blank" rel="noreferrer">
                  Review permissions on GitHub
                </a>
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
