/**
 * The App sign-in cards the page's one form controls (I-29): License keys and Polaris Locker.
 * They only mark the page dirty; the page's SaveBar saves them.
 */

import * as React from "react";
import { PencilLine } from "lucide-react";
import type { ProductSetting } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { ClaimByKeyWarning } from "./ClaimByKeyWarning.js";

export interface SignInDraft {
  portalEnabled: boolean;
  keyReissueEnabled: boolean;
  claimByKey: boolean;
  /** `null` while the setting has not loaded, or the viewer cannot read it. */
  keyLimit: number | null;
}

const PRESETS = [5, 10, 25];

/** "Not saved" under a changed row's text. */
const NOT_SAVED = "Not saved";

export function LicenseKeysSection({
  slug,
  draft,
  saved,
  limit,
  readOnly,
  set,
}: {
  slug: string;
  draft: SignInDraft;
  saved: SignInDraft;
  limit: ProductSetting | undefined;
  readOnly: boolean;
  set: <K extends keyof SignInDraft>(key: K, value: SignInDraft[K]) => void;
}): React.ReactElement {
  const [reverting, setReverting] = React.useState(false);
  const max =
    limit?.spec.kind === "integer" ? limit.spec.max : Number.MAX_SAFE_INTEGER;
  const current = draft.keyLimit;
  const options = [
    ...PRESETS.map((n) => ({ value: String(n), label: String(n) })),
    ...(current !== null && !PRESETS.includes(current) && current !== max
      ? [{ value: String(current), label: String(current) }]
      : []),
    { value: String(max), label: "No limit" },
  ].sort((a, b) => Number(a.value) - Number(b.value));
  const claimed =
    limit !== undefined &&
    limit.source === "console" &&
    limit.manifestValue !== undefined;
  const limitChanged = draft.keyLimit !== saved.keyLimit;
  const claimChanged = draft.claimByKey !== saved.claimByKey;

  return (
    <SettingsSection
      id="license-keys"
      title="License keys"
      source={
        claimed ? (
          <StatusPill tone="neutral" icon={PencilLine}>
            Changed here · <code>.pkey/product</code> says{" "}
            {String(limit!.manifestValue)}
          </StatusPill>
        ) : undefined
      }
      actions={
        claimed ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={readOnly}
            onClick={() => setReverting(true)}
          >
            Revert to manifest…
          </Button>
        ) : undefined
      }
    >
      {current !== null ? (
        <SettingsRow
          label="Key entries before an account is needed"
          help={
            <>
              Activated devices keep working.
              {limitChanged ? <> {NOT_SAVED}.</> : null}
            </>
          }
          state={limitChanged ? "changed" : undefined}
        >
          <SegmentedControl
            size="sm"
            wrap
            aria-label="Key entries before an account is needed"
            options={options}
            value={String(current)}
            disabled={readOnly}
            onChange={(v) => set("keyLimit", Number(v))}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow
        label="A key adds its license to whoever enters it"
        htmlFor="sign-in-claim-by-key"
        help={
          <>
            Off: only to the account with the buyer’s email.
            {claimChanged ? <> {NOT_SAVED}.</> : null}
          </>
        }
        state={claimChanged ? "changed" : undefined}
        footer={draft.claimByKey ? <ClaimByKeyWarning /> : undefined}
      >
        <Switch
          id="sign-in-claim-by-key"
          checked={draft.claimByKey}
          disabled={readOnly}
          onCheckedChange={(c) => set("claimByKey", c)}
        />
      </SettingsRow>
      {reverting && limit ? (
        <ConfirmDialog
          open
          onOpenChange={setReverting}
          intent="caution"
          title="Return key entries to the manifest?"
          consequences={[
            `The limit goes back to ${String(limit.manifestValue)}, as .pkey/product says.`,
            "Later resyncs keep it in line with the manifest.",
          ]}
          confirmLabel="Revert to manifest"
          describeError={(e) => errorCopy(e)}
          onConfirm={async () => {
            await mutate("revertProductSetting", slug, limit.key, {
              expectedVersion: limit.version,
            });
            toast.success("Key entries follow the manifest again");
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

/** Polaris Locker: the two switches that remain of the customer-facing settings. */
export function LockerSection({
  name,
  draft,
  saved,
  readOnly,
  set,
}: {
  name: string;
  draft: SignInDraft;
  saved: SignInDraft;
  readOnly: boolean;
  set: <K extends keyof SignInDraft>(key: K, value: SignInDraft[K]) => void;
}): React.ReactElement {
  const rows = [
    {
      key: "portalEnabled",
      label: `Show ${name} in players’ libraries`,
    },
    { key: "keyReissueEnabled", label: "Show a lost key again" },
  ] as const;
  return (
    <SettingsSection id="polaris-locker" title="Polaris Locker">
      {rows.map((row) => {
        const changed = draft[row.key] !== saved[row.key];
        return (
          <SettingsRow
            key={row.key}
            label={row.label}
            htmlFor={`locker-${row.key}`}
            help={changed ? NOT_SAVED : undefined}
            state={changed ? "changed" : undefined}
          >
            <Switch
              id={`locker-${row.key}`}
              checked={draft[row.key]}
              disabled={readOnly}
              onCheckedChange={(c) => set(row.key, c)}
            />
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
