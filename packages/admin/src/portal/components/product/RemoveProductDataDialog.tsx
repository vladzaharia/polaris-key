import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "../../../ui/Button.js";
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
} from "../../copy/yourData.js";
import {
  useExportProductData,
  useProduct,
  useRemoveProductData,
} from "../../data.js";
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
  // A stale sign-in on the "Download first" link: the prompt shows, confirming runs it again.
  const [askDownload, setAskDownload] = React.useState(false);
  // What the retry after a step-up prompt met: shown in the dialog like any other refusal.
  const [retryError, setRetryError] = React.useState<unknown>(null);
  const services = useProduct(product.slug, { enabled: open }).data?.services;
  const exportData = useExportProductData(product.slug);
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
      setAskDownload(false);
      setRetryError(null);
      exportData.reset();
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
    // The dialog said what stays and what goes; the toast only says it is done.
    toast.success(t("locker.productData.removed", { product: name }));
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
        services,
      })}
      typedConfirmation={{
        value: name,
        label: t("yourData.remove.type"),
        ignoreCase: true,
      }}
      error={retryError}
      cancelLabel={YOUR_DATA_COPY["yourData.remove.keep"]}
      confirmLabel={removeConfirm(also, licenses)}
      closeOnSuccess={false}
      describeError={(err) =>
        isNotRemovable(err)
          ? notRemovableCopy(name, err.reason)
          : portalErrorCopy(err)
      }
      onConfirm={async () => {
        setRetryError(null);
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
            setRetryError(null);
            run(also).catch((err: unknown) => {
              if (isStepUpRequired(err)) setAskFirst(true);
              else setRetryError(err);
            });
          }}
          onCancel={() => setAskFirst(false)}
        />
      ) : null}
      <DownloadFirst
        download={exportData}
        ask={askDownload}
        setAsk={setAskDownload}
      />
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

/**
 * **Download my data first** (I-11): the product's file, before the removal that cannot be undone.
 * The same request as the card's Download; a stale sign-in asks to confirm and runs it again, any
 * other refusal shows under the link.
 */
function DownloadFirst({
  download,
  ask,
  setAsk,
}: {
  download: ReturnType<typeof useExportProductData>;
  ask: boolean;
  setAsk: (ask: boolean) => void;
}): React.ReactElement {
  const start = (): void => {
    if (download.isPending) return;
    download.mutate(undefined, {
      onSuccess: () =>
        toast.success(YOUR_DATA_COPY["yourData.copy.started"], {
          description: YOUR_DATA_COPY["yourData.copy.private"],
        }),
      onError: (err) => {
        if (isStepUpRequired(err)) setAsk(true);
      },
    });
  };
  const failure =
    download.error && !isStepUpRequired(download.error)
      ? portalErrorCopy(download.error)
      : null;
  return (
    <div className="space-y-2">
      <Button
        variant="link"
        className="max-sm:min-h-11"
        iconStart={<Download aria-hidden />}
        loading={download.isPending}
        onClick={start}
      >
        {t("yourData.remove.downloadFirst")}
      </Button>
      {ask ? (
        <StepUpInline
          verb={t("locker.verb.downloadData")}
          onConfirmed={() => {
            setAsk(false);
            start();
          }}
          onCancel={() => setAsk(false)}
        />
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-danger">
          {failure.line}
        </p>
      ) : null}
    </div>
  );
}
