import * as React from "react";
import { useLicenses } from "../data.js";
import { href, useDocumentTitle, type ProductSection } from "../router.js";

/** The product page (PORTAL.md §4.20). PX-01 frame. */
export function ProductPage({
  product,
}: {
  product: string;
  section: ProductSection | null;
  params: URLSearchParams;
}): React.ReactElement {
  const licenses = useLicenses();
  const name =
    licenses.data?.find((l) => l.product === product)?.productName ?? product;
  useDocumentTitle(name);
  return (
    <section className="space-y-4">
      <a href={href.library()} className="text-sm text-fg-muted">
        Library
      </a>
      <h1 className="text-3xl font-bold text-fg-strong">{name}</h1>
    </section>
  );
}
