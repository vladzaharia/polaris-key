/** Users → Data → Settings: the declared settings the person has stored, and the open ones counted. */

import * as React from "react";
import type { SubjectData } from "./index.js";
import { cn } from "../../../../lib/cn.js";
import { formatCount, fromSeconds } from "../../../../lib/format.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ScrollTable } from "../../../../ui/ScrollTable.js";
import { TABLE } from "../../../../ui/classes.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { formatStorage } from "../pages/usageParts.js";

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function SettingsTable({
  data,
}: {
  data: SubjectData;
}): React.ReactElement {
  const { declared, open } = data.settings;
  return (
    <SettingsSection id="sync-data-settings" title="Settings">
      {declared.length === 0 ? (
        <div className="px-5 py-4">
          <EmptyState
            kind="first-run"
            variant="inline"
            title="No settings stored"
          />
        </div>
      ) : (
        <ScrollTable label="Synced settings" className={TABLE.table}>
          <thead className={TABLE.head}>
            <tr className={TABLE.headRow}>
              <th scope="col" className={cn(TABLE.headCell, "text-start")}>
                Setting
              </th>
              <th scope="col" className={cn(TABLE.headCell, "text-start")}>
                Where
              </th>
              <th scope="col" className={cn(TABLE.headCell, "text-end")}>
                Size
              </th>
              <th scope="col" className={cn(TABLE.headCell, "text-start")}>
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {declared.map((s) => (
              <tr key={`${s.key}:${s.platform ?? ""}`} className={TABLE.row}>
                <th
                  scope="row"
                  className={cn(
                    TABLE.cell,
                    "py-2 text-start font-mono text-xs font-normal text-fg-strong border-b border-border",
                  )}
                >
                  {s.key}
                </th>
                <td className={cn(TABLE.cell, "whitespace-nowrap")}>
                  {s.platform ? cap(s.platform) : "Everywhere"}
                </td>
                <td
                  className={cn(
                    TABLE.cell,
                    "text-end whitespace-nowrap tabular-nums",
                  )}
                >
                  {formatStorage(s.bytes)}
                </td>
                <td className={cn(TABLE.cell, "whitespace-nowrap")}>
                  <Timestamp at={fromSeconds(s.updatedAt)} />
                </td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      )}
      {open.count > 0 ? (
        <p className="border-t border-border px-5 py-3 text-sm text-fg-muted">
          {formatCount(open.count)} open{" "}
          {open.count === 1 ? "setting" : "settings"} the catalog doesn't
          declare, {formatStorage(open.bytes)}.
        </p>
      ) : null}
    </SettingsSection>
  );
}
