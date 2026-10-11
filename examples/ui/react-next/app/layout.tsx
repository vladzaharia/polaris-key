import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ClientShell } from "./client-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tidewater Studio",
  description: "A Polaris Key React App Router sample.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
      <body>
        <ClientShell>{children}</ClientShell>
      </body>
    </html>
  );
}
