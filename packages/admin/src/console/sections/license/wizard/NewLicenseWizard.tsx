/**
 * **New license** (LX-29; S-24 §8, FLOWS.md C-17): a five-step drawer on the wizard kit (ST-39) over
 * the Licenses list, then the result in place. The URL is `?setup=new-license&step=<id>`; the draft
 * is in `sessionStorage` per product. One assigned licence (optionally emailed), one floating key or
 * a batch (atomic on the Worker); nothing here learns whether an email has an account (D4).
 * Delivery is skipped when it has one answer. The key is shown once, from the create response;
 * leaving asks only when this screen holds the only copy. The first licence is a moment (MO-11).
 */

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { ApiError } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { momentSeen } from "../../../../ui/motion/index.js";
import { FormStep, Wizard } from "../../../../ui/wizard/index.js";
import { NEW_LICENSE_FLOW } from "../../../wizard/flows.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { momentKey } from "../../../components/Moment.js";
import { navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { focusWhenReady } from "../../../shell/palette/focus.js";
import {
  effectivePolicy,
  useHasLicenses,
  useInvitations,
  useManualChannels,
  useTiers,
} from "../components/shared.js";
import { ErrorBlock } from "../components/InlineFailure.js";
import { useRetrySend } from "./useRetrySend.js";
import {
  DoneBody,
  doneTitle,
  needsKeep,
  singleResult,
  type Result,
} from "./DoneStep.js";
import {
  EMPTY,
  FIELD_STEP,
  batchBody,
  createBody,
  deliveryOf,
  deliverySkipped,
  dirty as isDirty,
  firstInvalid,
  invitesPerson,
  isBatch,
  loadDraft,
  saveDraft,
  stepAfter,
  stepBefore,
  validateHolder,
  validateLimits,
  type Draft,
  type Errors,
  type StepId,
} from "./draft.js";
import {
  csvRows,
  primaryLabel,
  reviewRows,
  summaryOf,
  willItems,
} from "./review.js";
import { HolderStep, LimitsStep, TierStep, tierName } from "./steps.js";
import { DeliveryStep, ReviewStep } from "./stepsDelivery.js";
import {
  STEP_TITLES,
  focusHeading,
  focusPageTitle,
  refusedWords,
  retryable,
} from "./helpers.js";
import { useNewLicenseRoute, type Step } from "./route.js";

export function NewLicenseWizard({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const { open, step: urlStep, go } = useNewLicenseRoute();
  const tiersQ = useTiers(slug);
  const manual = useManualChannels(slug);
  const product = useProduct(slug).data;
  const hasLicenses = useHasLicenses(slug);
  const invitations = useInvitations(slug);
  const canInvite = invitations?.invitations === true;
  const tiers = React.useMemo(() => tiersQ.data?.tiers ?? [], [tiersQ.data]);
  // A 404 means the service has nothing to give: not a failure.
  const tiersError =
    tiersQ.error instanceof ApiError && tiersQ.error.status === 404
      ? null
      : tiersQ.error;

  const [draft, setDraft] = React.useState<Draft>(() => ({
    ...loadDraft(slug),
    invites: canInvite,
  }));
  const [errors, setErrors] = React.useState<Errors>({});
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [result, setResult] = React.useState<Result | null>(null);
  const [kept, setKept] = React.useState(false);
  /** A step was entered from Review (Change, the stepper): its primary goes back there. */
  const [toReview, setToReview] = React.useState(false);
  /** A refused value with no control of its own on its step: said above the step's fields. */
  const [stepNote, setStepNote] = React.useState<string | null>(null);

  // A result exists only in this tab's memory: a refresh on Done returns to Review.
  const step: Step = urlStep === "done" && !result ? "review" : urlStep;

  // Opening resumes the stored draft; the product changing loads that product's.
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft({ ...loadDraft(slug), invites: canInvite });
      setErrors({});
      setSubmitError(null);
      setResult(null);
      setKept(false);
      setToReview(false);
    }
    if (!open && wasOpen.current) focusPageTitle();
    wasOpen.current = open;
  }, [open, slug]);
  // Where invitations work, "Someone specific" is invited by default (L5); never stored.
  React.useEffect(() => {
    setDraft((d) =>
      d.invites === canInvite ? d : { ...d, invites: canInvite },
    );
  }, [canInvite]);
  React.useEffect(() => {
    if (open && step !== "done" && !result) saveDraft(slug, draft);
  }, [open, step, result, slug, draft]);

  // The Default tier is preselected, else the first. A product with no tier yet has nothing to
  // choose (`noTier`): the Worker uses its Default tier. A tier deleted since the draft is dropped.
  React.useEffect(() => {
    if (!open || result || !tiersQ.isSuccess) return;
    if (draft.tier !== null && !tiers.some((t) => t.id === draft.tier))
      setDraft((d) => ({ ...d, tier: null }));
    else if (draft.tier === null && !draft.noTier)
      setDraft((d) =>
        tiers.length > 0
          ? { ...d, tier: (tiers.find((t) => t.implicit) ?? tiers[0]!).id }
          : { ...d, noTier: true },
      );
  }, [open, result, tiersQ.isSuccess, tiers, draft.tier, draft.noTier]);

  // A deep link lands where the draft is good: an empty draft's Review is its first invalid step,
  // a stale `step=done` is Review, and a skipped Delivery is Review.
  React.useEffect(() => {
    if (!open || result || submitting) return;
    const bad = firstInvalid(draft);
    let want: Step = urlStep;
    if (want === "done") want = "review";
    if (want === "delivery" && deliverySkipped(draft)) want = "review";
    if ((want === "review" || want === "delivery") && bad) want = bad;
    if (want !== urlStep) go(want, { replace: true });
  }, [open, result, submitting, urlStep, draft, go]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const focusFirst = (errs: Errors): void => {
    const key = Object.keys(errs)[0];
    if (!key) return;
    // A batch's missing tier is said under "How many keys".
    const first = key === "tier" ? "count" : key;
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-create-field="${first}"]`)
        ?.querySelector<HTMLElement>("input,button,[tabindex]")
        ?.focus(),
    );
  };

  const goStep = (to: StepId, opts: { replace?: boolean } = {}): void => {
    if (to === "review") setToReview(false);
    setStepNote(null);
    go(to, { replace: false, ...opts });
  };
  const next = (from: StepId): void => {
    const errs =
      from === "holder"
        ? validateHolder(draft)
        : from === "limits"
          ? validateLimits(draft)
          : {};
    setErrors(errs);
    if (Object.keys(errs).length) return focusFirst(errs);
    goStep(toReview ? "review" : stepAfter(from, draft));
  };
  const change = (to: StepId): void => {
    setToReview(true);
    goStep(to);
  };

  const close = (): void => {
    if (step !== "done") saveDraft(slug, EMPTY);
    setDraft(EMPTY);
    go(null);
  };
  /** Discard asked and confirmed, or the result kept. */
  const finished = (): void => {
    saveDraft(slug, EMPTY);
    go(null);
  };

  const tier = draft.tier ? tiers.find((t) => t.id === draft.tier) : undefined;
  const lines = effectivePolicy(
    {
      tier: draft.tier,
      deviceLimit: draft.devices === "set" ? draft.deviceLimit : null,
      maxOfflineDays: draft.maxOfflineDays,
      channels: draft.channels,
      minVersion: draft.minVersion.trim() || null,
      maxVersion: draft.maxVersion.trim() || null,
    },
    tiers,
    product,
  );
  const limitLine = lines.find((l) => l.label === "Device limit");

  const submit = async (): Promise<void> => {
    const bad = firstInvalid(draft);
    if (bad) {
      setErrors(
        bad === "holder" ? validateHolder(draft) : validateLimits(draft),
      );
      return goStep(bad);
    }
    setSubmitting(true);
    setSubmitError(null);
    // Read before the create invalidates the list. An unknown list (still loading, failed) is
    // not an empty one: no moment.
    const first =
      hasLicenses === false && !momentSeen(momentKey("first-license", slug));
    const summary = summaryOf(
      draft,
      tier ? tierName(tier) : "Default",
      limitLine,
    );
    try {
      if (isBatch(draft)) {
        const res = await mutate("createLicenseBatch", slug, batchBody(draft));
        const limit =
          draft.devices === "set"
            ? draft.deviceLimit
            : Number(limitLine?.value) || null;
        setResult({
          kind: "batch",
          batchId: res.batchId,
          label: res.batch.label,
          first,
          summary: `${summary} · ${res.licenses.length} keys`,
          rows: csvRows(res, slug, draft.tier ?? "", limit),
        });
      } else {
        const res = await mutate("createLicense", slug, createBody(draft));
        setResult(singleResult(res, draft, first, summary));
      }
      saveDraft(slug, EMPTY);
      setKept(false);
      clearRetryError();
      go("done", { replace: true });
    } catch (err) {
      const fields =
        err instanceof ApiError && err.status === 422 ? err.fields : undefined;
      const field = fields?.find((f) => f in FIELD_STEP);
      if (field) {
        // A refused value goes back to its own step, in words.
        const reason =
          err instanceof ApiError && field === "delivery" ? err.reason : null;
        const words = refusedWords(field, reason);
        // The product can't invite after all: stop offering it.
        if (reason === "identity_off" || reason === "auto_link_off")
          setDraft((d) => ({ ...d, invites: false, delivery: null }));
        if (field === "tier") void tiersQ.refetch();
        announce(words);
        goStep(FIELD_STEP[field]!);
        // After goStep (which clears the note): the field's message, and a step-level one.
        setErrors({ [field]: words });
        setStepNote(words);
        setToReview(true);
        focusFirst({ [field]: "" });
      } else {
        setSubmitError(err);
        announce("The license wasn't created.");
        // The button that had focus is busy and blurred: keep the operator where they were.
        window.setTimeout(
          () => document.getElementById("new-license-create")?.focus(),
          0,
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const { retrying, retryWait, refusal, tryAgain, clearRetryError } =
    useRetrySend({ slug, result, setResult, setKept });

  // ── Footer and body per step ─────────────────────────────────────────────────────────────────
  const cancel = (
    <DialogPrimitive.Close asChild>
      <Button variant="ghost" className="max-sm:hidden" disabled={submitting}>
        Cancel
      </Button>
    </DialogPrimitive.Close>
  );
  // Done is the answer, not a step: the stepper shows the five.
  const kitSteps = NEW_LICENSE_FLOW.steps
    .filter((s) => s.kind !== "done")
    .map((s) => ({ id: s.id, label: s.label }));

  let body: React.ReactNode;
  let title: string;
  let why: string | undefined;
  let titleIcon: React.ReactNode;
  let footer: React.ComponentProps<typeof Wizard>["footer"];
  const showingResult = step === "done" && result !== null;
  const keeping = showingResult ? needsKeep(result) && !kept : false;

  if (showingResult) {
    const keep = needsKeep(result);
    const gate =
      keep && !kept
        ? result.kind === "batch"
          ? "Download or copy the keys first"
          : "Copy the key first"
        : undefined;
    title = doneTitle(result);
    why = result.summary;
    titleIcon =
      result.kind === "single" &&
      (result.delivered?.email === "failed" ||
        result.invite?.outcome === "failed") ? (
        <TriangleAlert aria-hidden className="size-5 shrink-0 text-warning" />
      ) : (
        <CheckCircle2 aria-hidden className="size-5 shrink-0 text-success" />
      );
    body = (
      <DoneBody
        slug={slug}
        productName={product?.name ?? slug}
        result={result}
        kept={kept || !keep}
        onKept={setKept}
        retrying={retrying}
        retryNote={
          refusal ? (
            <Callout tone={refusal.tone} title={refusal.title} live>
              {refusal.description}
            </Callout>
          ) : null
        }
        retryWait={retryWait}
        onRetry={() => void tryAgain()}
        onTryIt={() => {
          finished();
          if (window.location.hash.startsWith(r.integration(slug))) {
            focusWhenReady("integration-licensing");
            return;
          }
          navigate(r.integration(slug, { feature: "licensing" }));
        }}
      />
    );
    footer = {
      later: (
        <Button
          variant="ghost"
          disabledReason={gate}
          onClick={() => {
            setDraft(EMPTY);
            setResult(null);
            setToReview(false);
            go("tier", { replace: true });
          }}
        >
          Create another
        </Button>
      ),
      primary: (
        <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-2">
          <Button
            variant="outline"
            className="max-sm:order-2 max-sm:ms-auto"
            disabledReason={gate}
            onClick={() => {
              finished();
              navigate(
                result.kind === "batch"
                  ? r.licenseBatch(slug, result.batchId)
                  : r.license(slug, result.id),
              );
            }}
          >
            {result.kind === "batch" ? "Open batch" : "Open license"}
          </Button>
          <Button
            variant={result.kind === "batch" && !kept ? "outline" : "primary"}
            className="max-sm:order-3 max-sm:w-full"
            disabledReason={gate}
            onClick={finished}
          >
            Done
          </Button>
        </div>
      ),
    };
  } else {
    const at = (step === "done" ? "review" : step) as StepId;
    title = STEP_TITLES[at];
    const tierBlock =
      at === "tier" &&
      (tiersQ.isPending
        ? "Loading tiers…"
        : tiersError && !draft.noTier
          ? "Try the tiers again."
          : undefined);
    footer = {
      later: cancel,
      onBack: at === "tier" ? undefined : () => goStep(stepBefore(at, draft)),
      backDisabled: submitting,
      reason:
        tierBlock ||
        (at === "review" && submitError
          ? retryable(submitError)
            ? "Nothing was created. Try again."
            : "Nothing was created."
          : undefined),
      primary:
        at === "review" ? (
          <Button
            id="new-license-create"
            loading={submitting}
            onClick={() => void submit()}
          >
            {primaryLabel(draft)}
          </Button>
        ) : (
          <Button
            type="submit"
            form={`new-license-${at}`}
            disabled={Boolean(tierBlock)}
          >
            {toReview ? "Back to review" : "Continue"}
          </Button>
        ),
    };
    const form = (children: React.ReactNode): React.ReactNode => (
      <FormStep
        formId={`new-license-${at}`}
        onSubmit={() => next(at)}
        error={stepNote ? { title: stepNote } : null}
      >
        {children}
      </FormStep>
    );
    const common = { draft, set, errors };
    if (at === "tier") {
      body = form(
        <TierStep
          {...common}
          slug={slug}
          tiers={tiers}
          loading={tiersQ.isPending}
          error={tiersError}
          onRetry={() => void tiersQ.refetch()}
        />,
      );
    } else if (at === "holder") {
      body = form(<HolderStep {...common} />);
    } else if (at === "limits") {
      why = tier
        ? `${tierName(tier)}'s values are filled in. Change only what this license needs.`
        : "The product's values are filled in. Change only what this license needs.";
      body = form(
        <LimitsStep
          {...common}
          tiers={tiers}
          product={product}
          manualChannels={manual}
          moreOpen={moreOpen}
          onMoreOpen={setMoreOpen}
        />,
      );
    } else if (at === "delivery") {
      why = invitesPerson(draft)
        ? "An invitation has no key. A key you ask for is shown here only once."
        : "The key is shown here only once either way.";
      body = form(
        <DeliveryStep
          {...common}
          productName={product?.name ?? slug}
          invitationsOff={invitations?.off ?? null}
        />,
      );
    } else {
      body = (
        <ReviewStep
          rows={reviewRows(
            draft,
            tier ? tierName(tier) : "Default",
            tier?.policyExpiryDays ?? null,
            limitLine,
          )}
          items={willItems(draft, submitting)}
          onChange={change}
          error={submitError ? <ErrorBlock error={submitError} /> : undefined}
        />
      );
    }
  }

  return (
    <Wizard
      host="drawer"
      label="New license"
      steps={kitSteps}
      current={step}
      result={showingResult}
      titleIcon={titleIcon}
      onStep={
        showingResult || submitting ? undefined : (id) => change(id as StepId)
      }
      title={title}
      why={why}
      footer={footer}
      drawer={{
        open,
        onOpenChange: (o) => {
          if (o) return;
          if (showingResult) return finished();
          close();
        },
        title: "New license",
        eyebrow: `${product?.name ?? slug} · Licenses`,
        unsaved: showingResult ? keeping : isDirty(draft),
        discard: showingResult
          ? result.kind === "batch"
            ? {
                message: `Close without the CSV? The ${result.rows.length} keys can't be shown again.`,
                keep: "Keep it open",
                discard: "Close without keys",
              }
            : {
                message: "Close without copying? It can't be shown again.",
                keep: "Keep it open",
                discard: "Close without copying",
              }
          : { message: "Discard this license?", discard: "Discard" },
        dismissible: !submitting,
      }}
    >
      {body}
    </Wizard>
  );
}
