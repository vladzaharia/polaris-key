import * as React from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { PortalApiError } from "../../api.js";
import { YOUR_DATA_COPY, productCopyBody } from "../../copy/yourData.js";
import {
  useCreateSupportCode,
  useExportProductData,
  useProduct,
} from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import type { LibraryProduct } from "../../model/library.js";
import { DataRow } from "../DataRow.js";
import { DownloadData } from "../DownloadData.js";
import { SectionCard } from "./Card.js";
import { RemoveProductDataDialog } from "./RemoveProductDataDialog.js";

/**
 * "Your data in <Product>" (S-16 §5.5, §5.7; I-11): on the product page of a license and of an open
 * product's entry, compact rows for the person's own **Download my data** (what that one product
 * holds), **Remove my data** (confirmed in `RemoveProductDataDialog`) and a **Support code**.
 *
 * The product's name is in the heading only; the rows are about this product alone. The account's
 * own file and its 14-day deletion are Account's (Your data), never here. The slug is the library's
 * own item's, never the URL's, so the requests can only name a product this account holds.
 *
 * `onLeftLibrary`: a removal that also took the licenses out of the library leaves nothing to show
 * on this page, so the page goes back to the Library.
 */
export function ProductDataCard({
  product,
  onLeftLibrary,
}: {
  product: LibraryProduct;
  onLeftLibrary?: () => void;
}): React.ReactElement {
  const { name } = product;
  const exportData = useExportProductData(product.slug);
  const [removing, setRemoving] = React.useState(false);
  return (
    <SectionCard id="data" title={`Your data in ${name}`}>
      <div className="space-y-5">
        <DownloadData
          title={YOUR_DATA_COPY["yourData.product.copy.title"]}
          description={productCopyBody(product.licenses.length)}
          label={`Download my data from ${name}`}
          download={exportData}
        />
        <div className="border-t border-border pt-5">
          <DataRow
            danger
            icon={<Trash2 aria-hidden />}
            title={YOUR_DATA_COPY["yourData.product.remove.title"]}
            description={YOUR_DATA_COPY["yourData.product.remove.body"]}
          >
            <Button
              variant="outline"
              className="w-full border-danger-border text-danger sm:w-auto"
              aria-label={`Remove my data from ${name}`}
              onClick={() => setRemoving(true)}
            >
              Remove…
            </Button>
          </DataRow>
        </div>
        <div className="border-t border-border pt-5">
          <SupportCodeRow slug={product.slug} />
        </div>
      </div>
      <RemoveProductDataDialog
        open={removing}
        onOpenChange={setRemoving}
        product={product}
        onLeftLibrary={onLeftLibrary}
      />
    </SectionCard>
  );
}

/** The person's support code for this product: shown with Copy once it exists, else asked for. */
function SupportCodeRow({ slug }: { slug: string }): React.ReactElement {
  const view = useProduct(slug);
  const create = useCreateSupportCode(slug);
  const code = view.data?.supportCode ?? create.data?.supportCode ?? null;
  const limited =
    create.error instanceof PortalApiError && create.error.status === 429;
  const failure = create.error
    ? limited
      ? "Too many tries. Wait a minute, then try again."
      : `${portalErrorCopy(create.error).title}. ${portalErrorCopy(create.error).description}`
    : null;
  return (
    <DataRow
      icon={<KeyRound aria-hidden />}
      title={YOUR_DATA_COPY["yourData.product.support.title"]}
      description={YOUR_DATA_COPY["yourData.product.support.body"]}
      below={
        failure ? (
          <p role="alert" className="text-sm text-danger">
            {failure}
          </p>
        ) : null
      }
    >
      {code ? (
        <div className="flex flex-wrap items-center gap-2">
          <code
            aria-label="Support code"
            className="break-all rounded-md bg-surface-sunken px-2 py-1 font-mono text-sm text-fg-strong"
          >
            {code}
          </code>
          <CopyButton value={code} label="Copy support code" showLabel />
        </div>
      ) : (
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          loading={create.isPending || view.isPending}
          onClick={() => create.mutate()}
        >
          Get a support code
        </Button>
      )}
    </DataRow>
  );
}
