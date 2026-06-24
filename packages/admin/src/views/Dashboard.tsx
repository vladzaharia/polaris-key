import * as React from "react";
import { Boxes, KeyRound, ShieldCheck } from "lucide-react";
import { useAdmin } from "../context.js";
import { hashFor } from "../route.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/index.js";

/** A light landing view: who you are, what you administer, and quick links into products. */
export function Dashboard(): React.ReactElement {
  const { me } = useAdmin();
  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Welcome, {me.name.split(/\s+/)[0]}</h2>
        <p className="text-sm text-muted-foreground">
          {me.platformAdmin ? "Platform administrator" : "Product administrator"} · {me.email}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon={<Boxes aria-hidden />} label="Products" value={String(me.products.length)} />
        <StatCard
          icon={<ShieldCheck aria-hidden />}
          label="Role"
          value={me.platformAdmin ? "Platform" : "Product"}
        />
        <StatCard icon={<KeyRound aria-hidden />} label="Session" value="Active" />
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Your products</h3>
        {me.products.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              You don’t administer any products yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {me.products.map((prod) => (
              <Card key={prod.slug}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>{prod.name}</CardTitle>
                    <Badge variant="outline">v{prod.schemaVersion}</Badge>
                  </div>
                  <CardDescription>{prod.slug}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button asChild variant="secondary" size="sm">
                    <a href={hashFor({ kind: "product", slug: prod.slug, view: "licenses" })}>Open</a>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): React.ReactElement {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/15 text-primary [&_svg]:size-5">
          {icon}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="text-lg font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
