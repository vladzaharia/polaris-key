import * as React from "react";
import { Check, ScanLine } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import { Input } from "../../ui/Input.js";
import { formatRelative } from "../../lib/format.js";
import { t } from "../../lib/copy.js";
import {
  portalApi,
  PortalApiError,
  type PortalDeviceLoginRequest,
} from "../api.js";
import { isStepUpRequired, portalErrorCopy } from "../errors.js";
import { StepUpInline } from "./account/StepUpInline.js";

/**
 * Approve a new device (SIGN-IN.md §3.11, PORTAL.md §4.24): the signed-in side of "Sign in with
 * another device". A dialog over Account, opened by the QR's link (`#/account/approve?code=`, which
 * the router turns into `?approve=<code>`) or by **Approve a new device** under Where you're
 * signed in. Looking never approves: the code is looked up first, then the person sees the device,
 * where and when, and chooses. There is no default. A request from another place, or one whose
 * place is unknown, needs a sign-in no older than 5 minutes first ("Confirm it's you"); the code
 * stays live for the retry.
 */
type Phase =
  | { kind: "enter"; error?: string }
  | { kind: "looking" }
  | { kind: "review"; request: PortalDeviceLoginRequest; error?: string }
  | { kind: "stepup"; request: PortalDeviceLoginRequest; decision: Decision }
  | { kind: "deciding"; request: PortalDeviceLoginRequest }
  | {
      kind: "done";
      request: PortalDeviceLoginRequest;
      status: "approved" | "denied";
    };

type Decision = "approve" | "deny";

/** Group and case are ignored by the Worker; keep what the person typed readable. */
function tidyCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8)
    .replace(/^(.{4})(.+)$/, "$1-$2");
}

export function ApproveDeviceDialog({
  code,
  onClose,
}: {
  /** The code from the link, or "" to ask for it. */
  code: string;
  onClose: () => void;
}): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>({ kind: "enter" });
  const [typed, setTyped] = React.useState(tidyCode(code));
  const started = React.useRef(false);
  const arrived = React.useRef(false);
  const denyRef = React.useRef<HTMLButtonElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  // The step changed under the person: focus the safe choice, not the dialog frame.
  React.useEffect(() => {
    // Deny only on first arrival: after a failed Approve, focus stays where the person was.
    if (phase.kind === "review" && !arrived.current) {
      arrived.current = true;
      denyRef.current?.focus();
    } else if (phase.kind === "done") closeRef.current?.focus();
  }, [phase.kind]);

  const codeRef = React.useRef<HTMLInputElement>(null);
  // An answer at the field: focus goes to it, so the error is heard and the fix is one key away.
  React.useEffect(() => {
    if (phase.kind === "enter" && phase.error) codeRef.current?.focus();
  }, [phase]);

  const look = React.useCallback(async (value: string): Promise<void> => {
    setPhase({ kind: "looking" });
    try {
      const { request } = await portalApi.deviceLoginLookup(value);
      setPhase({ kind: "review", request });
    } catch (err) {
      setPhase({
        kind: "enter",
        error:
          err instanceof PortalApiError && err.status === 410
            ? t("signin.approve.expiredCode")
            : err instanceof PortalApiError &&
                (err.status === 404 || err.status === 422)
              ? t("signin.approve.notFound")
              : err instanceof PortalApiError && err.status === 429
                ? t("signin.approve.tooMany")
                : err instanceof PortalApiError && err.status === 0
                  ? portalErrorCopy(err).title
                  : t("signin.approve.failed"),
      });
    }
  }, []);

  // A link that carried a code looks it up at once.
  React.useEffect(() => {
    if (started.current || tidyCode(code).length < 9) return;
    started.current = true;
    void look(tidyCode(code));
  }, [code, look]);

  const decide = async (
    request: PortalDeviceLoginRequest,
    decision: Decision,
  ): Promise<void> => {
    setPhase({ kind: "deciding", request });
    try {
      const out = await portalApi.deviceLoginDecide(request.code, decision);
      setPhase({ kind: "done", request, status: out.status });
    } catch (err) {
      if (isStepUpRequired(err))
        return setPhase({ kind: "stepup", request, decision });
      if (err instanceof PortalApiError && err.status === 410)
        return setPhase({
          kind: "enter",
          error: t("signin.approve.expiredCode"),
        });
      if (
        err instanceof PortalApiError &&
        (err.status === 404 || err.status === 422)
      )
        return setPhase({ kind: "enter", error: t("signin.approve.notFound") });
      setPhase({ kind: "review", request, error: t("signin.approve.failed") });
    }
  };

  const title =
    phase.kind === "review" || phase.kind === "deciding"
      ? t("signin.approve.ask")
      : phase.kind === "stepup"
        ? t("core.codes.step_up_required.title")
        : phase.kind === "done"
          ? t("signin.approve.open")
          : t("signin.approve.open");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      title={title}
      dismissible={phase.kind !== "deciding" && phase.kind !== "looking"}
      onEscapeKeyDown={(e) => {
        // Escape backs out of the confirmation, one step; the dialog stays.
        if (phase.kind === "stepup") {
          e.preventDefault();
          setPhase({ kind: "review", request: phase.request });
        }
      }}
    >
      {phase.kind === "enter" || phase.kind === "looking" ? (
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            // Always pressable: a short code is answered at the field, not by a dead button.
            if (typed.length === 9) void look(typed);
            else
              setPhase({ kind: "enter", error: t("signin.approve.codeShort") });
          }}
        >
          <DialogBody className="space-y-3">
            <p className="text-fg-muted">{t("signin.approve.enter")}</p>
            <div className="space-y-1.5">
              <label
                htmlFor="pk-approve-code"
                className="text-sm font-medium text-fg-strong"
              >
                {t("signin.approve.codeLabel")}
              </label>
              <Input
                id="pk-approve-code"
                ref={codeRef}
                value={typed}
                onValueChange={(v) => {
                  setTyped(tidyCode(v));
                  // Editing answers the error.
                  if (phase.kind === "enter" && phase.error)
                    setPhase({ kind: "enter" });
                }}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-invalid={
                  phase.kind === "enter" && phase.error ? true : undefined
                }
                aria-describedby={
                  phase.kind === "enter" && phase.error
                    ? "pk-approve-err"
                    : undefined
                }
                className="h-12 font-mono text-lg tracking-widest"
              />
              {phase.kind === "enter" && phase.error ? (
                <p
                  id="pk-approve-err"
                  role="alert"
                  className="text-sm text-danger"
                >
                  {phase.error}
                </p>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="submit"
              variant="neutral"
              loading={phase.kind === "looking"}
              busyFocusable
              iconStart={<ScanLine aria-hidden />}
            >
              {t("signin.approve.look")}
            </Button>
          </DialogFooter>
        </form>
      ) : phase.kind === "review" || phase.kind === "deciding" ? (
        <>
          <DialogBody className="space-y-4">
            <p className="text-fg">
              {t("signin.approve.askBody", { code: phase.request.code })}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-fg-muted">{t("signin.approve.device")}</dt>
              <dd className="text-fg-strong">{phase.request.device.label}</dd>
              <dt className="text-fg-muted">{t("signin.approve.where")}</dt>
              <dd className="text-fg-strong">
                {phase.request.location.label ??
                  t("signin.approve.unknownPlace")}
              </dd>
              <dt className="text-fg-muted">{t("signin.approve.when")}</dt>
              <dd className="text-fg-strong">
                {formatRelative(phase.request.requestedAt * 1000, Date.now())}
              </dd>
            </dl>
            <Callout tone="warning">{t("signin.approve.warning")}</Callout>
            {phase.kind === "review" && phase.error ? (
              <p role="alert" className="text-sm text-danger">
                {phase.error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              ref={denyRef}
              variant="outline"
              disabled={phase.kind === "deciding"}
              onClick={() => void decide(phase.request, "deny")}
            >
              {t("signin.approve.deny")}
            </Button>
            <Button
              variant="neutral"
              loading={phase.kind === "deciding"}
              busyFocusable
              onClick={() => void decide(phase.request, "approve")}
            >
              {t("signin.approve.approve")}
            </Button>
          </DialogFooter>
        </>
      ) : phase.kind === "stepup" ? (
        <DialogBody className="space-y-3">
          <p className="text-fg-muted">{t("signin.approve.stepUpWhy")}</p>
          <StepUpInline
            verb={t("signin.approve.stepUpVerb")}
            onConfirmed={() => void decide(phase.request, phase.decision)}
            onCancel={() =>
              setPhase({ kind: "review", request: phase.request })
            }
          />
        </DialogBody>
      ) : (
        <>
          <DialogBody>
            <p role="status" className="flex items-center gap-2 text-fg">
              <Check aria-hidden className="size-4 shrink-0 text-success" />
              {phase.status === "approved"
                ? t("signin.approve.approved", {
                    device: phase.request.device.label,
                  })
                : t("signin.approve.deniedDone")}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button ref={closeRef} variant="neutral" onClick={onClose}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
