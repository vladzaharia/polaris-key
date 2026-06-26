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
  const [fieldErrors, setFieldErrors] = React.useState<
    Partial<Record<"name" | "email" | "expires" | "maxOffline", string>>
  >({});
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(license.name);
      setEmail(license.email);
      setExpires(epochToDateInput(license.expiresAt));
      setMaxOffline(
        license.maxOfflineDays == null ? "" : String(license.maxOfflineDays),
      );
      setFieldErrors({});
      setSaving(false);
    }
  }, [open, license]);

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const nextErrors = validateMetadata({
      name,
      email,
      expires,
      maxOffline,
    });
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
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
            Update holder details, license expiry, and device offline grace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4" noValidate>
          <Field label="Name" error={fieldErrors.name}>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearFieldError(setFieldErrors, "name");
              }}
              autoFocus
            />
          </Field>
          <Field label="Email" error={fieldErrors.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearFieldError(setFieldErrors, "email");
              }}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Expires"
              help="Blank means no expiry."
              error={fieldErrors.expires}
            >
              <Input
                type="date"
                value={expires}
                onChange={(e) => {
                  setExpires(e.target.value);
                  clearFieldError(setFieldErrors, "expires");
                }}
              />
            </Field>
            <Field
              label="Max offline days"
              help="How long a device may run without checking in."
              error={fieldErrors.maxOffline}
            >
              <Input
                type="number"
                min={0}
                value={maxOffline}
                onChange={(e) => {
                  setMaxOffline(e.target.value);
                  clearFieldError(setFieldErrors, "maxOffline");
                }}
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

type MetadataErrors = Partial<
  Record<"name" | "email" | "expires" | "maxOffline", string>
>;

function validateMetadata(input: {
  name: string;
  email: string;
  expires: string;
  maxOffline: string;
}): MetadataErrors {
  const errors: MetadataErrors = {};
  if (!input.name.trim()) errors.name = "Enter the holder name.";
  if (!input.email.trim()) errors.email = "Enter the holder email.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))
    errors.email = "Enter a valid email address.";
  if (input.expires.trim() && dateInputToEpoch(input.expires) == null)
    errors.expires = "Use a valid expiry date.";
  if (input.maxOffline.trim()) {
    const value = Number(input.maxOffline);
    if (!Number.isInteger(value) || value < 0)
      errors.maxOffline = "Enter a whole number of days, 0 or higher.";
  }
  return errors;
}

function clearFieldError(
  setErrors: React.Dispatch<React.SetStateAction<MetadataErrors>>,
  field: keyof MetadataErrors,
): void {
  setErrors((prev) => {
    if (!prev[field]) return prev;
    const next = { ...prev };
    delete next[field];
    return next;
  });
}
