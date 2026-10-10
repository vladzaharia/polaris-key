/**
 * The license record's two dialogs: Edit holder (the name; the terms live in the Overview form)
 * and Mint offline bundle (ADMIN.md §6.5.2).
 *
 * LX-30 (S-24 D20): Edit holder no longer edits an assigned licence's email. Giving the licence to
 * another address is **Reassign…**, and removing its holder is **Make floating…**, both I-12's
 * audited relink tool (`LicenseHolderDialogs.tsx`); a floating licence gets **Assign…** instead.
 *
 * ── The offline bundle ─────────────────────────────────────────────────────────────────────
 *
 * Some installs never touch the network. The app shows a REQUEST CODE (its own device id: 32
 * base64url characters), an operator pastes it here, and the console hands back one signed file
 * to carry across. A mistyped code has to fail HERE, not produce a bundle no machine can import.
 * A product without Config has no config document to ship, so the include box is absent rather
 * than disabled. The bundle is a signed artifact, not a secret, but it is still shown in the
 * one-time panel so the download is reliable and the value can be copied when it fails (LDT-13).
 * Escape, Close and an outside click ask before the result goes, until it is copied, downloaded
 * or ticked as stored (FLOWS.md C-21). Edit holder asks before it drops unsaved changes (C-20).
 */

import * as React from "react";
import type { LicenseDetail, MintBundleBody } from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  useDismissGuard,
} from "../../../../ui/Dialog.js";
import {
  diffValues,
  Form,
  FormField,
  useAdminForm,
} from "../../../../ui/form.js";
import { ValueCopyButton } from "../../../../ui/IdChip.js";
import { Input } from "../../../../ui/Input.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { OneTimeSecretPanel } from "../../../../ui/OneTimeSecretPanel.js";
import { toast } from "../../../../ui/toast.js";

// ── Edit holder ────────────────────────────────────────────────────────────────────────────────

interface HolderValues {
  [key: string]: unknown;
  name: string;
}

export function EditHolderDialog({
  slug,
  license,
  open,
  onOpenChange,
}: {
  slug: string;
  license: LicenseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit holder"
      description="The name this license is issued to. Devices pick up the change at their next license refresh. To give it to someone else, use Reassign."
    >
      {open ? (
        <HolderForm
          slug={slug}
          license={license}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function HolderForm({
  slug,
  license,
  onDone,
}: {
  slug: string;
  license: LicenseDetail;
  onDone: () => void;
}): React.ReactElement {
  const form = useAdminForm<HolderValues>({
    values: { name: license.name },
    onSubmit: async (draft, { server }) => {
      const d = diffValues(server, { name: draft.name.trim() });
      if (Object.keys(d).length) {
        await mutate("patchLicense", slug, license.id, d as never);
        toast.success("Holder updated");
      }
      onDone();
    },
  });
  useDismissGuard(form.isDirty && !form.isSubmitting);
  return (
    <Form form={form} aria-label="Holder" className="contents">
      <DialogBody className="space-y-4">
        <FormField name="name" label="Name">
          {(f) => <Input {...f} autoFocus />}
        </FormField>
        {license.email ? (
          <p className="text-sm text-fg-muted">
            Email: <span className="text-fg">{license.email}</span>
          </p>
        ) : null}
        {form.submitError && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="The holder wasn't saved" live>
            {errorCopy(form.submitError, { thing: "License" }).description}
          </Callout>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={form.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.isSubmitting}>
          Save holder
        </Button>
      </DialogFooter>
    </Form>
  );
}

// ── Offline bundle ─────────────────────────────────────────────────────────────────────────────

/** The default offline window: the ceiling, for the machine least able to come back. */
export const DEFAULT_GRACE_DAYS = 365;
export const MAX_GRACE_DAYS = 365;
/** Wire v3 §6's device id: 32 base64url characters. */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{32}$/;
/** A compact JWS is a JOSE object; naming it so keeps the OS from renaming the file. */
const BUNDLE_MIME = "application/jose";

export function OfflineBundleDialog({
  slug,
  licenseId,
  configOn,
  open,
  onOpenChange,
}: {
  slug: string;
  licenseId: string;
  configOn: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [deviceId, setDeviceId] = React.useState("");
  const [graceDays, setGraceDays] = React.useState<number | null>(
    DEFAULT_GRACE_DAYS,
  );
  const [includeConfig, setIncludeConfig] = React.useState(true);
  const [errors, setErrors] = React.useState<{
    deviceId?: string;
    graceDays?: string;
  }>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [minted, setMinted] = React.useState<{
    bundleId: string;
    bundle: string;
    deviceId: string;
  } | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const titleRef = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setAsking(false);
      setDeviceId("");
      setGraceDays(DEFAULT_GRACE_DAYS);
      setIncludeConfig(true);
      setErrors({});
      setBusy(false);
      setError(null);
      setMinted(null);
    }
  }, [open]);

  const mint = async (): Promise<void> => {
    const e: typeof errors = {};
    if (!DEVICE_ID_RE.test(deviceId.trim()))
      e.deviceId =
        "A request code is exactly 32 characters: letters, digits, “-” and “_”.";
    if (
      graceDays === null ||
      !Number.isInteger(graceDays) ||
      graceDays < 1 ||
      graceDays > MAX_GRACE_DAYS
    )
      e.graceDays = `Use a whole number of days from 1 to ${MAX_GRACE_DAYS}.`;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const body: MintBundleBody = {
        deviceId: deviceId.trim(),
        graceDays: graceDays!,
        licenseId,
      };
      // Only state a config preference when one was offered; enablement decides otherwise.
      if (configOn) body.includeConfig = includeConfig;
      const res = await mutate("mintBundle", slug, body);
      setMinted({ ...res, deviceId: body.deviceId });
      requestAnimationFrame(() =>
        titleRef.current?.focus({ preventScroll: true }),
      );
      announce("Bundle minted.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o && minted && !acknowledged) return setAsking(true);
        onOpenChange(o);
      }}
      dismissible={!busy}
      titleRef={titleRef}
      title={minted ? "Bundle minted" : "Mint offline bundle"}
      description={
        <>
          {minted
            ? "Download the file and carry it to the device. Minting another is free if this one is lost."
            : "Signs the documents an air-gapped device can't fetch for itself."}{" "}
          <a
            className="underline underline-offset-2 hover:text-fg-strong"
            href={docsUrl("mintBundle")}
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </a>
        </>
      }
    >
      {minted ? (
        <>
          <div className="px-6 pt-2 text-sm">
            <p className="font-medium text-fg-strong">Bundle id</p>
            <p className="mt-1 flex items-center gap-2">
              <code className="font-mono text-xs">{minted.bundleId}</code>
              <ValueCopyButton value={minted.bundleId} label="Copy ID" />
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              Quote it on a support ticket: the mint is recorded under it and
              the device reports it back on import.
            </p>
          </div>
          <OneTimeSecretPanel
            label="Bundle"
            value={minted.bundle}
            hint="A signed file, not a secret: mint another for the same device if this one is lost."
            download={{
              filename: `${slug}-${minted.deviceId.slice(0, 8)}.pkeybundle`,
              mime: BUNDLE_MIME,
            }}
            acknowledged={acknowledged}
            onAcknowledgedChange={(v) => {
              setAcknowledged(v);
              if (v) setAsking(false);
            }}
            closeRequested={asking}
            onCancelClose={() => setAsking(false)}
            onConfirmClose={() => onOpenChange(false)}
            onDone={() => onOpenChange(false)}
          />
        </>
      ) : (
        <form
          noValidate
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void mint();
          }}
        >
          <DialogBody className="space-y-4">
            <FormField
              name="deviceId"
              label="Device ID"
              help="The request code on the device's offline activation screen."
              value={deviceId}
              onChange={(v: string) => {
                setDeviceId(v);
                setErrors((x) => ({ ...x, deviceId: undefined }));
              }}
              error={errors.deviceId}
              announceError
            >
              {(f) => (
                <Input
                  {...f}
                  mono
                  placeholder="Paste the request code"
                  autoFocus
                />
              )}
            </FormField>
            <FormField
              name="graceDays"
              label="Grace days"
              help="How long the device may run before it needs a new bundle."
              value={graceDays}
              onChange={(v: number | null) => {
                setGraceDays(v);
                setErrors((x) => ({ ...x, graceDays: undefined }));
              }}
              error={errors.graceDays}
              announceError
            >
              {(f) => (
                <NumberInput
                  {...f}
                  integer
                  min={1}
                  max={MAX_GRACE_DAYS}
                  unit="days"
                  className="sm:max-w-48"
                />
              )}
            </FormField>
            {configOn ? (
              <Checkbox
                checked={includeConfig}
                onCheckedChange={setIncludeConfig}
                label="Include configuration"
                description="Ships the signed config document too, so the device starts with the settings it would have fetched online."
              />
            ) : null}
            {error ? (
              <Callout tone="danger" title="The bundle wasn't minted" live>
                {errorCopy(error, { thing: "License" }).description}
              </Callout>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Mint bundle
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
