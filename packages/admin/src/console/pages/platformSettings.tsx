/**
 * Platform → Settings (notes/S-13 §9.1, chunk 4P-1; T4). The instance-wide settings page:
 *
 * - **Background jobs**: the four runtime-editable settings of the A-13 registry (`LAZY_DELTAS`,
 *   `LAZY_DELTA_MAX_BYTES`, `BLOB_GC_MODE`, `BLOB_GC_GRACE_DAYS`), each its own save scope with its
 *   effective value and where it came from (`SourceBadge`: code default, deploy var, set in
 *   console). A deploy-time `off` on a kill switch is a hard off: the row is locked and says why.
 *   Every write carries `expectedVersion`; a 409 shows a reload-and-retry flow. Confirm levels
 *   come from the registry (`confirm`), per direction of change (ADMIN.md §5.2).
 * - The read-only inventory: identity and access, delivery, email and the code limits, all
 *   deploy-time.
 * - **Keyring**: the KEK keyring's state, read-only (`GET /products/kek`), plus the KEK
 *   configuration's presence. Rotation follows the runbook (`/docs/admin/kek/`).
 * - **Secrets**: presence only. The API never returns a value, a length or a hash.
 * - **History**: the settings writes of the platform trail (A-12 `platform_audit`).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Lock, RotateCcw } from "lucide-react";
import {
  api,
  ApiError,
  type PlatformActivityItem,
  type PlatformConfirmLevel,
  type PlatformCursor,
  type PlatformDeployValue,
  type PlatformIntegerSetting,
  type PlatformKekStatus,
  type PlatformSetting,
  type PlatformSettingsView,
  type PlatformSwitchSetting,
} from "../../api.js";
import { errorCopy } from "../../lib/errorCopy.js";
import {
  formatCount,
  formatNumber,
  formatSpan,
  fromSeconds,
} from "../../lib/format.js";
import { ENVIRONMENT_LABELS, label as labelOf } from "../../lib/labels.js";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { ConfirmDialog, type ConfirmIntent } from "../../ui/ConfirmDialog.js";
import { EmptyState } from "../../ui/EmptyState.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { Form, FormField, useAdminForm } from "../../ui/form.js";
import { NumberInput, numberRangeError } from "../../ui/NumberInput.js";
import { SaveBar } from "../../ui/SaveBar.js";
import { PageSkeleton } from "../../ui/Skeleton.js";
import { SourceBadge } from "../../ui/SourceBadge.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Switch } from "../../ui/Switch.js";
import { Timeline, TimelineItem } from "../../ui/Timeline.js";
import { toast } from "../../ui/toast.js";
import { PageHeader } from "../components/PageHeader.js";
import { mutate } from "../data/mutations.js";
import { qk } from "../data/queries.js";
import { queryClient } from "../data/queryClient.js";
import {
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../templates/Settings.js";

export function fetchPlatformSettings(): Promise<PlatformSettingsView> {
  return api.platformSettings();
}

export function fetchPlatformKek(): Promise<PlatformKekStatus> {
  return api.platformKek();
}

const MIB = 1_048_576;

// ── Values and confirm levels ────────────────────────────────────────────────────────────────

/** A setting's value in words: "On", "30 days", "32 MiB". */
export function formatSettingValue(
  setting: PlatformSetting,
  value: unknown,
): string {
  if (setting.kind === "switch") {
    return value === "on" ? "On" : value === "off" ? "Off" : String(value);
  }
  if (typeof value !== "number") return String(value);
  if (setting.unit === "days")
    return `${formatCount(value)} ${value === 1 ? "day" : "days"}`;
  return `${formatNumber(value / MIB, 2)} MiB`;
}

/** The registry's confirm level for a change from `before` to `after` (worker `settingConfirmLevel`). */
export function confirmLevel(
  setting: PlatformSetting,
  before: string | number,
  after: string | number,
): PlatformConfirmLevel {
  if (before === after) return "L0";
  if (setting.kind === "switch")
    return after === "on" ? setting.confirm.on : setting.confirm.off;
  return Number(after) > Number(before)
    ? setting.confirm.raise
    : setting.confirm.lower;
}

const RANK: Record<PlatformConfirmLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
};

function intentOf(level: PlatformConfirmLevel): ConfirmIntent {
  return RANK[level] >= 2 ? "danger" : "caution";
}

/** The deploy var as the setting would read it, or `undefined` when it is unset or not a value. */
function parsedDeployValue(
  setting: PlatformSetting,
): string | number | undefined {
  const raw = setting.deployValue?.trim();
  if (!raw) return undefined;
  if (setting.kind === "switch") {
    const v = raw.toLowerCase();
    return v === "on" || v === "off" ? v : undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** What a revert leaves in effect, and where it comes from. */
export function afterRevert(setting: PlatformSetting): {
  value: string | number;
  from: "deploy" | "default";
} {
  const deploy = parsedDeployValue(setting);
  return deploy !== undefined
    ? { value: deploy, from: "deploy" }
    : { value: setting.default, from: "default" };
}

/** What a change does, one effect per line, for its confirmation. */
function consequencesOf(
  setting: PlatformSetting,
  after: string | number,
  propagationSeconds: number,
): string[] {
  const before = formatSettingValue(setting, setting.value);
  const next = formatSettingValue(setting, after);
  const reach =
    setting.scripts.length > 1
      ? `Takes effect within ${propagationSeconds} seconds in both Worker scripts.`
      : `Takes effect within ${propagationSeconds} seconds.`;
  switch (setting.key) {
    case "LAZY_DELTAS":
      return after === "on"
        ? [
            "Products opted in to lazy deltas start counting demand and generating deltas.",
            "Delta work runs on the delta consumer, bounded by each product's daily cap and the size cap.",
            reach,
          ]
        : [
            "Demand counting and delta generation stop for every product.",
            reach,
          ];
    case "BLOB_GC_MODE":
      return after === "on"
        ? [
            "The nightly collector deletes blob-store objects nothing has referenced for the grace period.",
            "The bucket's 180-day age lock still bounds every deletion.",
            reach,
          ]
        : [
            "The nightly collector stops deleting; unreferenced objects keep using storage.",
            reach,
          ];
    case "BLOB_GC_GRACE_DAYS":
      return [
        `Objects unreferenced for ${next} become eligible for deletion at the next nightly run (was ${before}).`,
        "The bucket's 180-day age lock still bounds every deletion.",
        reach,
      ];
    case "LAZY_DELTA_MAX_BYTES":
      return [
        `The delta consumer encodes payloads up to ${next} on either side of a pair (was ${before}).`,
        "Larger pairs cost more consumer CPU and memory. 32 MiB is the measured ceiling.",
        reach,
      ];
    default:
      return [`${setting.label} changes from ${before} to ${next}.`, reach];
  }
}

/** A 409 from a version-guarded write. */
function isConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.reason === undefined || error.reason === "version_conflict")
  );
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "platform-jobs", title: "Background jobs" },
  { id: "platform-identity", title: "Identity & access" },
  { id: "platform-delivery", title: "Delivery" },
  { id: "platform-email", title: "Email" },
  { id: "platform-limits", title: "Limits" },
  { id: "platform-keyring", title: "Keyring" },
  { id: "platform-secrets", title: "Secrets" },
  { id: "platform-history", title: "History" },
];

const WARNING_TITLES: Record<string, string> = {
  console_oidc_shared: "The console shares the customer sign-in client",
  kek_id_set: "PLATFORM_KEK_ID is set",
  portal_session_secret_unset: "Portal sessions share the admin secret",
};

export function PlatformSettingsPage(): React.ReactElement {
  const query = useQuery(
    { queryKey: qk.platformSettings(), queryFn: fetchPlatformSettings },
    queryClient,
  );
  const view = query.data;
  const header = (
    <PageHeader
      title="Settings"
      description="Instance-wide settings: the background jobs you can change here, and the deploy-time values, keyring and secrets this deployment runs with."
      freshness={
        query.dataUpdatedAt
          ? {
              updatedAt: query.dataUpdatedAt,
              onRefresh: () => void query.refetch(),
              refreshing: query.isFetching,
            }
          : undefined
      }
    />
  );

  if (query.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="platform settings" />
      </div>
    );
  }
  if (!view) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const deploy = new Map(view.deployTime.map((d) => [d.name, d]));
  const secrets = new Map(view.secrets.map((s) => [s.name, s.set]));
  const kekWarning = view.warnings.find((w) => w.code === "kek_id_set");

  return (
    <SettingsTemplate header={header} sections={SECTIONS}>
      {view.warnings.length > 0 ? (
        <div className="space-y-3" aria-label="Warnings" role="region">
          {view.warnings.map((w) => (
            <Callout
              key={w.code}
              tone="warning"
              title={WARNING_TITLES[w.code] ?? w.code}
            >
              {w.message}
            </Callout>
          ))}
        </div>
      ) : null}

      <SettingsSection
        id="platform-jobs"
        title="Background jobs"
        description={`Each setting saves on its own and reaches every Worker isolate within ${view.propagationSeconds} seconds. A deploy var of off on a switch is a hard off the console cannot override.`}
      >
        {!view.storeAvailable ? (
          <div className="px-5 py-4">
            <Callout tone="danger" title="The settings store cannot be read">
              The switches are off until it can be read again, and changes
              cannot be saved. Check the D1 binding and migrations on
              Deployment.
            </Callout>
          </div>
        ) : null}
        {view.settings.map((s) =>
          s.kind === "switch" ? (
            <SwitchSettingRow
              key={s.key}
              setting={s}
              storeAvailable={view.storeAvailable}
              propagationSeconds={view.propagationSeconds}
            />
          ) : (
            <IntegerSettingRow
              key={s.key}
              setting={s}
              storeAvailable={view.storeAvailable}
              propagationSeconds={view.propagationSeconds}
            />
          ),
        )}
      </SettingsSection>

      <SettingsSection
        id="platform-identity"
        title="Identity & access"
        description="Who can sign in to this console. Deploy-time: these change only with a deploy, so a console session can never widen its own access."
      >
        <DeployRow item={deploy.get("PLATFORM_ADMIN_GROUP")} />
        <DeployRow item={deploy.get("ADMIN_OIDC_ISSUER")} />
        <DeployRow item={deploy.get("ADMIN_OIDC_CLIENT_ID")} />
        <DeployRow item={deploy.get("PLATFORM_OIDC_ISSUER")} />
        <DeployRow item={deploy.get("PLATFORM_OIDC_CLIENT_ID")} />
        <DeployRow item={deploy.get("OIDC_ISSUER_ALLOWLIST")} />
        <ConstantRow view={view} name="ADMIN_SESSION_TTL_SECONDS" />
      </SettingsSection>

      <SettingsSection
        id="platform-delivery"
        title="Delivery"
        description="Where this deployment serves from and stores bytes. Deploy-time."
      >
        <DeployRow item={deploy.get("PKEY_ENVIRONMENT")} />
        <DeployRow item={deploy.get("CONSOLE_ORIGIN")} />
        <DeployRow item={deploy.get("BLOB_ORIGIN")} />
        <DeployRow item={deploy.get("BLOBS_BUCKET_NAME")} />
        <DeployRow item={deploy.get("R2_ACCOUNT_ID")} />
        <DeployRow item={deploy.get("GITHUB_APP_ID")} />
      </SettingsSection>

      <SettingsSection
        id="platform-email"
        title="Email"
        description="The customer portal's sign-in email. The email binding's allowed senders still restrict it."
      >
        <DeployRow item={deploy.get("PORTAL_EMAIL_FROM")} />
      </SettingsSection>

      <LimitsSection view={view} />

      <KeyringSection
        deploy={deploy}
        secrets={secrets}
        warning={kekWarning?.message}
      />

      <SecretsSection view={view} />

      <HistorySection settings={view.settings} />
    </SettingsTemplate>
  );
}

// ── Editable rows ────────────────────────────────────────────────────────────────────────────

interface RowProps<S extends PlatformSetting> {
  setting: S;
  storeAvailable: boolean;
  propagationSeconds: number;
}

/** A confirmation waiting on the operator. */
interface PendingChange {
  kind: "set" | "revert";
  value: string | number;
  level: PlatformConfirmLevel;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const CANCELLED = Symbol("cancelled");

/** Where a conflict stands: just refused, or reloaded and ready to retry. */
type ConflictState = null | "refused" | "reloaded";

/**
 * The shared write logic of one setting row: version-guarded set and revert, the confirm dialog
 * per the registry's level, Undo for an L0 change, and the 409 flow.
 */
function useSettingWrites(
  setting: PlatformSetting,
  propagationSeconds: number,
) {
  const latest = React.useRef(setting);
  latest.current = setting;
  const [pending, setPending] = React.useState<PendingChange | null>(null);
  const [conflict, setConflict] = React.useState<ConflictState>(null);
  const [reloading, setReloading] = React.useState(false);

  const undoTo = React.useCallback(
    (prev: PlatformSetting, written: PlatformSetting) => {
      const restore =
        prev.stored && prev.stored.valid
          ? mutate("patchPlatformSetting", prev.key, {
              value: prev.stored.value as string | number,
              expectedVersion: written.version,
            })
          : mutate("revertPlatformSetting", prev.key, written.version);
      restore.then(
        () => toast.success(`${prev.label} restored`),
        (e: unknown) => toast.error(e),
      );
    },
    [],
  );

  /** Send the write. Resolves with the new setting; a 409 moves the row into the conflict flow. */
  const send = React.useCallback(
    async (kind: "set" | "revert", value: string | number) => {
      const current = latest.current;
      const level =
        kind === "set"
          ? confirmLevel(current, current.value, value)
          : ("L0" as const);
      try {
        const written =
          kind === "set"
            ? await mutate("patchPlatformSetting", current.key, {
                value,
                expectedVersion: current.version,
                ...(RANK[level] >= 2 ? { confirm: current.key } : {}),
              })
            : await mutate(
                "revertPlatformSetting",
                current.key,
                current.version,
              );
        setConflict(null);
        return { written, level };
      } catch (e) {
        if (isConflict(e)) setConflict("refused");
        throw e;
      }
    },
    [],
  );

  /** Change the value: straight away at L0 (with Undo), else through the confirmation. */
  const change = React.useCallback(
    (value: string | number): Promise<void> => {
      const current = latest.current;
      const level = confirmLevel(current, current.value, value);
      if (level === "L0") {
        return send("set", value).then(
          ({ written }) => {
            toast.success(
              `${current.label} set to ${formatSettingValue(current, written.value)}`,
              {
                action: {
                  label: "Undo",
                  onClick: () => undoTo(current, written),
                },
              },
            );
          },
          (e: unknown) => {
            if (!isConflict(e)) toast.error(e);
            throw e;
          },
        );
      }
      return new Promise<void>((resolve, reject) =>
        setPending({ kind: "set", value, level, resolve, reject }),
      );
    },
    [send, undoTo],
  );

  /** Revert to the deploy var or the code default: always confirmed (L1 at least). */
  const revert = React.useCallback((): Promise<void> => {
    const current = latest.current;
    const after = afterRevert(current);
    const computed = current.forcedOff
      ? "L0"
      : confirmLevel(current, current.value, after.value);
    const level: PlatformConfirmLevel = RANK[computed] >= 1 ? computed : "L1";
    return new Promise<void>((resolve, reject) =>
      setPending({
        kind: "revert",
        value: after.value,
        level,
        resolve,
        reject,
      }),
    );
  }, []);

  const reload = React.useCallback(async () => {
    setReloading(true);
    try {
      await queryClient.refetchQueries({
        queryKey: qk.platformSettings(),
        exact: true,
      });
      setConflict("reloaded");
    } finally {
      setReloading(false);
    }
  }, []);

  const dialog = pending ? (
    <ChangeDialog
      setting={setting}
      pending={pending}
      propagationSeconds={propagationSeconds}
      onCancel={() => {
        pending.reject(CANCELLED);
        setPending(null);
      }}
      onConfirm={async () => {
        try {
          await send(pending.kind, pending.value);
        } catch (e) {
          if (isConflict(e)) {
            // Close the dialog: the row now explains the conflict and offers the reload.
            pending.reject(e);
            setPending(null);
            return;
          }
          throw e;
        }
        toast.success(
          pending.kind === "revert"
            ? `${setting.label} reverted`
            : `${setting.label} set to ${formatSettingValue(setting, pending.value)}`,
        );
        pending.resolve();
        setPending(null);
      }}
    />
  ) : null;

  return {
    change,
    revert,
    dialog,
    conflict,
    clearConflict: () => setConflict(null),
    reload,
    reloading,
  };
}

function ChangeDialog({
  setting,
  pending,
  propagationSeconds,
  onCancel,
  onConfirm,
}: {
  setting: PlatformSetting;
  pending: PendingChange;
  propagationSeconds: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}): React.ReactElement {
  const next = formatSettingValue(setting, pending.value);
  const revert = pending.kind === "revert";
  const from = revert ? afterRevert(setting).from : null;
  const consequences = revert
    ? [
        `${setting.label} becomes ${next}, from ${from === "deploy" ? `the deploy var ${setting.key}` : "the code default"}.`,
        setting.stored
          ? `The console value (${formatSettingValue(setting, setting.stored.value)}) is removed.`
          : "The console value is removed.",
        `Takes effect within ${propagationSeconds} seconds.`,
      ]
    : consequencesOf(setting, pending.value, propagationSeconds);
  const verb = revert
    ? "Revert"
    : setting.kind === "switch"
      ? pending.value === "on"
        ? "Turn on"
        : "Turn off"
      : "Save";
  const title = revert
    ? `Revert ${setting.label.toLowerCase()}?`
    : setting.kind === "switch"
      ? `${verb} ${setting.label.toLowerCase()}?`
      : `Change ${setting.label.toLowerCase()} to ${next}?`;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      intent={intentOf(pending.level)}
      title={title}
      consequences={consequences}
      confirmLabel={
        revert
          ? `Revert to ${next}`
          : setting.kind === "switch"
            ? `${verb} ${setting.label.toLowerCase()}`
            : `Save ${next}`
      }
      typedConfirmation={
        pending.level === "L3"
          ? { value: setting.key, label: `Type ${setting.key} to confirm` }
          : undefined
      }
      describeError={(e) => errorCopy(e, { thing: "Setting" })}
      onConfirm={onConfirm}
    />
  );
}

/** The row's source: who owns the effective value, or why it is locked. */
function SettingSource({
  setting,
  onRevert,
}: {
  setting: PlatformSetting;
  onRevert?: () => void;
}): React.ReactElement {
  if (setting.forcedOff) {
    return (
      <StatusPill tone="warning" icon={Lock}>
        Locked off by deploy var
      </StatusPill>
    );
  }
  if (setting.source === "failsafe") {
    return <StatusPill tone="danger">Off: store unreadable</StatusPill>;
  }
  if (setting.source === "runtime") {
    return (
      <SourceBadge
        source="runtime"
        by={setting.stored?.updatedBy}
        at={setting.stored ? fromSeconds(setting.stored.updatedAt) : undefined}
        onRevert={onRevert}
      />
    );
  }
  return <SourceBadge source={setting.source} />;
}

/** Facts under a row: the hard off, an invalid stored value, who set it. */
function RowNotes({
  setting,
}: {
  setting: PlatformSetting;
}): React.ReactElement | null {
  const notes: React.ReactNode[] = [];
  if (setting.forcedOff) {
    notes.push(
      <Callout key="locked" tone="warning" title="Turned off at deploy time">
        <code className="font-mono text-xs">
          {setting.key} = &quot;off&quot;
        </code>{" "}
        in this environment&apos;s vars is a hard off. No console value can turn
        it on: change the deploy var and redeploy.
        {setting.stored && setting.stored.valid
          ? ` A console value of ${formatSettingValue(setting, setting.stored.value)} is stored and applies once the deploy var allows it.`
          : null}
      </Callout>,
    );
  }
  if (setting.stored && !setting.stored.valid) {
    notes.push(
      <Callout key="invalid" tone="warning" title="Stored value not applied">
        The console value {JSON.stringify(setting.stored.value)} is outside this
        setting&apos;s bounds, so it uses{" "}
        {setting.source === "deploy" ? "the deploy var" : "the code default"} (
        {formatSettingValue(setting, setting.value)}). Revert it or save a valid
        value.
      </Callout>,
    );
  }
  return notes.length > 0 ? (
    <div className="mt-3 space-y-2">{notes}</div>
  ) : null;
}

function ConflictNote({
  setting,
  state,
  reloading,
  onReload,
  onDismiss,
  draft,
}: {
  setting: PlatformSetting;
  state: ConflictState;
  reloading: boolean;
  onReload: () => void;
  onDismiss: () => void;
  /** The integer row's unsaved value, kept across the reload. */
  draft?: string;
}): React.ReactElement | null {
  if (state === null) return null;
  if (state === "refused") {
    return (
      <Callout
        tone="warning"
        title="This setting changed since you loaded it"
        className="mt-3"
        action={
          <Button
            size="sm"
            variant="outline"
            loading={reloading}
            onClick={onReload}
          >
            Reload
          </Button>
        }
      >
        Someone saved it first, so nothing was changed. Reload to see the
        current value{draft ? `; your ${draft} stays in the field` : ""}, then
        save again.
      </Callout>
    );
  }
  return (
    <Callout
      tone="info"
      title="Reloaded"
      className="mt-3"
      action={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      It now reads {formatSettingValue(setting, setting.value)}
      {setting.stored
        ? `, set by ${setting.stored.updatedBy || "an operator"}`
        : ""}
      .{" "}
      {draft
        ? `Save again to apply ${draft}, or Discard to keep the current value.`
        : "Change it again if you still need to."}
    </Callout>
  );
}

function RevertButton({
  setting,
  onRevert,
  disabled,
}: {
  setting: PlatformSetting;
  onRevert: () => void;
  disabled: boolean;
}): React.ReactElement | null {
  if (!setting.stored) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onRevert}
      disabled={disabled}
      aria-label={`Revert ${setting.label.toLowerCase()}…`}
    >
      <RotateCcw aria-hidden />
      Revert…
    </Button>
  );
}

function SettingHelp({
  setting,
}: {
  setting: PlatformSetting;
}): React.ReactElement {
  const deploy =
    setting.deployValue === null ? "unset" : `"${setting.deployValue}"`;
  return (
    <>
      {setting.description}
      <span className="mt-1 block text-xs">
        <code className="font-mono">{setting.key}</code> · deploy var {deploy} ·
        default {formatSettingValue(setting, setting.default)} · read by{" "}
        {setting.scripts.length > 1 ? "both Worker scripts" : "the main Worker"}
      </span>
    </>
  );
}

function SwitchSettingRow({
  setting,
  storeAvailable,
  propagationSeconds,
}: RowProps<PlatformSwitchSetting>): React.ReactElement {
  const writes = useSettingWrites(setting, propagationSeconds);
  const [busy, setBusy] = React.useState(false);
  const id = `platform-setting-${setting.key}`;
  const locked = setting.forcedOff || !storeAvailable;
  const run = (p: Promise<void>) => {
    setBusy(true);
    p.catch(() => undefined).finally(() => setBusy(false));
  };
  return (
    <SettingsRow
      label={setting.label}
      htmlFor={id}
      help={<SettingHelp setting={setting} />}
      source={
        <SettingSource
          setting={setting}
          onRevert={() => run(writes.revert())}
        />
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Switch
            id={id}
            checked={setting.value === "on"}
            disabled={locked || busy}
            onCheckedChange={(on) => run(writes.change(on ? "on" : "off"))}
          />
          <span className="text-sm text-fg-strong" aria-hidden>
            {setting.value === "on" ? "On" : "Off"}
          </span>
        </div>
        <RevertButton
          setting={setting}
          disabled={!storeAvailable || busy}
          onRevert={() => run(writes.revert())}
        />
      </div>
      <RowNotes setting={setting} />
      <ConflictNote
        setting={setting}
        state={writes.conflict}
        reloading={writes.reloading}
        onReload={() => void writes.reload()}
        onDismiss={writes.clearConflict}
      />
      {writes.dialog}
    </SettingsRow>
  );
}

interface IntegerDraft extends Record<string, unknown> {
  value: number | null;
}

/** The value as the field shows it: MiB for a byte size, the number itself otherwise. */
function toField(setting: PlatformIntegerSetting, value: number): number {
  return setting.unit === "bytes"
    ? Math.round((value / MIB) * 10_000) / 10_000
    : value;
}

function fromField(setting: PlatformIntegerSetting, value: number): number {
  return setting.unit === "bytes" ? Math.round(value * MIB) : value;
}

function IntegerSettingRow({
  setting,
  storeAvailable,
  propagationSeconds,
}: RowProps<PlatformIntegerSetting>): React.ReactElement {
  const writes = useSettingWrites(setting, propagationSeconds);
  const bytes = setting.unit === "bytes";
  const min = toField(setting, setting.min);
  const max = toField(setting, setting.max);
  const form = useAdminForm<IntegerDraft>({
    values: { value: toField(setting, setting.value) },
    resetOn: [setting.version, setting.value, setting.source],
    validate: (v): Record<string, string> => {
      const range = numberRangeError(v.value, { min, max, required: true });
      return range ? { value: range } : {};
    },
    mapServerErrors: () => null,
    onSubmit: async (v) => {
      try {
        await writes.change(fromField(setting, v.value!));
      } catch (e) {
        if (e === CANCELLED) throw new Error("cancelled");
        throw e;
      }
    },
  });

  // After a conflict's reload, keep the operator's draft against the new server value.
  const { serverChanged, keepMine } = form;
  React.useEffect(() => {
    if (writes.conflict === "reloaded" && serverChanged) keepMine();
  }, [writes.conflict, serverChanged, keepMine]);

  const draft = form.rhf.watch("value");
  const draftText =
    form.isDirty && typeof draft === "number"
      ? formatSettingValue(setting, fromField(setting, draft))
      : undefined;
  const id = `platform-setting-${setting.key}`;
  const unitLabel = bytes ? "MiB" : "days";
  const bounds = bytes
    ? `${formatNumber(min)} to ${formatNumber(max)} MiB. It can only lower the measured ${formatNumber(max)} MiB ceiling.`
    : `${formatCount(setting.min)} to ${formatCount(setting.max)} days.`;
  return (
    <SettingsRow
      label={setting.label}
      help={<SettingHelp setting={setting} />}
      source={
        <SettingSource
          setting={setting}
          onRevert={() => void writes.revert().catch(() => undefined)}
        />
      }
    >
      <Form form={form} id={id} aria-label={`${setting.label} value`}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <FormField<number | null>
            name="value"
            label={`Value (${unitLabel})`}
            help={bounds}
            disabled={!storeAvailable}
            className="min-w-48 max-w-xs flex-1"
          >
            {(f) => (
              <NumberInput
                {...f}
                unit={unitLabel}
                min={min}
                max={max}
                step={bytes ? "any" : 1}
                integer={!bytes}
              />
            )}
          </FormField>
          <RevertButton
            setting={setting}
            disabled={!storeAvailable}
            onRevert={() => void writes.revert().catch(() => undefined)}
          />
        </div>
        <SaveBar form={form} section={setting.label} saveLabel="Save" />
      </Form>
      {bytes ? (
        <p className="mt-2 text-xs text-fg-muted">
          In effect: {formatCount(setting.value)} bytes.
        </p>
      ) : null}
      <RowNotes setting={setting} />
      <ConflictNote
        setting={setting}
        state={writes.conflict}
        reloading={writes.reloading}
        onReload={() => void writes.reload()}
        onDismiss={writes.clearConflict}
        draft={draftText}
      />
      {writes.dialog}
    </SettingsRow>
  );
}

// ── Read-only inventory ──────────────────────────────────────────────────────────────────────

const DEPLOY_LABELS: Record<
  string,
  { label: string; help: string; unset: string }
> = {
  PKEY_ENVIRONMENT: {
    label: "Environment",
    help: "Names this deployment; the console badge shows it.",
    unset: "Not set",
  },
  PLATFORM_ADMIN_GROUP: {
    label: "Admin group",
    help: "Membership of this identity-provider group is console access.",
    unset: "Not set: nobody is a platform admin",
  },
  ADMIN_OIDC_ISSUER: {
    label: "Console identity provider issuer",
    help: "The OIDC issuer of the console's own sign-in client.",
    unset: "Not set: the console uses the platform client",
  },
  ADMIN_OIDC_CLIENT_ID: {
    label: "Console identity provider client",
    help: "The console's own OIDC client id. Operators only; customers never sign in through it.",
    unset: "Not set: the console uses the platform client",
  },
  PLATFORM_OIDC_ISSUER: {
    label: "Platform identity provider issuer",
    help: "The OIDC issuer the customer portal and platform-provider products sign in against.",
    unset: "Not set",
  },
  PLATFORM_OIDC_CLIENT_ID: {
    label: "Platform identity provider client",
    help: "The OIDC client id the customer portal and platform-provider products use.",
    unset: "Not set",
  },
  OIDC_ISSUER_ALLOWLIST: {
    label: "Custom issuer allowlist",
    help: "Hosts a product's repo manifest may name as a custom OIDC issuer. Anything else is refused.",
    unset: "Empty: every custom issuer is refused",
  },
  BLOB_ORIGIN: {
    label: "Bytes host",
    help: "The origin that serves release bytes. Requests there reach only byte routes.",
    unset: "Not set",
  },
  CONSOLE_ORIGIN: {
    label: "Console origin",
    help: "Where download pages link storefront feeds.",
    unset: "Not set",
  },
  BLOBS_BUCKET_NAME: {
    label: "Blob bucket",
    help: "The R2 bucket upload tickets are scoped to.",
    unset: "Not set",
  },
  R2_ACCOUNT_ID: {
    label: "Cloudflare account",
    help: "The account upload tickets are issued in.",
    unset: "Not set",
  },
  GITHUB_APP_ID: {
    label: "GitHub App",
    help: "The App that reads product repositories.",
    unset: "Not set: repositories cannot be linked",
  },
  PORTAL_EMAIL_FROM: {
    label: "Portal sender",
    help: "The From address of the portal's magic-link email.",
    unset: "Not set",
  },
};

function DeployRow({
  item,
}: {
  item: PlatformDeployValue | undefined;
}): React.ReactElement | null {
  if (!item) return null;
  const meta = DEPLOY_LABELS[item.name] ?? {
    label: item.name,
    help: "",
    unset: "Not set",
  };
  const value = item.value;
  return (
    <SettingsRow
      label={meta.label}
      help={
        <>
          {meta.help}
          <span className="mt-1 block font-mono text-xs">{item.name}</span>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {value === null || (Array.isArray(value) && value.length === 0) ? (
          <span className="text-fg-muted">{meta.unset}</span>
        ) : Array.isArray(value) ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={meta.label}>
            {value.map((host) => (
              <li
                key={host}
                className="rounded-md border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs text-fg"
              >
                {host}
              </li>
            ))}
          </ul>
        ) : item.name === "PKEY_ENVIRONMENT" ? (
          <span>{labelOf(ENVIRONMENT_LABELS, value)}</span>
        ) : (
          <span className="break-all font-mono text-xs text-fg">{value}</span>
        )}
      </div>
    </SettingsRow>
  );
}

const CONSTANT_LABELS: Record<string, { label: string; help: string }> = {
  ADMIN_SESSION_TTL_SECONDS: {
    label: "Console session length",
    help: "A console session ends after this, however active it is.",
  },
  AUDIT_RETENTION_SECONDS: {
    label: "Audit retention",
    help: "Audit and platform trail rows older than this are deleted nightly.",
  },
  BLOB_LOCK_AGE_SECONDS: {
    label: "Blob bucket age lock",
    help: "No object younger than this can be deleted. It must match the bucket's lock rule.",
  },
  MIN_GC_GRACE_SECONDS: {
    label: "Shortest collector grace",
    help: "The collector never deletes an object unreferenced for less than this.",
  },
  LAZY_DELTA_MAX_BYTES_CEILING: {
    label: "Lazy delta size ceiling",
    help: "The measured largest payload the delta consumer can encode.",
  },
};

function formatConstant(value: number, unit: string): string {
  if (unit === "seconds") {
    // Whole days stay in days ("180 days", not "6 months"): retention is promised in days.
    if (value >= 86_400 && value % 86_400 === 0) {
      const days = value / 86_400;
      return `${formatCount(days)} ${days === 1 ? "day" : "days"}`;
    }
    return formatSpan(value * 1000);
  }
  if (unit === "bytes") return `${formatNumber(value / MIB, 2)} MiB`;
  return `${formatCount(value)} ${unit}`;
}

function ConstantRow({
  view,
  name,
}: {
  view: PlatformSettingsView;
  name: string;
}): React.ReactElement | null {
  const c = view.constants.find((x) => x.name === name);
  if (!c) return null;
  const meta = CONSTANT_LABELS[c.name] ?? { label: c.name, help: "" };
  return (
    <SettingsRow
      label={meta.label}
      help={
        <>
          {meta.help}
          <span className="mt-1 block font-mono text-xs">{c.name}</span>
        </>
      }
    >
      {formatConstant(c.value, c.unit)}
    </SettingsRow>
  );
}

function LimitsSection({
  view,
}: {
  view: PlatformSettingsView;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const shown = view.constants.filter(
    (c) => c.name !== "ADMIN_SESSION_TTL_SECONDS",
  );
  return (
    <SettingsSection
      id="platform-limits"
      title="Limits"
      description="Retention and storage bounds built into this build. They change only through a code change, where review sees them."
      actions={
        <Button
          size="sm"
          variant="outline"
          aria-expanded={open}
          aria-controls="platform-limits-list"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : `Show ${shown.length}`}
        </Button>
      }
    >
      <div id="platform-limits-list" hidden={!open}>
        {open
          ? shown.map((c) => (
              <ConstantRow key={c.name} view={view} name={c.name} />
            ))
          : null}
      </div>
    </SettingsSection>
  );
}

// ── Keyring ──────────────────────────────────────────────────────────────────────────────────

const KEK_GROUPS: Record<string, string> = {
  keys: "Signing keys",
  secrets: "Product secrets",
  outletCredentials: "Outlet credentials",
  managed: "Managed secret values",
  platform: "Store connection credentials",
};

function KeyringSection({
  deploy,
  secrets,
  warning,
}: {
  deploy: Map<string, PlatformDeployValue>;
  secrets: Map<string, boolean>;
  warning?: string;
}): React.ReactElement {
  const kek = useQuery(
    { queryKey: qk.platformKek(), queryFn: fetchPlatformKek, retry: false },
    queryClient,
  );
  const k = kek.data;
  const ring = secrets.get("PLATFORM_KEK_KEYS");
  const single = secrets.get("PLATFORM_KEK");
  const activeVar = deploy.get("PLATFORM_KEK_ACTIVE")?.value;
  const idVar = deploy.get("PLATFORM_KEK_ID")?.value;
  const perKid = new Map<string, number>();
  for (const group of Object.values(k?.counts ?? {}))
    for (const [kid, n] of Object.entries(group))
      perKid.set(kid, (perKid.get(kid) ?? 0) + n);
  const groups = Object.entries(k?.counts ?? {}).filter(
    ([, g]) => Object.keys(g).length > 0,
  );
  return (
    <SettingsSection
      id="platform-keyring"
      title="Keyring"
      description="The platform key-encryption key seals every product's signing key and secrets. Read-only here: rotation is a deploy-time change, and the runbook walks through it with the re-seal sweep."
      actions={
        <a
          href="/docs/admin/kek/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          Keyring runbook
          <ExternalLink aria-hidden className="size-3.5" />
          <span className="sr-only">(opens the docs)</span>
        </a>
      }
    >
      {warning ? (
        <div className="px-5 py-4">
          <Callout tone="warning" title="PLATFORM_KEK_ID is set">
            {warning}
          </Callout>
        </div>
      ) : null}
      <SettingsRow
        label="Key configuration"
        help="Which KEK secrets this deployment has. Presence only."
      >
        <ul className="space-y-1.5">
          <PresenceItem name="PLATFORM_KEK_KEYS" set={ring} />
          <PresenceItem name="PLATFORM_KEK" set={single} />
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs">PLATFORM_KEK_ACTIVE</span>
            <span className="font-mono text-xs text-fg">
              {typeof activeVar === "string" ? activeVar : "Not set"}
            </span>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs">PLATFORM_KEK_ID</span>
            <span className="font-mono text-xs text-fg">
              {typeof idVar === "string" ? idVar : "Not set"}
            </span>
          </li>
        </ul>
      </SettingsRow>
      {kek.isPending ? (
        <div className="px-5 py-4" aria-hidden>
          <div className="h-24 animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none" />
        </div>
      ) : !k ? (
        <div className="px-5 py-4">
          {kek.error instanceof ApiError && kek.error.status === 503 ? (
            <Callout tone="danger" title="The platform keyring is unusable">
              {kek.error.message}. Every product&apos;s sealed values fail to
              open until it is fixed: start at Troubleshooting in the keyring
              runbook.
            </Callout>
          ) : (
            <ErrorState
              compact
              error={kek.error}
              onRetry={() => void kek.refetch()}
            />
          )}
        </div>
      ) : (
        <>
          <SettingsRow
            label="Active key"
            help="New values are sealed under it."
          >
            <span className="font-mono text-xs">{k.active}</span>
          </SettingsRow>
          <SettingsRow
            label="Keys in the ring"
            help="Every key the Worker can open values with."
          >
            <ul className="space-y-1.5" aria-label="Keys in the ring">
              {[...new Set([...k.kids, ...perKid.keys()])].map((kid) => {
                const inRing = k.kids.includes(kid);
                return (
                  <li
                    key={kid}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span className="font-mono text-xs">{kid}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-fg-muted">
                        {formatCount(perKid.get(kid) ?? 0)} sealed
                      </span>
                      {kid === k.active ? (
                        <StatusPill tone="success" size="sm">
                          Active
                        </StatusPill>
                      ) : inRing ? (
                        <StatusPill tone="neutral" size="sm">
                          In ring
                        </StatusPill>
                      ) : (
                        <StatusPill tone="danger" size="sm">
                          Not in ring
                        </StatusPill>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </SettingsRow>
          <SettingsRow
            label="Re-seal progress"
            help="Values still sealed under an older key."
          >
            {k.unopenable > 0 ? (
              <Callout tone="danger" title="Values cannot be opened">
                {formatCount(k.unopenable)} sealed{" "}
                {k.unopenable === 1 ? "value is" : "values are"} under a key no
                longer in the ring. Put that key back in PLATFORM_KEK_KEYS.
              </Callout>
            ) : k.remaining > 0 ? (
              <StatusPill tone="warning">
                {formatCount(k.remaining)} still on an older key
              </StatusPill>
            ) : (
              <StatusPill tone="success">
                Every value is under the active key
              </StatusPill>
            )}
          </SettingsRow>
          {groups.length > 0 ? (
            <SettingsRow
              label="Sealed values"
              help="Per kind of value, per key."
            >
              <ul className="space-y-1.5">
                {groups.map(([group, counts]) => (
                  <li
                    key={group}
                    className="flex flex-wrap items-baseline justify-between gap-2"
                  >
                    <span>{KEK_GROUPS[group] ?? group}</span>
                    <span className="font-mono text-xs text-fg-muted">
                      {Object.entries(counts)
                        .map(([kid, n]) => `${kid}: ${formatCount(n)}`)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </SettingsRow>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function PresenceItem({
  name,
  set,
}: {
  name: string;
  set: boolean | undefined;
}): React.ReactElement {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-mono text-xs">{name}</span>
      <StatusPill tone={set ? "success" : "neutral"} size="sm">
        {set ? "Set" : "Not set"}
      </StatusPill>
    </li>
  );
}

// ── Secrets ──────────────────────────────────────────────────────────────────────────────────

const SECRET_NOTES: Record<string, { what: string; unset?: string }> = {
  PLATFORM_KEK: { what: "Single platform KEK (legacy form of the ring)" },
  PLATFORM_KEK_KEYS: { what: "Platform KEK ring" },
  KEY_HASH_PEPPER: { what: "Pepper for license key and token hashes" },
  ADMIN_SESSION_SECRET: { what: "Console session signing" },
  PORTAL_SESSION_SECRET: {
    what: "Customer portal session signing",
    unset: "Falls back to ADMIN_SESSION_SECRET",
  },
  PLATFORM_OIDC_CLIENT_SECRET: {
    what: "Platform identity provider client secret",
  },
  ADMIN_OIDC_CLIENT_SECRET: {
    what: "Console identity provider client secret",
    unset: "Not needed while the console uses the platform client",
  },
  GITHUB_APP_PRIVATE_KEY: { what: "GitHub App private key" },
  GITHUB_WEBHOOK_SECRET: { what: "GitHub webhook signature secret" },
  R2_PARENT_ACCESS_KEY_ID: {
    what: "R2 parent access key id",
    unset: "Trusted publishing is off",
  },
  R2_PARENT_SECRET_ACCESS_KEY: {
    what: "R2 parent secret access key",
    unset: "Trusted publishing is off",
  },
};

function SecretsSection({
  view,
}: {
  view: PlatformSettingsView;
}): React.ReactElement {
  return (
    <SettingsSection
      id="platform-secrets"
      title="Secrets"
      description="Whether each Worker secret is set. Values are never shown: not a length, not a hash. Set them with wrangler secret put."
    >
      <div className="px-5 py-4">
        <ul className="divide-y divide-border" aria-label="Worker secrets">
          {view.secrets.map((s) => {
            const note = SECRET_NOTES[s.name];
            return (
              <li
                key={s.name}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-fg-strong">{s.name}</p>
                  {note ? (
                    <p className="text-xs text-fg-muted">
                      {note.what}
                      {!s.set && note.unset ? `. ${note.unset}.` : null}
                    </p>
                  ) : null}
                </div>
                <StatusPill tone={s.set ? "success" : "neutral"} size="sm">
                  {s.set ? "Set" : "Not set"}
                </StatusPill>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsSection>
  );
}

// ── History ──────────────────────────────────────────────────────────────────────────────────

const SETTING_ACTIONS = new Set([
  "platform.setting.set",
  "platform.setting.revert",
]);

interface HistoryPage {
  items: PlatformActivityItem[];
  nextCursor: PlatformCursor | null;
}

/** Pages read per fetch before showing what was found: the trail holds other actions too. */
const HISTORY_PAGE_BUDGET = 5;
const HISTORY_TARGET = 10;

/** The settings writes of the platform trail, from `cursor` on, filtered client-side. */
export async function fetchSettingsHistory(
  cursor: PlatformCursor | null = null,
): Promise<HistoryPage> {
  const items: PlatformActivityItem[] = [];
  let next = cursor;
  for (let i = 0; i < HISTORY_PAGE_BUDGET; i++) {
    const page = await api.platformActivity(next);
    items.push(...page.items.filter((a) => SETTING_ACTIONS.has(a.action)));
    next = page.nextCursor;
    if (!next || items.length >= HISTORY_TARGET) break;
  }
  return { items, nextCursor: next };
}

function fetchFirstHistoryPage(): Promise<HistoryPage> {
  return fetchSettingsHistory(null);
}

function snapshotValue(raw: unknown): unknown {
  return raw && typeof raw === "object" && "effective" in raw
    ? (raw as { effective: unknown }).effective
    : undefined;
}

function HistorySection({
  settings,
}: {
  settings: PlatformSetting[];
}): React.ReactElement {
  const history = useQuery(
    {
      queryKey: qk.platformSettingsHistory(),
      queryFn: fetchFirstHistoryPage,
    },
    queryClient,
  );
  const [extra, setExtra] = React.useState<HistoryPage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const first = history.data;
  React.useEffect(() => {
    setExtra(null);
    setError(null);
  }, [first]);
  const cursor = extra ? extra.nextCursor : (first?.nextCursor ?? null);
  const items = [...(first?.items ?? []), ...(extra?.items ?? [])];
  const loadMore = () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    fetchSettingsHistory(cursor)
      .then((page) =>
        setExtra((prev) => ({
          items: [...(prev?.items ?? []), ...page.items],
          nextCursor: page.nextCursor,
        })),
      )
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  };
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const describe = (a: PlatformActivityItem): string | undefined => {
    const s = a.target ? byKey.get(a.target.id) : undefined;
    const before = snapshotValue(a.before);
    const after = snapshotValue(a.after);
    if (!s || before === undefined || after === undefined)
      return a.summary || undefined;
    return `${formatSettingValue(s, before)} → ${formatSettingValue(s, after)}`;
  };
  return (
    <SettingsSection
      id="platform-history"
      title="History"
      description="Every change to a background-job setting, newest first, from the platform trail."
    >
      <div className="px-5 py-4">
        {history.isPending ? (
          <div
            aria-hidden
            className="h-24 animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none"
          />
        ) : history.isError && !first ? (
          <ErrorState
            compact
            error={history.error}
            onRetry={() => void history.refetch()}
          />
        ) : items.length === 0 && !cursor ? (
          <EmptyState
            kind="first-run"
            title="No setting changes yet"
            description="Each change made here is recorded with who made it and the value before and after."
            docs="/docs/admin/activity/"
          />
        ) : (
          <>
            {items.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No setting changes in the most recent platform activity.
              </p>
            ) : null}
            <Timeline<PlatformActivityItem>
              label="Setting changes"
              items={items}
              getKey={(a) => a.id}
              getTime={(a) => fromSeconds(a.at)}
              loadMore={{
                onLoadMore: loadMore,
                hasMore: cursor !== null,
                loading,
              }}
              renderItem={(a) => {
                const s = a.target ? byKey.get(a.target.id) : undefined;
                const change = describe(a);
                return (
                  <TimelineItem
                    actor={
                      a.actor.name || a.actor.email
                        ? { name: a.actor.name || a.actor.email }
                        : "system"
                    }
                    verb={
                      a.action === "platform.setting.revert"
                        ? "reverted"
                        : "changed"
                    }
                    target={
                      <span className="font-bold text-fg-strong">
                        {s?.label ?? a.target?.id ?? "a setting"}
                        {change ? (
                          <span className="ml-1 font-normal text-fg-muted">
                            ({change})
                          </span>
                        ) : null}
                      </span>
                    }
                    at={fromSeconds(a.at)}
                    summary={a.summary || undefined}
                  />
                );
              }}
            />
            {error ? (
              <ErrorState compact error={error} onRetry={loadMore} />
            ) : null}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
