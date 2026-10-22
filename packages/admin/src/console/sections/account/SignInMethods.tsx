/**
 * Sign-in methods (`#/account/sign-in-methods`, ST-30c.4): the signed-in operator's own methods,
 * which of them open the console, "Add a passkey" and "Use for the console".
 *
 * Both writes are step-up rows. The confirm dialog is the house step-up (D11): a 403
 * `step_up_required` turns it into "Sign in again", and the dialog is back on this page after the
 * sign-in. Removal is not here: the Locker account holds the methods, so the page points there.
 * An emergency (break-glass) session has no account behind it, so it has no methods to show.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Fingerprint, KeyRound, Link2, Mail } from "lucide-react";
import { api, type ConsoleMethod } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import {
  PasskeyError,
  createPasskey,
  passkeysSupported,
} from "../../../lib/webauthn.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useMe } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";

export function useMyMethods() {
  return useQuery({
    queryKey: qk.myMethods(),
    queryFn: () => api.myMethods().then((r) => r.methods),
  });
}

const KIND_LABEL: Record<string, string> = {
  passkey: "Passkey",
  oidc: "Linked account",
  email: "Email",
};

function kindIcon(kind: string): React.ReactElement {
  const Icon = kind === "passkey" ? KeyRound : kind === "email" ? Mail : Link2;
  return <Icon aria-hidden className="size-4" />;
}

/** The label a row carries: its name, else the kind in words. */
export function methodLabel(m: ConsoleMethod): string {
  return m.name ?? KIND_LABEL[m.kind] ?? "Sign-in method";
}

/** What a refused write says, keyed off the Worker's `reason`, never its sentence. */
function refusal(error: unknown): { title: string; description?: string } {
  const reason = (error as { reason?: string } | null)?.reason;
  if (reason === "not_eligible")
    return {
      title: "This passkey can't be used here",
      description: "Add a passkey on this page instead.",
    };
  if (reason === "already_strong")
    return { title: "This passkey already signs you in here" };
  if (error instanceof PasskeyError)
    return { title: "Couldn't add the passkey", description: "Try again." };
  return errorCopy(error, { thing: "sign-in methods" });
}

/** A browser-side ceremony that ended without a passkey, as the page words it. */
type Ceremony = "cancelled" | "exists" | "unsupported" | "failed";
const CEREMONY: Record<
  Ceremony,
  { tone: "info" | "warning"; title: string; body: string }
> = {
  cancelled: {
    tone: "info",
    title: "Nothing was added",
    body: "Your browser closed the prompt.",
  },
  exists: {
    tone: "warning",
    title: "This device already has a passkey for you",
    body: "Use another device or security key.",
  },
  unsupported: {
    tone: "warning",
    title: "This browser can't create passkeys here",
    body: "Try another browser or device.",
  },
  failed: {
    tone: "warning",
    title: "Couldn't add the passkey",
    body: "Nothing was changed.",
  },
};

function MethodRow({
  method,
  onUse,
}: {
  method: ConsoleMethod;
  onUse: (m: ConsoleMethod) => void;
}): React.ReactElement {
  const label = methodLabel(method);
  return (
    <li
      data-method-id={method.id}
      tabIndex={-1}
      className="flex flex-col gap-3 px-4 py-3 outline-none sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 text-fg-muted">{kindIcon(method.kind)}</span>
        <div className="min-w-0">
          <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
            {label}
          </p>
          <p className="text-xs text-fg-muted">
            {KIND_LABEL[method.kind] ?? method.kind}
            {" · Added "}
            <Timestamp at={fromSeconds(method.createdAt)} format="date" />
            {" · "}
            {method.lastUsedAt === null ? (
              "Never used"
            ) : (
              <>
                Used <Timestamp at={fromSeconds(method.lastUsedAt)} />
              </>
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:justify-end">
        {method.strong ? (
          <StatusPill tone="success">Opens the console</StatusPill>
        ) : (
          <StatusPill tone="neutral">Doesn&apos;t open the console</StatusPill>
        )}
        {method.consoleEligible ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onUse(method)}
            aria-label={`Use ${label} for the console`}
          >
            Use for the console
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function focusSoon(find: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      (find() ?? document.querySelector<HTMLElement>("h1"))?.focus(),
    ),
  );
}

export function SignInMethods(): React.ReactElement {
  const me = useMe();
  if (me.data?.breakGlass) return <BreakGlass />;
  return <Methods customerOrigin={me.data?.customerOrigin ?? null} />;
}

function BreakGlass(): React.ReactElement {
  return (
    <div className="space-y-6" data-template="settings">
      <PageHeader title="Sign-in methods" />
      <EmptyState
        kind="first-run"
        title="Emergency sign-in can't manage sign-in methods"
        description="Sign out, then sign in with your account to add a passkey or use one for the console."
      />
    </div>
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
  const [useOpen, setUseOpen] = React.useState(false);
  const [useId, setUseId] = React.useState<string | null>(null);
  const [ceremony, setCeremony] = React.useState<Ceremony | null>(null);
  const target = (methods.data ?? []).find((m) => m.id === useId) ?? null;

  const addPasskey = async (): Promise<void> => {
    setCeremony(null);
    if (!passkeysSupported()) {
      setCeremony("unsupported");
      return;
    }
    // The challenge first: a stale sign-in answers 403 here, before the browser prompts.
    const { options } = (await mutate("myPasskeyOptions")) as {
      options: Record<string, unknown>;
    };
    let response: Record<string, unknown>;
    try {
      response = await createPasskey(options);
    } catch (e) {
      if (e instanceof PasskeyError) {
        setCeremony(e.reason);
        return;
      }
      throw e;
    }
    await mutate("myPasskeyAdd", response);
    toast.success("Passkey added", {
      description: "It signs you in to Polaris Key.",
    });
    focusSoon(() => document.getElementById("sign-in-methods-list"));
  };

  const usePasskey = async (): Promise<void> => {
    if (!target) return;
    try {
      await mutate("myMethodStrong", target.id);
    } catch (e) {
      // The list is stale when the Worker says it is already done: show the truth.
      if ((e as { reason?: string }).reason === "already_strong")
        void methods.refetch();
      throw e;
    }
    toast.success("Passkey set", {
      description: `${methodLabel(target)} signs you in to Polaris Key.`,
    });
    focusSoon(() =>
      [...document.querySelectorAll<HTMLElement>("[data-method-id]")].find(
        (e) => e.dataset.methodId === target.id,
      ),
    );
  };

  const lockerHref = customerOrigin
    ? `${customerOrigin}/#/account/methods`
    : null;
  const note = ceremony ? CEREMONY[ceremony] : null;

  return (
    <div className="space-y-6" data-template="settings">
      <PageHeader
        title="Sign-in methods"
        description="How you sign in to Polaris Key."
        refetching={methods.isFetching && !methods.isPending}
        primaryAction={
          <Button
            onClick={() => {
              setCeremony(null);
              setAdding(true);
            }}
            iconStart={<Fingerprint aria-hidden />}
          >
            Add a passkey
          </Button>
        }
      />
      {note ? (
        <Callout
          tone={note.tone}
          title={note.title}
          live
          action={
            ceremony === "cancelled" || ceremony === "failed" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCeremony(null);
                  setAdding(true);
                }}
              >
                Try again
              </Button>
            ) : undefined
          }
        >
          {note.body}
        </Callout>
      ) : null}
      {methods.isError && !methods.data ? (
        <ErrorState
          error={methods.error}
          onRetry={() => void methods.refetch()}
          context={{ thing: "sign-in methods" }}
        />
      ) : methods.isPending ? (
        <Skeleton className="h-32 rounded-lg" />
      ) : methods.data && methods.data.length > 0 ? (
        <ul
          id="sign-in-methods-list"
          tabIndex={-1}
          aria-label="Sign-in methods"
          className="divide-y divide-border rounded-lg border border-border bg-surface-raised outline-none"
        >
          {methods.data.map((m) => (
            <MethodRow
              key={m.id}
              method={m}
              onUse={(x) => {
                setUseId(x.id);
                setUseOpen(true);
              }}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          kind="first-run"
          title="No sign-in methods"
          description="Add a passkey to sign in here without a password."
        />
      )}
      <p className="text-sm text-fg-muted">
        To remove a method, use your Polaris Locker account.{" "}
        {lockerHref ? (
          <a
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-fg-strong"
            href={lockerHref}
            target="_blank"
            rel="noreferrer"
          >
            Open Polaris Locker
            <ExternalLink aria-hidden className="size-3.5" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
      </p>
      <ConfirmDialog
        open={adding}
        onOpenChange={setAdding}
        intent="neutral"
        title="Add a passkey?"
        consequences={[
          "Your browser asks you to create it.",
          "It signs you in to Polaris Key.",
          "We email you and your Superadmins.",
        ]}
        confirmLabel="Add passkey"
        stepUpKey="signin-methods:add"
        signedInAt={me.data?.authAt ?? null}
        describeError={refusal}
        onConfirm={addPasskey}
      />
      <ConfirmDialog
        open={useOpen}
        onOpenChange={setUseOpen}
        intent="neutral"
        title={
          target
            ? `Use ${methodLabel(target)} for the console?`
            : "Use this passkey for the console?"
        }
        consequences={[
          "It signs you in to Polaris Key.",
          "We email you and your Superadmins.",
        ]}
        confirmLabel="Use for the console"
        stepUpKey="signin-methods:use"
        stepUpState={useId ? { id: useId } : undefined}
        onRestore={(s) => setUseId(s.id ?? null)}
        signedInAt={me.data?.authAt ?? null}
        describeError={refusal}
        onConfirm={usePasskey}
      />
    </div>
  );
}
