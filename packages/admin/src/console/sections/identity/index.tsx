import * as React from "react";
import { AppSignInPage } from "./pages/AppSignIn.js";
import type { SectionPageProps } from "../../pages/types.js";

/** Identity: the one App sign-in page (T4). */
export default function IdentityPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  switch (route.page) {
    case "app-sign-in":
      return <AppSignInPage slug={route.slug} />;
    default:
      return null;
  }
}
