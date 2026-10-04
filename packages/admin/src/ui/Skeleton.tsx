import * as React from "react";
import { cn } from "../lib/cn.js";
import { LiveRegion } from "./LiveRegion.js";

/**
 * Loading placeholders (components.md §5.3). `Skeleton` is one hidden block; `PageSkeleton`
 * draws a template's real layout (T1 dashboard, T2 table, T3 record, T4 form, T5 matrix) so the
 * page does not jump when the data lands, and announces "Loading …" politely (UI-13). The blocks
 * do not pulse: loading motion is the refetch bar, never decoration (BRAND.md §7.5).
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      aria-hidden
      className={cn("rounded-md bg-surface-sunken", className)}
      {...props}
    />
  );
}

export type SkeletonTemplate =
  | "table"
  | "record"
  | "form"
  | "matrix"
  | "dashboard";

function Header({ tabs = false }: { tabs?: boolean }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-4 w-80 max-w-full" />
      {tabs ? (
        <div className="flex gap-4 border-b border-border pb-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-4 w-16" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Rows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex gap-4 border-b border-border bg-surface-raised px-3 py-3">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          className="flex h-11 items-center gap-4 border-b border-border px-3 last:border-0"
        >
          {Array.from({ length: cols }, (_, i) => (
            <Skeleton
              key={i}
              className={cn("h-3 flex-1", i === 0 && "flex-[2]")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Card({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-raised p-4">
      <Skeleton className="h-4 w-32" />
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="grid gap-2 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

const BODIES: Record<SkeletonTemplate, () => React.ReactElement> = {
  dashboard: () => (
    <>
      <Header />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="space-y-2 rounded-lg border border-border bg-surface-raised p-4"
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-64 lg:col-span-2" />
        <Skeleton className="h-64" />
      </div>
    </>
  ),
  table: () => (
    <>
      <Header />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-24" />
      </div>
      <Rows />
    </>
  ),
  record: () => (
    <>
      <Header tabs />
      <Card lines={4} />
    </>
  ),
  form: () => (
    <>
      <Header />
      <Card lines={3} />
      <Card lines={2} />
    </>
  ),
  matrix: () => (
    <>
      <Header />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-56" />
      </div>
      <Rows rows={5} cols={5} />
    </>
  ),
};

export function PageSkeleton({
  template,
  label,
  className,
}: {
  template: SkeletonTemplate;
  /** What is loading, for the announcement: "licenses" → "Loading licenses…". */
  label?: string;
  className?: string;
}): React.ReactElement {
  const Body = BODIES[template];
  return (
    <div data-skeleton={template} className={cn("space-y-6", className)}>
      <LiveRegion message={label ? `Loading ${label}…` : "Loading…"} />
      <Body />
    </div>
  );
}
