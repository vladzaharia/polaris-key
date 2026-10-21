import * as React from "react";
import { Checkbox } from "../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { toast } from "../../../ui/toast.js";
import { t } from "../../../lib/copy.js";
import { PortalApiError } from "../../api.js";
import {
  YOUR_DATA_COPY,
  alsoRemoveLabel,
  alsoRemoveNote,
  notRemovableCopy,
  removeConfirm,
  removeConsequences,
  removedNote,
} from "../../copy/yourData.js";
import { useRemoveProductData } from "../../data.js";
import { isStepUpRequired, portalErrorCopy } from "../../errors.js";
import { StepUpInline } from "../account/StepUpInline.js";
import type { LibraryProduct } from "../../model/library.js";

/**
 * **Remove my data from <Product>** (S-16 §5.5, D25; I-11), on the console's `ConfirmDialog`
 * (danger: focus on **Keep my data**, the least destructive action; the refusal inline). The
 * Worker's `DELETE /api/products/<p>/data` deletes what Polaris Key holds for the person in this
 * one product and ends the ID it uses for them there. It never touches the account, another
 * product, or the account's 14-day deletion (that stays on Account).
 *
 * The license stays by default, and the dialog says plainly that while it does, the developer can
 * still connect the person to the old records through it. **Also remove my license from my
 * library** is the person's explicit choice (`?alsoRemoveLicense=1`) and is offered only when it
 * can succeed: the product has a license and every one the Worker marks `removable` (its key can
 * bring it back). An open product's entry has no license, so it has no choice and says nothing
 * about one.
 *
 * A refusal (`409 not_removable`) wrote nothing, so the data is still there too: the dialog says
 * so, stops offering the choice for this page and lets the person remove the data alone. Any other
 * error stays inline as well. Only a success refreshes the library and the product (and, with the
 * license gone, hands the page back to `onLeftLibrary`).
 */
export function RemoveProductDataDialog({
  open,
  onOpenChange,
  product,
  onLeftLibrary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: LibraryProduct;
  /** The licenses went with the data: the product has left the library, so the page should too. */
  onLeftLibrary?: () => void;
}): React.ReactElement {
  const { name } = product;
  const licenses = product.licenses.length;
  const remove = useRemoveProductData(
    product.slug,
    product.licenses.map((l) => l.id),
  );
  const [alsoRemove, setAlsoRemove] = React.useState(false);
  // The Worker refused the license's removal on this page: the choice is not offered again.
  const [refused, setRefused] = React.useState(false);
  // A stale sign-in: the prompt shows in the dialog, and confirming removes the data.
  const [askFirst, setAskFirst] = React.useState(false);
  const offered =
    licenses > 0 &&
    !refused &&
    product.licenses.every((l) => l.removable === true);
  const also = offered && alsoRemove;
  // A fresh dialog keeps the license, the default, every time it opens.
  React.useEffect(() => {
    if (open) {
      setAlsoRemove(false);
      setAskFirst(false);
    }
  }, [open]);

  /** The removal, its toast and the close; throws what the Worker refused. */
  const run = async (alsoRemoveLicense: boolean): Promise<void> => {
    try {
      await remove.mutateAsync(alsoRemoveLicense);
    } catch (err) {
      // Nothing was written: the license can't go, but the data still can.
      if (isNotRemovable(err)) {
        setRefused(true);
        setAlsoRemove(false);
      }
      throw err;
    }
    toast.success(t("locker.productData.removed", { product: name }), {
      description: removedNote({ name, licenses, alsoRemoveLicense }),
    });
    onOpenChange(false);
    if (alsoRemoveLicense) onLeftLibrary?.();
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent="danger"
      title={t("locker.productData.removeAsk", { product: name })}
      description={t("locker.productData.removeBody", { product: name })}
      consequences={removeConsequences({
        name,
        developer: product.presentation.developer,
        licenses,
        alsoRemoveLicense: also,
      })}
      cancelLabel={YOUR_DATA_COPY["yourData.remove.keep"]}
      confirmLabel={removeConfirm(also, licenses)}
      closeOnSuccess={false}
      describeError={(err) =>
        isNotRemovable(err)
          ? notRemovableCopy(name, err.reason)
          : portalErrorCopy(err)
      }
      onConfirm={async () => {
        try {
          await run(also);
        } catch (err) {
          if (isStepUpRequired(err)) {
            setAskFirst(true);
            return;
          }
          throw err;
        }
      }}
    >
      {askFirst ? (
        <StepUpInline
          verb={t("locker.verb.removeData")}
          onConfirmed={() => {
            setAskFirst(false);
            // A refusal shows on the next press of the confirm button.
            void run(also).catch(() => undefined);
          }}
          onCancel={() => setAskFirst(false)}
        />
      ) : null}
      {offered ? (
        <Checkbox
          checked={alsoRemove}
          onCheckedChange={setAlsoRemove}
          disabled={remove.isPending}
          label={alsoRemoveLabel(licenses)}
          description={alsoRemoveNote(licenses)}
        />
      ) : null}
    </ConfirmDialog>
  );
}

/** `409 not_removable`: a license the key could not bring back, so the Worker wrote nothing. */
function isNotRemovable(err: unknown): err is PortalApiError {
  return err instanceof PortalApiError && err.code === "not_removable";
}
