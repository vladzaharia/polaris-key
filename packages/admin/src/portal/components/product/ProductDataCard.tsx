import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { YOUR_DATA_COPY, productCopyBody } from "../../copy/yourData.js";
import { useExportProductData } from "../../data.js";
import type { LibraryProduct } from "../../model/library.js";
import { DownloadData } from "../DownloadData.js";
import { SectionCard } from "./Card.js";
import { RemoveProductDataDialog } from "./RemoveProductDataDialog.js";

/**
 * "Your data in <Product>" (S-16 §5.5, §5.7; I-11): on the product page of a license and of an open
 * product's entry, the person's own **Download my data from <Product>** (what that one product
 * holds, saved as `polaris-key-<product>-data.json`) and **Remove my data from <Product>**,
 * confirmed in a dialog (`RemoveProductDataDialog`).
 *
 * Everything here is about this product alone, and says so in its heading and its words: the
 * account's own file and its 14-day deletion are Account's (Your data), never here. Like the
 * product sign-in card it has no entry in the section nav. The slug is the library's own item's,
 * never the URL's, so the requests can only name a product this account holds.
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
    <SectionCard
      id="data"
      title={`Your data in ${name}`}
      subtitle={`Only what ${name} holds for you, not your account or your other apps.`}
    >
      <div className="space-y-6">
        <DownloadData
          title={YOUR_DATA_COPY["yourData.product.copy.title"]}
          description={productCopyBody(name, product.licenses.length)}
          label={`Download my data from ${name}`}
          // What `portalApi.exportProductData` saves it as.
          filename={`polaris-key-${product.slug}-data.json`}
          download={exportData}
        />
        <div className="space-y-3 border-t border-border pt-6">
          <div className="space-y-1">
            <p className="font-medium text-fg-strong">
              {YOUR_DATA_COPY["yourData.product.remove.title"]}
            </p>
            <p className="text-sm text-fg-muted">
              Deletes what Polaris Key holds for you in {name}, such as your
              settings and synced data.
            </p>
          </div>
          <Button
            variant="outline"
            // A long product name wraps inside the card instead of running past it.
            className="h-auto min-h-9 max-w-full whitespace-normal border-danger-border py-2 text-left text-danger"
            iconStart={<Trash2 aria-hidden />}
            onClick={() => setRemoving(true)}
          >
            Remove my data from {name}
          </Button>
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
