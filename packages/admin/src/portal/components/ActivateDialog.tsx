import * as React from "react";
import { ArrowRight, Check, Info } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import { PortalApiError, type PortalLicenseSummary } from "../api.js";
import { useClaimKey, useLicenses } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import { requestHeadingFocus } from "../focus.js";
import { checkKey, keyProblem, slugOf } from "../model/key.js";
import { href, navigate } from "../router.js";
import { KeyField } from "./KeyField.js";
import { ProductArt } from "./ProductArt.js";
import { ProductIcon } from "./ProductIcon.js";

/**
 * Activate license (PORTAL.md §4.17–4.19, §5.2 `ActivateDialog`): always a modal over the
 * Library (a bottom sheet on phones), mounted once by the shell.
 *
 * Steps: **enter** → **done**. The confirm step (art, tier, terms) needs the key preview (G22,
 * PX-W5); until then Continue adds the key directly and the refusals come back inline, mapped
 * from today's claim codes. Nothing about the key is sent before Continue: the product is named
 * from the key's own prefix.
 */
type Step =
  | { kind: "enter" }
  | {
      kind: "done";
      license: PortalLicenseSummary | null;
      slug: string;
      already: boolean;
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
    setStep({ kind: "enter" });
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (check.kind !== "valid") {
      setTouched(true);
      return;
    }
    setServerError(null);
    const before = new Set(
      (licenses.data ?? []).map((l) => `${l.product}:${l.id}`),
    );
    claim.mutate(key, {
      onSuccess: (res) => {
        const lic = res.license;
        setStep({
          kind: "done",
          license: lic,
          slug: check.slug,
          already: lic ? before.has(`${lic.product}:${lic.id}`) : false,
        });
      },
      onError: (err) => setServerError(claimError(err, nameFor(check.slug))),
    });
  };

  const done = step.kind === "done" ? step : null;
  const doneName = done
    ? (done.license?.productName ?? nameFor(done.slug))
    : "";

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
          : "Activate a license"
      }
      description={
        done
          ? undefined
          : "Paste a key from a store, a developer or an email. The product joins your library and stays there, even if you lose the key."
      }
      size="md"
    >
      {done ? (
        <>
          <DialogBody className="space-y-4">
            <ProductArt
              slug={done.slug}
              name={doneName}
              tint={null}
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
          <DialogFooter className="flex-col border-0 sm:flex-col sm:justify-start sm:[&>*]:w-full">
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
              loading={claim.isPending}
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

/** Today's claim refusals in the person's words (§4.19), never a toast. */
export function claimError(err: unknown, name: string): string {
  if (err instanceof PortalApiError) {
    if (err.status === 401)
      return "We couldn't find that key. Capital letters matter, and l, 1, O and 0 are easy to mix up, so paste the key instead of typing it.";
    if (err.status === 404) return `${name} manages this license elsewhere.`;
    if (err.status === 422)
      return "That isn't a Polaris Key license key. Ours start with pkey_.";
    if (err.status === 429)
      return "Too many tries. Wait a minute, then try again.";
  }
  const copy = portalErrorCopy(err);
  return `${copy.title}. ${copy.description}`;
}
