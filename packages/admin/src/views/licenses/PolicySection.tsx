import * as React from "react";
import { api, type LicenseDetail, type PatchLicenseBody } from "../../api.js";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  useToast,
} from "../../components/ui/index.js";
import { ChannelMultiSelect, useManualChannels } from "./shared.js";

/**
 * The channel & version policy editor. An admin picks which release channels this license may
 * receive (the canonical stable/beta/pr, the product's manual channels, and any legacy grant the
 * license already holds, labelled) and an optional version floor/ceiling; submitting PATCHes the
 * license. Diffs against the loaded values so an unchanged form is a no-op.
 */
export function PolicySection({
  slug,
  license,
  onSaved,
}: {
  slug: string;
  license: LicenseDetail;
  onSaved: () => void;
}): React.ReactElement {
  const toast = useToast();
  const manualChannels = useManualChannels(slug);
  const [channels, setChannels] = React.useState<string[]>(license.channels);
  const [minVersion, setMinVersion] = React.useState(license.minVersion ?? "");
  const [maxVersion, setMaxVersion] = React.useState(license.maxVersion ?? "");
  const [versionError, setVersionError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Re-seed from a fresh license after a save invalidates + reloads.
  React.useEffect(() => {
    setChannels(license.channels);
    setMinVersion(license.minVersion ?? "");
    setMaxVersion(license.maxVersion ?? "");
    setVersionError(null);
  }, [license]);

  const dirty =
    JSON.stringify([...channels].sort()) !==
      JSON.stringify([...license.channels].sort()) ||
    minVersion !== (license.minVersion ?? "") ||
    maxVersion !== (license.maxVersion ?? "");

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (compareDottedVersion(minVersion.trim(), maxVersion.trim()) > 0) {
      setVersionError("Minimum version must be lower than maximum version.");
      return;
    }
    setSaving(true);
    try {
      const body: PatchLicenseBody = {
        channels,
        minVersion: minVersion.trim() || null,
        maxVersion: maxVersion.trim() || null,
      };
      await api.patchLicense(slug, license.id, body);
      toast.success("Policy updated");
      onSaved();
    } catch (err) {
      toast.error(
        "Could not update policy",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel &amp; version policy</CardTitle>
        <CardDescription>
          Control which release channels and versions this license may receive.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-5" noValidate>
          <Field
            label="Release channels"
            help="Devices on this license may update from the selected channels."
          >
            <div>
              <ChannelMultiSelect
                value={channels}
                onChange={setChannels}
                manual={manualChannels}
                held={license.channels}
                idPrefix="policy-channel"
              />
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Minimum version"
              help="Lowest version allowed. Leave blank for no floor."
              error={versionError}
            >
              <Input
                value={minVersion}
                onChange={(e) => {
                  setMinVersion(e.target.value);
                  setVersionError(null);
                }}
                placeholder="e.g. 1.2.0"
              />
            </Field>
            <Field
              label="Maximum version"
              help="Highest version allowed. Leave blank for no ceiling."
            >
              <Input
                value={maxVersion}
                onChange={(e) => {
                  setMaxVersion(e.target.value);
                  setVersionError(null);
                }}
                placeholder="e.g. 2.0.0"
              />
            </Field>
          </div>
          <PolicySummary
            channels={channels}
            minVersion={minVersion}
            maxVersion={maxVersion}
          />
          <div className="flex justify-end">
            <Button type="submit" loading={saving} disabled={!dirty}>
              Save policy
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PolicySummary({
  channels,
  minVersion,
  maxVersion,
}: {
  channels: string[];
  minVersion: string;
  maxVersion: string;
}): React.ReactElement {
  const version =
    minVersion.trim() || maxVersion.trim()
      ? `${minVersion.trim() || "any"} to ${maxVersion.trim() || "any"}`
      : "Product compatibility window";
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        Effective update policy
      </p>
      <p className="mt-2">
        Channels:{" "}
        <span className="font-medium">
          {channels.length ? channels.join(", ") : "default"}
        </span>
      </p>
      <p>
        Versions: <span className="font-medium">{version}</span>
      </p>
    </div>
  );
}

function compareDottedVersion(a: string, b: string): number {
  const parse = (value: string): number[] | null => {
    if (!value || !/^\d+(?:\.\d+)*$/.test(value)) return null;
    return value.split(".").map((part) => Number(part));
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
