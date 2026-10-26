import * as React from "react";
import { EmptyState } from "../../../ui/EmptyState.js";
import { PageHeader } from "../../../ui/PageHeader.js";

/**
 * Cloud Connect's one page for now: nothing to set up until the Worker routes land (CC-06, CC-07).
 * CC-16 replaces it with Setup, Usage and Linked devices.
 */
export function ConnectSetupPage(): React.ReactElement {
  return (
    <>
      <PageHeader
        title="Cloud Connect"
        description="Link a person's devices and move data between them."
      />
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="Not available yet"
        description="Cloud Connect has no settings until a later release."
        docs="/docs/features/cloud-connect/"
      />
    </>
  );
}
