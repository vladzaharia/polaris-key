import * as React from "react";
import {
  api,
  type LicenseDetail,
  type PatchLicenseBody,
  type TierSummary,
} from "../../api.js";
import {
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from "../../components/ui/index.js";
import { dateInputToEpoch, epochToDateInput } from "./shared.js";

/** Radix Select has no empty-string item value, so "no tier" needs a sentinel. */
const NO_TIER = "__none__";

/**
 * Edit a license's core metadata (name / email / expiry / max offline days) via `patch`. Only
 * the changed fields are sent. Expiry uses a date input mapped to epoch seconds (blank ⇒ clears
 * the expiry by sending null).
 */
export function EditMetadataDialog({
  slug,
  license,
  tiers,
  deviceCount,
  open,
  onOpenChange,
  onSaved,
}: {
  slug: string;
  license: LicenseDetail;
  /** Tiers this license can be moved to. Changing tier IS the remote re-licensing action:
   *  running clients pick the new entitlements up on their next config refresh. */
  tiers?: TierSummary[];
  /** Active devices, used to warn before a downgrade that lands below the new tier's limit. */
  deviceCount?: number;
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
  const [tier, setTier] = React.useState(license.tier ?? "");
  const [activeTab, setActiveTab] = React.useState("holder");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(license.name);
      setEmail(license.email);
      setExpires(epochToDateInput(license.expiresAt));
      setMaxOffline(
        license.maxOfflineDays == null ? "" : String(license.maxOfflineDays),
      );
      setTier(license.tier ?? "");
      setFieldErrors({});
      setActiveTab("holder");
      setSaving(false);
    }
  }, [open, license]);

  const nextTierId = tier || null;
  const tierChanged = nextTierId !== (license.tier ?? null);
  const nextTier = tiers?.find((t) => t.id === nextTierId);
  // Grandfathering is the server's behaviour, not a warning we can act on — say so plainly
  // instead of letting the operator discover it by watching activations fail later.
  const downgradeWarning =
    tierChanged &&
    nextTier?.policyDeviceLimit != null &&
    nextTier.policyDeviceLimit > 0 &&
    deviceCount != null &&
    deviceCount > nextTier.policyDeviceLimit
      ? `${deviceCount} devices are active but ${nextTier.label} allows ${nextTier.policyDeviceLimit}. ` +
        "Existing devices keep working; new activations are refused until the count drops."
      : null;

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const nextErrors = validateMetadata({
      name,
      email,
      expires,
      maxOffline,
    });
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setActiveTab(nextErrors.name || nextErrors.email ? "holder" : "policy");
      return;
    }
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
      if (tierChanged) body.tier = nextTierId;

      if (Object.keys(body).length === 0) {
        onOpenChange(false);
        return;
      }
      const result = await api.patchLicense(slug, license.id, body);
      if (result.overLimit) {
        toast.success(
          "License updated",
          `${result.overLimit.deviceCount} devices are active but the new tier allows ` +
            `${result.overLimit.deviceLimit}. Existing devices keep working; new ` +
            "activations are refused until the count drops.",
        );
      } else if (tierChanged) {
        toast.success(
          "License updated",
          "Running clients pick up the new entitlements on their next config refresh.",
        );
      } else {
        toast.success("License updated");
      }
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
        <form onSubmit={save} className="contents" noValidate>
          <DialogBody>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="w-full">
                <TabsTrigger value="holder" className="flex-1">
                  Holder
                </TabsTrigger>
                <TabsTrigger value="policy" className="flex-1">
                  Policy
                </TabsTrigger>
              </TabsList>

              <TabsContent value="holder" className="space-y-4">
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
              </TabsContent>

              <TabsContent value="policy" className="grid gap-4 sm:grid-cols-2">
                {tiers && tiers.length > 0 ? (
                  <Field
                    label="Tier"
                    help="Changing this re-licenses running clients on their next refresh."
                    className="sm:col-span-2"
                  >
                    <Select
                      value={tier || NO_TIER}
                      onValueChange={(v) => setTier(v === NO_TIER ? "" : v)}
                    >
                      <SelectTrigger aria-label="Tier">
                        <SelectValue placeholder="No tier" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_TIER}>No tier</SelectItem>
                        {tiers.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.label || t.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                {downgradeWarning ? (
                  <p className="sm:col-span-2 text-xs text-muted-foreground">
                    {downgradeWarning}
                  </p>
                ) : null}
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
              </TabsContent>
            </Tabs>
          </DialogBody>
          <DialogActionBar>
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
          </DialogActionBar>
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
