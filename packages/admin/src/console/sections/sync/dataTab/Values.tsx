/**
 * Users → Data → Values (server mode only): what the person's settings and records hold, read on
 * request. Showing values needs a sign-in from the last 5 minutes and is audited, so the section
 * starts closed and reads nothing until "Show values". A read the Worker refuses for a stale
 * sign-in asks for a new one and, on return, opens again (`stashKey`).
 */

import * as React from "react";
import {
  useInfiniteQuery,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  SyncJsonValue,
  SyncSubjectCollection,
  SyncValuesResponse,
  SyncValueRecord,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { readStash, hasSavedStepUp } from "../../../../lib/stepUp.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { ScrollTable } from "../../../../ui/ScrollTable.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { TABLE } from "../../../../ui/classes.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { syncRecordsQuery, syncValuesQuery } from "../data.js";
import { formatStorage } from "../pages/usageParts.js";
import { useFileDownload } from "./Download.js";
import { FileHistory, type HistoryTarget } from "./FileHistory.js";
import { needsSignIn, SignInAgain } from "./SignInAgain.js";
import type { SubjectData } from "./index.js";

const head = cn(TABLE.headCell, "text-start");
const headNum = cn(TABLE.headCell, "text-end");
const cell = cn(TABLE.cell, "py-2 align-top");
const num = cn(cell, "text-end whitespace-nowrap tabular-nums");
const MAX_SHOWN = 160;

/** A value as one line of JSON, cut at `MAX_SHOWN` characters (the full text is the tooltip). */
function show(v: SyncJsonValue | null): { text: string; whole: string } {
  const whole = JSON.stringify(v) ?? "null";
  return {
    whole,
    text:
      whole.length > MAX_SHOWN ? `${whole.slice(0, MAX_SHOWN - 1)}…` : whole,
  };
}

function ValueCell({
  value,
  sealed,
  file,
}: {
  value: SyncJsonValue | null;
  sealed: boolean;
  file?: boolean;
}): React.ReactElement {
  if (sealed) return <span className="text-fg-muted">Sealed</span>;
  if (value === null && file)
    return <span className="text-fg-muted">File only</span>;
  const v = show(value);
  return (
    <code
      className="block max-w-[28rem] break-all font-mono text-xs"
      title={v.whole}
    >
      {v.text}
    </code>
  );
}

function SettingValues({
  q,
}: {
  q: UseQueryResult<SyncValuesResponse>;
}): React.ReactElement | null {
  if (!q.data) return null;
  const settings = q.data.settings ?? [];
  if (settings.length === 0)
    return (
      <p className="px-5 py-4 text-sm text-fg-muted">No settings stored.</p>
    );
  return (
    <ScrollTable label="Setting values" className={TABLE.table}>
      <thead className={TABLE.head}>
        <tr className={TABLE.headRow}>
          <th scope="col" className={head}>
            Setting
          </th>
          <th scope="col" className={head}>
            Value
          </th>
          <th scope="col" className={headNum}>
            Size
          </th>
          <th scope="col" className={head}>
            Updated
          </th>
        </tr>
      </thead>
      <tbody>
        {settings.map((s) => (
          <tr key={`${s.key}:${s.platform ?? ""}`} className={TABLE.row}>
            <th
              scope="row"
              className={cn(
                cell,
                "text-start font-mono text-xs font-normal text-fg-strong",
              )}
            >
              {s.key}
              {s.platform ? (
                <span className="block font-sans text-fg-muted">
                  {s.platform}
                </span>
              ) : null}
            </th>
            <td className={cell}>
              <ValueCell value={s.value} sealed={s.sealed} />
            </td>
            <td className={num}>{formatStorage(s.bytes)}</td>
            <td className={cn(cell, "whitespace-nowrap")}>
              <Timestamp at={fromSeconds(s.updatedAt)} />
            </td>
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  );
}

function Records({
  slug,
  subject,
  collection,
  stashKey,
  onHistory,
  download,
  busy,
  refused,
}: {
  slug: string;
  subject: string;
  collection: SyncSubjectCollection;
  stashKey: string;
  onHistory: (t: HistoryTarget) => void;
  download: (collection: string, id: string, version?: number) => void;
  busy: string | null;
  refused: boolean;
}): React.ReactElement {
  const q = useInfiniteQuery(syncRecordsQuery(slug, subject, collection.name));
  if (q.data === undefined && !q.isError)
    return <Skeleton className="h-24 w-full rounded-lg" />;
  if (q.isError && q.data === undefined)
    return (
      <div className="p-4">
        {needsSignIn(q.error) ? (
          <SignInAgain what="show records" stashKey={stashKey} />
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
  const records: SyncValueRecord[] = (q.data?.pages ?? []).flatMap(
    (p) => p.records,
  );
  return (
    <>
      {refused ? (
        <div className="p-4">
          <SignInAgain what="download this file" stashKey={stashKey} />
        </div>
      ) : null}
      {records.length === 0 ? (
        <p className="px-5 py-4 text-sm text-fg-muted">No records stored.</p>
      ) : (
        <ScrollTable
          label={`${collection.label} records`}
          className={TABLE.table}
        >
          <thead className={TABLE.head}>
            <tr className={TABLE.headRow}>
              <th scope="col" className={head}>
                Record
              </th>
              <th scope="col" className={head}>
                Value
              </th>
              <th scope="col" className={headNum}>
                Size
              </th>
              <th scope="col" className={head}>
                Updated
              </th>
              <th scope="col" className={head}>
                File
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} className={TABLE.row}>
                <th
                  scope="row"
                  className={cn(
                    cell,
                    "text-start font-mono text-xs font-normal text-fg-strong break-all",
                  )}
                >
                  {r.id}
                </th>
                <td className={cell}>
                  <ValueCell
                    value={r.value}
                    sealed={r.sealed}
                    file={!!r.file}
                  />
                </td>
                <td className={num}>{formatStorage(r.bytes)}</td>
                <td className={cn(cell, "whitespace-nowrap")}>
                  <Timestamp at={fromSeconds(r.updatedAt)} />
                </td>
                <td className={cell}>
                  {r.file ? (
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="tabular-nums">
                        {formatStorage(r.file.size)}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        loading={busy === `${collection.name}/${r.id}/`}
                        aria-label={`Download file of ${r.id}`}
                        onClick={() => download(collection.name, r.id)}
                      >
                        Download
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`History of ${r.id}`}
                        onClick={() =>
                          onHistory({
                            collection: collection.name,
                            id: r.id,
                            file: r.file!,
                          })
                        }
                      >
                        History
                      </Button>
                    </div>
                  ) : (
                    <span className="text-fg-muted">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
      {q.hasNextPage ? (
        <div className="border-t border-border px-5 py-3">
          <Button
            size="sm"
            variant="outline"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            Show more
          </Button>
        </div>
      ) : null}
      {q.isError ? (
        <div className="px-5 pb-3">
          {needsSignIn(q.error) ? (
            <SignInAgain what="show more" stashKey={stashKey} />
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
  const [shown, setShown] = React.useState(() => hasSavedStepUp(stashKey));
  const [picked, setPicked] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<HistoryTarget | null>(null);
  const files = useFileDownload(slug, subject);
  React.useEffect(() => {
    // Back from the sign-in: the section opens again, once.
    readStash(stashKey, true);
  }, [stashKey]);

  const values = useQuery({
    ...syncValuesQuery(slug, subject),
    enabled: shown,
  });
  const browsable = data.collections.filter((c) => c.records > 0);
  const current = browsable.find((c) => c.name === picked) ?? browsable[0];
  return (
    <SettingsSection
      id="sync-data-values"
      title="Values"
      description={
        shown
          ? undefined
          : "Reading them needs a recent sign-in and is recorded in the audit log."
      }
      actions={
        <Button
          size="sm"
          variant="outline"
          aria-expanded={shown}
          onClick={() => {
            setShown((v) => !v);
            setHistory(null);
          }}
        >
          {shown ? "Hide values" : "Show values"}
        </Button>
      }
    >
      {shown && values.isPending ? (
        <div className="p-4">
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ) : shown && values.isError ? (
        <div className="p-4">
          {needsSignIn(values.error) ? (
            <SignInAgain what="show values" stashKey={stashKey} />
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
      ) : shown ? (
        <>
          <SettingValues q={values} />
          {current ? (
            <div className="border-t border-border">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <h3 className="text-sm font-semibold text-fg-strong">
                  Records
                  <span className="ms-2 font-normal text-fg-muted">
                    {formatCount(current.records)} in {current.label}
                  </span>
                </h3>
                {browsable.length > 1 && browsable.length <= 4 ? (
                  <SegmentedControl
                    aria-label="Collection"
                    size="sm"
                    wrap
                    value={current.name}
                    onChange={setPicked}
                    options={browsable.map((c) => ({
                      value: c.name,
                      label: c.label,
                    }))}
                  />
                ) : null}
              </div>
              <Records
                key={current.name}
                slug={slug}
                subject={subject}
                collection={current}
                stashKey={stashKey}
                onHistory={setHistory}
                download={files.download}
                busy={files.busy}
                refused={files.refused}
              />
            </div>
          ) : null}
          <FileHistory
            slug={slug}
            subject={subject}
            target={history}
            onClose={() => setHistory(null)}
            download={files.download}
            busy={files.busy}
            refused={files.refused}
            stashKey={stashKey}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
