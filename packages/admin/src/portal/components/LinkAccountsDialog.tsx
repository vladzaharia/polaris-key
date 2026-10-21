import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, UserRound } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { formatDate, formatRelative } from "../../lib/format.js";
import { t } from "../../lib/copy.js";
import {
  portalApi,
  PortalApiError,
  type PortalLinkAccount,
  type PortalLinkReason,
  type PortalLinkView,
} from "../api.js";
import {
  portalKeys,
  refreshAfterMethodChange,
  useLinkView,
  useSession,
} from "../data.js";
import { isStepUpRequired, portalErrorCopy } from "../errors.js";
import { beginSecondSignIn } from "../linkSecond.js";
import { focusPageHeading, href, navigate } from "../router.js";
import { StepUpInline } from "./account/StepUpInline.js";

/**
 * Link an existing account (SIGN-IN.md D-27, PORTAL.md §4.11; PX-W12's `/api/me/link`): the signed-in
 * side of joining two accounts. A dialog over Account, opened by **Link an existing account** under
 * Sign-in methods or by the Activate dialog's `license_owned` refusal, and re-entered at
 * `#/account/link` when the sign-in to the other account comes back.
 *
 * Proof of both, in this browser: the person is signed in to this account (fresh, else "Confirm
 * it's you" first), signs in to the other one (the login card in "other account" mode while still
 * signed in, `linkSecond.ts`; the Worker's `/signin` sends the browser back here) and returns to
 * see both and join. Nothing moves until **Join into one account**, which is always pressable: a
 * refusal shows as text at the button and never as a disabled control. A proof older than 5
 * minutes is re-made from here, per account. Joins are undoable for 72 hours.
 */
const SIGN_IN_OTHER = "/signin?return_to=%2F%23%2Faccount%2Flink";

const REASON_COPY: Record<PortalLinkReason, () => string> = {
  sign_in_other: () => t("signin.join.signInOther"),
  step_up_required: () => t("signin.join.reasonStepUp"),
  merge_pending: () => t("signin.join.reasonPending"),
  unavailable: () => t("signin.join.reasonUnavailable"),
};

const METHOD_NAME: Record<string, string> = {
  email: "email",
  passkey: "passkey",
  google: "Google",
  apple: "Apple",
  steam: "Steam",
  gamecenter: "Game Center",
  pgs: "Play Games",
  oidc: t("signin.sso.name"),
  sso: t("signin.sso.name"),
};
const methodName = (kind: string): string => METHOD_NAME[kind] ?? kind;

type Action =
  | { kind: "idle"; error?: string; withMethods?: boolean; stale?: string[] }
  | { kind: "busy" }
  | { kind: "stepup"; then: "start" | "undo" | "verify"; merge?: string }
  | {
      kind: "joined";
      undoUntil: number | null;
      merge: string | null;
      error?: string;
    }
  | { kind: "undone" };

export function LinkAccountsDialog({
  onClose,
  undoId,
}: {
  onClose: () => void;
  /** Opened from the 72-hour row: confirm undoing this join, nothing else. */
  undoId?: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const session = useSession();
  const view = useLinkView();
  const [action, setAction] = React.useState<Action>({ kind: "idle" });
  const flow = view.data?.flow ?? null;
  const undoable = view.data?.undoable ?? [];
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

  /** The login card, in "other account" mode (App.tsx), for whichever proof is wanted. */
  const signInOther = (email?: string): void => {
    const token = session.data?.csrf;
    if (token) beginSecondSignIn(token, email);
    window.location.assign(SIGN_IN_OTHER);
  };

  const fail = (err: unknown): void => {
    if (err instanceof PortalApiError && err.code === "signin_expired") {
      // The flow was used up by the attempt: back to the start view, keeping the undo list.
      const reset: PortalLinkView = {
        flow: null,
        undoable: view.data?.undoable ?? [],
      };
      qc.setQueryData(portalKeys.link, reset);
      return setAction({ kind: "idle", error: t("signin.join.expired") });
    }
    if (err instanceof PortalApiError && err.reason === "same_account")
      return setAction({ kind: "idle", error: t("signin.join.sameAccount") });
    if (err instanceof PortalApiError && err.reason === "merge_pending")
      return setAction({ kind: "idle", error: REASON_COPY.merge_pending() });
    if (err instanceof PortalApiError && err.reason === "unavailable")
      return setAction({ kind: "idle", error: REASON_COPY.unavailable() });
    if (isStepUpRequired(err)) {
      const roles =
        err instanceof PortalApiError && err.stale?.length
          ? err.stale
          : ["started", "other"];
      return setAction({
        kind: "idle",
        error: staleMessage(roles, flow),
        stale: roles,
      });
    }
    if (err instanceof PortalApiError && err.status === 409)
      // `last_link`: the Worker's own sentence, and where to add a way.
      return setAction({
        kind: "idle",
        error: err.message.startsWith("portal api")
          ? t("signin.join.failed")
          : err.message,
        withMethods: true,
      });
    if (err instanceof PortalApiError && err.status === 0)
      return setAction({ kind: "idle", error: portalErrorCopy(err).title });
    setAction({ kind: "idle", error: t("signin.join.failed") });
  };

  const start = async (): Promise<void> => {
    setAction({ kind: "busy" });
    try {
      await portalApi.linkStart();
      signInOther();
    } catch (err) {
      if (isStepUpRequired(err))
        return setAction({ kind: "stepup", then: "start" });
      fail(err);
    }
  };

  const startAgain = async (): Promise<void> => {
    await portalApi.linkCancel().catch(() => undefined);
    await start();
  };

  const join = async (): Promise<void> => {
    // The button always answers: a join the Worker would refuse says why, here.
    if (flow && !flow.canJoin && flow.reason) {
      const roles =
        flow.reason === "step_up_required"
          ? [flow.started, flow.other]
              .filter((a): a is PortalLinkAccount => !!a && !a.proven.fresh)
              .map((a) => a.role)
          : undefined;
      return setAction({
        kind: "idle",
        error: roles ? staleMessage(roles, flow) : REASON_COPY[flow.reason](),
        stale: roles,
      });
    }
    setAction({ kind: "busy" });
    try {
      const out = await portalApi.linkConfirm();
      refreshAfterMethodChange(qc);
      void qc.invalidateQueries({ queryKey: portalKeys.link });
      setAction({
        kind: "joined",
        undoUntil: out.merge?.undoUntil ?? null,
        merge: out.merge?.id ?? null,
      });
    } catch (err) {
      fail(err);
    }
  };

  const undo = async (merge: string): Promise<void> => {
    const before = action;
    setAction({ kind: "busy" });
    try {
      await portalApi.linkUndo(merge);
      refreshAfterMethodChange(qc);
      void qc.invalidateQueries({ queryKey: portalKeys.link });
      setAction({ kind: "undone" });
    } catch (err) {
      if (isStepUpRequired(err))
        return setAction({ kind: "stepup", then: "undo", merge });
      const msg =
        err instanceof PortalApiError && err.status === 404
          ? t("signin.join.noUndo")
          : err instanceof PortalApiError && err.status === 0
            ? portalErrorCopy(err).title
            : t("signin.join.undoFailed");
      if (err instanceof PortalApiError && err.status === 404)
        void qc.invalidateQueries({ queryKey: portalKeys.link });
      // Back where the person was, with the reason: the Undo they pressed stays in reach.
      if (before.kind === "joined") setAction({ ...before, error: msg });
      else setAction({ kind: "idle", error: msg });
    }
  };

  const confirmUndo = !flow ? undoable.find((u) => u.id === undoId) : undefined;
  const busy = action.kind === "busy";
  const done = action.kind === "joined" || action.kind === "undone";
  const error =
    action.kind === "idle" || action.kind === "joined"
      ? action.error
      : undefined;
  const stale = action.kind === "idle" ? (action.stale ?? []) : [];
  const alertRef = React.useRef<HTMLDivElement>(null);
  const statusRef = React.useRef<HTMLParagraphElement>(null);
  // After an outcome, focus goes to what answers it: the status, or the reason.
  React.useEffect(() => {
    if (action.kind === "joined" && !action.error) statusRef.current?.focus();
    else if (action.kind === "undone") statusRef.current?.focus();
    else if (error) alertRef.current?.focus();
  }, [action.kind, error]);

  const problem = (
    <Problem
      id="pk-join-err"
      text={error}
      methods={action.kind === "idle" && action.withMethods}
      alertRef={alertRef}
      onMethods={() => {
        onClose();
        navigate(href.account("methods"));
      }}
    />
  );
  const stepUpEscape = (e: KeyboardEvent): void => {
    // Escape backs out of the confirmation, one step; the dialog stays.
    if (action.kind === "stepup") {
      e.preventDefault();
      setAction({ kind: "idle" });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      size="md"
      title={t("signin.join.title")}
      dismissible={!busy}
      onEscapeKeyDown={stepUpEscape}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        focusPageHeading();
      }}
    >
      {action.kind === "stepup" ? (
        <DialogBody className="space-y-3">
          <StepUpInline
            verb={t("signin.join.stepUpVerb")}
            onConfirmed={() => {
              if (action.then === "undo" && action.merge)
                void undo(action.merge);
              else if (action.then === "verify") {
                // This account is fresh now: read the join screen again.
                void view.refetch();
                setAction({ kind: "idle" });
              } else void start();
            }}
            onCancel={() => setAction({ kind: "idle" })}
          />
        </DialogBody>
      ) : done ? (
        <>
          <DialogBody className="space-y-3">
            <p
              ref={statusRef}
              tabIndex={-1}
              role="status"
              className="flex items-start gap-2 text-fg outline-none"
            >
              <Check
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-success"
              />
              {action.kind === "joined"
                ? action.undoUntil
                  ? t("signin.join.doneUntil", {
                      date: formatDate(action.undoUntil * 1000),
                    })
                  : t("signin.join.done")
                : t("signin.join.undone")}
            </p>
            {action.kind === "joined" && action.merge ? (
              <Button
                variant="outline"
                size="sm"
                busyFocusable
                className="max-sm:min-h-11"
                onClick={() => void undo(action.merge!)}
              >
                {t("signin.join.undo")}
              </Button>
            ) : null}
            {problem}
          </DialogBody>
          <DialogFooter className={SHORT_FOOTER}>
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
          <p role="alert" className="text-fg">
            {t("signin.join.failed")}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 max-sm:min-h-11"
            onClick={() => void view.refetch()}
          >
            {t("signin.retry")}
          </Button>
        </DialogBody>
      ) : flow && flow.other ? (
        <>
          <DialogBody className="space-y-4">
            <ul className="space-y-2">
              {[flow.started, flow.other]
                .sort((a, b) => Number(!!b?.current) - Number(!!a?.current))
                .map((a) =>
                  a ? (
                    <li key={a.role}>
                      <AccountCard account={a} />
                    </li>
                  ) : null,
                )}
            </ul>
            {flow.result ? (
              <div className="space-y-1">
                <p className="text-fg">
                  {t("signin.join.result", {
                    email: flow.result.primaryEmail ?? "",
                    count: flow.result.products,
                  })}
                </p>
                <p className="text-sm text-fg-muted">
                  {t("signin.join.keepsWorking")}
                </p>
              </div>
            ) : null}
            {problem}
            <StaleActions
              accounts={[flow.started, flow.other]}
              roles={stale}
              busy={busy}
              onSignIn={signInOther}
              onConfirm={() => setAction({ kind: "stepup", then: "verify" })}
              onStartAgain={() => void startAgain()}
            />
          </DialogBody>
          <DialogFooter className={SHORT_FOOTER}>
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
      ) : confirmUndo ? (
        <>
          <DialogBody className="space-y-4">
            <p className="text-fg">
              {t("signin.join.undoConfirm", {
                email:
                  confirmUndo.joined?.email ?? confirmUndo.joined?.name ?? "",
                date: formatDate(confirmUndo.undoUntil * 1000),
              })}
            </p>
            {problem}
          </DialogBody>
          <DialogFooter className={SHORT_FOOTER}>
            <Button variant="outline" disabled={busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="neutral"
              loading={busy}
              busyFocusable
              onClick={() => void undo(confirmUndo.id)}
            >
              {t("signin.join.undo")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogBody className="space-y-4">
            <p className="text-fg-muted">{t("signin.join.lede")}</p>
            {flow?.started ? <AccountCard account={flow.started} /> : null}
            {problem}
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
                      busyFocusable
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
          <DialogFooter className={SHORT_FOOTER}>
            <Button variant="outline" disabled={busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="neutral"
              loading={busy}
              busyFocusable
              onClick={() => (flow ? signInOther() : void start())}
            >
              {t("signin.join.start")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

/**
 * 400 % zoom is a viewport about 200 px tall: a stacked, full-width footer would take most of it,
 * so on a short window the footer goes back to one compact row and the body keeps the room.
 */
const SHORT_FOOTER =
  "[@media(max-height:520px)]:flex-row [@media(max-height:520px)]:py-2 [@media(max-height:520px)]:mt-0 [@media(max-height:520px)]:[&_button]:h-auto [@media(max-height:520px)]:[&_button]:whitespace-normal";

/** A proof older than 5 minutes: sign in to that account again, or start over. Never a dead end. */
function StaleActions({
  accounts,
  roles,
  busy,
  onSignIn,
  onConfirm,
  onStartAgain,
}: {
  accounts: (PortalLinkAccount | null)[];
  roles: string[];
  busy: boolean;
  onSignIn: (email?: string) => void;
  onConfirm: () => void;
  onStartAgain: () => void;
}): React.ReactElement | null {
  if (roles.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {accounts
        .filter((a): a is PortalLinkAccount => !!a && roles.includes(a.role))
        .map((a) => (
          <Button
            key={a.role}
            variant="outline"
            size="sm"
            className="max-sm:min-h-11"
            disabled={busy}
            onClick={() =>
              a.current ? onConfirm() : onSignIn(a.email ?? undefined)
            }
          >
            {a.current
              ? t("core.codes.step_up_required.title")
              : t("signin.join.again", { email: a.email ?? "" })}
          </Button>
        ))}
      <Button
        variant="ghost"
        size="sm"
        className="max-sm:min-h-11"
        disabled={busy}
        onClick={onStartAgain}
      >
        {t("signin.join.startAgain")}
      </Button>
    </div>
  );
}

function Problem({
  id,
  text,
  methods,
  onMethods,
  alertRef,
}: {
  alertRef?: React.Ref<HTMLDivElement>;
  id: string;
  text?: string;
  methods?: boolean;
  onMethods: () => void;
}): React.ReactElement | null {
  return text ? (
    <div
      id={id}
      ref={alertRef}
      tabIndex={-1}
      role="alert"
      className="space-y-1 text-sm outline-none"
    >
      <p className="text-danger">{text}</p>
      {methods ? (
        <Button
          variant="link"
          size="sm"
          className="max-sm:min-h-11"
          onClick={onMethods}
        >
          {t("signin.join.methodsLink")}
        </Button>
      ) : null}
    </div>
  ) : null;
}

function AccountCard({
  account,
}: {
  account: PortalLinkAccount;
}): React.ReactElement {
  const stale = !account.proven.fresh;
  const named = account.name && account.name !== account.email;
  const methods = account.methods.map(methodName).join(", ");
  const by = account.proven.by ? methodName(account.proven.by) : null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-sunken px-3 py-2.5">
      {account.avatarUrl ? (
        <img
          src={account.avatarUrl}
          alt=""
          className="size-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        // The same initials on two accounts read as one account: a neutral glyph instead.
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-fg-muted">
          <UserRound aria-hidden className="size-5" />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-0.5 text-sm [overflow-wrap:anywhere]">
        <span className="text-xs font-medium text-fg-muted">
          {account.current
            ? t("signin.join.signedNow")
            : t("signin.join.yourOther")}
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
          {methods
            ? ` · ${t("signin.join.methodsLine", { method: methods })}`
            : ""}
        </span>
        {stale ? (
          <span className="font-medium text-fg-strong">
            {t("signin.join.staleMark")}
          </span>
        ) : by ? (
          <span className="text-fg-muted">
            {t("signin.join.provenBy", {
              method: by,
              when: formatRelative(account.proven.at * 1000, Date.now()),
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The alert for a stale proof names only the account that is stale. */
function staleMessage(roles: string[], flow: PortalLinkView["flow"]): string {
  const accounts = [flow?.started, flow?.other].filter(
    (a): a is PortalLinkAccount => !!a && roles.includes(a.role),
  );
  return accounts.length === 1 && accounts[0]!.email
    ? t("signin.join.reasonStaleOne", { email: accounts[0]!.email })
    : t("signin.join.reasonStepUp");
}
