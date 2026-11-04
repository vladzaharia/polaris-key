import * as React from "react";
import { cn } from "../../lib/cn.js";
import { AUTH_LINK_CLASS } from "./parts.js";

/**
 * The identity display of a sign-in step that knows who is signing in (SIGNIN-REDESIGN m7): an
 * initial avatar, the address and, unless the identity is fixed (a step-up), a Change link. It
 * sits above the step's title. The Worker's twin is `identityPill` in `console/signinPage.ts`.
 */
export function IdentityPill({
  initials,
  email,
  changeLabel,
  onChange,
}: {
  initials: string;
  email: string;
  /** The Change link's text; omit it with `onChange` when the identity cannot change. */
  changeLabel?: string;
  onChange?: () => void;
}): React.ReactElement {
  return (
    <div className="inline-flex max-w-full flex-wrap items-center gap-x-2 rounded-full bigtext:rounded-lg border border-border py-0.5 ps-1 pe-1 text-sm/5 text-fg-muted">
      <span
        aria-hidden
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-hover text-sm/5 font-medium text-fg-strong"
      >
        {initials}
      </span>
      <span
        className={cn(
          "min-w-0 [overflow-wrap:break-word]",
          !onChange && "pe-2",
        )}
      >
        {email}
      </span>
      {onChange ? (
        <button
          type="button"
          onClick={onChange}
          className={cn(AUTH_LINK_CLASS, "shrink-0 px-2")}
        >
          {changeLabel}
        </button>
      ) : null}
    </div>
  );
}
