/** Users → Data → Values: a record's file, its current version and the older ones it keeps. */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Drawer, DrawerBody } from "../../../../ui/Drawer.js";
import { ScrollTable } from "../../../../ui/ScrollTable.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { TABLE } from "../../../../ui/classes.js";
import { cn } from "../../../../lib/cn.js";
import type { SyncSubjectFile } from "../../../../api.js";
import { syncRevisionsQuery } from "../data.js";
import { formatStorage } from "../pages/usageParts.js";
import { needsSignIn, SignInAgain } from "./SignInAgain.js";

export interface HistoryTarget {
  collection: string;
  id: string;
  file: SyncSubjectFile;
}

const head = cn(TABLE.headCell, "text-start");
const cell = cn(TABLE.cell, "py-2 whitespace-nowrap");

export function FileHistory({
  slug,
  subject,
  target,
  onClose,
  download,
  busy,
  refused,
  stashKey,
}: {
  slug: string;
  subject: string;
  target: HistoryTarget | null;
  onClose: () => void;
  download: (collection: string, id: string, version?: number) => void;
  busy: string | null;
  refused: boolean;
  stashKey: string;
}): React.ReactElement {
  const open = target !== null;
  // The query is keyed by the last target, so closing the drawer does not blank it mid-animation.
  const last = React.useRef<HistoryTarget | null>(target);
  if (target) last.current = target;
  const t = target ?? last.current;
  const q = useQuery({
    ...syncRevisionsQuery(slug, subject, t?.collection ?? "", t?.id ?? ""),
    enabled: open && t !== null,
  });
  const running = (version: number): boolean =>
    t !== null && busy === `${t.collection}/${t.id}/${version}`;
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="File history"
      description={
        t ? (
          <>
            <span className="font-mono text-xs">{t.id}</span> in {t.collection}
          </>
        ) : undefined
      }
    >
      <DrawerBody className="space-y-4">
        {refused ? (
          <SignInAgain what="download this file" stashKey={stashKey} />
        ) : null}
        {q.isPending && open ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : q.isError ? (
          needsSignIn(q.error) ? (
            <SignInAgain what="show its history" stashKey={stashKey} />
          ) : (
            <ErrorState
              error={q.error}
              onRetry={() => void q.refetch()}
              thing="File history"
              context={{ read: true, thing: "File history" }}
              compact
            />
          )
        ) : t && q.data ? (
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
              {[
                {
                  version: t.file.version,
                  size: t.file.size,
                  createdAt: null as number | null,
                },
                ...q.data.revisions,
              ].map((v) => (
                <tr key={v.version} className={TABLE.row}>
                  <th
                    scope="row"
                    className={cn(cell, "text-start font-normal")}
                  >
                    {v.version}
                    {v.createdAt === null ? (
                      <span className="ms-2 text-xs text-fg-muted">
                        Current
                      </span>
                    ) : null}
                  </th>
                  <td className={cn(cell, "text-end tabular-nums")}>
                    {formatStorage(v.size)}
                  </td>
                  <td className={cell}>
                    {v.createdAt === null ? (
                      <span className="text-fg-muted">Latest</span>
                    ) : (
                      <Timestamp at={fromSeconds(v.createdAt)} />
                    )}
                  </td>
                  <td className={cn(cell, "text-end")}>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={running(v.version)}
                      aria-label={`Download version ${v.version}`}
                      onClick={() => download(t.collection, t.id, v.version)}
                    >
                      Download
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        ) : null}
        {q.data && q.data.revisions.length === 0 ? (
          <p className="text-sm text-fg-muted">No older versions are kept.</p>
        ) : null}
      </DrawerBody>
    </Drawer>
  );
}
