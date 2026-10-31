/**
 * Users → Data → Values: one setting or record, whole. The value pretty-printed with Copy, and for
 * a record with a file, its current version and the older ones it keeps, each with Download. A
 * row clamps its value to two lines; this is where the rest is read, by keyboard or touch.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../../../../lib/cn.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Drawer, DrawerBody } from "../../../../ui/Drawer.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { ScrollTable } from "../../../../ui/ScrollTable.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { TABLE } from "../../../../ui/classes.js";
import type { SyncJsonValue, SyncSubjectFile } from "../../../../api.js";
import { syncRevisionsQuery } from "../data.js";
import { formatStorage } from "../pages/usageParts.js";
import { downloadKey, type DownloadState } from "./Download.js";
import { PrettyJson, prettyJson } from "./ValueView.js";
import { needsSignIn, SignInAgain } from "./SignInAgain.js";

export interface RecordTarget {
  /** The setting's key or the record's id. */
  name: string;
  /** "Setting", or the collection's label. */
  where: string;
  /** The collection's name, for a record. */
  collection?: string;
  /** The record's version. */
  version?: number;
  bytes: number;
  updatedAt: number;
  value: SyncJsonValue | null;
  sealed: boolean;
  file?: SyncSubjectFile;
}

const head = cn(TABLE.headCell, "text-start");
const cell = cn(TABLE.cell, "py-2 whitespace-nowrap");

function FileBlock({
  slug,
  subject,
  t,
  files,
  stashKey,
  stashFields,
}: {
  slug: string;
  subject: string;
  t: RecordTarget & { collection: string; file: SyncSubjectFile };
  files: DownloadState;
  stashKey: string;
  stashFields: Record<string, string>;
}): React.ReactElement {
  const q = useQuery(syncRevisionsQuery(slug, subject, t.collection, t.name));
  const rows = [
    { version: t.file.version, size: t.file.size, current: true },
    ...(q.data?.revisions ?? []).map((r) => ({
      version: r.version,
      size: r.size,
      current: false,
      createdAt: r.createdAt,
    })),
  ];
  const req = (version: number, current: boolean) => ({
    collection: t.collection,
    id: t.name,
    label: version,
    ...(current ? {} : { version }),
  });
  const progress = files.progress;
  return (
    <section aria-labelledby="record-file" className="space-y-3">
      <h3 id="record-file" className="text-sm font-semibold text-fg-strong">
        File
      </h3>
      {files.refused ? (
        <SignInAgain
          what="download this file"
          stashKey={stashKey}
          fields={stashFields}
        />
      ) : null}
      {files.failed ? (
        <Callout
          alert
          tone="danger"
          title={`Couldn't download ${files.failed.name}`}
          action={
            <Button size="sm" onClick={files.failed.retry}>
              Try again
            </Button>
          }
        >
          The file didn't arrive. Nothing was saved.
        </Callout>
      ) : null}
      {files.busy !== null ? (
        <p role="status" className="text-sm text-fg-muted">
          {progress && progress.total > 0
            ? `Downloading ${Math.min(100, Math.floor((progress.loaded / progress.total) * 100))} %`
            : progress
              ? `Downloading, ${formatStorage(progress.loaded)} so far`
              : "Downloading"}
        </p>
      ) : null}
      {q.isError && !needsSignIn(q.error) ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          thing="File history"
          context={{ read: true, thing: "File history" }}
          compact
        />
      ) : null}
      {q.isError && needsSignIn(q.error) ? (
        <SignInAgain
          what="show its history"
          stashKey={stashKey}
          fields={stashFields}
        />
      ) : null}
      {q.isPending ? <Skeleton className="h-16 w-full rounded-lg" /> : null}
      {q.data ? (
        <ScrollTable label="File versions" className={TABLE.table}>
          <thead className={TABLE.head}>
            <tr className={TABLE.headRow}>
              <th scope="col" className={head}>
                Version
              </th>
              <th scope="col" className={cn(TABLE.headCell, "text-end")}>
                Size
              </th>
              <th scope="col" className={head}>
                Saved
              </th>
              <th scope="col" className={head}>
                <span className="sr-only">Download</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => {
              const r = req(v.version, v.current);
              const mine = files.busy === downloadKey(r);
              return (
                <tr key={v.version} className={TABLE.row}>
                  <th
                    scope="row"
                    className={cn(
                      cell,
                      "text-start font-normal border-b border-border",
                    )}
                  >
                    {v.version}
                    {v.current ? (
                      <span className="ms-2 text-xs text-fg-muted">
                        Current
                      </span>
                    ) : null}
                  </th>
                  <td className={cn(cell, "text-end tabular-nums")}>
                    {formatStorage(v.size)}
                  </td>
                  <td className={cell}>
                    <Timestamp
                      at={fromSeconds(
                        "createdAt" in v ? v.createdAt : t.updatedAt,
                      )}
                    />
                  </td>
                  <td className={cn(cell, "text-end")}>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={mine}
                      aria-disabled={
                        files.busy !== null && !mine ? true : undefined
                      }
                      aria-label={`Download version ${v.version}`}
                      onClick={() => files.download(r)}
                    >
                      Download
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </ScrollTable>
      ) : null}
      {q.data && q.data.revisions.length === 0 ? (
        <p className="text-sm text-fg-muted">No older versions are kept.</p>
      ) : null}
    </section>
  );
}

export function RecordDrawer({
  slug,
  subject,
  target,
  onClose,
  files,
  stashKey,
  stashFields,
}: {
  slug: string;
  subject: string;
  target: RecordTarget | null;
  onClose: () => void;
  files: DownloadState;
  stashKey: string;
  stashFields: Record<string, string>;
}): React.ReactElement {
  const open = target !== null;
  // Kept so closing the drawer does not blank it mid-animation.
  const last = React.useRef<RecordTarget | null>(target);
  if (target) last.current = target;
  const t = target ?? last.current;
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t ? <span className="font-mono text-base">{t.name}</span> : ""}
      description={
        t ? (
          <>
            In {t.where}
            {t.version !== undefined ? ` · version ${t.version}` : ""}
            {" · "}
            {formatStorage(t.bytes)}
            {" · updated "}
            <Timestamp at={fromSeconds(t.updatedAt)} />
          </>
        ) : undefined
      }
    >
      <DrawerBody className="space-y-5">
        {t ? (
          <section aria-labelledby="record-value" className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3
                id="record-value"
                className="text-sm font-semibold text-fg-strong"
              >
                Value
              </h3>
              {!t.sealed && t.value !== null ? (
                <CopyButton
                  value={prettyJson(t.value)}
                  label={`Copy value of ${t.name}`}
                  showLabel
                />
              ) : null}
            </div>
            {t.sealed ? (
              <p className="text-sm text-fg-muted">Sealed</p>
            ) : t.value === null && t.file ? (
              <p className="text-sm text-fg-muted">File only</p>
            ) : (
              <PrettyJson
                value={t.value}
                className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-sunken p-3 font-mono text-xs [overflow-wrap:anywhere]"
              />
            )}
          </section>
        ) : null}
        {t && t.file && t.collection ? (
          <FileBlock
            slug={slug}
            subject={subject}
            t={{ ...t, collection: t.collection, file: t.file }}
            files={files}
            stashKey={stashKey}
            stashFields={stashFields}
          />
        ) : null}
      </DrawerBody>
    </Drawer>
  );
}
