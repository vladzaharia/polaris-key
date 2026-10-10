/**
 * A platform setting as a `SettingRow` (ST-07). The Worker's platform registry (A-13) has its own
 * shapes (`switch` with on/off, `choice` with a level per value, `integer` with raise/lower); this
 * adapts one to the engine's spec and confirm vocabulary, words what each change does, and wires
 * the version-guarded writes. Switches and choices commit on change (L0 with Undo); an integer
 * keeps a draft until Save.
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import {
  api,
  ApiError,
  type PlatformActivityItem,
  type PlatformCursor,
  type PlatformSetting,
} from "../../../../api.js";
import {
  formatCount,
  formatNumber,
  fromSeconds,
} from "../../../../lib/format.js";
import { Callout } from "../../../../ui/Callout.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { toast } from "../../../../ui/toast.js";
import { SettingRow } from "../../../../ui/settings/SettingRow.js";
import {
  LEVEL_RANK,
  confirmLevel,
  formatSettingValue,
  toField,
  type SettingConfirm,
  type SettingLevel,
  type SettingSpec,
} from "../../../../ui/settings/model.js";
import type { SettingHistoryEntry } from "../../../../ui/settings/SettingExtras.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";

/** The engine's spec for a platform setting. */
export function specOf(s: PlatformSetting): SettingSpec {
  if (s.kind === "switch") return { kind: "switch" };
  if (s.kind === "choice")
    return { kind: "enum", values: s.options.map((o) => o.value) };
  return { kind: "integer", unit: s.unit, min: s.min, max: s.max };
}

/** The engine's confirm vocabulary for a platform setting. */
export function confirmOf(s: PlatformSetting): SettingConfirm {
  if (s.kind === "switch") return s.confirm;
  if (s.kind === "choice") return { byValue: s.confirm };
  return { up: s.confirm.raise, down: s.confirm.lower };
}

const labelsOf = (s: PlatformSetting): Record<string, string> | undefined =>
  s.kind === "choice"
    ? Object.fromEntries(s.options.map((o) => [o.value, o.label]))
    : undefined;

/** A setting's value in words: "On", "30 days", "32 MiB". */
export function formatPlatformValue(
  s: PlatformSetting,
  value: unknown,
): string {
  return formatSettingValue(specOf(s), value, labelsOf(s));
}

/** A 409 from a version-guarded write. */
function isConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.reason === undefined || error.reason === "version_conflict")
  );
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
  if (setting.kind === "choice") {
    const v = raw.toLowerCase();
    return setting.options.some((o) => o.value === v) ? v : undefined;
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
  const before = formatPlatformValue(setting, setting.value);
  const next = formatPlatformValue(setting, after);
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
    case "LICENSING_RESERVED_NAMES":
      return after === "error"
        ? [
            "A manifest or catalog whose flag declares a reserved name with an incompatible type is refused at link, resync and console publish.",
            "A product listed below as incompatible fails its next resync until its catalog is fixed. Signed documents do not change.",
            reach,
          ]
        : [
            "Incompatible reserved-name declarations are accepted again, with a warning.",
            reach,
          ];
    case "IDENTITY_RESERVED_DISPLAY_NAMES":
      return after === "error"
        ? [
            "A product or listing name that uses a platform or store name is refused at link, resync and console listing edits.",
            "A product whose current name is reserved fails its next resync until it is renamed. The sign-in card already shows such a name as the product slug.",
            reach,
          ]
        : ["Reserved display names are accepted again, with a warning.", reach];
    case "KEYENTRY_REFUSALS":
      return after === "on"
        ? [
            "On products with Identity on, a new device is refused a key whose licence is in no account and has used every key entry. The app shows a link to add the key to an account.",
            "Devices already using a key are never refused. Turn this on only once the SDKs that show the refusal are released.",
            reach,
          ]
        : [
            "Every key entry is admitted again. Key entries are still counted.",
            reach,
          ];
    case "ASSET_HOSTING":
      return after === "on"
        ? [
            "The portal, the AltStore and SideStore sources and the download page show Polaris Key's own copies of products' images from the image host again.",
            "Release files are mirrored again, and the legacy download serves the copies.",
            reach,
          ]
        : [
            "Every surface goes back to the developer's own image URLs and the portal's media proxy, as before hosted assets.",
            "Release-file mirroring stops and the legacy download streams from GitHub; release files already copied keep serving from their copies. The stored copies stay, and image URLs already handed out keep working.",
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

const SETTING_ACTIONS = new Set([
  "platform.setting.set",
  "platform.setting.revert",
]);

export interface HistoryPage {
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

// ── Row chrome ───────────────────────────────────────────────────────────────────────────────

/** The row's source: who owns the effective value, or why it is locked. */
function SettingSource({
  setting,
}: {
  setting: PlatformSetting;
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
      />
    );
  }
  return <SourceBadge source={setting.source} />;
}

/** Why a hard-off switch cannot be turned on here. */
function HardOff({
  setting,
}: {
  setting: PlatformSetting;
}): React.ReactElement {
  return (
    <>
      <strong className="font-medium text-fg-strong">
        Turned off at deploy time
      </strong>{" "}
      <code className="font-mono text-xs">{setting.key} = &quot;off&quot;</code>{" "}
      in this environment&apos;s vars is a hard off. No console value can turn
      it on: change the deploy var and redeploy.
      {setting.stored && setting.stored.valid
        ? ` A console value of ${formatPlatformValue(setting, setting.stored.value)} is stored and applies once the deploy var allows it.`
        : null}
    </>
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
        default {formatPlatformValue(setting, setting.default)} · read by{" "}
        {setting.scripts.length > 1 ? "both Worker scripts" : "the main Worker"}
      </span>
    </>
  );
}

function snapshotValue(raw: unknown): unknown {
  return raw && typeof raw === "object" && "effective" in raw
    ? (raw as { effective: unknown }).effective
    : undefined;
}

/** This setting's changes from the platform trail, newest first. */
async function loadHistory(
  setting: PlatformSetting,
): Promise<SettingHistoryEntry[]> {
  const out: SettingHistoryEntry[] = [];
  let cursor: PlatformCursor | null = null;
  do {
    const page = await fetchSettingsHistory(cursor);
    for (const a of page.items) {
      if (a.target?.id !== setting.key) continue;
      const before = snapshotValue(a.before);
      const after = snapshotValue(a.after);
      out.push({
        id: a.id,
        by: a.actor.name || a.actor.email || "system",
        at: fromSeconds(a.at),
        change:
          before !== undefined && after !== undefined
            ? `${formatPlatformValue(setting, before)} → ${formatPlatformValue(setting, after)}`
            : a.action === "platform.setting.revert"
              ? "Reverted"
              : a.summary || "Changed",
      });
    }
    cursor = page.nextCursor;
  } while (cursor && out.length < 10);
  return out;
}

/** One editable platform setting. */
export function EditableRow({
  setting,
  storeAvailable,
  propagationSeconds,
}: {
  setting: PlatformSetting;
  storeAvailable: boolean;
  propagationSeconds: number;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const fmt = (v: unknown) => formatPlatformValue(setting, v);
  const bytes = setting.kind === "integer" && setting.unit === "bytes";
  const stored = setting.stored;
  const notes: React.ReactNode[] = [];
  if (stored && !stored.valid) {
    notes.push(
      <Callout key="invalid" tone="warning" title="Stored value not applied">
        The console value {JSON.stringify(stored.value)} is outside this
        setting&apos;s bounds, so it uses{" "}
        {setting.source === "deploy" ? "the deploy var" : "the code default"} (
        {fmt(setting.value)}). Revert it or save a valid value.
      </Callout>,
    );
  }

  const undo = (prev: PlatformSetting, written: PlatformSetting) => {
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
  };

  return (
    <SettingRow
      id={`platform-setting-${setting.key}`}
      settingKey={setting.key}
      label={setting.label}
      help={<SettingHelp setting={setting} />}
      spec={specOf(setting)}
      confirm={confirmOf(setting)}
      labels={labelsOf(setting)}
      value={setting.value}
      version={setting.version}
      commit={setting.kind === "integer" ? "explicit" : "immediate"}
      source={<SettingSource setting={setting} />}
      disabled={!storeAvailable}
      locked={setting.forcedOff ? <HardOff setting={setting} /> : undefined}
      notes={notes.length > 0 ? notes : undefined}
      footnote={
        bytes
          ? `In effect: ${formatCount(setting.value as number)} bytes.`
          : undefined
      }
      bounds={
        setting.kind === "integer"
          ? bytes
            ? `${formatNumber(toField(specOf(setting), setting.min))} to ${formatNumber(toField(specOf(setting), setting.max))} MiB. It can only lower the measured ${formatNumber(toField(specOf(setting), setting.max))} MiB ceiling.`
            : `${formatCount(setting.min)} to ${formatCount(setting.max)} days.`
          : undefined
      }
      reloadedBy={
        stored ? `set by ${stored.updatedBy || "an operator"}` : undefined
      }
      history={() => loadHistory(setting)}
      isConflict={isConflict}
      reload={() =>
        queryClient.refetchQueries({
          queryKey: qk.platformSettings(),
          exact: true,
        })
      }
      consequences={(to) =>
        consequencesOf(setting, to as string | number, propagationSeconds)
      }
      save={(value, ctx) =>
        mutate("patchPlatformSetting", setting.key, {
          value: value as string | number,
          expectedVersion: ctx.expectedVersion,
          ...(LEVEL_RANK[ctx.level] >= 2 ? { confirm: setting.key } : {}),
        })
      }
      onSaved={(res, done) => {
        const written = res as PlatformSetting;
        const text = `${setting.label} set to ${fmt(written.value)}`;
        if (done.level === "L0")
          toast.success(text, {
            action: { label: "Undo", onClick: () => undo(setting, written) },
          });
        else toast.success(text);
      }}
      revertPlan={() => {
        if (!stored) return null;
        const after = afterRevert(setting);
        const computed = confirmLevel(
          specOf(setting),
          confirmOf(setting),
          setting.value,
          after.value,
        );
        const level: SettingLevel = LEVEL_RANK[computed] >= 1 ? computed : "L1";
        const next = fmt(after.value);
        return {
          level,
          title: `Revert ${setting.label.toLowerCase()}?`,
          confirmLabel: `Revert to ${next}`,
          consequences: [
            `${setting.label} becomes ${next}, from ${after.from === "deploy" ? `the deploy var ${setting.key}` : "the code default"}.`,
            `The console value (${fmt(stored.value)}) is removed.`,
            `Takes effect within ${propagationSeconds} seconds.`,
          ],
          run: ({ expectedVersion }) =>
            mutate("revertPlatformSetting", setting.key, expectedVersion),
          onDone: () => toast.success(`${setting.label} reverted`),
        };
      }}
    />
  );
}
