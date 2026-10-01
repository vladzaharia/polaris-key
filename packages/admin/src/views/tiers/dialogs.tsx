import * as React from "react";
import type { TierBody, TierSummary } from "../../api.js";
import { docsUrl } from "../../lib/docsLinks.js";
import { ChannelMultiSelect } from "../licenses/shared.js";
import {
  Badge,
  Button,
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogContent,
  DialogDescription,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/index.js";

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
  devices,
  setDevices,
  minVersion,
  setMinVersion,
  maxVersion,
  setMaxVersion,
}: {
  expiry: string;
  setExpiry: (v: string) => void;
  devices: string;
  setDevices: (v: string) => void;
  minVersion: string;
  setMinVersion: (v: string) => void;
  maxVersion: string;
  setMaxVersion: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Expiry (days)"
        help="License lifetime granted by this tier. Blank = product default."
      >
        <Input
          type="number"
          min={1}
          inputMode="numeric"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          placeholder="default"
        />
      </Field>
      <Field
        label="Device limit"
        help="Activations allowed per license. Blank = product default."
      >
        <Input
          type="number"
          min={1}
          inputMode="numeric"
          value={devices}
          onChange={(e) => setDevices(e.target.value)}
          placeholder="default"
        />
      </Field>
      <Field
        label="Min version"
        help="Lowest app version this tier may run. Blank = no floor."
      >
        <Input
          value={minVersion}
          onChange={(e) => setMinVersion(e.target.value)}
          placeholder="e.g. 1.0.0"
        />
      </Field>
      <Field
        label="Max version"
        help="Highest app version this tier may run. Blank = no ceiling."
      >
        <Input
          value={maxVersion}
          onChange={(e) => setMaxVersion(e.target.value)}
          placeholder="e.g. 2.0.0"
        />
      </Field>
    </div>
  );
}

/**
 * The tier's channels: the same picker the licence editors use (WIRE-CONTRACT-V3 §5.1), so a
 * tier offers the canonical channels and the product's manual channels, shows a legacy grant it
 * already holds with its label, and keeps any value the picker does not offer.
 */
function ChannelPicker({
  selected,
  onChange,
  manual,
  held,
  idPrefix,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  manual: readonly string[];
  held: readonly string[];
  idPrefix: string;
}): React.ReactElement {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium leading-none text-foreground">
        Channels
      </legend>
      <p className="text-xs text-muted-foreground">
        Release channels this tier may receive updates from.
      </p>
      <div className="pt-1">
        <ChannelMultiSelect
          value={selected}
          onChange={onChange}
          manual={manual}
          held={held}
          idPrefix={idPrefix}
        />
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
  manualChannels = [],
  saving,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: ProfileOption[];
  existingIds: string[];
  /** The product's declared channel names, for the channel picker. */
  manualChannels?: readonly string[];
  saving: boolean;
  onCreate: (body: TierBody) => void;
}): React.ReactElement {
  const [id, setId] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [profile, setProfile] = React.useState<string>(NONE);
  const [expiry, setExpiry] = React.useState("");
  const [devices, setDevices] = React.useState("");
  const [minVersion, setMinVersion] = React.useState("");
  const [maxVersion, setMaxVersion] = React.useState("");
  const [channels, setChannels] = React.useState<string[]>([]);
  const [activeTab, setActiveTab] = React.useState("basics");

  // Reset the form each time the dialog (re)opens.
  React.useEffect(() => {
    if (open) {
      setId("");
      setLabel("");
      setProfile(NONE);
      setExpiry("");
      setDevices("");
      setMinVersion("");
      setMaxVersion("");
      setChannels([]);
      setActiveTab("basics");
    }
  }, [open]);

  const trimmedId = id.trim();
  const idTaken = existingIds.includes(trimmedId);
  const idError =
    trimmedId === ""
      ? undefined
      : !ID_PATTERN.test(trimmedId)
        ? "Lowercase letters, digits, '-' and '_' only."
        : idTaken
          ? "A tier with this id already exists."
          : undefined;
  const canSubmit = trimmedId !== "" && !idError && !saving;

  const submit = (): void => {
    if (!canSubmit) {
      setActiveTab("basics");
      return;
    }
    const body: TierBody = { id: trimmedId };
    if (label.trim()) body.label = label.trim();
    if (profile !== NONE) body.profile = profile;
    const e = toNumber(expiry);
    if (e !== undefined) body.policyExpiryDays = e;
    const m = toNumber(devices);
    if (m !== undefined) body.policyDeviceLimit = m;
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
          <DialogDescription>
            Tiers bundle a profile and license policies under a stable id.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("tierEditor")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full">
                <TabsTrigger value="basics" className="flex-1">
                  Basics
                </TabsTrigger>
                <TabsTrigger value="policy" className="flex-1">
                  Policy
                </TabsTrigger>
                <TabsTrigger value="channels" className="flex-1">
                  Channels
                </TabsTrigger>
              </TabsList>

              <TabsContent value="basics" className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Id"
                    required
                    error={idError}
                    help="Stable, immutable identifier."
                  >
                    <Input
                      value={id}
                      onChange={(e) => setId(e.target.value)}
                      placeholder="pro"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field
                    label="Label"
                    help="Human-friendly name shown in the console."
                  >
                    <Input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="Pro"
                    />
                  </Field>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="create-tier-profile">Profile</Label>
                  <Select value={profile} onValueChange={setProfile}>
                    <SelectTrigger
                      id="create-tier-profile"
                      aria-label="Profile"
                    >
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
                  <p className="text-xs text-muted-foreground">
                    The managed payload applied to licenses on this tier.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="policy">
                <PolicyFields
                  expiry={expiry}
                  setExpiry={setExpiry}
                  devices={devices}
                  setDevices={setDevices}
                  minVersion={minVersion}
                  setMinVersion={setMinVersion}
                  maxVersion={maxVersion}
                  setMaxVersion={setMaxVersion}
                />
              </TabsContent>

              <TabsContent value="channels">
                <ChannelPicker
                  selected={channels}
                  onChange={setChannels}
                  manual={manualChannels}
                  held={[]}
                  idPrefix="create-tier-channel"
                />
              </TabsContent>
            </Tabs>
          </DialogBody>

          <DialogActionBar>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!canSubmit}>
              Create tier
            </Button>
          </DialogActionBar>
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
  manualChannels = [],
  saving,
  onSave,
}: {
  tier: TierSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: ProfileOption[];
  /** The product's declared channel names, for the channel picker. */
  manualChannels?: readonly string[];
  saving: boolean;
  onSave: (id: string, body: TierBody) => void;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [profile, setProfile] = React.useState<string>(NONE);
  const [expiry, setExpiry] = React.useState("");
  const [devices, setDevices] = React.useState("");
  const [minVersion, setMinVersion] = React.useState("");
  const [maxVersion, setMaxVersion] = React.useState("");
  const [channels, setChannels] = React.useState<string[]>([]);
  const [activeTab, setActiveTab] = React.useState("basics");

  // Seed the form from the tier whenever the dialog opens for a (new) tier.
  React.useEffect(() => {
    if (open && tier) {
      setLabel(tier.label ?? "");
      setProfile(tier.profile ?? NONE);
      setExpiry(
        tier.policyExpiryDays == null ? "" : String(tier.policyExpiryDays),
      );
      setDevices(
        tier.policyDeviceLimit == null ? "" : String(tier.policyDeviceLimit),
      );
      setMinVersion(tier.minVersion ?? "");
      setMaxVersion(tier.maxVersion ?? "");
      setChannels(tier.channels ?? []);
      setActiveTab("basics");
    }
  }, [open, tier]);

  if (!tier) return <Dialog open={open} onOpenChange={onOpenChange} />;

  const submit = (): void => {
    if (saving) return;
    const body: TierBody = {
      label: label.trim(),
      profile: profile === NONE ? "" : profile,
      policyExpiryDays: toNumber(expiry),
      policyDeviceLimit: toNumber(devices),
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
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("tierEditor")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full">
                <TabsTrigger value="basics" className="flex-1">
                  Basics
                </TabsTrigger>
                <TabsTrigger value="policy" className="flex-1">
                  Policy
                </TabsTrigger>
                <TabsTrigger value="channels" className="flex-1">
                  Channels
                </TabsTrigger>
              </TabsList>

              <TabsContent value="basics" className="space-y-4">
                <Field
                  label="Label"
                  help="Human-friendly name shown in the console."
                >
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={tier.id}
                    autoFocus
                  />
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
              </TabsContent>

              <TabsContent value="policy">
                <PolicyFields
                  expiry={expiry}
                  setExpiry={setExpiry}
                  devices={devices}
                  setDevices={setDevices}
                  minVersion={minVersion}
                  setMinVersion={setMinVersion}
                  maxVersion={maxVersion}
                  setMaxVersion={setMaxVersion}
                />
              </TabsContent>

              <TabsContent value="channels">
                <ChannelPicker
                  selected={channels}
                  onChange={setChannels}
                  manual={manualChannels}
                  held={tier.channels ?? []}
                  idPrefix="edit-tier-channel"
                />
              </TabsContent>
            </Tabs>
          </DialogBody>

          <DialogActionBar>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
          </DialogActionBar>
        </form>
      </DialogContent>
    </Dialog>
  );
}
