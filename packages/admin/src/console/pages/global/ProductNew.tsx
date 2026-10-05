import * as React from "react";
import { ArrowLeft, ArrowRight, Github, PenLine } from "lucide-react";
import type {
  CreateManualProductResult,
  LinkRepoResult,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import {
  parseSchemaField,
  signingBundleOf,
  slugError,
} from "../../../lib/products.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { KeyDisplay } from "../../../ui/KeyDisplay.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { RadioCards } from "../../../ui/RadioCards.js";
import { Stepper, type Step } from "../../../ui/Stepper.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { PageHeader } from "../../components/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { codecs, Link, navigate, useSearchParam } from "../../router.js";
import { r } from "../../routes.js";
import { Panel, STRETCH_CELL } from "../../templates/Dashboard.js";

export type Via = "github" | "manual";
type StepId =
  | "source"
  | "repository"
  | "basics"
  | "catalog"
  | "defaults"
  | "review"
  | "result";

const STEPS: Record<Via, Step[]> = {
  github: [
    { id: "source", label: "Source" },
    { id: "repository", label: "Repository" },
    { id: "review", label: "Review" },
  ],
  manual: [
    { id: "source", label: "Source" },
    { id: "basics", label: "Basics" },
    { id: "catalog", label: "Catalog" },
    { id: "defaults", label: "Defaults" },
    { id: "review", label: "Review" },
  ],
};

/** The draft. Nothing in it is secret, so it may live in `sessionStorage` (ADMIN.md §5.7). */
export interface ProductDraft {
  repoUrl: string;
  slug: string;
  name: string;
  adminGroup: string;
  schema: string;
  maxOfflineDays: number | null;
  deviceLimit: number | null;
}

const EMPTY: ProductDraft = {
  repoUrl: "",
  slug: "",
  name: "",
  adminGroup: "",
  schema: "",
  maxOfflineDays: null,
  deviceLimit: null,
};

/** What the result step shows: public material and names only, never a secret value. */
interface Created {
  via: Via;
  slug: string;
  name: string;
  kid: string;
  publicKey: string | null;
  remainingSecrets: string[];
}

export const DRAFT_KEY = "pk-product-new";

interface Stored {
  draft: ProductDraft;
  created: Created | null;
}

function readStored(): Stored {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return { draft: EMPTY, created: null };
    const v = JSON.parse(raw) as Partial<Stored>;
    return {
      draft: { ...EMPTY, ...(v.draft ?? {}) },
      created: v.created ?? null,
    };
  } catch {
    return { draft: EMPTY, created: null };
  }
}

function writeStored(value: Stored | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(DRAFT_KEY);
    else window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(value));
  } catch {
    // storage unavailable: the draft lasts as long as the page
  }
}

const isDirtyDraft = (d: ProductDraft): boolean =>
  JSON.stringify(d) !== JSON.stringify(EMPTY);

const GITHUB_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+?\/?$/;

/** Field errors for one step. Empty: the step is complete. */
export function stepErrors(
  step: StepId,
  draft: ProductDraft,
): Record<string, string> {
  const e: Record<string, string> = {};
  if (step === "repository") {
    const url = draft.repoUrl.trim();
    if (url === "") e.repoUrl = "Enter the repository's URL.";
    else if (!GITHUB_URL.test(url))
      e.repoUrl = "Use the repository's https://github.com/<owner>/<repo> URL.";
  }
  if (step === "basics") {
    const s = slugError(draft.slug);
    if (s) e.slug = s;
  }
  if (step === "catalog") {
    const parsed = parseSchemaField(draft.schema);
    if (parsed.error) e.schema = parsed.error;
  }
  if (step === "defaults") {
    for (const key of ["maxOfflineDays", "deviceLimit"] as const) {
      const v = draft[key];
      if (v !== null && (!Number.isInteger(v) || v < 1)) {
        e[key] = "Use a whole number of 1 or more, or leave it blank.";
      }
    }
  }
  return e;
}

const viaCodec = codecs.string();
const stepCodec = codecs.string();

/**
 * New product (ADMIN.md §2.3, T6): a full-page wizard instead of tabs inside tabs in a dialog
 * (PRD-7). The source comes first (`?via=github|manual`, preselected from Home's first-run
 * actions, DSH-6), the step is in the URL (`?step=`), the draft survives a refresh in
 * `sessionStorage`, Back keeps values, and leaving with a draft asks first.
 *
 * - The compatibility window is not asked for: it lives in Update → Feed now (PRD-7).
 * - A Review step comes before the irreversible create, and the create button cannot be pressed
 *   twice (PRD-10). A refusal is worded by `errorCopy`, inline, with every field the server named
 *   (PRD-12, and the aggregated manifest errors of link-repo).
 * - The result names the signing key with a copy button (PRD-9) and offers the next steps: Open
 *   product, and Set the missing secrets in Keys & secrets (PRD-8).
 */
export function ProductNew(): React.ReactElement {
  const [viaRaw, setViaParam] = useSearchParam("via", viaCodec);
  const [stepRaw, setStepParam] = useSearchParam("step", stepCodec);
  const via: Via | null =
    viaRaw === "github" || viaRaw === "manual" ? viaRaw : null;

  const [stored] = React.useState(readStored);
  const [draft, setDraft] = React.useState<ProductDraft>(stored.draft);
  const [created, setCreated] = React.useState<Created | null>(stored.created);
  const [shown, setShown] = React.useState<Set<StepId>>(new Set());
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    writeStored(isDirtyDraft(draft) || created ? { draft, created } : null);
  }, [draft, created]);

  const steps = via ? STEPS[via] : STEPS.manual.slice(0, 1);
  const ids = steps.map((s) => s.id as StepId);

  // The step the URL may show: the asked one, unless an earlier step is still incomplete.
  const firstIncomplete = ids.find(
    (id) => id !== "review" && Object.keys(stepErrors(id, draft)).length > 0,
  );
  let step: StepId;
  if (created) step = "result";
  else if (!via) step = "source";
  else {
    const asked = (ids as string[]).includes(stepRaw)
      ? (stepRaw as StepId)
      : "source";
    const askedIndex = ids.indexOf(asked);
    const blockIndex = firstIncomplete ? ids.indexOf(firstIncomplete) : -1;
    step =
      blockIndex !== -1 && blockIndex < askedIndex ? firstIncomplete! : asked;
  }

  // Keep the URL honest about the step actually shown.
  React.useEffect(() => {
    const want = step === "source" ? "" : step;
    if (stepRaw !== want) setStepParam(want);
  }, [step, stepRaw, setStepParam]);

  const guard = useUnsavedChangesGuard(isDirtyDraft(draft) && !created, {
    message: "Discard this new product?",
    consequences: [
      "What you entered in this wizard is lost. Nothing was created.",
    ],
    onDiscard: () => {
      writeStored(null);
      setDraft(EMPTY);
    },
    allow: (hash) => hash.startsWith(r.productNew()),
  });

  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const errors = shown.has(step) ? stepErrors(step, draft) : {};

  const goTo = (id: StepId) => {
    setSubmitError(null);
    setStepParam(id === "source" ? "" : id);
  };

  const next = () => {
    if (!via) return;
    const problems = stepErrors(step, draft);
    if (Object.keys(problems).length > 0) {
      setShown((s) => new Set(s).add(step));
      const first = Object.keys(problems)[0];
      window.setTimeout(
        () =>
          document
            .querySelector<HTMLElement>(`[data-field-name="${first}"]`)
            ?.focus(),
        0,
      );
      return;
    }
    const i = ids.indexOf(step);
    if (i < ids.length - 1) goTo(ids[i + 1]!);
  };

  const back = () => {
    const i = ids.indexOf(step);
    if (i > 0) goTo(ids[i - 1]!);
  };

  const submit = async () => {
    if (!via || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (via === "github") {
        const res: LinkRepoResult = await mutate(
          "linkRepo",
          draft.repoUrl.trim(),
        );
        const bundle = signingBundleOf(res);
        setCreated({
          via,
          slug: res.slug,
          name: res.product?.name ?? res.slug,
          kid: bundle.kid ?? res.kid,
          publicKey: bundle.publicKey,
          remainingSecrets: res.remainingSecrets ?? [],
        });
        toast.success("Repository linked", {
          description: `${res.slug} is registered.`,
        });
      } else {
        const res: CreateManualProductResult = await mutate(
          "createManualProduct",
          {
            slug: draft.slug.trim(),
            name: draft.name.trim() || undefined,
            schema: parseSchemaField(draft.schema).value,
            defaultMaxOfflineDays: draft.maxOfflineDays ?? undefined,
            defaultDeviceLimit: draft.deviceLimit ?? undefined,
            adminGroup: draft.adminGroup.trim() || undefined,
          },
        );
        const bundle = signingBundleOf(res);
        setCreated({
          via,
          slug: res.slug,
          name: res.product?.name ?? (draft.name.trim() || res.slug),
          kid: bundle.kid ?? res.kid,
          publicKey: bundle.publicKey,
          remainingSecrets: [],
        });
        toast.success("Product created", {
          description: `${res.slug} is registered.`,
        });
      }
      setDraft(EMPTY);
    } catch (e) {
      setSubmitError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const startOver = () => {
    writeStored(null);
    setCreated(null);
    setDraft(EMPTY);
    setShown(new Set());
    setViaParam("");
  };

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
      {step !== "result" ? (
        <Stepper
          label="New product steps"
          steps={steps}
          current={step}
          onStep={(id) => goTo(id as StepId)}
        />
      ) : null}

      {/* The step card and the aside share a row and both stretch to its height; the actions get
          a row of their own under the step card, so the two cards share top and bottom edges. On
          a phone the order is step, actions, aside. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className={cn(STRETCH_CELL, "lg:col-span-2 lg:row-start-1")}>
          <section
            aria-labelledby="wizard-step-title"
            className="rounded-lg border border-border bg-surface-raised p-4 sm:p-6"
          >
            {step === "source" ? (
              <SourceStep
                via={via}
                onChange={(v) => {
                  setSubmitError(null);
                  setViaParam(v);
                }}
              />
            ) : null}
            {step === "repository" ? (
              <RepositoryStep draft={draft} set={set} errors={errors} />
            ) : null}
            {step === "basics" ? (
              <BasicsStep draft={draft} set={set} errors={errors} />
            ) : null}
            {step === "catalog" ? (
              <CatalogStep draft={draft} set={set} errors={errors} />
            ) : null}
            {step === "defaults" ? (
              <DefaultsStep draft={draft} set={set} errors={errors} />
            ) : null}
            {step === "review" && via ? (
              <ReviewStep via={via} draft={draft} error={submitError} />
            ) : null}
            {step === "result" && created ? (
              <ResultStep created={created} />
            ) : null}
          </section>
        </div>
        <div className="min-w-0 lg:col-span-2 lg:row-start-2">
          {step === "result" && created ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={startOver}>
                Register another
              </Button>
              {created.remainingSecrets.length > 0 ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    writeStored(null);
                    navigate(r.keys(created.slug));
                  }}
                >
                  {created.remainingSecrets.length === 1
                    ? "Set 1 missing secret"
                    : `Set ${created.remainingSecrets.length} missing secrets`}
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  writeStored(null);
                  navigate(r.overview(created.slug));
                }}
              >
                Open product
              </Button>
            </div>
          ) : (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="ghost" asChild>
                <Link to={r.products()}>Cancel</Link>
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                {step !== "source" ? (
                  <Button
                    variant="outline"
                    iconStart={<ArrowLeft aria-hidden />}
                    onClick={back}
                    disabled={submitting}
                  >
                    Back
                  </Button>
                ) : null}
                {step === "review" ? (
                  <Button loading={submitting} onClick={() => void submit()}>
                    {via === "github" ? "Link repository" : "Create product"}
                  </Button>
                ) : (
                  <Button
                    iconEnd={<ArrowRight aria-hidden />}
                    disabledReason={
                      step === "source" && !via
                        ? "Choose where the product comes from first."
                        : undefined
                    }
                    onClick={next}
                  >
                    Continue
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
        <Aside via={via} step={step} />
      </div>
      {guard.dialog}
    </div>
  );
}

interface StepProps {
  draft: ProductDraft;
  set: <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => void;
  errors: Record<string, string>;
}

function StepTitle({
  children,
  description,
}: {
  children: React.ReactNode;
  description?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-5 space-y-1">
      <h2 id="wizard-step-title" className="text-lg font-bold text-fg-strong">
        {children}
      </h2>
      {description ? (
        <p className="text-sm text-fg-muted">{description}</p>
      ) : null}
    </div>
  );
}

function SourceStep({
  via,
  onChange,
}: {
  via: Via | null;
  onChange: (via: Via) => void;
}): React.ReactElement {
  return (
    <>
      <StepTitle description="Where the product's definition lives. You can link a repository to a manual product later.">
        Source
      </StepTitle>
      <RadioCards<Via>
        aria-labelledby="wizard-step-title"
        value={via}
        onChange={onChange}
        options={[
          {
            value: "github",
            label: "Link a GitHub repository",
            icon: <Github aria-hidden className="size-4" />,
            description:
              "The Polaris Key GitHub App reads the repository's .pkey/ directory: services, catalog, tiers, profiles, sign-in and releases, all from the manifest.",
          },
          {
            value: "manual",
            label: "Start manually",
            icon: <PenLine aria-hidden className="size-4" />,
            description:
              "A slug, a name and optional catalog and license defaults. For experiments before release syncing, sign-in or provisioning matter.",
          },
        ]}
      />
    </>
  );
}

function RepositoryStep({ draft, set, errors }: StepProps): React.ReactElement {
  return (
    <>
      <StepTitle description="The repository must have a .pkey/ directory on its default branch.">
        Repository
      </StepTitle>
      <FormField
        name="repoUrl"
        label="Repository URL"
        required
        help="For example https://github.com/acme/my-product."
        value={draft.repoUrl}
        onChange={(v: string) => set("repoUrl", v)}
        error={errors.repoUrl}
        announceError
      >
        {(field) => (
          <Input
            {...field}
            data-field-name="repoUrl"
            onChange={(e) => field.onChange(e.target.value)}
            placeholder="https://github.com/acme/my-product"
            autoComplete="off"
            spellCheck={false}
            mono
          />
        )}
      </FormField>
    </>
  );
}

function BasicsStep({ draft, set, errors }: StepProps): React.ReactElement {
  return (
    <>
      <StepTitle description="The slug is permanent: it is in every URL and SDK configuration of the product.">
        Basics
      </StepTitle>
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          name="slug"
          label="Slug"
          required
          help="Lowercase letters, digits and hyphens, for example djdl."
          value={draft.slug}
          onChange={(v: string) => set("slug", v)}
          error={errors.slug}
          announceError
        >
          {(field) => (
            <Input
              {...field}
              data-field-name="slug"
              onChange={(e) => field.onChange(e.target.value)}
              placeholder="my-product"
              autoComplete="off"
              spellCheck={false}
              mono
            />
          )}
        </FormField>
        <FormField
          name="name"
          label="Name"
          help="Shown in the console and the customer portal. Blank uses the slug."
          value={draft.name}
          onChange={(v: string) => set("name", v)}
        >
          {(field) => (
            <Input
              {...field}
              onChange={(e) => field.onChange(e.target.value)}
              placeholder="My Product"
            />
          )}
        </FormField>
        <FormField
          name="adminGroup"
          label="Admin group (metadata only)"
          help="A label recorded on the product. It grants no access: the console authorizes on PLATFORM_ADMIN_GROUP alone."
          value={draft.adminGroup}
          onChange={(v: string) => set("adminGroup", v)}
          className="sm:col-span-2"
        >
          {(field) => (
            <Input
              {...field}
              onChange={(e) => field.onChange(e.target.value)}
              placeholder="pkey-my-product-admins"
              autoComplete="off"
            />
          )}
        </FormField>
      </div>
    </>
  );
}

function CatalogStep({ draft, set, errors }: StepProps): React.ReactElement {
  return (
    <>
      <StepTitle description="Optional. The product starts with an empty catalog when you leave this blank; publish one later from Config → Catalog.">
        Catalog
      </StepTitle>
      <FormField
        name="schema"
        label="Catalog (JSON or YAML)"
        help="The product's config catalog: its keys, kinds and defaults."
        value={draft.schema}
        onChange={(v: string) => set("schema", v)}
        error={errors.schema}
        announceError
      >
        {(field) => (
          <Textarea
            {...field}
            data-field-name="schema"
            onChange={(e) => field.onChange(e.target.value)}
            rows={10}
            mono
            spellCheck={false}
            placeholder={'{\n  "schemaVersion": 2,\n  "entries": []\n}'}
          />
        )}
      </FormField>
    </>
  );
}

function DefaultsStep({ draft, set, errors }: StepProps): React.ReactElement {
  return (
    <>
      <StepTitle description="Optional. What a new license gets unless its tier or the license itself says otherwise. Blank uses the platform default.">
        License defaults
      </StepTitle>
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          name="maxOfflineDays"
          label="Offline grace"
          help="Days a device keeps working without reaching Polaris Key."
          value={draft.maxOfflineDays}
          onChange={(v: number | null) => set("maxOfflineDays", v)}
          error={errors.maxOfflineDays}
          announceError
        >
          {(field) => (
            <NumberInput
              {...field}
              data-field-name="maxOfflineDays"
              nullable
              integer
              min={1}
              unit="days"
              placeholder="14"
            />
          )}
        </FormField>
        <FormField
          name="deviceLimit"
          label="Device limit"
          help="Devices one license may activate at a time."
          value={draft.deviceLimit}
          onChange={(v: number | null) => set("deviceLimit", v)}
          error={errors.deviceLimit}
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
    </>
  );
}

function ReviewStep({
  via,
  draft,
  error,
}: {
  via: Via;
  draft: ProductDraft;
  error: unknown;
}): React.ReactElement {
  const copy = error ? errorCopy(error, { thing: "Product" }) : null;
  const blank = <span className="text-fg-muted">Not set</span>;
  return (
    <>
      <StepTitle description="Check the details. The product is created when you confirm, with a new signing key.">
        Review
      </StepTitle>
      {via === "github" ? (
        <DescriptionList
          items={[
            { term: "Source", detail: "GitHub repository" },
            {
              term: "Repository",
              detail: (
                <span className="break-all font-mono text-xs">
                  {draft.repoUrl.trim()}
                </span>
              ),
            },
            {
              term: "Slug and settings",
              detail: "From the repository's .pkey/product manifest",
            },
          ]}
        />
      ) : (
        <DescriptionList
          columns={2}
          items={[
            { term: "Source", detail: "Manual" },
            {
              term: "Slug",
              detail: <span className="font-mono">{draft.slug.trim()}</span>,
            },
            { term: "Name", detail: draft.name.trim() || draft.slug.trim() },
            {
              term: "Admin group",
              detail: draft.adminGroup.trim() || blank,
            },
            {
              term: "Catalog",
              detail: draft.schema.trim() ? "Provided" : "Empty catalog",
            },
            {
              term: "Offline grace",
              detail:
                draft.maxOfflineDays !== null
                  ? `${draft.maxOfflineDays} days`
                  : "Platform default",
            },
            {
              term: "Device limit",
              detail:
                draft.deviceLimit !== null
                  ? String(draft.deviceLimit)
                  : "Platform default",
            },
          ]}
        />
      )}
      {copy ? (
        <div className="mt-5">
          <Callout tone="danger" title={copy.title} live>
            <p>{copy.description}</p>
            {copy.fieldErrors?.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {copy.fieldErrors.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : null}
            {copy.lines?.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {copy.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : null}
          </Callout>
        </div>
      ) : null}
    </>
  );
}

function ResultStep({ created }: { created: Created }): React.ReactElement {
  return (
    <>
      <StepTitle
        description={
          created.via === "github"
            ? "The repository is linked and the product is registered from its manifest."
            : "The product is registered with a new signing key and an empty release history."
        }
      >
        {created.name} is registered
      </StepTitle>
      <div className="space-y-5">
        <KeyDisplay
          kind="signing"
          label="Signing key"
          kid={created.kid}
          status="active"
          value={created.publicKey ?? undefined}
        />
        <p className="text-sm text-fg-muted">
          Give this key to your SDK trust configuration and release tooling. The
          private key never leaves the platform; the public key is also in the
          product's JWKS.
        </p>
        {created.via === "github" ? (
          <Callout
            tone={created.remainingSecrets.length ? "warning" : "success"}
            title={
              created.remainingSecrets.length
                ? "Secrets the manifest declares but nobody has set"
                : "Every secret the manifest declares is set"
            }
          >
            {created.remainingSecrets.length ? (
              <>
                <ul className="mt-1 space-y-1">
                  {created.remainingSecrets.map((s) => (
                    <li key={s} className="font-mono text-xs">
                      {s}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">
                  Set each one in Keys &amp; secrets. Values are write-only and
                  never shown again. Install the Polaris Key GitHub App on the
                  repository too, so publishing and resync can authenticate.
                </p>
              </>
            ) : (
              <p>
                Install the Polaris Key GitHub App on the repository, so
                publishing and resync can authenticate.
              </p>
            )}
          </Callout>
        ) : null}
      </div>
    </>
  );
}

function Aside({
  via,
  step,
}: {
  via: Via | null;
  step: StepId;
}): React.ReactElement {
  const text =
    step === "result"
      ? "Next: open the product's Overview for its setup checklist, and set any secrets it still needs."
      : via === "github"
        ? "Polaris Key validates the manifest before anything is created. A refusal lists every problem it found, so you can fix them in one commit."
        : via === "manual"
          ? "Creating the product mints its Ed25519 signing key and an active catalog in one step. A product never exists without a usable signing key."
          : "Most products are linked from a repository: the manifest is reviewed in pull requests and resync keeps the console in step with it.";
  return (
    <aside className={cn(STRETCH_CELL, "lg:col-start-3 lg:row-start-1")}>
      <Panel title="What happens next" headingLevel={2}>
        <p className="text-sm text-fg">{text}</p>
        <p className="mt-3 text-sm">
          <a
            href="/docs/admin/products/"
            target="_blank"
            rel="noreferrer"
            className="text-accent-fg underline underline-offset-4"
          >
            Registering a product (docs)
          </a>
        </p>
      </Panel>
    </aside>
  );
}
