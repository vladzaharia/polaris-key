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
  KeySquare,
  LayoutDashboard,
  Link2,
  Plus,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  ApiError,
  type ServiceSlug,
  type MembersView,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { ROLE_GLYPHS } from "../../../access/RoleTag.js";
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

/** The glyph of a role id, from the one map the roster's tags use (RoleTag.tsx). */
const ROLE_GLYPH: Record<string, LucideIcon> = {
  superadmin: ROLE_GLYPHS.superadmin,
  platform_admin: ROLE_GLYPHS.platform_admin,
  product_admin: ROLE_GLYPHS.product,
  console_access: ROLE_GLYPHS.console_access,
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
    covers: ["One product or all of them, narrowable by area."],
    givenBy: "Given by a Superadmin or that product’s admin",
  },
  console_access: {
    covers: ["Sign in and read the docs. Every role includes it."],
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

const NUMBER = new Intl.NumberFormat("en");

/** "2 people hold this role" on a card, "2 people" on a tile. */
export function peopleText(n: number, atLeast: boolean, long: boolean): string {
  if (n === 0)
    return atLeast
      ? "None counted"
      : long
        ? "No one holds this role"
        : "No one";
  const count = NUMBER.format(n);
  const who = n === 1 ? `${count} person` : `${count} people`;
  const text = atLeast ? `At least ${who}` : who;
  return long
    ? `${text} ${n === 1 && !atLeast ? "holds" : "hold"} this role`
    : text;
}

/** Narrow media: the picker mode of a phone (and a short window) and the phone's matrix. */
function useMedia(query: string): boolean {
  const get = (): boolean =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  return React.useSyncExternalStore(
    (cb) => {
      if (
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      )
        return () => undefined;
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    get,
    () => false,
  );
}

/** The picker (tiles) takes over from the cards on a phone and on a short window. */
const CARDS_SHOWN = "max-md:hidden [@media(max-height:500px)]:hidden";
const TILES_SHOWN = "md:hidden [@media(max-height:500px)]:block";

type CountState = { loading: boolean; failed: boolean; atLeast: boolean };

function Count({
  n,
  state,
  long,
}: {
  n: number;
  state: CountState;
  long: boolean;
}): React.ReactElement | null {
  if (state.loading)
    return (
      <>
        <Skeleton className="h-4 w-16" />
        <span className="sr-only">Counting…</span>
      </>
    );
  // The failure is said once, above; a count that was not read is not drawn.
  if (state.failed) return null;
  return (
    <span className="text-fg-muted">{peopleText(n, state.atLeast, long)}</span>
  );
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
  const Glyph = ROLE_GLYPH[id] ?? ROLE_GLYPHS.product;
  const copy = ROLE_COPY[id]!;
  return (
    // A subgrid row pair, so the footers' dividers line up across the cards of a row. Between md
    // and xl the cards are compact (tighter padding).
    <article
      data-role-card={id}
      className="row-span-2 grid grid-rows-subgrid rounded-xl border border-border bg-surface-raised light:shadow-elevation-1"
    >
      <div className="space-y-2 p-5 md:max-xl:space-y-1 md:max-xl:p-4">
        <h2 className="flex items-start gap-2 text-base font-semibold text-fg-strong">
          <Glyph className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
        </h2>
        {copy.covers.map((line) => (
          <p key={line} className="text-sm text-fg-muted">
            {line}
          </p>
        ))}
      </div>
      <div className="space-y-1 border-t border-border px-5 py-3 text-xs md:max-xl:px-4 md:max-xl:py-2">
        <p className="text-fg">{copy.givenBy}</p>
        <p data-role-count="" className="min-h-4">
          {count}
        </p>
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

/** An exception word is a link to its note: the note is focused, not navigated to (the hash is the router's). */
function WordLink({
  word,
  note,
}: {
  word: string;
  note: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-describedby={`roles-note-${note}`}
      onClick={() => {
        const el = document.getElementById(`roles-note-${note}`);
        el?.focus();
        el?.scrollIntoView?.({ block: "nearest" });
      }}
      className="rounded-sm text-sm text-fg underline decoration-dotted underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
    >
      {word}
    </button>
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
        "text-center [overflow-wrap:anywhere]",
        // A phone shows the Area column and the picked role's only.
        picked
          ? "max-md:bg-accent-subtle [@media(max-height:500px)]:bg-accent-subtle"
          : "max-sm:hidden",
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
        <WordLink word={cell.word} note={cell.note} />
      )}
    </td>
  );
}

function AreaCell({ row }: { row: RolesMatrixRow }): React.ReactElement {
  const service = ROW_SERVICE[row.id];
  const Icon = ROW_ICON[row.id] ?? LayoutDashboard;
  return (
    <th
      scope="row"
      className={cn(
        TABLE.cell,
        "py-2 text-start font-normal [overflow-wrap:anywhere]",
      )}
    >
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
            <span className="block text-xs text-fg-muted max-sm:line-clamp-1">
              {row.detail}
            </span>
          ) : null}
        </span>
      </div>
    </th>
  );
}

function GroupRow({
  label,
  picked,
  names,
}: {
  label: string;
  picked: string;
  /** A phone's column names, repeated where the header has scrolled off (it does not stick there). */
  names: boolean;
}): React.ReactElement {
  // One cell per column, hidden like the cells under it: a spanning cell would keep the phone's
  // hidden columns in the table's grid.
  const band =
    "border-b border-border bg-surface-sunken console:bg-(--pk-admin-band)";
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
          className={cn(
            band,
            "px-3 text-center text-xs font-medium text-fg-muted",
            r.id !== picked && "max-sm:hidden",
          )}
        >
          {names ? <span className="sm:hidden">{r.name}</span> : null}
        </td>
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
          className="bg-surface-raised text-sm text-fg max-sm:min-h-14 sm:h-14 [&>*]:border-b [&>*]:border-border"
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

/** The ids of the notes a role's column points at, for a phone that shows one column. */
function notesOf(roleId: string): Set<string> {
  const i = ROLES_MATRIX.roles.findIndex((r) => r.id === roleId);
  const out = new Set<string>();
  for (const row of [
    ...ROLES_MATRIX.productRows,
    ...ROLES_MATRIX.platformRows,
  ]) {
    const c = row.cells[i];
    if (c?.kind === "word") out.add(c.note);
  }
  return out;
}

/** The role picker: a radio group (one of four) with arrow keys, in a grid that follows the text size. */
function RolePicker({
  picked,
  onPick,
  count,
}: {
  picked: string;
  onPick: (id: string) => void;
  count: (id: string) => React.ReactNode;
}): React.ReactElement {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const roles = ROLES_MATRIX.roles;
  const move = (from: number, delta: number): void => {
    const next = (from + delta + roles.length) % roles.length;
    refs.current[next]?.focus();
    onPick(roles[next]!.id);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Role"
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-2"
    >
      {roles.map((r, i) => {
        const Glyph = ROLE_GLYPH[r.id] ?? ROLE_GLYPHS.product;
        const on = r.id === picked;
        return (
          <button
            key={r.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-controls="roles-detail"
            tabIndex={on ? 0 : -1}
            onClick={() => onPick(r.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cn(
              "flex min-h-14 min-w-0 flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 text-start",
              "focus-visible:outline-2 focus-visible:outline-focus",
              on
                ? "border-2 border-accent bg-accent-subtle"
                : "border-border bg-surface-raised",
            )}
          >
            <span className="flex min-w-0 items-start gap-1.5 text-sm font-medium text-fg-strong">
              <Glyph className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{r.name}</span>
            </span>
            <span className="text-xs">{count(r.id)}</span>
          </button>
        );
      })}
    </div>
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
  const phone = useMedia("(max-width: 639px)");
  const counts = React.useMemo(() => holdersOf(view), [view]);
  const failed = !view && error !== null && error !== undefined;
  const refused = failed && error instanceof ApiError && error.status === 403;
  const state: CountState = {
    loading,
    failed,
    atLeast: Boolean(view?.truncated || view?.incomplete),
  };
  const countOf =
    (long: boolean) =>
    (id: string): React.ReactNode => (
      <Count n={counts[id] ?? 0} state={state} long={long} />
    );
  const roleName = (id: string): string =>
    ROLES_MATRIX.roles.find((r) => r.id === id)?.name ?? id;
  const pickedCopy = ROLE_COPY[picked]!;
  const pickedNotes = React.useMemo(() => notesOf(picked), [picked]);

  // After a Retry that works, the alert is gone: focus moves to the cards' region.
  const region = React.useRef<HTMLDivElement>(null);
  const wasFailed = React.useRef(false);
  // The flag clears only on success: a retried query with no data goes back to pending first.
  React.useEffect(() => {
    if (failed) wasFailed.current = true;
    else if (!loading && wasFailed.current) {
      wasFailed.current = false;
      region.current?.focus();
    }
  }, [failed, loading]);

  const matrix = (
    <table className={cn(TABLE.table, "table-fixed")}>
      <caption className="sr-only">What each role can do, by area</caption>
      <thead className={TABLE.head}>
        <tr className={TABLE.headRow}>
          <th
            scope="col"
            className={cn(
              TABLE.headCell,
              "text-start [overflow-wrap:anywhere] max-sm:w-3/5 sm:w-[34%]",
            )}
          >
            Area
          </th>
          {ROLES_MATRIX.roles.map((r) => {
            const Glyph = ROLE_GLYPH[r.id] ?? ROLE_GLYPHS.product;
            return (
              <th
                key={r.id}
                scope="col"
                data-role-col={r.id}
                className={cn(
                  TABLE.headCell,
                  "text-center whitespace-normal [overflow-wrap:anywhere]",
                  r.id !== picked
                    ? "max-sm:hidden"
                    : "max-md:bg-accent-subtle [@media(max-height:500px)]:bg-accent-subtle",
                )}
              >
                {/* Inline, not a flex row: a long name at large text must be able to break. */}
                <Glyph
                  className="me-1.5 inline size-3.5 align-[-2px] max-sm:hidden"
                  aria-hidden="true"
                />
                {r.name}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        <GroupRow label="In a product" picked={picked} names={false} />
        <MatrixRows rows={ROLES_MATRIX.productRows} picked={picked} />
        <GroupRow label="Platform" picked={picked} names />
        <MatrixRows rows={ROLES_MATRIX.platformRows} picked={picked} />
      </tbody>
    </table>
  );

  return (
    <div className="w-full max-w-[1280px] space-y-6" data-roles-tab="">
      {refused ? (
        <p role="status" className="text-sm text-fg-muted">
          You can’t see who holds each role.
        </p>
      ) : failed ? (
        <ErrorState
          compact
          error={error}
          onRetry={onRetry}
          thing="The member counts"
          context={{ thing: "members" }}
        />
      ) : null}

      <div
        ref={region}
        tabIndex={-1}
        role="group"
        aria-label="Roles"
        className="space-y-6 outline-hidden"
      >
        {/* One column, two from 30rem, four from 54rem of the row's own width: rem, so large text
            drops columns, and never three and an orphan. */}
        <div className={cn("@container", CARDS_SHOWN)}>
          <div className="grid grid-cols-1 gap-4 @[30rem]:grid-cols-2 @[54rem]:grid-cols-4 md:max-xl:gap-3">
            {ROLES_MATRIX.roles.map((r) => (
              <RoleCard
                key={r.id}
                id={r.id}
                name={r.name}
                count={countOf(true)(r.id)}
              />
            ))}
          </div>
        </div>

        <div className={cn("space-y-3", TILES_SHOWN)}>
          <RolePicker
            picked={picked}
            onPick={setPicked}
            count={countOf(false)}
          />
          <div
            id="roles-detail"
            aria-live="polite"
            className="space-y-1 text-sm text-fg-muted"
          >
            {pickedCopy.covers.map((line, i) => (
              <p
                key={line}
                className={cn(
                  i > 0 && "[@media(max-height:500px)]:hidden",
                  "[@media(max-height:500px)]:truncate",
                )}
              >
                {line}
              </p>
            ))}
            <p className="[@media(max-height:500px)]:hidden">
              {pickedCopy.givenBy}.
            </p>
          </div>
        </div>
      </div>

      <Section
        title="What each role can do"
        description={
          <span className="[@media(max-height:500px)]:hidden">
            A person’s roles add up
          </span>
        }
        actions={
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <Check className="size-4 text-success" aria-hidden="true" />
            Manage
          </span>
        }
        className="[&>div:last-child]:p-0"
      >
        {phone ? (
          // Two columns fit a phone, but at 200 % text a name may not: the region scrolls.
          <div
            role="region"
            aria-label="Role matrix"
            tabIndex={0}
            className={TABLE.scroller}
          >
            {matrix}
          </div>
        ) : (
          // From sm up the matrix never scrolls sideways, so the header can stick to the page.
          matrix
        )}
        {phone && pickedNotes.size === 0 ? null : (
          <ul
            aria-label="Notes"
            className="flex flex-col gap-1 border-t border-border px-5 py-4 text-xs text-fg-muted"
          >
            {ROLES_MATRIX.footnotes.map((f) => (
              <li
                key={f.id}
                id={`roles-note-${f.id}`}
                tabIndex={-1}
                className={cn(
                  "rounded-sm outline-hidden focus:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus",
                  !pickedNotes.has(f.id) && "max-sm:hidden",
                )}
              >
                <strong className="font-medium text-fg-strong">{f.word}</strong>{" "}
                {f.role
                  ? `${roleName(f.role)}: ${f.text.charAt(0).toLowerCase()}${f.text.slice(1)}`
                  : f.text}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
