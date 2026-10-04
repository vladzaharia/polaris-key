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
import { href, setParams, useDocumentTitle } from "../router.js";
import { LiveRegion } from "../../ui/LiveRegion.js";
import { LibraryList } from "../components/LibraryList.js";
import { LibraryToolbar } from "../components/LibraryToolbar.js";
import {
  applyView,
  effectiveMode,
  readRememberedMode,
  readView,
  rememberMode,
} from "../model/libraryView.js";

/**
 * The Library (§4.12–4.15), the default page: one tile per product, never per license.
 * 0 → the empty state; 1 → the hero; 2–7 → large tiles; 8+ → the shelf and the compact grid.
 */
export function LibraryPage({
  account,
  params,
}: {
  account: PortalAccount;
  params: URLSearchParams;
}): React.ReactElement {
  useDocumentTitle("Library");
  const lib = useLibrary();
  const count = lib.isPending ? 0 : (lib.products?.length ?? 0);

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
          params={params}
        />
      )}
    </section>
  );
}

function LibraryBody({
  products,
  device,
  email,
  params,
}: {
  products: LibraryProduct[];
  device: DeviceInHand;
  email: string;
  params: URLSearchParams;
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
  return <ScaledLibrary products={products} device={device} params={params} />;
}

/** 8+ products (§4.15): toolbar, the shelf, then the compact grid or the list. */
function ScaledLibrary({
  products,
  device,
  params,
}: {
  products: LibraryProduct[];
  device: DeviceInHand;
  params: URLSearchParams;
}): React.ReactElement {
  const v = readView(params);
  const [remembered, setRemembered] = React.useState(readRememberedMode);
  const mode = effectiveMode(
    v.view,
    remembered,
    device.phone || isNarrow(),
    products.length,
  );
  const shown = applyView(products, v);
  const filtered = v.q.trim() !== "" || v.filter !== "all";
  const action = (p: LibraryProduct) =>
    quickAction(p, device, (s) => href.product(p.slug, s));
  const attention = products.filter((p) => p.status.attention).length;
  const summary = `Showing ${shown.length} of ${products.length}`;
  return (
    <>
      <LibraryToolbar
        total={products.length}
        q={v.q}
        filter={v.filter}
        sort={v.sort}
        mode={mode}
        attentionCount={attention}
        onChange={(patch) =>
          setParams({
            ...(patch.q !== undefined ? { q: patch.q } : {}),
            ...(patch.filter !== undefined
              ? { filter: patch.filter === "all" ? null : patch.filter }
              : {}),
            ...(patch.sort !== undefined
              ? { sort: patch.sort === "recent" ? null : patch.sort }
              : {}),
          })
        }
        onMode={(m) => {
          rememberMode(m);
          setRemembered(m);
          setParams({ view: m });
        }}
      />
      <LiveRegion message={filtered ? summary : ""} />
      {filtered ? null : <AttentionShelf items={attentionItems(products)} />}
      <section aria-labelledby="all-h" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2
            id="all-h"
            className="flex items-baseline gap-3 text-lg font-bold text-fg-strong"
          >
            All products
            <span className="text-sm font-normal text-fg-muted">
              {v.sort === "name" ? "By name" : "Recently added first"}
            </span>
          </h2>
          {filtered ? (
            <p className="text-sm text-fg-muted">
              {summary} ·{" "}
              <button
                type="button"
                className="font-bold text-accent-fg hover:underline"
                onClick={() => setParams({ q: null, filter: null })}
              >
                Show all
              </button>
            </p>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-fg-muted">
            Nothing in your library matches
            {v.q.trim() ? ` “${v.q.trim()}”` : " this filter"}.
          </p>
        ) : mode === "list" ? (
          <LibraryList
            products={shown}
            actionFor={action}
            actionHeader={
              device.os && !device.phone
                ? `Quick action for this ${device.os === "macos" ? "Mac" : "computer"}`
                : "Quick action"
            }
          />
        ) : (
          <ul className="grid gap-5 desk:grid-cols-3 wide:grid-cols-4">
            {shown.map((p) => (
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
        )}
      </section>
    </>
  );
}

function isNarrow(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 760px)").matches
    : false;
}
