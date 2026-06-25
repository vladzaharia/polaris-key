import * as React from "react";
import { api, type LicenseDetail, type PatchLicenseBody } from "../../api.js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  useToast,
} from "../../components/ui/index.js";
import { dateInputToEpoch, epochToDateInput } from "./shared.js";

/**
 * Edit a license's core metadata (name / email / expiry / max offline days) via `patch`. Only
 * the changed fields are sent. Expiry uses a date input mapped to epoch seconds (blank ⇒ clears
 * the expiry by sending null).
 */
export function EditMetadataDialog({
  slug,
  license,
  open,
  onOpenChange,
  onSaved,
}: {
  slug: string;
  license: LicenseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [name, setName] = React.useState(license.name);
  const [email, setEmail] = React.useState(license.email);
  const [expires, setExpires] = React.useState(
    epochToDateInput(license.expiresAt),
  );
  const [maxOffline, setMaxOffline] = React.useState(
    license.maxOfflineDays == null ? "" : String(license.maxOfflineDays),
  );
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(license.name);
      setEmail(license.email);
      setExpires(epochToDateInput(license.expiresAt));
      setMaxOffline(
        license.maxOfflineDays == null ? "" : String(license.maxOfflineDays),
      );
      setSaving(false);
    }
  }, [open, license]);

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      const body: PatchLicenseBody = {};
      if (name.trim() !== license.name) body.name = name.trim();
      if (email.trim() !== license.email) body.email = email.trim();
      const nextExpiry = dateInputToEpoch(expires);
      if (nextExpiry !== (license.expiresAt ?? null))
        body.expiresAt = nextExpiry;
      const nextOffline =
        maxOffline.trim() === "" ? undefined : Number(maxOffline);
      if (nextOffline !== undefined && nextOffline !== license.maxOfflineDays)
        body.maxOfflineDays = nextOffline;

      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }
      await api.patchLicense(slug, license.id, body);
      toast.success("License updated");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(
        "Could not update license",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit license</DialogTitle>
          <DialogDescription>
            Update the holder details, expiry, and offline grace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Expires" help="Blank means no expiry.">
              <Input
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </Field>
            <Field
              label="Max offline days"
              help="How long a device may run without checking in."
            >
              <Input
                type="number"
                min={0}
                value={maxOffline}
                onChange={(e) => setMaxOffline(e.target.value)}
                placeholder="e.g. 14"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
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
