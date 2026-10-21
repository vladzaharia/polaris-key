import * as React from "react";
import { cn } from "../../lib/cn.js";

/**
 * A link into Help (DOC-06a): quiet, underlined, 44 px to hit. The label is
 * catalog copy the caller passes; the `href` comes from `helpLinks.ts`. Same tab: Help is on the
 * same host and the person is mid-task, so the browser's Back returns to the portal.
 */
export function HelpLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex items-center text-sm font-medium text-fg-strong underline underline-offset-4 hover:text-fg-strong min-h-11",
        className,
      )}
    >
      {children}
    </a>
  );
}
