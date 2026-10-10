import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Fingerprint,
  Gamepad2,
  Info,
  KeyRound,
  Mail,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Input } from "../../../ui/Input.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { Expand } from "../../../ui/motion/index.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatDate, formatRelative } from "../../../lib/format.js";
import {
  portalApi,
  PortalApiError,
  type PortalAccount,
  type PortalMethod,
  type PortalMethods,
  type PortalPasskey,
  type PortalProvider,
} from "../../api.js";
import { browser } from "../../browser.js";
import { refreshAfterMethodChange, useMethods } from "../../data.js";
import { isStepUpRequired, portalErrorCopy } from "../../errors.js";
import {
  PROVIDER_NAME,
  methodIdentity,
  passkeyName,
  passkeyProvider,
  remainingAfter,
  stepUpFresh,
} from "../../model/methods.js";
import {
  focusPageHeading,
  href,
  scrollBehavior,
  setParams,
} from "../../router.js";
import {
  PasskeyError,
  createPasskey,
  passkeysSupported,
} from "../../webauthn.js";
import { CODE_LENGTH, CodeCells } from "../CodeCells.js";
import {
  AppleGlyph,
  GoogleGlyph,
  ProviderGlyph,
  SteamGlyph,
  WindowsGlyph,
} from "../Glyphs.js";
import { ErrorPanel } from "../States.js";
import { SectionCard } from "../product/Card.js";
import { MethodRow } from "./MethodRow.js";
import { StepUp } from "./StepUp.js";

/**
 * Account → Sign-in methods (PORTAL.md §4.26; G27 on PX-W12's API, passkeys on I-16's).
 *
 * "Each one is a key to this account." Three groups, each with an `h3` focus can return to:
 *
 * - **Accounts**: Apple, Google and Steam (each this deploy can connect, connected or not), then
 *   any platform identity (Game Center, Play Games, single sign-on) the account holds. **Connect**
 *   opens the provider, which comes back to `#/account/methods?connected=<provider>` (or
 *   `?error=<code>&method=<provider>`); **Disconnect** asks for step-up (`MethodRow`).
 * - **Email**: each verified address, the primary first, with **Remove**; **Add an email**
 *   verifies a new one with a 6-digit code.
 * - **Passkeys**: each passkey by its provider (a static AAGUID table, else the browser it was
 *   added from), with **Remove**; **Add a passkey**, disabled with its reason until the account
 *   has a verified email (or while the browser can't make one).
 *
 * The last method is guarded (`last_link`), and every change needs a sign-in from the last
 * 5 minutes (`StepUp`). An Apple Hide My Email account gets a notice at the top. The footnote says
 * every change is recorded and emailed.
 *
 * Not here yet, for want of an API: **Make primary**, a passkey's **Rename**, the products each
 * method brought in and the products that know the person through a method (see PX-13's brief).
 * **Link an existing account** is PX-15's (`LinkAccounts`), so neither the header nor the Hide My
 * Email notice links to it until that screen exists.
 */
export function SignInMethods({
  account,
  params,
}: {
  account: PortalAccount;
  params: URLSearchParams;
}): React.ReactElement {
  const methods = useMethods();
  // One card whatever the state, so nothing remounts as the list arrives.
  const emailOnly = methods.data === null;
  return (
    <SectionCard
      id="methods"
      title="Sign-in methods"
      subtitle={
        emailOnly
          ? "Receipts and security notices go to your primary email."
          : "Each one is a key to this account. Connect or disconnect them any time; you need at least one."
      }
    >
      {emailOnly ? (
        <SignInEmailOnly account={account} />
      ) : methods.isPending ? (
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : methods.error || !methods.data ? (
        <ErrorPanel
          error={methods.error}
          onRetry={() => void methods.refetch()}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <MethodGroups account={account} view={methods.data} params={params} />
      )}
    </SectionCard>
  );
}

/** A Worker without G27: the one address this account signs in with (PX-07's section). */
function SignInEmailOnly({
  account,
}: {
  account: PortalAccount;
}): React.ReactElement {
  return (
    <>
      <h3 className="mb-2 text-xs font-semibold text-fg-muted">Email</h3>
      <ul className="divide-y divide-border border-y border-border">
        <li className="flex items-center gap-3 py-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong">
            <Mail aria-hidden className="size-5" />
          </span>
          <p className="min-w-0 flex-1 truncate font-medium text-fg-strong">
            {account.email}
          </p>
        </li>
      </ul>
    </>
  );
}

/** Apple, Google or Steam: a key of `PROVIDER_NAME` of its own, never an inherited one. */
function isProvider(kind: string | null): kind is PortalProvider {
  return (
    kind !== null && Object.prototype.hasOwnProperty.call(PROVIDER_NAME, kind)
  );
}

/**
 * What a provider callback came back with (`?connected=` or `?error=&method=`), in words.
 * "Connected" is said only when the methods list shows it connected: the URL alone is no proof.
 */
function callbackNotice(
  params: URLSearchParams,
  view: PortalMethods,
): { tone: "success" | "danger"; text: string } | null {
  const method = params.get("method") ?? params.get("connected");
  const name = isProvider(method) ? PROVIDER_NAME[method] : "That account";
  const connected = params.get("connected");
  if (connected)
    return isProvider(connected) &&
      view.providers.some((p) => p.kind === connected && p.connected)
      ? { tone: "success", text: `${name} is connected.` }
      : null;
  const error = params.get("error");
  if (!error) return null;
  if (error === "link_conflict")
    return {
      tone: "danger",
      text: `That ${name} account is connected to another Polaris Key account, so it wasn't added here. Connect a different one, or sign in to that account to use it.`,
    };
  if (error === "step_up_required")
    return {
      tone: "danger",
      text: `Confirm it's you, then connect ${name} again.`,
    };
  if (error === "signin_expired")
    return {
      tone: "danger",
      text: `That took too long. Connect ${name} again.`,
    };
  return { tone: "danger", text: `${name} wasn't connected. Try again.` };
}

// 9rem (6rem on desk) below the top: the shell's scroll padding (`--pk-scroll-top`, the header
// and the section pills) plus this margin; 0.75rem under whatever sticks on a short screen
// (product/Card.tsx).
const GROUP_HEADING =
  "text-xs font-medium text-fg-muted outline-none scroll-mt-[calc(9rem_-_var(--pk-scroll-top,0px))] desk:scroll-mt-[calc(6rem_-_var(--pk-scroll-top,0px))] short:scroll-mt-3";

function MethodGroups({
  account,
  view,
  params,
}: {
  account: PortalAccount;
  view: PortalMethods;
  params: URLSearchParams;
}): React.ReactElement {
  const ids = {
    accounts: React.useId(),
    email: React.useId(),
    passkeys: React.useId(),
  };
  const focusGroup = (g: keyof typeof ids) => () => {
    const el = document.getElementById(ids[g]);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() });
  };
  /** "Add your real email" (the Hide My Email notice) opens Add an email: a new value each time. */
  const [addEmailAsked, setAddEmailAsked] = React.useState(0);
  /** Back from a provider's step-up to add a passkey or connect a provider: their button. */
  const [passkeyAsked, setPasskeyAsked] = React.useState(0);
  const [connectAsked, setConnectAsked] = React.useState<{
    kind: PortalProvider;
    n: number;
  } | null>(null);
  // A provider's callback, a step-up sign-in coming back to finish what it started (`?remove=`,
  // `?add=email|passkey`, `?connect=<provider>`), or a link asking for Add an email: each is read
  // once and dropped from the URL, so a reload doesn't repeat it.
  const [notice, setNotice] = React.useState(() =>
    callbackNotice(params, view),
  );
  const [removeId] = React.useState(() => params.get("remove"));
  React.useEffect(() => {
    const said = callbackNotice(params, view);
    const add = params.get("add");
    const connect = params.get("connect");
    if (
      !said &&
      !add &&
      !connect &&
      !params.get("remove") &&
      !params.get("connected") &&
      !params.get("error")
    )
      return;
    if (said) setNotice(said);
    if (said?.tone === "success") {
      toast.success(said.text);
      announce(said.text);
    }
    if (add === "email") setAddEmailAsked((n) => n + 1);
    if (add === "passkey") setPasskeyAsked((n) => n + 1);
    if (isProvider(connect))
      setConnectAsked((c) => ({ kind: connect, n: (c?.n ?? 0) + 1 }));
    setParams({
      connected: null,
      error: null,
      method: null,
      remove: null,
      add: null,
      connect: null,
    });
    // `view` is read as the parameters arrive; a later refetch says nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const returnTo = (extra?: Record<string, string>): string =>
    `${window.location.origin}/${href.account("methods")}${
      extra ? `?${new URLSearchParams(extra).toString()}` : ""
    }`;
  const common = {
    view,
    accountId: account.id,
  };
  const accounts = view.methods.filter((m) => m.group === "accounts");
  const others = accounts.filter((m) => !isProvider(m.kind));
  const passkeyByMethod = new Map(view.passkeys.map((p) => [p.methodId, p]));
  const notifyTo = view.primaryEmail ?? account.email;
  const recorded = notifyTo
    ? `We record the change and email ${notifyTo}.`
    : "We record the change.";
  const rowFor = (
    m: PortalMethod,
    group: keyof typeof ids,
    shape: {
      icon: React.ReactNode;
      title: React.ReactNode;
      name: string;
      keepLabel: string;
      guardName: string;
      identity?: React.ReactNode;
      meta: React.ReactNode;
      verb: "Disconnect" | "Remove";
      consequence: string;
      doneText: string;
      notice?: React.ReactNode;
    },
  ): React.ReactElement => {
    const left = remainingAfter(view.methods, m.id);
    return (
      <MethodRow
        key={m.id}
        id={m.id}
        {...common}
        icon={shape.icon}
        title={shape.title}
        name={shape.name}
        keepLabel={shape.keepLabel}
        guardName={shape.guardName}
        badge={
          m.reason === "last_link" ? (
            <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent-fg">
              Only method
            </span>
          ) : undefined
        }
        identity={shape.identity}
        meta={shape.meta}
        notice={shape.notice}
        canRemove={m.canRemove}
        reason={m.reason}
        verb={shape.verb}
        consequences={[
          left
            ? `${shape.consequence} You still have ${left}.`
            : shape.consequence,
          recorded,
        ]}
        returnTo={returnTo({ remove: m.id })}
        initiallyOpen={removeId === m.id && m.canRemove}
        focusAfter={focusGroup(group)}
        doneText={shape.doneText}
      />
    );
  };

  return (
    <div className="space-y-6">
      {notice && notice.tone === "danger" ? (
        <Callout tone="danger" live>
          {notice.text}
        </Callout>
      ) : null}
      {view.hideMyEmail ? (
        <Callout
          tone="info"
          title="Bought something with your real email?"
          action={
            <Button
              variant="outline"
              size="sm"
              className="font-medium"
              onClick={() => setAddEmailAsked((n) => n + 1)}
            >
              Add your real email
            </Button>
          }
        >
          Hide My Email gave us a private address, so we can't match it to your
          real email. Add your real email and purchases made with it join your
          library.
        </Callout>
      ) : null}

      <div>
        <h3 id={ids.accounts} tabIndex={-1} className={GROUP_HEADING}>
          Accounts
        </h3>
        <ul className="divide-y divide-border">
          {(["apple", "google", "steam"] as const).flatMap((kind) => {
            const linked = accounts.filter((m) => m.kind === kind);
            const provider = view.providers.find((p) => p.kind === kind);
            if (linked.length === 0)
              return provider?.available
                ? [
                    <ConnectRow
                      key={kind}
                      kind={kind}
                      {...common}
                      returnTo={returnTo({ connect: kind })}
                      asked={connectAsked?.kind === kind ? connectAsked.n : 0}
                    />,
                  ]
                : [];
            return linked.map((m) =>
              rowFor(m, "accounts", {
                icon: <ProviderGlyph provider={kind} />,
                title: PROVIDER_NAME[kind],
                name: PROVIDER_NAME[kind],
                keepLabel: `Keep ${PROVIDER_NAME[kind]}`,
                guardName: PROVIDER_NAME[kind],
                identity: methodIdentity(m),
                meta: methodMeta(m),
                verb: "Disconnect",
                consequence: `You won't sign in with ${PROVIDER_NAME[kind]} any more.`,
                doneText: `${PROVIDER_NAME[kind]} was disconnected`,
                notice: flagText(m),
              }),
            );
          })}
          {others.map((m) =>
            rowFor(m, "accounts", {
              icon:
                m.kind === "oidc" ? (
                  <ShieldCheck aria-hidden />
                ) : (
                  <Gamepad2 aria-hidden />
                ),
              title: m.label,
              name: m.label,
              keepLabel: `Keep ${m.label}`,
              guardName: m.label,
              identity: methodIdentity(m),
              meta: methodMeta(m),
              verb: "Disconnect",
              consequence: `You won't sign in with ${m.label} any more.`,
              doneText: `${m.label} was disconnected`,
              notice: flagText(m),
            }),
          )}
        </ul>
      </div>

      <div>
        <h3 id={ids.email} tabIndex={-1} className={GROUP_HEADING}>
          Email
          <span className="font-normal"> · sign in with a code</span>
        </h3>
        <ul className="divide-y divide-border">
          {view.emails.map((e) => {
            const m = view.methods.find((x) => x.id === e.methodId);
            if (!m) return null;
            return rowFor(m, "email", {
              icon: <Mail aria-hidden />,
              title: e.email,
              name: e.email,
              keepLabel: "Keep it",
              guardName: "this email",
              meta: [
                e.primary ? "Primary" : null,
                `added ${formatDate(e.connectedAt * 1000)}`,
                e.lastUsedAt
                  ? `last used ${formatRelative(e.lastUsedAt * 1000)}`
                  : "never used to sign in",
              ]
                .filter(Boolean)
                .join(" · "),
              verb: "Remove",
              consequence: e.primary
                ? `You won't sign in with ${e.email} any more, and notices go to your next oldest address.`
                : `You won't sign in with ${e.email} any more.`,
              doneText: `${e.email} was removed`,
            });
          })}
          <AddEmail
            {...common}
            returnTo={returnTo({ add: "email" })}
            asked={addEmailAsked}
            onAdded={focusGroup("email")}
          />
        </ul>
      </div>

      <div>
        <h3 id={ids.passkeys} tabIndex={-1} className={GROUP_HEADING}>
          Passkeys
        </h3>
        <ul className="divide-y divide-border">
          {view.methods
            .filter((m) => m.group === "passkeys")
            .map((m) => {
              const p = passkeyByMethod.get(m.id);
              const name = p ? passkeyName(p) : "Passkey";
              const which =
                name === "Passkey" ? "this passkey" : `the ${name} passkey`;
              return rowFor(m, "passkeys", {
                icon: <PasskeyGlyph passkey={p} />,
                title: name,
                name: which,
                keepLabel: "Keep it",
                guardName: "this passkey",
                meta: p ? passkeyMeta(p) : methodMeta(m),
                verb: "Remove",
                consequence: `You won't sign in with ${which} any more. It stays on your device until you delete it there.`,
                doneText: "The passkey was removed",
              });
            })}
          <AddPasskey
            {...common}
            returnTo={returnTo({ add: "passkey" })}
            asked={passkeyAsked}
            onAdded={focusGroup("passkeys")}
          />
        </ul>
      </div>

      <p className="flex gap-2 text-sm text-fg-muted">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        {notifyTo
          ? `Changing a method asks you to confirm it's you. Every change is recorded and emailed to ${notifyTo}.`
          : "Changing a method asks you to confirm it's you. Every change is recorded."}
      </p>
    </div>
  );
}

function methodMeta(m: PortalMethod): string {
  return [
    `Connected ${formatDate(m.connectedAt * 1000)}`,
    m.lastUsedAt ? `last used ${formatRelative(m.lastUsedAt * 1000)}` : null,
    m.tenantScoped ? "connect only from inside a game" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function passkeyMeta(p: PortalPasskey): string {
  const named = passkeyProvider(p.aaguid) !== null;
  return [
    `Added ${formatDate(p.createdAt * 1000)}`,
    p.lastUsedAt
      ? `last used ${formatRelative(p.lastUsedAt * 1000)}`
      : "never used to sign in",
    // The browser it came from, unless it already names the passkey.
    named && p.addedFrom ? `added on ${p.addedFrom}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a provider reported about a method since it was linked (Apple's notifications, I-06). */
function flagText(m: PortalMethod): string | null {
  switch (m.flag) {
    case "consent_revoked":
      return `You stopped using ${m.label} with Polaris Key. Connect it again to sign in with it.`;
    case "account_deleted":
      return `That ${m.label} account was deleted.`;
    case "email_disabled":
      return "Hide My Email stopped forwarding to this address.";
    default:
      return null;
  }
}

function PasskeyGlyph({
  passkey,
}: {
  passkey: PortalPasskey | undefined;
}): React.ReactElement {
  const glyph = passkeyProvider(passkey?.aaguid)?.glyph;
  if (glyph === "apple") return <AppleGlyph />;
  if (glyph === "google") return <GoogleGlyph />;
  if (glyph === "windows") return <WindowsGlyph />;
  return <Fingerprint aria-hidden />;
}

/** The failure of a change that is not "confirm it's you first", in words. */
function changeErrorText(err: unknown, name?: string): string {
  if (err instanceof PortalApiError) {
    if (err.code === "link_conflict")
      return err.message && err.message !== `portal api ${err.status}`
        ? err.message
        : "Another Polaris Key account uses this. Use a different one.";
    if (err.code === "auth_method_disabled" || err.status === 404)
      return `${name ?? "This"} isn't available here right now.`;
    if (err.status === 503)
      return `${name ?? "It"} can't be reached right now. Try again later.`;
    if (err.status === 429)
      return "Too many changes. Wait a minute, then try again.";
    if (err.reason === "email_unverified" || err.reason === "limit")
      return err.message;
  }
  const copy = portalErrorCopy(err);
  return `${copy.title}. ${copy.description}`;
}

/** When `asked` changes (above 0), focus `ref` after the page's own heading focus, in view. */
function useAskedFocus(
  asked: number,
  ref: React.RefObject<HTMLElement | null>,
): void {
  React.useEffect(() => {
    if (asked === 0) return;
    focusPageHeading(() => ref.current);
    ref.current?.scrollIntoView?.({
      block: "center",
      behavior: scrollBehavior(),
    });
    // Only when asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
}

/**
 * A provider the account hasn't connected: **Connect** opens it (after step-up), and it comes back
 * to the account page linked, or with the reason it wasn't.
 */
function ConnectRow({
  kind,
  view,
  accountId,
  returnTo,
  asked,
}: {
  kind: PortalProvider;
  view: PortalMethods;
  accountId: string;
  returnTo: string;
  /** Changes when a provider's step-up comes back to connect this one (`?connect=`). */
  asked: number;
}): React.ReactElement {
  const [stepUp, setStepUp] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const name = PROVIDER_NAME[kind];
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  // Confirmed with another provider and back: Connect is the next thing to press (the page
  // never leaves for a second provider by itself).
  useAskedFocus(asked, buttonRef);
  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const out = await portalApi.startProviderMethod(kind);
      browser.go(out.redirect);
    } catch (err) {
      setBusy(false);
      if (isStepUpRequired(err)) setStepUp(true);
      else setError(changeErrorText(err, name));
    }
  };
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong [&_svg]:size-5">
          {kind === "apple" ? (
            <AppleGlyph />
          ) : kind === "google" ? (
            <GoogleGlyph />
          ) : (
            <SteamGlyph />
          )}
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="font-medium text-fg-strong">{name}</p>
          <p className="text-sm text-fg-muted">Not connected</p>
        </div>
        {stepUp ? null : (
          <Button
            ref={buttonRef}
            variant="outline"
            className="ml-auto h-10 font-medium"
            loading={busy}
            aria-label={`Connect ${name}`}
            onClick={() => void connect()}
          >
            Connect
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger sm:pl-13">
          {error}
        </p>
      ) : null}
      {stepUp ? (
        <div className="mt-3 space-y-3 rounded-lg border border-border bg-surface-sunken p-4 sm:ml-13">
          <StepUp
            verb={`connect ${name}`}
            view={view}
            accountId={accountId}
            returnTo={returnTo}
            autoFocus
            onConfirmed={() => {
              setStepUp(false);
              requestAnimationFrame(() => buttonRef.current?.focus());
              void connect();
            }}
          />
          <Button
            variant="outline"
            onClick={() => {
              setStepUp(false);
              requestAnimationFrame(() => buttonRef.current?.focus());
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </li>
  );
}

type AddEmailStep =
  | { kind: "closed" }
  | { kind: "enter" }
  | { kind: "stepUp" }
  | { kind: "code"; email: string };

/**
 * **Add an email**: the address, a 6-digit code to it, connected. The answer to the first step
 * is the same whoever holds the address (nothing is enumerated); only a right code says it's
 * another account's.
 */
function AddEmail({
  view,
  accountId,
  returnTo,
  asked,
  onAdded,
}: {
  view: PortalMethods;
  accountId: string;
  returnTo: string;
  /** Changes when something else on the page asks for this form (the Hide My Email notice). */
  asked: number;
  onAdded: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const [step, setStep] = React.useState<AddEmailStep>({ kind: "closed" });
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [invalid, setInvalid] = React.useState(false);
  const fieldId = React.useId();
  const codeId = React.useId();
  const errorId = React.useId();
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  /** Opened from elsewhere (a link, the notice): the field takes focus after the page's own. */
  const askedRef = React.useRef(false);
  const focusField = (): void => {
    const field = (): HTMLElement | null => document.getElementById(fieldId);
    if (!askedRef.current) {
      field()?.focus({ preventScroll: true });
      return;
    }
    askedRef.current = false;
    // After any navigation's heading focus and any closing dialog (the Activate dialog's
    // "Add and verify that email" lands here), so it is the last to move focus.
    focusPageHeading(field);
  };
  React.useEffect(() => {
    if (asked === 0) return;
    askedRef.current = true;
    if (step.kind === "closed") setStep({ kind: "enter" });
    else focusField();
    // Only when asked again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const close = (): void => {
    setStep({ kind: "closed" });
    setEmail("");
    setCode("");
    setError(null);
    setInvalid(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const send = async (): Promise<void> => {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setInvalid(true);
      setError("Enter a full email address, like name@example.com.");
      document.getElementById(fieldId)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid(false);
    try {
      const out = await portalApi.startEmailMethod(value);
      if (out.status === "connected") {
        toast.success(`${out.email} is already on your account`);
        close();
        return;
      }
      setCode("");
      setStep({ kind: "code", email: out.email });
      requestAnimationFrame(() => document.getElementById(codeId)?.focus());
    } catch (err) {
      if (isStepUpRequired(err)) setStep({ kind: "stepUp" });
      else {
        if (err instanceof PortalApiError && err.status === 422)
          setInvalid(true);
        setError(
          err instanceof PortalApiError && err.status === 422
            ? "Enter a full email address, like name@example.com."
            : err instanceof PortalApiError && err.code === "email_unavailable"
              ? "We can't send email right now. Try again later."
              : changeErrorText(err),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string): Promise<void> => {
    if (value.length !== CODE_LENGTH || busy || step.kind !== "code") return;
    setBusy(true);
    setError(null);
    try {
      const out = await portalApi.verifyEmailMethod(value);
      const text = `${out.email} was added`;
      toast.success(text, {
        description: "Products bought with it join your library.",
      });
      announce(text);
      refreshAfterMethodChange(qc);
      setStep({ kind: "closed" });
      setEmail("");
      setCode("");
      onAdded();
    } catch (err) {
      setCode("");
      if (isStepUpRequired(err)) setStep({ kind: "stepUp" });
      else if (err instanceof PortalApiError && err.code === "invalid_code") {
        const left = err.triesLeft;
        setError(
          left === 0
            ? "Too many tries. Send a new code."
            : `That code isn't right. Check the email and try again.${
                left !== undefined && left <= 2
                  ? left === 1
                    ? " 1 try left."
                    : ` ${left} tries left.`
                  : ""
              }`,
        );
      } else if (err instanceof PortalApiError && err.code === "signin_expired")
        setError("That code has expired. Send a new code.");
      else setError(changeErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const open = step.kind !== "closed";
  return (
    <li className="py-3">
      {open ? null : (
        <Button
          ref={buttonRef}
          variant="link"
          className="h-11 font-medium sm:ml-13"
          iconStart={<Plus aria-hidden />}
          aria-expanded={false}
          onClick={() => setStep({ kind: "enter" })}
        >
          Add an email
        </Button>
      )}
      <Expand
        open={open}
        onOpen={focusField}
        onOpened={(region) =>
          region.scrollIntoView?.({
            block: "nearest",
            behavior: scrollBehavior(),
          })
        }
      >
        <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4 sm:ml-13">
          <h4 className="font-semibold text-fg-strong">Add an email</h4>
          {step.kind === "stepUp" ? (
            <StepUp
              verb="add it"
              view={view}
              accountId={accountId}
              returnTo={returnTo}
              autoFocus
              onConfirmed={() => {
                // Back to the address (focus with it), and on with sending the code.
                setStep({ kind: "enter" });
                requestAnimationFrame(() =>
                  document.getElementById(fieldId)?.focus(),
                );
                void send();
              }}
            />
          ) : step.kind === "code" ? (
            <form
              noValidate
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void verify(code);
              }}
            >
              <p role="status" className="text-sm text-fg">
                We sent a 6-digit code to{" "}
                <span className="font-medium text-fg-strong">{step.email}</span>
                . It works for 10 minutes.
              </p>
              <label
                htmlFor={codeId}
                className="text-sm font-medium text-fg-strong"
              >
                Code
              </label>
              <div className="max-w-xs">
                <CodeCells
                  id={codeId}
                  value={code}
                  invalid={Boolean(error)}
                  describedBy={error ? errorId : undefined}
                  onChange={(v) => {
                    setCode(v);
                    if (error) setError(null);
                    if (v.length === CODE_LENGTH) void verify(v);
                  }}
                />
              </div>
              {error ? (
                <p id={errorId} role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  loading={busy}
                  disabled={code.length !== CODE_LENGTH}
                >
                  Add {step.email}
                </Button>
                <Button
                  variant="link"
                  className="text-sm font-medium"
                  onClick={() => void send()}
                >
                  Send a new code
                </Button>
              </div>
            </form>
          ) : (
            <form
              noValidate
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label
                htmlFor={fieldId}
                className="text-sm font-medium text-fg-strong"
              >
                Email address
              </label>
              <Input
                id={fieldId}
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onValueChange={(v) => {
                  setEmail(v);
                  if (invalid) setInvalid(false);
                }}
                aria-invalid={invalid || undefined}
                aria-describedby={error ? errorId : undefined}
              />
              {error ? (
                <p id={errorId} role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : (
                <p className="text-sm text-fg-muted">
                  We'll send a code to check it's yours.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" loading={busy}>
                  Send code
                </Button>
              </div>
            </form>
          )}
          {step.kind === "stepUp" ? (
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
          ) : null}
        </div>
      </Expand>
    </li>
  );
}

/**
 * **Add a passkey**: I-16's registration challenge (after step-up), the browser's prompt, the
 * attestation. Disabled, with its reason as text, while the account has no verified email (a
 * passkey is never the only way back in), at the limit, or in a browser without passkeys.
 */
function AddPasskey({
  view,
  accountId,
  returnTo,
  asked,
  onAdded,
}: {
  view: PortalMethods;
  accountId: string;
  returnTo: string;
  /** Changes when a provider's step-up comes back to add a passkey (`?add=passkey`). */
  asked: number;
  onAdded: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const [stepUp, setStepUp] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const reasonId = React.useId();
  const supported = passkeysSupported();
  // Back from a provider's step-up: a browser makes a passkey only from a click, so the button
  // takes focus, ready to press.
  useAskedFocus(asked, buttonRef);
  React.useEffect(() => {
    if (asked > 0 && stepUpFresh(view.stepUp, Math.floor(Date.now() / 1000)))
      setReady(true);
    // Only when asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  const reason = !view.passkey.canAdd
    ? view.passkey.reason === "limit"
      ? "You have as many passkeys as an account can hold. Remove one to add another."
      : "Add an email first: it's how you get back in if a passkey is lost."
    : !supported
      ? "This browser can't make passkeys. Try another browser or device."
      : null;

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await portalApi.passkeyRegistrationOptions();
      const response = await createPasskey(options);
      await portalApi.addPasskey(response);
      toast.success("Passkey added", {
        description: "Use it to sign in to Polaris Key on this device.",
      });
      announce("Passkey added");
      refreshAfterMethodChange(qc);
      setStepUp(false);
      setReady(false);
      onAdded();
    } catch (err) {
      if (isStepUpRequired(err)) setStepUp(true);
      else if (err instanceof PasskeyError)
        setError(
          err.reason === "exists"
            ? "This device already has a passkey for your account."
            : err.reason === "cancelled"
              ? "The passkey wasn't added. Try again when you're ready."
              : "This browser couldn't make a passkey. Try another browser or device.",
        );
      else setError(changeErrorText(err, "Passkeys"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-3">
      {stepUp ? null : (
        <Button
          ref={buttonRef}
          variant="link"
          className="h-11 font-medium sm:ml-13"
          iconStart={<KeyRound aria-hidden />}
          loading={busy}
          aria-disabled={reason ? true : undefined}
          aria-describedby={reason ? reasonId : undefined}
          onClick={() => {
            if (!reason) void add();
          }}
        >
          Add a passkey
        </Button>
      )}
      {reason ? (
        <p id={reasonId} className="text-sm text-fg-muted sm:pl-13">
          {reason}
        </p>
      ) : null}
      {ready && !stepUp && !error ? (
        <p role="status" className="text-sm text-fg sm:pl-13">
          Thanks, that's you. Now add your passkey.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-sm text-danger sm:pl-13">
          {error}
        </p>
      ) : null}
      {stepUp ? (
        <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4 sm:ml-13">
          <StepUp
            verb="add a passkey"
            view={view}
            accountId={accountId}
            returnTo={returnTo}
            autoFocus
            onConfirmed={() => {
              // A browser makes a passkey only from a click, so the person presses Add a passkey
              // once more (focus is on it), now with a fresh sign-in.
              setStepUp(false);
              setReady(true);
              requestAnimationFrame(() => buttonRef.current?.focus());
            }}
          />
          <Button
            variant="outline"
            onClick={() => {
              setStepUp(false);
              requestAnimationFrame(() => buttonRef.current?.focus());
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </li>
  );
}
