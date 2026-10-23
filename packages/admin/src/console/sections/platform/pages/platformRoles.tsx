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
import { Check } from "lucide-react";
import { ApiError, type MembersView } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { ROLE_GLYPHS } from "../../../access/RoleTag.js";
import { Section } from "../../../../ui/Section.js";
import { TABLE } from "../../../../ui/classes.js";
import { ROLES_MATRIX } from "../../../access/rolesMatrix.generated.js";

import {
  CARDS_SHOWN,
  Count,
  type CountState,
  GroupRow,
  MatrixRows,
  ROLE_COPY,
  ROLE_GLYPH,
  RoleCard,
  RolePicker,
  TILES_SHOWN,
  holdersOf,
  notesOf,
  useMedia,
} from "./platformRolesParts.js";

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
          You can't see who holds each role.
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
            A person's roles add up
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
