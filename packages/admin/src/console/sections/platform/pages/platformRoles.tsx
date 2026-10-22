/**
 * Platform → Members → Roles (`#/platform/members?tab=roles`, ST-31.13; mockup `admin.roles`): the
 * four built-in roles as cards (what each covers, who can give it, how many people hold it now,
 * counted from the Members read) and the read-only matrix of what each role can do. The matrix is
 * `rolesMatrix.generated.ts`, generated from the Worker's route table (`pnpm gen roles-matrix`);
 * nothing in it is written here.
 *
 * A healthy cell is a tick alone. An exception is a word (Create, Invite, Name only, Most), and
 * the footnote under the table says what it means. On a phone the cards become four tiles that
 * pick the one role column the matrix shows.
 */

import * as React from "react";
import {
  BookOpen,
  Boxes,
  Check,
  Crown,
  KeyRound,
  KeySquare,
  LayoutDashboard,
  Link2,
  Package,
  Plus,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ServiceSlug, MembersView } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { ScrollTable } from "../../../../ui/ScrollTable.js";
import { Section } from "../../../../ui/Section.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { TABLE } from "../../../../ui/classes.js";
import {
  ROLES_MATRIX,
  type RolesMatrixCell,
  type RolesMatrixRow,
} from "../../../access/rolesMatrix.generated.js";

type RoleId = (typeof ROLES_MATRIX.roles)[number]["id"];

const ROLE_GLYPH: Record<string, LucideIcon> = {
  superadmin: Crown,
  platform_admin: ShieldCheck,
  product_admin: Package,
  console_access: KeyRound,
};

/** What each role covers and who can give it. The matrix says the rest. */
const ROLE_COPY: Record<string, { covers: string[]; givenBy: string }> = {
  superadmin: {
    covers: ["Everything, including products added later."],
    givenBy: "Given by a Superadmin or the root rule",
  },
  platform_admin: {
    covers: ["The platform, not the products."],
    givenBy: "Given by a Superadmin",
  },
  product_admin: {
    covers: ["One product, or all of them.", "Can be narrowed to some areas."],
    givenBy: "Given by a Superadmin or that product’s admin",
  },
  console_access: {
    covers: ["Can sign in and read the docs.", "Every other role includes it."],
    givenBy: "Given by a Superadmin or a Platform admin",
  },
};

/** The service whose glyph a feature row carries (B17); the other rows are Core's. */
const ROW_SERVICE: Record<string, ServiceSlug> = {
  license: "license",
  config: "config",
  ship: "release",
  signin: "identity",
  sync: "sync",
  commerce: "commerce",
};

const ROW_ICON: Record<string, LucideIcon> = {
  core: LayoutDashboard,
  keys: KeySquare,
  settings: Settings,
  members: Users,
  "platform-members": Users,
  connections: Link2,
  "platform-settings": Settings,
  "packages-status": Boxes,
  "new-products": Plus,
  docs: BookOpen,
};

/** How many people hold each role now, from the Members read; invites do not count. */
export function holdersOf(
  view: MembersView | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of ROLES_MATRIX.roles) out[r.id] = 0;
  for (const m of view?.members ?? []) {
    for (const id of new Set(m.roles.map((x) => x.role as string)))
      out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

function peopleText(n: number, atLeast: boolean): string {
  if (n === 0 && !atLeast) return "No one yet";
  const words = n === 1 ? "1 person" : `${n} people`;
  return atLeast ? `At least ${words}` : words;
}

function Count({
  n,
  loading,
  failed,
  atLeast,
}: {
  n: number;
  loading: boolean;
  failed: boolean;
  atLeast: boolean;
}): React.ReactElement {
  if (loading)
    return (
      <>
        <Skeleton className="h-4 w-16" />
        <span className="sr-only">Counting…</span>
      </>
    );
  if (failed) return <span className="text-fg-muted">Not counted</span>;
  return <span className="text-fg-muted">{peopleText(n, atLeast)}</span>;
}

function RoleCard({
  id,
  name,
  count,
}: {
  id: string;
  name: string;
  count: React.ReactNode;
}): React.ReactElement {
  const Glyph = ROLE_GLYPH[id] ?? Package;
  const copy = ROLE_COPY[id]!;
  return (
    // A subgrid row pair, so the footers' dividers line up across the cards of a row.
    <article
      data-role-card={id}
      className="row-span-2 grid grid-rows-subgrid rounded-xl border border-border bg-surface-raised light:shadow-elevation-1"
    >
      <div className="space-y-2 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-fg-strong">
          <Glyph className="size-4 shrink-0" aria-hidden="true" />
          {name}
        </h2>
        {copy.covers.map((line) => (
          <p key={line} className="text-sm text-fg-muted">
            {line}
          </p>
        ))}
      </div>
      <div className="space-y-1 border-t border-border px-5 py-3 text-xs">
        <p className="text-fg">{copy.givenBy}</p>
        <p data-role-count="">{count}</p>
      </div>
    </article>
  );
}

function Tick(): React.ReactElement {
  return (
    <span role="img" aria-label="Manage" className="inline-flex text-success">
      <Check className="size-4" aria-hidden="true" />
    </span>
  );
}

function Cell({
  cell,
  role,
  picked,
}: {
  cell: RolesMatrixCell;
  role: RoleId;
  picked: boolean;
}): React.ReactElement {
  return (
    <td
      data-role-col={role}
      className={cn(
        TABLE.cell,
        "text-center",
        // A phone shows the Area column and the picked role's only.
        !picked && "max-sm:hidden",
      )}
    >
      {cell.kind === "tick" ? (
        <Tick />
      ) : cell.kind === "none" ? (
        <span className="text-fg-muted">
          <span aria-hidden="true">—</span>
          <span className="sr-only">No access</span>
        </span>
      ) : (
        <span
          aria-describedby={`roles-note-${cell.note}`}
          className="text-sm font-medium text-fg-strong"
        >
          {cell.word}
        </span>
      )}
    </td>
  );
}

function AreaCell({ row }: { row: RolesMatrixRow }): React.ReactElement {
  const service = ROW_SERVICE[row.id];
  const Icon = ROW_ICON[row.id] ?? LayoutDashboard;
  return (
    <th scope="row" className={cn(TABLE.cell, "text-start font-normal")}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted">
          {service ? (
            <ServiceGlyph id={service} size={16} />
          ) : (
            <Icon className="size-4" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-fg-strong">{row.name}</span>
          {row.detail ? (
            <span className="block text-xs text-fg-muted">{row.detail}</span>
          ) : null}
        </span>
      </div>
    </th>
  );
}

function GroupRow({
  label,
  picked,
}: {
  label: string;
  picked: string;
}): React.ReactElement {
  // One cell per column, hidden like the cells under it: a spanning cell would keep the phone's
  // hidden columns in the table's grid.
  const band = "border-b border-border bg-surface-sunken";
  return (
    <tr data-group-row="">
      <th
        scope="row"
        className={cn(
          band,
          "px-3 py-2 text-start text-xs font-medium text-fg-muted",
        )}
      >
        {label}
      </th>
      {ROLES_MATRIX.roles.map((r) => (
        <td
          key={r.id}
          aria-hidden="true"
          className={cn(band, r.id !== picked && "max-sm:hidden")}
        />
      ))}
    </tr>
  );
}

function MatrixRows({
  rows,
  picked,
}: {
  rows: readonly RolesMatrixRow[];
  picked: string;
}): React.ReactElement {
  return (
    <>
      {rows.map((row) => (
        <tr
          key={row.id}
          data-matrix-row={row.id}
          className={cn(
            TABLE.rowComfortable,
            "[&>*]:border-b [&>*]:border-border",
          )}
        >
          <AreaCell row={row} />
          {ROLES_MATRIX.roles.map((role, i) => (
            <Cell
              key={role.id}
              cell={row.cells[i]!}
              role={role.id}
              picked={role.id === picked}
            />
          ))}
        </tr>
      ))}
    </>
  );
}

export function PlatformRoles({
  view,
  loading,
  error,
  onRetry,
}: {
  view: MembersView | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const [picked, setPicked] = React.useState<string>("product_admin");
  const counts = React.useMemo(() => holdersOf(view), [view]);
  const failed = !view && error !== null && error !== undefined;
  const atLeast = Boolean(view?.truncated || view?.incomplete);
  const countOf = (id: string): React.ReactNode => (
    <Count
      n={counts[id] ?? 0}
      loading={loading}
      failed={failed}
      atLeast={atLeast}
    />
  );
  const roleName = (id: string): string =>
    ROLES_MATRIX.roles.find((r) => r.id === id)?.name ?? id;
  const pickedCopy = ROLE_COPY[picked]!;

  return (
    <div className="space-y-6" data-roles-tab="">
      {failed ? (
        <ErrorState
          compact
          error={error}
          onRetry={onRetry}
          thing="The member counts"
          context={{ thing: "members" }}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 max-sm:hidden sm:grid-cols-2 xl:grid-cols-4">
        {ROLES_MATRIX.roles.map((r) => (
          <RoleCard key={r.id} id={r.id} name={r.name} count={countOf(r.id)} />
        ))}
      </div>

      <div className="space-y-3 sm:hidden">
        <div role="group" aria-label="Role" className="grid grid-cols-2 gap-2">
          {ROLES_MATRIX.roles.map((r) => {
            const Glyph = ROLE_GLYPH[r.id] ?? Package;
            const on = r.id === picked;
            return (
              <button
                key={r.id}
                type="button"
                aria-pressed={on}
                aria-controls="roles-detail"
                onClick={() => setPicked(r.id)}
                className={cn(
                  "flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 text-start",
                  "focus-visible:outline-2 focus-visible:outline-focus",
                  on
                    ? "border-accent bg-accent-subtle"
                    : "border-border bg-surface-raised",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-fg-strong">
                  <Glyph className="size-3.5 shrink-0" aria-hidden="true" />
                  {r.name}
                </span>
                <span className="text-xs">{countOf(r.id)}</span>
              </button>
            );
          })}
        </div>
        <div
          id="roles-detail"
          aria-live="polite"
          className="space-y-1 text-sm text-fg-muted"
        >
          {pickedCopy.covers.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p>{pickedCopy.givenBy}.</p>
        </div>
      </div>

      <Section
        title="What each role can do"
        description="A person’s roles add up"
        actions={
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <Check className="size-4 text-success" aria-hidden="true" />
            Manage
          </span>
        }
        className="[&>div:last-child]:p-0"
      >
        <ScrollTable
          label="What each role can do"
          caption="What each role can do, by area"
          className={cn(TABLE.table, "max-sm:table-fixed")}
        >
          <thead className={TABLE.head}>
            <tr className={TABLE.headRow}>
              <th
                scope="col"
                className={cn(
                  TABLE.headCell,
                  "text-start sm:w-[300px] xl:w-[380px] max-sm:w-3/5",
                )}
              >
                Area
              </th>
              {ROLES_MATRIX.roles.map((r) => {
                const Glyph = ROLE_GLYPH[r.id] ?? Package;
                return (
                  <th
                    key={r.id}
                    scope="col"
                    data-role-col={r.id}
                    className={cn(
                      TABLE.headCell,
                      "text-center max-sm:whitespace-normal",
                      r.id !== picked && "max-sm:hidden",
                    )}
                  >
                    <span className="inline-flex items-center justify-center gap-1.5">
                      <Glyph
                        className="size-3.5 shrink-0 max-sm:hidden"
                        aria-hidden="true"
                      />
                      {r.name}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <GroupRow label="In a product" picked={picked} />
            <MatrixRows rows={ROLES_MATRIX.productRows} picked={picked} />
            <GroupRow label="Platform" picked={picked} />
            <MatrixRows rows={ROLES_MATRIX.platformRows} picked={picked} />
          </tbody>
        </ScrollTable>
        <ul
          aria-label="Notes"
          className="flex flex-col gap-1 border-t border-border px-5 py-4 text-xs text-fg-muted"
        >
          {ROLES_MATRIX.footnotes.map((f) => (
            <li key={f.id} id={`roles-note-${f.id}`}>
              <strong className="font-medium text-fg-strong">{f.word}</strong>{" "}
              {f.role
                ? `${roleName(f.role)}: ${f.text.charAt(0).toLowerCase()}${f.text.slice(1)}`
                : f.text}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
