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
import { ArrowRight, LayoutGrid, LogIn } from "lucide-react";
import type { AccessAdmin, Me, MeRole } from "../../api.js";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/Button.js";
import { CopyButton } from "../../ui/CopyButton.js";
import { PageHeader } from "../../ui/PageHeader.js";
import { Panel } from "../../ui/Section.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { mutate } from "../data/mutations.js";
import { pageOf, type ProductPageId } from "../nav.js";
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
  commerce: "commerce",
  license: "licenses",
  config: "catalog",
  signin: "sign-in",
  sync: "sync-data",
  keys: "keys",
  core: "overview",
};

/** The ink fill (B2): the console's one filled action is neutral, never the accent. */
const INK =
  "bg-action text-action-on hover:not-disabled:not-aria-disabled:bg-action-hover";

interface Destination {
  key: string;
  label: string;
  to: string;
  area: AreaId;
}

/** Up to two places the member can open: in this product first, then their other products. */
function destinations(me: Me, slug: string | null): Destination[] {
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
      out.push({
        key: `${s}:${page}`,
        label: `${name(s)} ${pageOf(page).label.toLowerCase()}`,
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

/** A role as Members draws it: the tag, then the areas of a narrowed one. */
function RoleTag({ role, me }: { role: MeRole; me: Me }): React.ReactElement {
  const { label, areas } = roleLabel(
    role,
    (s) => me.products.find((p) => p.slug === s)?.name ?? s,
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs font-medium text-fg-strong">
        {role.role === "console_access" ? (
          <LogIn aria-hidden className="size-3.5" />
        ) : null}
        {label}
      </span>
      {areas ? (
        <span className="text-xs text-fg-muted">
          {areas.map((a) => AREA_NAMES[a]).join(", ")}
        </span>
      ) : null}
    </span>
  );
}

/** "Signed in as … with <role>", and the way to switch accounts. */
function SignedInLine({ me }: { me: Me }): React.ReactElement {
  const roles = me.permissions?.roles ?? [];
  const useAnother = (): void => {
    void mutate("logout").finally(() => {
      window.location.href = "/manage/login";
    });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>
        Signed in as <strong className="text-fg-strong">{me.email}</strong>
        {roles.length ? " with" : ""}
      </span>
      {roles.map((role) => (
        <RoleTag key={`${role.role}:${role.scope}`} role={role} me={me} />
      ))}
      <Button variant="link" className="min-h-6" onClick={useAnother}>
        Use another account
      </Button>
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
      <span className="flex min-w-0 max-w-full basis-full pl-12 sm:basis-auto sm:pl-0">
        <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm bg-surface-sunken pl-2 font-mono text-xs text-fg">
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
  area,
  slug,
  productName,
  home,
}: {
  area: AreaId;
  slug: string | null;
  productName?: string;
  home: boolean;
}): React.ReactElement {
  const q = useAccessAdmins(area, slug);
  let body: React.ReactNode;
  if (q.isPending)
    body = (
      <div aria-busy="true" className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  else if (q.isError)
    body = (
      <p className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
        The list didn’t load.
        <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
          Try again
        </Button>
      </p>
    );
  else if (q.data.admins.length === 0)
    body = (
      <p className="text-sm text-fg-muted">
        No one can be named yet. A Superadmin of this Polaris Key can give you
        access.
      </p>
    );
  else
    body = (
      <>
        {home ? (
          <p className="mb-3 text-sm text-fg-muted">
            Superadmins can give you any role.
          </p>
        ) : null}
        <ul className="divide-y divide-border">
          {q.data.admins.map((person) => (
            <PersonRow
              key={person.email}
              person={person}
              productName={productName}
            />
          ))}
        </ul>
      </>
    );
  return (
    <Panel title="Who can give you access" className="h-full">
      {body}
    </Panel>
  );
}

function YouCanOpen({
  me,
  slug,
}: {
  me: Me;
  slug: string | null;
}): React.ReactElement {
  const places = destinations(me, slug);
  return (
    <Panel title="You can open" className="h-full">
      <div className="flex flex-col gap-3">
        {places.map((d, i) => (
          <Button
            key={d.key}
            asChild
            variant={i === 0 ? "primary" : "outline"}
            className={cn("w-full justify-start", i === 0 && INK)}
            data-service={AREA_ACCENTS[d.area]}
          >
            <Link to={d.to}>{d.label}</Link>
          </Button>
        ))}
        <a
          href="/"
          className="inline-flex min-h-6 items-center gap-1 self-start rounded-xs text-sm text-accent-fg underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
        >
          Open your library
          <ArrowRight aria-hidden className="size-4" />
        </a>
      </div>
    </Panel>
  );
}

/** The library tile of the no-product Home: the whole tile is the link. */
function LibraryTile(): React.ReactElement {
  return (
    <a
      href="/"
      className="group flex h-full flex-col gap-3 rounded-lg border border-border bg-surface-raised p-5 shadow-elevation-1 transition-colors hover:border-border-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
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
  /** Home for a member who holds no product yet. */
  home?: boolean;
}

export function NoAccessPage({
  me,
  area,
  slug,
  productName,
  home = false,
}: NoAccessPageProps): React.ReactElement {
  const where =
    slug === null
      ? area === "platform"
        ? "Platform"
        : `Platform → ${AREA_NAMES[area]}`
      : `${productName ?? slug} → ${AREA_NAMES[area]}`;
  const location =
    typeof window === "undefined"
      ? ""
      : `${window.location.host}${window.location.pathname}${window.location.hash}`;
  return (
    <section
      data-service="core"
      data-no-access={home ? "home" : area}
      className="mx-auto w-full max-w-[71rem] space-y-6 animate-pk-enter"
    >
      <PageHeader
        title={
          home ? (
            "You don’t have access to any product yet"
          ) : (
            <>
              You don’t have access to{" "}
              <span className="whitespace-nowrap">{where}</span>
            </>
          )
        }
        description={<SignedInLine me={me} />}
      />
      <div className="grid items-stretch gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <WhoCanHelp
            area={home ? "console" : area}
            slug={home ? null : slug}
            productName={productName}
            home={home}
          />
        </div>
        <div className="lg:col-span-4">
          {home ? <LibraryTile /> : <YouCanOpen me={me} slug={slug} />}
        </div>
      </div>
      {!home && location ? (
        <p className="break-all font-mono text-xs text-fg-muted">{location}</p>
      ) : null}
    </section>
  );
}
