import * as React from "react";
import { KeyRound } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { markPartPath } from "../../ui/markPath.js";
import { useActivate } from "../activate.js";
import { href } from "../router.js";

const STAR = markPartPath("star", { kind: "key", size: 48, theme: "mono" });

/**
 * The empty library (§4.12): the signed-in email, Activate a license (the one primary) and the
 * stationary star on the right half (a top strip on phones). The Discover teaser and "See N in
 * Discover" wait for G24.
 */
export function LibraryEmpty({ email }: { email: string }): React.ReactElement {
  const activate = useActivate();
  return (
    <section
      aria-labelledby="empty-h"
      className="grid overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1 desk:grid-cols-2"
    >
      <div className="order-2 flex flex-col gap-5 p-6 desk:order-1 desk:p-12">
        <h2
          id="empty-h"
          className="text-2xl font-bold text-fg-strong desk:text-3xl [overflow-wrap:anywhere]"
        >
          Nothing here for {email} yet
        </h2>
        <p className="text-fg-muted">
          Products bought with this email show up here by themselves. Got a
          license key from a store or a developer? Activate it and the product
          joins your library.
        </p>
        <div>
          <Button
            size="lg"
            className="h-12"
            iconStart={<KeyRound aria-hidden />}
            onClick={() => activate.open()}
          >
            Activate a license
          </Button>
        </div>
        <p className="border-t border-border pt-5 text-sm text-fg-muted">
          Bought with a different email or on Steam?{" "}
          <a
            href={href.account("methods")}
            className="font-bold text-accent-fg hover:underline"
          >
            Add it in Account → Sign-in methods
          </a>
        </p>
      </div>
      <div
        aria-hidden
        className="order-1 flex h-28 items-center justify-center bg-accent-subtle desk:order-2 desk:h-auto"
      >
        <svg
          viewBox={STAR.viewBox}
          className="size-16 fill-accent desk:size-36"
        >
          <path d={STAR.d} />
        </svg>
      </div>
    </section>
  );
}
