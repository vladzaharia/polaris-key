/**
 * Who may open what, for the components below the shell that list links (ST-29). The shell
 * provides the member's `canOpenHref`; outside it (the component gallery, a page rendered alone)
 * every link passes, which only ever shows more, never decides anything: the worker refuses every
 * route a member lacks on its own.
 */

import * as React from "react";

export const HrefAccess = React.createContext<(href: string) => boolean>(
  () => true,
);

/** Does the member's role open this console href? */
export function useCanOpenHref(): (href: string) => boolean {
  return React.useContext(HrefAccess);
}
