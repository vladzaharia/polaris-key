import * as React from "react";
import type { ChannelPolicyDto, ReleaseChannelFloorDto } from "../../../api.js";
import { confirmFor, type ActionId } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatDate, fromSeconds } from "../../../lib/format.js";
import { isValidVersion } from "../../../lib/version.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Combobox } from "../../../ui/Combobox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { FormField } from "../../../ui/form.js";
import { Select } from "../../../ui/Select.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { VersionInput } from "../../../ui/VersionInput.js";
import { mutate } from "../../data/mutations.js";

/**
 * Every release-policy write the console makes (P2-05's admin routes, P4-12's pack floors), one
 * confirmation each (ADMIN.md §5.2, §6.3.3). The dialog states the effect before anything is
 * sent, worded from what the server implements; its level comes from `lib/actions.ts`, so a yank
 * is a danger confirm and an unyank a caution one (REL-5), and "Mark critical" is caution, not
 * destructive (PAD-5). A refusal stays in the dialog, worded by `errorCopy` (PAD-1's invalidation
 * is `mutate`'s table).
 */

/** A release the pickers can offer (an app release from the store, or a pack release). */
export interface ReleaseOption {
  releaseId: string;
  version: string;
  channel: string | null;
  publishedAt: number | null;
  seq: number | null;
  yanked: boolean;
}

export type PolicyAction =
  /** Promote or pin; the channel, the release or both may be preselected (a row menu). */
  | {
      kind: "promote" | "pin";
      deliverable: string;
      channel?: string;
      releaseId?: string;
    }
  | { kind: "unpin"; channel: ChannelPolicyDto }
  | { kind: "minSupported"; channel: ChannelPolicyDto }
  | { kind: "critical"; channel: ChannelPolicyDto }
  | { kind: "revert"; channel: ChannelPolicyDto }
  /** A pack's floor for one contentApi line (P4-12): set, change or clear. */
  | { kind: "packFloor"; channel: ChannelPolicyDto; contentApi?: number }
  /** The anti-rollback floor is keyed by channel name alone (a floor can outlive its channel). */
  | { kind: "lowerFloor"; channel: string; floor: ReleaseChannelFloorDto }
  | { kind: "clearFloor"; channel: string; floor: ReleaseChannelFloorDto }
  | { kind: "yank"; release: ReleaseOption }
  | { kind: "unyank"; release: ReleaseOption };

export const ACTION_IDS: Record<PolicyAction["kind"], ActionId> = {
  promote: "channel.promote",
  pin: "channel.pin",
  unpin: "channel.unpin",
  minSupported: "channel.setMinSupported",
  critical: "channel.markCritical",
  revert: "manifest.revert",
  packFloor: "channel.setPackFloor",
  lowerFloor: "channel.lowerFloor",
  clearFloor: "channel.clearFloor",
  yank: "release.yank",
  unyank: "release.unyank",
};

/** The action id an action is levelled by (clearing critical has its own id). */
export function actionIdOf(action: PolicyAction): ActionId {
  if (action.kind === "critical" && action.channel.critical)
    return "channel.clearCritical";
  return ACTION_IDS[action.kind];
}

/** Newest first, by seq, then publish time. */
function newestFirst(a: ReleaseOption, b: ReleaseOption): number {
  return (
    (b.seq ?? 0) - (a.seq ?? 0) || (b.publishedAt ?? 0) - (a.publishedAt ?? 0)
  );
}

export function PolicyDialog({
  slug,
  action,
  channels,
  releases,
  onClose,
}: {
  slug: string;
  /** `null` = closed. */
  action: PolicyAction | null;
  /** The channels of the action's deliverable (promote and pin choose one, and read its pin). */
  channels: ChannelPolicyDto[];
  /** The deliverable's releases, for the pickers and for naming a release by its version. */
  releases: ReleaseOption[];
  onClose: () => void;
}): React.ReactElement | null {
  const [channel, setChannel] = React.useState<string | null>(null);
  const [releaseId, setReleaseId] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");
  const [clear, setClear] = React.useState(false);
  const [contentApi, setContentApi] = React.useState("");
  const [touched, setTouched] = React.useState(false);

  // Each opening starts from the action's own defaults. Keyed on the action alone: a refetch
  // while the dialog is open must not reset what the operator typed.
  const ctx = React.useRef({ channels, releases });
  ctx.current = { channels, releases };
  React.useEffect(() => {
    if (!action) return;
    const { channels, releases } = ctx.current;
    setTouched(false);
    setClear(false);
    setText("");
    setContentApi("");
    setChannel(null);
    setReleaseId(null);
    if (action.kind === "promote" || action.kind === "pin") {
      const c = action.channel ?? channels[0]?.channel ?? null;
      setChannel(c);
      const policy = channels.find((x) => x.channel === c);
      const options = pickable(action.kind, releases);
      setReleaseId(
        action.releaseId ??
          options.find((r) => r.releaseId === policy?.pointer)?.releaseId ??
          options[0]?.releaseId ??
          null,
      );
    } else if (action.kind === "minSupported") {
      setText(action.channel.minSupported ?? "");
      setClear(false);
    } else if (action.kind === "packFloor") {
      const line = action.contentApi;
      setContentApi(line === undefined ? "" : String(line));
      setText(
        action.channel.packFloors?.find((f) => f.contentApi === line)
          ?.minSupported ?? "",
      );
    } else if (action.kind === "lowerFloor") {
      setText("");
    }
  }, [action]);

  if (!action) return null;

  const versionOf = (id: string | null | undefined): string =>
    id ? (releases.find((r) => r.releaseId === id)?.version ?? id) : "—";
  const policy =
    action.kind === "promote" || action.kind === "pin"
      ? channels.find((c) => c.channel === channel)
      : undefined;
  const spec = describe(action, {
    channel,
    policy,
    picked: releaseId ? versionOf(releaseId) : null,
    text: text.trim(),
    clear,
    contentApi: contentApi.trim(),
    versionOf,
  });
  const level = confirmFor(actionIdOf(action));

  const confirm = async (): Promise<void> => {
    // An input that is not ready yet is shown on its field; nothing is sent.
    setTouched(true);
    if (spec.error) return;
    await run(slug, action, {
      channel: channel ?? "",
      releaseId: releaseId ?? "",
      text: text.trim(),
      clear,
      contentApi: Number(contentApi.trim()),
    });
    toast.success(spec.done);
    onClose();
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      intent={level.intent === "none" ? "neutral" : level.intent}
      title={spec.title}
      description={spec.description}
      consequences={spec.consequences}
      confirmLabel={spec.confirmLabel}
      closeOnSuccess={false}
      describeError={(e) => errorCopy(e, { area: "release", thing: "Release" })}
      onConfirm={confirm}
    >
      {action.kind === "promote" || action.kind === "pin" ? (
        <div className="space-y-4">
          {action.channel === undefined ? (
            <FormField
              name="policy-channel"
              label="Channel"
              value={channel}
              onChange={(v: string | null) => setChannel(v)}
              error={
                touched && spec.error === NO_CHANNEL ? spec.error : undefined
              }
            >
              {(f) => (
                <Select
                  {...f}
                  options={channels.map((c) => ({
                    value: c.channel,
                    label: c.channel,
                    description: c.pinned ? "Pinned" : undefined,
                  }))}
                  placeholder="Choose a channel"
                />
              )}
            </FormField>
          ) : null}
          <FormField
            name="policy-release"
            label="Release"
            help={
              action.kind === "promote"
                ? "Yanked releases can't be promoted; pin one instead."
                : "A pin may name a yanked release: it is the only way one is served."
            }
            value={releaseId}
            onChange={(v: string | null) => setReleaseId(v)}
            error={
              touched && spec.error === NO_RELEASE ? spec.error : undefined
            }
          >
            {(f) => (
              <Combobox
                {...f}
                options={pickable(action.kind, releases).map((r) => ({
                  value: r.releaseId,
                  label: r.version,
                  secondary: [
                    r.channel,
                    r.publishedAt
                      ? formatDate(fromSeconds(r.publishedAt))
                      : null,
                    r.yanked ? "Yanked" : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  searchText: `${r.version} ${r.channel ?? ""}`,
                }))}
                placeholder="Choose a release"
                searchPlaceholder="Search versions"
                emptyText="No release matches."
              />
            )}
          </FormField>
        </div>
      ) : null}
      {action.kind === "yank" ? (
        <FormField
          name="yank-reason"
          label="Reason"
          required
          help="Recorded with the yank and shown beside the release (500 characters at most)."
          value={text}
          onChange={(v: string) => setText(v)}
          error={touched && spec.error ? spec.error : undefined}
          announceError
        >
          {(f) => (
            <Textarea
              {...f}
              maxLength={500}
              placeholder="Crashes on launch on Android 14"
            />
          )}
        </FormField>
      ) : null}
      {action.kind === "minSupported" ? (
        <div className="space-y-3">
          <FormField
            name="policy-min"
            label="Minimum supported version"
            help="Devices below it are asked to update."
            value={text}
            onChange={(v: string) => setText(v)}
            disabled={clear}
            error={touched && spec.error && !clear ? spec.error : undefined}
            announceError
          >
            {(f) => <VersionInput {...f} />}
          </FormField>
          {action.channel.minSupported ? (
            <Checkbox
              checked={clear}
              onCheckedChange={setClear}
              label="Remove the minimum supported version"
            />
          ) : null}
        </div>
      ) : null}
      {action.kind === "packFloor" ? (
        <div className="space-y-3">
          {action.contentApi === undefined ? (
            <FormField
              name="policy-content-api"
              label="Content API line"
              help="The contentApi level of the app releases this floor applies to."
              value={contentApi}
              onChange={(v: string) => setContentApi(v)}
              error={
                touched && spec.error === BAD_LINE ? spec.error : undefined
              }
            >
              {(f) => <VersionInput {...f} placeholder="3" />}
            </FormField>
          ) : null}
          <FormField
            name="policy-pack-floor"
            label="Minimum pack version"
            help="Devices on this line below it are moved to a newer pack release."
            value={text}
            onChange={(v: string) => setText(v)}
            disabled={clear}
            error={
              touched && spec.error === NO_VERSION && !clear
                ? spec.error
                : undefined
            }
          >
            {(f) => <VersionInput {...f} placeholder="1.3.0" />}
          </FormField>
          {action.contentApi !== undefined ? (
            <Checkbox
              checked={clear}
              onCheckedChange={setClear}
              label="Clear this line's floor"
            />
          ) : null}
        </div>
      ) : null}
      {action.kind === "lowerFloor" ? (
        <FormField
          name="policy-floor"
          label="Lower the floor to"
          required
          help={`Below the current floor, ${action.floor.version}.`}
          value={text}
          onChange={(v: string) => setText(v)}
          error={touched && spec.error ? spec.error : undefined}
          announceError
        >
          {(f) => <VersionInput {...f} placeholder="1.0.0" />}
        </FormField>
      ) : null}
    </ConfirmDialog>
  );
}

const NO_CHANNEL = "Choose a channel.";
const NO_RELEASE = "Choose a release.";
const NO_VERSION = "Enter a version.";
const BAD_VERSION = "Use a version such as 2.0.0.";
const BAD_LINE = "Enter a content API line: a whole number, 1 or higher.";

/**
 * The releases a promote or pin may name, newest first. A yanked release can't be promoted (the
 * server refuses it with `release_yanked`) but may be pinned.
 */
export function pickable(
  kind: "promote" | "pin",
  releases: ReleaseOption[],
): ReleaseOption[] {
  return releases.filter((r) => kind === "pin" || !r.yanked).sort(newestFirst);
}

interface Spec {
  title: string;
  description?: string;
  consequences: string[];
  confirmLabel: string;
  done: string;
  /** Why the confirm can't send yet (shown inline, on the field). */
  error?: string;
}

function describe(
  action: PolicyAction,
  input: {
    channel: string | null;
    policy: ChannelPolicyDto | undefined;
    picked: string | null;
    text: string;
    clear: boolean;
    contentApi: string;
    versionOf: (id: string | null | undefined) => string;
  },
): Spec {
  const { picked, text, clear, versionOf } = input;
  switch (action.kind) {
    case "promote": {
      const c = input.channel ?? "the channel";
      const v = picked ?? "the release";
      return {
        title: `Promote ${v} to ${c}`,
        consequences: input.policy?.pinned
          ? [
              `${c} is pinned, so the pin moves to ${v}: every platform with a ${v} build serves it.`,
              "Newer releases stay ignored until you unpin.",
            ]
          : [
              `Promote moves the pointer; newer releases still flow if the pointer is unpinned.`,
              `${c} serves ${v} on each platform where it is newer than what the platform gets now.`,
            ],
        confirmLabel: `Promote ${picked ?? ""}`.trim(),
        done: `Promoted ${v} to ${c}`,
        error: !input.channel ? NO_CHANNEL : !picked ? NO_RELEASE : undefined,
      };
    }
    case "pin": {
      const c = input.channel ?? "the channel";
      const v = picked ?? "the release";
      return {
        title: `Pin ${c} to ${v}`,
        consequences: [
          "Pin freezes the channel at this release.",
          `${c} serves ${v} on every platform that has a ${v} build; a platform without one gets the newest older release that has one.`,
          "Newer releases are ignored until you unpin.",
        ],
        confirmLabel: `Pin ${input.channel ?? ""}`.trim(),
        done: `Pinned ${c} to ${v}`,
        error: !input.channel ? NO_CHANNEL : !picked ? NO_RELEASE : undefined,
      };
    }
    case "unpin": {
      const c = action.channel.channel;
      return {
        title: `Unpin ${c}`,
        consequences: [
          `${c} goes back to serving its newest eligible release on each platform.`,
          `${versionOf(action.channel.pointer)} stays a member of ${c}.`,
        ],
        confirmLabel: `Unpin ${c}`,
        done: `Unpinned ${c}`,
      };
    }
    case "minSupported": {
      const c = action.channel.channel;
      const removing = clear;
      return {
        title: removing
          ? `Remove ${c}'s minimum supported version`
          : `Set ${c}'s minimum supported version`,
        consequences: removing
          ? [
              `The signed channel feed stops asking older devices on ${c} to update on its account.`,
            ]
          : [
              `Devices on ${c} running a version below ${text || "it"} are asked to update.`,
              `The signed channel feed carries ${text || "the version"} as its floor.`,
            ],
        confirmLabel: removing ? "Remove minimum" : "Set minimum",
        done: removing
          ? `Removed ${c}'s minimum supported version`
          : `${c} requires ${text} or newer`,
        error: removing
          ? undefined
          : !text
            ? NO_VERSION
            : action.channel.deliverable === "app" && !isValidVersion(text)
              ? BAD_VERSION
              : text === (action.channel.minSupported ?? "")
                ? "That is already the minimum supported version."
                : undefined,
      };
    }
    case "critical": {
      const c = action.channel.channel;
      const on = !action.channel.critical;
      return {
        title: on ? `Mark ${c} critical` : `Clear ${c}'s critical flag`,
        consequences: on
          ? [
              `The signed channel feed marks ${c}'s pointer release as a critical update.`,
              ...(action.channel.pointer
                ? []
                : [
                    `${c} has no pointer yet, so nothing is marked until it has one.`,
                  ]),
            ]
          : [
              `The signed channel feed stops marking ${c}'s pointer release as critical.`,
            ],
        confirmLabel: on ? "Mark critical" : "Clear critical",
        done: on ? `${c} is marked critical` : `${c} is no longer critical`,
      };
    }
    case "revert": {
      const c = action.channel.channel;
      return {
        title: `Revert ${c} to manifest`,
        consequences: [
          `Nothing changes now: ${c} keeps its pointer, pin, minimum and critical flag.`,
          "The manifest's declaration re-applies on the next resync, which may then overwrite them.",
        ],
        confirmLabel: "Revert to manifest",
        done: `${c} follows the manifest again`,
      };
    }
    case "packFloor": {
      const c = action.channel.channel;
      const line = input.contentApi;
      const lineOk = /^\d+$/.test(line) && Number(line) >= 1;
      return {
        title: clear
          ? `Clear ${action.channel.deliverable}'s floor for contentApi ${line} on ${c}`
          : `Set ${action.channel.deliverable}'s floor for contentApi ${line || "…"} on ${c}`,
        consequences: clear
          ? [
              `Devices on contentApi ${line} take any compatible ${action.channel.deliverable} release again.`,
            ]
          : [
              `Devices on contentApi ${line || "this line"} running a ${action.channel.deliverable} release below ${text || "the floor"} are moved to a newer one.`,
              "Other content API lines are unaffected.",
            ],
        confirmLabel: clear ? "Clear floor" : "Set floor",
        done: clear
          ? `Cleared the contentApi ${line} floor on ${c}`
          : `${action.channel.deliverable} needs ${text} or newer on contentApi ${line}`,
        error: !lineOk ? BAD_LINE : !clear && !text ? NO_VERSION : undefined,
      };
    }
    case "lowerFloor": {
      const c = action.channel;
      return {
        title: `Lower ${c}'s rollback floor`,
        consequences: [
          `${c} is floored at ${action.floor.version}: a sync never lets it move below the highest version it has seen.`,
          `Lowering it lets ${c} serve releases down to ${text || "the new floor"}; lower it only if the newer release is gone for good.`,
          "A later sync raises it again when it sees a newer release.",
        ],
        confirmLabel: "Lower floor",
        done: `Lowered ${c}'s floor to ${text}`,
        error: !text
          ? NO_VERSION
          : !isValidVersion(text)
            ? BAD_VERSION
            : undefined,
      };
    }
    case "clearFloor": {
      const c = action.channel;
      return {
        title: `Clear ${c}'s rollback floor`,
        consequences: [
          `${c} is floored at ${action.floor.version}.`,
          `Clearing it lets ${c} resolve to any release again, older ones included, until the next sync records a new floor.`,
        ],
        confirmLabel: "Clear floor",
        done: `Cleared ${c}'s floor`,
      };
    }
    case "yank": {
      const v = action.release.version;
      return {
        title: `Yank ${v}`,
        consequences: [
          `${v} stops being offered on every moving channel, on every platform; each falls back to the newest release it may still serve.`,
          `${v} resolves only through an explicit pin or a request for exactly ${v}.`,
          "Devices that already installed it are not moved off it.",
        ],
        confirmLabel: `Yank ${v}`,
        done: `Yanked ${v}`,
        error: text ? undefined : "Enter a reason for the yank.",
      };
    }
    case "unyank": {
      const v = action.release.version;
      return {
        title: `Unyank ${v}`,
        consequences: [
          `${v} becomes eligible again on every channel it is a member of.`,
        ],
        confirmLabel: `Unyank ${v}`,
        done: `Lifted the yank on ${v}`,
      };
    }
  }
}

/** The one request each action sends (worker `release/admin.ts`, `release/policy.ts`). */
async function run(
  slug: string,
  action: PolicyAction,
  input: {
    channel: string;
    releaseId: string;
    text: string;
    clear: boolean;
    contentApi: number;
  },
): Promise<unknown> {
  switch (action.kind) {
    case "promote":
      return mutate("updateReleaseChannel", slug, input.channel, {
        deliverable: action.deliverable,
        pointer: input.releaseId,
      });
    case "pin":
      return mutate("updateReleaseChannel", slug, input.channel, {
        deliverable: action.deliverable,
        pointer: input.releaseId,
        pinned: true,
      });
    case "unpin":
      return mutate("updateReleaseChannel", slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        pinned: false,
      });
    case "minSupported":
      return mutate("updateReleaseChannel", slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        minSupported: input.clear ? null : input.text,
      });
    case "critical":
      return mutate("updateReleaseChannel", slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        critical: !action.channel.critical,
      });
    case "revert":
      return mutate(
        "revertReleaseChannel",
        slug,
        action.channel.channel,
        action.channel.deliverable,
      );
    case "packFloor":
      return mutate("updateReleaseChannel", slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        contentApi: input.contentApi,
        minSupported: input.clear ? null : input.text,
      });
    case "lowerFloor":
      return mutate("setChannelFloor", slug, action.channel, {
        version: input.text,
      });
    case "clearFloor":
      return mutate("setChannelFloor", slug, action.channel, { clear: true });
    case "yank":
      return mutate("yankRelease", slug, action.release.releaseId, input.text);
    case "unyank":
      return mutate("unyankRelease", slug, action.release.releaseId);
  }
}
