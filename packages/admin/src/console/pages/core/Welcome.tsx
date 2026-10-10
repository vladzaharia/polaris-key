/**
 * The one-time welcome on a new product's Overview (EXPERIENCE.md §0.4 S1 step 4, §0.7 "Product
 * created", C1). Create has no result page and no toast: it records what was made here and lands
 * on Overview, which shows "<Name> is ready" with the new signing key once, above the setup.
 *
 * The record lives in `sessionStorage` and is consumed when Overview reads it, so a refresh or a
 * later visit shows the ordinary Overview. Nothing in it is secret: a name, a key id, the public
 * key and the names (never values) of the secrets a linked manifest still needs.
 *
 * It is EXPERIENCE §0.7's "Product created" moment: the heading carries the success check and
 * sparks (MO-11), once per product.
 */

import * as React from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { SignedBadge } from "../../../ui/SignedBadge.js";
import { Celebration } from "../../../ui/motion/index.js";
import { momentKey } from "../../components/Moment.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";

export const WELCOME_KEY = "pk-product-welcome";

/** What create hands Overview: public material and names only. */
export interface Welcome {
  slug: string;
  name: string;
  kid: string;
  publicKey: string | null;
  /** The repository a linked product was registered from (`acme/tonebox`), else absent. */
  repo?: string;
  /** Secret names a linked manifest declares that nobody has set yet. */
  remainingSecrets: string[];
}

export function storeWelcome(welcome: Welcome): void {
  try {
    window.sessionStorage.setItem(WELCOME_KEY, JSON.stringify(welcome));
  } catch {
    // storage unavailable: Overview opens without the welcome
  }
}

function readWelcome(slug: string): Welcome | null {
  try {
    const raw = window.sessionStorage.getItem(WELCOME_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Welcome>;
    if (v.slug !== slug || typeof v.kid !== "string") return null;
    return {
      slug,
      name: typeof v.name === "string" && v.name ? v.name : slug,
      kid: v.kid,
      publicKey: typeof v.publicKey === "string" ? v.publicKey : null,
      ...(typeof v.repo === "string" && v.repo ? { repo: v.repo } : {}),
      remainingSecrets: Array.isArray(v.remainingSecrets)
        ? v.remainingSecrets.filter((s): s is string => typeof s === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function clearWelcome(): void {
  try {
    window.sessionStorage.removeItem(WELCOME_KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * The welcome for `slug`, read once and consumed: it shows on this visit until dismissed, and
 * never again.
 */
export function useWelcome(slug: string): [Welcome | null, () => void] {
  const [welcome, setWelcome] = React.useState<Welcome | null>(() =>
    readWelcome(slug),
  );
  React.useEffect(() => {
    if (welcome) clearWelcome();
  }, [welcome]);
  const dismiss = React.useCallback(() => setWelcome(null), []);
  return [welcome, dismiss];
}

export function WelcomeHeader({
  welcome,
  onDismiss,
}: {
  welcome: Welcome;
  onDismiss: () => void;
}): React.ReactElement {
  const missing = welcome.remainingSecrets.length;
  return (
    <section
      aria-labelledby="product-welcome-title"
      data-testid="product-welcome"
      className="flex items-start gap-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5"
    >
      <span
        aria-hidden
        className="hidden size-10 shrink-0 place-items-center sm:grid rounded-lg bg-accent-subtle text-base font-semibold text-accent-fg"
      >
        {welcome.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h2
          id="product-welcome-title"
          className="flex items-center gap-2 text-lg font-semibold text-fg-strong"
        >
          {welcome.name} is ready
          <span className="text-accent-fg">
            <Celebration
              momentKey={momentKey("product-created", welcome.slug)}
              size={20}
            />
          </span>
        </h2>
        <p className="text-sm text-fg-muted">
          {welcome.repo
            ? `Registered from ${welcome.repo}. Its signing key was made just now.`
            : "Its signing key was made just now."}{" "}
          {/* UX-59: the key is for the app's trust pins, not for release tooling. */}
          Pin this key in your app. Releases are signed by a separate CI release
          key.
        </p>
        <p className="flex min-w-0 items-center gap-1">
          <SignedBadge kid={welcome.kid} by="product signing key" />
          <CopyButton
            value={welcome.publicKey ?? welcome.kid}
            label={
              welcome.publicKey
                ? "Copy the signing public key"
                : "Copy the signing key id"
            }
          />
        </p>
        {missing > 0 ? (
          <p className="text-sm text-fg">
            {missing === 1
              ? "1 secret the manifest declares is not set."
              : `${missing} secrets the manifest declares are not set.`}{" "}
            <Link
              to={r.keys(welcome.slug)}
              className="inline-flex items-center gap-1 text-accent-fg underline underline-offset-4"
            >
              {missing === 1
                ? "Set 1 missing secret"
                : `Set ${missing} missing secrets`}
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </p>
        ) : null}
      </div>
      <div className="shrink-0">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
