/**
 * **New license** (LX-29; S-24 §8, FLOWS.md C-17): a five-step drawer on the wizard kit (ST-39)
 * over the Licenses list. Tier, who it's for, limits, delivery, review; then the result in place.
 *
 * - The drawer is the URL: `?setup=new-license&step=<id>`. The draft is in `sessionStorage` per
 *   product, so a refresh or a trip to Tiers resumes it. Escape asks "Discard this license?".
 * - One assigned license (optionally emailed), one floating key, or a batch of floating keys (up to
 *   500, one CSV). Nothing here learns whether an email has an account (D4). Delivery is skipped
 *   when it has one answer. A batch is atomic on the Worker (one `db.batch`): it all happens or none.
 * - The key is shown once, in the response of the request that made it; a batch's CSV is built
 *   here from that response. Leaving asks only when this screen holds the only copy.
 * - The product's first license is a moment (EXPERIENCE.md §0.7; MO-11), once per product.
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
import { SDK_QUICK_START_ID } from "../../core/model/sdkQuickStart.js";
import {
  effectivePolicy,
  useHasLicenses,
  useManualChannels,
  useTiers,
} from "../components/shared.js";
import { ErrorBlock } from "../components/InlineFailure.js";
import { sendKeyRefusal } from "../components/SendKeyDialog.js";
import { DoneBody, doneTitle, needsKeep, type Result } from "./DoneStep.js";
import {
  EMPTY,
  FIELD_STEP,
  batchBody,
  createBody,
  deliveryOf,
  deliverySkipped,
  dirty as isDirty,
  firstInvalid,
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
import { devicesWords, primaryLabel, reviewRows, willItems } from "./review.js";
import { HolderStep, LimitsStep, TierStep, tierName } from "./steps.js";
import { DeliveryStep, ReviewStep } from "./stepsDelivery.js";
import { useNewLicenseRoute, type Step } from "./route.js";

const STEP_TITLES: Record<StepId, string> = {
  tier: "Choose a tier",
  holder: "Who it's for",
  limits: "Limits",
  delivery: "Delivery",
  review: "Review",
};

/** With the opener gone (palette, deep link, reload) focus goes to the page's h1. */
function focusPageTitle(): void {
  window.setTimeout(() => {
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest("[data-wizard]")) return;
    const h1 = document.querySelector<HTMLElement>(
      "[data-page-title], main h1",
    );
    if (!h1) return;
    if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
    h1.focus({ preventScroll: true });
  }, 80);
}

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
  const tiers = React.useMemo(() => tiersQ.data?.tiers ?? [], [tiersQ.data]);
  // A 404 means the service has nothing to give: not a failure.
  const tiersError =
    tiersQ.error instanceof ApiError && tiersQ.error.status === 404
      ? null
      : tiersQ.error;

  const [draft, setDraft] = React.useState<Draft>(() => loadDraft(slug));
  const [errors, setErrors] = React.useState<Errors>({});
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [result, setResult] = React.useState<Result | null>(null);
  const [kept, setKept] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<unknown>(null);
  const [retryUntil, setRetryUntil] = React.useState(0);
  /** A step was entered from Review (Change, the stepper): its primary goes back there. */
  const [toReview, setToReview] = React.useState(false);

  // A result exists only in this tab's memory: a refresh on Done returns to Review.
  const step: Step = urlStep === "done" && !result ? "review" : urlStep;

  // Opening resumes the stored draft; the product changing loads that product's.
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(loadDraft(slug));
      setErrors({});
      setSubmitError(null);
      setResult(null);
      setKept(false);
      setToReview(false);
    }
    if (!open && wasOpen.current) focusPageTitle();
    wasOpen.current = open;
  }, [open, slug]);
  React.useEffect(() => {
    if (open && step !== "done" && !result) saveDraft(slug, draft);
  }, [open, step, result, slug, draft]);

  // The first tier is preselected, unless "No tier" was chosen on purpose.
  React.useEffect(() => {
    if (
      open &&
      !result &&
      tiersQ.isSuccess &&
      tiers.length > 0 &&
      draft.tier === null &&
      !draft.noTier
    )
      setDraft((d) => ({ ...d, tier: tiers[0]!.id }));
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
    const first = Object.keys(errs)[0];
    if (!first) return;
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-create-field="${first}"]`)
        ?.querySelector<HTMLElement>("input,button,[tabindex]")
        ?.focus(),
    );
  };

  const goStep = (to: StepId, opts: { replace?: boolean } = {}): void => {
    if (to === "review") setToReview(false);
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
    const summary = [
      tier ? tierName(tier) : "No tier",
      devicesWords(limitLine?.value),
      draft.who === "person" ? `for ${draft.email.trim()}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
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
          rows: res.licenses.map((l) => ({
            key: l.key,
            licenseId: l.licenseId,
            product: slug,
            tier: draft.tier ?? "",
            deviceLimit: limit,
            expiresAt: res.expiresAt,
            batch: res.batch.label,
          })),
        });
      } else {
        const res = await mutate("createLicense", slug, createBody(draft));
        const failed = res.delivered?.email === "failed";
        const delivery = deliveryOf(draft);
        setResult({
          kind: "single",
          id: res.licenseId,
          key: res.key,
          email: draft.who === "person" ? draft.email.trim() : null,
          // "Email the key" alone never shows it, unless the email did not go out.
          showKey: delivery !== "email" || failed,
          // Only then is this screen the one copy: Show it once, or an email that failed.
          onlyCopy: delivery === "show" || failed,
          delivered: res.delivered ?? null,
          first,
          summary,
        });
      }
      saveDraft(slug, EMPTY);
      setKept(false);
      setRetryError(null);
      go("done", { replace: true });
    } catch (err) {
      const fields =
        err instanceof ApiError && err.status === 422 ? err.fields : undefined;
      const field = fields?.find((f) => f in FIELD_STEP);
      if (field) {
        // A refused value goes back to its own step, in words.
        setErrors({
          [field]: "This value isn't accepted. Check it and try again.",
        });
        announce("A value was refused. Check it and try again.");
        const to = FIELD_STEP[field]!;
        goStep(to);
        focusFirst({ [field]: "" });
      } else {
        setSubmitError(err);
        announce("The license wasn't created.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const tryAgain = async (): Promise<void> => {
    if (result?.kind !== "single" || !result.email) return;
    setRetrying(true);
    setRetryError(null);
    try {
      // A retry never revokes: the key on screen may already be copied.
      const res = await mutate("sendLicenseKey", slug, result.id, false);
      if (res.delivered.email === "sent") {
        setResult({
          ...result,
          onlyCopy: false,
          delivered: { email: "sent" },
        });
        announce(`License created. Key sent to ${result.email}.`);
      } else {
        setResult({
          ...result,
          key: res.key,
          showKey: true,
          onlyCopy: true,
          delivered: res.delivered,
        });
        setKept(false);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429)
        setRetryUntil(Date.now() + (err.retryAfter ?? 600) * 1000);
      setRetryError(err);
    } finally {
      setRetrying(false);
    }
  };
  const retryWait = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
  const refusal =
    retryError && result?.kind === "single"
      ? sendKeyRefusal(retryError, result.email ?? "", retryWait || 600)
      : null;

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
      result.kind === "single" && result.delivered?.email === "failed" ? (
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
          navigate(r.overview(slug));
          // Lands on the SDK chooser, as the palette's "SDK quick start" does.
          focusWhenReady(SDK_QUICK_START_ID);
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
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
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
          ? "Retry the tiers, or choose No tier."
          : undefined);
    footer = {
      later: cancel,
      onBack: at === "tier" ? undefined : () => goStep(stepBefore(at, draft)),
      backDisabled: submitting,
      reason:
        tierBlock ||
        (at === "review" && submitError
          ? "Nothing was created. Try again."
          : undefined),
      primary:
        at === "review" ? (
          <Button loading={submitting} onClick={() => void submit()}>
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
      <FormStep formId={`new-license-${at}`} onSubmit={() => next(at)}>
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
      why = "The key is shown here only once either way.";
      body = form(
        <DeliveryStep {...common} productName={product?.name ?? slug} />,
      );
    } else {
      body = (
        <ReviewStep
          rows={reviewRows(
            draft,
            tier ? tierName(tier) : "No tier",
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
