import * as React from "react";
import { Download } from "lucide-react";
import { api, type MintBundleBody } from "../../api.js";
import { useResource } from "../../context.js";
import { docsUrl } from "../../lib/docsLinks.js";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  useToast,
} from "../../components/ui/index.js";
import { CopyButton } from "./shared.js";
import { qk } from "../../console/data/queries.js";
import { mutate } from "../../console/data/mutations.js";

/**
 * The offline-activation bundle mint — the console half of the request-code flow
 * (`packages/worker/src/core/bundles.ts` is the server half and the source of truth).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * Some installs never touch the network: a broadcast rack on an isolated VLAN, a machine on a
 * ship, an air-gapped edit bay. Such an install cannot register, cannot fetch a licence
 * document, and cannot be told it is out of grace. So the flow is inverted and a human carries
 * the bytes: the app shows a REQUEST CODE, an operator reads it over the phone or off a ticket
 * and pastes it here, and this dialog hands back one signed file to walk back across on a USB
 * stick. What the operator pastes is the device's own id — 32 base64url characters the app
 * generated for itself — not a licence key and not anything they can invent, which is why a
 * mistyped code has to fail HERE rather than produce a bundle no machine can import.
 *
 * ── WHY THE CONFIG CHECKBOX DISAPPEARS ──────────────────────────────────────────────────────
 *
 * A product that does not run the Config service has no config document to ship, so the box is
 * removed rather than shown disabled with a tooltip. A disabled control is a promise that the
 * option exists and could be reached; here it does not exist for this product at all, and the
 * only thing a tooltip could say is "this product is not that kind of product". While
 * enablement is still loading the row renders as nothing rather than as an unticked box, since
 * a wrong default that flips under the operator's cursor is worse than a beat of absence.
 *
 * ── WHY THE BUNDLE IS SHOWN ONCE, BUT WITHOUT THE CEREMONY OF A KEY ─────────────────────────
 *
 * The result phase replaces the form, as a minted key does — but for the opposite reason. A
 * licence key is shown once because the server keeps only its hash and can never show it again.
 * A bundle is a SIGNED ARTIFACT: nothing is lost by losing it, and minting another for the same
 * device costs one request. So it is offered for download and then dropped from React state
 * without warning anyone that this is their only chance, because it is not.
 */

/** The offline window the operator gets by default: the ceiling, because the machine this is
 *  for is the one least able to come back for another bundle. */
const DEFAULT_GRACE_DAYS = 365;
/** The same bound the importing client enforces (§3.3) — exceed it and the refusal happens on
 *  an air-gapped machine instead of here. */
const MAX_GRACE_DAYS = 365;
/** The device id shape wire v3 §6 fixes: 32 base64url characters. */
const DEVICE_ID = /^[A-Za-z0-9_-]{32}$/;
/** A compact JWS is a JOSE object, and naming it so keeps the OS from renaming the file. */
const BUNDLE_MIME = "application/jose";

/**
 * Mint one offline activation bundle for `licenseId`, bound to a device the operator names by
 * pasting its request code. Two phases: the form, then the minted result.
 */
export function OfflineBundleDialog({
  slug,
  licenseId,
  open,
  onOpenChange,
}: {
  slug: string;
  licenseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const toast = useToast();
  const configId = React.useId();
  const [deviceId, setDeviceId] = React.useState("");
  const [graceDays, setGraceDays] = React.useState(String(DEFAULT_GRACE_DAYS));
  const [includeConfig, setIncludeConfig] = React.useState(true);
  const [fieldErrors, setFieldErrors] = React.useState<BundleErrors>({});
  const [minted, setMinted] = React.useState<MintedBundle | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Enablement decides which documents a bundle can carry, so the console has to ask rather
  // than assume. Keyed per product and shared through the resource cache: the dialog is mounted
  // with the detail view, so the answer is already settled by the time it is opened.
  const { data: serviceData } = useResource(qk.services(slug), () =>
    api.services(slug),
  );
  const configEnabled = serviceData
    ? serviceData.services.config.enabled
    : null;

  React.useEffect(() => {
    if (open) {
      setDeviceId("");
      setGraceDays(String(DEFAULT_GRACE_DAYS));
      setIncludeConfig(true);
      setFieldErrors({});
      setMinted(null);
      setBusy(false);
    }
  }, [open]);

  const mint = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const nextErrors = validateBundle({ deviceId, graceDays });
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setBusy(true);
    try {
      const body: MintBundleBody = {
        deviceId: deviceId.trim(),
        graceDays: Number(graceDays),
        licenseId,
      };
      // Only assert a config preference when the operator was actually offered one; otherwise
      // let the server's enablement answer, which it would anyway.
      if (configEnabled) body.includeConfig = includeConfig;
      const res = await mutate("mintBundle", slug, body);
      // Carry the device id into the result so the filename cannot drift from what was signed.
      setMinted({ ...res, deviceId: body.deviceId });
      toast.success(
        "Bundle minted",
        "Carry the file to the device and import it there.",
      );
    } catch (err) {
      toast.error(
        "Could not mint bundle",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mint offline bundle</DialogTitle>
          <DialogDescription>
            {minted
              ? "Download the file and carry it to the device. Minting another is free if this one is lost."
              : "Sign the documents an air-gapped device cannot fetch for itself."}{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("mintBundle")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </DialogDescription>
        </DialogHeader>
        {minted ? (
          <>
            <DialogBody>
              <div className="space-y-4">
                <div
                  role="status"
                  aria-live="polite"
                  className="space-y-3 rounded-md border border-border bg-card/40 p-4"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">
                      Bundle minted
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Quote this id on a support ticket — the mint is recorded
                      under it, and the device reports it back on import.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <code
                      aria-label="Bundle ID"
                      className="flex-1 select-all overflow-x-auto whitespace-nowrap rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                    >
                      {minted.bundleId}
                    </code>
                    <CopyButton value={minted.bundleId} label="Copy ID" />
                  </div>
                </div>
                <Button
                  type="button"
                  onClick={() =>
                    downloadText(
                      `${slug}-${minted.deviceId.slice(0, 8)}.pkeybundle`,
                      BUNDLE_MIME,
                      minted.bundle,
                    )
                  }
                >
                  <Download aria-hidden />
                  Download .pkeybundle
                </Button>
              </div>
            </DialogBody>
            <DialogActionBar>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogActionBar>
          </>
        ) : (
          <form onSubmit={mint} className="contents" noValidate>
            <DialogBody>
              <div className="space-y-4">
                <Field
                  label="Device ID"
                  help="The request code shown on the device's offline-activation screen — 32 characters the app generated for itself."
                  error={fieldErrors.deviceId}
                >
                  <Input
                    value={deviceId}
                    onChange={(e) => {
                      setDeviceId(e.target.value);
                      clearFieldError(setFieldErrors, "deviceId");
                    }}
                    placeholder="Paste the request code"
                    className="font-mono"
                    autoFocus
                  />
                </Field>
                <Field
                  label="Grace days"
                  help="How long the device may run before it needs a new bundle. 1–365."
                  error={fieldErrors.graceDays}
                >
                  <Input
                    type="number"
                    min={1}
                    max={MAX_GRACE_DAYS}
                    value={graceDays}
                    onChange={(e) => {
                      setGraceDays(e.target.value);
                      clearFieldError(setFieldErrors, "graceDays");
                    }}
                  />
                </Field>
                {configEnabled ? (
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor={configId}
                      className="flex items-center gap-2 text-sm font-medium leading-none"
                    >
                      <Checkbox
                        id={configId}
                        checked={includeConfig}
                        onCheckedChange={(v) => setIncludeConfig(v === true)}
                      />
                      Include configuration
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Ships the signed config document too, so the device starts
                      with the settings it would have fetched online.
                    </p>
                  </div>
                ) : null}
              </div>
            </DialogBody>
            <DialogActionBar>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Mint bundle
              </Button>
            </DialogActionBar>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface MintedBundle {
  bundleId: string;
  bundle: string;
  /** The id that was actually signed, not whatever the field holds now. */
  deviceId: string;
}

type BundleErrors = Partial<Record<"deviceId" | "graceDays", string>>;

function validateBundle(input: {
  deviceId: string;
  graceDays: string;
}): BundleErrors {
  const errors: BundleErrors = {};
  const deviceId = input.deviceId.trim();
  if (!deviceId) errors.deviceId = "Paste the device's request code.";
  else if (!DEVICE_ID.test(deviceId))
    errors.deviceId =
      "A request code is exactly 32 characters — letters, digits, “-” or “_”. Check for a truncated paste.";
  const graceDays = Number(input.graceDays);
  if (
    !input.graceDays.trim() ||
    !Number.isInteger(graceDays) ||
    graceDays < 1 ||
    graceDays > MAX_GRACE_DAYS
  ) {
    errors.graceDays = `Enter a whole number of days between 1 and ${MAX_GRACE_DAYS}.`;
  }
  return errors;
}

function clearFieldError(
  setErrors: React.Dispatch<React.SetStateAction<BundleErrors>>,
  field: keyof BundleErrors,
): void {
  setErrors((prev) => {
    if (!prev[field]) return prev;
    const next = { ...prev };
    delete next[field];
    return next;
  });
}

/**
 * Offer `text` to the browser as a downloaded file.
 *
 * The admin package has no download helper because nothing else here produces a file — a
 * bundle is the first artifact the console hands over rather than displays. Feature-detected
 * rather than assumed: jsdom has no `URL.createObjectURL`, and a test that opened this dialog
 * should fail on a broken assertion, not on a missing browser API.
 *
 * Doing nothing is the right degradation precisely BECAUSE the only environment that reaches it
 * is a test runner. Every browser the console supports has had `createObjectURL` for a decade,
 * so there is no operator on the other side of this branch to be left without a file — and if
 * one somehow were, the honest recovery is to mint again (which is free) rather than to fall
 * back to a `data:` URL that some browsers refuse to download from anyway.
 */
function downloadText(filename: string, mime: string, text: string): void {
  const createObjectUrl = URL.createObjectURL as
    | ((blob: Blob) => string)
    | undefined;
  if (typeof createObjectUrl !== "function") return;
  const url = createObjectUrl(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}
