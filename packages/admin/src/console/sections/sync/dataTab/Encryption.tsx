/** Users → Data → Encryption: who can read the values, and the person's key ring. */

import * as React from "react";
import type { SubjectData } from "./index.js";
import { fromSeconds } from "../../../../lib/format.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { SettingsSection } from "../../../templates/Settings.js";

export function Encryption({
  data,
}: {
  data: SubjectData;
}): React.ReactElement {
  const { encryption, ring } = data;
  const e2e = encryption === "e2e";
  return (
    <SettingsSection id="sync-data-encryption" title="Encryption">
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm">
          <span className="font-medium text-fg-strong">
            {e2e ? "End-to-end" : "Readable by Polaris Key"}
          </span>
          <span className="text-fg-muted">
            {e2e
              ? ". Values are sealed on the person's devices and Polaris Key can't read them."
              : ". Values are stored so the server can read them."}
          </span>
        </p>
        {ring ? (
          <DescriptionList
            columns={2}
            items={[
              {
                term: "Key",
                detail: <code className="font-mono text-xs">{ring.kid}</code>,
              },
              {
                term: "Created",
                detail: <Timestamp at={fromSeconds(ring.createdAt)} />,
              },
              {
                term: "Recovery code",
                detail: ring.recoverySet ? "Set" : "Not set",
              },
              {
                term: "Devices that can open it",
                detail:
                  ring.devices.length === 0 ? (
                    "None"
                  ) : (
                    <ul className="space-y-0.5">
                      {ring.devices.map((label, i) => (
                        <li key={`${label}:${i}`}>{label}</li>
                      ))}
                    </ul>
                  ),
              },
              ...(ring.previousUntil !== undefined
                ? [
                    {
                      term: "Previous key",
                      detail: (
                        <>
                          Opens until{" "}
                          <Timestamp at={fromSeconds(ring.previousUntil)} />
                        </>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        ) : e2e ? (
          <p className="text-sm text-fg-muted">No key yet.</p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
