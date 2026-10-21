import * as React from "react";
import { CircleCheck, Clock } from "lucide-react";
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

/**
 * AccountUpgrade (SIGN-IN.md §3.9, PX-12; WIRE-CONTRACT-V4 §12.2 rule 8): what a key leads to,
 * from `POST /api/key/preview`, before anyone signs in. The key card ("Key works"), then "Keep
 * <Product> in an account" with the entries meter in ink (never amber: auth-10) and **Create
 * account**. Skippable while entries remain, and only where an app sent the person; forced when
 * a new device would be refused `key_entry_limit`: then a neutral callout and no skip.
 */
export function AccountUpgrade({
  preview,
  canSkip,
  onCreate,
  onSkip,
}: {
  preview: KeyPreview;
  /** An app sent the person: the key is accepted and the licence floats (S-24 D13). */
  canSkip: boolean;
  onCreate: () => void;
  onSkip: () => void;
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
      <div className="space-y-2">
        <AuthTitle>
          {forced
            ? t("signin.key.noEntriesTitle", { product: name })
            : t("signin.key.upgradeTitle", { product: name })}
        </AuthTitle>
        {forced ? null : (
          <p className="text-fg-muted">{t("signin.key.upgradeLede")}</p>
        )}
      </div>
      {forced ? (
        <NeutralCallout icon={<Clock />}>
          <p>{t("signin.key.noEntries", { product: name })}</p>
        </NeutralCallout>
      ) : null}
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
      {!forced && canSkip ? (
        <QuietLinks>
          <QuietLink onClick={onSkip}>{t("signin.key.withoutKey")}</QuietLink>
        </QuietLinks>
      ) : null}
    </>
  );
}
