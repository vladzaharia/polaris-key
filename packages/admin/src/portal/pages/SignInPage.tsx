import * as React from "react";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { portalApi } from "../api.js";
import { capabilitiesOrNone, useCapabilities } from "../data.js";
import { useDocumentTitle } from "../router.js";

/** Sign in (PORTAL.md §4.1). PX-01 frame; PX-05 builds the login card. */
export function SignInPage(): React.ReactElement {
  useDocumentTitle("Sign in");
  const caps = capabilitiesOrNone(useCapabilities());
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-bold text-fg-strong">
        Sign in to Polaris Key
      </h1>
      {caps.auth.oidc ? (
        <Button asChild>
          <a
            href={`/login?return_to=${encodeURIComponent(window.location.href)}`}
          >
            Continue with single sign-on
          </a>
        </Button>
      ) : null}
      {caps.auth.magic ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void portalApi.startMagic(email).then(() => setSent(true));
          }}
          className="space-y-3"
        >
          <label htmlFor="pk-email">Email</label>
          <Input
            id="pk-email"
            type="email"
            value={email}
            onValueChange={setEmail}
          />
          <Button type="submit">Email me a sign-in link</Button>
          {sent ? <p>Check your email.</p> : null}
        </form>
      ) : null}
    </main>
  );
}
