import { t } from "../../../lib/copy.js";
import * as React from "react";
import { LifeBuoy, Trash2 } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { PortalApiError } from "../../api.js";
import {
  YOUR_DATA_COPY,
  productCopyBody,
  supportCodeHint,
} from "../../copy/yourData.js";
import {
  useCreateSupportCode,
  useExportProductData,
  useProduct,
} from "../../data.js";
import { SpellOut } from "../../../ui/SpellOut.js";
import { LiveRegion } from "../../../ui/LiveRegion.js";
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
    <SectionCard
      id="data"
      title={t("locker.productData.title", { product: name })}
    >
      <div className="space-y-5">
        <DownloadData
          title={YOUR_DATA_COPY["yourData.product.copy.title"]}
          description={productCopyBody(product.licenses.length)}
          label={t("locker.productData.download", { product: name })}
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
              aria-label={t("locker.productData.removeAria", { product: name })}
              onClick={() => setRemoving(true)}
            >
              {t("locker.productData.remove")}
            </Button>
          </DataRow>
        </div>
        <div className="border-t border-border pt-5">
          <SupportCodeRow slug={product.slug} name={name} />
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

/**
 * The person's support code for this product (I-41: `XXX-XXX-XXX`, in the mono font): shown with
 * Copy once it exists, else asked for. Copy puts the dashed form on the clipboard.
 */
function SupportCodeRow({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  const view = useProduct(slug);
  const create = useCreateSupportCode(slug);
  const code = view.data?.supportCode ?? create.data?.supportCode ?? null;
  // A code the person just asked for takes focus and is announced once; one already there is not.
  const groupRef = React.useRef<HTMLDivElement>(null);
  const asked = create.data?.supportCode ?? null;
  // One polite region, always mounted and empty until the code arrives, so it reads once.
  const [announced, setAnnounced] = React.useState("");
  React.useEffect(() => {
    if (!asked) return;
    groupRef.current?.focus();
    setAnnounced(t("locker.productData.supportCode", { detail: asked }));
  }, [asked]);
  const limited =
    create.error instanceof PortalApiError && create.error.status === 429;
  const failure = create.error
    ? limited
      ? t("signin.code.rateLimited")
      : portalErrorCopy(create.error).line
    : null;
  return (
    <>
      <DataRow
        icon={<LifeBuoy aria-hidden />}
        title={YOUR_DATA_COPY["yourData.product.support.title"]}
        description={supportCodeHint(name)}
        below={
          failure || code ? (
            <>
              {failure ? (
                <p role="alert" className="text-sm text-danger">
                  {failure}
                </p>
              ) : null}
              {code ? <SpellOut code={code} touch /> : null}
            </>
          ) : null
        }
      >
        {code ? (
          <div className="flex flex-wrap items-center gap-2">
            <div
              ref={groupRef}
              role="group"
              aria-label={t("yourData.product.support.title")}
              tabIndex={-1}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <code className="select-all break-normal rounded-md box-decoration-clone bg-surface-sunken px-3 py-1.5 font-mono text-lg tracking-widest text-fg-strong">
                {code}
              </code>
            </div>
            <CopyButton
              value={code}
              label={t("locker.productData.copyCode")}
              size="md"
              showLabel
            />
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            loading={create.isPending || view.isPending}
            onClick={() => create.mutate()}
          >
            {t("locker.productData.getCode")}
          </Button>
        )}
      </DataRow>
      <LiveRegion message={announced} />
    </>
  );
}
