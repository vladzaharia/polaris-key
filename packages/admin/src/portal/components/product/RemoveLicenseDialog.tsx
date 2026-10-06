import * as React from "react";
import { Button } from "../../../ui/Button.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import type { PortalLicenseDetail, PortalLicenseSummary } from "../../api.js";
import { useRemoveLicense } from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import { licenseStatus, type LibraryProduct } from "../../model/library.js";
import { licenseOptionLabel } from "../../model/product.js";

/**
 * **Remove from my library** (docs/design/PORTAL.md §4.20's overflow menu; notes/S-24 §5.5, §10,
 * D19; PX-23): what removing does, then **Keep it** / **Remove from my library**. The Worker's
 * `DELETE /api/licenses/<p>/<id>` takes the licence out of the account and keeps it out: no later
 * visit or sign-in adds it back, only its key does.
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
 * and the product stays in the library with the others.
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
  const close = (next: boolean): void => {
    if (!next) remove.reset();
    onOpenChange(next);
  };
  const error = remove.error ? portalErrorCopy(remove.error) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="md"
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
    >
      <DialogBody className="space-y-4">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-fg">
          <li>Its devices keep working.</li>
          {cloudSync ? (
            <li>
              The devices you signed in on stop syncing it with Cloud Sync.
            </li>
          ) : null}
          <li>
            {named
              ? "It won't be in an account, and it won't come back to this account by itself. To add it again, use its key."
              : "It won't be in an account: anyone with the key can add it, and it won't come back to this account by itself."}
          </li>
        </ul>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error.title}. {error.description}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button
          variant="outline"
          className="font-bold"
          onClick={() => close(false)}
        >
          Keep it
        </Button>
        <Button
          variant="danger"
          className="font-bold"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(license.id, {
              onSuccess: () => {
                onOpenChange(false);
                onRemoved(others);
              },
            })
          }
        >
          Remove from my library
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
