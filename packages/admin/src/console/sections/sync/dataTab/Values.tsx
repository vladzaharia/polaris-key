/**
 * Users → Data → Values (server mode only): what the person's settings and records hold, read on
 * request. Showing values needs a sign-in from the last 5 minutes and is audited, so the section
 * starts closed and reads nothing until "Show values". A read the Worker refuses for a stale
 * sign-in asks for a new one and, on return, opens again at this section, with the same collection
 * picked and the same record open (`stashKey`).
 *
 * A row clamps its value to two lines (a card on a phone); the record drawer reads it whole.
 * Names, sizes and ages of the settings are in the Settings section above, so the settings here
 * show only the value.
 */

import * as React from "react";
import {
  useInfiniteQuery,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type {
  SyncJsonValue,
  SyncSubjectCollection,
  SyncSubjectFile,
  SyncValuesResponse,
  SyncValueRecord,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { readStash, hasSavedStepUp } from "../../../../lib/stepUp.js";
import { Button } from "../../../../ui/Button.js";
import { useNarrowRem } from "../../../../ui/data-table/DataTable.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { ScrollTable } from "../../../../ui/ScrollTable.js";
import { Select } from "../../../../ui/Select.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { TABLE } from "../../../../ui/classes.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { syncRecordsQuery, syncValuesQuery } from "../data.js";
import { formatStorage } from "../pages/usageParts.js";
import { useFileDownload } from "./Download.js";
import { RecordDrawer, type RecordTarget } from "./RecordDrawer.js";
import { needsSignIn, SignInAgain } from "./SignInAgain.js";
import { ClampedValue } from "./ValueView.js";
import type { SubjectData } from "./index.js";

/** The phone layout (cards) applies below `sm`, 40 rem of the root font, so enlarged text gets it too. */
const CARDS_BELOW_REM = 40;

const head = cn(TABLE.headCell, "text-start");
const headNum = cn(TABLE.headCell, "text-end");
const cell = cn(TABLE.cell, "py-2 align-top border-b border-border");
const num = cn(cell, "text-end whitespace-nowrap tabular-nums");
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One row of values: a setting (name and value) or a record (also size, age and file). */
interface Row {
  key: string;
  name: string;
  /** A second line under the name (a setting's platform). */
  sub?: string;
  value: SyncJsonValue | null;
  sealed: boolean;
  /** Records only. */
  facts?: { bytes: number; updatedAt: number; file?: SyncSubjectFile };
  open: () => void;
}

function NameButton({ row }: { row: Row }): React.ReactElement {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={row.open}
      className="min-h-6 text-start font-mono text-xs text-fg-strong underline-offset-2 [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2"
    >
      {row.name}
    </button>
  );
}

/** Rows as a table from `sm` up, and as cards on a phone (EXPERIENCE §6). */
function ValueRows({
  label,
  nameHead,
  rows,
}: {
  label: string;
  nameHead: string;
  rows: readonly Row[];
}): React.ReactElement {
  const cards = useNarrowRem(CARDS_BELOW_REM);
  const facts = rows.some((r) => r.facts);
  if (cards)
    return (
      <ul aria-label={label} className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key}>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={r.open}
              className="flex w-full items-center gap-3 px-5 py-3 text-start focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2"
            >
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block font-mono text-xs text-fg-strong [overflow-wrap:anywhere]">
                  {r.name}
                  {r.sub ? (
                    <span className="block font-sans text-fg-muted">
                      {r.sub}
                    </span>
                  ) : null}
                </span>
                <ClampedValue
                  value={r.value}
                  sealed={r.sealed}
                  fileOnly={!!r.facts?.file}
                />
                {r.facts ? (
                  <span className="block text-xs text-fg-muted">
                    {formatStorage(r.facts.bytes)}
                    {" · "}
                    <Timestamp at={fromSeconds(r.facts.updatedAt)} />
                    {r.facts.file
                      ? ` · File ${formatStorage(r.facts.file.size)}`
                      : ""}
                  </span>
                ) : null}
              </span>
              <ChevronRight
                aria-hidden
                className="size-4 shrink-0 text-fg-muted rtl:rotate-180"
              />
            </button>
          </li>
        ))}
      </ul>
    );
  return (
    <ScrollTable label={label} className={TABLE.table}>
      <thead className={TABLE.head}>
        <tr className={TABLE.headRow}>
          <th scope="col" className={head}>
            {nameHead}
          </th>
          <th scope="col" className={head}>
            Value
          </th>
          {facts ? (
            <>
              <th scope="col" className={headNum}>
                Size
              </th>
              <th scope="col" className={head}>
                Updated
              </th>
              <th scope="col" className={head}>
                File
              </th>
            </>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={TABLE.row}>
            <th
              scope="row"
              className={cn(cell, "min-w-32 max-w-64 text-start font-normal")}
            >
              <NameButton row={r} />
              {r.sub ? (
                <span className="block text-xs text-fg-muted">{r.sub}</span>
              ) : null}
            </th>
            <td className={cn(cell, "min-w-64")}>
              <ClampedValue
                value={r.value}
                sealed={r.sealed}
                fileOnly={!!r.facts?.file}
              />
            </td>
            {facts ? (
              <>
                <td className={num}>
                  {r.facts ? formatStorage(r.facts.bytes) : null}
                </td>
                <td className={cn(cell, "whitespace-nowrap")}>
                  {r.facts ? (
                    <Timestamp at={fromSeconds(r.facts.updatedAt)} />
                  ) : null}
                </td>
                <td className={cn(cell, "whitespace-nowrap tabular-nums")}>
                  {r.facts?.file ? (
                    formatStorage(r.facts.file.size)
                  ) : (
                    <span className="text-fg-muted">None</span>
                  )}
                </td>
              </>
            ) : null}
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  );
}

function SettingValues({
  q,
  onOpen,
}: {
  q: UseQueryResult<SyncValuesResponse>;
  onOpen: (t: RecordTarget) => void;
}): React.ReactElement | null {
  if (!q.data) return null;
  const settings = q.data.settings ?? [];
  if (settings.length === 0)
    return (
      <p className="px-5 py-4 text-sm text-fg-muted">No settings stored.</p>
    );
  const rows: Row[] = settings.map((s) => ({
    key: `${s.key}:${s.platform ?? ""}`,
    name: s.key,
    ...(s.platform ? { sub: cap(s.platform) } : {}),
    value: s.value,
    sealed: s.sealed,
    open: () =>
      onOpen({
        name: s.key,
        where: "Settings",
        bytes: s.bytes,
        updatedAt: s.updatedAt,
        value: s.value,
        sealed: s.sealed,
      }),
  }));
  return <ValueRows label="Setting values" nameHead="Setting" rows={rows} />;
}

function Records({
  slug,
  subject,
  collection,
  stashKey,
  onOpen,
  reopen,
}: {
  slug: string;
  subject: string;
  collection: SyncSubjectCollection;
  stashKey: string;
  onOpen: (t: RecordTarget) => void;
  /** A record to open once it is listed (back from the sign-in). */
  reopen: string | null;
}): React.ReactElement {
  const q = useInfiniteQuery(syncRecordsQuery(slug, subject, collection.name));
  const end = React.useRef<HTMLParagraphElement>(null);
  const [focusEnd, setFocusEnd] = React.useState(false);
  const records: SyncValueRecord[] = (q.data?.pages ?? []).flatMap(
    (p) => p.records,
  );
  const target = (r: SyncValueRecord): RecordTarget => ({
    name: r.id,
    where: collection.label,
    collection: collection.name,
    version: r.version,
    bytes: r.bytes,
    updatedAt: r.updatedAt,
    value: r.value,
    sealed: r.sealed,
    ...(r.file ? { file: r.file } : {}),
  });
  const reopened = React.useRef(false);
  React.useEffect(() => {
    if (reopen === null || reopened.current) return;
    const r = records.find((x) => x.id === reopen);
    if (!r) return;
    reopened.current = true;
    onOpen(target(r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records.length, reopen]);
  const last = !q.hasNextPage && (q.data?.pages.length ?? 0) > 1;
  React.useEffect(() => {
    if (focusEnd && last) {
      end.current?.focus();
      setFocusEnd(false);
    }
  }, [focusEnd, last]);

  if (q.data === undefined && !q.isError)
    return (
      <div role="status">
        <span className="sr-only">Loading records</span>
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  if (q.isError && q.data === undefined)
    return (
      <div className="p-4">
        {needsSignIn(q.error) ? (
          <SignInAgain
            what="show records"
            stashKey={stashKey}
            fields={{ collection: collection.name }}
          />
        ) : (
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            thing="Records"
            context={{ read: true, thing: "Records" }}
            compact
          />
        )}
      </div>
    );
  const rows: Row[] = records.map((r) => ({
    key: r.id,
    name: r.id,
    value: r.value,
    sealed: r.sealed,
    facts: {
      bytes: r.bytes,
      updatedAt: r.updatedAt,
      ...(r.file ? { file: r.file } : {}),
    },
    open: () => onOpen(target(r)),
  }));
  const more = async (): Promise<void> => {
    const before = records.length;
    const res = await q.fetchNextPage();
    const after = (res.data?.pages ?? []).flatMap((p) => p.records).length;
    if (after > before)
      announce(
        `${formatCount(after - before)} more ${after - before === 1 ? "record" : "records"}`,
      );
    if (res.hasNextPage === false) setFocusEnd(true);
  };
  return (
    <>
      {records.length === 0 ? (
        <p className="px-5 py-4 text-sm text-fg-muted">No records stored.</p>
      ) : (
        <ValueRows
          label={`${collection.label} records`}
          nameHead="Record"
          rows={rows}
        />
      )}
      {q.hasNextPage ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
          <Button
            size="sm"
            variant="outline"
            loading={q.isFetchingNextPage}
            onClick={() => void more()}
          >
            Show more
          </Button>
          <span className="text-sm text-fg-muted">
            {formatCount(records.length)} of {formatCount(collection.records)}
          </span>
        </div>
      ) : last ? (
        <p
          ref={end}
          tabIndex={-1}
          className="border-t border-border px-5 py-3 text-sm text-fg-muted outline-hidden"
        >
          All {formatCount(records.length)} records shown
        </p>
      ) : null}
      {q.isError ? (
        <div className="px-5 pb-3">
          {needsSignIn(q.error) ? (
            <SignInAgain
              what="show more"
              stashKey={stashKey}
              fields={{ collection: collection.name }}
            />
          ) : (
            <ErrorState
              error={q.error}
              onRetry={() => void q.fetchNextPage()}
              thing="More records"
              context={{ read: true, thing: "Records" }}
              compact
            />
          )}
        </div>
      ) : null}
    </>
  );
}

export function Values({
  slug,
  subject,
  data,
}: {
  slug: string;
  subject: string;
  data: SubjectData;
}): React.ReactElement {
  const stashKey = `sync-values:${subject}`;
  // Back from the sign-in: the saved state, read once here and removed after the first paint.
  const [back] = React.useState(() => readStash(stashKey, false));
  const [shown, setShown] = React.useState(() => hasSavedStepUp(stashKey));
  const [picked, setPicked] = React.useState<string | null>(
    back?.fields.collection ?? null,
  );
  const [openTarget, setOpenTarget] = React.useState<RecordTarget | null>(null);
  const files = useFileDownload(slug, subject);
  const narrow = useNarrowRem(CARDS_BELOW_REM);
  React.useEffect(() => {
    if (back === null) return;
    readStash(stashKey, true);
    // Land on this section, not the top of the tab.
    document
      .getElementById("sync-data-values")
      ?.scrollIntoView?.({ block: "start" });
    const h = document.getElementById("sync-data-values-heading");
    if (h) {
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
  }, [back, stashKey]);

  const values = useQuery({
    ...syncValuesQuery(slug, subject),
    enabled: shown,
  });
  const browsable = data.collections.filter((c) => c.records > 0);
  const current = browsable.find((c) => c.name === picked) ?? browsable[0];
  const stashFields: Record<string, string> = {
    ...(current ? { collection: current.name } : {}),
    ...(openTarget?.collection ? { record: openTarget.name } : {}),
  };
  const close = (): void => {
    setOpenTarget(null);
    files.clear();
  };
  const picker =
    browsable.length < 2 ? null : browsable.length <= 4 && !narrow ? (
      <SegmentedControl
        aria-label="Collection"
        size="sm"
        wrap
        value={current?.name ?? ""}
        onChange={setPicked}
        options={browsable.map((c) => ({ value: c.name, label: c.label }))}
      />
    ) : (
      <div className="w-full sm:w-64">
        <Select
          aria-label="Collection"
          value={current?.name ?? null}
          onChange={(v) => v && setPicked(v)}
          options={browsable.map((c) => ({
            value: c.name,
            label: `${c.label} · ${formatCount(c.records)}`,
          }))}
        />
      </div>
    );
  return (
    <SettingsSection
      id="sync-data-values"
      title="Values"
      actions={
        <Button
          size="sm"
          variant="outline"
          aria-expanded={shown}
          onClick={() => {
            setShown((v) => !v);
            close();
          }}
        >
          {shown && values.isSuccess ? "Hide values" : "Show values"}
        </Button>
      }
    >
      {!shown ? (
        <p className="px-5 py-4 text-sm text-fg-muted">
          Reading them needs a recent sign-in and is recorded in the audit log.
        </p>
      ) : values.isPending ? (
        <div className="p-4" role="status">
          <span className="sr-only">Loading values</span>
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ) : values.isError ? (
        <div className="p-4">
          {needsSignIn(values.error) ? (
            <SignInAgain
              what="show values"
              stashKey={stashKey}
              fields={stashFields}
            />
          ) : (
            <ErrorState
              error={values.error}
              onRetry={() => void values.refetch()}
              thing="Values"
              context={{ read: true, thing: "Values" }}
              compact
            />
          )}
        </div>
      ) : (
        <>
          <SettingValues q={values} onOpen={setOpenTarget} />
          {current ? (
            <div className="border-t border-border">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <h3 className="text-sm font-semibold text-fg-strong">
                  Records
                </h3>
                {picker ?? (
                  <span className="text-sm text-fg-muted">
                    {formatCount(current.records)} in {current.label}
                  </span>
                )}
              </div>
              <Records
                key={current.name}
                slug={slug}
                subject={subject}
                collection={current}
                stashKey={stashKey}
                onOpen={setOpenTarget}
                reopen={back?.fields.record ?? null}
              />
            </div>
          ) : null}
          <RecordDrawer
            slug={slug}
            subject={subject}
            target={openTarget}
            onClose={close}
            files={files}
            stashKey={stashKey}
            stashFields={stashFields}
          />
        </>
      )}
    </SettingsSection>
  );
}
