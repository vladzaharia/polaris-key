import React, { useEffect, useState } from "react";
import { api, setCsrf, type Me } from "./api.js";
import { AdminProvider, StatusProvider } from "./context.js";
import { hashFor, parseRoute, tabOf, type Route, type Tab } from "./route.js";
import { Products } from "./views/Products.js";
import { Licenses } from "./views/Licenses.js";
import { LicenseDetailView } from "./views/LicenseDetail.js";
import { Tiers } from "./views/Tiers.js";
import { SchemaCatalog } from "./views/SchemaCatalog.js";
import { Activity } from "./views/Activity.js";

/**
 * Top-level shell. Boots the admin identity + CSRF + the set of products the operator may
 * administer, then renders a product switcher + per-product nav. Routing is hash-based so
 * deep links + back/forward work without a router dependency.
 */
export function App(): React.ReactElement {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const m = await api.me();
        setCsrf(m.csrf);
        setMe(m);
      } catch {
        setError("Could not load the admin session.");
      }
    })();
  }, []);

  if (error)
    return (
      <div className="boot">
        <p className="note note-error">{error}</p>
      </div>
    );
  if (!me)
    return (
      <div className="boot">
        <p className="muted">Loading console…</p>
      </div>
    );

  // Resolve the active product: route slug, else the first the operator can admin.
  const activeSlug = route.kind === "product" ? route.slug : me.products[0]?.slug ?? "";

  return (
    <AdminProvider value={{ me, product: activeSlug, setProduct: (slug) => (window.location.hash = hashFor({ kind: "product", slug, view: "licenses" })) }}>
      <StatusProvider>
        <div className="app">
          <Sidebar me={me} route={route} activeSlug={activeSlug} />
          <main className="main" key={route.kind === "product" ? `${route.slug}:${route.view}:${route.id ?? ""}` : "products"}>
            {renderRoute(route, me, activeSlug)}
          </main>
        </div>
      </StatusProvider>
    </AdminProvider>
  );
}

function renderRoute(route: Route, me: Me, activeSlug: string): React.ReactElement {
  if (route.kind === "products") return <Products />;
  if (!me.products.some((prod) => prod.slug === activeSlug)) {
    return <p className="note note-error">You do not administer “{activeSlug}”.</p>;
  }
  switch (route.view) {
    case "licenses":
      return <Licenses />;
    case "license":
      return route.id ? <LicenseDetailView id={route.id} /> : <Licenses />;
    case "tiers":
      return <Tiers />;
    case "catalog":
      return <SchemaCatalog />;
    case "activity":
      return <Activity />;
  }
}

const TABS: { tab: Tab; label: string }[] = [
  { tab: "licenses", label: "Licenses" },
  { tab: "tiers", label: "Tiers" },
  { tab: "catalog", label: "Schema catalog" },
  { tab: "activity", label: "Activity" },
];

function Sidebar({ me, route, activeSlug }: { me: Me; route: Route; activeSlug: string }): React.ReactElement {
  const active = tabOf(route);
  return (
    <aside className="sidebar">
      <a className="side-brand" href={hashFor({ kind: "products" })}>
        <span className="brand-dot" aria-hidden="true" />
        Polaris Key<span className="brand-sub">admin</span>
      </a>

      {me.platformAdmin ? (
        <a className={`side-link${route.kind === "products" ? " active" : ""}`} href={hashFor({ kind: "products" })}>
          Products
        </a>
      ) : null}

      <label className="product-switcher">
        <span className="sr-only">Product</span>
        <select
          aria-label="Product"
          value={activeSlug}
          onChange={(e) => (window.location.hash = hashFor({ kind: "product", slug: e.target.value, view: "licenses" }))}
        >
          {me.products.map((prod) => (
            <option key={prod.slug} value={prod.slug}>
              {prod.name}
            </option>
          ))}
        </select>
      </label>

      <nav className="side-nav" aria-label="Primary">
        {TABS.map(({ tab, label }) => (
          <a
            key={tab}
            className={`side-link${active === tab ? " active" : ""}`}
            aria-current={active === tab ? "page" : undefined}
            href={hashFor({ kind: "product", slug: activeSlug, view: tab })}
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="side-foot">
        <span className="side-who" title={me.email}>
          {me.name}
        </span>
        <button
          className="side-signout"
          onClick={() => void api.logout().finally(() => (window.location.href = "/admin/login"))}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
