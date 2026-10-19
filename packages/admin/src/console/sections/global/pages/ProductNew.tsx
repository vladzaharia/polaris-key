import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SlugCheck } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import { Wizard } from "../../../../ui/wizard/index.js";
import { Breadcrumbs } from "../../../components/Breadcrumbs.js";
import { qk } from "../../../data/queries.js";
import { mutate } from "../../../data/mutations.js";
import { codecs, Link, navigate, useSearchParam } from "../../../router.js";
import { r } from "../../../routes.js";
import {
  NEW_PRODUCT_REPO_FLOW,
  NEW_PRODUCT_SCRATCH_FLOW,
} from "../../../wizard/flows.js";
import { CheckStep, RepoStep } from "../components/NewProductRepo.js";
import {
  NameStep,
  PurposeStep,
  RefusalCallout,
} from "../components/NewProductSteps.js";
import {
  choicesFor,
  isDirty,
  manifestSlugRefusal,
  readDraft,
  repoOf,
  slugFromName,
  slugVerdict,
  slugRefusal,
  type ProductDraft,
  type Via,
  writeDraft,
  DRAFT_KEY,
  suggestSlug,
} from "../model/newProduct.js";

// The pure helpers keep their old home for the callers and tests that import them from here.
export {
  DRAFT_KEY,
  repoOf,
  slugFromName,
  slugVerdict,
  suggestSlug,
  type ProductDraft,
  type Via,
};

const viaCodec = codecs.string();
const stepCodec = codecs.string();

const focusField = (name: string): void => {
  window.setTimeout(
    () =>
      document
        .querySelector<HTMLElement>(`[data-field-name="${name}"]`)
        ?.focus(),
    0,
  );
};

/** A value that follows `value` after `ms` (the slug check and the repository search). */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const TITLES: Record<string, string> = {
  repo: "Which repository?",
  check: "Check it",
  name: "What is it called?",
  purpose: "What is it for?",
};

/**
 * New product (ST-43; FLOWS.md §3): two or three steps. From a GitHub repository: pick it, then
 * check what `.pkey/` says and create. From scratch: name it (the slug follows and is checked),
 * say what it is for, create. Creating lands on Integration, where the product's first moment
 * shows. A refusal stays on the step it belongs to, worded by `errorCopy`.
 *
 * The step is a search parameter, so a refresh resumes; `?via=` still preselects the source for
 * Home's and Products' first-run links. The draft lives in `sessionStorage` (ADMIN.md §5.7).
 */
export function ProductNew(): React.ReactElement {
  const client = useQueryClient();
  const [viaRaw, setViaParam] = useSearchParam("via", viaCodec);
  const [stepRaw, setStepParam] = useSearchParam("step", stepCodec, {
    replace: false,
  });
  const via: Via = viaRaw === "github" ? "github" : "manual";
  const flow =
    via === "github" ? NEW_PRODUCT_REPO_FLOW : NEW_PRODUCT_SCRATCH_FLOW;

  const [draft, setDraft] = React.useState<ProductDraft>(readDraft);
  const [showErrors, setShowErrors] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<{
    error: unknown;
    via: Via;
    slug: string;
  } | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [advancing, setAdvancing] = React.useState(false);
  const created = React.useRef(false);

  React.useEffect(() => {
    if (!created.current) writeDraft(isDirty(draft) ? draft : null);
  }, [draft]);

  const guard = useUnsavedChangesGuard(isDirty(draft), {
    message: "Discard this new product?",
    consequences: ["What you entered is lost. Nothing was created."],
    onDiscard: () => {
      writeDraft(null);
      setDraft(readDraft());
    },
    allow: (hash) => hash.startsWith(r.productNew()) || created.current,
  });

  const update = (patch: Partial<ProductDraft>) => {
    setSubmitError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setName = (name: string) =>
    update(draft.slugEdited ? { name } : { name, slug: slugFromName(name) });
  const setSlug = (slug: string) =>
    update({ slug, slugEdited: slug !== slugFromName(draft.name) });

  const repo = repoOf(draft.repo);
  const slug = draft.slug.trim();
  const local = slugVerdict(slug, new Set());
  const settledSlug = useSettled(slug);
  const slugQuery = useQuery({
    queryKey: qk.slugCheck(settledSlug),
    queryFn: () => api.slugCheck(settledSlug),
    enabled:
      via === "manual" &&
      settledSlug !== "" &&
      slugVerdict(settledSlug, new Set()).kind !== "invalid" &&
      slugVerdict(settledSlug, new Set()).kind !== "reserved",
    staleTime: 15_000,
    retry: false,
  });
  const slugAnswer: SlugCheck | null =
    slugQuery.data && slugQuery.data.slug === slug ? slugQuery.data : null;

  // The first step the draft can stand on: a later step needs what the earlier ones collect.
  const ids = flow.steps.map((s) => s.id);
  const ready: Record<string, boolean> = {
    repo: true,
    check: repo !== null,
    name: true,
    purpose: draft.name.trim() !== "" && slug !== "",
  };
  const requested = ids.includes(stepRaw ?? "") ? stepRaw! : ids[0]!;
  const current = ready[requested] ? requested : ids[0]!;
  const index = ids.indexOf(current);
  const go = (id: string) => setStepParam(id);

  // W22: the repositories the app can read, searched as you type.
  const search = useSettled(repo ? "" : draft.repo.trim());
  const repos = useQuery({
    queryKey: qk.githubRepositories(search),
    queryFn: () => api.githubRepositories(search),
    enabled: via === "github" && current === "repo",
    staleTime: 30_000,
    retry: false,
  });

  // W23: what `.pkey/` says, read when the step opens and again on demand.
  const check = useQuery({
    queryKey: qk.createCheck(repo ?? ""),
    queryFn: () => mutate("checkRepoCreate", draft.repo.trim()),
    enabled: via === "github" && current === "check" && repo !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const checkFailure = check.error
    ? errorCopy(check.error, { thing: "Product", ...(repo ? { repo } : {}) })
    : null;

  const refusal = submitError && submitError.via === via ? submitError : null;
  const worded = refusal
    ? errorCopy(refusal.error, {
        thing: "Product",
        ...(via === "manual" ? { slug: refusal.slug } : repo ? { repo } : {}),
      })
    : null;
  const copy =
    worded && via === "github" && worded.focus === "slug"
      ? manifestSlugRefusal(worded)
      : worded;
  const slugServer =
    copy && via === "manual" && copy.focus === "slug"
      ? slugRefusal(copy, refusal!.slug, new Set())
      : null;

  const nameErrors: { name?: string; slug?: string } = {};
  if (showErrors && draft.name.trim() === "")
    nameErrors.name = "Enter the product's name.";
  if (slugServer) nameErrors.slug = slugServer.message;
  else if (local.kind === "invalid") nameErrors.slug = local.message;
  else if (local.kind === "reserved")
    nameErrors.slug = `${slug} is reserved. Choose another slug.`;
  else if (slugAnswer && slugAnswer.status !== "available")
    nameErrors.slug = slugAnswer.suggestion
      ? `${slug} is ${slugAnswer.status}. Try ${slugAnswer.suggestion}.`
      : slugAnswer.message;
  else if (showErrors && local.kind === "empty")
    nameErrors.slug = "Enter a slug.";
  const suggestion =
    slugServer?.suggestion ??
    (slugAnswer && slugAnswer.status !== "available"
      ? slugAnswer.suggestion
      : null);

  const repoError =
    showErrors && draft.repo.trim() === ""
      ? "Enter the repository."
      : draft.repo.trim() !== "" && !repo && showErrors
        ? "Use owner/repo or the repository's GitHub URL."
        : undefined;

  const finish = (made: string) => {
    created.current = true;
    writeDraft(null);
    navigate(r.integration(made, { created: "1" }));
  };

  const failWith = (err: unknown, at: Via) => {
    setSubmitError({ error: err, via: at, slug });
    setSubmitting(false);
    const f = errorCopy(err).focus;
    if (at === "manual" && f === "slug") {
      go("name");
      focusField("slug");
    }
  };

  const createManual = async (over?: Partial<ProductDraft>) => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const d = { ...draft, ...over };
      const res = await mutate("createManualProduct", {
        slug,
        name: d.name.trim(),
        ...choicesFor(d),
      });
      finish(res.slug);
    } catch (err) {
      failWith(err, "manual");
    }
  };

  const createLinked = async () => {
    if (submitting || !check.data) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await mutate("linkRepo", draft.repo.trim(), {
        manifestDigest: check.data.manifestDigest,
        ...(check.data.releaseWorkflow === true
          ? { trustReleaseWorkflow: true }
          : {}),
      });
      finish(res.slug);
    } catch (err) {
      failWith(err, "github");
    }
  };

  const toCheck = () => {
    if (!repo) {
      setShowErrors(true);
      focusField("repoUrl");
      return;
    }
    go("check");
  };

  const toPurpose = async () => {
    setShowErrors(true);
    if (draft.name.trim() === "") return focusField("name");
    if (local.kind !== "available" && local.kind !== "unknown")
      return focusField("slug");
    setAdvancing(true);
    try {
      const answer = await client.fetchQuery({
        queryKey: qk.slugCheck(slug),
        queryFn: () => api.slugCheck(slug),
        staleTime: 15_000,
      });
      if (answer.status !== "available") return focusField("slug");
    } catch {
      // the server decides on Create
    } finally {
      setAdvancing(false);
    }
    go("purpose");
  };

  const ready2 = check.data?.ready === true && check.data.registeredAs === null;
  const checkReason = check.isPending
    ? "Reading the repository"
    : !ready2
      ? check.data?.registeredAs
        ? "This repository is a product already"
        : "Fix the problems first"
      : undefined;

  const stepDefs = flow.steps.map((s) => ({
    id: s.id,
    label: s.label,
    ...(s.id === "repo" && repo ? { decided: repo } : {}),
    ...(s.id === "name" && draft.name.trim()
      ? { decided: draft.name.trim() }
      : {}),
  }));

  const name = draft.name.trim();
  const primary =
    current === "repo" ? (
      <Button type="submit" form="np-repo">
        {repo ? `Read ${repo}` : "Read repository"}
      </Button>
    ) : current === "check" ? (
      <Button
        onClick={() => void createLinked()}
        loading={submitting}
        disabledReason={checkReason}
      >
        {check.data?.product?.name
          ? `Create ${check.data.product.name}`
          : "Create product"}
      </Button>
    ) : current === "name" ? (
      <Button type="submit" form="np-name" loading={advancing}>
        Continue
      </Button>
    ) : (
      <Button onClick={() => void createManual()} loading={submitting}>
        {name ? `Create ${name}` : "Create product"}
      </Button>
    );

  return (
    <div className="space-y-6" data-template="flow">
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[{ label: "Home", to: r.home() }, { label: "New product" }]}
          />
        }
        title="New product"
        titleAside={
          <Button variant="ghost" size="sm" asChild>
            <Link to={r.products()}>Cancel</Link>
          </Button>
        }
      />
      <Wizard
        centered={false}
        label="New product"
        steps={stepDefs}
        current={current}
        title={TITLES[current]!}
        onStep={go}
        footer={{
          onBack: index > 0 ? () => go(ids[index - 1]!) : undefined,
          later:
            current === "purpose" ? (
              <Button
                variant="ghost"
                disabled={submitting}
                onClick={() => {
                  update({ later: true });
                  void createManual({ later: true });
                }}
              >
                I'll choose later
              </Button>
            ) : undefined,
          primary,
          reason: current === "check" ? checkReason : undefined,
        }}
      >
        <div className="space-y-4">
          {current === "repo" || current === "name" ? (
            <SourceChoice
              via={via}
              onChange={(v) => {
                setShowErrors(false);
                setViaParam(v);
              }}
            />
          ) : null}
          {current === "repo" ? (
            <RepoStep
              value={draft.repo}
              onChange={(v) => update({ repo: v })}
              onSubmit={toCheck}
              error={repoError}
              list={{
                pending: repos.isPending,
                error: repos.isError,
                data: repos.data,
                retry: () => void repos.refetch(),
              }}
            />
          ) : null}
          {current === "check" ? (
            <CheckStep
              repo={repo ?? draft.repo}
              state={{ pending: check.isPending, data: check.data }}
              failure={checkFailure}
              checking={check.isFetching}
              onCheckAgain={() => void check.refetch()}
            />
          ) : null}
          {current === "name" ? (
            <NameStep
              name={draft.name}
              slug={draft.slug}
              onName={setName}
              onSlug={setSlug}
              onSubmit={() => void toPurpose()}
              errors={nameErrors}
              available={slugAnswer?.status === "available"}
              checking={slugQuery.isFetching && slug !== ""}
              suggestion={suggestion}
              onUseSuggestion={(s) => {
                setSlug(s);
                focusField("slug");
              }}
            />
          ) : null}
          {current === "purpose" ? (
            <PurposeStep draft={draft} onChange={update} />
          ) : null}
          {copy && !slugServer ? (
            <RefusalCallout
              copy={copy}
              onCheckAgain={() => {
                setSubmitError(null);
                if (via === "github") void check.refetch();
              }}
            />
          ) : null}
        </div>
      </Wizard>
      {guard.dialog}
    </div>
  );
}

/** From a repository, or from scratch. Home's and Products' links preselect it. */
function SourceChoice({
  via,
  onChange,
}: {
  via: Via;
  onChange: (v: Via) => void;
}): React.ReactElement {
  return (
    <div
      role="group"
      aria-label="Start from"
      className="flex flex-wrap items-center gap-2"
    >
      <Button
        type="button"
        size="sm"
        variant={via === "github" ? "secondary" : "outline"}
        aria-pressed={via === "github"}
        onClick={() => onChange("github")}
      >
        A GitHub repository
      </Button>
      <Button
        type="button"
        size="sm"
        variant={via === "manual" ? "secondary" : "outline"}
        aria-pressed={via === "manual"}
        onClick={() => onChange("manual")}
      >
        From scratch
      </Button>
    </div>
  );
}
