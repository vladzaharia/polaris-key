import * as React from "react";
import { Compass } from "lucide-react";
import { Skeleton } from "../../ui/Skeleton.js";
import type { PortalAccount } from "../api.js";
import { AttentionShelf } from "../components/AttentionShelf.js";
import { LibraryEmpty } from "../components/LibraryEmpty.js";
import { LibraryHero } from "../components/LibraryHero.js";
import { LibraryTile } from "../components/LibraryTile.js";
import { ErrorPanel } from "../components/States.js";
import { useLibrary } from "../library.js";
import {
  attentionItems,
  platformsOnlyNote,
  quickAction,
  type DeviceInHand,
  type LibraryProduct,
} from "../model/library.js";
import { href, useDocumentTitle } from "../router.js";

/**
 * The Library (§4.12–4.15), the default page: one tile per product, never per license.
 * 0 → the empty state; 1 → the hero; 2–7 → large tiles; 8+ → the shelf and the compact grid.
 */
export function LibraryPage({
  account,
}: {
  account: PortalAccount;
  params?: URLSearchParams;
}): React.ReactElement {
  useDocumentTitle("Library");
  const lib = useLibrary();
  const count = lib.products?.length ?? 0;

  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-[1.875rem] font-bold leading-tight text-fg-strong desk:text-[2.5rem]">
          Your library
        </h1>
        <p className="text-fg-muted">
          {count > 1 ? `${count} products · ` : ""}
          {count > 1 ? "signed in as " : "Signed in as "}
          <span className="text-fg-strong">{account.email}</span>
        </p>
      </div>
      {lib.isPending ? (
        <div className="grid gap-6 desk:grid-cols-3" aria-busy>
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      ) : lib.error ? (
        <ErrorPanel error={lib.error} onRetry={lib.retry} />
      ) : count === 0 ? (
        <LibraryEmpty email={account.email} />
      ) : (
        <LibraryBody
          products={lib.products!}
          device={lib.device}
          email={account.email}
        />
      )}
    </section>
  );
}

function LibraryBody({
  products,
  device,
  email,
}: {
  products: LibraryProduct[];
  device: DeviceInHand;
  email: string;
}): React.ReactElement {
  const action = (p: LibraryProduct) =>
    quickAction(p, device, (s) => href.product(p.slug, s));
  if (products.length === 1) {
    const p = products[0]!;
    return (
      <>
        <LibraryHero product={p} action={action(p)} />
        <p className="flex items-center gap-2 text-fg-muted">
          <Compass aria-hidden className="size-4 shrink-0" />
          That's everything linked to {email}.
        </p>
      </>
    );
  }
  if (products.length < 8) {
    return (
      <section aria-labelledby="all-h">
        <h2 id="all-h" className="sr-only">
          All products
        </h2>
        <ul className="grid gap-6 desk:grid-cols-2 wide:grid-cols-3">
          {products.map((p) => (
            <li key={p.slug} className="grid">
              <LibraryTile
                product={p}
                action={action(p)}
                note={platformsOnlyNote(p, device)}
              />
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <>
      <AttentionShelf items={attentionItems(products)} />
      <section aria-labelledby="all-h" className="space-y-4">
        <h2
          id="all-h"
          className="flex items-baseline gap-3 text-lg font-bold text-fg-strong"
        >
          All products
          <span className="text-sm font-normal text-fg-muted">
            Recently added first
          </span>
        </h2>
        <ul className="grid gap-5 desk:grid-cols-3 wide:grid-cols-4">
          {products.map((p) => (
            <li key={p.slug} className="grid">
              <LibraryTile
                product={p}
                action={action(p)}
                note={platformsOnlyNote(p, device)}
                compact
              />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
