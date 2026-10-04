import * as React from "react";
import type { PortalAccount } from "../api.js";
import { useDocumentTitle, type AccountSection } from "../router.js";

/** Account (PORTAL.md §4.26). PX-01 frame. */
export function AccountPage({
  account,
}: {
  account: PortalAccount;
  section: AccountSection | null;
}): React.ReactElement {
  useDocumentTitle("Account");
  return (
    <section className="space-y-2">
      <h1 className="text-3xl font-bold text-fg-strong">Account</h1>
      <p className="text-fg-muted">{account.email}</p>
    </section>
  );
}
