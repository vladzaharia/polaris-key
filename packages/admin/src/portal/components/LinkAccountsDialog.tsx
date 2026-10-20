import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { formatDate } from "../../lib/format.js";
import { t } from "../../lib/copy.js";
import {
  portalApi,
  PortalApiError,
  type PortalLinkAccount,
  type PortalLinkReason,
  type PortalLinkView,
} from "../api.js";
import { refreshAfterMethodChange } from "../data.js";
import { isStepUpRequired, portalErrorCopy } from "../errors.js";
import { Avatar } from "./Avatar.js";
import { ErrorPanel } from "./States.js";
import { StepUpInline } from "./account/StepUpInline.js";

/**
 * Link an existing account (SIGN-IN.md D-27, PORTAL.md §4.11; PX-W12's `/api/me/link`): the signed-in
 * side of joining two accounts. A dialog over Account, opened by **Link an existing account** under
 * Sign-in methods or by the Activate dialog's `license_owned` refusal, and re-entered at
 * `#/account/link` when the sign-in to the other account comes back.
 *
 * Proof of both, in this browser: the person is signed in to this account (fresh, else "Confirm
 * it's you" first), signs in to the other one on the login card, and returns here to see both and
 * join. Nothing moves until **Join into one account**, which is always pressable: a refusal shows
 * as text at the button and never as a disabled control. Joins are undoable for 72 hours.
 */
const SIGN_IN_OTHER = "/signin?return_to=%2F%23%2Faccount%2Flink";

const REASON_COPY: Record<PortalLinkReason, () => string> = {
  sign_in_other: () => t("signin.join.signInOther"),
  step_up_required: () => t("signin.join.reasonStepUp"),
  merge_pending: () => t("signin.join.reasonPending"),
  unavailable: () => t("signin.join.reasonUnavailable"),
};

type Action =
  | { kind: "idle"; error?: string }
  | { kind: "busy" }
  | { kind: "stepup"; then: "start" | "undo"; merge?: string }
  | { kind: "joined"; undoUntil: number | null }
  | { kind: "undone" };

export function LinkAccountsDialog({
  onClose,
}: {
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const view = useQuery<PortalLinkView>({
    queryKey: ["portal", "link"],
    queryFn: () => portalApi.linkView(),
    retry: false,
    gcTime: 0,
  });
  const [action, setAction] = React.useState<Action>({ kind: "idle" });
  const flow = view.data?.flow ?? null;
  const expired =
    view.error instanceof PortalApiError &&
    view.error.code === "signin_expired";

  // A flow that expired between visits reads as a fresh start, with the reason once.
  React.useEffect(() => {
    if (expired) setAction({ kind: "idle", error: t("signin.join.expired") });
  }, [expired]);

  const close = (): void => {
    // Leaving a half-done link forgets it: the proof lives on the server for 15 minutes.
    if (flow && action.kind !== "joined")
      void portalApi.linkCancel().catch(() => undefined);
    onClose();
  };

  const fail = (err: unknown): void => {
    if (err instanceof PortalApiError && err.code === "signin_expired") {
      void view.refetch();
      return setAction({ kind: "idle", error: t("signin.join.expired") });
    }
    if (err instanceof PortalApiError && err.reason === "same_account")
      return setAction({ kind: "idle", error: t("signin.join.sameAccount") });
    if (err instanceof PortalApiError && err.reason === "merge_pending")
      return setAction({ kind: "idle", error: REASON_COPY.merge_pending() });
    if (err instanceof PortalApiError && err.reason === "unavailable")
      return setAction({ kind: "idle", error: REASON_COPY.unavailable() });
    if (isStepUpRequired(err))
      return setAction({ kind: "idle", error: REASON_COPY.step_up_required() });
    const copy = portalErrorCopy(err);
    setAction({ kind: "idle", error: `${copy.title}. ${copy.description}` });
  };

  const start = async (): Promise<void> => {
    setAction({ kind: "busy" });
    try {
      const out = await portalApi.linkStart();
      window.location.assign(out.next);
    } catch (err) {
      if (isStepUpRequired(err))
        return setAction({ kind: "stepup", then: "start" });
      fail(err);
    }
  };

  const join = async (): Promise<void> => {
    // The button always answers: a join the Worker would refuse says why, here.
    if (flow && !flow.canJoin && flow.reason) {
      return setAction({ kind: "idle", error: REASON_COPY[flow.reason]() });
    }
    setAction({ kind: "busy" });
    try {
      const out = await portalApi.linkConfirm();
      refreshAfterMethodChange(qc);
      setAction({ kind: "joined", undoUntil: out.merge?.undoUntil ?? null });
    } catch (err) {
      fail(err);
      void view.refetch();
    }
  };

  const undo = async (merge: string): Promise<void> => {
    setAction({ kind: "busy" });
    try {
      await portalApi.linkUndo(merge);
      refreshAfterMethodChange(qc);
      setAction({ kind: "undone" });
    } catch (err) {
      if (isStepUpRequired(err))
        return setAction({ kind: "stepup", then: "undo", merge });
      fail(err);
    }
  };

  const busy = action.kind === "busy";
  const done = action.kind === "joined" || action.kind === "undone";
  const error = action.kind === "idle" ? action.error : undefined;
  const undoable = view.data?.undoable ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      size="md"
      title={t("signin.join.title")}
      dismissible={!busy}
    >
      {action.kind === "stepup" ? (
        <DialogBody className="space-y-3">
          <StepUpInline
            verb={t("signin.join.stepUpVerb")}
            onConfirmed={() => {
              if (action.then === "undo" && action.merge)
                void undo(action.merge);
              else void start();
            }}
            onCancel={() => setAction({ kind: "idle" })}
          />
        </DialogBody>
      ) : done ? (
        <>
          <DialogBody>
            <p role="status" className="flex items-start gap-2 text-fg">
              <Check
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-success"
              />
              {action.kind === "joined"
                ? t("signin.join.done")
                : t("signin.join.undone")}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="neutral" onClick={onClose}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </>
      ) : view.isPending ? (
        <DialogBody aria-busy="true" className="space-y-3">
          <Skeleton className="h-16 w-full" />
        </DialogBody>
      ) : view.error && !expired ? (
        <DialogBody>
          <ErrorPanel
            error={view.error}
            onRetry={() => void view.refetch()}
            className="border-0 p-0 shadow-none"
          />
        </DialogBody>
      ) : flow && flow.other ? (
        <>
          <DialogBody className="space-y-4">
            <ul className="space-y-2">
              {flow.started ? (
                <li>
                  <AccountCard account={flow.started} />
                </li>
              ) : null}
              <li>
                <AccountCard account={flow.other} />
              </li>
            </ul>
            {flow.result ? (
              <p className="text-fg">
                {t("signin.join.result", {
                  email: flow.result.primaryEmail ?? "",
                  count: flow.result.products,
                })}
              </p>
            ) : null}
            <Problem id="pk-join-err" text={error} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="neutral"
              loading={busy}
              busyFocusable
              aria-describedby={error ? "pk-join-err" : undefined}
              onClick={() => void join()}
            >
              {t("signin.gate.join")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogBody className="space-y-4">
            <p className="text-fg-muted">{t("signin.join.lede")}</p>
            {flow?.started ? <AccountCard account={flow.started} /> : null}
            <Problem id="pk-join-err" text={error} />
            {undoable.length > 0 ? (
              <ul className="space-y-2 border-t border-border pt-4">
                {undoable.map((u) => (
                  <li
                    key={u.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 text-fg [overflow-wrap:anywhere]">
                      {t("signin.join.undoable", {
                        email: u.joined?.email ?? u.joined?.name ?? "",
                        date: formatDate(u.undoUntil * 1000),
                      })}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="max-sm:min-h-11"
                      disabled={busy}
                      onClick={() => void undo(u.id)}
                    >
                      {t("signin.join.undo")}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="neutral"
              loading={busy}
              busyFocusable
              onClick={() =>
                flow ? window.location.assign(SIGN_IN_OTHER) : void start()
              }
            >
              {t("signin.join.start")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

function Problem({
  id,
  text,
}: {
  id: string;
  text?: string;
}): React.ReactElement | null {
  return text ? (
    <p id={id} role="alert" className="text-sm text-danger">
      {text}
    </p>
  ) : null;
}

function AccountCard({
  account,
}: {
  account: PortalLinkAccount;
}): React.ReactElement {
  const named = account.name && account.name !== account.email;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-sunken px-3 py-2.5">
      <Avatar
        name={account.name}
        email={account.email ?? ""}
        picture={account.avatarUrl}
        size={40}
      />
      <div className="flex min-w-0 flex-col gap-0.5 text-sm [overflow-wrap:anywhere]">
        <span className="text-xs font-medium text-fg-muted">
          {account.role === "started"
            ? t("signin.join.thisAccount")
            : t("signin.join.otherAccount")}
        </span>
        {named ? (
          <span dir="auto" className="font-medium text-fg-strong">
            {account.name}
          </span>
        ) : null}
        <span
          className={named ? "text-fg-muted" : "font-medium text-fg-strong"}
        >
          {account.email}
        </span>
        <span className="text-fg-muted">
          {t("signin.join.products", { count: account.products })}
        </span>
      </div>
    </div>
  );
}
