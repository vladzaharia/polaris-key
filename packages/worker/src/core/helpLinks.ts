/**
 * The Worker's one table of Help paths (DOC-06b): the footers of Polaris Locker mail and the
 * links under a Locker card. Every value is an absolute `/docs/help/…/` path ending in `/`, public
 * tier, resolved against the origin the message already points at.
 *
 * Drift gate: `test/customerHelpLinks.test.ts` reads this table and the anchor each notice uses,
 * and checks both against the built docs site. Renaming a Help page means updating this table
 * in the same change.
 */
export const WORKER_HELP_LINKS = {
  help: "/docs/help/",
  privacy: "/docs/help/your-data/",
  whatIsLocker: "/docs/help/what-is-polaris-locker/",
  emails: "/docs/help/emails/",
  secureYourAccount: "/docs/help/secure-your-account/",
  checkADownload: "/docs/help/check-a-download/",
  approveASignIn: "/docs/help/approve-a-sign-in/",
} as const;

/** One plain-text line for a link: `Label: url`, no colon after a label that ends in punctuation. */
export function linkText(l: FooterLink): string {
  return `${l.label}${/[?!.]$/.test(l.label) ? "" : ":"} ${l.url}`;
}

/** A link in an email footer: fixed label, absolute URL. */
export interface FooterLink {
  label: string;
  url: string;
}

/** "What is Polaris Locker?": every Locker mail. */
export function whatIsLockerLink(origin: string): FooterLink {
  return {
    label: "What is Polaris Locker?",
    url: `${origin}${WORKER_HELP_LINKS.whatIsLocker}`,
  };
}

/** "About this email": the notice's own entry on the Emails page. `anchor` is a fixed id. */
export function aboutThisEmailLink(origin: string, anchor: string): FooterLink {
  return {
    label: "About this email",
    url: `${origin}${WORKER_HELP_LINKS.emails}#${anchor}`,
  };
}

/** "How to secure your account": the Help article (a security notice's footer; the callout keeps the app link). */
export function secureHelpLink(origin: string): FooterLink {
  return {
    label: "How to secure your account",
    url: `${origin}${WORKER_HELP_LINKS.secureYourAccount}`,
  };
}
