/**
 * The step-up callout (ST-27): announced when it appears (`live`) and focusing its "Sign in
 * again" link, so a keyboard or screen-reader user lands on the way forward.
 */

import * as React from "react";
import { Callout } from "../../../ui/Callout.js";
import { stepUpHref } from "../core/pages/UserRelink.js";

export function SignInCallout({
  hash,
  children,
}: {
  hash: string;
  children: React.ReactNode;
}): React.ReactElement {
  const link = React.useRef<HTMLAnchorElement>(null);
  React.useEffect(() => {
    link.current?.focus();
  }, []);
  return (
    <Callout
      tone="warning"
      live
      title="Sign in again to continue"
      action={
        <a
          ref={link}
          href={stepUpHref(hash)}
          className="py-1 whitespace-nowrap font-medium text-accent-fg underline underline-offset-2"
        >
          Sign in again
        </a>
      }
    >
      {children}
    </Callout>
  );
}
