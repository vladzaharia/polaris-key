import * as React from "react";
import { AlertTriangle, ArrowRight, Check, Info } from "lucide-react";
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
import {
  blocksResend,
  checkKey,
  claimVerdict,
  entriesVerdict,
  formatVerdict,
  previewVerdict,
  productLabel,
  readEntries,
  slugOf,
  type KeyVerdict,
  type KeyVerdictExtras,
} from "../model/key.js";
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
 * Continue: the product is named from the key's own prefix, by its presentation name (the
 * account's own name for it, else the slug as words), never the slug itself.
 *
 * Every verdict (format, refusal, the entries notice) is one `KeyVerdict` from `model/key.ts`,
 * shown inline under the field with its actions (EXPERIENCE.md §0.6 P1 step 4, UX-05).
 */
type ConfirmPreview = PortalKeyPreview &
  KeyVerdictExtras & {
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
  const [serverVerdict, setServerVerdict] = React.useState<KeyVerdict | null>(
    null,
  );
  /** Names the Worker has told us (the preview), by slug: they win over everything else. */
  const [names, setNames] = React.useState<Record<string, string>>({});
  const claim = useClaimKey();
  const preview = usePreviewKey();
  const licenses = useLicenses(open);
  const fieldId = React.useId();

  const check = checkKey(key);
  const slug = check.kind === "valid" ? check.slug : slugOf(key);
  const nameFor = (s: string): string =>
    productLabel(
      s,
      names[s] ?? licenses.data?.find((l) => l.product === s)?.productName,
    );
  const owned = (s: string) =>
    licenses.data?.some((l) => l.product === s) ?? false;
  const problem =
    touched || check.kind === "notKey" ? formatVerdict(check) : null;
  const verdict = serverVerdict ?? problem;

  const focusField = (): void => {
    document.getElementById(fieldId)?.focus();
  };

  /*
   * Focus follows the step (FLOWS.md §2 C18, P-5): a new step's heading takes focus once it has
   * rendered, so a screen reader hears where it is and focus never stays on the dialog itself;
   * coming back to the key (Back, Change key, a refused claim) puts it on the field. A refusal
   * (an inline verdict) also puts focus on the field: Continue is disabled until the key
   * changes, and a disabled button that held focus would drop it to `body`.
   */
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  const lastStep = React.useRef<Step["kind"]>(step.kind);
  React.useEffect(() => {
    if (lastStep.current === step.kind) return;
    lastStep.current = step.kind;
    const frame = requestAnimationFrame(() => {
      if (step.kind === "enter") focusField();
      else focusDialogHeading(anchorRef.current);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind]);
  React.useEffect(() => {
    if (!serverVerdict || step.kind !== "enter") return;
    const frame = requestAnimationFrame(focusField);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverVerdict]);

  const reset = (): void => {
    setKey("");
    setTouched(false);
    setServerVerdict(null);
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
        setServerVerdict(claimError(err, product?.name ?? nameFor(slugToAdd)));
      },
    });
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (check.kind !== "valid") {
      setTouched(true);
      focusField();
      return;
    }
    setServerVerdict(null);
    const slugNow = check.slug;
    preview.mutate(key, {
      onSuccess: (p) => {
        const named = p.product;
        if (named?.name)
          setNames((n) => ({
            ...n,
            [named.slug]: named.name,
            [slugNow]: named.name,
          }));
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
          setServerVerdict(previewVerdict(p, nameFor(slugNow)));
        }
      },
      onError: (err) => {
        // A Worker without the preview: add directly, as before G22.
        if (err instanceof PortalApiError && err.status === 404) add(slugNow);
        else setServerVerdict(claimError(err, nameFor(slugNow)));
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
          : "The product stays in your library even if you lose the key."
      }
      size="md"
    >
      <span ref={anchorRef} hidden />
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
              valid={check.kind === "valid" && !serverVerdict}
              verdict={
                verdict
                  ? {
                      tone: verdict.tone,
                      message: verdict.message,
                      actions:
                        verdict.code === "license_owned" ? (
                          <OwnedActions
                            signInUrl={verdict.signInUrl}
                            onDifferentKey={() => {
                              setKey("");
                              setTouched(false);
                              setServerVerdict(null);
                              focusField();
                            }}
                          />
                        ) : undefined,
                    }
                  : null
              }
              onBlur={() => setTouched(true)}
              onChange={(v, how) => {
                setKey(v);
                setServerVerdict(null);
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
                  : "Starts with pkey_. Case-sensitive."
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
              disabled={check.kind === "empty" || blocksResend(serverVerdict)}
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
 * `license_owned`'s way forward (EXPERIENCE.md §0.6 P1 frame 5): **Use a different key** always;
 * **Sign in to that account** once the Worker names where (I-09's `signInUrl`).
 */
function OwnedActions({
  signInUrl,
  onDifferentKey,
}: {
  signInUrl?: string;
  onDifferentKey: () => void;
}): React.ReactElement {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="font-bold"
        onClick={onDifferentKey}
      >
        Use a different key
      </Button>
      {signInUrl ? (
        <Button
          variant="outline"
          size="sm"
          className="font-bold"
          onClick={() => window.location.assign(signInUrl)}
        >
          Sign in to that account
        </Button>
      ) : null}
    </>
  );
}

/**
 * The confirm step (§4.17 step 2): the art with the icon overlapping, "Key recognized", the
 * tier tag, the terms ("Lifetime · up to 5 devices") and platforms, the key echoed with
 * **Change key**, the entries notice when the key has used its entries (a warning; Add stays
 * enabled, Q-5), and **Back** / **Add <product>**.
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
  const entries = entriesVerdict(readEntries(preview), p.name);
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
            Key recognized ·{" "}
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
        {entries ? (
          <p
            role="status"
            className="flex gap-2 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm text-fg"
          >
            <AlertTriangle
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
            <span>{entries.message}</span>
          </p>
        ) : null}
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

/**
 * Focus the open dialog's title (`ui/Dialog` renders it as the dialog's one heading), made
 * programmatically focusable first. `from` is any element inside the dialog.
 */
function focusDialogHeading(from: HTMLElement | null): void {
  const heading = from
    ?.closest('[role="dialog"], [role="alertdialog"]')
    ?.querySelector<HTMLElement>("h1, h2");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.classList.add("outline-none");
  heading.focus();
}

/** A failed preview or claim as a verdict (§4.19), never a toast. */
function claimError(err: unknown, name: string): KeyVerdict {
  if (err instanceof PortalApiError) {
    const v = claimVerdict(err, name);
    if (v) return v;
  }
  const copy = portalErrorCopy(err);
  return {
    code: "failed",
    tone: "danger",
    message: `${copy.title}. ${copy.description}`,
  };
}
