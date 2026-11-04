import * as React from "react";
import {
  CircleCheck,
  Clock,
  KeyRound,
  MonitorSmartphone,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { leadParts, recommendReasons } from "@polaris-key/ui-core";
import type { KeyPreview } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import {
  AUTH_METHOD_CLASS,
  AuthTitle,
  QuietLink,
  QuietLinks,
} from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { termText } from "../../model/signInRequest.js";
import type { SkipRefusal } from "../../model/key.js";
import {
  InkMeter,
  NeutralCallout,
  Pill,
  PRIMARY_CLASS,
} from "./requestParts.js";

type ReasonKey =
  | "activate.recommend.sync"
  | "activate.recommend.recover"
  | "activate.recommend.devices"
  | "activate.recommend.portal";

/** One icon per reason, by copy key: a new reason must pick one. */
const REASON_ICONS: Record<ReasonKey, LucideIcon> = {
  "activate.recommend.sync": RefreshCw,
  "activate.recommend.recover": KeyRound,
  "activate.recommend.devices": MonitorSmartphone,
  "activate.recommend.portal": CircleCheck,
};

/**
 * AccountUpgrade (SIGN-IN.md §3.9, PX-12; WIRE-CONTRACT-V4 §12.2 rule 8): what a key leads to,
 * from `POST /api/key/preview`, before anyone signs in. The key card ("Key works"), then "Keep
 * <Product> in an account" with the entries meter in ink (never amber: auth-10) and **Create
 * account** and the quiet **Sign in instead**; both carry the key to the sign-in card. Forced
 * when a new device would be refused `key_entry_limit`: then a neutral callout. Under the lede
 * the reasons to add the licence to an account (frame 48, LK-SKIP.1): ui-core's `recommendReasons`,
 * plain text; Cloud Sync only when the requesting app has it. **Continue without an account**
 * (S-24 D13, LK-SKIP.5) is drawn only when the parent passes `skip` (the request opted in with
 * `keyReturn` and the key is the request's product's) and the upgrade is skippable: it returns to
 * the app on the key's licence. A refusal that stays on the card is said under it; the others
 * (`license_owned`, `key_entry_limit`, a gone request) are the parent's steps.
 */
export function AccountUpgrade({
  preview,
  cloudSync = false,
  onCreate,
  onSignIn,
  skip,
  fromSkip = false,
  onDifferentKey,
}: {
  preview: KeyPreview;
  /** The requesting app's Cloud Sync (`client.services.cloudSync`); a signed-out standalone has none. */
  cloudSync?: boolean;
  /** Create account: on to the sign-in card with the key carried. */
  onCreate: () => void;
  /** Sign in instead: the same card, the key carried too (LK-polish M5). */
  onSignIn: () => void;
  /**
   * The key return. Resolves `null` when it left the card (the redirect, or a step of the parent's)
   * and the refusal that stays here otherwise.
   */
  skip?: () => Promise<Extract<SkipRefusal, { kind: "message" }> | null>;
  /** The forced body was reached from **Continue without an account**: the callout says so first. */
  fromSkip?: boolean;
  /** Back to the key field, after a refusal that is the key's own. */
  onDifferentKey?: () => void;
}): React.ReactElement {
  const name = preview.product.name;
  const forced = preview.upgrade === "forced";
  const entries = preview.keyEntries;
  const left = entries ? Math.max(0, entries.limit - entries.used) : null;
  const [busy, setBusy] = React.useState(false);
  const [refusal, setRefusal] = React.useState<Extract<
    SkipRefusal,
    { kind: "message" }
  > | null>(null);
  /** A 429 holds the control for its `retryAfter`, then lets it go. */
  const [hold, setHold] = React.useState<{ seconds: number } | null>(null);
  const messageId = React.useId();
  React.useEffect(() => {
    if (!hold) return;
    // The hold ends and the refusal with it: there is nothing left to wait for.
    const id = window.setTimeout(() => {
      setHold(null);
      setRefusal(null);
    }, hold.seconds * 1000);
    return () => window.clearTimeout(id);
  }, [hold]);
  const press = async (): Promise<void> => {
    if (!skip || busy || hold) return;
    setBusy(true);
    setRefusal(null);
    const out = await skip();
    // Left the card: stay busy until the page goes. A step of the parent's unmounts this.
    if (out === null) return;
    setBusy(false);
    setRefusal(out);
    setHold(out.wait ? { seconds: out.wait } : null);
  };
  return (
    <>
      {forced ? null : (
        <div
          data-key-card
          className="flex items-start gap-3 rounded-lg border border-border px-4 py-3"
        >
          <CircleCheck
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-fg-muted"
          />
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-fg-strong">
              {t("signin.key.keyWorks")}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-sm/5 text-fg-muted">
              <span className="[overflow-wrap:anywhere]">{name}</span>
              {preview.license?.tierName ? (
                <Pill>{preview.license.tierName}</Pill>
              ) : null}
              {preview.license ? (
                <span>
                  {termText(
                    preview.license.term === "perpetual"
                      ? null
                      : preview.license.term,
                  )}
                </span>
              ) : null}
            </p>
          </div>
        </div>
      )}
      <AuthTitle>
        {forced
          ? t("signin.key.noEntriesTitle", { product: name })
          : t("signin.key.upgradeTitle", { product: name })}
      </AuthTitle>
      {forced ? (
        <NeutralCallout icon={<Clock />}>
          <p>
            {fromSkip ? (
              <strong className="font-medium text-fg-strong">
                {t("locker.key.noEntriesLead")}
              </strong>
            ) : null}
            {fromSkip ? " " : null}
            {t("signin.key.noEntries", { product: name })}
          </p>
        </NeutralCallout>
      ) : null}
      <ul className="space-y-2 text-sm/5 text-fg-muted" data-reasons>
        {recommendReasons({ identity: true, sync: cloudSync }).map((key) => {
          const Icon = REASON_ICONS[key as ReasonKey];
          return (
            <li key={key} className="flex items-start gap-2">
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="text-pretty">
                {leadParts(
                  t(key as Parameters<typeof t>[0], {
                    developer: preview.product.developerName ?? name,
                  }),
                ).map((p, i) =>
                  p.strong ? <strong key={i}>{p.text}</strong> : p.text,
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {entries && left !== null ? (
        <div className="space-y-2">
          <InkMeter
            used={entries.used}
            limit={entries.limit}
            next={!forced}
            label={t("signin.key.meter", {
              used: entries.used,
              limit: entries.limit,
            })}
          />
          {forced ? null : (
            <p className="text-sm/5 text-fg-muted">
              {t("signin.key.entries", {
                left,
                limit: entries.limit,
                n: entries.used + 1,
              })}
            </p>
          )}
        </div>
      ) : null}
      <Button
        variant="neutral"
        size="xl"
        className={PRIMARY_CLASS}
        // While the skip is in flight: focusable, inert, so a second path cannot start.
        {...(busy ? { "aria-disabled": true } : {})}
        onClick={busy ? undefined : onCreate}
      >
        {t("signin.key.createAccount")}
      </Button>
      {forced ? (
        <p className="text-sm/5 text-fg-muted">
          {t("signin.key.noEntriesKeeps", { product: name })}
        </p>
      ) : null}
      {skip && !forced ? (
        <div className="space-y-2 text-center">
          <Button
            variant="outline"
            size="xl"
            className={AUTH_METHOD_CLASS}
            loading={busy}
            // A 429 holds the control without a tooltip of its own: the message under it is the
            // button's description (once), and the button keeps its focus.
            {...(hold ? { "aria-disabled": true } : {})}
            aria-describedby={refusal ? messageId : undefined}
            onClick={() => void press()}
          >
            {t("signin.key.skip")}
          </Button>
          <p className="text-sm/5 text-fg-muted">
            {t("signin.key.skipNote", { product: name })}
          </p>
          {refusal ? (
            <p
              id={messageId}
              role="alert"
              className="text-sm/5 text-danger [overflow-wrap:anywhere]"
            >
              {refusal.message}
            </p>
          ) : null}
        </div>
      ) : null}
      <QuietLinks>
        <QuietLink onClick={onSignIn} disabled={busy}>
          {t("signin.key.signInInstead")}
        </QuietLink>
        {refusal?.differentKey && onDifferentKey ? (
          <QuietLink onClick={onDifferentKey}>
            {t("signin.key.differentKey")}
          </QuietLink>
        ) : null}
      </QuietLinks>
    </>
  );
}

/**
 * A key that belongs to an account (`license_owned` from the key return, SIGN-IN.md §3.9): the
 * Worker never moves an owned license by key, so the card says whose it is to use and offers the
 * sign-in it already has, with the request kept. **Use a different key** goes back to the field.
 */
export function KeyOwned({
  product,
  onSignIn,
  onDifferentKey,
}: {
  product: string;
  onSignIn: () => void;
  onDifferentKey: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="space-y-2">
        <AuthTitle>{t("core.codes.license_owned.title")}</AuthTitle>
        <p className="text-fg-muted">
          {t("core.codes.license_owned.message", { product })}
        </p>
      </div>
      <Button
        variant="neutral"
        size="xl"
        className={PRIMARY_CLASS}
        onClick={onSignIn}
      >
        {t("signin.key.ownedSignIn")}
      </Button>
      <QuietLinks>
        <QuietLink onClick={onDifferentKey}>
          {t("signin.key.differentKey")}
        </QuietLink>
      </QuietLinks>
    </>
  );
}
