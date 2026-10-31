/** Users → Data → Collections: records and files per collection, and the uploads still open. */

import * as React from "react";
import type { SubjectData } from "./index.js";
import type { SyncSubjectCollection } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { ScrollTable } from "../../../../ui/ScrollTable.js";
import { TABLE } from "../../../../ui/classes.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { formatStorage } from "../pages/usageParts.js";

/** What a collection takes: records, files and the history the files keep. */
export function collectionBytes(c: SyncSubjectCollection): number {
  return c.bytes + c.fileBytes + c.revisionBytes;
}

const head = cn(TABLE.headCell, "text-start");
const headNum = cn(TABLE.headCell, "text-end");
const num = cn(TABLE.cell, "text-end whitespace-nowrap tabular-nums");

export function Collections({
  data,
}: {
  data: SubjectData;
}): React.ReactElement | null {
  const { collections, uploadsOpen } = data;
  if (collections.length === 0) return null;
  return (
    <SettingsSection id="sync-data-collections" title="Collections">
      <ScrollTable label="Collections" className={TABLE.table}>
        <thead className={TABLE.head}>
          <tr className={TABLE.headRow}>
            <th scope="col" className={head}>
              Collection
            </th>
            <th scope="col" className={headNum}>
              Records
            </th>
            <th scope="col" className={headNum}>
              Files
            </th>
            <th scope="col" className={headNum}>
              Size
            </th>
            <th scope="col" className={head}>
              Last change
            </th>
          </tr>
        </thead>
        <tbody>
          {collections.map((c) => (
            <tr key={c.name} className={TABLE.row}>
              <th
                scope="row"
                className={cn(
                  TABLE.cell,
                  "py-2 text-start font-normal border-b border-border",
                )}
              >
                <span className="block text-fg-strong">{c.label}</span>
                {c.label !== c.name ? (
                  <span className="block font-mono text-xs text-fg-muted">
                    {c.name}
                  </span>
                ) : null}
              </th>
              <td className={num}>{formatCount(c.records)}</td>
              <td className={num}>{formatCount(c.files)}</td>
              <td className={num}>
                {formatStorage(collectionBytes(c))}
                {c.revisionBytes > 0 ? (
                  <span className="block text-xs text-fg-muted">
                    {formatStorage(c.revisionBytes)} history
                  </span>
                ) : null}
              </td>
              <td className={cn(TABLE.cell, "whitespace-nowrap")}>
                {c.lastWriteAt !== null ? (
                  <Timestamp at={fromSeconds(c.lastWriteAt)} />
                ) : (
                  <span className="text-fg-muted">None</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      {uploadsOpen > 0 ? (
        <p className="border-t border-border px-5 py-3 text-sm text-fg-muted">
          {formatCount(uploadsOpen)} {uploadsOpen === 1 ? "upload" : "uploads"}{" "}
          in progress. Their space is held until they finish or expire.
        </p>
      ) : null}
    </SettingsSection>
  );
}
