/**
 * **New license** (LX-29; S-24 §8, FLOWS.md C-17): a five-step drawer on the wizard kit (ST-39)
 * over the Licenses list. Tier, who it's for, limits, delivery, review; then the result in place.
 *
 * - The drawer is the URL: `?setup=new-license&step=<id>`. The draft is in `sessionStorage` per
 *   product, so a refresh or a trip to Tiers resumes it. Escape asks "Discard this license?".
 * - One assigned license (optionally emailed), one floating key, or a batch of floating keys (up to
 *   500, one CSV). Nothing here learns whether an email has an account (D4).
 * - The key is shown once, in the response of the request that made it; a batch's CSV is built
 *   here from that response. Closing before it is kept asks (a batch: refuses).
 * - The product's first license is a moment (EXPERIENCE.md §0.7; MO-11), once per product.
 */

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ApiError } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { toast } from "../../../../ui/toast.js";
import { momentSeen } from "../../../../ui/motion/index.js";
import {
  FormStep,
  Wizard,
  type AutoItem,
} from "../../../../ui/wizard/index.js";
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
import { sendKeyRefusal } from "../components/SendKeyDialog.js";
import { DoneBody, doneTitle, needsKeep, type Result } from "./DoneStep.js";
import {
  EMPTY,
  STEP_IDS,
  batchBody,
  createBody,
  deliveryOf,
  dirty as isDirty,
  emailsKey,
  expiryWords,
  firstInvalid,
  isBatch,
  loadDraft,
  saveDraft,
  validateHolder,
  validateLimits,
  type Draft,
  type Errors,
  type StepId,
} from "./draft.js";
import { HolderStep, LimitsStep, TierStep, tierName } from "./steps.js";
import { DeliveryStep, ReviewStep, type ReviewRow } from "./stepsDelivery.js";
import { useNewLicenseRoute, type Step } from "./route.js";

const STEP_TITLES: Record<StepId, string> = {
  tier: "Choose a tier",
  holder: "Who it's for",
  limits: "Limits",
  delivery: "Delivery",
  review: "Review",
};

const DELIVERY_WORDS = {
  "email-show": "Email the key and show it once",
  email: "Email the key",
  show: "Show it once",
  csv: "Download a CSV",
} as const;

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
    }
    wasOpen.current = open;
  }, [open, slug]);
  React.useEffect(() => {
    if (open && step !== "done" && !result) saveDraft(slug, draft);
  }, [open, step, result, slug, draft]);

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

  const next = (from: StepId): void => {
    const errs =
      from === "holder"
        ? validateHolder(draft)
        : from === "limits"
          ? validateLimits(draft)
          : {};
    setErrors(errs);
    if (Object.keys(errs).length) return focusFirst(errs);
    const to = STEP_IDS[STEP_IDS.indexOf(from) + 1]!;
    go(to, { replace: false });
  };
  const back = (from: StepId): void =>
    go(STEP_IDS[Math.max(0, STEP_IDS.indexOf(from) - 1)]!, { replace: false });

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
  const line = (label: string) => lines.find((l) => l.label === label);

  const submit = async (): Promise<void> => {
    const bad = firstInvalid(draft);
    if (bad) {
      setErrors(
        bad === "holder" ? validateHolder(draft) : validateLimits(draft),
      );
      return go(bad, { replace: false });
    }
    setSubmitting(true);
    setSubmitError(null);
    // Read before the create invalidates the list. An unknown list (still loading, failed) is
    // not an empty one: no moment.
    const first =
      hasLicenses === false && !momentSeen(momentKey("first-license", slug));
    try {
      if (isBatch(draft)) {
        const res = await mutate("createLicenseBatch", slug, batchBody(draft));
        const limit =
          draft.devices === "set"
            ? draft.deviceLimit
            : Number(line("Device limit")?.value) || null;
        setResult({
          kind: "batch",
          batchId: res.batchId,
          label: res.batch.label,
          first,
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
        const email = draft.who === "person" ? draft.email.trim() : null;
        const failed = res.delivered?.email === "failed";
        setResult({
          kind: "single",
          id: res.licenseId,
          key: res.key,
          email,
          // "Email the key" alone never shows it, unless the email did not go out.
          showKey: deliveryOf(draft) !== "email" || failed,
          delivered: res.delivered ?? null,
          first,
        });
      }
      saveDraft(slug, EMPTY);
      setKept(false);
      setRetryError(null);
      go("done", { replace: true });
    } catch (err) {
      setSubmitError(err);
      announce("The license wasn't created.");
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
        toast.success(`Key sent to ${result.email}.`);
        setResult({ ...result, delivered: { email: "sent" } });
      } else {
        setResult({
          ...result,
          key: res.key,
          showKey: true,
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

  // ── Review ───────────────────────────────────────────────────────────────────────────────────
  const batch = isBatch(draft);
  const delivery = deliveryOf(draft);
  const rows: ReviewRow[] = [
    {
      label: "Tier",
      value: tier ? tierName(tier) : "No tier",
      step: "tier",
    },
    {
      label: "For",
      value:
        draft.who === "person"
          ? [draft.email.trim(), draft.name.trim()].filter(Boolean).join(" · ")
          : batch
            ? `${draft.count} floating keys · ${draft.label.trim()}`
            : "Anyone with the key",
      step: "holder",
    },
    {
      label: "Devices",
      value: `${line("Device limit")?.value ?? "—"} · ${line("Device limit")?.from ?? ""}`,
      step: "limits",
    },
    {
      label: "Expires",
      value: expiryWords(draft, tier?.policyExpiryDays ?? null),
      step: "limits",
    },
    { label: "Delivery", value: DELIVERY_WORDS[delivery], step: "delivery" },
  ];
  const will: AutoItem[] = [
    {
      id: "create",
      label: batch
        ? `Create ${draft.count} floating licenses`
        : draft.who === "person"
          ? `Create the license for ${draft.email.trim()}`
          : "Create a floating license",
      state: submitting ? "doing" : "will",
    },
    ...(emailsKey(draft)
      ? [
          {
            id: "email",
            label: `Email the key to ${draft.email.trim()}`,
            state: (submitting ? "doing" : "will") as AutoItem["state"],
          },
        ]
      : []),
    {
      id: "keep",
      label: batch
        ? "Offer the keys as a CSV"
        : delivery === "email"
          ? "Keep the key out of sight"
          : "Show the key once",
      state: "will",
    },
  ];
  const primary = batch
    ? `Create ${draft.count} keys`
    : emailsKey(draft)
      ? "Create and email license"
      : "Create license";

  // ── Footer and body per step ─────────────────────────────────────────────────────────────────
  const cancel = (
    <DialogPrimitive.Close asChild>
      <Button variant="ghost" disabled={submitting}>
        Cancel
      </Button>
    </DialogPrimitive.Close>
  );
  const index = step === "done" ? STEP_IDS.length : STEP_IDS.indexOf(step);
  const kitSteps = NEW_LICENSE_FLOW.steps.map((s) => ({
    id: s.id,
    label: s.label,
  }));

  let body: React.ReactNode;
  let title: string;
  let why: string | undefined;
  let footer: React.ComponentProps<typeof Wizard>["footer"];

  if (step === "done" && result) {
    const keep = needsKeep(result);
    const gate = keep && !kept ? "Copy the key first" : undefined;
    title = doneTitle(result);
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
            go("tier", { replace: true });
          }}
        >
          Create another
        </Button>
      ),
      primary: (
        <div className="flex flex-wrap items-center gap-2">
          {result.first ? (
            <Button
              variant="ghost"
              disabledReason={gate}
              onClick={() => {
                finished();
                navigate(r.overview(slug));
                // Lands on the SDK chooser, as the palette's "SDK quick start" does.
                focusWhenReady(SDK_QUICK_START_ID);
              }}
            >
              Try it
            </Button>
          ) : null}
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
          <Button disabledReason={gate} onClick={finished}>
            Done
          </Button>
        </div>
      ),
    };
  } else {
    const at = (step === "done" ? "review" : step) as StepId;
    title = STEP_TITLES[at];
    footer = {
      later: cancel,
      onBack: at === "tier" ? undefined : () => back(at),
      primary:
        at === "review" ? (
          <Button loading={submitting} onClick={() => void submit()}>
            {primary}
          </Button>
        ) : (
          <Button type="submit" form={`new-license-${at}`}>
            Continue
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
          error={
            tiersQ.error instanceof ApiError && tiersQ.error.status === 404
              ? null
              : tiersQ.error
          }
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
      why = batch
        ? "Keys are shown once, as a file."
        : draft.who === "person"
          ? "The key is shown here only once either way."
          : "The key is shown here only once.";
      body = form(
        <DeliveryStep {...common} productName={product?.name ?? slug} />,
      );
    } else {
      body = (
        <ReviewStep
          rows={rows}
          items={will}
          onChange={(s) => go(s, { replace: false })}
          error={
            submitError ? (
              <Callout tone="danger" title="The license wasn't created" live>
                {errorCopy(submitError, { thing: "License" }).description}
              </Callout>
            ) : undefined
          }
        />
      );
    }
  }

  const keeping =
    step === "done" && result ? needsKeep(result) && !kept : false;
  const blocked = submitting || (keeping && result?.kind === "batch");
  return (
    <Wizard
      host="drawer"
      label="New license"
      steps={kitSteps}
      current={step}
      done={step === "done" ? STEP_IDS.slice() : undefined}
      onStep={
        step === "done" || submitting
          ? undefined
          : (id) => go(id as StepId, { replace: false })
      }
      title={title}
      why={why}
      footer={footer}
      drawer={{
        open,
        onOpenChange: (o) => {
          if (o) return;
          if (step === "done") return finished();
          close();
        },
        title: "New license",
        unsaved: step === "done" ? keeping : isDirty(draft),
        discard:
          step === "done"
            ? {
                message: "Close without copying? It can't be shown again.",
                keep: "Keep it open",
                discard: "Close without copying",
              }
            : { message: "Discard this license?", discard: "Discard" },
        dismissible: !blocked,
      }}
    >
      {body}
    </Wizard>
  );
}
