/**
 * The license record's **Device limit…** sheet (LX-14a; SIGN-IN.md D-53, EXPERIENCE.md O1 item
 * 5). It sets the licence's own device limit (`PATCH …/license/licenses/<id>` `deviceLimit`), the
 * most specific value: it beats the tier's limit, any `deviceLimit` entitlement and the product
 * default. **Use inherited limit** clears it (`null`), so the inherited value applies again.
 *
 * Lowering the limit below the devices in use signs nobody out: the Worker checks the limit only
 * on a new activation, so the sheet says so before saving, and the toast repeats the server's
 * `overLimit` answer after.
 */

import * as React from "react";
import type { LicenseDetail, TierSummary } from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { Form, FormField, useAdminForm } from "../../../ui/form.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { toast } from "../../../ui/toast.js";

interface DeviceLimitValues {
  [key: string]: unknown;
  deviceLimit: number | null;
}

/** The inherited limit in words, for the placeholder: "Inherits 5 from Pro". */
export function inheritedText(
  license: Pick<
    LicenseDetail,
    "tier" | "inheritedDeviceLimit" | "inheritedDeviceLimitSource"
  >,
  tiers: readonly TierSummary[],
  productLimit: number | undefined,
): { limit: number | null; text: string } {
  const tier = license.tier
    ? tiers.find((t) => t.id === license.tier)
    : undefined;
  let limit: number | undefined = license.inheritedDeviceLimit;
  let source = license.inheritedDeviceLimitSource;
  if (limit === undefined || source === undefined) {
    // An older Worker: the tier's, else the product's.
    limit = tier?.policyDeviceLimit ?? productLimit;
    source = tier?.policyDeviceLimit != null ? "tier" : "product";
  }
  const n = limit && limit > 0 ? limit : null;
  const from =
    source === "tier"
      ? `from ${tier ? tier.label || tier.id : "the tier"}`
      : source === "entitlement"
        ? "from an entitlement"
        : "from the product default";
  return { limit: n, text: `Inherits ${n ?? "no limit"} ${from}` };
}

/** "4 devices are signed in. None is signed out; …" when `limit` is below the devices in use. */
export function overLimitText(
  deviceCount: number,
  limit: number | null,
): string | null {
  if (limit === null || deviceCount <= limit) return null;
  return `${deviceCount} ${deviceCount === 1 ? "device is" : "devices are"} signed in. None is signed out; new devices are refused until the count is under ${limit}.`;
}

export function DeviceLimitSheet({
  slug,
  license,
  tiers,
  productLimit,
  open,
  onOpenChange,
}: {
  slug: string;
  license: LicenseDetail;
  tiers: readonly TierSummary[];
  productLimit: number | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Device limit"
      description="How many devices this license can have signed in at once. It beats the tier's limit and the product default; devices pick it up at their next activation."
    >
      {open ? (
        <DeviceLimitForm
          slug={slug}
          license={license}
          tiers={tiers}
          productLimit={productLimit}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Drawer>
  );
}

function DeviceLimitForm({
  slug,
  license,
  tiers,
  productLimit,
  onDone,
}: {
  slug: string;
  license: LicenseDetail;
  tiers: readonly TierSummary[];
  productLimit: number | undefined;
  onDone: () => void;
}): React.ReactElement {
  const inherited = inheritedText(license, tiers, productLimit);
  const [clearing, setClearing] = React.useState(false);
  const [clearError, setClearError] = React.useState<unknown>(null);

  const save = async (deviceLimit: number | null): Promise<void> => {
    const res = await mutate("patchLicense", slug, license.id, {
      deviceLimit,
    });
    const message =
      deviceLimit === null ? "Device limit inherited" : "Device limit saved";
    if (res.overLimit) {
      toast.warning(`${message}: over the limit`, {
        description:
          overLimitText(res.overLimit.deviceCount, res.overLimit.deviceLimit) ??
          undefined,
      });
    } else {
      toast.success(message);
    }
  };

  const form = useAdminForm<DeviceLimitValues>({
    values: { deviceLimit: license.deviceLimit ?? null },
    validate: (v) => {
      const e: Record<string, string> = {};
      if (v.deviceLimit === null)
        e.deviceLimit =
          "Enter a number of devices, or use the inherited limit.";
      else if (!Number.isInteger(v.deviceLimit) || v.deviceLimit < 1)
        e.deviceLimit = "Enter a whole number of at least 1.";
      return e;
    },
    onSubmit: async (draft) => {
      if (draft.deviceLimit !== (license.deviceLimit ?? null))
        await save(draft.deviceLimit);
      onDone();
    },
  });

  const draft = form.rhf.watch("deviceLimit") as number | null | undefined;
  const target = draft ?? inherited.limit;
  const warning = overLimitText(license.deviceCount, target);
  const busy = form.isSubmitting || clearing;

  const inherit = async (): Promise<void> => {
    setClearing(true);
    setClearError(null);
    try {
      await save(null);
      onDone();
    } catch (e) {
      setClearError(e);
    } finally {
      setClearing(false);
    }
  };

  const failure = clearError ?? form.submitError;
  return (
    <Form form={form} aria-label="Device limit" className="contents">
      <DrawerBody className="space-y-4">
        <FormField
          name="deviceLimit"
          label="Devices"
          help={
            license.deviceLimit != null
              ? `Set on this license. ${inherited.text} without it.`
              : `${inherited.text}. A number here overrides it for this license only.`
          }
        >
          {(f) => (
            <NumberInput
              {...f}
              nullable
              integer
              min={1}
              unit="devices"
              placeholder={inherited.text}
              className="sm:max-w-64"
              autoFocus
            />
          )}
        </FormField>
        {warning ? (
          <Callout tone="warning" title="Below the devices in use" live>
            {warning}
          </Callout>
        ) : null}
        {failure && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="The device limit wasn't saved" live>
            {errorCopy(failure, { thing: "License" }).description}
          </Callout>
        ) : null}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => void inherit()}
          loading={clearing}
          disabled={busy || license.deviceLimit == null}
        >
          Use inherited limit
        </Button>
        <Button type="submit" loading={form.isSubmitting} disabled={clearing}>
          Save
        </Button>
      </DrawerFooter>
    </Form>
  );
}
