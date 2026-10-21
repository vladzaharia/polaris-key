/**
 * Where each alert kind goes for one product (ST-27): its own destinations, the platform's, or the
 * audit trail only, as short lines. The failing-destination alert stays inside the scope it is
 * about, so the platform never covers it here. Kinds nothing raises yet are named once.
 */

import * as React from "react";
import type { AlertDestinationsView } from "../../../api.js";
import { r } from "../../routes.js";
import type { KindInfo } from "./alertShared.js";

export function RoutingSummary({
  view,
}: {
  view: AlertDestinationsView;
}): React.ReactElement {
  const own = (k: KindInfo): boolean =>
    view.destinations.some((d) => d.enabled && d.alerts.includes(k.id));
  const viaPlatform = (k: KindInfo): number =>
    k.id === "notifications_failing" ? 0 : (view.inheritedByKind?.[k.id] ?? 0);
  const names = (ks: readonly KindInfo[]): string =>
    ks.map((k) => k.label).join(", ");
  const here = view.kinds.filter(own);
  const rest = view.kinds.filter((k) => !own(k));
  const platform = rest.filter((k) => viaPlatform(k) > 0);
  const audit = rest.filter((k) => viaPlatform(k) === 0);
  const platformCount = Math.max(0, ...platform.map(viaPlatform));
  const unsent = view.kinds.filter((k) => !k.sent);
  const head = (text: React.ReactNode): React.ReactElement => (
    <span className="font-medium text-fg-strong">{text}</span>
  );
  return (
    <div
      className="space-y-0.5 text-sm text-fg-muted"
      data-testid="alert-routing"
    >
      {here.length > 0 ? (
        <p>
          {head("This product:")} {names(here)}
        </p>
      ) : null}
      {platform.length > 0 ? (
        <p>
          <a
            className="py-1 font-medium text-accent-fg underline underline-offset-2"
            href={r.platformSettings()}
          >
            Platform ({platformCount}):
          </a>{" "}
          {names(platform)}
        </p>
      ) : null}
      {audit.length > 0 ? (
        <p>
          {head("Audit trail only:")}{" "}
          {here.length === 0 && platform.length === 0
            ? "all alerts"
            : names(audit)}
        </p>
      ) : null}
      {unsent.length > 0 ? <p>Not sent yet: {names(unsent)}.</p> : null}
    </div>
  );
}
