import * as React from "react";
import type { TierBody, TierSummary } from "../../api.js";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/index.js";

/**
 * The known release channels a tier may grant. The wire accepts an arbitrary string list, but
 * surfacing a fixed, accessible checklist keeps the editor honest and discoverable. Stable + the
 * "stable + beta" path are the common shapes; the list mirrors the worker's channel vocabulary.
 */
export const CHANNELS = ["stable", "beta", "alpha", "nightly", "internal"] as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface ProfileOption {
  id: string;
  name: string;
}

/** Coerce a possibly-empty numeric input to a defined number or undefined ("no policy"). */
function toNumber(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const NONE = "__none__";

/** Shared policy + version-window fields used by both the create and edit dialogs. */
function PolicyFields({
  expiry,
  setExpiry,
  machines,
  setMachines,
  minVersion,
  setMinVersion,
  maxVersion,
  setMaxVersion,
}: {
  expiry: string;
  setExpiry: (v: string) => void;
  machines: string;
  setMachines: (v: string) => void;
  minVersion: string;
  setMinVersion: (v: string) => void;
  maxVersion: string;
  setMaxVersion: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Expiry (days)" help="License lifetime granted by this tier. Blank = product default.">
        <Input
          type="number"
          min={1}
          inputMode="numeric"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          placeholder="default"
        />
      </Field>
      <Field label="Machine limit" help="Activations allowed per license. Blank = product default.">
        <Input
          type="number"
          min={1}
          inputMode="numeric"
          value={machines}
          onChange={(e) => setMachines(e.target.value)}
          placeholder="default"
        />
      </Field>
      <Field label="Min version" help="Lowest app version this tier may run. Blank = no floor.">
        <Input value={minVersion} onChange={(e) => setMinVersion(e.target.value)} placeholder="e.g. 1.0.0" />
      </Field>
      <Field label="Max version" help="Highest app version this tier may run. Blank = no ceiling.">
        <Input value={maxVersion} onChange={(e) => setMaxVersion(e.target.value)} placeholder="e.g. 2.0.0" />
      </Field>
    </div>
  );
}

/** An accessible channels checklist (labelled group of checkboxes). */
function ChannelPicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (channel: string, on: boolean) => void;
}): React.ReactElement {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium leading-none text-foreground">Channels</legend>
      <p className="text-xs text-muted-foreground">Release channels this tier may receive updates from.</p>
      <div className="flex flex-wrap gap-3 pt-1">
        {CHANNELS.map((channel) => {
          const id = `tier-channel-${channel}`;
          const on = selected.includes(channel);
          return (
            <label key={channel} htmlFor={id} className="flex items-center gap-2 text-sm">
              <Checkbox id={id} checked={on} onCheckedChange={(c) => onToggle(channel, c === true)} />
              {channel}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ── create ─────────────────────────────────────────────────────────────────────

export function CreateTierDialog({
  open,
  onOpenChange,
  profiles,
  existingIds,
  saving,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: ProfileOption[];
  existingIds: string[];
  saving: boolean;
  onCreate: (body: TierBody) => void;
}): React.ReactElement {
  const [id, setId] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [profile, setProfile] = React.useState<string>(NONE);
  const [expiry, setExpiry] = React.useState("");
  const [machines, setMachines] = React.useState("");
  const [minVersion, setMinVersion] = React.useState("");
  const [maxVersion, setMaxVersion] = React.useState("");
  const [channels, setChannels] = React.useState<string[]>([]);

  // Reset the form each time the dialog (re)opens.
  React.useEffect(() => {
    if (open) {
      setId("");
      setLabel("");
      setProfile(NONE);
      setExpiry("");
      setMachines("");
      setMinVersion("");
      setMaxVersion("");
      setChannels([]);
    }
  }, [open]);

  const trimmedId = id.trim();
  const idTaken = existingIds.includes(trimmedId);
  const idError = trimmedId === "" ? undefined : !ID_PATTERN.test(trimmedId)
    ? "Lowercase letters, digits, '-' and '_' only."
    : idTaken
      ? "A tier with this id already exists."
      : undefined;
  const canSubmit = trimmedId !== "" && !idError && !saving;

  const submit = (): void => {
    if (!canSubmit) return;
    const body: TierBody = { id: trimmedId };
    if (label.trim()) body.label = label.trim();
    if (profile !== NONE) body.profile = profile;
    const e = toNumber(expiry);
    if (e !== undefined) body.policyExpiryDays = e;
    const m = toNumber(machines);
    if (m !== undefined) body.policyMachineLimit = m;
    if (channels.length) body.channels = channels;
    if (minVersion.trim()) body.minVersion = minVersion.trim();
    if (maxVersion.trim()) body.maxVersion = maxVersion.trim();
    onCreate(body);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        onEscapeKeyDown={(e) => saving && e.preventDefault()}
        onInteractOutside={(e) => saving && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>New tier</DialogTitle>
          <DialogDescription>Tiers bundle a profile and license policies under a stable id.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Id" required error={idError} help="Stable, immutable identifier.">
              <Input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="pro"
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Label" help="Human-friendly name shown in the console.">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Pro" />
            </Field>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-tier-profile">Profile</Label>
            <Select value={profile} onValueChange={setProfile}>
              <SelectTrigger id="create-tier-profile" aria-label="Profile">
                <SelectValue placeholder="No profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No profile</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name || p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">The managed payload applied to licenses on this tier.</p>
          </div>

          <PolicyFields
            expiry={expiry}
            setExpiry={setExpiry}
            machines={machines}
            setMachines={setMachines}
            minVersion={minVersion}
            setMinVersion={setMinVersion}
            maxVersion={maxVersion}
            setMaxVersion={setMaxVersion}
          />

          <ChannelPicker
            selected={channels}
            onToggle={(channel, on) =>
              setChannels((prev) => (on ? [...prev, channel] : prev.filter((c) => c !== channel)))
            }
          />

          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!canSubmit}>
              Create tier
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── edit ───────────────────────────────────────────────────────────────────────

export function EditTierDialog({
  tier,
  open,
  onOpenChange,
  profiles,
  saving,
  onSave,
}: {
  tier: TierSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: ProfileOption[];
  saving: boolean;
  onSave: (id: string, body: TierBody) => void;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [profile, setProfile] = React.useState<string>(NONE);
  const [expiry, setExpiry] = React.useState("");
  const [machines, setMachines] = React.useState("");
  const [minVersion, setMinVersion] = React.useState("");
  const [maxVersion, setMaxVersion] = React.useState("");
  const [channels, setChannels] = React.useState<string[]>([]);

  // Seed the form from the tier whenever the dialog opens for a (new) tier.
  React.useEffect(() => {
    if (open && tier) {
      setLabel(tier.label ?? "");
      setProfile(tier.profile ?? NONE);
      setExpiry(tier.policyExpiryDays == null ? "" : String(tier.policyExpiryDays));
      setMachines(tier.policyMachineLimit == null ? "" : String(tier.policyMachineLimit));
      setMinVersion(tier.minVersion ?? "");
      setMaxVersion(tier.maxVersion ?? "");
      setChannels(tier.channels ?? []);
    }
  }, [open, tier]);

  if (!tier) return <Dialog open={open} onOpenChange={onOpenChange} />;

  const submit = (): void => {
    if (saving) return;
    const body: TierBody = {
      label: label.trim(),
      profile: profile === NONE ? "" : profile,
      policyExpiryDays: toNumber(expiry),
      policyMachineLimit: toNumber(machines),
      channels,
      minVersion: minVersion.trim() === "" ? null : minVersion.trim(),
      maxVersion: maxVersion.trim() === "" ? null : maxVersion.trim(),
    };
    onSave(tier.id, body);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        onEscapeKeyDown={(e) => saving && e.preventDefault()}
        onInteractOutside={(e) => saving && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Edit tier</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <Badge variant="outline">{tier.id}</Badge>
            <span>The id is immutable.</span>
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Label" help="Human-friendly name shown in the console.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={tier.id} autoFocus />
          </Field>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-tier-profile">Profile</Label>
            <Select value={profile} onValueChange={setProfile}>
              <SelectTrigger id="edit-tier-profile" aria-label="Profile">
                <SelectValue placeholder="No profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No profile</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name || p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <PolicyFields
            expiry={expiry}
            setExpiry={setExpiry}
            machines={machines}
            setMachines={setMachines}
            minVersion={minVersion}
            setMinVersion={setMinVersion}
            maxVersion={maxVersion}
            setMaxVersion={setMaxVersion}
          />

          <ChannelPicker
            selected={channels}
            onToggle={(channel, on) =>
              setChannels((prev) => (on ? [...prev, channel] : prev.filter((c) => c !== channel)))
            }
          />

          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
