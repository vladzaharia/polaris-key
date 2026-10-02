import * as React from "react";
import type {
  ChannelPolicyDto,
  ReleaseChannelFloorDto,
  ReleaseDto,
} from "../../api.js";
import { api, releasePolicyMessage } from "../../api.js";
import { invalidate } from "../../context.js";
import { docsUrl } from "../../lib/docsLinks.js";
import {
  ConfirmDialog,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
  type ButtonProps,
} from "../../components/ui/index.js";

/**
 * Every operator change to release policy the console can make (P2-05's admin routes), one
 * confirmation each. The dialog states the EFFECT before anything is sent, and the effect is
 * worded from what P2-05 and the signed feed (P3-03) implement — never more.
 *
 * Confirm, toast and error handling are `ResyncButton`'s: the dialog stays open and busy while
 * the request runs, success toasts and refreshes every reader of the release store, and a
 * refusal toasts the console's wording for its `reason` (`RELEASE_POLICY_ERROR_MESSAGES`).
 */
export type PolicyAction =
  | { kind: "promote"; channel: ChannelPolicyDto }
  | { kind: "pin"; channel: ChannelPolicyDto }
  | { kind: "unpin"; channel: ChannelPolicyDto }
  | { kind: "minSupported"; channel: ChannelPolicyDto }
  | { kind: "critical"; channel: ChannelPolicyDto }
  | { kind: "revert"; channel: ChannelPolicyDto }
  /** The anti-rollback floor is keyed by channel name alone (P0-02): a floor can outlive the
   *  channel's policy row (a stranded floor), so these name the channel, not its policy. */
  | { kind: "lowerFloor"; channel: string; floor: ReleaseChannelFloorDto }
  | { kind: "clearFloor"; channel: string; floor: ReleaseChannelFloorDto }
  | { kind: "yank"; release: ReleaseDto }
  | { kind: "unyank"; release: ReleaseDto };

/** The cache keys a policy change can move: the store, the channels and release health. */
export function invalidateReleaseViews(slug: string): void {
  invalidate(`releases:${slug}`);
  invalidate(`release-channels:${slug}`);
  invalidate(`release-health:${slug}`);
}

export function PolicyActionDialog({
  slug,
  action,
  releases,
  onClose,
}: {
  slug: string;
  /** `null` = closed. */
  action: PolicyAction | null;
  /** The store's releases, for the pickers and for naming a release by its version. */
  releases: ReleaseDto[];
  onClose: () => void;
}): React.ReactElement | null {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [releaseId, setReleaseId] = React.useState("");
  const [text, setText] = React.useState("");

  // Each opening starts from the action's own defaults, never from the previous dialog's input.
  // Keyed on the action alone: a store refresh while the dialog is open must not reset the input.
  const releasesRef = React.useRef(releases);
  releasesRef.current = releases;
  React.useEffect(() => {
    if (!action) return;
    const releases = releasesRef.current;
    setText(
      action.kind === "minSupported" ? (action.channel.minSupported ?? "") : "",
    );
    if (action.kind === "promote" || action.kind === "pin") {
      const options = pickable(action, releases);
      const current = options.find(
        (r) => r.releaseId === action.channel.pointer,
      );
      setReleaseId((current ?? options[0])?.releaseId ?? "");
    } else {
      setReleaseId("");
    }
  }, [action]);

  const versionOf = (id: string | null): string =>
    id === null
      ? "—"
      : (releases.find((r) => r.releaseId === id)?.version ?? id);

  if (!action) return null;

  const spec = describe(action, { releaseId, text, versionOf });

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await run(slug, action, { releaseId, text });
      toast.success(spec.done);
      invalidateReleaseViews(slug);
      onClose();
    } catch (err) {
      toast.error(spec.failed, releasePolicyMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !busy && !next && onClose()}
      title={spec.title}
      description={spec.description}
      confirmLabel={spec.confirmLabel}
      confirmVariant={spec.variant}
      confirmDisabled={!spec.ready}
      loading={busy}
      onConfirm={confirm}
    >
      {action.kind === "promote" || action.kind === "pin" ? (
        <ReleasePicker
          value={releaseId}
          onChange={setReleaseId}
          options={pickable(action, releases)}
        />
      ) : null}
      {action.kind === "yank" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="yank-reason">Reason (required)</Label>
          <Textarea
            id="yank-reason"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            placeholder="crashes on launch on Android 14"
            aria-invalid={text.trim() ? undefined : true}
            aria-describedby="yank-reason-help"
          />
          <p id="yank-reason-help" className="text-xs text-muted-foreground">
            Recorded with the yank and shown beside the release. A yank without
            a reason is refused.
          </p>
        </div>
      ) : null}
      {action.kind === "minSupported" || action.kind === "lowerFloor" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-version">
            {action.kind === "minSupported"
              ? "Minimum supported version"
              : "Lower the floor to"}
          </Label>
          <Input
            id="policy-version"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              action.kind === "minSupported" ? "empty to remove" : "1.0.0"
            }
            className="font-mono"
          />
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

function ReleasePicker({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (id: string) => void;
  options: ReleaseDto[];
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="policy-release">Release</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="policy-release" aria-label="Release">
          <SelectValue placeholder="Choose a release" />
        </SelectTrigger>
        <SelectContent>
          {options.map((r) => (
            <SelectItem key={r.releaseId} value={r.releaseId}>
              {r.version}
              {r.yank ? " (yanked)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The releases a promote or pin may name: the channel's deliverable's, newest first. A yanked
 * release cannot be promoted (the CI route refuses it with `release_yanked`) but may be pinned —
 * a pin is the only way a yanked release is served.
 */
function pickable(
  action: Extract<PolicyAction, { kind: "promote" | "pin" }>,
  releases: ReleaseDto[],
): ReleaseDto[] {
  return releases
    .filter((r) => r.deliverable === action.channel.deliverable)
    .filter((r) => action.kind === "pin" || !r.yank)
    .sort(
      (a, b) =>
        (b.seq ?? 0) - (a.seq ?? 0) ||
        (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
    );
}

interface Spec {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  variant: ButtonProps["variant"];
  ready: boolean;
  done: string;
  failed: string;
}

function describe(
  action: PolicyAction,
  input: {
    releaseId: string;
    text: string;
    versionOf: (id: string | null) => string;
  },
): Spec {
  const { releaseId, text, versionOf } = input;
  const picked = versionOf(releaseId || null);
  switch (action.kind) {
    case "promote": {
      const c = action.channel.channel;
      return {
        title: `Promote a release to ${c}?`,
        description: action.channel.pinned
          ? `${c} is pinned, so the pin moves to ${picked}: every platform that has a build serves ${picked}, and newer releases stay ignored until you unpin.`
          : `${picked} becomes a member of ${c}. ${c} still serves its newest eligible release on each platform, so this changes what a platform gets only where ${picked} is newer than what it serves now.`,
        confirmLabel: "Promote",
        variant: "primary",
        ready: !!releaseId,
        done: `Promoted ${picked} to ${c}`,
        failed: "Promote failed",
      };
    }
    case "pin": {
      const c = action.channel.channel;
      return {
        title: `Pin ${c}?`,
        description: (
          <>
            {c} will serve {picked} on every platform that has a build; newer
            releases are ignored until you unpin. A platform without a {picked}{" "}
            build gets the newest older release that has one.
          </>
        ),
        confirmLabel: "Pin",
        variant: "primary",
        ready: !!releaseId,
        done: `Pinned ${c} to ${picked}`,
        failed: "Pin failed",
      };
    }
    case "unpin": {
      const c = action.channel.channel;
      return {
        title: `Unpin ${c}?`,
        description: `${c} goes back to serving its newest eligible release on each platform. ${versionOf(action.channel.pointer)} stays a member of ${c}.`,
        confirmLabel: "Unpin",
        variant: "primary",
        ready: true,
        done: `Unpinned ${c}`,
        failed: "Unpin failed",
      };
    }
    case "minSupported": {
      const c = action.channel.channel;
      const v = text.trim();
      return {
        title: `Set ${c}'s minimum supported version?`,
        description: v
          ? `Devices on ${c} running a version below ${v} are asked to update: the signed channel feed carries ${v} as its floor.`
          : `${c} will have no minimum supported version; the signed channel feed stops asking older devices to update on its account.`,
        confirmLabel: v ? "Set minimum" : "Remove minimum",
        variant: "primary",
        ready: v !== (action.channel.minSupported ?? ""),
        done: v
          ? `${c} requires ${v} or newer`
          : `Removed ${c}'s minimum supported version`,
        failed: "Couldn’t set the minimum supported version",
      };
    }
    case "critical": {
      const c = action.channel.channel;
      const on = !action.channel.critical;
      return {
        title: on ? `Mark ${c} critical?` : `Clear ${c}'s critical flag?`,
        description: on
          ? `The signed channel feed marks ${c}'s pointer release as a critical update.${action.channel.pointer ? "" : ` ${c} has no pointer yet, so nothing is marked until it has one.`}`
          : `The signed channel feed stops marking ${c}'s pointer release as critical.`,
        confirmLabel: on ? "Mark critical" : "Clear critical",
        variant: on ? "destructive" : "primary",
        ready: true,
        done: on ? `${c} is marked critical` : `${c} is no longer critical`,
        failed: "Couldn’t change the critical flag",
      };
    }
    case "revert": {
      const c = action.channel.channel;
      return {
        title: `Hand ${c} back to the manifest?`,
        description: (
          <>
            Nothing changes now: {c} keeps its current pointer, pin, minimum and
            critical flag. The manifest’s declaration re-applies on the next
            resync, which may then overwrite them.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("releaseChannels")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </>
        ),
        confirmLabel: "Revert to manifest",
        variant: "primary",
        ready: true,
        done: `${c} follows the manifest again`,
        failed: "Couldn’t revert to the manifest",
      };
    }
    case "lowerFloor": {
      const c = action.channel;
      return {
        title: `Lower ${c}'s rollback floor?`,
        description: `${c} is floored at ${action.floor.version}: a sync never lets it move below the highest version it has seen. Lower it if that release is gone for good. It can only be lowered here; a later sync raises it again when it sees a newer release.`,
        confirmLabel: "Lower floor",
        variant: "destructive",
        ready: text.trim().length > 0,
        done: `Lowered ${c}'s floor to ${text.trim()}`,
        failed: "Couldn’t lower the floor",
      };
    }
    case "clearFloor": {
      const c = action.channel;
      return {
        title: `Clear ${c}'s rollback floor?`,
        description: `${c} is floored at ${action.floor.version}. Clearing it lets ${c} resolve to any release again until the next sync records a new floor.`,
        confirmLabel: "Clear floor",
        variant: "destructive",
        ready: true,
        done: `Cleared ${c}'s floor`,
        failed: "Couldn’t clear the floor",
      };
    }
    case "yank": {
      const v = action.release.version;
      return {
        title: `Yank ${v}?`,
        description: `${v} stops being offered on every moving channel (stable, beta, …) on every platform; each falls back to the newest release it still may serve. It resolves only through an explicit pin or a request for exactly ${v}. Devices that already installed it are not moved off it.`,
        confirmLabel: "Yank",
        variant: "destructive",
        ready: text.trim().length > 0,
        done: `Yanked ${v}`,
        failed: "Yank failed",
      };
    }
    case "unyank": {
      const v = action.release.version;
      return {
        title: `Lift the yank on ${v}?`,
        description: `${v} becomes eligible again on every channel it is a member of.`,
        confirmLabel: "Unyank",
        variant: "primary",
        ready: true,
        done: `Lifted the yank on ${v}`,
        failed: "Unyank failed",
      };
    }
  }
}

/** The one request each action sends (worker `release/admin.ts`). */
async function run(
  slug: string,
  action: PolicyAction,
  input: { releaseId: string; text: string },
): Promise<unknown> {
  switch (action.kind) {
    case "promote":
      return api.updateReleaseChannel(slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        pointer: input.releaseId,
      });
    case "pin":
      return api.updateReleaseChannel(slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        pointer: input.releaseId,
        pinned: true,
      });
    case "unpin":
      return api.updateReleaseChannel(slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        pinned: false,
      });
    case "minSupported": {
      const v = input.text.trim();
      return api.updateReleaseChannel(slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        minSupported: v ? v : null,
      });
    }
    case "critical":
      return api.updateReleaseChannel(slug, action.channel.channel, {
        deliverable: action.channel.deliverable,
        critical: !action.channel.critical,
      });
    case "revert":
      return api.revertReleaseChannel(
        slug,
        action.channel.channel,
        action.channel.deliverable,
      );
    case "lowerFloor":
      return api.setChannelFloor(slug, action.channel, {
        version: input.text.trim(),
      });
    case "clearFloor":
      return api.setChannelFloor(slug, action.channel, { clear: true });
    case "yank":
      return api.yankRelease(slug, action.release.releaseId, input.text.trim());
    case "unyank":
      return api.unyankRelease(slug, action.release.releaseId);
  }
}
