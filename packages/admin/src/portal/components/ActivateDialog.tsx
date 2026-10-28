import * as React from "react";
import { flushSync } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  MonitorSmartphone,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Avatar } from "./Avatar.js";
import { Button } from "../../ui/Button.js";
import { announce } from "../../ui/LiveRegion.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import { toast } from "../../ui/toast.js";
import { Celebration, viewTransition } from "../../ui/motion/index.js";
import {
  HttpError,
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
import { href, navigateFromModal, type ActivateNext } from "../router.js";
import {
  PLATFORM_ORDER,
  PlatformGlyphs,
  type PlatformKey,
} from "../../ui/Glyphs.js";
import { helpForRefusal } from "../helpLinks.js";
import { HelpLink } from "./HelpLink.js";
import { KeyField } from "./KeyField.js";
import { ProductArt } from "./ProductArt.js";
import { ProductIcon } from "./ProductIcon.js";
import { t, tParts } from "../../lib/copy.js";

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
  onDraft,
}: {
  open: boolean;
  /** Told the key as it is typed ("" once the add is done), so a dismissal keeps it. */
  onDraft?: (key: string) => void;
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
  React.useEffect(() => {
    onDraft?.(step.kind === "done" ? "" : key);
    // The callback is a ref write in the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, step.kind]);
  const [serverVerdict, setServerVerdict] = React.useState<KeyVerdict | null>(
    null,
  );
  /** A claim that failed on the confirm step for a reason that is not the key's (B-083). */
  const [addError, setAddError] = React.useState<string | null>(null);
  /** Names the Worker has told us (the preview), by slug: they win over everything else. */
  const [names, setNames] = React.useState<Record<string, string>>({});
  const claim = useClaimKey();
  const preview = usePreviewKey();
  /** Single-flight: set at the press, cleared when the request settles. `isPending` only turns
   *  true after a re-render, so a quick second press would otherwise send a second request. */
  const inFlight = React.useRef(false);
  const licenses = useLicenses(open);
  const account = useSession().data?.account;
  const accountId = account?.id ?? null;
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
   * coming back to the key (Back, Change key, a refused claim) puts it on the field. After a claim
   * focus goes to Done's primary action (Open, or Back to the app) with the outcome announced once
   * (BRAND-TRANSITION B12). A refusal (an inline verdict) also puts focus on the field: Continue
   * is disabled until the key changes, and a disabled button that held focus would drop it to
   * `body`.
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
      else if (next.kind === "done") {
        focusDonePrimary(anchorRef.current);
        announce(
          next.already
            ? t("locker.activate.alreadyIn", { product: doneNameOf(next) })
            : t("locker.discover.added", { product: doneNameOf(next) }),
        );
      } else focusDialogHeading(anchorRef.current);
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
      if (!done.already)
        toast.success(t("locker.discover.added", { product: name }));
      const params: Record<string, string> = {};
      if (licenseId) params.license = licenseId;
      if (forDevice) params.for = forDevice;
      if (returnTo) params.return = returnTo;
      requestHeadingFocus(done.slug);
      onOpenChange(false);
      navigateFromModal(href.focused(done.slug, "free-device", params));
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
    if (inFlight.current) return;
    inFlight.current = true;
    setAddError(null);
    claim.mutate(key, {
      onSettled: () => {
        inFlight.current = false;
      },
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
        // A failure that is not the key's (a server error, the network, a rate limit) leaves the
        // person on the confirm step with the verdict under the key and Add to retry; a refusal
        // about the key goes back to the field, where its actions are (B-083).
        if (confirmed && keepsConfirm(verdict.code)) {
          setAddError(verdict.message);
          return;
        }
        goTo({ kind: "enter" }, () => setServerVerdict(verdict));
      },
    });
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (check.kind !== "valid") {
      setTouched(true);
      // An empty field is answered at the field, in words.
      if (check.kind === "empty")
        setServerVerdict({
          code: "failed",
          tone: "danger",
          message: t("signin.key.enterKey"),
        });
      focusField();
      return;
    }
    // A refusal the same key would get again: back to the field, nothing sent.
    if (blocksResend(serverVerdict)) {
      focusField();
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setServerVerdict(null);
    const slugNow = check.slug;
    preview.mutate(key, {
      onSettled: () => {
        inFlight.current = false;
      },
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
        if (err instanceof HttpError && err.status === 404) {
          inFlight.current = false;
          add(slugNow);
        } else setServerVerdict(claimError(err, nameFor(slugNow)));
      },
    });
  };

  const done = step.kind === "done" ? step : null;
  const confirm = step.kind === "confirm" ? step : null;
  const doneNameOf = (d: Extract<Step, { kind: "done" }>): string =>
    d.product?.name ?? d.license?.productName ?? nameFor(d.slug);
  const doneName = done ? doneNameOf(done) : "";
  const confirmName = confirm?.preview.product.name ?? "";

  const openProduct = (s: string): void => {
    requestHeadingFocus(s);
    onOpenChange(false);
    navigateFromModal(href.product(s));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape on Done leaves for the product: focus follows to its page heading.
        if (!next && done) requestHeadingFocus(done.slug);
        onOpenChange(next);
      }}
      title={
        done
          ? done.already
            ? t("locker.activate.alreadyIn", { product: doneName })
            : t("locker.discover.added", { product: doneName })
          : confirm
            ? t("locker.activate.addAsk", { product: confirmName })
            : t("common.activateLicense")
      }
      description={done || confirm ? undefined : t("locker.activate.stays")}
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
          error={addError}
          onBack={() => goTo({ kind: "enter" }, () => setAddError(null))}
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
        <form
          onSubmit={submit}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
        >
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
            {account ? <AccountRow account={account} /> : null}
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
                        verdict.code === "portal_off" ||
                        verdict.code === "email_mismatch" ? (
                          <RefusalActions
                            help={helpForRefusal(verdict.code)}
                            ownedNotice={verdict.code === "license_owned"}
                            nextStep={
                              verdict.code === "portal_off"
                                ? t("locker.key.managedElsewhereNext")
                                : undefined
                            }
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
                                    navigateFromModal(
                                      href.account("methods", { add: "email" }),
                                    );
                                  }
                                : undefined
                            }
                          />
                        ) : helpForRefusal(verdict.code) ? (
                          <div className="basis-full text-start">
                            <HelpLink href={helpForRefusal(verdict.code)!}>
                              {t("locker.help.whatToDo")}
                            </HelpLink>
                          </div>
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
                      {tParts("locker.activate.keyFor", ["product"]).map(
                        (part, i) =>
                          typeof part === "string" ? (
                            part
                          ) : (
                            <span
                              key={i}
                              className="font-medium text-fg-strong"
                            >
                              {nameFor(slug)}
                            </span>
                          ),
                      )}
                      {owned(slug) ? ` · ${t("locker.activate.keyOwned")}` : ""}
                    </span>
                  </p>
                ) : null
              }
              // The format help stays under the verdict lines (portal.activate); a key from a
              // link keeps its own line (B-087).
              help={
                prefill
                  ? t("locker.activate.prefillHelp")
                  : t("signin.key.help")
              }
            />
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              className="font-medium max-sm:min-h-11"
              onClick={() => onOpenChange(false)}
            >
              {t("signin.cancel")}
            </Button>
            {serverVerdict?.code === "license_owned" ? (
              // The refusal's lead action is the primary: join the account that holds the key.
              <Button
                type="button"
                className="font-medium max-sm:min-h-11"
                onClick={() => {
                  onOpenChange(false);
                  navigateFromModal("#/account/link");
                }}
              >
                {t("signin.join.title")}
              </Button>
            ) : (
              <Button
                type="submit"
                // After a refusal, Continue would only repeat it: "Use a different key" leads.
                variant={serverVerdict ? "outline" : undefined}
                className="font-medium max-sm:min-h-11"
                loading={preview.isPending || claim.isPending || leaving}
              >
                {t("signin.continue")}
              </Button>
            )}
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
  help,
  ownedNotice,
  nextStep,
  onDifferentKey,
  onAddEmail,
}: {
  /** The Help page for this refusal (helpLinks.ts). */
  help?: string | undefined;
  /** Signed in on the portal, `license_owned`: say the account may be theirs (SIGN-IN.md D-27). */
  ownedNotice?: boolean;
  /** `portal_off`: where to go next, since the key can't be added here (LF3). */
  nextStep?: string | undefined;
  onDifferentKey: () => void;
  onAddEmail?: () => void;
}): React.ReactElement {
  return (
    <>
      {ownedNotice ? (
        <p className="basis-full text-sm text-fg-muted">
          {t("signin.join.ownedNotice")}
        </p>
      ) : null}
      {nextStep ? (
        <p className="basis-full text-sm text-fg-muted">{nextStep}</p>
      ) : null}
      {help ? (
        <div className="basis-full text-start">
          <HelpLink href={help}>{t("locker.help.whatToDo")}</HelpLink>
        </div>
      ) : null}
      <Button
        // The refusal's way forward is the action; where the footer leads with Join (the account
        // may be theirs), it stays a quiet link instead of a second primary.
        variant={ownedNotice ? "ghost" : "neutral"}
        size="sm"
        className={cn(
          "font-medium max-sm:min-h-11 max-sm:w-full",
          ownedNotice && "underline decoration-2 underline-offset-4",
        )}
        onClick={onDifferentKey}
      >
        {t("signin.key.differentKey")}
      </Button>
      {onAddEmail ? (
        <Button
          variant="outline"
          size="sm"
          className="font-medium max-sm:min-h-11 max-sm:w-full"
          onClick={onAddEmail}
        >
          {t("locker.activate.addVerify")}
        </Button>
      ) : null}
    </>
  );
}

/**
 * Which account the key joins (§4.17 step 1): the avatar, the name (only when there is one that
 * is not the email) and the primary email, wrapping rather than truncating. The avatar is
 * decorative; the group's label tells a screen reader what the row is.
 */
function AccountRow({
  account,
}: {
  account: {
    name?: string | null;
    email: string;
    avatarUrl?: string | null;
  };
}): React.ReactElement {
  const name = account.name?.trim();
  const named = Boolean(name) && name !== account.email;
  const group = (
    <div
      role="group"
      aria-label={t("locker.activate.account")}
      className="flex min-w-0 flex-1 basis-40 items-center gap-3"
    >
      <Avatar
        name={account.name}
        email={account.email}
        picture={account.avatarUrl}
        size={40}
        className="@max-[18rem]:hidden"
      />
      <div className="flex min-w-0 flex-col gap-0.5 text-sm [overflow-wrap:anywhere]">
        {named ? (
          <span dir="auto" className="min-w-0 font-medium text-fg-strong">
            {name}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0",
            named ? "text-fg-muted" : "font-medium text-fg-strong",
          )}
        >
          {account.email}
        </span>
      </div>
    </div>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-surface-sunken px-3 py-2">
      {group}
      {/* The dialog's own form wraps this row, and forms do not nest: a detached POST form. */}
      <button
        type="button"
        onClick={() => {
          const f = document.createElement("form");
          f.method = "post";
          f.action = "/logout";
          f.hidden = true;
          document.body.append(f);
          f.submit();
        }}
        className="inline-flex min-h-11 shrink-0 items-center rounded-sm text-sm font-medium text-fg-strong underline underline-offset-2"
      >
        {t("signin.notYou")}
      </button>
    </div>
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
    context === "card"
      ? t("locker.activate.leadCard", { product: name })
      : t("locker.activate.leadSent", { product: name });
  const body =
    context === "entries"
      ? noEntriesCopy(name)
      : context === "free-device"
        ? forDevice
          ? t("locker.activate.freeUpFor", { device: forDevice })
          : t("locker.activate.freeUp")
        : t("locker.activate.backToSignIn");
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
  /*
   * `Back to <product>` replaces `Open <product>` once the product's declared targets arrive.
   * Focus was on Open (or fell to the dialog or the page when it went), so it moves to the
   * replacement; focus the person has put elsewhere stays.
   */
  const shownBack = React.useRef(back);
  React.useLayoutEffect(() => {
    if (shownBack.current === back) return;
    shownBack.current = back;
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      active.getAttribute("role") === "dialog"
    )
      document.querySelector<HTMLElement>("[data-done-primary]")?.focus();
  }, [back]);
  const lede = back
    ? already
      ? t("locker.activate.ledeBackAlready", { product: name })
      : t("locker.activate.ledeBack", { product: name })
    : already
      ? t("locker.activate.ledeAlready")
      : t("locker.activate.ledeNew");
  return (
    <>
      <DialogBody className="space-y-4">
        <ProductArt
          slug={slug}
          name={name}
          tint={null}
          src={headerUrl}
          variant="banner"
          className="h-36 rounded-lg"
        />
        <span className="inline-flex items-center gap-1 rounded-full border border-success-border bg-surface-overlay px-2 py-1 text-xs font-medium text-success">
          {momentKey ? (
            <Celebration momentKey={momentKey} size={14} />
          ) : (
            <Check aria-hidden className="size-3.5" />
          )}
          {t("locker.activate.inLibrary")}
        </span>
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
              {t("locker.activate.seeLibrary")}
            </Button>
            <Button
              asChild
              size="lg"
              className="h-11 font-medium"
              data-done-primary=""
            >
              <a href={back}>
                {t("locker.activate.backTo", { product: name })}
              </a>
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
              {t("locker.activate.another")}
            </Button>
            <Button
              data-done-primary=""
              size="lg"
              className="h-11 font-medium"
              iconEnd={<ArrowRight aria-hidden />}
              onClick={onOpen}
            >
              {t("locker.activate.open", { product: name })}
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
  const lead =
    step === "confirm"
      ? t("locker.activate.onDevices", { count })
      : t("locker.activate.cameWith", { count });
  const rest =
    step === "confirm"
      ? one
        ? t("locker.activate.keepsOne")
        : t("locker.activate.keepsMany")
      : cloudSync
        ? one
          ? t("locker.activate.syncOne")
          : t("locker.activate.syncMany")
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
  error = null,
  onBack,
  onAdd,
  primaryLabel,
  notes,
}: {
  preview: ConfirmPreview;
  licenseKey: string;
  adding: boolean;
  /** Why the last Add failed, said under the key (a failure that is not the key's). */
  error?: string | null;
  onBack: () => void;
  onAdd: () => void;
  /** The primary's words; `Add to my library` by default. */
  primaryLabel?: string;
  /** More lines about what adding does, under the key. */
  notes?: React.ReactNode;
}): React.ReactElement {
  const p = preview.product;
  // A cover that is missing or fails to load leaves no empty tint box: the icon stands alone.
  const [coverFailed, setCoverFailed] = React.useState(false);
  const hasCover = Boolean(p.headerUrl) && !coverFailed;
  const lic = preview.license;
  const tier = lic ? (lic.tierLabel ?? tierLabel(lic.tier)) : null;
  const terms = lic
    ? [
        lic.expiresAt === null
          ? t("signin.term.lifetime")
          : t("locker.activate.updatesUntil", {
              date: formatDay(lic.expiresAt),
            }),
        lic.deviceLimit
          ? t("locker.activate.upTo", { count: lic.deviceLimit })
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
          {hasCover ? (
            <ProductArt
              slug={p.slug}
              name={p.name}
              tint={null}
              src={p.headerUrl}
              variant="banner"
              letter={false}
              onError={() => setCoverFailed(true)}
              // A short screen (§8) drops the art, so the facts and the key start on the first
              // screen; the icon, in a row of its own, carries the product's identity.
              className="h-36 rounded-lg short:hidden"
            />
          ) : null}
          <ProductIcon
            slug={p.slug}
            name={p.name}
            tint={null}
            src={p.iconUrl}
            size={64}
            lift
            className={
              hasCover
                ? "relative -mt-8 ms-4 short:mt-0 short:ms-0"
                : "relative"
            }
            tileClassName="outline-3 -outline-offset-3 outline-surface-overlay"
          />
        </div>
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Check aria-hidden className="size-4 shrink-0 text-success" />
          <span>
            {tParts("locker.activate.recognized", ["product"]).map((part, i) =>
              typeof part === "string" ? (
                part
              ) : (
                <span key={i} className="font-medium text-fg-strong">
                  {p.name}
                </span>
              ),
            )}
            {p.developerName ? ` · ${p.developerName}` : ""}
          </span>
        </p>
        {tier || terms ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
            {tier ? (
              <span className="inline-flex h-5 items-center rounded-full border border-border bg-surface-sunken px-2 text-xs text-fg-muted">
                {tier}
              </span>
            ) : null}
            {terms ? <span>{terms}</span> : null}
            <PlatformGlyphs platforms={platforms} className="ms-auto" />
          </div>
        ) : null}
        <div className="flex items-center gap-3 rounded-md border border-border bg-surface-sunken py-1 pe-1 ps-3">
          <code className="min-w-0 flex-1 font-mono text-code leading-5 [overflow-wrap:anywhere]">
            <span className="text-fg-subtle">pkey_</span>
            <span className="font-medium text-accent-fg">{p.slug}</span>
            <span className="text-fg-subtle">_</span>
            <span className="text-fg-strong">
              {middleTruncate(licenseKey.slice(`pkey_${p.slug}_`.length))}
            </span>
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 font-medium max-sm:min-h-11"
            onClick={onBack}
          >
            {t("locker.activate.changeKey")}
          </Button>
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
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
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
          className="h-auto min-h-9 min-w-0 py-1.5 font-medium"
          loading={adding}
          onClick={onAdd}
          aria-label={primaryLabel ?? t("locker.activate.addToLibrary")}
        >
          <span className="truncate max-[24rem]:overflow-visible max-[24rem]:whitespace-normal max-[24rem]:text-center">
            {primaryLabel ?? t("locker.activate.addToLibrary")}
          </span>
        </Button>
      </DialogFooter>
    </>
  );
}

/** A key's secret part with its middle cut out, so the row stays one line. */
function middleTruncate(rest: string): string {
  return rest.length > 8 ? `${rest.slice(0, 3)}…${rest.slice(-3)}` : rest;
}

/**
 * Focus Done's primary action (`Open <product>`, or `Back to <product>` for an app's return),
 * marked `data-done-primary`; the heading when there is none. `from` is any element inside the
 * dialog.
 */
function focusDonePrimary(from: HTMLElement | null): void {
  const primary = from
    ?.closest('[role="dialog"], [role="alertdialog"]')
    ?.querySelector<HTMLElement>("[data-done-primary]");
  if (primary) primary.focus();
  else focusDialogHeading(from);
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
  if (err instanceof HttpError) {
    const v = claimVerdict(err, name);
    if (v) return v;
    // A server error is not the key's fault: its own words, and nothing to retype.
    if (err.status >= 500)
      return {
        code: "failed",
        tone: "danger",
        message: t("locker.activate.addFailed"),
      };
  }
  const copy = portalErrorCopy(err);
  return {
    code: "failed",
    tone: "danger",
    message: copy.line,
  };
}

/** The verdicts that say nothing about the key: the confirm step stays, with Add to try again. */
function keepsConfirm(code: KeyVerdict["code"]): boolean {
  return code === "failed" || code === "rate_limited";
}
