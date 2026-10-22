import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalApiError } from "../src/portal/api.js";
import { portalErrorCopy } from "../src/portal/errors.js";
import { HELP_LINKS, helpForRefusal } from "../src/portal/helpLinks.js";
import { ErrorPanel } from "../src/portal/components/States.js";
import { HelpCard } from "../src/portal/components/product/HelpCard.js";
import type { LibraryProduct } from "../src/portal/model/library.js";

afterEach(cleanup);

const linkTo = (href: string): HTMLElement | undefined =>
  screen.queryAllByRole("link").find((a) => a.getAttribute("href") === href);

describe("helpLinks.ts", () => {
  it("is absolute /docs/help/ paths that end in a slash (before any #anchor)", () => {
    for (const [id, link] of Object.entries(HELP_LINKS))
      expect(link.split("#")[0], id).toMatch(/^\/docs\/help\/([a-z0-9-]+\/)*$/);
  });

  it("maps a refusal code to the page that explains it, and others to none", () => {
    expect(helpForRefusal("license_owned")).toBe(HELP_LINKS.licenseOwned);
    expect(helpForRefusal("email_mismatch")).toBe(HELP_LINKS.emailMismatch);
    expect(helpForRefusal("entries")).toBe(HELP_LINKS.keyEntryLimit);
    expect(helpForRefusal("file_not_found")).toBe(HELP_LINKS.fileNotFound);
    expect(helpForRefusal("format")).toBeUndefined();
    expect(helpForRefusal("toString")).toBeUndefined();
    expect(helpForRefusal(undefined)).toBeUndefined();
  });
});

describe("a refusal links its Help page", () => {
  it("carries the page on a download refusal, and none on a generic error", () => {
    expect(portalErrorCopy(new PortalApiError(409, "not_hosted")).help).toBe(
      HELP_LINKS.notHosted,
    );
    expect(portalErrorCopy(new PortalApiError(403, "not_entitled")).help).toBe(
      HELP_LINKS.notEntitled,
    );
    expect(
      portalErrorCopy(new PortalApiError(404, "not_found")).help,
    ).toBeUndefined();
  });

  it("shows What to do under a download refusal only", () => {
    render(<ErrorPanel error={new PortalApiError(403, "license_inactive")} />);
    expect(linkTo(HELP_LINKS.licenseInactive)?.textContent).toBe("What to do");
    cleanup();
    render(<ErrorPanel error={new PortalApiError(404, "not_found")} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("the Help card", () => {
  const product = (presentation: object): LibraryProduct =>
    ({ name: "Nightfall", presentation }) as unknown as LibraryProduct;

  it("points to who to contact when the developer gave no support contact", () => {
    render(<HelpCard product={product({ developer: "Kiln Games" })} />);
    expect(linkTo(HELP_LINKS.contact)?.textContent).toBe("Who to contact");
  });

  it("leaves the developer's own contact alone otherwise", () => {
    render(
      <HelpCard
        product={product({
          developer: "Kiln Games",
          supportEmail: "help@kiln.example",
        })}
      />,
    );
    expect(linkTo(HELP_LINKS.contact)).toBeUndefined();
  });
});
