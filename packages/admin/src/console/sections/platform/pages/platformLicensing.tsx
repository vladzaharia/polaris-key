/**
 * Platform → Settings → Licensing (S-19 §7.4, LX-05; split from platformSettings.tsx by ST-09).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type PlatformReservedNames } from "../../../../api.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { qk } from "../../../data/queries.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";

export function fetchPlatformReservedNames(): Promise<PlatformReservedNames> {
  return api.platformReservedNames();
}

const RESERVED_TYPE_WORDS: Record<string, string> = {
  string: "string",
  integer: "integer",
  "string-array": "array of strings",
};

/**
 * Platform → Settings → Licensing (S-19 §7.4, LX-05): the reserved-names severity, the reserved
 * keys with the rule the platform applies, and every registered product that declares one.
 */
export function LicensingSection({
  rows,
}: {
  /** The registry's licensing rows, already rendered. */
  rows: React.ReactNode;
}): React.ReactElement {
  const report = useQuery({
    queryKey: qk.platformReservedNames(),
    queryFn: fetchPlatformReservedNames,
  });
  const data = report.data;
  return (
    <SettingsSection
      id="platform-licensing"
      title="Licensing"
      description="A product's catalog flag may declare a system key the platform sets itself. A compatible declaration is always valid; this decides what happens to an incompatible one."
    >
      {rows}
      {report.isPending ? (
        <div className="space-y-2 px-5 py-4" aria-busy>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !data ? (
        <div className="px-5 py-4">
          <ErrorState
            error={report.error}
            onRetry={() => void report.refetch()}
          />
        </div>
      ) : (
        <>
          <SettingsRow
            label="Reserved keys"
            help={
              <>
                A declaration must keep the key&apos;s type and may only narrow
                it. Names under{" "}
                {data.prefixes.map((p, i) => (
                  <React.Fragment key={p}>
                    {i > 0
                      ? i === data.prefixes.length - 1
                        ? " and "
                        : ", "
                      : null}
                    <code className="font-mono">{p}</code>
                  </React.Fragment>
                ))}{" "}
                are reserved for future system keys.
              </>
            }
            align="block"
          >
            <ul className="divide-y divide-border" aria-label="Reserved keys">
              {data.keys.map((k) => (
                <li
                  key={k.key}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
                >
                  <span>
                    <code className="font-mono text-xs text-fg-strong">
                      {k.key}
                    </code>{" "}
                    <span className="text-xs text-fg-muted">
                      {RESERVED_TYPE_WORDS[k.type] ?? k.type}
                    </span>
                  </span>
                  <span className="text-right text-xs text-fg-muted">
                    {k.rule}
                  </span>
                </li>
              ))}
            </ul>
          </SettingsRow>
          {data.products.length === 0 ? (
            <div className="px-5 py-4">
              <EmptyState
                kind="first-run"
                variant="inline"
                title="No product declares a reserved name"
                description="Registered products whose catalog declares one are listed here with whether each declaration is compatible."
              />
            </div>
          ) : (
            data.products.map((p) => (
              <ReservedNamesProductRow key={p.slug} product={p} />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function ReservedNamesProductRow({
  product,
}: {
  product: PlatformReservedNames["products"][number];
}): React.ReactElement {
  const bad = product.declarations.filter((d) => !d.compatible);
  return (
    <SettingsRow
      label={product.name}
      help={
        <>
          <span className="block font-mono text-xs">
            {product.slug} · catalog v{product.catalogVersion}
          </span>
          <ul
            className="mt-1 space-y-1"
            aria-label={`${product.name} declarations`}
          >
            {product.declarations.map((d) => (
              <li key={d.key}>
                <code className="font-mono text-xs">{d.key}</code>
                {d.compatible
                  ? " · compatible"
                  : ` · ${d.problem ?? "incompatible"}`}
              </li>
            ))}
          </ul>
        </>
      }
    >
      {bad.length > 0 ? (
        <StatusPill tone="warning">
          {bad.length === 1 ? "1 incompatible" : `${bad.length} incompatible`}
        </StatusPill>
      ) : (
        <span className="text-fg-muted">Compatible</span>
      )}
    </SettingsRow>
  );
}
