import * as React from "react";
import { isReservedProductSlug } from "@polaris-key/manifest";
import { ArrowRight, Check, ChevronRight, Github, Plus } from "lucide-react";
import {
  type CreateManualProductResult,
  type LinkRepoResult,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { DOCS_LINKS } from "../../../../lib/docsLinks.js";
import {
  errorCopy,
  type ErrorCopy,
  type ErrorFix,
} from "../../../../lib/errorCopy.js";
import { signingBundleOf, slugError } from "../../../../lib/products.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import { Breadcrumbs } from "../../../components/Breadcrumbs.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useProducts } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { codecs, Link, navigate, useSearchParam } from "../../../router.js";
import { r } from "../../../routes.js";
import { storeWelcome, type Welcome } from "../../core/pages/Welcome.js";

/**
 * Where the product's definition comes from. The URL keeps the old `?via=` names, so Home's and
 * Products' first-run links still preselect: `manual` is "Nothing", `github` is "A GitHub
 * repository".
 */
export type Via = "github" | "manual";

/** The draft. Nothing in it is secret, so it may live in `sessionStorage` (ADMIN.md §5.7). */
export interface ProductDraft {
  name: string;
  slug: string;
  /** The operator typed the slug: it no longer follows the name. */
  slugEdited: boolean;
  repo: string;
  maxOfflineDays: number | null;
  deviceLimit: number | null;
}

const EMPTY: ProductDraft = {
  name: "",
  slug: "",
  slugEdited: false,
  repo: "",
  maxOfflineDays: null,
  deviceLimit: null,
};

export const DRAFT_KEY = "pk-product-new";

function readDraft(): ProductDraft {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<ProductDraft>;
    return {
      name: typeof v.name === "string" ? v.name : "",
      slug: typeof v.slug === "string" ? v.slug : "",
      slugEdited: v.slugEdited === true,
      repo: typeof v.repo === "string" ? v.repo : "",
      maxOfflineDays:
        typeof v.maxOfflineDays === "number" ? v.maxOfflineDays : null,
      deviceLimit: typeof v.deviceLimit === "number" ? v.deviceLimit : null,
    };
  } catch {
    return EMPTY;
  }
}

function writeDraft(draft: ProductDraft | null): void {
  try {
    if (draft === null) window.sessionStorage.removeItem(DRAFT_KEY);
    else window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // storage unavailable: the draft lasts as long as the page
  }
}

const isDirty = (d: ProductDraft): boolean =>
  JSON.stringify(d) !== JSON.stringify(EMPTY);

/**
 * The slug a name derives (EXPERIENCE.md S1: "Name first; the slug follows"): lowercase ASCII
 * letters and digits, everything else a single hyphen, no hyphen at either end.
 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `owner/repo` from what the worker's `parseRepoUrl` accepts: an https or git@ GitHub URL, or a
 * bare `owner/repo`. Null when it is neither.
 */
export function repoOf(input: string): string | null {
  const t = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const m =
    t.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i) ??
    t.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  return m && m[1] && m[2] ? `${m[1]}/${m[2]}` : null;
}

/** What the registry says about a slug, before asking the server. */
export type SlugVerdict =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "reserved" }
  | { kind: "taken"; suggestion: string }
  | { kind: "available" }
  /** The registry hasn't loaded: the server decides on Create. */
  | { kind: "unknown" };

/** The server's reservations (P0-14): router paths, admin actions, the system product. */
const isReserved = (slug: string): boolean => isReservedProductSlug(slug);

/** The first free variant of a taken slug: `-app`, then `-2`, `-3`… */
export function suggestSlug(slug: string, taken: ReadonlySet<string>): string {
  const free = (s: string) => !taken.has(s) && !isReserved(s);
  if (free(`${slug}-app`)) return `${slug}-app`;
  for (let i = 2; ; i++) if (free(`${slug}-${i}`)) return `${slug}-${i}`;
}

export function slugVerdict(
  slug: string,
  taken: ReadonlySet<string> | null,
): SlugVerdict {
  const t = slug.trim();
  if (t === "") return { kind: "empty" };
  const invalid = slugError(t);
  if (invalid) return { kind: "invalid", message: invalid };
  if (isReserved(t)) return { kind: "reserved" };
  if (!taken) return { kind: "unknown" };
  if (taken.has(t)) return { kind: "taken", suggestion: suggestSlug(t, taken) };
  return { kind: "available" };
}

/**
 * The field a refusal is about: the one `errorCopy` says to focus, when the source on screen
 * has it. Nothing has a Slug field and no Repository; a linked product has the Repository and
 * takes its slug from `.pkey/product`, so a slug refusal there goes to the callout.
 */
function refusedField(copy: ErrorCopy, via: Via): "slug" | "repoUrl" | null {
  if (via === "manual") return copy.focus === "slug" ? "slug" : null;
  return copy.focus === "repoUrl" ? "repoUrl" : null;
}

/**
 * A slug refusal on the GitHub path, worded as the manifest change it needs: the slug lives in
 * `product.slug` in `.pkey/product`, so there is no free slug to take on this screen. The
 * reason `errorCopy` gives (reserved, malformed) is kept; its "Try …" is not.
 */
function manifestSlugRefusal(copy: ErrorCopy): ErrorCopy {
  const reason = copy.description
    .replace(/\s*(?:Try \S+|Choose another slug)\.$/, "")
    .trim();
  // link-repo registers new products only: a repository already registered resyncs from its
  // product's page, so "taken" may mean this very product.
  const resync = /\btaken$/.test(copy.title)
    ? " If it is this repository's product, resync it from that product instead."
    : "";
  return {
    ...copy,
    description: `${reason ? `${reason} ` : ""}The slug comes from product.slug in .pkey/product: change it there, push, then check again.${resync}`,
    fieldErrors: undefined,
    suggestion: undefined,
    focus: undefined,
    fix: { kind: "check-again", label: "Check again" },
  };
}

/**
 * "tonebox is taken. Try tonebox-app." for a slug the server refused: `errorCopy`'s title and
 * description together. The free slug it offers is checked against the registry here, so a
 * suggestion that is itself taken is swapped for one that is not.
 */
function slugRefusal(
  copy: ErrorCopy,
  slug: string,
  taken: ReadonlySet<string>,
): { message: string; suggestion?: string } {
  const suggestion = copy.suggestion
    ? suggestSlug(slug, new Set([...taken, slug]))
    : undefined;
  const description =
    copy.suggestion && suggestion
      ? copy.description.replace(copy.suggestion, suggestion)
      : copy.description;
  return {
    message: `${copy.title.replace(/[.!]$/, "")}. ${description}`,
    ...(suggestion ? { suggestion } : {}),
  };
}

const viaCodec = codecs.string();

const focusField = (name: string): void => {
  window.setTimeout(
    () =>
      document
        .querySelector<HTMLElement>(`[data-field-name="${name}"]`)
        ?.focus(),
    0,
  );
};

/**
 * New product (EXPERIENCE.md §0.4 S1, C1): one screen, three actions. Start from Nothing or a
 * GitHub repository; for Nothing, the name comes first and the slug follows it, checked against
 * the registry as you type. License defaults sit under Advanced. Enter creates.
 *
 * There is no result page and no toast: a created product opens on its Overview, which shows a
 * one-time welcome with the new signing key (`core/Welcome.tsx`). A refusal stays on this screen,
 * worded by `errorCopy` and placed on the field it is about.
 *
 * "Start from" comes first rather than after the slug (the storyboard's order): a linked product
 * takes its name and slug from `.pkey/product` (link-repo accepts only the repository), so the
 * name and slug fields belong to Nothing alone, and choosing a source must not move fields that
 * sit above the pointer.
 *
 * The GitHub path has no live "App installed · manifest valid" check before Link (AS 1.6, the
 * storyboard's frame 1): that needs a read-only worker probe this screen does not own. Until it
 * exists, the same problems arrive as the refusal of Link, each with its fix beside it.
 */
export function ProductNew(): React.ReactElement {
  const [viaRaw, setViaParam] = useSearchParam("via", viaCodec);
  const via: Via = viaRaw === "github" ? "github" : "manual";

  const [draft, setDraft] = React.useState<ProductDraft>(readDraft);
  const [showErrors, setShowErrors] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(
    () => draft.maxOfflineDays !== null || draft.deviceLimit !== null,
  );
  const [submitError, setSubmitError] = React.useState<{
    error: unknown;
    via: Via;
    slug: string;
  } | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const created = React.useRef(false);

  React.useEffect(() => {
    if (!created.current) writeDraft(isDirty(draft) ? draft : null);
  }, [draft]);

  const products = useProducts();
  const taken = React.useMemo(
    () => (products.data ? new Set(products.data.map((p) => p.slug)) : null),
    [products.data],
  );

  const guard = useUnsavedChangesGuard(isDirty(draft), {
    message: "Discard this new product?",
    consequences: ["What you entered is lost. Nothing was created."],
    onDiscard: () => {
      writeDraft(null);
      setDraft(EMPTY);
    },
    allow: (hash) => hash.startsWith(r.productNew()) || created.current,
  });

  const update = (patch: Partial<ProductDraft>) => {
    setSubmitError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const setName = (name: string) =>
    update(draft.slugEdited ? { name } : { name, slug: slugFromName(name) });

  // Typing the slug the name derives (or one back to it) makes it follow the name again.
  const setSlug = (slug: string) =>
    update({ slug, slugEdited: slug !== slugFromName(draft.name) });

  const verdict = slugVerdict(draft.slug, taken);
  const repo = repoOf(draft.repo);

  // Client checks; a failing one keeps Create from reaching the server.
  const fieldErrors: Record<string, string> = {};
  if (via === "manual") {
    if (draft.name.trim() === "")
      fieldErrors.name = "Enter the product's name.";
    if (verdict.kind === "empty") fieldErrors.slug = "Enter a slug.";
    if (verdict.kind === "invalid") fieldErrors.slug = verdict.message;
    if (verdict.kind === "reserved")
      fieldErrors.slug = `${draft.slug.trim()} is reserved. Choose another slug.`;
    if (verdict.kind === "taken")
      fieldErrors.slug = `${draft.slug.trim()} is taken. Try ${verdict.suggestion}.`;
    const days = draft.maxOfflineDays;
    // The worker's cap (WriteChecks.offlineDays): checked here so it lands on the field.
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365))
      fieldErrors.maxOfflineDays =
        "Use a whole number from 1 to 365, or leave it blank.";
    const devices = draft.deviceLimit;
    if (devices !== null && (!Number.isInteger(devices) || devices < 1))
      fieldErrors.deviceLimit =
        "Use a whole number of 1 or more, or leave it blank.";
  } else if (draft.repo.trim() === "") {
    fieldErrors.repoUrl = "Enter the repository.";
  } else if (!repo) {
    fieldErrors.repoUrl = "Use owner/repo or the repository's GitHub URL.";
  }

  // The slug's own state shows as you type (taken, reserved, malformed); "Enter a…" waits for a
  // Create attempt, so an empty form opens quiet.
  const liveSlugError =
    verdict.kind === "invalid" ||
    verdict.kind === "reserved" ||
    verdict.kind === "taken"
      ? fieldErrors.slug
      : undefined;

  // A refusal belongs to the source it was made for; switching source sets it aside.
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
  const serverField = copy ? refusedField(copy, via) : null;
  const slugServer =
    copy && serverField === "slug"
      ? slugRefusal(copy, refusal!.slug, taken ?? new Set())
      : null;

  const errorFor = (name: string): string | undefined => {
    if (name === "slug" && slugServer) return slugServer.message;
    if (copy && serverField === name) return copy.description;
    if (name === "slug" && liveSlugError) return liveSlugError;
    return showErrors ? fieldErrors[name] : undefined;
  };

  const suggestion =
    slugServer?.suggestion ??
    (verdict.kind === "taken" ? verdict.suggestion : null);

  const finish = (welcome: Welcome) => {
    created.current = true;
    writeDraft(null);
    storeWelcome(welcome);
    navigate(r.overview(welcome.slug));
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (submitting) return;
    const problems = Object.keys(fieldErrors);
    if (problems.length > 0) {
      setShowErrors(true);
      const first = problems[0]!;
      if (first === "maxOfflineDays" || first === "deviceLimit")
        setAdvanced(true);
      focusField(first);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const slug = draft.slug.trim();
    try {
      if (via === "github") {
        const res: LinkRepoResult = await mutate("linkRepo", draft.repo.trim());
        const bundle = signingBundleOf(res);
        finish({
          slug: res.slug,
          name: res.product?.name ?? res.slug,
          kid: bundle.kid ?? res.kid,
          publicKey: bundle.publicKey,
          ...(repo ? { repo } : {}),
          remainingSecrets: res.remainingSecrets ?? [],
        });
      } else {
        const res: CreateManualProductResult = await mutate(
          "createManualProduct",
          {
            slug,
            name: draft.name.trim(),
            defaultMaxOfflineDays: draft.maxOfflineDays ?? undefined,
            defaultDeviceLimit: draft.deviceLimit ?? undefined,
          },
        );
        const bundle = signingBundleOf(res);
        finish({
          slug: res.slug,
          name: res.product?.name ?? draft.name.trim(),
          kid: bundle.kid ?? res.kid,
          publicKey: bundle.publicKey,
          remainingSecrets: [],
        });
      }
    } catch (err) {
      setSubmitError({ error: err, via, slug });
      setSubmitting(false);
      const f = refusedField(errorCopy(err), via);
      if (f) focusField(f);
    }
  };

  const createLabel =
    via === "github"
      ? "Link repository"
      : draft.name.trim()
        ? `Create ${draft.name.trim()}`
        : "Create product";

  return (
    <div className="space-y-6" data-template="flow">
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[
              { label: "Products", to: r.products() },
              { label: "New product" },
            ]}
          />
        }
        title="New product"
      />
      <form
        noValidate
        aria-label="New product"
        onSubmit={(e) => void submit(e)}
        className="max-w-2xl space-y-5 rounded-xl border border-border bg-surface-raised p-4 sm:p-6"
      >
        <FormField
          name="via"
          label="Start from"
          group
          value={via}
          onChange={(v: Via) => {
            setShowErrors(false);
            setViaParam(v);
          }}
        >
          {(field) => (
            <RadioCards<Via>
              {...field}
              id="product-new-via"
              options={[
                {
                  value: "manual",
                  label: "Nothing",
                  icon: <Plus aria-hidden className="size-4" />,
                  description:
                    "A name and a slug; set up the rest from Overview",
                },
                {
                  value: "github",
                  label: "A GitHub repository",
                  icon: <Github aria-hidden className="size-4" />,
                  description: "Reads .pkey/ and publishes from CI",
                },
              ]}
            />
          )}
        </FormField>

        {via === "manual" ? (
          <>
            <FormField
              name="name"
              label="Name"
              value={draft.name}
              onChange={setName}
              error={errorFor("name")}
              announceError
            >
              {(field) => (
                <Input
                  {...field}
                  data-field-name="name"
                  onChange={(e) => field.onChange(e.target.value)}
                  placeholder="Tonebox"
                  autoComplete="off"
                />
              )}
            </FormField>
            <FormField
              name="slug"
              label="Slug"
              labelAside={
                <span className="text-xs text-fg-subtle">
                  Permanent · used in keys and URLs
                </span>
              }
              help={
                verdict.kind === "available" && !errorFor("slug") ? (
                  <span className="inline-flex items-center gap-1">
                    <Check aria-hidden className="size-3.5" />
                    Available
                  </span>
                ) : undefined
              }
              value={draft.slug}
              onChange={setSlug}
              error={errorFor("slug")}
              announceError
            >
              {(field) => (
                <div className="flex items-center gap-2">
                  <Input
                    {...field}
                    data-field-name="slug"
                    onChange={(e) => field.onChange(e.target.value)}
                    placeholder="tonebox"
                    autoComplete="off"
                    spellCheck={false}
                    mono
                    className="min-w-0 flex-1"
                  />
                  {suggestion ? (
                    <Button
                      variant="outline"
                      className="shrink-0"
                      onClick={() => {
                        setSlug(suggestion);
                        focusField("slug");
                      }}
                    >
                      Use {suggestion}
                    </Button>
                  ) : null}
                </div>
              )}
            </FormField>
          </>
        ) : (
          <FormField
            name="repoUrl"
            label="Repository"
            help={
              repo && !errorFor("repoUrl")
                ? `Polaris Key reads .pkey/ on ${repo}'s default branch when you link it.`
                : undefined
            }
            value={draft.repo}
            onChange={(v: string) => update({ repo: v })}
            error={errorFor("repoUrl")}
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
        )}

        {copy?.fix && serverField ? (
          <RefusalFix fix={copy.fix} onCheckAgain={() => void submit()} />
        ) : null}

        {via === "manual" ? (
          <div>
            <button
              type="button"
              aria-expanded={advanced}
              aria-controls="product-new-advanced"
              onClick={() => setAdvanced((a) => !a)}
              className="inline-flex items-center gap-1 rounded-sm text-sm text-fg-muted hover:text-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-4 transition-transform motion-reduce:transition-none",
                  advanced && "rotate-90",
                )}
              />
              Advanced: license defaults
            </button>
            <div
              id="product-new-advanced"
              hidden={!advanced}
              className="mt-4 grid gap-5 sm:grid-cols-2"
            >
              <FormField
                name="maxOfflineDays"
                label="Offline grace"
                optional
                help="Blank uses the platform default."
                value={draft.maxOfflineDays}
                onChange={(v: number | null) => update({ maxOfflineDays: v })}
                error={errorFor("maxOfflineDays")}
                announceError
              >
                {(field) => (
                  <NumberInput
                    {...field}
                    data-field-name="maxOfflineDays"
                    nullable
                    integer
                    min={1}
                    max={365}
                    unit="days"
                    placeholder="14"
                  />
                )}
              </FormField>
              <FormField
                name="deviceLimit"
                label="Device limit"
                optional
                help="Blank uses the platform default."
                value={draft.deviceLimit}
                onChange={(v: number | null) => update({ deviceLimit: v })}
                error={errorFor("deviceLimit")}
                announceError
              >
                {(field) => (
                  <NumberInput
                    {...field}
                    data-field-name="deviceLimit"
                    nullable
                    integer
                    min={1}
                    unit="devices"
                    placeholder="3"
                  />
                )}
              </FormField>
            </div>
          </div>
        ) : null}

        {copy && !serverField ? (
          <RefusalCallout copy={copy} onCheckAgain={() => void submit()} />
        ) : null}

        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <Button variant="ghost" asChild>
            <Link to={r.products()}>Cancel</Link>
          </Button>
          <Button type="submit" loading={submitting}>
            {createLabel}
          </Button>
        </div>
      </form>
      {guard.dialog}
    </div>
  );
}

/**
 * A refusal no single field owns: a manifest the server would not accept, GitHub access, service
 * settings that don't fit together. Every problem is listed, so they can be fixed in one commit.
 */
function RefusalCallout({
  copy,
  onCheckAgain,
}: {
  copy: ErrorCopy;
  onCheckAgain: () => void;
}): React.ReactElement {
  const lines = copy.problems?.length
    ? copy.problems.map((p) => ({
        key: `${p.file}${p.path}${p.message}`,
        text: (
          <>
            <span className="font-mono text-xs">
              {p.file}
              {p.path ? ` ${p.path}` : ""}
            </span>
            {": "}
            {p.message}
          </>
        ),
      }))
    : [...(copy.fieldErrors ?? []), ...(copy.lines ?? [])].map((l) => ({
        key: l,
        text: <>{l}</>,
      }));
  return (
    <Callout tone="danger" title={copy.title} live>
      <p>{copy.description}</p>
      {lines.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {lines.map((l) => (
            <li key={l.key}>{l.text}</li>
          ))}
        </ul>
      ) : null}
      {copy.fix ? (
        <div className="mt-3">
          <RefusalFix fix={copy.fix} onCheckAgain={onCheckAgain} />
        </div>
      ) : null}
    </Callout>
  );
}

/**
 * The fix a refusal offers beside its words (EXPERIENCE.md §0.3 "Inline fixes on errors"): the
 * GitHub App install guide, or "Check again" once a fixed manifest is pushed, which links the
 * repository again. Shown under the field a refusal sits on, or inside the callout.
 */
function RefusalFix({
  fix,
  onCheckAgain,
}: {
  fix: ErrorFix;
  onCheckAgain: () => void;
}): React.ReactElement {
  if (fix.kind === "check-again")
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onCheckAgain}
      >
        {fix.label}
      </Button>
    );
  return (
    <a
      href={DOCS_LINKS.createProduct}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
    >
      {fix.label}
      <ArrowRight aria-hidden className="size-3.5" />
    </a>
  );
}
