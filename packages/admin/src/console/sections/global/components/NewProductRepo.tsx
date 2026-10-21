import * as React from "react";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import type {
  CreateDryRun,
  GithubRepositories,
  SlugCheck,
} from "../../../../api.js";
import { DOCS_LINKS } from "../../../../lib/docsLinks.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { FormStep } from "../../../../ui/wizard/index.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { FEATURES } from "../../../../services.generated.js";
import {
  platformLabel,
  pushedWords,
  repoOf,
  slugFromName,
} from "../model/newProduct.js";

const PAGE = 5;

/** A slow read shows its skeleton only after a beat, so a quick one doesn't flash. */
export function useGrace(pending: boolean, ms = 250): boolean {
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    if (!pending) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), ms);
    return () => window.clearTimeout(t);
  }, [pending, ms]);
  return shown;
}

// ── Repository ───────────────────────────────────────────────────────────────────────────────

export interface RepoList {
  pending: boolean;
  error: boolean;
  data: GithubRepositories | undefined;
  retry: () => void;
}

/**
 * The repository step (W22): paste `owner/repo` or a URL, or pick one the Polaris Key app can
 * read. A repository that is a product already says so, and the primary opens that product.
 */
export function RepoStep({
  value,
  onChange,
  onSubmit,
  error,
  list,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  error?: string;
  list: RepoList;
}): React.ReactElement {
  return (
    <FormStep formId="np-repo" onSubmit={onSubmit}>
      {/* The picker adds fields to the form: without a submit button Enter would do nothing. */}
      <button type="submit" tabIndex={-1} aria-hidden className="sr-only" />
      <FormField
        name="repoUrl"
        label="Repository"
        help="owner/repo, or the repository's GitHub URL. Polaris Key reads .pkey/ on its default branch."
        value={value}
        onChange={onChange}
        error={error}
        announceError
      >
        {(field) => (
          <Input
            {...field}
            data-field-name="repoUrl"
            onChange={(e) => field.onChange(e.target.value)}
            placeholder="acme/tonebox"
            autoComplete="off"
            spellCheck={false}
            mono
          />
        )}
      </FormField>
      <RepoPicker list={list} value={repoOf(value) ?? ""} onPick={onChange} />
    </FormStep>
  );
}

/**
 * Enter on a repository row continues, as it does in the text field (B-232). A radio button takes
 * Enter for itself (it never submits), so the row is chosen if it was only focused, and the step's
 * form submits once that choice has landed.
 */
export function enterSubmits(e: React.KeyboardEvent<HTMLElement>): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[role=radio]");
  if (e.key !== "Enter" || !row) return;
  e.preventDefault();
  const form = e.currentTarget.closest("form");
  if (row.getAttribute("aria-checked") !== "true") row.click();
  setTimeout(() => form?.requestSubmit(), 0);
}

function RepoPicker({
  list,
  value,
  onPick,
}: {
  list: RepoList;
  value: string;
  onPick: (full: string) => void;
}): React.ReactElement | null {
  const [shown, setShown] = React.useState(PAGE);
  const grace = useGrace(list.pending);
  // "Show more" focuses the first row it adds, so the keyboard continues where the list grew.
  const focusFrom = React.useRef<number | null>(null);
  React.useEffect(() => {
    const at = focusFrom.current;
    if (at === null) return;
    focusFrom.current = null;
    document
      .querySelectorAll<HTMLElement>("#np-repos [role=radio]")
      [at]?.focus();
  }, [shown]);
  if (list.pending)
    return grace ? (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    ) : null;
  if (list.error || !list.data)
    return (
      <p className="text-sm text-fg-muted">
        The repositories could not be listed. Paste one above, or{" "}
        <button
          type="button"
          onClick={list.retry}
          className="underline underline-offset-4"
        >
          try again
        </button>
        .
      </p>
    );
  const data = list.data;
  if (!data.configured || !data.app)
    return (
      <Callout tone="info" title="The GitHub App isn't set up">
        This platform has no GitHub App credentials yet. Add them on the
        Platform page. You can still paste a repository above once it is.
        <div className="mt-2">
          <Link
            to={r.platform()}
            className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
          >
            Open Platform
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </Callout>
    );
  if (data.installations.length === 0)
    return (
      <Callout
        tone="info"
        title="The Polaris Key app is not installed on GitHub"
      >
        Install it to pick a repository here. You can still paste one above.
        {data.app ? (
          <div className="mt-2">
            <a
              href={data.app.installUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
            >
              Install on GitHub
              <ArrowRight aria-hidden className="size-3.5" />
            </a>
          </div>
        ) : null}
      </Callout>
    );
  if (data.repositories.length === 0)
    return <p className="text-sm text-fg-muted">No repository matches.</p>;
  const rows = data.repositories.slice(0, shown);
  return (
    <div className="space-y-2" onKeyDown={enterSubmits}>
      <RadioCards
        id="np-repos"
        aria-label="Repositories the Polaris Key app can read"
        columns={1}
        value={rows.some((r) => r.fullName === value) ? value : null}
        onChange={onPick}
        options={rows.map((row) => ({
          value: row.fullName,
          label: <span className="break-words">{row.fullName}</span>,
          description: (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                {[
                  row.product ? `Already a product · ${row.product}` : null,
                  row.language,
                  row.pushedAt ? pushedWords(row.pushedAt) : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No pushes yet"}
              </span>
              {row.hasManifest === true && !row.product ? (
                <StatusPill tone="success" size="sm">
                  Has .pkey/
                </StatusPill>
              ) : row.hasManifest === false ? (
                <StatusPill tone="neutral" size="sm">
                  No .pkey/ yet
                </StatusPill>
              ) : null}
            </span>
          ),
        }))}
      />
      {data.repositories.length > shown ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            focusFrom.current = shown;
            setShown((n) => n + PAGE);
          }}
        >
          Show more ({data.repositories.length - shown})
        </Button>
      ) : null}
    </div>
  );
}

// ── Check ────────────────────────────────────────────────────────────────────────────────────

/** Why the check could not be read, in the words of what to do next. */
export interface CheckFailure {
  kind: "app" | "notfound" | "network" | "other";
  title: string;
  description: string;
  /** Where "Install on GitHub" goes (W22's `installUrl`). */
  installUrl: string | null;
}

const slugWords = (s: SlugCheck | null): string | null =>
  s?.status === "available" ? "Available" : s ? s.message : null;

/** The feature names a set of enabled services turns on (never the slugs). */
export function featuresOfServices(services: readonly string[]): string[] {
  return FEATURES.filter((f) =>
    f.primary.some((s) => services.includes(s)),
  ).map((f) => f.label);
}

/** `.pkey/product` is missing: the one-command start, the docs, and the way out. */
function NoPkey({
  repo,
  onScratch,
  again,
}: {
  repo: string;
  onScratch: () => void;
  again: React.ReactNode;
}): React.ReactElement {
  const name = repo.split("/")[1] ?? repo;
  const slug = slugFromName(name) || "my-product";
  return (
    <Callout tone="info" title="No .pkey/ yet">
      <p>
        Run this in the repository, commit and push, then check again. Or start
        from scratch and link the repository later.
      </p>
      <div className="mt-2">
        <CodeBlock
          code={`pkey init --product ${slug} --name "${name}"`}
          language="text"
          filename="Terminal"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          href={DOCS_LINKS.createProduct}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
        >
          How .pkey/ works
          <ArrowRight aria-hidden className="size-3.5" />
        </a>
        {again}
        <Button type="button" variant="outline" size="sm" onClick={onScratch}>
          Start from scratch instead
        </Button>
      </div>
    </Callout>
  );
}

/** `.pkey/product` is missing: the repository has no `.pkey/` yet. */
export function isNoPkey(d: CreateDryRun): boolean {
  return d.problems.some(
    (p) =>
      p.file === "product" && p.message.includes(".pkey/product is required"),
  );
}

/**
 * The check step (W23): what `.pkey/` says and the product as it would be created, or why it can't
 * be read. Nothing to type: creating is the consent. The list of what Create writes is the rail.
 */
export function CheckStep({
  repo,
  state,
  failure,
  stale,
  changed,
  onCheckAgain,
  checking,
  onScratch,
}: {
  repo: string;
  state: { pending: boolean; data: CreateDryRun | undefined };
  failure: CheckFailure | null;
  /** The create was refused because `.pkey/` changed after the check. */
  stale: boolean;
  /** The last create was refused because `.pkey/` changed after the check; nothing was created. */
  changed: boolean;
  onCheckAgain: () => void;
  checking: boolean;
  onScratch: () => void;
}): React.ReactElement {
  const grace = useGrace(state.pending);
  const again = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      loading={checking}
      onClick={onCheckAgain}
    >
      Check again
    </Button>
  );
  if (state.pending)
    return grace ? (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    ) : (
      <div aria-busy="true" />
    );
  if (failure || !state.data)
    return (
      <Callout
        tone={failure?.kind === "network" ? "warning" : "danger"}
        title={failure?.title ?? "Could not read the repository"}
        live
      >
        <p>{failure?.description ?? `Polaris Key could not read ${repo}.`}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {failure &&
          (failure.kind === "app" || failure.kind === "notfound") ? (
            <a
              href={failure.installUrl ?? DOCS_LINKS.createProduct}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
            >
              {failure.kind === "app"
                ? "Install on GitHub"
                : "Open the app on GitHub"}
              <ArrowRight aria-hidden className="size-3.5" />
            </a>
          ) : null}
          {again}
        </div>
      </Callout>
    );
  const d = state.data;
  const noPkey = isNoPkey(d);
  return (
    <div className="space-y-5">
      {changed ? (
        <Callout
          tone="warning"
          title="The repository changed after the check"
          live
        >
          <p>
            Nothing was created.{" "}
            {stale
              ? "Polaris Key is reading it again."
              : "Check what it found, then create."}
          </p>
        </Callout>
      ) : null}
      <section
        aria-label="The product"
        className="space-y-2 rounded-lg border border-border bg-surface-sunken p-4"
      >
        <p className="break-words text-base font-semibold text-fg-strong">
          {d.product?.name ?? d.repository}
        </p>
        {d.product && !d.registeredAs ? (
          <p className="text-sm text-fg-muted">
            <span className="font-mono">{d.product.slug}</span>
            {slugWords(d.slug) ? (
              <>
                {" · "}
                <span className="inline-flex items-center gap-1">
                  {d.slug?.status === "available" ? (
                    <Check aria-hidden className="size-3.5" />
                  ) : (
                    <TriangleAlert aria-hidden className="size-3.5" />
                  )}
                  {slugWords(d.slug)}
                </span>
              </>
            ) : null}
          </p>
        ) : null}
        <p className="text-sm text-fg-muted">
          <span className="break-words font-mono">{d.repository}</span> at{" "}
          <span className="font-mono">{d.commit.slice(0, 7)}</span>
        </p>
      </section>

      {d.registeredAs ? (
        <Callout tone="info" title={`Already a product: ${d.registeredAs}`}>
          Polaris Key keeps it in sync with every push.
        </Callout>
      ) : noPkey ? (
        <NoPkey repo={d.repository} onScratch={onScratch} again={again} />
      ) : d.problems.length > 0 ? (
        <Callout tone="danger" title="Fix these in one commit" live>
          <ul className="mt-1 list-disc space-y-1 ps-5">
            {d.problems.map((p) => (
              <li key={`${p.file}${p.path}${p.message}`}>
                {p.file ? (
                  <span className="font-mono text-xs">
                    .pkey/{p.file}
                    {p.path && p.path !== "/" ? ` ${p.path}` : ""}
                  </span>
                ) : null}
                {p.file ? ": " : null}
                {p.message}
                {p.suggestion ? ` Try ${p.suggestion}.` : ""}
              </li>
            ))}
          </ul>
          <div className="mt-3">{again}</div>
        </Callout>
      ) : (
        <>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
            <Row k="Features">
              {featuresOfServices(d.services).join(", ") || "none"}
            </Row>
            <Row k="Catalog">
              {d.catalog
                ? `${d.catalog.entries} ${d.catalog.entries === 1 ? "entry" : "entries"}`
                : "none"}
            </Row>
            <Row k="Platforms">
              {d.platforms.values.length
                ? d.platforms.values.map(platformLabel).join(", ")
                : "none declared"}
            </Row>
          </dl>
          {d.secrets.length > 0 ? (
            <p className="text-sm text-fg-muted">
              {d.secrets.length} {d.secrets.length === 1 ? "secret" : "secrets"}{" "}
              to set after creating:{" "}
              <span className="break-words font-mono">
                {d.secrets.join(", ")}
              </span>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Row({
  k,
  children,
}: {
  k: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <dt className="text-fg-muted">{k}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </>
  );
}

/** What a checked repository's create writes (the rail on a repository path). */
export function repoCreates(d: CreateDryRun): string[] {
  return [
    "A signing key",
    "Default profile",
    `Catalog v1 (${d.catalog?.entries ?? 0} ${d.catalog?.entries === 1 ? "entry" : "entries"})`,
    ...(d.starterTier === "free" ? ["The Free tier"] : []),
    ...(d.releaseWorkflow ? ["Trust for .github/workflows/release.yml"] : []),
    "Sync with every push",
  ];
}
