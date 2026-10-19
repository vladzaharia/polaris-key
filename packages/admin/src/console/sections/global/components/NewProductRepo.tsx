import * as React from "react";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import type {
  CreateDryRun,
  GithubRepoRow,
  GithubRepositories,
  SlugCheck,
} from "../../../../api.js";
import type { ErrorCopy } from "../../../../lib/errorCopy.js";
import { cn } from "../../../../lib/cn.js";
import { formatRelative } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import {
  AutoList,
  FormStep,
  type AutoItem,
} from "../../../../ui/wizard/index.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { repoOf } from "../model/newProduct.js";
import { RefusalFix } from "./NewProductSteps.js";

// ── Repository ───────────────────────────────────────────────────────────────────────────────

/**
 * The repository step (W22): paste `owner/repo` or a URL, or pick one the Polaris Key app can
 * read. A repository that is a product already opens that product; it is never registered twice.
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
  list: {
    pending: boolean;
    error: boolean;
    data: GithubRepositories | undefined;
    retry: () => void;
  };
}): React.ReactElement {
  const picked = repoOf(value)?.toLowerCase();
  return (
    <FormStep formId="np-repo" onSubmit={onSubmit}>
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
      <RepoList
        list={list}
        picked={picked}
        onPick={(row) => onChange(row.fullName)}
      />
    </FormStep>
  );
}

function RepoList({
  list,
  picked,
  onPick,
}: {
  list: {
    pending: boolean;
    error: boolean;
    data: GithubRepositories | undefined;
    retry: () => void;
  };
  picked: string | undefined;
  onPick: (row: GithubRepoRow) => void;
}): React.ReactElement | null {
  if (list.pending)
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
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
  if (!data.configured || data.installations.length === 0)
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
  return (
    <ul
      aria-label="Repositories the Polaris Key app can read"
      className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border"
    >
      {data.repositories.map((row) => (
        <li
          key={row.fullName}
          className="flex flex-wrap items-center gap-2 p-2"
        >
          {row.product ? (
            <>
              <span className="min-w-0 basis-full break-all font-mono text-sm">
                {row.fullName}
              </span>
              <span className="text-sm text-fg-muted">
                Already a product · {row.product}
              </span>
              <Button variant="ghost" size="sm" asChild>
                <Link to={r.overview(row.product)}>Open product</Link>
              </Button>
            </>
          ) : (
            <button
              type="button"
              aria-pressed={picked === row.fullName.toLowerCase()}
              onClick={() => onPick(row)}
              className={cn(
                "flex min-h-8 min-w-0 flex-1 basis-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 text-left text-sm sm:basis-0",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
                picked === row.fullName.toLowerCase() &&
                  "bg-surface-sunken ring-1 ring-border-strong",
              )}
            >
              <span className="min-w-0 break-all font-mono">
                {row.fullName}
              </span>
              <span className="text-fg-muted">
                {[
                  row.language,
                  row.pushedAt
                    ? `pushed ${formatRelative(row.pushedAt * 1000)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {row.hasManifest === true ? (
                <StatusPill tone="success" size="sm">
                  Has .pkey/
                </StatusPill>
              ) : row.hasManifest === false ? (
                <StatusPill tone="neutral" size="sm">
                  No .pkey/ yet
                </StatusPill>
              ) : null}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Check ────────────────────────────────────────────────────────────────────────────────────

const slugWords = (s: SlugCheck | null): string | null =>
  s?.status === "available" ? "Available" : s ? s.message : null;

/**
 * The check step (W23): what `.pkey/` says, the product as it will be, and every problem with its
 * file and path. Nothing to type: creating is the consent.
 */
export function CheckStep({
  repo,
  state,
  failure,
  onCheckAgain,
  checking,
}: {
  repo: string;
  state: { pending: boolean; data: CreateDryRun | undefined };
  failure: ErrorCopy | null;
  onCheckAgain: () => void;
  checking: boolean;
}): React.ReactElement {
  if (state.pending)
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (failure || !state.data)
    return (
      <Callout
        tone="danger"
        title={failure?.title ?? "Could not read the repository"}
        live
      >
        <p>{failure?.description ?? `Polaris Key could not read ${repo}.`}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {failure?.fix?.kind === "install-github-app" ? (
            <RefusalFix fix={failure.fix} onCheckAgain={onCheckAgain} />
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={checking}
            onClick={onCheckAgain}
          >
            Check again
          </Button>
        </div>
      </Callout>
    );
  const d = state.data;
  const rows: [string, string][] = [
    ["Services", d.services.length ? d.services.join(", ") : "none"],
    [
      "Catalog",
      d.catalog
        ? `${d.catalog.entries} ${d.catalog.entries === 1 ? "entry" : "entries"}`
        : "none",
    ],
    [
      "Platforms",
      d.platforms.values.length
        ? d.platforms.values.join(", ")
        : "none declared",
    ],
  ];
  const items: AutoItem[] = [
    { id: "key", label: "Mint and activate the signing key", state: "will" },
    { id: "profile", label: "Create the Default profile", state: "will" },
    ...(d.services.includes("license")
      ? [
          {
            id: "tier",
            label: "Create the Free tier if the manifest declares no tier",
            state: "will" as const,
          },
        ]
      : []),
    ...(d.releaseWorkflow
      ? [
          {
            id: "trust",
            label: "Trust .github/workflows/release.yml to publish",
            state: "will" as const,
          },
        ]
      : []),
    {
      id: "sync",
      label: "Keep the product in sync with every push",
      state: "will",
    },
  ];
  return (
    <div className="space-y-5">
      <section
        aria-label="The product"
        className="space-y-2 rounded-lg border border-border bg-surface-sunken p-4"
      >
        <p className="text-base font-semibold text-fg-strong">
          {d.product?.name ?? d.repository}
        </p>
        {d.product ? (
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
          <span className="font-mono break-all">{d.repository}</span> at{" "}
          <span className="font-mono">{d.commit.slice(0, 7)}</span>
        </p>
      </section>

      {d.registeredAs ? (
        <Callout tone="info" title={`Already a product: ${d.registeredAs}`}>
          <Link
            to={r.overview(d.registeredAs)}
            className="underline underline-offset-4"
          >
            Open {d.registeredAs}
          </Link>
        </Callout>
      ) : null}

      {d.problems.length > 0 ? (
        <Callout tone="danger" title="Fix these in one commit" live>
          <ul className="mt-1 list-disc space-y-1 pl-5">
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
          <div className="mt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={checking}
              onClick={onCheckAgain}
            >
              Check again
            </Button>
          </div>
        </Callout>
      ) : (
        <>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
            {rows.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-fg-muted">{k}</dt>
                <dd className="min-w-0 break-words text-fg">{v}</dd>
              </React.Fragment>
            ))}
          </dl>
          {d.secrets.length > 0 ? (
            <p className="text-sm text-fg-muted">
              {d.secrets.length} {d.secrets.length === 1 ? "secret" : "secrets"}{" "}
              to set after creating:{" "}
              <span className="font-mono">{d.secrets.join(", ")}</span>
            </p>
          ) : null}
          <AutoList title="Polaris Key will set this up" items={items} />
        </>
      )}
    </div>
  );
}
