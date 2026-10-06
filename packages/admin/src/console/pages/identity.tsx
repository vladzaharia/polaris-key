import * as React from "react";
import { PortalPage } from "./identity/Portal.js";
import { SignInPage } from "./identity/SignIn.js";
import type { SectionPageProps } from "./types.js";

/** Identity: Portal (T4) and Sign-in (T3, with I-12's sign-in-through-product settings). */
export default function IdentityPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  switch (route.page) {
    case "portal":
      return <PortalPage slug={route.slug} />;
    case "sign-in":
      return <SignInPage slug={route.slug} />;
    default:
      return null;
  }
}
