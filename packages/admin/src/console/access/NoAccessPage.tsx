/**
 * NoAccessPage (ST-29; mockups `admin.no-access` and `admin.no-access-home`). What a member sees
 * where the worker would answer 403: a deep link into an area they do not hold, or Home with no
 * product yet. It names the area they lack and their role, lists up to three people who can give
 * them access (a name, a role and an address to copy), and offers the places they can open, so the
 * page is never a dead end. Nothing from the refused page appears, not even a count.
 *
 * There is no request workflow (ST-33 is not built): the people are named, and the member asks.
 * Colour (B2, B17): the one filled action is the neutral ink; a destination takes the accent of
 * the area it opens; the page itself is Core's.
 */

import * as React from "react";
import { ArrowRight, LayoutGrid } from "lucide-react";
import type { AccessAdmin, Me, MeRole } from "../../api.js";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/Button.js";
import { CopyButton } from "../../ui/CopyButton.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { Panel } from "../../ui/Section.js";
import { ServiceGlyph } from "../../ui/ServiceBadge.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { RoleSet } from "./RoleTag.js";
import { mutate } from "../data/mutations.js";
import {
  ALL_PAGES,
  isPageEnabled,
  type ProductPageId,
  type ServiceState,
} from "../nav.js";
import { Link } from "../router.js";
import { productPage } from "../routes.js";
import {
  AREA_ACCENTS,
  AREA_NAMES,
  canIn,
  roleLabel,
  type AreaId,
} from "./can.js";
import { useAccessAdmins } from "./useCan.js";

/** The page an area opens on, for "You can open". */
const AREA_LANDING: Partial<Record<AreaId, ProductPageId>> = {
  ship: "releases",
  commerce: "commerce-overview",
  license: "licenses",
  config: "catalog",
  signin: "app-sign-in",
  sync: "sync-setup",
  connect: "connect-setup",
  keys: "keys",
  core: "overview",
};

interface Destination {
  key: string;
  label: string;
  to: string;
  area: AreaId;
}

/**
 * Up to two places the member can open: in this product first, then their other products. A page
 * behind a service the product does not run is no destination (`services` is the current
 * product's; another product's are not loaded, and its landing page says if a service is off).
 */
/** What a destination is called: Core is not a page name, its landing page is Overview. */
/** The page a destination opens, by its own name ("Releases", "Storefronts"), never the area's. */
const pageLabel = (page: ProductPageId): string =>
  page === "commerce-overview"
    ? "Storefronts"
    : (ALL_PAGES.find((p) => p.page === page)?.label ?? page);

function destinations(
  me: Me,
  slug: string | null,
  services: ServiceState,
): Destination[] {
  const name = (s: string) => me.products.find((p) => p.slug === s)?.name ?? s;
  const order = [
    ...(slug ? [slug] : []),
    ...me.products.map((p) => p.slug).filter((s) => s !== slug),
  ];
  const out: Destination[] = [];
  for (const s of order) {
    for (const [area, page] of Object.entries(AREA_LANDING) as [
      AreaId,
      ProductPageId,
    ][]) {
      if (!canIn(me, area, s)) continue;
      if (s === slug && !isPageEnabled(page, services)) continue;
      out.push({
        key: `${s}:${page}`,
        // The page's name; in another product "Acme · Cloud Sync".
        label: s === slug ? pageLabel(page) : `${name(s)} · ${pageLabel(page)}`,
        to: productPage(s, page),
        area,
      });
      if (out.length === 2) return out;
      // Another product gets one destination: its first.
      if (s !== slug) break;
    }
  }
  return out;
}

function initials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/** Where a role came from, in the member's words (the facts line of the no-product Home). */
function sourceLine(role: MeRole, email: string): string {
  switch (role.source) {
    case "rule":
      return `From the ${email.split("@")[1] ?? "email"} email rule`;
    case "invite":
      return "From an invitation";
    case "grant":
      return "Added by an admin";
    case "root":
      return "From the Superadmin group";
    case "creator":
      return "You created the product";
    case "breakglass":
      return "From emergency access";
    default:
      return "";
  }
}

/** Who the member is: the address and the roles that bear on this page. */
function UseAnotherAccount({
  className,
}: {
  className?: string;
}): React.ReactElement {
  const useAnother = (): void => {
    // `go=1&other=1` asks the IdP for its account chooser (`prompt=select_account`): a bare
    // /manage/login would let a live IdP session sign the same account straight back in.
    void mutate("logout").finally(() => {
      window.location.href = "/manage/login?go=1&other=1";
    });
  };
  return (
    <Button
      variant="link"
      className={cn("min-h-6", className)}
      onClick={useAnother}
    >
      Use another account
    </Button>
  );
}

function SignedInLine({
  me,
  home,
  slug,
}: {
  me: Me;
  home: boolean;
  slug: string | null;
}): React.ReactElement {
  const all = me.permissions?.roles ?? [];
  // Roles that bear on this page: the product's own and the platform-wide ones, not the
  // member's roles in other products. A member whose roles are all elsewhere (a product-only
  // member on a platform page) still sees them, so the line can say what they hold.
  const bearing = all.filter(
    (r) =>
      home || !r.scope.startsWith("product:") || r.scope === `product:${slug}`,
  );
  const roles = bearing.length > 0 ? bearing : all;
  const productName = (s: string): string =>
    me.products.find((p) => p.slug === s)?.name ?? s;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="min-w-0 max-w-full">
        <strong className="break-all text-fg-strong">{me.email}</strong>
      </span>
      {/* From 640 px the way out follows the address, as the mockup draws it; below, at the foot. */}
      <UseAnotherAccount className="max-sm:hidden" />
      {roles.map((role) => (
        <span
          key={`${role.role}:${role.scope}`}
          className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1"
        >
          <RoleSet role={role} productName={productName} />
          {home && sourceLine(role, me.email) ? (
            <span>{sourceLine(role, me.email)}</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function PersonRow({
  person,
  productName,
}: {
  person: AccessAdmin;
  /** The product a product admin administers, for the role ("Diceroll admin"). */
  productName?: string;
}): React.ReactElement {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs font-medium text-fg-strong"
      >
        {initials(person.name)}
      </span>
      <span className="min-w-0 flex-1 basis-40">
        <span className="block font-medium text-fg-strong">{person.name}</span>
        <span className="block text-sm text-fg-muted">
          {person.role === "superadmin"
            ? "Superadmin"
            : `${productName ?? "Product"} admin`}
        </span>
      </span>
      {/* On a phone the address goes on its own line under the name, so the name never wraps
          around it; from 640 px it ends the row. */}
      <span className="flex min-w-0 max-w-full basis-full sm:basis-auto">
        <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm bg-surface-sunken ps-2 font-mono text-xs text-fg">
          <span className="min-w-0 break-all">{person.email}</span>
          <CopyButton
            value={person.email}
            label={`Copy ${person.name}'s email`}
            size="xs"
          />
        </span>
      </span>
    </li>
  );
}

function WhoCanHelp({
  q,
  productName,
}: {
  q: ReturnType<typeof useAccessAdmins>;
  productName?: string;
}): React.ReactElement {
  const wrap = React.useRef<HTMLDivElement>(null);
  const [retrying, setRetrying] = React.useState(false);
  const failedAt = React.useRef(0);
  // A retry keeps the error body (and the focused button, with its spinner) until the answer
  // arrives: a refetch with no data would otherwise swap in the skeleton and drop focus to
  // <body>. On success focus moves to the panel's heading; on a failure the button keeps it.
  React.useEffect(() => {
    if (!retrying) return;
    if (q.isSuccess) {
      setRetrying(false);
      const h = wrap.current?.querySelector<HTMLElement>("h2,h3");
      h?.setAttribute("tabindex", "-1");
      h?.focus();
    } else if (q.isError && q.errorUpdatedAt > failedAt.current)
      setRetrying(false);
  }, [retrying, q.isSuccess, q.isError, q.errorUpdatedAt]);
  let body: React.ReactNode;
  if (q.isPending && !retrying)
    body = (
      <ul aria-busy="true" className="divide-y divide-border">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="flex items-center gap-x-3 py-3 first:pt-0 last:pb-0"
          >
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <span className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3.5 w-1/4" />
            </span>
            <Skeleton className="hidden h-6 w-44 sm:block" />
          </li>
        ))}
      </ul>
    );
  else if (q.isError || retrying)
    body = (
      <div className="space-y-3 text-sm text-fg-muted">
        <p>The list didn't load. Ask a Superadmin of this console.</p>
        <Button
          variant="outline"
          size="sm"
          loading={q.isFetching}
          onClick={() => {
            failedAt.current = q.errorUpdatedAt;
            setRetrying(true);
            void q.refetch();
          }}
        >
          Try again
        </Button>
      </div>
    );
  else if (q.data!.admins.length === 0)
    body = (
      <p className="text-sm text-fg-muted">Ask a Superadmin of this console.</p>
    );
  else
    body = (
      <ul className="divide-y divide-border">
        {/* The product's admins first, whatever order they arrive in (the sort is stable). */}
        {[...q.data!.admins]
          .sort(
            (a, b) =>
              Number(b.role === "product_admin") -
              Number(a.role === "product_admin"),
          )
          .map((person) => (
            <PersonRow
              key={person.email}
              person={person}
              productName={productName}
            />
          ))}
      </ul>
    );
  return (
    <div ref={wrap}>
      <Panel title="Who can give you access">{body}</Panel>
    </div>
  );
}

/** The buttons: the first is the one filled action (ink), the rest outline; a row from 640 px. */
function Destinations({
  places,
}: {
  places: Destination[];
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-3 max-sm:flex-col">
      {places.map((d, i) => (
        <Button
          key={d.key}
          asChild
          variant={i === 0 ? "primary" : "outline"}
          className={cn(
            "h-auto grow justify-center whitespace-normal py-2 text-center sm:grow sm:justify-start sm:text-start max-sm:w-full",
            i > 0 && "hover:border-accent",
          )}
          data-service={AREA_ACCENTS[d.area]}
        >
          <Link to={d.to}>
            <ServiceGlyph
              id={(AREA_ACCENTS[d.area] ?? "core") as "core"}
              className={cn("[&_svg]:size-[1.1em]", i === 0 && "text-current")}
            />
            {d.label}
          </Link>
        </Button>
      ))}
    </div>
  );
}

function LibraryLink(): React.ReactElement {
  return (
    <a
      href="/"
      className="inline-flex min-h-6 items-center gap-1 self-start rounded-xs text-sm text-accent-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
    >
      Open your library
      <ArrowRight aria-hidden className="size-4" />
    </a>
  );
}

/** The library tile of the no-product Home: the whole tile is the link. */
function LibraryTile(): React.ReactElement {
  return (
    <a
      href="/"
      className="group flex w-full flex-col gap-3 self-start rounded-lg border border-border bg-surface-raised p-5 shadow-elevation-1 transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus"
    >
      <span className="flex size-9 items-center justify-center rounded-md bg-surface-sunken">
        <LayoutGrid aria-hidden className="size-4" />
      </span>
      <span className="inline-flex items-center gap-1 text-base font-medium text-fg-strong">
        Your library
        <ArrowRight aria-hidden className="size-4 text-accent-fg" />
      </span>
    </a>
  );
}

export interface NoAccessPageProps {
  me: Me;
  /** The area the refused page needs; `console` with `home` for a member with no product yet. */
  area: AreaId;
  /** The product, for a product page; `null` for a platform page. */
  slug: string | null;
  productName?: string;
  /** The product's services, to leave out a destination behind one it does not run. */
  services?: ServiceState;
  /** Home for a member who holds no product yet. */
  home?: boolean;
}

export function NoAccessPage({
  me,
  area,
  slug,
  productName,
  services = null,
  home = false,
}: NoAccessPageProps): React.ReactElement {
  // The product (or Platform) wraps anywhere, so a 200-character name stays on screen; only
  // "→ Area" holds together. The arrow is decoration: a screen reader hears ", Licensing".
  const q = useAccessAdmins(home ? "console" : area, home ? null : slug);
  const places = home ? [] : destinations(me, slug, services);
  const subject = slug === null ? "Platform" : (productName ?? slug);
  const areaName =
    slug === null && area === "platform" ? null : AREA_NAMES[area];
  return (
    <section
      data-service="core"
      data-no-access={home ? "home" : area}
      className="mx-auto w-full max-w-[71rem] space-y-6 animate-pk-enter"
    >
      <PageHeader
        unclampedTitle
        title={
          home ? (
            "You don't have access to any product yet"
          ) : (
            <span className="[overflow-wrap:anywhere]">
              You don't have access to {subject}
              {areaName ? (
                <>
                  <span className="sr-only">,</span>{" "}
                  <span className="whitespace-nowrap">
                    <ArrowRight
                      aria-hidden
                      className="me-[0.3em] inline size-[0.8em] align-baseline"
                    />
                    {areaName}
                  </span>
                </>
              ) : null}
            </span>
          )
        }
        description={<SignedInLine me={me} home={home} slug={slug} />}
      />
      {/* Top-aligned on purpose (`data-top-aligned`): each panel is as tall as its own content,
          so a short list never sits in a stretched box. Nothing stacks; with nothing to open the
          list keeps its eight columns and the library link goes to the foot. */}
      <div data-top-aligned className="grid items-start gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <WhoCanHelp q={q} productName={productName} />
        </div>
        {home ? (
          <div className="lg:col-span-4">
            <LibraryTile />
          </div>
        ) : places.length > 0 ? (
          <div className="min-w-0 lg:col-span-4">
            <Panel title="You can open">
              <div className="flex flex-col gap-3">
                <Destinations places={places} />
                <LibraryLink />
              </div>
            </Panel>
          </div>
        ) : null}
      </div>
      <div
        className={cn(
          "flex flex-col items-start gap-2",
          (home || places.length > 0) && "sm:hidden",
        )}
      >
        {!home && places.length === 0 ? <LibraryLink /> : null}
        <UseAnotherAccount className="sm:hidden" />
      </div>
    </section>
  );
}
