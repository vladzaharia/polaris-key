import * as React from "react";
import {
  CircleCheck,
  Clock,
  KeyRound,
  MonitorSmartphone,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { recommendReasons } from "@polaris-key/ui-core";
import type { KeyPreview } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import { AuthTitle, QuietLink, QuietLinks } from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { termText } from "../../model/signInRequest.js";
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
 * plain text; Cloud Sync only when the requesting app has it. **Skip for now** (S-24 D13) waits
 * for the floating-key return to an app (SIGN-IN.md §3.9).
 */
export function AccountUpgrade({
  preview,
  cloudSync = false,
  onCreate,
  onSignIn,
}: {
  preview: KeyPreview;
  /** The requesting app's Cloud Sync (`client.services.cloudSync`); a signed-out standalone has none. */
  cloudSync?: boolean;
  /** Create account: on to the sign-in card with the key carried. */
  onCreate: () => void;
  /** Sign in instead: the same card, the key carried too (LK-polish M5). */
  onSignIn: () => void;
}): React.ReactElement {
  const name = preview.product.name;
  const forced = preview.upgrade === "forced";
  const entries = preview.keyEntries;
  const left = entries ? Math.max(0, entries.limit - entries.used) : null;
  return (
    <>
      <div
        data-key-card
        className="flex items-start gap-3 rounded-md border border-border-strong px-3 py-3"
      >
        <CircleCheck
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-fg-muted"
        />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-fg-strong">
            {t("signin.key.keyWorks")}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
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
      <AuthTitle>
        {forced
          ? t("signin.key.noEntriesTitle", { product: name })
          : t("signin.key.upgradeTitle", { product: name })}
      </AuthTitle>
      {forced ? (
        <NeutralCallout icon={<Clock />}>
          <p>{t("signin.key.noEntries", { product: name })}</p>
        </NeutralCallout>
      ) : null}
      <ul className="space-y-1.5 text-sm text-fg-muted" data-reasons>
        {recommendReasons({ identity: true, sync: cloudSync }).map((key) => {
          const Icon = REASON_ICONS[key as ReasonKey];
          return (
            <li key={key} className="flex items-start gap-2">
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="text-pretty">
                {t(key as Parameters<typeof t>[0], {
                  developer: preview.product.developerName ?? name,
                })}
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
            <p className="text-sm text-fg-muted">
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
        size="lg"
        className={PRIMARY_CLASS}
        onClick={onCreate}
      >
        {t("signin.key.createAccount")}
      </Button>
      {forced ? (
        <p className="text-sm text-fg-muted">
          {t("signin.key.noEntriesKeeps", { product: name })}
        </p>
      ) : null}
      <QuietLinks>
        <QuietLink onClick={onSignIn}>
          {t("signin.key.signInInstead")}
        </QuietLink>
      </QuietLinks>
    </>
  );
}
