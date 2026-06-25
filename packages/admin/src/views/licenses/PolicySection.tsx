import * as React from "react";
import { api, type LicenseDetail, type PatchLicenseBody } from "../../api.js";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, useToast } from "../../components/ui/index.js";
import { ChannelMultiSelect } from "./shared.js";

/**
 * The channel & version policy editor. An admin picks which release channels this license may
 * receive (a subset of stable/beta/staging/pr) and an optional version floor/ceiling; submitting
 * PATCHes the license. Diffs against the loaded values so an unchanged form is a no-op.
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
  const [channels, setChannels] = React.useState<string[]>(license.channels);
  const [minVersion, setMinVersion] = React.useState(license.minVersion ?? "");
  const [maxVersion, setMaxVersion] = React.useState(license.maxVersion ?? "");
  const [saving, setSaving] = React.useState(false);

  // Re-seed from a fresh license after a save invalidates + reloads.
  React.useEffect(() => {
    setChannels(license.channels);
    setMinVersion(license.minVersion ?? "");
    setMaxVersion(license.maxVersion ?? "");
  }, [license]);

  const dirty =
    JSON.stringify([...channels].sort()) !== JSON.stringify([...license.channels].sort()) ||
    minVersion !== (license.minVersion ?? "") ||
    maxVersion !== (license.maxVersion ?? "");

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
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
      toast.error("Could not update policy", err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel &amp; version policy</CardTitle>
        <CardDescription>Control which release channels and versions this license may receive.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-5">
          <Field label="Release channels" help="Devices on this license may update from the selected channels.">
            <div>
              <ChannelMultiSelect value={channels} onChange={setChannels} idPrefix="policy-channel" />
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Minimum version" help="Lowest version allowed. Leave blank for no floor.">
              <Input value={minVersion} onChange={(e) => setMinVersion(e.target.value)} placeholder="e.g. 1.2.0" />
            </Field>
            <Field label="Maximum version" help="Highest version allowed. Leave blank for no ceiling.">
              <Input value={maxVersion} onChange={(e) => setMaxVersion(e.target.value)} placeholder="e.g. 2.0.0" />
            </Field>
          </div>
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
