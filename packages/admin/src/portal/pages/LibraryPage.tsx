import * as React from "react";
import { Skeleton } from "../../ui/Skeleton.js";
import type { PortalAccount } from "../api.js";
import { useLicenses } from "../data.js";
import { href, useDocumentTitle } from "../router.js";
import { ErrorPanel } from "../components/States.js";

/** The Library (PORTAL.md §4.12–4.15). PX-01 frame: one row per product. */
export function LibraryPage({
  account,
}: {
  account: PortalAccount;
}): React.ReactElement {
  useDocumentTitle("Library");
  const licenses = useLicenses();
  const products = new Map<string, string>();
  for (const l of licenses.data ?? []) products.set(l.product, l.productName);
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold text-fg-strong desk:text-[2.5rem]">
          Your library
        </h1>
        <p className="text-fg-muted">Signed in as {account.email}</p>
      </div>
      {licenses.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : licenses.error ? (
        <ErrorPanel
          error={licenses.error}
          onRetry={() => void licenses.refetch()}
        />
      ) : (
        <ul className="space-y-2">
          {[...products].map(([slug, name]) => (
            <li key={slug}>
              <a href={href.product(slug)}>{name}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
