import * as React from "react";
import { ErrorState } from "../../../ui/ErrorState.js";
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
import { ActionMenu } from "../../../ui/ActionMenu.js";
import { Button } from "../../../ui/Button.js";
import { t, tParts } from "../../../lib/copy.js";
import { expiredCodeText, wrongCodeText } from "../../copy/codeEntry.js";
import { Callout } from "../../../ui/Callout.js";
import { Input } from "../../../ui/Input.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { Expand } from "../../../ui/motion/index.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import { PORTAL_FMT } from "../../date.js";
import { formatDay } from "../../date.js";
import {
  HttpError,
  type PortalAccount,
  type PortalMethod,
  type PortalMethods,
  type PortalPasskey,
  type PortalProvider,
} from "../../api.js";
import { browser } from "../../browser.js";
import { useLinkView, useMethods } from "../../data.js";
import { isStepUpRequired, portalErrorCopy } from "../../errors.js";
import {
  PROVIDER_NAME,
  methodIdentity,
  passkeyName,
  passkeyProvider,
  plural,
  remainingAfter,
  stepUpFresh,
} from "../../model/methods.js";
import {
  focusPageHeading,
  href,
  navigate,
  scrollBehavior,
  setParams,
} from "../../router.js";
import {
  PasskeyError,
  createPasskey,
  passkeysSupported,
} from "../../webauthn.js";
import { CODE_LENGTH, CodeCells } from "../../../ui/auth/CodeCells.js";
import {
  AppleGlyph,
  GoogleGlyph,
  ProviderGlyph,
  SteamGlyph,
  WindowsGlyph,
} from "../../../ui/Glyphs.js";
import { AccountCard as SectionCard } from "./AccountCard.js";
import { MethodRow } from "./MethodRow.js";
import {
  MakePrimaryTool,
  RenamePasskeyTool,
  type ToolSlots,
} from "./RowTools.js";
import { StepUp } from "./StepUp.js";
import { mutate } from "../../mutations.js";

/**
 * Account → Sign-in methods (PORTAL.md §4.26; G27 on PX-W12's API, passkeys on I-16's).
 *
 * "Each one is a key to this account." Three groups, each with an `h3` focus can return to:
 *
 * - **Accounts**: Apple, Google and Steam (each this deploy can connect, connected or not), then
 *   any platform identity (Game Center, Play Games, single sign-on) the account holds. **Connect**
 *   opens the provider, which comes back to `#/account/methods?connected=<provider>` (or
 *   `?error=<code>&method=<provider>`); **Disconnect** asks for step-up (`MethodRow`).
 * - **Email**: each verified address, the primary first, with **Make primary** (on the others)
 *   and **Remove**, and how many products the address brought in; **Add an email** verifies a new
 *   one with a 6-digit code.
 * - **Passkeys**: each passkey by the name its holder gave it (**Rename**), else its provider (a
 *   static AAGUID table, else the browser it was added from), with **Remove**; **Add a passkey**,
 *   disabled with its reason until the account has a verified email (or while the browser can't
 *   make one).
 *
 * The last method is guarded (`last_link`), and every change needs a sign-in from the last
 * 5 minutes (`StepUp`). An Apple Hide My Email account gets a notice at the top. The footnote says
 * every change is recorded and emailed.
 *
 * Not here yet, for want of an API: the products that know the person through a method (see
 * PX-13's brief). **Link an existing account** (PX-15's `LinkAccountsDialog`) is the button under
 * the footnote; neither the header nor the Hide My Email notice links to it.
 */
export function SignInMethods({
  account,
  params,
}: {
  account: PortalAccount;
  params: URLSearchParams;
}): React.ReactElement {
  const methods = useMethods();
  /** The header menu's commands: each press bumps a counter the groups below act on. */
  const [cmd, setCmd] = React.useState({ email: 0, passkey: 0 });
  const passkeyReason = methods.data ? passkeyBlock(methods.data) : null;
  // One card whatever the state, so nothing remounts as the list arrives.
  const emailOnly = methods.data === null;
  return (
    <SectionCard
      id="methods"
      title={t("signin.join.methodsLink")}
      aside={
        !emailOnly && methods.data ? (
          <ActionMenu
            label={t("locker.methods.addMethod")}
            align="end"
            trigger={
              <Button
                variant="outline"
                className="max-sm:min-h-11"
                iconStart={<Plus aria-hidden />}
              >
                {t("locker.methods.add")}
              </Button>
            }
            items={[
              {
                label: t("locker.methods.addEmail"),
                onSelect: () =>
                  later(() => setCmd((c) => ({ ...c, email: c.email + 1 }))),
              },
              {
                label: t("signin.gate.passkeyAdd"),
                disabledReason: passkeyReason ?? undefined,
                onSelect: () =>
                  later(() =>
                    setCmd((c) => ({ ...c, passkey: c.passkey + 1 })),
                  ),
              },
            ]}
          />
        ) : null
      }
      subtitle={
        emailOnly
          ? t("locker.methods.subtitleEmail")
          : t("locker.methods.subtitle")
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
        <ErrorState
          account
          error={methods.error}
          onRetry={() => void methods.refetch()}
          message={t("locker.error.loadFailedMethods")}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <MethodGroups
          account={account}
          view={methods.data}
          params={params}
          cmd={cmd}
        />
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
      <h3 className="mb-2 text-xs font-semibold text-fg-muted">
        {t("signin.email.label")}
      </h3>
      <ul className="divide-y divide-border border-b border-border -mx-4 desk:-mx-5 bigtext:max-sm:mx-0 [&>li]:px-4 desk:[&>li]:px-5 bigtext:max-sm:[&>li]:px-0">
        <li className="flex items-center gap-3 py-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong">
            <Mail aria-hidden className="size-5" />
          </span>
          <p className="min-w-0 flex-1 break-words font-medium [overflow-wrap:anywhere] text-fg-strong">
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
  const name = isProvider(method)
    ? PROVIDER_NAME[method]
    : t("locker.methods.thatAccount");
  const connected = params.get("connected");
  if (connected)
    return isProvider(connected) &&
      view.providers.some((p) => p.kind === connected && p.connected)
      ? { tone: "success", text: t("locker.methods.connected", { name }) }
      : null;
  const error = params.get("error");
  if (!error) return null;
  if (error === "link_conflict")
    return {
      tone: "danger",
      text: t("locker.methods.linkConflict", { name }),
    };
  if (error === "step_up_required")
    return {
      tone: "danger",
      text: t("locker.methods.stepUpAgain", { name }),
    };
  if (error === "signin_expired")
    return {
      tone: "danger",
      text: t("locker.methods.tookTooLong", { name }),
    };
  return { tone: "danger", text: t("locker.methods.notConnected", { name }) };
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
  cmd,
}: {
  account: PortalAccount;
  view: PortalMethods;
  params: URLSearchParams;
  cmd: { email: number; passkey: number };
}): React.ReactElement {
  // Link an existing account: absent on a Worker without the route (404).
  const linkView = useLinkView();
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
    ? t("locker.methods.recordedTo", { email: notifyTo })
    : t("locker.methods.recorded");
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
      /** The primary email: a quiet tag beside the address. */
      primary?: boolean;
      /** Wraps the row with an action beside Remove (Make primary, Rename). */
      tool?: (
        render: (slots: ToolSlots) => React.ReactElement,
      ) => React.ReactElement;
    },
  ): React.ReactElement => {
    const left = remainingAfter(view.methods, m.id);
    const row = (slots?: ToolSlots): React.ReactElement => (
      <MethodRow
        key={m.id}
        actions={slots?.action}
        extra={slots?.panel}
        id={m.id}
        {...common}
        icon={shape.icon}
        title={shape.title}
        name={shape.name}
        keepLabel={shape.keepLabel}
        guardName={shape.guardName}
        badge={
          shape.primary || m.reason === "last_link" ? (
            <>
              {shape.primary ? (
                <span className="rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-fg">
                  {t("locker.methods.primary")}
                </span>
              ) : null}
              {m.reason === "last_link" ? (
                <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent-fg">
                  {t("locker.methods.onlyMethod")}
                </span>
              ) : null}
            </>
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
            ? t("locker.methods.consequenceLeft", {
                detail: shape.consequence,
                rest: left,
              })
            : shape.consequence,
          recorded,
        ]}
        returnTo={returnTo({ remove: m.id })}
        initiallyOpen={removeId === m.id && m.canRemove}
        focusAfter={focusGroup(group)}
        doneText={shape.doneText}
      />
    );
    return shape.tool ? shape.tool(row) : row();
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
          title={t("locker.methods.hideTitle")}
          action={
            <Button
              variant="outline"
              className="font-medium max-sm:min-h-11"
              onClick={() => setAddEmailAsked((n) => n + 1)}
            >
              {t("locker.methods.hideAction")}
            </Button>
          }
        >
          {t("locker.methods.hideBody")}
        </Callout>
      ) : null}

      <div>
        <h3 id={ids.accounts} tabIndex={-1} className={GROUP_HEADING}>
          {t("locker.methods.accounts")}
        </h3>
        <ul className="divide-y divide-border border-b border-border -mx-4 desk:-mx-5 bigtext:max-sm:mx-0 [&>li]:px-4 desk:[&>li]:px-5 bigtext:max-sm:[&>li]:px-0">
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
                keepLabel: t("locker.methods.keepName", {
                  name: PROVIDER_NAME[kind],
                }),
                guardName: PROVIDER_NAME[kind],
                identity: methodIdentity(m),
                meta: methodMeta(m),
                verb: "Disconnect",
                consequence: t("locker.methods.disconnectNote", {
                  name: PROVIDER_NAME[kind],
                }),
                doneText: t("locker.methods.disconnected", {
                  name: PROVIDER_NAME[kind],
                }),
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
              keepLabel: t("locker.methods.keepName", { name: m.label }),
              guardName: m.label,
              identity: methodIdentity(m),
              meta: methodMeta(m),
              verb: "Disconnect",
              consequence: t("locker.methods.disconnectNote", {
                name: m.label,
              }),
              doneText: t("locker.methods.disconnected", { name: m.label }),
              notice: flagText(m),
            }),
          )}
        </ul>
      </div>

      <div>
        <h3 id={ids.email} tabIndex={-1} className={GROUP_HEADING}>
          {t("signin.email.label")}
          <span className="font-normal">
            {" "}
            · {t("locker.methods.signInWithCode")}
          </span>
        </h3>
        <ul className="divide-y divide-border border-b border-border -mx-4 desk:-mx-5 bigtext:max-sm:mx-0 [&>li]:px-4 desk:[&>li]:px-5 bigtext:max-sm:[&>li]:px-0">
          {view.emails.map((e) => {
            const m = view.methods.find((x) => x.id === e.methodId);
            if (!m) return null;
            return rowFor(m, "email", {
              icon: <Mail aria-hidden />,
              title: e.email,
              name: e.email,
              keepLabel: t("locker.methods.keepIt"),
              guardName: t("locker.methods.thisEmail"),
              tool: e.primary
                ? undefined
                : (render) => (
                    <MakePrimaryTool
                      key={m.id}
                      methodId={e.methodId}
                      email={e.email}
                      focusAfter={focusGroup("email")}
                      {...common}
                      returnTo={returnTo({})}
                    >
                      {render}
                    </MakePrimaryTool>
                  ),
              primary: e.primary,
              meta: [
                e.productCount
                  ? t("locker.methods.found", { count: e.productCount })
                  : null,
                t("locker.methods.addedOn", { date: formatDay(e.connectedAt) }),
                e.lastUsedAt
                  ? t("locker.methods.lastUsed", {
                      when: formatRelative(
                        e.lastUsedAt * 1000,
                        Date.now(),
                        PORTAL_FMT,
                      ),
                    })
                  : t("locker.methods.neverUsed"),
              ]
                .filter(Boolean)
                .join(" · ")
                .replace(/^./, (c) => c.toUpperCase()),
              verb: "Remove",
              consequence: e.primary
                ? t("locker.methods.removeNotePrimary", { email: e.email })
                : t("locker.methods.disconnectNote", { name: e.email }),
              doneText: t("locker.methods.removed", { name: e.email }),
            });
          })}
          <AddEmail
            {...common}
            returnTo={returnTo({ add: "email" })}
            asked={addEmailAsked}
            command={cmd.email}
            prompt={view.emails.length === 0}
            onAdded={focusGroup("email")}
          />
        </ul>
      </div>

      <div>
        <h3 id={ids.passkeys} tabIndex={-1} className={GROUP_HEADING}>
          {t("locker.methods.passkeys")}
        </h3>
        <ul className="divide-y divide-border border-b border-border -mx-4 desk:-mx-5 bigtext:max-sm:mx-0 [&>li]:px-4 desk:[&>li]:px-5 bigtext:max-sm:[&>li]:px-0">
          {view.methods
            .filter((m) => m.group === "passkeys")
            .map((m) => {
              const p = passkeyByMethod.get(m.id);
              const name = p
                ? passkeyName(p)
                : t("locker.methods.passkeyDefault");
              const which =
                name === t("locker.methods.passkeyDefault")
                  ? t("locker.methods.thisPasskey")
                  : t("locker.methods.namedPasskey", { name });
              return rowFor(m, "passkeys", {
                icon: <PasskeyGlyph passkey={p} />,
                title: name,
                name: which,
                keepLabel: t("locker.methods.keepIt"),
                guardName: t("locker.methods.thisPasskey"),
                tool: p
                  ? (render) => (
                      <RenamePasskeyTool
                        key={m.id}
                        passkeyId={p.id}
                        current={p.name ?? ""}
                        fallback={passkeyName({ ...p, name: null })}
                        what={which}
                        {...common}
                        returnTo={returnTo({})}
                      >
                        {render}
                      </RenamePasskeyTool>
                    )
                  : undefined,
                meta: p ? passkeyMeta(p) : methodMeta(m),
                verb: "Remove",
                consequence: t("locker.methods.passkeyRemoveNote", {
                  name: which,
                }),
                doneText: t("locker.methods.passkeyRemoved"),
              });
            })}
          <AddPasskey
            {...common}
            returnTo={returnTo({ add: "passkey" })}
            asked={passkeyAsked}
            start={cmd.passkey}
            prompt={!view.methods.some((m) => m.group === "passkeys")}
            onAdded={focusGroup("passkeys")}
          />
        </ul>
      </div>

      <p className="flex gap-2 text-sm text-fg-muted">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          {notifyTo
            ? t("locker.methods.footEmailed", { email: notifyTo })
            : t("locker.methods.foot")}
        </span>
      </p>
      {linkView.data ? (
        <div className="space-y-3">
          {linkView.data.undoable.map((u) => (
            <p
              key={u.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {t("signin.join.undoable", {
                  email: u.joined?.email ?? u.joined?.name ?? "",
                  date: formatDay(u.undoUntil),
                })}
              </span>
              <Button
                variant="link"
                size="sm"
                className="max-sm:min-h-11"
                onClick={() => navigate(`#/account?link=1&undo=${u.id}`)}
              >
                {t("signin.join.undo")}
              </Button>
            </p>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="max-sm:min-h-11"
            onClick={() => navigate("#/account/link")}
          >
            {t("signin.join.title")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** After the menu has closed and handed focus back to its trigger: what we focus then stays. */
function later(fn: () => void): void {
  setTimeout(() => requestAnimationFrame(fn), 30);
}

/** Why a passkey can't be added now, or null. */
function passkeyBlock(view: PortalMethods): string | null {
  if (!view.passkey.canAdd)
    return view.passkey.reason === "limit"
      ? t("locker.methods.blockLimit")
      : t("locker.methods.blockEmail");
  return passkeysSupported() ? null : t("locker.methods.blockBrowser");
}

function methodMeta(m: PortalMethod): string {
  return [
    t("locker.methods.connectedOn", { date: formatDay(m.connectedAt) }),
    m.lastUsedAt
      ? t("locker.methods.lastUsed", {
          when: formatRelative(m.lastUsedAt * 1000, Date.now(), PORTAL_FMT),
        })
      : null,
    m.tenantScoped ? t("locker.methods.gameOnly") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function passkeyMeta(p: PortalPasskey): string {
  const named = Boolean(p.name?.trim()) || passkeyProvider(p.aaguid) !== null;
  return [
    t("locker.methods.addedCap", { date: formatDay(p.createdAt) }),
    p.lastUsedAt
      ? t("locker.methods.lastUsed", {
          when: formatRelative(p.lastUsedAt * 1000, Date.now(), PORTAL_FMT),
        })
      : t("locker.methods.neverUsed"),
    // The browser it came from, unless it already names the passkey.
    named && p.addedFrom
      ? t("locker.methods.addedFrom", { place: p.addedFrom })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a provider reported about a method since it was linked (Apple's notifications, I-06). */
function flagText(m: PortalMethod): string | null {
  switch (m.flag) {
    case "consent_revoked":
      return t("locker.methods.flagRevoked", { name: m.label });
    case "account_deleted":
      return t("locker.methods.flagDeleted", { name: m.label });
    case "email_disabled":
      return t("locker.methods.flagRelay");
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
  if (err instanceof HttpError) {
    if (err.code === "link_conflict")
      return err.message && err.message !== `http ${err.status}`
        ? err.message
        : t("locker.methods.errLinkConflict");
    if (err.code === "auth_method_disabled" || err.status === 404)
      return name
        ? t("locker.methods.errUnavailable", { name })
        : t("locker.methods.errThisUnavailable");
    if (err.status === 503)
      return name
        ? t("locker.methods.errUnreachable", { name })
        : t("locker.methods.errThisUnreachable");
    if (err.status === 429) return t("locker.methods.errTooMany");
    if (err.reason === "email_unverified" || err.reason === "limit")
      return err.message;
  }
  return portalErrorCopy(err).line;
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
      const out = await mutate("startProviderMethod", kind);
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
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong [&_svg]:size-5">
          {kind === "apple" ? (
            <AppleGlyph />
          ) : kind === "google" ? (
            <GoogleGlyph />
          ) : (
            <SteamGlyph />
          )}
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="break-words font-medium text-fg-strong">{name}</p>
          <p className="text-sm text-fg-muted">
            {t("locker.methods.notConnectedRow")}
          </p>
        </div>
        {stepUp ? null : (
          <Button
            ref={buttonRef}
            variant="outline"
            className="ms-auto h-11 font-medium"
            loading={busy}
            aria-label={t("signin.provider.connect", { provider: name })}
            onClick={() => void connect()}
          >
            {t("locker.methods.connect")}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger sm:ps-12">
          {error}
        </p>
      ) : null}
      {stepUp ? (
        <div className="mt-3 space-y-3 rounded-lg border border-border bg-surface-sunken p-4 sm:ms-12">
          <StepUp
            verb={t("locker.verb.connect", { name })}
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
            {t("signin.cancel")}
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
  command,
  prompt,
  onAdded,
}: {
  view: PortalMethods;
  accountId: string;
  returnTo: string;
  /** Changes when something else on the page asks for this form (a link, a notice). */
  asked: number;
  /** Changes when the header's Add asks for it: the form opens and its field takes focus. */
  command: number;
  /** Show the inline button: only while the group is empty (PX-31a; the header's Add is the one entry point). */
  prompt: boolean;
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

  React.useEffect(() => {
    if (command === 0) return;
    askedRef.current = true;
    if (step.kind === "closed") setStep({ kind: "enter" });
    else focusField();
    // Only when commanded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  const close = (): void => {
    setStep({ kind: "closed" });
    setEmail("");
    setCode("");
    setError(null);
    setInvalid(false);
    requestAnimationFrame(() =>
      buttonRef.current ? buttonRef.current.focus() : onAdded(),
    );
  };

  const send = async (): Promise<void> => {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setInvalid(true);
      setError(t("signin.email.invalid"));
      document.getElementById(fieldId)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid(false);
    try {
      const out = await mutate("startEmailMethod", value);
      if (out.status === "connected") {
        toast.success(t("locker.methods.emailAlreadyOn", { email: out.email }));
        close();
        return;
      }
      setCode("");
      setStep({ kind: "code", email: out.email });
      requestAnimationFrame(() => document.getElementById(codeId)?.focus());
    } catch (err) {
      if (isStepUpRequired(err)) setStep({ kind: "stepUp" });
      else {
        if (err instanceof HttpError && err.status === 422) setInvalid(true);
        setError(
          err instanceof HttpError && err.status === 422
            ? t("signin.email.invalid")
            : err instanceof HttpError && err.code === "email_unavailable"
              ? t("locker.stepUp.noEmail")
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
      const out = await mutate("verifyEmailMethod", value);
      const text = t("locker.methods.emailAdded", { email: out.email });
      toast.success(text, {
        description: t("locker.methods.emailAddedNote"),
      });
      announce(text);
      setStep({ kind: "closed" });
      setEmail("");
      setCode("");
      onAdded();
    } catch (err) {
      setCode("");
      if (isStepUpRequired(err)) setStep({ kind: "stepUp" });
      else if (err instanceof HttpError && err.code === "invalid_code") {
        const left = err.triesLeft;
        setError(wrongCodeText(left));
      } else if (err instanceof HttpError && err.code === "signin_expired")
        setError(expiredCodeText());
      else setError(changeErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const open = step.kind !== "closed";
  return (
    <li className={open || prompt ? "py-3" : undefined}>
      {open || !prompt ? null : (
        <Button
          ref={buttonRef}
          variant="link"
          className="h-11 font-medium ms-12 bigtext:max-sm:ms-0"
          iconStart={<Plus aria-hidden />}
          aria-expanded={false}
          onClick={() => setStep({ kind: "enter" })}
        >
          {t("locker.methods.addEmail")}
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
        <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4 sm:ms-12">
          <h4 className="font-semibold text-fg-strong">
            {t("locker.methods.addEmail")}
          </h4>
          {step.kind === "stepUp" ? (
            <StepUp
              verb={t("locker.verb.addIt")}
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
                {tParts("locker.stepUp.sent", ["email"]).map((part, i) =>
                  typeof part === "string" ? (
                    part
                  ) : (
                    <span key={i} className="font-medium text-fg-strong">
                      {step.email}
                    </span>
                  ),
                )}
              </p>
              <label
                htmlFor={codeId}
                className="text-sm font-medium text-fg-strong"
              >
                {t("signin.approve.codeLabel")}
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
                  {t("signin.cancel")}
                </Button>
                <Button
                  type="submit"
                  loading={busy}
                  disabled={code.length !== CODE_LENGTH}
                >
                  {t("locker.methods.addEmailName", { email: step.email })}
                </Button>
                <Button
                  variant="link"
                  className="text-sm font-medium"
                  onClick={() => void send()}
                >
                  {t("signin.code.resend")}
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
                {t("locker.methods.emailAddress")}
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
                  {t("locker.methods.emailNote")}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={close}>
                  {t("signin.cancel")}
                </Button>
                <Button type="submit" loading={busy}>
                  {t("signin.gate.sendCode")}
                </Button>
              </div>
            </form>
          )}
          {step.kind === "stepUp" ? (
            <Button variant="outline" onClick={close}>
              {t("signin.cancel")}
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
  start,
  prompt,
  onAdded,
}: {
  view: PortalMethods;
  accountId: string;
  returnTo: string;
  /** Changes when a provider's step-up comes back to add a passkey (`?add=passkey`). */
  asked: number;
  /** Changes when the header's Add asks for a passkey: the ceremony starts at once. */
  start: number;
  /** Show the inline button: only while the group is empty, or when a press is due (`ready`). */
  prompt: boolean;
  onAdded: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const [stepUp, setStepUp] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const reasonId = React.useId();
  // Back from a provider's step-up: a browser makes a passkey only from a click, so the button
  // takes focus, ready to press.
  useAskedFocus(asked, buttonRef);
  React.useEffect(() => {
    if (asked > 0 && stepUpFresh(view.stepUp, Math.floor(Date.now() / 1000)))
      setReady(true);
    // Only when asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  const reason = passkeyBlock(view);

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await mutate("passkeyRegistrationOptions");
      const response = await createPasskey(options);
      await mutate("addPasskey", response);
      toast.success(t("locker.methods.passkeyAdded"), {
        description: t("locker.methods.passkeyAddedNote"),
      });
      announce(t("locker.methods.passkeyAdded"));
      setStepUp(false);
      setReady(false);
      onAdded();
    } catch (err) {
      if (isStepUpRequired(err)) setStepUp(true);
      else if (err instanceof PasskeyError)
        setError(
          err.reason === "exists"
            ? t("locker.methods.passkeyExists")
            : err.reason === "cancelled"
              ? t("locker.methods.passkeyCancelled")
              : t("locker.methods.passkeyFailed"),
        );
      else setError(changeErrorText(err, "Passkeys"));
    } finally {
      setBusy(false);
    }
  };

  // The header's Add: a click made the request, so the ceremony starts now.
  React.useEffect(() => {
    if (start > 0 && !reason) void add();
    // Only when asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  const inline = prompt || ready;
  const showing = inline || stepUp || busy || Boolean(error);
  if (!showing) return <></>;
  return (
    <li className="py-3">
      {stepUp || !inline ? null : (
        <Button
          ref={buttonRef}
          variant="link"
          className="h-11 font-medium ms-12 bigtext:max-sm:ms-0"
          iconStart={<KeyRound aria-hidden />}
          loading={busy}
          aria-disabled={reason ? true : undefined}
          aria-describedby={reason ? reasonId : undefined}
          onClick={() => {
            if (!reason) void add();
          }}
        >
          {t("signin.gate.passkeyAdd")}
        </Button>
      )}
      {reason && prompt ? (
        <p id={reasonId} className="text-sm text-fg-muted sm:ps-12">
          {reason}
        </p>
      ) : null}
      {ready && !stepUp && !error ? (
        <p role="status" className="text-sm text-fg sm:ps-12">
          {t("locker.methods.passkeyReady")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-sm text-danger sm:ps-12">
          {error}
        </p>
      ) : null}
      {stepUp ? (
        <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4 sm:ms-12">
          <StepUp
            verb={t("locker.verb.addPasskey")}
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
            {t("signin.cancel")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
