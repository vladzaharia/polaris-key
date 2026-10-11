import * as React from "react";
import { LogOut, Trash2 } from "lucide-react";
import {
  useMotionPreference,
  type MotionPreference,
} from "../../components/motionPreference.js";
import { useTheme, type ThemePreference } from "../../components/theme.js";
import { Button } from "../../ui/Button.js";
import { RadioCards } from "../../ui/RadioCards.js";
import { toast } from "../../ui/toast.js";
import { cn } from "../../lib/cn.js";
import type { PortalAccount } from "../api.js";
import { ProfileCard } from "../components/ProfileCard.js";
import { SignInMethods } from "../components/account/SignInMethods.js";
import { SessionsCard } from "../components/account/SessionsCard.js";
import { SectionCard } from "../components/product/Card.js";
import { DownloadData } from "../components/DownloadData.js";
import {
  useCancelAccountDeletion,
  useDeleteAccount,
  useExportAccountData,
  useSessions,
} from "../data.js";
import { ACCOUNT_EXPORT_FILE, YOUR_DATA_COPY } from "../copy/yourData.js";
import { portalErrorCopy } from "../errors.js";
import { focusSectionHeading } from "../focus.js";
import {
  href,
  scrollBehavior,
  useDocumentTitle,
  type AccountSection,
} from "../router.js";
import { t } from "../../lib/copy.js";

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
const SECTIONS: { id: AccountSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "methods", label: "Sign-in methods" },
  { id: "sessions", label: "Where you're signed in" },
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Your data" },
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
  useDocumentTitle("Account");
  const sessions = useSessions();
  const sessionsShown = !sessions.isPending && sessions.data !== null;
  const sections = SECTIONS.filter((s) => s.id !== "sessions" || sessionsShown);
  const [current, setCurrent] = React.useState<AccountSection>(
    SECTIONS.some((s) => s.id === section) ? section! : "profile",
  );
  // A section deep link scrolls there once, as the page opens; the router scrolls to a section
  // the URL names later (MO-05), so this does not undo its smooth scroll with an instant one.
  React.useEffect(() => {
    if (!section) return;
    document
      .getElementById(`section-${section}`)
      ?.scrollIntoView?.({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  const showName = account.name && account.name !== account.email;

  return (
    <div className="space-y-6 desk:space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          {/* Focus lands here after a navigation (the router, MO-05): no ring on a heading. */}
          <h1
            tabIndex={-1}
            className="text-3xl font-semibold leading-tight text-fg-strong outline-none desk:text-display"
          >
            Account
          </h1>
          <p className="text-fg-muted">
            {showName ? `${account.name} · ` : ""}
            <span className="text-fg-strong">{account.email}</span>
          </p>
        </div>
        <form method="post" action="/logout">
          <Button
            type="submit"
            variant="outline"
            iconStart={<LogOut aria-hidden />}
          >
            {t("common.signOut")}
          </Button>
        </form>
      </div>
      <nav
        aria-label="Account sections"
        // Sticky under the header below desk (at the top on a short screen, where the header
        // scrolls away): the page's scroll padding clears it (styles.css).
        data-section-pills=""
        className="sticky top-14 z-20 -mx-4 overflow-x-auto border-b border-border bg-surface-page px-4 py-2 short:top-0 desk:hidden"
      >
        <ul className="flex gap-2">
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
          aria-label="On this page"
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
          ? "inline-flex h-9 items-center whitespace-nowrap rounded-full border px-4 text-sm"
          : "block rounded-md px-3 py-2 text-sm",
        pill
          ? on
            ? "border-fg-strong bg-fg-strong font-medium text-surface-page"
            : "border-border-strong text-fg-strong"
          : on
            ? "bg-accent-subtle font-medium text-fg-strong"
            : "text-fg-muted hover:bg-hover hover:text-fg-strong",
      )}
    >
      {label}
    </a>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Match my device" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const MOTION_OPTIONS: {
  value: MotionPreference;
  label: string;
  description: string;
}[] = [
  {
    value: "system",
    label: "Match my device",
    description: "Animates unless your device asks for reduced motion.",
  },
  {
    value: "reduce",
    label: "Reduced",
    description: "Changes happen at once, with no animation.",
  },
];

/**
 * Appearance (§0.3): the theme (Match my device / Dark / Light, persisted and applied before
 * paint) and Motion (notes/S-23 §6.6, MO-12: Match my device / Reduced, stored in this browser).
 */
function Appearance(): React.ReactElement {
  const { preference, setPreference } = useTheme();
  const [motion, setMotion] = useMotionPreference();
  return (
    <SectionCard id="appearance" title="Appearance">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h3
            id="appearance-theme-label"
            className="text-sm font-medium text-fg-strong"
          >
            Theme
          </h3>
          <RadioCards
            aria-labelledby="appearance-theme-label"
            columns={3}
            value={preference}
            onChange={setPreference}
            options={THEME_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
              description: <ThemeSwatch preference={o.value} />,
            }))}
          />
        </div>
        <div className="flex flex-col gap-2">
          <h3
            id="appearance-motion-label"
            className="text-sm font-medium text-fg-strong"
          >
            Motion
          </h3>
          <RadioCards
            id="appearance-motion"
            aria-labelledby="appearance-motion-label"
            columns={2}
            value={motion}
            onChange={setMotion}
            options={MOTION_OPTIONS}
          />
        </div>
      </div>
    </SectionCard>
  );
}

function ThemeSwatch({
  preference,
}: {
  preference: ThemePreference;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      data-swatch={preference}
      // 112 px, shrinking only when its card is narrower (three cards share a tablet's column).
      className="mt-2 flex h-10 w-28 max-w-full overflow-hidden rounded-md border border-border"
    >
      {preference !== "light" ? <span className="flex-1 bg-[#060912]" /> : null}
      {preference !== "dark" ? <span className="flex-1 bg-[#f6f7fb]" /> : null}
    </span>
  );
}

/**
 * Your data: **Download my data** (the whole account as one JSON file; I-11), then Delete account.
 * A typed confirmation schedules an erasure after a 14-day grace period; the holder can keep using
 * the account, download their data and cancel until cron claims the due request. The download is
 * the account's own and never a product's: each product page has its own Your data card.
 */
function YourData({ account }: { account: PortalAccount }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const exportData = useExportAccountData();
  const del = useDeleteAccount();
  const cancel = useCancelAccountDeletion();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const inputId = React.useId();
  const target = account.email || account.name;
  const matches = typed.trim().toLowerCase() === target.toLowerCase();
  const scheduled = account.deletion
    ? {
        at: new Date(account.deletion.dueAt * 1000),
        label: new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(account.deletion.dueAt * 1000)),
      }
    : null;
  React.useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open]);

  return (
    <SectionCard
      id="data"
      title="Your data"
      subtitle={YOUR_DATA_COPY["yourData.subtitle"]}
    >
      <div className="space-y-6">
        <DownloadData
          title={YOUR_DATA_COPY["yourData.account.copy.title"]}
          description={YOUR_DATA_COPY["yourData.account.copy.body"]}
          label={YOUR_DATA_COPY["yourData.account.copy.button"]}
          filename={ACCOUNT_EXPORT_FILE}
          download={exportData}
        />
        <div className="space-y-3 border-t border-border pt-6">
          {scheduled ? (
            <div
              role="status"
              className="space-y-4 rounded-lg border border-danger-border bg-danger-subtle p-4"
            >
              <h3 className="font-medium text-fg-strong">
                Your account is scheduled for deletion
              </h3>
              <p className="text-sm text-fg">
                Your account will be erased on{" "}
                <time dateTime={scheduled.at.toISOString()}>
                  {scheduled.label}
                </time>
                . You can cancel the deletion before then.
              </p>
              <p className="text-sm text-fg">
                Until then, you can keep using your account. Your licenses stay
                with each developer and can be added to a new account later.
              </p>
              {cancel.error ? (
                <p role="alert" className="text-sm text-danger">
                  {portalErrorCopy(cancel.error).title}.{" "}
                  {portalErrorCopy(cancel.error).description}
                </p>
              ) : null}
              <Button
                variant="outline"
                loading={cancel.isPending}
                onClick={() =>
                  cancel.mutate(undefined, {
                    onSuccess: () => {
                      toast.success("Account deletion was cancelled", {
                        description: "Your account will remain active.",
                      });
                    },
                  })
                }
              >
                Cancel scheduled deletion
              </Button>
            </div>
          ) : open ? (
            <div className="space-y-4 rounded-lg border border-danger-border bg-danger-subtle p-4">
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="font-medium text-fg-strong outline-none"
              >
                Schedule your Polaris Key account for deletion?
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
                <li>
                  Your account will stay active for 14 days, then its data and
                  links to licenses will be erased.
                </li>
                <li>
                  You can cancel the deletion any time before the 14-day period
                  ends.
                </li>
                <li>
                  Licenses stay with each developer. Add them again with a new
                  account.
                </li>
                <li>We'll email {account.email} to confirm the schedule.</li>
              </ul>
              <div className="space-y-1.5">
                <label
                  htmlFor={inputId}
                  className="text-sm font-medium text-fg-strong"
                >
                  Type {target} to confirm
                </label>
                <input
                  id={inputId}
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                  className="h-11 w-full rounded-md border border-border-strong bg-surface-page px-3 text-fg-strong"
                />
              </div>
              {del.error ? (
                <p role="alert" className="text-sm text-danger">
                  {portalErrorCopy(del.error).title}.{" "}
                  {portalErrorCopy(del.error).description}
                </p>
              ) : null}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setOpen(false);
                    setTyped("");
                    requestAnimationFrame(() => triggerRef.current?.focus());
                  }}
                >
                  Keep my account
                </Button>
                <Button
                  variant="danger"
                  disabled={!matches}
                  loading={del.isPending}
                  iconStart={<Trash2 aria-hidden />}
                  onClick={() =>
                    del.mutate(undefined, {
                      onSuccess: () => {
                        setOpen(false);
                        setTyped("");
                        toast.success(
                          "Your account is scheduled for deletion",
                          {
                            description:
                              "We sent a confirmation to your email. You can cancel it for 14 days.",
                          },
                        );
                      },
                    })
                  }
                >
                  Schedule deletion
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-fg-muted">
                {YOUR_DATA_COPY["yourData.account.deleteNote"]}
              </p>
              <Button
                ref={triggerRef}
                variant="outline"
                className="border-danger-border text-danger"
                iconStart={<Trash2 aria-hidden />}
                onClick={() => setOpen(true)}
              >
                Delete account
              </Button>
            </>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
