import * as React from "react";
import { flushSync } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  MonitorSmartphone,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import { toast } from "../../ui/toast.js";
import { Celebration, viewTransition } from "../../ui/motion/index.js";
import {
  PortalApiError,
  type PortalKeyPreview,
  type PortalLicenseSummary,
} from "../api.js";
import { browser } from "../browser.js";
import {
  useClaimKey,
  useLicenses,
  usePreviewKey,
  useProduct,
  useSession,
} from "../data.js";
import { portalErrorCopy } from "../errors.js";
import { requestHeadingFocus } from "../focus.js";
import {
  blocksResend,
  checkKey,
  claimVerdict,
  entriesVerdict,
  formatVerdict,
  noEntriesCopy,
  previewVerdict,
  productLabel,
  readEntries,
  slugOf,
  type KeyVerdict,
  type KeyVerdictExtras,
} from "../model/key.js";
import { formatDay, normalisePlatform, tierLabel } from "../model/library.js";
import { allowedReturn, cardReturn } from "../model/returnUrl.js";
import { href, navigate, type ActivateNext } from "../router.js";
import { PLATFORM_ORDER, PlatformGlyphs, type PlatformKey } from "./Glyphs.js";
import { KeyField } from "./KeyField.js";
import { ProductArt } from "./ProductArt.js";
import { ProductIcon } from "./ProductIcon.js";
import { t } from "../../lib/copy.js";

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
 *
 * **From an app** (§4.18, PX-17): the link's `product=` names who sent the person and why, as a
 * notice over the field; `next=free-device` (a floating license at its device limit, PX-W8 Q3)
 * goes straight to the free-device flow after the add; `return=` goes back to the login card
 * (`/signin?request=…`, plans/I-04.md) at once, or offers **Back to <product>** on Done for a
 * target the product declares (PX-10's rule). Nothing is followed that `model/returnUrl.ts`
 * refuses, and none of it ever carries the key.
 *
 * **Motion** (notes/S-23 §6.1 morph and success; MO-06): a step change is one `dialog` View
 * Transition with the panel as `pk-vt-dialog`: the old step leaves in `fast`, the new one comes
 * in after `micro` while the panel morphs its size at `moderate`; focus moves on
 * `updateCallbackDone`, when the new step is in the DOM. The first add on an account shows the
 * success moment on Done (`<Celebration momentKey="first-activation:<account>">`: the check
 * draws and six sparks burst, once per account); every later Done shows the check only. Under
 * reduced motion the step swaps at once and the check is static.
 */
export type ConfirmPreview = PortalKeyPreview &
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
      /** From the preview: the devices that came with it (PX-23), and whether Cloud Sync runs. */
      devices?: number;
      cloudSync?: boolean;
    };

/** Why an app's link sent the person here, from what it carries (§4.18). */
type LinkContext = "entries" | "free-device" | "card";

export function ActivateDialog({
  open,
  prefill,
  fromProduct,
  next,
  forDevice,
  returnTo,
  onOpenChange,
}: {
  open: boolean;
  /** A key from `/activate#key=…`, filled in and checked. */
  prefill?: string;
  /** The product slug an app sent along (`&product=`). */
  fromProduct?: string;
  /** `next=free-device`: after the add, the free-device flow for that license. */
  next?: ActivateNext;
  /** `for=`: the device the free-device flow frees a seat for. */
  forDevice?: string;
  /** `return=`, as the link carried it; validated before it is followed. */
  returnTo?: string;
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
  const accountId = useSession().data?.account.id ?? null;
  const fieldId = React.useId();
  const noticeId = React.useId();
  /** Set while the page leaves for the login card, so the busy state holds until it unloads. */
  const [leaving, setLeaving] = React.useState(false);
  const toCard = cardReturn(returnTo, window.location.origin);
  const linkContext: LinkContext | null = !fromProduct
    ? null
    : next === "free-device"
      ? "free-device"
      : toCard
        ? "card"
        : "entries";

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
   * Focus follows the step (FLOWS.md §2 C18, P-5): a new step's heading takes focus once it is in
   * the DOM, so a screen reader hears where it is and focus never stays on the dialog itself;
   * coming back to the key (Back, Change key, a refused claim) puts it on the field. A refusal
   * (an inline verdict) also puts focus on the field: Continue is disabled until the key
   * changes, and a disabled button that held focus would drop it to `body`.
   */
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  /** The step on screen now (a step change in flight has not landed yet). */
  const stepRef = React.useRef(step);
  stepRef.current = step;

  /**
   * Change step (with `also`, the state that changes with it) in one `dialog` View Transition:
   * the update runs once the old step is captured, and focus moves when it has landed
   * (`updateCallbackDone`), never after the animation. Without the API or under reduced motion
   * the update runs here and focus moves right after: the same end state, at once. A step change
   * made while another is in flight is the newer one: the running transition is skipped to its
   * end, its update lands first and this one after it, and focus follows the step that is on
   * screen when each lands.
   */
  const goTo = (next: Step, also?: () => void): void => {
    const apply = (): void => {
      also?.();
      setStep(next);
    };
    if (stepRef.current.kind === next.kind) {
      apply();
      return;
    }
    const handle = viewTransition(() => flushSync(apply), { type: "dialog" });
    void handle.updateCallbackDone.then(() => {
      if (stepRef.current.kind !== next.kind) return;
      if (next.kind === "enter") focusField();
      else focusDialogHeading(anchorRef.current);
    });
  };

  React.useEffect(() => {
    if (!serverVerdict || step.kind !== "enter") return;
    const frame = requestAnimationFrame(focusField);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverVerdict]);

  const reset = (): void => {
    goTo({ kind: "enter" }, () => {
      setKey("");
      setTouched(false);
      setServerVerdict(null);
      claim.reset();
      preview.reset();
    });
  };

  /**
   * The key's license is in the library now (added, or it already was): go where the link said
   * (§4.18). `next=free-device` opens the free-device flow for that license, carrying `for=` and
   * `return=` (the flow checks `return=` against the product's declared targets itself);
   * a `return=` to the login card goes back to it; anything else shows Done.
   */
  const finish = (
    done: Extract<Step, { kind: "done" }>,
    licenseId: string | undefined = done.license?.id,
  ): void => {
    const name =
      done.product?.name ?? done.license?.productName ?? nameFor(done.slug);
    if (next === "free-device") {
      if (!done.already) toast.success(`${name} is in your library`);
      const params: Record<string, string> = {};
      if (licenseId) params.license = licenseId;
      if (forDevice) params.for = forDevice;
      if (returnTo) params.return = returnTo;
      requestHeadingFocus(done.slug);
      onOpenChange(false);
      navigate(href.focused(done.slug, "free-device", params));
      return;
    }
    if (toCard) {
      setLeaving(true);
      browser.go(toCard);
      return;
    }
    goTo(done);
  };

  /** Add the key (the claim); refusals go back to the enter step, inline. */
  const add = (slugToAdd: string, confirmed?: ConfirmPreview): void => {
    const product = confirmed?.product;
    const before = new Set(
      (licenses.data ?? []).map((l) => `${l.product}:${l.id}`),
    );
    claim.mutate(key, {
      onSuccess: (res) => {
        const lic = res.license;
        finish({
          kind: "done",
          license: lic,
          slug: lic?.product ?? slugToAdd,
          already: lic ? before.has(`${lic.product}:${lic.id}`) : false,
          product,
          devices: confirmed?.devices,
          cloudSync: confirmed?.cloudSync,
        });
      },
      onError: (err) => {
        const verdict = claimError(err, product?.name ?? nameFor(slugToAdd));
        goTo({ kind: "enter" }, () => setServerVerdict(verdict));
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
          goTo({
            kind: "confirm",
            preview: p as ConfirmPreview,
            slug: slugNow,
          });
        } else if (p.verdict === "already_yours") {
          finish(
            {
              kind: "done",
              license: null,
              slug: p.product?.slug ?? slugNow,
              already: true,
              product: p.product ?? undefined,
            },
            p.license?.id,
          );
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
      describedBy={
        !done && !confirm && fromProduct && linkContext ? noticeId : undefined
      }
      size="md"
      className="pk-vt-dialog"
    >
      <span ref={anchorRef} hidden />
      {confirm ? (
        <ConfirmStep
          preview={confirm.preview}
          licenseKey={key}
          adding={claim.isPending || leaving}
          onBack={() => goTo({ kind: "enter" })}
          onAdd={() => add(confirm.slug, confirm.preview)}
          notes={<DevicesNote count={confirm.preview.devices} step="confirm" />}
        />
      ) : done ? (
        <DoneStep
          slug={done.slug}
          name={doneName}
          headerUrl={done.product?.headerUrl}
          already={done.already}
          devices={done.already ? undefined : done.devices}
          cloudSync={done.cloudSync === true}
          appReturn={toCard ? undefined : returnTo}
          momentKey={
            accountId && !done.already
              ? `first-activation:${accountId}`
              : undefined
          }
          onAnother={reset}
          onOpen={() => openProduct(done.slug)}
        />
      ) : (
        <form onSubmit={submit} noValidate>
          <DialogBody className="space-y-4">
            {fromProduct && linkContext ? (
              <LinkNotice
                id={noticeId}
                slug={fromProduct}
                name={nameFor(fromProduct)}
                context={linkContext}
                forDevice={forDevice}
              />
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
                        verdict.code === "license_owned" ||
                        verdict.code === "email_mismatch" ? (
                          <RefusalActions
                            signInUrl={verdict.signInUrl}
                            onDifferentKey={() => {
                              setKey("");
                              setTouched(false);
                              setServerVerdict(null);
                              focusField();
                            }}
                            onAddEmail={
                              verdict.code === "email_mismatch"
                                ? () => {
                                    // PX-13: Account → Sign-in methods with Add an email open. The
                                    // masked address can't be filled in; the person types theirs.
                                    onOpenChange(false);
                                    navigate(
                                      href.account("methods", { add: "email" }),
                                    );
                                  }
                                : undefined
                            }
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
                      <span className="font-medium text-fg-strong">
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
              className="font-medium"
              onClick={() => onOpenChange(false)}
            >
              {t("signin.cancel")}
            </Button>
            <Button
              type="submit"
              className="font-medium"
              loading={preview.isPending || claim.isPending || leaving}
              disabled={check.kind === "empty" || blocksResend(serverVerdict)}
            >
              {t("signin.continue")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/**
 * A refused key's way forward (EXPERIENCE.md §0.6 P1 frame 5; SIGN-IN.md §3.9): **Use a
 * different key** always, for `license_owned` and `email_mismatch`; **Sign in to that account**
 * once the Worker names where (`license_owned` only, I-09's `signInUrl`); **Add and verify that
 * email** for `email_mismatch` (PORTAL.md §4.19), which opens Account → Sign-in methods with
 * Add an email open (PX-13).
 */
function RefusalActions({
  signInUrl,
  onDifferentKey,
  onAddEmail,
}: {
  signInUrl?: string;
  onDifferentKey: () => void;
  onAddEmail?: () => void;
}): React.ReactElement {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="font-medium"
        onClick={onDifferentKey}
      >
        {t("signin.key.differentKey")}
      </Button>
      {onAddEmail ? (
        <Button
          variant="outline"
          size="sm"
          className="font-medium"
          onClick={onAddEmail}
        >
          Add and verify that email
        </Button>
      ) : null}
      {signInUrl ? (
        <Button
          variant="outline"
          size="sm"
          className="font-medium"
          onClick={() => window.location.assign(signInUrl)}
        >
          {t("signin.key.ownedSignIn")}
        </Button>
      ) : null}
    </>
  );
}

/**
 * Who sent the person here, and why (§4.18; SIGN-IN.md §3.9), over the field: the product's icon
 * and "<Product> sent you here." An app at its key-entry limit (`manageUrl` =
 * `/activate?product=…`) gets `signin.key.noEntries`, a `warning` that never blocks (Q-5); a
 * floating license at its device limit (`next=free-device`) says the free-device flow follows;
 * the login card (`return=/signin?…`) says the person goes back to it.
 */
function LinkNotice({
  id,
  slug,
  name,
  context,
  forDevice,
}: {
  /** Named by the dialog's `aria-describedby`, so a screen reader hears it on open. */
  id: string;
  slug: string;
  name: string;
  context: LinkContext;
  forDevice?: string;
}): React.ReactElement {
  const lead =
    context === "card" ? `Signing in to ${name}.` : `${name} sent you here.`;
  const body =
    context === "entries"
      ? noEntriesCopy(name)
      : context === "free-device"
        ? `This license is on every device it allows. Add it to your account, then free one up${forDevice ? ` for ${forDevice}` : ""}.`
        : "Add your key here, then you go back to signing in.";
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border p-3 text-sm text-fg",
        context === "card"
          ? "border-info-border bg-info-subtle"
          : "border-warning-border bg-warning-subtle",
      )}
    >
      <ProductIcon
        slug={slug}
        name={name}
        tint={null}
        size={24}
        className="mt-0.5 shrink-0"
      />
      <p id={id} className="min-w-0 [overflow-wrap:anywhere]">
        <strong className="font-semibold text-fg-strong">{lead}</strong> {body}
      </p>
    </div>
  );
}

/**
 * Done (§4.17 step 3): the art with **In your library**, then **Activate another** and **Open
 * <product>**. When the link's `return=` is a target the product declares (`GET
 * /api/products/<p>` `returnTo`, PX-10's rule), the way forward is the app that sent the person:
 * **Back to <product>**, with **See it in your library** beside it. An undeclared target is
 * dropped and Done stays as it is.
 *
 * An add carries `momentKey`: the plate's check is the success moment (EXPERIENCE §0.7, S-23 D5),
 * which draws and bursts the first time the key is seen and is a still check after that (and
 * under reduced motion). The plate sits over the art, outside its clipping box, so the sparks are
 * never cut off. A key that was already yours changed nothing: the plate keeps its plain check.
 */
function DoneStep({
  slug,
  name,
  headerUrl,
  already,
  devices,
  cloudSync,
  appReturn,
  momentKey,
  onAnother,
  onOpen,
}: {
  slug: string;
  name: string;
  headerUrl?: string | null;
  already: boolean;
  /** The devices that came with it (PX-23); none or absent says nothing. */
  devices?: number;
  /** Cloud Sync runs, so signing in on those devices turns it on. */
  cloudSync: boolean;
  /** The link's `return=`, not yet validated; absent for the login card (gone to already). */
  appReturn?: string;
  /** `first-activation:<account>` for an add; absent when nothing was added. */
  momentKey?: string;
  onAnother: () => void;
  onOpen: () => void;
}): React.ReactElement {
  const product = useProduct(slug, { enabled: Boolean(appReturn) });
  const back =
    appReturn && product.data
      ? allowedReturn(appReturn, product.data.returnTo)
      : null;
  const lede = back
    ? already
      ? `It was already in your account. Go back to ${name} and sign in.`
      : `Go back to ${name} and sign in. You won't need the key again.`
    : already
      ? "This key's license was already linked to your account, so nothing changed."
      : "Download it, see your license and manage devices on its page. You won't need the key again.";
  return (
    <>
      <DialogBody className="space-y-4">
        <div className="relative">
          <ProductArt
            slug={slug}
            name={name}
            tint={null}
            src={headerUrl}
            variant="banner"
            className="h-36 rounded-lg"
          />
          <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full border border-success-border bg-surface-overlay px-2.5 py-1 text-xs font-medium text-success shadow-elevation-2">
            {momentKey ? (
              <Celebration momentKey={momentKey} size={14} />
            ) : (
              <Check aria-hidden className="size-3.5" />
            )}
            In your library
          </span>
        </div>
        <p className="text-fg">{lede}</p>
        <DevicesNote count={devices} step="done" cloudSync={cloudSync} />
      </DialogBody>
      {/* §8: side by side when both fit, primary last (right); otherwise stacked full
          width, primary last (bottom, nearest the thumb). */}
      <DialogFooter className="flex-row flex-wrap border-0 sm:flex-row sm:justify-start [&>*]:flex-[1_1_11rem]">
        {back ? (
          <>
            <Button
              variant="outline"
              size="lg"
              className="h-11 font-medium"
              onClick={onOpen}
            >
              See it in your library
            </Button>
            <Button asChild size="lg" className="h-11 font-medium">
              <a href={back}>Back to {name}</a>
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="lg"
              className="h-11 font-medium"
              onClick={onAnother}
            >
              Activate another
            </Button>
            <Button
              size="lg"
              className="h-11 font-medium"
              iconEnd={<ArrowRight aria-hidden />}
              onClick={onOpen}
            >
              Open {name}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * A floating key's devices (notes/S-24 §10, D22; PX-23): on Confirm, "It's on 2 devices already.
 * They keep working and come with it."; on Done, "Its 2 devices came with it." and, when the
 * product runs Cloud Sync, "Sign in on them to turn on Cloud Sync." (the devices keep their
 * seats and tokens; only signing in on each one turns Cloud Sync on). Nothing for a licence on
 * no device, or when the Worker did not say.
 */
function DevicesNote({
  count,
  step,
  cloudSync = false,
}: {
  count?: number;
  step: "confirm" | "done";
  cloudSync?: boolean;
}): React.ReactElement | null {
  if (!count || count < 1) return null;
  const one = count === 1;
  const devices = one ? "1 device" : `${count} devices`;
  const lead =
    step === "confirm"
      ? `It's on ${devices} already.`
      : `Its ${devices} came with it.`;
  const rest =
    step === "confirm"
      ? one
        ? "It keeps working and comes with it."
        : "They keep working and come with it."
      : cloudSync
        ? `Sign in on ${one ? "it" : "them"} to turn on Cloud Sync.`
        : null;
  return (
    <p className="flex gap-3 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-fg">
      <MonitorSmartphone
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-accent-fg"
      />
      <span>
        <strong className="font-semibold text-fg-strong">{lead}</strong>
        {rest ? ` ${rest}` : null}
      </span>
    </p>
  );
}

/**
 * The confirm step (§4.17 step 2): the art with the icon overlapping, "Key recognized", the
 * tier tag, the terms ("Lifetime · up to 5 devices") and platforms, the key echoed with
 * **Change key**, the entries notice when the key has used its entries (a warning; Add stays
 * enabled, Q-5), and **Back** / **Add <product>**.
 *
 * The login card's KeyStep (PX-14, SIGN-IN.md §3.9) renders this same step: in passthrough the
 * primary is **Add and use on this device** (`signin.key.addAndUse`, `primaryLabel`), and the
 * confirm is the license choice. `notes` sits under the key, beside the entries notice, for
 * PX-23's "It's on {n} devices already. They keep working and come with it." (S-24 §10).
 */
export function ConfirmStep({
  preview,
  licenseKey,
  adding,
  onBack,
  onAdd,
  primaryLabel,
  notes,
}: {
  preview: ConfirmPreview;
  licenseKey: string;
  adding: boolean;
  onBack: () => void;
  onAdd: () => void;
  /** The primary's words; `Add <product>` by default. */
  primaryLabel?: string;
  /** More lines about what adding does, under the key. */
  notes?: React.ReactNode;
}): React.ReactElement {
  const p = preview.product;
  const lic = preview.license;
  const tier = lic ? (lic.tierLabel ?? tierLabel(lic.tier)) : null;
  const terms = lic
    ? [
        lic.expiresAt === null
          ? t("signin.term.lifetime")
          : t("signin.term.until", { date: formatDay(lic.expiresAt) }),
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
            // No cover: a bare tint field; the icon overlapping the art already shows the letter.
            letter={false}
            // A short screen (§8) drops the art, so the facts and the key start on the first
            // screen; the icon, in a row of its own, carries the product's identity.
            className="h-36 rounded-lg short:hidden"
          />
          <ProductIcon
            slug={p.slug}
            name={p.name}
            tint={null}
            src={p.iconUrl}
            size={64}
            lift
            className="relative -mt-8 ml-4 short:mt-0 short:ml-0"
            tileClassName="border-[3px] border-surface-overlay"
          />
        </div>
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Check aria-hidden className="size-4 shrink-0 text-success" />
          <span>
            Key recognized ·{" "}
            <span className="font-medium text-fg-strong">{p.name}</span>
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
          <code className="min-w-0 flex-1 font-mono text-code leading-5 [overflow-wrap:anywhere]">
            <span className="text-fg-subtle">pkey_</span>
            <span className="font-medium text-accent-fg">{p.slug}</span>
            <span className="text-fg-subtle">_</span>
            <span className="text-fg-strong">
              {licenseKey.slice(`pkey_${p.slug}_`.length)}
            </span>
          </code>
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-sm text-sm font-medium text-accent-fg hover:underline"
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
        {notes}
      </DialogBody>
      <DialogFooter>
        <Button
          variant="outline"
          className="shrink-0 font-medium"
          onClick={onBack}
        >
          {t("signin.replace.back")}
        </Button>
        {/* A long product name is cut short with an ellipsis rather than spilling out of the
            button (PS-05 review M5); the name is read in full (the label, the heading above). */}
        <Button
          className="min-w-0 font-medium"
          loading={adding}
          onClick={onAdd}
          aria-label={primaryLabel ?? `Add ${p.name}`}
        >
          <span className="truncate">{primaryLabel ?? `Add ${p.name}`}</span>
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
