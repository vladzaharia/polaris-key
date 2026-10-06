import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Mail, Trash2 } from "lucide-react";
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
import { Avatar } from "../components/Avatar.js";
import { SectionCard } from "../components/product/Card.js";
import { signOutQuietly, useDeleteAccount } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import {
  href,
  scrollBehavior,
  useDocumentTitle,
  type AccountSection,
} from "../router.js";

/**
 * Account v1 (PORTAL.md §4.26, PX-07) on today's API: the sign-in email (the Sign-in methods
 * section's scaffold until G27 lists Apple, Google, Steam and passkeys), Appearance, Your data
 * with Delete account behind a typed confirmation, and Sign out. Profile, Connected products and
 * Where you're signed in arrive with G32, I-06 and I-15; the section nav lists only what exists.
 */
const SECTIONS: { id: AccountSection; label: string }[] = [
  { id: "methods", label: "Sign-in methods" },
  { id: "appearance", label: "Appearance" },
  { id: "data", label: "Your data" },
];

export function AccountPage({
  account,
  section,
}: {
  account: PortalAccount;
  section: AccountSection | null;
}): React.ReactElement {
  useDocumentTitle("Account");
  const [current, setCurrent] = React.useState<AccountSection>(
    SECTIONS.some((s) => s.id === section) ? section! : "methods",
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
            className="text-[1.875rem] font-bold leading-tight text-fg-strong outline-none desk:text-[2.5rem]"
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
            Sign out
          </Button>
        </form>
      </div>
      <nav
        aria-label="Account sections"
        className="sticky top-14 z-20 -mx-4 overflow-x-auto border-b border-border bg-surface-page px-4 py-2 desk:hidden"
      >
        <ul className="flex gap-2">
          {SECTIONS.map((s) => (
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
          className="sticky top-24 hidden w-56 shrink-0 self-start desk:block"
        >
          <ul className="space-y-1">
            {SECTIONS.map((s) => (
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
          <SignInMethods account={account} />
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
            ? "border-fg-strong bg-fg-strong font-bold text-surface-page"
            : "border-border-strong text-fg-strong"
          : on
            ? "bg-accent-subtle font-bold text-fg-strong"
            : "text-fg-muted hover:bg-hover hover:text-fg-strong",
      )}
    >
      {label}
    </a>
  );
}

/** Sign-in methods, v1: the one email this account signs in with (G10/G27 fallback). */
function SignInMethods({
  account,
}: {
  account: PortalAccount;
}): React.ReactElement {
  return (
    <SectionCard
      id="methods"
      title="Sign-in methods"
      subtitle="How you get into this account. Sign-in links, receipts and security notices go to this email."
    >
      <h3 className="mb-2 text-xs font-bold text-fg-muted">Email</h3>
      <ul className="divide-y divide-border border-y border-border">
        <li className="flex items-center gap-3 py-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong">
            <Mail aria-hidden className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold text-fg-strong">{account.email}</p>
            <p className="text-sm text-fg-muted">
              Products bought with this email join your library by themselves.
            </p>
          </div>
        </li>
      </ul>
    </SectionCard>
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
            className="text-sm font-bold text-fg-strong"
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
            className="text-sm font-bold text-fg-strong"
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
      className="mt-2 flex h-10 w-28 overflow-hidden rounded-md border border-border"
    >
      {preference !== "light" ? <span className="flex-1 bg-[#060912]" /> : null}
      {preference !== "dark" ? <span className="flex-1 bg-[#f6f7fb]" /> : null}
    </span>
  );
}

/**
 * Your data: Delete account behind a typed confirmation (the email). Download my data waits for
 * I-15's export.
 */
function YourData({ account }: { account: PortalAccount }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const del = useDeleteAccount();
  const qc = useQueryClient();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const inputId = React.useId();
  const target = account.email || account.name;
  const matches = typed.trim().toLowerCase() === target.toLowerCase();
  React.useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open]);

  return (
    <SectionCard
      id="data"
      title="Your data"
      subtitle="Deleting your account doesn't cancel your licenses: they stay with each developer and you can add them again."
    >
      {open ? (
        <div className="space-y-4 rounded-lg border border-danger-border bg-danger-subtle p-4">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="font-bold text-fg-strong outline-none"
          >
            Delete your Polaris Key account?
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
            <li>
              Your account, its email addresses and its links to licenses are
              erased.
            </li>
            <li>
              Licenses stay with each developer. Add them again with a new
              account.
            </li>
            <li>
              We'll email {account.email} to confirm. This can't be undone.
            </li>
          </ul>
          <div className="space-y-1.5">
            <label
              htmlFor={inputId}
              className="text-sm font-bold text-fg-strong"
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
                    toast.success("Your account was deleted", {
                      description: "We sent a confirmation to your email.",
                    });
                    window.history.replaceState(null, "", "/#/");
                    signOutQuietly(qc);
                  },
                })
              }
            >
              Delete my account
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={triggerRef}
          variant="outline"
          className="border-danger-border text-danger"
          iconStart={<Trash2 aria-hidden />}
          onClick={() => setOpen(true)}
        >
          Delete account
        </Button>
      )}
    </SectionCard>
  );
}
