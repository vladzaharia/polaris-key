import * as React from "react";
import { AppSignInPage } from "./pages/AppSignIn.js";
import { IdentityClientsRoute } from "./pages/IdentityClients.js";
import type { SectionPageProps } from "../../pages/types.js";

/** Identity: the App sign-in page (T4) and the registered clients of Sign in with <Product> (I-21.14). */
export default function IdentityPages({
  route,
}: SectionPageProps): React.ReactElement | null {
  switch (route.page) {
    case "app-sign-in":
      return <AppSignInPage slug={route.slug} />;
    case "identity-clients":
      return <IdentityClientsRoute slug={route.slug} id={route.id} />;
    default:
      return null;
  }
}
