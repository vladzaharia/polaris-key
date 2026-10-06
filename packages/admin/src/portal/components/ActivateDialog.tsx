import * as React from "react";
import { ArrowRight, Check, Info } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import {
  PortalApiError,
  type PortalKeyPreview,
  type PortalLicenseSummary,
} from "../api.js";
import { useClaimKey, useLicenses, usePreviewKey } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import { requestHeadingFocus } from "../focus.js";
import { checkKey, keyProblem, slugOf } from "../model/key.js";
import { formatDay, normalisePlatform, tierLabel } from "../model/library.js";
import { href, navigate } from "../router.js";
import { PLATFORM_ORDER, PlatformGlyphs, type PlatformKey } from "./Glyphs.js";
import { KeyField } from "./KeyField.js";
import { ProductArt } from "./ProductArt.js";
import { ProductIcon } from "./ProductIcon.js";

/**
 * Activate license (PORTAL.md §4.17–4.19, §5.2 `ActivateDialog`): always a modal over the
 * Library (a bottom sheet on phones), mounted once by the shell.
 *
 * Steps: **enter** → **confirm** → **done**. Continue asks the key preview (G22, PX-W5) what
 * adding would do: an addable key shows the confirm step (art, tier, terms, platforms), a refusal
 * comes back inline in §4.19's words. The preview and the claim share one evaluator on the
 * Worker, so the confirm step never promises an add the claim refuses. A Worker without the
 * preview (404) adds the key directly, as before. Nothing about the key is sent before
 * Continue: the product is named from the key's own prefix.
 */
type ConfirmPreview = PortalKeyPreview & {
  product: NonNullable<PortalKeyPreview["product"]>;
};

type Step =
  | { kind: "enter" }
  | { kind: "confirm"; preview: ConfirmPreview; slug: string }
  | {
      kind: "done";
      license: PortalLicenseSummary | null;
      slug: string;
      already: boolean;
      /** From the preview, when it ran: the name and art the confirm step showed. */
      product?: ConfirmPreview["product"];
    };

export function ActivateDialog({
  open,
  prefill,
  fromProduct,
  onOpenChange,
}: {
  open: boolean;
  /** A key from `/activate?key=…`, filled in and checked. */
  prefill?: string;
  /** The product slug an app sent along (`&product=`). */
  fromProduct?: string;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [key, setKey] = React.useState(prefill ?? "");
  const [touched, setTouched] = React.useState(Boolean(prefill));
  const [step, setStep] = React.useState<Step>({ kind: "enter" });
  const [serverError, setServerError] = React.useState<string | null>(null);
  const claim = useClaimKey();
  const preview = usePreviewKey();
  const licenses = useLicenses(open);
  const fieldId = React.useId();

  const check = checkKey(key);
  const slug = check.kind === "valid" ? check.slug : slugOf(key);
  const nameFor = (s: string): string =>
    licenses.data?.find((l) => l.product === s)?.productName ?? s;
  const owned = (s: string) =>
    licenses.data?.some((l) => l.product === s) ?? false;
  const problem = touched || check.kind === "notKey" ? keyProblem(check) : null;

  const reset = (): void => {
    setKey("");
    setTouched(false);
    setServerError(null);
    claim.reset();
    preview.reset();
    setStep({ kind: "enter" });
  };

  /** Add the key (the claim); refusals go back to the enter step, inline. */
  const add = (
    slugToAdd: string,
    product?: ConfirmPreview["product"],
  ): void => {
    const before = new Set(
      (licenses.data ?? []).map((l) => `${l.product}:${l.id}`),
    );
    claim.mutate(key, {
      onSuccess: (res) => {
        const lic = res.license;
        setStep({
          kind: "done",
          license: lic,
          slug: slugToAdd,
          already: lic ? before.has(`${lic.product}:${lic.id}`) : false,
          product,
        });
      },
      onError: (err) => {
        setStep({ kind: "enter" });
        setServerError(claimError(err, product?.name ?? nameFor(slugToAdd)));
      },
    });
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (check.kind !== "valid") {
      setTouched(true);
      return;
    }
    setServerError(null);
    const slugNow = check.slug;
    preview.mutate(key, {
      onSuccess: (p) => {
        if (p.verdict === "addable" && p.product) {
          setStep({
            kind: "confirm",
            preview: p as ConfirmPreview,
            slug: slugNow,
          });
        } else if (p.verdict === "already_yours") {
          setStep({
            kind: "done",
            license: null,
            slug: p.product?.slug ?? slugNow,
            already: true,
            product: p.product ?? undefined,
          });
        } else {
          setServerError(previewError(p, nameFor(slugNow)));
        }
      },
      onError: (err) => {
        // A Worker without the preview: add directly, as before G22.
        if (err instanceof PortalApiError && err.status === 404) add(slugNow);
        else setServerError(claimError(err, nameFor(slugNow)));
      },
    });
  };

  const done = step.kind === "done" ? step : null;
  const confirm = step.kind === "confirm" ? step : null;
  const doneName = done
    ? (done.product?.name ?? done.license?.productName ?? nameFor(done.slug))
    : "";
  const confirmName = confirm?.preview.product.name ?? "";

  const openProduct = (s: string): void => {
    requestHeadingFocus(s);
    onOpenChange(false);
    navigate(href.product(s));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        done
          ? done.already
            ? `${doneName} is already in your library`
            : `${doneName} is in your library`
          : confirm
            ? `Add ${confirmName} to your account?`
            : "Activate a license"
      }
      description={
        done || confirm
          ? undefined
          : "Paste a key from a store, a developer or an email. The product joins your library and stays there, even if you lose the key."
      }
      size="md"
    >
      {confirm ? (
        <ConfirmStep
          preview={confirm.preview}
          licenseKey={key}
          adding={claim.isPending}
          onBack={() => setStep({ kind: "enter" })}
          onAdd={() => add(confirm.slug, confirm.preview.product)}
        />
      ) : done ? (
        <>
          <DialogBody className="space-y-4">
            <ProductArt
              slug={done.slug}
              name={doneName}
              tint={null}
              src={done.product?.headerUrl}
              variant="banner"
              className="h-36 rounded-lg"
            >
              <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full border border-success-border bg-surface-overlay px-2.5 py-1 text-xs font-bold text-success shadow-elevation-2">
                <Check aria-hidden className="size-3.5" />
                In your library
              </span>
            </ProductArt>
            <p className="text-fg">
              {done.already
                ? "This key's license was already linked to your account, so nothing changed."
                : "Download it, see your license and manage devices on its page. You won't need the key again."}
            </p>
          </DialogBody>
          {/* §8: side by side when both fit, primary last (right); otherwise stacked full
              width, primary last (bottom, nearest the thumb). */}
          <DialogFooter className="flex-row flex-wrap border-0 sm:flex-row sm:justify-start [&>*]:flex-[1_1_11rem]">
            <Button
              variant="outline"
              size="lg"
              className="h-11 font-bold"
              onClick={reset}
            >
              Activate another
            </Button>
            <Button
              size="lg"
              className="h-11 font-bold"
              iconEnd={<ArrowRight aria-hidden />}
              onClick={() => openProduct(done.slug)}
            >
              Open {doneName}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <DialogBody className="space-y-4">
            {fromProduct ? (
              <p className="flex gap-2 rounded-lg border border-info-border bg-info-subtle p-3 text-sm text-fg">
                <Info
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-info"
                />
                {nameFor(fromProduct)} sent you here. Add the key to your
                account and it stays in your library.
              </p>
            ) : null}
            <KeyField
              id={fieldId}
              value={key}
              autoFocus={!prefill}
              valid={check.kind === "valid" && !serverError}
              error={serverError ?? problem}
              onBlur={() => setTouched(true)}
              onChange={(v, how) => {
                setKey(v);
                setServerError(null);
                if (how === "paste") setTouched(true);
              }}
              hint={
                slug ? (
                  <p className="flex items-center gap-2 text-sm text-fg-muted">
                    <ProductIcon
                      slug={slug}
                      name={nameFor(slug)}
                      tint={null}
                      size={20}
                    />
                    <span>
                      Key for{" "}
                      <span className="font-bold text-fg-strong">
                        {nameFor(slug)}
                      </span>
                      {owned(slug) ? " · already in your library" : ""}
                    </span>
                  </p>
                ) : null
              }
              help={
                prefill
                  ? "Filled in from your link. Check it matches the key you have."
                  : "Paste the whole key. It starts with pkey_ and capital letters matter."
              }
            />
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              className="font-bold"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="font-bold"
              loading={preview.isPending || claim.isPending}
              disabled={check.kind !== "valid"}
            >
              Continue
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/**
 * The confirm step (§4.17 step 2): the art with the icon overlapping, "Key recognised", the
 * tier tag, the terms ("Lifetime · up to 5 devices") and platforms, the key echoed with
 * **Change key**, and **Back** / **Add <product>**.
 */
function ConfirmStep({
  preview,
  licenseKey,
  adding,
  onBack,
  onAdd,
}: {
  preview: ConfirmPreview;
  licenseKey: string;
  adding: boolean;
  onBack: () => void;
  onAdd: () => void;
}): React.ReactElement {
  const p = preview.product;
  const lic = preview.license;
  const tier = lic ? (lic.tierLabel ?? tierLabel(lic.tier)) : null;
  const terms = lic
    ? [
        lic.expiresAt === null
          ? "Lifetime"
          : `Until ${formatDay(lic.expiresAt)}`,
        lic.deviceLimit
          ? `up to ${lic.deviceLimit} ${lic.deviceLimit === 1 ? "device" : "devices"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const platforms = PLATFORM_ORDER.filter((k: PlatformKey) =>
    (preview.platforms ?? []).some((x) => normalisePlatform(x) === k),
  );
  return (
    <>
      <DialogBody className="space-y-4">
        <div>
          <ProductArt
            slug={p.slug}
            name={p.name}
            tint={null}
            src={p.headerUrl}
            variant="banner"
            letter={false}
            className="h-36 rounded-lg"
          />
          <ProductIcon
            slug={p.slug}
            name={p.name}
            tint={null}
            src={p.iconUrl}
            size={64}
            lift
            className="relative -mt-8 ml-4"
            tileClassName="border-[3px] border-surface-overlay"
          />
        </div>
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Check aria-hidden className="size-4 shrink-0 text-success" />
          <span>
            Key recognised ·{" "}
            <span className="font-bold text-fg-strong">{p.name}</span>
            {p.developerName ? ` · ${p.developerName}` : ""}
          </span>
        </p>
        {tier || terms ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
            {tier ? (
              <span className="inline-flex h-6 items-center rounded-md border border-border-strong px-2 text-xs text-fg-strong">
                {tier}
              </span>
            ) : null}
            {terms ? <span>{terms}</span> : null}
            <PlatformGlyphs platforms={platforms} className="ml-auto" />
          </div>
        ) : null}
        <div className="flex items-center gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
          <code className="min-w-0 flex-1 font-mono text-[0.8125rem] leading-5 [overflow-wrap:anywhere]">
            <span className="text-fg-subtle">pkey_</span>
            <span className="font-bold text-accent-fg">{p.slug}</span>
            <span className="text-fg-subtle">_</span>
            <span className="text-fg-strong">
              {licenseKey.slice(`pkey_${p.slug}_`.length)}
            </span>
          </code>
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-sm text-sm font-bold text-accent-fg hover:underline"
          >
            Change key
          </button>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" className="font-bold" onClick={onBack}>
          Back
        </Button>
        <Button className="font-bold" loading={adding} onClick={onAdd}>
          Add {p.name}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The preview's refusals in the person's words (§4.19), never a toast. */
export function previewError(
  p: PortalKeyPreview,
  fallbackName: string,
): string {
  const name = p.product?.name ?? fallbackName;
  switch (p.verdict) {
    case "license_owned":
      return `This ${name} license is already in another Polaris Key account. A license never moves by its key.`;
    case "email_mismatch":
      return `${name} was bought with ${p.maskedEmail ?? "another email"}. It joins only the account with that email verified.`;
    case "portal_off":
      return `${p.product?.developerName ?? name} manages this license elsewhere.`;
    default:
      return UNKNOWN_KEY;
  }
}

const UNKNOWN_KEY =
  "We couldn't find that key. Capital letters matter, and l, 1, O and 0 are easy to mix up, so paste the key instead of typing it.";

/** The claim's refusals in the person's words (§4.19), never a toast. */
export function claimError(err: unknown, name: string): string {
  if (err instanceof PortalApiError) {
    if (err.code === "license_owned")
      return `This ${name} license is already in another Polaris Key account. A license never moves by its key.`;
    if (err.code === "email_mismatch")
      return `${name} joins only the account with the license's email verified.`;
    if (err.status === 401) return UNKNOWN_KEY;
    if (err.status === 404) return `${name} manages this license elsewhere.`;
    if (err.status === 422)
      return "That isn't a Polaris Key license key. Ours start with pkey_.";
    if (err.status === 429)
      return "Too many tries. Wait a minute, then try again.";
  }
  const copy = portalErrorCopy(err);
  return `${copy.title}. ${copy.description}`;
}
