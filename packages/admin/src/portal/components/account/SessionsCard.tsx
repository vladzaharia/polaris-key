import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Monitor, ScanLine, Smartphone } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { Expand } from "../../../ui/motion/index.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import type { PortalSession } from "../../api.js";
import {
  signOutQuietly,
  useEndSession,
  useSessions,
  useSignOutEverywhere,
} from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import { sessionMethodText } from "../../model/methods.js";
import { href, scrollBehavior } from "../../router.js";
import { ErrorPanel } from "../States.js";
import { AccountCard as SectionCard } from "./AccountCard.js";
import { t } from "../../../lib/copy.js";

/**
 * Where you're signed in (PORTAL.md §4.26; I-07's account sessions): the browsers signed in to
 * this account, never product devices (those are on each product's page). This browser is marked
 * and signs out with the page's own **Sign out**; every other one has **Sign out**.
 *
 * **Sign out everywhere** is I-07's: it ends every session of the account, this browser's
 * included, and signs the account out of its apps too (Core's clearing hook), so it says exactly
 * that and confirms in place before it runs. After it, this page is signed out.
 *
 * Focus never falls to `body`: signing one browser out moves it to the section's heading as the
 * row leaves; the confirm's heading takes it as it opens, and **Cancel** hands it back.
 */
export function SessionsCard(): React.ReactElement | null {
  const sessions = useSessions();
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  if (sessions.data === null) return null;
  const listed =
    Boolean(sessions.data) && !sessions.isPending && !sessions.error;
  return (
    <SectionCard
      id="sessions"
      title={t("locker.account.sessions")}
      aside={
        listed && !open ? (
          <Button
            ref={buttonRef}
            variant="outline"
            className="max-sm:min-h-11"
            iconStart={<LogOut aria-hidden />}
            aria-expanded={false}
            aria-controls="sign-out-everywhere"
            onClick={() => setOpen(true)}
          >
            {t("locker.sessions.signOutAll")}
          </Button>
        ) : null
      }
      subtitle={t("locker.sessions.subtitle")}
    >
      {sessions.isPending ? (
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : sessions.error || !sessions.data ? (
        <ErrorPanel
          account
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
          className="border-0 p-0 shadow-none"
        />
      ) : (
        <SessionList
          sessions={sessions.data}
          open={open}
          onClose={() => {
            setOpen(false);
            requestAnimationFrame(() => buttonRef.current?.focus());
          }}
        />
      )}
    </SectionCard>
  );
}

function focusHeading(): void {
  const h = document.getElementById("section-sessions-h");
  if (!h) return;
  if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
  h.focus({ preventScroll: true });
}

function SessionList({
  sessions,
  open,
  onClose,
}: {
  sessions: PortalSession[];
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  // This browser first, then the others newest first (the Worker's order).
  const ordered = [
    ...sessions.filter((s) => s.current),
    ...sessions.filter((s) => !s.current),
  ];
  const others = ordered.filter((s) => !s.current).length;
  return (
    <>
      <ul className="divide-y divide-border border-y border-border">
        {ordered.map((s) => (
          <SessionRow key={s.id} session={s} />
        ))}
      </ul>
      <Everywhere others={others} open={open} onClose={onClose} />
      <div className="mt-1">
        <Button
          variant="link"
          className="h-11 font-medium"
          iconStart={<ScanLine aria-hidden />}
          onClick={() => {
            window.location.hash = href.account("sessions", { approve: "" });
          }}
        >
          {t("signin.approve.open")}
        </Button>
      </div>
    </>
  );
}

function SessionRow({
  session,
}: {
  session: PortalSession;
}): React.ReactElement {
  const end = useEndSession();
  const name = session.browser?.trim() || t("locker.sessions.unknownBrowser");
  const phone = /iOS|Android/.test(name);
  const how = sessionMethodText(session.methods);
  const meta = [
    how,
    session.current
      ? t("locker.sessions.now")
      : t("locker.sessions.lastActive", {
          when: formatRelative(session.lastSeenAt * 1000),
        }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong">
          {phone ? (
            <Smartphone aria-hidden className="size-5" />
          ) : (
            <Monitor aria-hidden className="size-5" />
          )}
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="flex flex-wrap items-center gap-x-2 font-medium text-fg-strong">
            <span className="min-w-0 break-words">{name}</span>
            {session.current ? (
              <span className="rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-fg-strong">
                {t("signin.replace.thisBrowser")}
              </span>
            ) : null}
          </p>
          <p className="text-sm text-fg-muted">{meta}</p>
        </div>
        {session.current ? null : (
          <Button
            variant="ghost"
            className="ml-auto h-10 font-medium max-sm:h-11"
            loading={end.isPending}
            busyFocusable
            aria-label={t("locker.sessions.signOutOne", { name, when: meta })}
            onClick={() =>
              end.mutate(session.id, {
                onSuccess: () => {
                  const text = t("locker.sessions.signedOutOne", { name });
                  toast.success(text);
                  announce(text);
                  // The row leaves with the refetch: focus goes to the section first.
                  focusHeading();
                },
              })
            }
          >
            {t("common.signOut")}
          </Button>
        )}
      </div>
      {end.error ? (
        <p role="alert" className="mt-2 text-sm text-danger sm:pl-13">
          {portalErrorCopy(end.error).line}
        </p>
      ) : null}
    </li>
  );
}

/** Sign out everywhere: every browser, this one included, and every app, after a confirm. */
function Everywhere({
  others,
  open,
  onClose,
}: {
  others: number;
  open: boolean;
  onClose: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const all = useSignOutEverywhere();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  return (
    <div className="mt-3">
      <Expand
        id="sign-out-everywhere"
        open={open}
        onOpen={() => headingRef.current?.focus({ preventScroll: true })}
        onOpened={(region) =>
          region.scrollIntoView?.({
            block: "nearest",
            behavior: scrollBehavior(),
          })
        }
      >
        <div className="space-y-3 rounded-lg border border-danger-border bg-danger-subtle p-4">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="font-medium text-fg-strong outline-none"
          >
            {t("locker.sessions.askTitle")}
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
            <li>
              {others > 0
                ? t("locker.sessions.askOthers", { count: others })
                : t("locker.sessions.askThis")}
            </li>
            <li>{t("locker.sessions.askApps")}</li>
            <li>{t("locker.sessions.askStay")}</li>
          </ul>
          {all.error ? (
            <p role="alert" className="text-sm text-danger">
              {portalErrorCopy(all.error).line}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              className="max-sm:min-h-11"
              onClick={() => {
                all.reset();
                onClose();
              }}
            >
              {t("signin.cancel")}
            </Button>
            <Button
              variant="danger"
              className="max-sm:min-h-11"
              loading={all.isPending}
              busyFocusable
              iconStart={<LogOut aria-hidden />}
              onClick={() =>
                all.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t("locker.sessions.done"), {
                      description: t("locker.error.signInAgain"),
                    });
                    window.history.replaceState(null, "", "/#/");
                    signOutQuietly(qc);
                  },
                })
              }
            >
              {t("locker.sessions.signOutAll")}
            </Button>
          </div>
        </div>
      </Expand>
    </div>
  );
}
