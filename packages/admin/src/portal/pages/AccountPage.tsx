import * as React from "react";
import { LogOut, Trash2 } from "lucide-react";
import {
  useMotionPreference,
  type MotionPreference,
} from "../../components/motionPreference.js";
import { useTheme, type ThemePreference } from "../../components/theme.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { toast } from "../../ui/toast.js";
import { cn } from "../../lib/cn.js";
import type { PortalAccount } from "../api.js";
import { ProfileCard } from "../components/ProfileCard.js";
import { SignInMethods } from "../components/account/SignInMethods.js";
import {
  PackagesCard,
  packagesVisible,
} from "../components/account/PackagesCard.js";
import { SessionsCard } from "../components/account/SessionsCard.js";
import { AccountCard as SectionCard } from "../components/account/AccountCard.js";
import { SegmentedRow } from "../components/account/SegmentedRow.js";
import { DownloadData } from "../components/DownloadData.js";
import { DataRow } from "../components/DataRow.js";
import { StepUpInline } from "../components/account/StepUpInline.js";
import {
  useCancelAccountDeletion,
  useDeleteAccount,
  useExportAccountData,
  usePersonalTokens,
  useSessions,
} from "../data.js";
import { YOUR_DATA_COPY } from "../copy/yourData.js";
import { isStepUpRequired, portalErrorCopy } from "../errors.js";
import { focusSectionHeading } from "../focus.js";
import {
  href,
  scrollBehavior,
  useDocumentTitle,
  type AccountSection,
} from "../router.js";
import { t, tParts } from "../../lib/copy.js";
import { formatDayTime } from "../date.js";

/**
 * Account (PORTAL.md §4.26): Profile first (PX-22, §4.30: name and picture, edited in place),
 * Sign-in methods (PX-13 on PX-W12: connect, disconnect with step-up, the last-method guard, the
 * Hide My Email notice), Where you're signed in (PX-13 on I-07's sessions), Appearance, Your data
 * with Download my data (I-11's full export) and Delete account behind a typed confirmation, and
 * Sign out (PX-07).
 *
 * The section nav lists only what is on the page: Where you're signed in once the Worker answers
 * for sessions. Connected products wait for their API (PX-13's brief); until then neither the nav
 * nor the page points at them. Download my data sits inside Your data, not in a section of its own.
 */
/**
 * Extension points (PX-15 and PX-31b add files under `components/account/` and one line here):
 * a section is a row of SECTIONS plus a card in the column below, in the canonical order (Profile,
 * Sign-in methods, Connected apps, Packages, Where you're signed in, Appearance, Your data); the
 * after-sign-in nudge and the link-accounts offer render above the column's first card; the
 * Approve-a-device dialog opens from SessionsCard and the `approve` route. Connected apps
 * (PX-31b) goes between Sign-in methods and Packages.
 */
const SECTIONS: { id: AccountSection; label: string }[] = [
  { id: "profile", label: t("profile.title") },
  { id: "methods", label: t("signin.join.methodsLink") },
  { id: "packages", label: t("locker.account.packages") },
  { id: "sessions", label: t("locker.account.sessions") },
  { id: "appearance", label: t("locker.appearance.title") },
  { id: "data", label: t("locker.account.yourData") },
];

export function AccountPage({
  account,
  section,
  params,
}: {
  account: PortalAccount;
  section: AccountSection | null;
  params: URLSearchParams;
}): React.ReactElement {
  useDocumentTitle(t("locker.account.title"));
  const sessions = useSessions();
  const sessionsShown = !sessions.isPending && sessions.data !== null;
  const packages = usePersonalTokens();
  const packagesShown = packagesVisible(packages.data);
  const sections = SECTIONS.filter(
    (s) =>
      (s.id !== "sessions" || sessionsShown) &&
      (s.id !== "packages" || packagesShown),
  );
  const [current, setCurrent] = React.useState<AccountSection>(
    SECTIONS.some((s) => s.id === section) ? section! : "profile",
  );
  // A section deep link scrolls there once, as the page opens; the router scrolls to a section
  // the URL names later (MO-05), so this does not undo its smooth scroll with an instant one.
  // The sections above Packages load after the first paint and push it down, so a link to it
  // waits until they have settled, scrolls there and moves focus to its heading, once (the
  // product page's pointer row links here).
  const landed = React.useRef(false);
  const settled =
    section === "packages" ? !packages.isPending && !sessions.isPending : true;
  React.useEffect(() => {
    if (!section || landed.current || !settled) return;
    landed.current = true;
    const go = (refocus: boolean): void => {
      document
        .getElementById(`section-${section}`)
        ?.scrollIntoView?.({ block: "start" });
      // Never take focus from a control the person has reached since: only from the page's own
      // headings or the body.
      const at = document.activeElement;
      const idle =
        !at ||
        at === document.body ||
        (at instanceof HTMLElement && /^H[123]$/.test(at.tagName));
      if (section === "packages" && refocus && idle)
        focusSectionHeading("packages");
    };
    go(true);
    // The sign-in methods card above fills in a frame later: land again once it has.
    if (section === "packages") setTimeout(() => go(true), 400);
  }, [section, settled]);
  const pick = (s: AccountSection): void => {
    setCurrent(s);
    document.getElementById(`section-${s}`)?.scrollIntoView?.({
      // Smooth scrolling becomes instant under reduced motion (notes/S-23 §6.6).
      behavior: scrollBehavior(),
      block: "start",
    });
    // Focus follows the jump, without scrolling (PS-05 review M4).
    focusSectionHeading(s);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${href.account(s)}`,
    );
  };

  return (
    <div className="space-y-6 desk:space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {/* Focus lands here after a navigation (the router, MO-05): no ring on a heading. */}
          <h1
            tabIndex={-1}
            className="text-3xl font-semibold leading-tight text-fg-strong outline-none desk:text-display"
          >
            {t("locker.account.title")}
          </h1>
        </div>
        <form method="post" action="/logout">
          <Button
            type="submit"
            variant="outline"
            className="max-sm:min-h-11"
            iconStart={<LogOut aria-hidden />}
          >
            {t("common.signOut")}
          </Button>
        </form>
      </div>
      <nav
        aria-label={t("locker.account.sections")}
        // Sticky under the header below desk (at the top on a short screen, where the header
        // scrolls away): the page's scroll padding clears it (styles.css).
        data-section-pills=""
        className="sticky top-14 z-20 -mx-4 min-w-0 max-w-[100vw] overflow-x-auto border-b border-border bg-surface-page px-4 py-2 short:top-0 bigtext:max-desk:static desk:hidden"
      >
        <ul className="flex w-max gap-2">
          {sections.map((s) => (
            <li key={s.id}>
              <SectionLink
                id={s.id}
                label={s.label}
                on={current === s.id}
                onPick={pick}
                pill
              />
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex gap-8">
        <nav
          aria-label={t("locker.account.onThisPage")}
          className="sticky top-24 hidden w-56 shrink-0 self-start desk:block short:top-6"
        >
          <ul className="space-y-1">
            {sections.map((s) => (
              <li key={s.id}>
                <SectionLink
                  id={s.id}
                  label={s.label}
                  on={current === s.id}
                  onPick={pick}
                />
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 space-y-6">
          <ProfileCard account={account} />
          <SignInMethods account={account} params={params} />
          <PackagesCard />
          <SessionsCard />
          <Appearance />
          <YourData account={account} />
        </div>
      </div>
    </div>
  );
}

function SectionLink({
  id,
  label,
  on,
  onPick,
  pill,
}: {
  id: AccountSection;
  label: string;
  on: boolean;
  onPick: (s: AccountSection) => void;
  pill?: boolean;
}): React.ReactElement {
  return (
    <a
      href={href.account(id)}
      aria-current={on ? "location" : undefined}
      onClick={(e) => {
        e.preventDefault();
        onPick(id);
      }}
      className={cn(
        pill
          ? "inline-flex h-9 items-center whitespace-nowrap rounded-full border px-4 text-sm max-sm:h-11"
          : "relative flex items-center rounded-md px-3 py-2 text-sm pointer-coarse:min-h-11",
        pill
          ? on
            ? "border-fg-strong bg-hover font-semibold text-fg-strong"
            : "border-border-strong text-fg-strong"
          : on
            ? "bg-hover font-medium text-fg-strong before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-accent before:content-[''] forced-colors:before:bg-[Highlight]"
            : "text-fg-muted hover:bg-hover hover:text-fg-strong",
      )}
    >
      {label}
    </a>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: t("locker.appearance.matchDevice") },
  { value: "dark", label: t("locker.appearance.dark") },
  { value: "light", label: t("locker.appearance.light") },
];

const MOTION_OPTIONS: {
  value: MotionPreference;
  label: string;
  description: string;
}[] = [
  {
    value: "system",
    label: t("locker.appearance.matchDevice"),
    description: t("locker.appearance.matchNote"),
  },
  {
    value: "reduce",
    label: t("locker.appearance.reduced"),
    description: t("locker.appearance.reducedNote"),
  },
];

/**
 * Appearance (§0.3): the theme (Match device / Dark / Light, persisted and applied before
 * paint) and Motion (notes/S-23 §6.6, MO-12: Match device / Reduced, stored in this browser).
 */
function Appearance(): React.ReactElement {
  const { preference, setPreference } = useTheme();
  const [motion, setMotion] = useMotionPreference();
  return (
    <SectionCard id="appearance" title={t("locker.appearance.title")}>
      <div className="flex flex-col gap-4">
        <SegmentedRow
          label={t("locker.appearance.theme")}
          value={preference}
          onChange={setPreference}
          options={THEME_OPTIONS}
        />
        <SegmentedRow
          label={t("locker.appearance.motion")}
          note={MOTION_OPTIONS.find((o) => o.value === motion)?.description}
          value={motion}
          onChange={setMotion}
          options={MOTION_OPTIONS}
        />
      </div>
    </SectionCard>
  );
}

/**
 * Your data: **Download my data** (the whole account as one JSON file; I-11), then Delete account.
 * A typed confirmation schedules an erasure after a 14-day grace period; the holder can keep using
 * the account, download their data and cancel until cron claims the due request. The download is
 * the account's own and never a product's: each product page has its own Your data card.
 *
 * A stale sign-in (the Worker's `step_up_required`) shows "Confirm it's you first" where the
 * refusal would be, and confirming runs the request again; the typed email stays. Focus follows the
 * result: a schedule moves it to the scheduled box's heading, a cancel back to Delete account.
 */
function YourData({ account }: { account: PortalAccount }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [askSchedule, setAskSchedule] = React.useState(false);
  const [askCancel, setAskCancel] = React.useState(false);
  // What the retry after a step-up prompt met: shown in the dialog like any other refusal.
  const [retryError, setRetryError] = React.useState<unknown>(null);
  const exportData = useExportAccountData();
  const del = useDeleteAccount();
  const cancel = useCancelAccountDeletion();
  const scheduledRef = React.useRef<HTMLHeadingElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const target = account.email || account.name;
  const scheduled = account.deletion
    ? {
        at: new Date(account.deletion.dueAt * 1000),
        label: formatDayTime(account.deletion.dueAt),
      }
    : null;

  /** Schedules the erasure; throws what the Worker refused (a stale sign-in included). */
  const schedule = async (): Promise<void> => {
    await del.mutateAsync();
    setOpen(false);
    setAskSchedule(false);
    // The box mounts once the account is read again: focus its heading then.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => scheduledRef.current?.focus()),
    );
  };
  const cancelDeletion = (): void =>
    cancel.mutate(undefined, {
      onSuccess: () => {
        setAskCancel(false);
        toast.success(t("locker.delete.canceled"), { id: "account-deletion" });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => triggerRef.current?.focus()),
        );
      },
      onError: (err) => {
        if (isStepUpRequired(err)) setAskCancel(true);
      },
    });
  const cancelFailure =
    cancel.error && !isStepUpRequired(cancel.error)
      ? portalErrorCopy(cancel.error, { account: true })
      : null;

  return (
    <SectionCard id="data" title={t("locker.account.yourData")}>
      <div className="space-y-5">
        <DownloadData
          title={YOUR_DATA_COPY["yourData.account.copy.title"]}
          description={YOUR_DATA_COPY["yourData.account.copy.body"]}
          label={YOUR_DATA_COPY["yourData.account.copy.button"]}
          download={exportData}
          account
        />
        <div className="border-t border-border pt-5">
          {scheduled ? (
            <div
              role="status"
              className="space-y-4 rounded-lg border border-danger-border bg-danger-subtle p-4"
            >
              <h3
                ref={scheduledRef}
                tabIndex={-1}
                className="font-medium text-fg-strong outline-none"
              >
                {tParts("locker.delete.scheduledTitle", ["date"]).map(
                  (part, i) =>
                    typeof part === "string" ? (
                      part
                    ) : (
                      <time key={i} dateTime={scheduled.at.toISOString()}>
                        {scheduled.label}
                      </time>
                    ),
                )}
              </h3>
              <p className="text-sm text-fg">
                {t("locker.delete.scheduledNote")}
              </p>
              {askCancel ? (
                <StepUpInline
                  verb={t("locker.delete.verbCancel")}
                  onConfirmed={() => {
                    setAskCancel(false);
                    cancelDeletion();
                  }}
                  onCancel={() => setAskCancel(false)}
                />
              ) : null}
              {cancelFailure ? (
                <p role="alert" className="text-sm text-danger">
                  {cancelFailure.line}
                </p>
              ) : null}
              <Button
                variant="outline"
                className="max-sm:min-h-11"
                loading={cancel.isPending}
                onClick={cancelDeletion}
              >
                {t("locker.delete.cancel")}
              </Button>
            </div>
          ) : (
            <DataRow
              danger
              icon={<Trash2 aria-hidden />}
              title={t("locker.delete.rowTitle")}
              description={t("locker.delete.rowNote")}
            >
              <Button
                ref={triggerRef}
                variant="outline"
                className="h-auto min-h-9 w-full whitespace-normal border-danger-border py-1.5 text-danger max-sm:min-h-11 sm:w-auto"
                aria-label={t("locker.delete.rowTitle")}
                onClick={() => setOpen(true)}
              >
                {t("locker.delete.open")}
              </Button>
            </DataRow>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setAskSchedule(false);
            setRetryError(null);
            del.reset();
            requestAnimationFrame(() => triggerRef.current?.focus());
          }
        }}
        intent="danger"
        title={t("locker.delete.askTitle")}
        consequences={[
          t("locker.delete.askErased"),
          t("locker.delete.askLicenses"),
          t("locker.delete.askEmail", { email: account.email }),
        ]}
        typedConfirmation={{
          value: target,
          label: t("locker.delete.type"),
          ignoreCase: true,
        }}
        confirmLabel={t("locker.delete.confirm")}
        cancelLabel={t("common.cancel")}
        closeOnSuccess={false}
        error={retryError}
        describeError={(err) => portalErrorCopy(err, { account: true })}
        onConfirm={async () => {
          setRetryError(null);
          try {
            await schedule();
          } catch (err) {
            // A stale sign-in: the prompt shows below, and confirming runs it again.
            if (isStepUpRequired(err)) {
              setAskSchedule(true);
              return;
            }
            throw err;
          }
        }}
      >
        {askSchedule ? (
          <StepUpInline
            verb={t("locker.delete.verbSchedule")}
            onConfirmed={() => {
              setAskSchedule(false);
              schedule().catch((err: unknown) => {
                if (isStepUpRequired(err)) setAskSchedule(true);
                else setRetryError(err);
              });
            }}
            onCancel={() => setAskSchedule(false)}
          />
        ) : null}
      </ConfirmDialog>
    </SectionCard>
  );
}
