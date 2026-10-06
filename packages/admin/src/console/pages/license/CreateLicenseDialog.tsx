/**
 * Create license (ADMIN.md §6.5.1): a stepped dialog (T6). Holder → Terms → the one-time key.
 *
 * - Terms holds every policy field, including **profiles** as an ordered list whose order is the
 *   precedence (LIC-3), and an "Effective policy" aside naming each value's source (LIC-4).
 * - A failed tier, profile or channel lookup is said inline, never as "none defined" (LIC-6).
 * - Validation runs on Continue / Create, so every message can actually show (LIC-10).
 * - The key is shown once, in a `OneTimeSecretPanel` that will not close uncopied (LIC-2).
 * - Flow conformance (FLOWS.md C-17, §2 C3, C5, C13, C18): "Step n of 2 for you" with a step
 *   heading that takes focus on every step change, each step and the result announced once,
 *   primaries that name their action, and a draft that Escape cannot drop without asking.
 * - The product's first license (EXPERIENCE.md §0.7; MO-11) is a moment: Done carries the success
 *   check and sparks, once per product, and a **Try it** that opens the SDK quick start on Overview.
 */

import * as React from "react";
import { ApiError, type CreateLicenseBody } from "../../../api.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { r } from "../../routes.js";
import { navigate } from "../../router.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import { toSeconds } from "../../../lib/format.js";
import { versionRangeError } from "../../../lib/version.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ChannelPicker } from "../../../ui/ChannelPicker.js";
import { Combobox } from "../../../ui/Combobox.js";
import { DateInput } from "../../../ui/DateInput.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { announce } from "../../../ui/LiveRegion.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { OneTimeSecretPanel } from "../../../ui/OneTimeSecretPanel.js";
import { OrderedMultiSelect } from "../../../ui/OrderedMultiSelect.js";
import { Select } from "../../../ui/Select.js";
import { VersionInput } from "../../../ui/VersionInput.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { momentSeen } from "../../../ui/motion/index.js";
import { MomentLine, momentKey } from "../../components/Moment.js";
import {
  EMAIL_RE,
  EffectivePolicy,
  MAX_OFFLINE_DAYS,
  MIN_OFFLINE_DAYS,
  effectivePolicy,
  tierSummary,
  useLicenses,
  useManualChannels,
  useProfiles,
  useTiers,
} from "./shared.js";

type Step = "holder" | "terms" | "result";

/** The person's steps (the key is Polaris Key's result, not a step), titled by what they do. */
const STEPS: { id: Exclude<Step, "result">; title: string }[] = [
  { id: "holder", title: "Who it's for" },
  { id: "terms", title: "Set the terms" },
];
type ExpiryMode = "tier" | "none" | "date";

interface Draft {
  name: string;
  email: string;
  tier: string | null;
  expiryMode: ExpiryMode;
  /** Epoch ms, the end of the chosen local day. */
  expiresAt: number | null;
  maxOfflineDays: number | null;
  channels: string[];
  minVersion: string;
  maxVersion: string;
  profiles: string[];
}

const EMPTY: Draft = {
  name: "",
  email: "",
  tier: null,
  expiryMode: "tier",
  expiresAt: null,
  maxOfflineDays: null,
  channels: [],
  minVersion: "",
  maxVersion: "",
  profiles: [],
};

type Errors = Partial<Record<keyof Draft, string>>;

export function validateHolder(d: Pick<Draft, "name" | "email">): Errors {
  const e: Errors = {};
  if (!d.name.trim()) e.name = "Enter the holder's name.";
  if (!d.email.trim()) e.email = "Enter the holder's email.";
  else if (!EMAIL_RE.test(d.email.trim()))
    e.email = "Enter a valid email address.";
  return e;
}

export function validateTerms(d: Draft): Errors {
  const e: Errors = {};
  if (d.expiryMode === "date" && d.expiresAt === null)
    e.expiresAt = "Choose the expiry date.";
  if (
    d.maxOfflineDays !== null &&
    (!Number.isInteger(d.maxOfflineDays) ||
      d.maxOfflineDays < MIN_OFFLINE_DAYS ||
      d.maxOfflineDays > MAX_OFFLINE_DAYS)
  )
    e.maxOfflineDays = `Use a whole number of days from ${MIN_OFFLINE_DAYS} to ${MAX_OFFLINE_DAYS}.`;
  const range = versionRangeError(d.minVersion, d.maxVersion);
  if (range)
    e[range.field === "min" ? "minVersion" : "maxVersion"] = range.message;
  return e;
}

/** The POST body: only what the operator stated (an omitted expiry takes the tier's term). */
export function createBody(d: Draft): CreateLicenseBody {
  const body: CreateLicenseBody = {
    name: d.name.trim(),
    email: d.email.trim(),
  };
  if (d.tier) body.tier = d.tier;
  // "The tier's term" without a tier is no expiry, said explicitly.
  const mode = d.expiryMode === "tier" && !d.tier ? "none" : d.expiryMode;
  if (mode === "none") body.expiresAt = null;
  else if (mode === "date" && d.expiresAt !== null)
    body.expiresAt = toSeconds(d.expiresAt);
  if (d.maxOfflineDays !== null) body.maxOfflineDays = d.maxOfflineDays;
  if (d.channels.length) body.channels = d.channels;
  if (d.minVersion.trim()) body.minVersion = d.minVersion.trim();
  if (d.maxVersion.trim()) body.maxVersion = d.maxVersion.trim();
  if (d.profiles.length) body.profiles = d.profiles;
  return body;
}

/** A lookup that failed (not a 404, which means the service has nothing to give). */
function failed(error: unknown): boolean {
  return !!error && !(error instanceof ApiError && error.status === 404);
}

export function CreateLicenseDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const tiersQ = useTiers(slug);
  const profilesQ = useProfiles(slug);
  const manual = useManualChannels(slug);
  const product = useProduct(slug).data;
  // The product's licenses as the page knows them: an empty list means the next one is the first.
  const licensesQ = useLicenses(slug);
  const tiers = React.useMemo(() => tiersQ.data?.tiers ?? [], [tiersQ.data]);
  const profiles = profilesQ.data?.profiles ?? [];

  const [step, setStep] = React.useState<Step>("holder");
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [errors, setErrors] = React.useState<Errors>({});
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [created, setCreated] = React.useState<{
    id: string;
    key: string;
    /** The product had no license before this one, and its moment has not been shown. */
    first: boolean;
  } | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const stepHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  // Set by a step change; the effect below moves focus once the new step has rendered.
  const movedTo = React.useRef<Step | null>(null);

  const go = (to: Step): void => {
    movedTo.current = to;
    setStep(to);
  };
  React.useEffect(() => {
    const to = movedTo.current;
    if (!to || to !== step) return;
    movedTo.current = null;
    if (to === "result") {
      titleRef.current?.focus({ preventScroll: true });
      announce(`License created for ${draft.name.trim()}.`);
      return;
    }
    stepHeadingRef.current?.focus({ preventScroll: true });
    const i = STEPS.findIndex((x) => x.id === to);
    announce(`Step ${i + 1} of ${STEPS.length} for you: ${STEPS[i]!.title}`);
  }, [step, draft.name]);

  const reset = (): void => {
    setStep("holder");
    setDraft(EMPTY);
    setErrors({});
    setSubmitError(null);
    setSubmitting(false);
    setCreated(null);
    setAcknowledged(false);
    setAsking(false);
  };
  React.useEffect(() => {
    if (open) reset();
  }, [open]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const tier = draft.tier ? tiers.find((t) => t.id === draft.tier) : undefined;
  const tierTerm = tier?.policyExpiryDays ?? null;

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

  const next = (): void => {
    const errs = validateHolder(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return focusFirst(errs);
    go("terms");
  };

  const submit = async (): Promise<void> => {
    const errs = validateTerms(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return focusFirst(errs);
    setSubmitting(true);
    setSubmitError(null);
    // Read before the create invalidates the list. An unknown list (still loading, failed) is
    // not an empty one: no moment.
    const first =
      licensesQ.data !== undefined &&
      licensesQ.data.licenses.length === 0 &&
      !momentSeen(momentKey("first-license", slug));
    try {
      const res = await mutate("createLicense", slug, createBody(draft));
      setCreated({ id: res.licenseId, key: res.key, first });
      go("result");
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const close = (): void => onOpenChange(false);
  const dirty =
    step !== "result" && JSON.stringify(draft) !== JSON.stringify(EMPTY);
  const stepIndex = STEPS.findIndex((x) => x.id === step);

  const policy = effectivePolicy(
    {
      tier: draft.tier,
      maxOfflineDays: draft.maxOfflineDays,
      channels: draft.channels,
      minVersion: draft.minVersion.trim() || null,
      maxVersion: draft.maxVersion.trim() || null,
    },
    tiers,
    product,
  );

  const expiryOptions = [
    ...(draft.tier
      ? [
          {
            value: "tier",
            label:
              tierTerm !== null
                ? `Use the tier's term (${tierTerm} days)`
                : "Use the tier's term (none: no expiry)",
          },
        ]
      : []),
    { value: "none", label: "No expiry" },
    { value: "date", label: "On a date" },
  ];
  const expiryMode: ExpiryMode =
    draft.expiryMode === "tier" && !draft.tier ? "none" : draft.expiryMode;

  return (
    <Dialog
      open={open}
      size="lg"
      title={step === "result" ? "License created" : "Create license"}
      titleRef={titleRef}
      unsaved={dirty}
      description={
        step === "result" ? undefined : (
          <>
            <a
              className="underline underline-offset-2 hover:text-fg-strong"
              href={docsUrl("createLicense")}
              target="_blank"
              rel="noreferrer"
            >
              Docs
            </a>
          </>
        )
      }
      dismissible={!submitting}
      onOpenChange={(o) => {
        if (o) return onOpenChange(true);
        if (step === "result" && !acknowledged) return setAsking(true);
        close();
      }}
    >
      {stepIndex !== -1 ? (
        <div className="flex items-baseline justify-between gap-4 px-6 pt-2">
          <h3
            ref={stepHeadingRef}
            tabIndex={-1}
            className="text-base font-bold text-fg-strong outline-hidden"
          >
            {STEPS[stepIndex]!.title}
          </h3>
          <p className="shrink-0 text-sm text-fg-muted">
            Step {stepIndex + 1} of {STEPS.length} for you
          </p>
        </div>
      ) : null}

      {step === "holder" ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            next();
          }}
          className="contents"
        >
          <DialogBody className="space-y-4">
            <div data-create-field="name">
              <FormField
                name="name"
                label="Name"
                required
                value={draft.name}
                onChange={(v: string) => set("name", v)}
                error={errors.name}
                announceError
              >
                {(f) => <Input {...f} placeholder="Full name" autoFocus />}
              </FormField>
            </div>
            <div data-create-field="email">
              <FormField
                name="email"
                label="Email"
                required
                value={draft.email}
                onChange={(v: string) => set("email", v)}
                error={errors.email}
                announceError
              >
                {(f) => (
                  <Input {...f} type="email" placeholder="name@company.com" />
                )}
              </FormField>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Continue to terms</Button>
          </DialogFooter>
        </form>
      ) : null}

      {step === "terms" ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="contents"
        >
          <DialogBody className="space-y-5">
            {/* Fields first, then the effective policy at full width, so its values never wrap word by word. */}
            <div className="grid gap-5">
              <div className="space-y-5">
                <FormField
                  name="tier"
                  label="Tier"
                  help="Applies the tier's profile, device limit and term."
                  value={draft.tier}
                  onChange={(v: string | null) => {
                    set("tier", v);
                    if (!v && draft.expiryMode === "tier")
                      set("expiryMode", "none");
                    if (v && draft.expiryMode === "none")
                      set("expiryMode", "tier");
                  }}
                >
                  {(f) =>
                    failed(tiersQ.error) ? (
                      <InlineFailure
                        what="tiers"
                        error={tiersQ.error}
                        onRetry={() => void tiersQ.refetch()}
                      />
                    ) : (
                      <Combobox
                        {...f}
                        clearable
                        placeholder={tiersQ.isPending ? "Loading…" : "No tier"}
                        searchPlaceholder="Search tiers"
                        emptyText="No tiers match."
                        options={tiers.map((t) => ({
                          value: t.id,
                          label: t.label || t.id,
                          secondary: tierSummary(t),
                          searchText: `${t.label} ${t.id}`,
                        }))}
                      />
                    )
                  }
                </FormField>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    name="expiryMode"
                    label="Expiry"
                    value={expiryMode}
                    onChange={(v: string | null) =>
                      set("expiryMode", (v ?? "none") as ExpiryMode)
                    }
                  >
                    {(f) => <Select {...f} options={expiryOptions} />}
                  </FormField>
                  {expiryMode === "date" ? (
                    <div data-create-field="expiresAt">
                      <FormField
                        name="expiresAt"
                        label="Expires"
                        value={draft.expiresAt}
                        onChange={(v: number | null) => set("expiresAt", v)}
                        error={errors.expiresAt}
                        announceError
                      >
                        {(f) => <DateInput {...f} resolvedLabel="Ends" />}
                      </FormField>
                    </div>
                  ) : null}
                </div>

                <div data-create-field="maxOfflineDays">
                  <FormField
                    name="maxOfflineDays"
                    label="Max offline days"
                    help={`Blank uses the product default (${product?.defaultMaxOfflineDays ?? "—"} days).`}
                    value={draft.maxOfflineDays}
                    onChange={(v: number | null) => set("maxOfflineDays", v)}
                    error={errors.maxOfflineDays}
                    announceError
                  >
                    {(f) => (
                      <NumberInput
                        {...f}
                        nullable
                        integer
                        unit="days"
                        className="sm:max-w-48"
                      />
                    )}
                  </FormField>
                </div>

                <FormField
                  name="channels"
                  label="Release channels"
                  help="Added to the tier's channels. None selected: the tier's, else stable only."
                  group
                  value={draft.channels}
                  onChange={(v: string[]) => set("channels", v)}
                >
                  {(f) => <ChannelPicker {...f} manual={manual} />}
                </FormField>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div data-create-field="minVersion">
                    <FormField
                      name="minVersion"
                      label="Minimum version"
                      value={draft.minVersion}
                      onChange={(v: string | null) =>
                        set("minVersion", v ?? "")
                      }
                      error={errors.minVersion}
                      announceError
                    >
                      {(f) => <VersionInput {...f} placeholder="e.g. 1.2.0" />}
                    </FormField>
                  </div>
                  <div data-create-field="maxVersion">
                    <FormField
                      name="maxVersion"
                      label="Maximum version"
                      value={draft.maxVersion}
                      onChange={(v: string | null) =>
                        set("maxVersion", v ?? "")
                      }
                      error={errors.maxVersion}
                      announceError
                    >
                      {(f) => <VersionInput {...f} placeholder="e.g. 2.0.0" />}
                    </FormField>
                  </div>
                </div>

                <FormField
                  name="profiles"
                  label="Profiles"
                  group
                  value={draft.profiles}
                  onChange={(v: string[]) => set("profiles", v)}
                >
                  {(f) =>
                    failed(profilesQ.error) ? (
                      <InlineFailure
                        what="profiles"
                        error={profilesQ.error}
                        onRetry={() => void profilesQ.refetch()}
                      />
                    ) : (
                      <OrderedMultiSelect
                        {...f}
                        addLabel="Add profile"
                        emptyText={
                          profilesQ.isPending
                            ? "Loading profiles…"
                            : profiles.length === 0
                              ? "This product has no profiles."
                              : "No profiles: the tier's profile and catalog defaults apply."
                        }
                        orderHint="Applied in this order, after the tier's profile: a later profile overrides an earlier one."
                        options={profiles.map((p) => ({
                          value: p.id,
                          label: p.name || p.id,
                          secondary: p.id,
                          searchText: `${p.name} ${p.id}`,
                        }))}
                      />
                    )
                  }
                </FormField>
              </div>
              <div>
                <EffectivePolicy
                  lines={[
                    {
                      label: "Expiry",
                      value:
                        expiryMode === "none"
                          ? "No expiry"
                          : expiryMode === "date"
                            ? draft.expiresAt
                              ? new Date(draft.expiresAt).toLocaleDateString()
                              : "—"
                            : tierTerm !== null
                              ? `${tierTerm} days from today`
                              : "No expiry",
                      source: expiryMode === "tier" ? "tier" : "license",
                      from:
                        expiryMode === "tier"
                          ? `tier “${tier?.label || tier?.id}”`
                          : "this license",
                    },
                    ...policy,
                  ]}
                />
              </div>
            </div>
            {submitError ? (
              <Callout tone="danger" title="The license wasn't created" live>
                {errorCopy(submitError, { thing: "License" }).description}
              </Callout>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => go("holder")}
            >
              Back
            </Button>
            <Button type="submit" loading={submitting}>
              Create license
            </Button>
          </DialogFooter>
        </form>
      ) : null}

      {step === "result" && created ? (
        <OneTimeSecretPanel
          label="License key"
          value={created.key}
          acknowledged={acknowledged}
          onAcknowledgedChange={(v) => {
            setAcknowledged(v);
            if (v) setAsking(false);
          }}
          closeRequested={asking}
          onCancelClose={() => setAsking(false)}
          onConfirmClose={close}
          onDone={close}
          details={
            created.first ? (
              <MomentLine
                momentKey={momentKey("first-license", slug)}
                title={`${product?.name ?? slug}'s first license`}
                className="rounded-md border border-border bg-surface-raised p-3"
              >
                Try it in your app: the SDK quick start on Overview installs the
                SDK and pins your signing key.
              </MomentLine>
            ) : undefined
          }
          actions={
            <>
              {created.first ? (
                <Button
                  variant="ghost"
                  disabledReason={
                    acknowledged ? undefined : "Copy the license key first"
                  }
                  onClick={() => {
                    close();
                    navigate(r.overview(slug));
                  }}
                >
                  Try it
                </Button>
              ) : null}
              <Button
                variant="ghost"
                disabledReason={
                  acknowledged ? undefined : "Copy the license key first"
                }
                onClick={() => {
                  reset();
                  movedTo.current = "holder";
                }}
              >
                Create another
              </Button>
              <Button
                variant="outline"
                disabledReason={
                  acknowledged ? undefined : "Copy the license key first"
                }
                onClick={() => {
                  close();
                  navigate(r.license(slug, created.id));
                }}
              >
                Open license
              </Button>
            </>
          }
        />
      ) : null}
    </Dialog>
  );
}

/** A lookup failure, said where the control would be (LIC-6). */
export function InlineFailure({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <Callout
      tone="warning"
      title={`Couldn't load ${what}`}
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {errorCopy(error).description}
    </Callout>
  );
}
