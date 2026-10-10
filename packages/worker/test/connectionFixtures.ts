/**
 * I-30: fixtures for the connection tests. A connection row written straight to the table, and a
 * fake DNS-over-HTTPS resolver for the domain proofs.
 */
import type { Db } from "../src/db/types.js";
import { NOW } from "./seed.js";

export async function insertConnection(
  db: Db,
  over: {
    id: string;
    scope?: string;
    label?: string;
    issuer?: string;
    audience?: string;
    status?: string;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO identity_connections (id, scope, label, issuer, client_id, audience, status,
       source, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'console', ?, ?)`,
    over.id,
    over.scope ?? "platform",
    over.label ?? `Label ${over.id}`,
    over.issuer ?? `https://${over.id}.idp.example`,
    `client-${over.id}`,
    over.audience ?? "customers",
    over.status ?? "active",
    NOW,
    NOW,
  );
}

export type DohAnswer =
  | { kind: "txt"; values: string[] }
  | { kind: "nxdomain" }
  | { kind: "servfail" }
  | { kind: "throw" }
  | { kind: "redirect"; to: string }
  | { kind: "raw"; status: number; body: string };

/** A fake resolver: answers per record name; records every URL dialled. */
export function fakeDoh(records: Map<string, DohAnswer>): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      const name = new URL(url).searchParams.get("name") ?? "";
      const a = records.get(name) ?? { kind: "txt", values: [] };
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        });
      switch (a.kind) {
        case "txt":
          return json({
            Status: 0,
            Answer: a.values.map((v) => ({
              name,
              type: 16,
              TTL: 300,
              data: `"${v}"`,
            })),
          });
        case "nxdomain":
          return json({ Status: 3 });
        case "servfail":
          return json({ Status: 2 });
        case "throw":
          throw new Error("network down");
        case "redirect":
          return new Response(null, {
            status: 302,
            headers: { location: a.to },
          });
        case "raw":
          return new Response(a.body, { status: a.status });
      }
    },
  };
}
