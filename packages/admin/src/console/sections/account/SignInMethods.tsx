/**
 * Sign-in methods (`#/account/sign-in-methods`, ST-30c.4): which of the signed-in operator's own
 * methods open the console, "Add a passkey" and "Use for the console".
 *
 * Both writes are step-up rows. The confirm dialog is the house step-up (D11): a 403
 * `step_up_required` turns it into "Sign in again", and it is back on this page after the sign-in.
 * Removal is not here: the Locker account holds the methods, so the page points there. An
 * emergency session has no account behind it, so it has no methods to show.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Fingerprint, Lock } from "lucide-react";
import { api, type ConsoleMethod } from "../../../api.js";
import {
  PasskeyError,
  createPasskey,
  passkeysSupported,
} from "../../../lib/webauthn.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog, isStepUpRequired } from "../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { toast } from "../../../ui/toast.js";
import { useMe } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { MethodRow } from "./MethodRow.js";
import {
  LOCKER_ONLY,
  OPENS,
  addOffReason,
  grouped,
  refusal,
  titles,
} from "./methodsModel.js";

export function useMyMethods() {
  return useQuery({
    queryKey: qk.myMethods(),
    queryFn: () => api.myMethods(),
  });
}

/** Focus the page's heading: where focus goes when the control that had it is gone. */
function focusHeading(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>("h1")?.focus(),
    ),
  );
}

/** A browser-side ceremony that ended without a passkey. */
type Ceremony = "cancelled" | "exists" | "unsupported" | "failed";

interface Notice {
  tone: "info" | "warning";
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}

export function SignInMethods(): React.ReactElement {
  const me = useMe();
  if (me.data?.breakGlass) return <Emergency />;
  return <Methods customerOrigin={me.data?.customerOrigin ?? null} />;
}

function Emergency(): React.ReactElement {
  return (
    <div className="space-y-6" data-template="settings">
      <PageHeader title="Sign-in methods" />
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <Lock aria-hidden className="size-6 text-fg-muted" />
        <h2 className="font-semibold text-fg-strong">
          Emergency sign-in can&apos;t manage sign-in methods
        </h2>
        <p className="text-sm text-fg-muted">
          Sign in with your account to manage them.
        </p>
      </div>
    </div>
  );
}

function Group({
  heading,
  rows,
  names,
  onUse,
}: {
  heading: string;
  rows: ConsoleMethod[];
  names: Map<string, string>;
  onUse: (m: ConsoleMethod) => void;
}): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={`group-${heading.replace(/\s/g, "-")}`}>
      <h2
        id={`group-${heading.replace(/\s/g, "-")}`}
        className="mb-2 text-sm font-semibold text-fg-strong"
      >
        {heading}
      </h2>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface-raised">
        {rows.map((m) => (
          <MethodRow
            key={m.id}
            method={m}
            title={names.get(m.id) ?? m.id}
            onUse={onUse}
          />
        ))}
      </ul>
    </section>
  );
}

function Methods({
  customerOrigin,
}: {
  customerOrigin: string | null;
}): React.ReactElement {
  const methods = useMyMethods();
  const me = useMe();
  useLoadingAnnouncement("Sign-in methods", methods.isPending);
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<unknown>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [useOpen, setUseOpen] = React.useState(false);
  const [useId, setUseId] = React.useState<string | null>(null);
  // The Worker said this passkey can't open the console: the dialog offers Add a passkey instead.
  const [refused, setRefused] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const supported = React.useMemo(() => passkeysSupported(), []);

  const list = methods.data?.methods ?? [];
  const names = React.useMemo(() => titles(list), [list]);
  const { opens, locker } = grouped(list);
  const target = list.find((m) => m.id === useId) ?? null;
  const targetName = target ? (names.get(target.id) ?? "This passkey") : null;
  const offReason = addOffReason({
    supported,
    canAdd: methods.data?.canAdd,
    reason: methods.data?.reason,
    passkeys: list.filter((m) => m.kind === "passkey").length,
  });

  // After a change, focus the row that changed (it may have moved between groups).
  React.useEffect(() => {
    if (!focusId) return;
    const row = [
      ...document.querySelectorAll<HTMLElement>("[data-method-id]"),
    ].find((e) => e.dataset.methodId === focusId);
    if (!row) return;
    // After the dialog has closed and given its own focus back (the row may have moved groups).
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        row.focus();
        setFocusId(null);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [focusId, methods.data]);

  const askUse = (m: ConsoleMethod): void => {
    setUseId(m.id);
    setRefused(false);
    setUseOpen(true);
  };

  /** The whole ceremony; a browser-side end is a notice, anything else throws. */
  const addPasskey = async (): Promise<void> => {
    setNotice(null);
    const { options } = (await mutate("myPasskeyOptions")) as {
      options: Record<string, unknown>;
    };
    let response: Record<string, unknown>;
    try {
      response = await createPasskey(options);
    } catch (e) {
      if (e instanceof PasskeyError) {
        setNotice(ceremonyNotice(e.reason));
        return;
      }
      throw e;
    }
    const added = await mutate("myPasskeyAdd", response);
    toast.success("Passkey added", {
      description: "It opens the console from now on.",
    });
    setFocusId(added.passkey.methodId);
  };

  const ceremonyNotice = (why: Ceremony): Notice => {
    if (why === "exists") {
      const eligible = list.find((m) => m.consoleEligible);
      return eligible
        ? {
            tone: "info",
            title: "This device already has a passkey for you",
            body: "Use it for the console instead.",
            action: {
              label: "Use for the console",
              run: () => askUse(eligible),
            },
          }
        : {
            tone: "warning",
            title: "This device already has a passkey for you",
            body: "Use another device or security key.",
          };
    }
    if (why === "unsupported")
      return { tone: "warning", title: "This browser can't create passkeys" };
    return {
      tone: why === "cancelled" ? "info" : "warning",
      title:
        why === "cancelled" ? "Nothing was added" : "Couldn't add the passkey",
      action: { label: "Try again", run: () => void tryAgain() },
    };
  };

  /** Try again starts the prompt at once: the click is the user's confirmation. */
  const tryAgain = async (): Promise<void> => {
    setRetrying(true);
    setAddError(null);
    try {
      await addPasskey();
    } catch (e) {
      if (isStepUpRequired(e)) {
        setAddError(e);
        setAdding(true);
      } else {
        const r = refusal(e);
        setNotice({ tone: "warning", title: r.title, body: r.description });
      }
    } finally {
      setRetrying(false);
    }
  };

  const usePasskey = async (): Promise<void> => {
    if (refused) {
      await addPasskey();
      setUseOpen(false);
      return;
    }
    // The route needs only the id, so a confirm before the list has loaded still sends.
    if (!useId) throw new Error("Choose a passkey first.");
    try {
      await mutate("myMethodStrong", useId);
    } catch (e) {
      const x = e as { reason?: string; status?: number };
      if (x.reason === "already_strong") {
        await methods.refetch();
        toast.info(`${targetName ?? "This passkey"} already opens the console`);
        setFocusId(useId);
        setUseOpen(false);
        return;
      }
      if (x.reason === "not_eligible") {
        void methods.refetch();
        setRefused(true);
        return;
      }
      if (x.status === 404 && !isStepUpRequired(e)) {
        void methods.refetch();
        setUseOpen(false);
        focusHeading();
        setNotice({
          tone: "warning",
          title: "This passkey was removed",
          body: "It's no longer on your account.",
        });
        return;
      }
      throw e;
    }
    // The row moves groups on the refetch: focus it once it is where it will stay.
    if (methods.data) await methods.refetch();
    else void methods.refetch();
    toast.success(`${targetName ?? "The passkey"} now opens the console`);
    setFocusId(useId);
    setUseOpen(false);
  };

  const lockerHref = customerOrigin
    ? `${customerOrigin}/#/account/methods`
    : null;

  return (
    <div className="max-w-5xl space-y-6" data-template="settings">
      <PageHeader
        title="Sign-in methods"
        description="Which methods open the console."
        refetching={methods.isFetching && !methods.isPending}
        primaryAction={
          <Button
            onClick={() => {
              setNotice(null);
              setAddError(null);
              setAdding(true);
            }}
            iconStart={<Fingerprint aria-hidden />}
            loading={retrying}
            disabledReason={offReason ?? undefined}
          >
            Add a passkey
          </Button>
        }
      />
      {offReason ? (
        <p aria-hidden className="text-sm text-fg-muted">
          {offReason}
        </p>
      ) : null}
      {notice ? (
        <Callout
          tone={notice.tone}
          title={notice.title}
          live
          action={
            notice.action ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const run = notice.action!.run;
                  // The callout goes away with its button: focus has to land somewhere.
                  document.querySelector<HTMLElement>("h1")?.focus();
                  setNotice(null);
                  run();
                }}
              >
                {notice.action.label}
              </Button>
            ) : undefined
          }
        >
          {notice.body}
        </Callout>
      ) : null}
      {methods.isError && !methods.data ? (
        <ErrorState
          error={methods.error}
          onRetry={() => void methods.refetch()}
          context={{ thing: "sign-in methods" }}
        />
      ) : methods.isPending ? (
        <div aria-hidden className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : list.length > 0 ? (
        <div id="sign-in-methods-list" className="space-y-6">
          <Group heading={OPENS} rows={opens} names={names} onUse={askUse} />
          <Group
            heading={LOCKER_ONLY}
            rows={locker}
            names={names}
            onUse={askUse}
          />
        </div>
      ) : (
        <EmptyState
          kind="first-run"
          title="No sign-in methods"
          description="Add a passkey to open the console with it."
        />
      )}
      <p className="text-sm text-fg-muted">
        {lockerHref ? (
          <>
            Remove methods in{" "}
            <a
              className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-fg-strong"
              href={lockerHref}
              target="_blank"
              rel="noreferrer"
            >
              Polaris Locker
              <ExternalLink aria-hidden className="size-3.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </>
        ) : (
          "Remove methods in your Polaris Locker account."
        )}
      </p>
      <ConfirmDialog
        open={adding}
        onOpenChange={setAdding}
        intent="neutral"
        title="Add a passkey?"
        consequences={[
          "It opens the console from now on.",
          "We email you and your Superadmins.",
        ]}
        confirmLabel="Add passkey"
        stepUpKey="signin-methods:add"
        signedInAt={me.data?.authAt ?? null}
        describeError={refusal}
        error={addError}
        onConfirm={addPasskey}
      />
      <ConfirmDialog
        open={useOpen}
        onOpenChange={(o) => {
          setUseOpen(o);
          if (!o) setRefused(false);
        }}
        intent="neutral"
        title={
          refused
            ? "This passkey can't open the console"
            : targetName
              ? `Use “${targetName}” for the console?`
              : "Use this passkey for the console?"
        }
        consequences={
          refused
            ? ["It was saved for another site.", "Add a passkey here instead."]
            : [
                "It opens the console from now on.",
                "We email you and your Superadmins.",
              ]
        }
        confirmLabel={refused ? "Add a passkey" : "Use for the console"}
        closeOnSuccess={false}
        stepUpKey="signin-methods:use"
        // A refused Use turned the dialog into the add flow: the step-up must resume that one.
        stepUpState={
          useId ? { id: useId, ...(refused ? { flow: "add" } : {}) } : undefined
        }
        onRestore={(s) => {
          setUseId(s.id ?? null);
          if (s.flow === "add") {
            setUseOpen(false);
            setAddError(null);
            setAdding(true);
          }
        }}
        signedInAt={me.data?.authAt ?? null}
        describeError={refusal}
        onConfirm={usePasskey}
      />
    </div>
  );
}
