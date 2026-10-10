import * as React from "react";
import { Mail, Store } from "lucide-react";
import { href } from "../router.js";

/**
 * "Missing a license?" (B12): the two other ways a license reaches the account, as a quiet strip
 * under the library. A license sent to another email joins through Account → Sign-in methods;
 * a store purchase (Steam through a sign-in method, the App Store and Google Play through the
 * product's own sign-in).
 */
export function MissingLicense(): React.ReactElement {
  return (
    <section
      aria-labelledby="missing-h"
      className="space-y-4 border-t border-border pt-8"
    >
      <h2 id="missing-h" className="text-lg font-semibold text-fg-strong">
        Missing a license?
      </h2>
      <ul className="grid gap-4 desk:grid-cols-2">
        <li className="flex gap-3">
          <Glyph>
            <Mail aria-hidden className="size-5" />
          </Glyph>
          <p className="text-sm text-fg-muted">
            <strong className="block font-medium text-fg-strong">
              Sent to another email?
            </strong>
            Add that email under{" "}
            <a
              href={href.account("methods")}
              className="font-medium text-accent-fg hover:underline"
            >
              Sign-in methods
            </a>
            .
          </p>
        </li>
        <li className="flex gap-3">
          <Glyph>
            <Store aria-hidden className="size-5" />
          </Glyph>
          <p className="text-sm text-fg-muted">
            <strong className="block font-medium text-fg-strong">
              Bought in a store?
            </strong>
            Add Steam under Sign-in methods. For the App Store or Google Play,
            sign in to the game once.
          </p>
        </li>
      </ul>
    </section>
  );
}

function Glyph({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-muted"
    >
      {children}
    </span>
  );
}
