import * as React from "react";
import { cn } from "../../../../lib/cn.js";

/**
 * One of a feature's own settings, nested under its row (products.features, `.feature-subs`): the
 * title and one fact per line on the left, the control flush right, an inline error below.
 */
export function FeatureSubRow({
  title,
  htmlFor,
  lines = [],
  control,
  footer,
  className,
}: {
  title: React.ReactNode;
  /** The control's id: the title labels it. */
  htmlFor?: string;
  /** One fact per line, each its own `description`. */
  lines?: React.ReactNode[];
  control: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("px-4 py-3", className)}>
      <div className="flex items-center justify-between gap-4 max-sm:flex-wrap">
        <div className="min-w-0 max-w-[72ch]">
          {htmlFor ? (
            <label
              htmlFor={htmlFor}
              className="block text-sm font-medium text-fg-strong"
            >
              {title}
            </label>
          ) : (
            <p className="text-sm font-medium text-fg-strong">{title}</p>
          )}
          {lines.map((line, i) => (
            <p key={i} className="text-sm text-fg-muted">
              {line}
            </p>
          ))}
        </div>
        <div className="flex shrink-0 items-center max-sm:w-full max-sm:justify-start">
          {control}
        </div>
      </div>
      {footer}
    </div>
  );
}
