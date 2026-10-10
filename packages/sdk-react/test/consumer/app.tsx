// What a consumer writes against the kit, compiled twice (test/consumerTypes.test.ts): once
// against React 18's types and once against React 19's, with `skipLibCheck: false`, so a
// declaration that reaches for React 18's global `JSX` namespace (gone in 19) fails here.
import type { ReactNode } from "react";
import {
  DeviceManager,
  LicenseGate,
  PolarisKeyProvider,
  PolarisLogout,
  UpdatePrompt,
  useLicense,
} from "@polaris-key/react";

function Status(): React.JSX.Element {
  const license = useLicense();
  return <p>{license.status}</p>;
}

export function App(props: { children?: ReactNode }): React.JSX.Element {
  return (
    <PolarisKeyProvider
      productSlug="acme"
      trust={{ pinnedKeys: { k1: "A".repeat(43) } }}
      version="1.0.0"
    >
      <LicenseGate slots={{ loading: () => <p>…</p> }}>
        <Status />
        <UpdatePrompt />
        <DeviceManager />
        <PolarisLogout />
        {props.children}
      </LicenseGate>
    </PolarisKeyProvider>
  );
}
