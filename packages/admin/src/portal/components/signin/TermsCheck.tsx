import * as React from "react";
import { Checkbox } from "../../../ui/Checkbox.js";
import { cn } from "../../../lib/cn.js";
import { t, tParts } from "../../../lib/copy.js";
import { LINK_CLASS } from "../../linkClass.js";

function safeHref(url: string): string | null {
  return /^https:\/\//.test(url) || url.startsWith("/") ? url : null;
}

/** A terms link that opens in a new tab: a 44 px target, named for what it opens. */
function TermsLink({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}): React.ReactElement {
  const href = safeHref(url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(LINK_CLASS, "-my-3 py-3")}
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

/** "I agree to the {term}" with the link filling the slot (a catalog sentence, a real link). */
export function TermsSentence({
  sentence,
  url,
  label,
}: {
  sentence: "signin.gate.productTerms" | "signin.gate.platformTerms";
  url: string;
  label: string;
}): React.ReactElement {
  return (
    <>
      {tParts(sentence, ["term"]).map((part, i) =>
        typeof part === "string" ? (
          <React.Fragment key={i}>{part}</React.Fragment>
        ) : (
          <TermsLink key={i} url={url}>
            {label}
          </TermsLink>
        ),
      )}
    </>
  );
}

/**
 * The product's terms the person has not accepted yet, above Continue on a consent step (the Worker
 * answers `409 terms_required` until Continue carries the version it was shown). `check` is the box;
 * `pass()` is false, and the box says why, while it is unticked; `version` is what to post.
 */
export function useTermsCheck(
  terms: { version: string; url: string } | undefined,
  product: string,
): {
  check: React.ReactNode;
  pass: () => boolean;
  version: string | undefined;
} {
  const id = React.useId();
  const [ok, setOk] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const check = terms ? (
    <div className="space-y-2">
      <Checkbox
        className="max-desk:min-h-11 max-desk:items-center max-desk:[&_label]:-my-3 max-desk:[&_label]:py-3 pointer-coarse:min-h-11 pointer-coarse:items-center pointer-coarse:[&_label]:-my-3 pointer-coarse:[&_label]:py-3"
        checked={ok}
        onCheckedChange={(v) => {
          setOk(v);
          if (v) setInvalid(false);
        }}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-terms` : undefined}
        label={
          <TermsSentence
            sentence="signin.gate.productTerms"
            url={terms.url}
            label={t("signin.gate.termsLinkProduct", { product })}
          />
        }
      />
      {invalid ? (
        <p id={`${id}-terms`} role="alert" className="text-sm/5 text-danger">
          {t("core.codes.terms_required.message")}
        </p>
      ) : null}
    </div>
  ) : null;
  return {
    check,
    pass: () => {
      if (terms && !ok) {
        setInvalid(true);
        return false;
      }
      return true;
    },
    version: terms?.version,
  };
}
