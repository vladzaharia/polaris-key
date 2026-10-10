import * as React from "react";
import { KeyRound } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { StationaryStar } from "../../ui/EmptyState.js";
import { useActivate } from "../activate.js";
import { href, useDocumentTitle } from "../router.js";

/** A product that isn't in the library (§4.28): never "portal api 404". */
export function NotFoundProduct({
  email,
}: {
  email: string;
}): React.ReactElement {
  useDocumentTitle("Not in your library");
  const activate = useActivate();
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      <StationaryStar />
      <h1 className="text-3xl font-semibold leading-tight text-fg-strong">
        That product isn't in your library
      </h1>
      <p className="text-fg-muted">
        You're signed in as <span className="text-fg-strong">{email}</span>. If
        you got it with another email or a license key, add it to this account.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild variant="outline" size="lg">
          <a href={href.library()}>Back to your library</a>
        </Button>
        <Button
          size="lg"
          iconStart={<KeyRound aria-hidden />}
          onClick={() => activate.open()}
        >
          Activate a license
        </Button>
      </div>
      <p className="text-sm text-fg-muted">
        Bought it with another email?{" "}
        <a
          href={href.account("methods")}
          className="font-medium text-accent-fg hover:underline"
        >
          Add an email in Account → Sign-in methods
        </a>
      </p>
    </section>
  );
}
