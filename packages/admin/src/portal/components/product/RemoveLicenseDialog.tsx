import * as React from "react";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import type { PortalLicenseDetail, PortalLicenseSummary } from "../../api.js";
import { useRemoveLicense } from "../../data.js";
import { PortalApiError } from "../../api.js";
import { portalErrorCopy } from "../../errors.js";
import { licenseStatus, type LibraryProduct } from "../../model/library.js";
import { licenseOptionLabel } from "../../model/product.js";
import { t } from "../../../lib/copy.js";

/**
 * **Remove from my library** (docs/design/PORTAL.md §4.20's overflow menu; notes/S-24 §5.5, §10,
 * D19; PX-23), on the console's `ConfirmDialog` (danger: focus on **Keep it**, the least
 * destructive action; the error inline). The Worker's `DELETE /api/licenses/<p>/<id>` takes the
 * licence out of the account and keeps it out: no later visit or sign-in adds it back, only its
 * key does.
 *
 * The consequences, in the person's words:
 * - its devices keep working (a removal signs nobody out and frees no seat);
 * - with Cloud Sync, the devices this person signed in on stop syncing it (lead decision,
 *   2026-10-06);
 * - where it goes. A licence nobody was named for floats again, so anyone with the key can add
 *   it; one the developer assigned keeps that email and waits for it. Either way it is "not in an
 *   account" (customers never see "floating", S-24 D5), and it won't come back here by itself.
 *
 * With several licences for the product the dialog names the one the page shows ("Pro · Key"),
 * and the product stays in the library with the others. The page offers it only for a licence
 * the Worker marks `removable` (its key can bring it back); a licence already gone (another tab)
 * counts as removed.
 */
export function RemoveLicenseDialog({
  open,
  onOpenChange,
  product,
  license,
  detail,
  cloudSync,
  store = null,
  onRemoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: LibraryProduct;
  /** The licence the page shows. */
  license: PortalLicenseSummary;
  /** Its detail, when loaded: the key's last characters for its name. */
  detail?: PortalLicenseDetail;
  /** The product runs Cloud Sync (the product view's `services.sync`). */
  cloudSync: boolean;
  /** The store of an active purchase on it (PX-W6), for an older Worker's origin. */
  store?: string | null;
  /** After the Worker removed it; `others` is how many licences of the product remain. */
  onRemoved: (others: number) => void;
}): React.ReactElement {
  const remove = useRemoveLicense(product.slug);
  const now = Math.floor(Date.now() / 1000);
  const others = product.licenses.filter((l) => l.id !== license.id).length;
  const named = Boolean((detail ?? license).email?.trim());
  const which = licenseOptionLabel(license, licenseStatus(license, now), {
    keys: detail?.id === license.id ? detail.keys : undefined,
    store,
    developer: product.presentation.developer,
  });
  const consequences = [
    "Its devices keep working.",
    ...(cloudSync
      ? ["The devices you signed in on stop syncing it with Cloud Sync."]
      : []),
    named
      ? "It won't be in an account, and it won't come back to this account by itself. To add it again, use its key."
      : "It won't be in an account: anyone with the key can add it, and it won't come back to this account by itself.",
  ];
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent="danger"
      title={
        others > 0
          ? `Remove this ${product.name} license from your library?`
          : `Remove ${product.name} from your library?`
      }
      description={
        others > 0
          ? `${which}. ${others === 1 ? "Your other license stays." : `Your other ${others} licenses stay.`}`
          : undefined
      }
      consequences={consequences}
      cancelLabel="Keep it"
      confirmLabel="Remove from my library"
      describeError={removeErrorCopy}
      onConfirm={async () => {
        await remove.mutateAsync(license.id);
        onRemoved(others);
      }}
    />
  );
}

/** `409 not_removable` in the person's words (copy.en.json's), else the portal's usual copy. */
function removeErrorCopy(err: unknown): { title: string; description: string } {
  if (err instanceof PortalApiError && err.code === "not_removable")
    return {
      title: t("core.codes.not_removable.title"),
      description: t("core.codes.not_removable.message"),
    };
  return portalErrorCopy(err);
}
