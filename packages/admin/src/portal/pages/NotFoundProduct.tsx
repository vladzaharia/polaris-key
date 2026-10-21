import * as React from "react";
import { t, tParts } from "../../lib/copy.js";
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
  useDocumentTitle(t("locker.notFound.title"));
  const activate = useActivate();
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      <StationaryStar />
      <h1 className="text-3xl font-semibold leading-tight text-fg-strong">
        {t("locker.notFound.heading")}
      </h1>
      <p className="text-fg-muted">
        {tParts("locker.notFound.body", ["email"]).map((part, i) =>
          typeof part === "string" ? (
            part
          ) : (
            <span key={i} className="text-fg-strong">
              {email}
            </span>
          ),
        )}
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild variant="outline" size="lg">
          <a href={href.library()}>{t("locker.discover.empty.back")}</a>
        </Button>
        <Button
          size="lg"
          iconStart={<KeyRound aria-hidden />}
          onClick={() => activate.open()}
        >
          {t("common.activateLicense")}
        </Button>
      </div>
      <p className="text-sm text-fg-muted">
        {t("locker.notFound.otherEmail")}{" "}
        <a
          href={href.account("methods")}
          className="font-medium text-accent-fg hover:underline"
        >
          {t("locker.notFound.addEmail")}
        </a>
      </p>
    </section>
  );
}
