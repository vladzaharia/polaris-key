/**
 * I-18: verify the auth sending subdomain's SPF, DKIM and DMARC once the owner has published them.
 *
 *   pnpm --filter @polaris-key/worker email:dns-check              # auth.plrs.im
 *   pnpm --filter @polaris-key/worker email:dns-check -- other.example
 *
 * Resolves over Cloudflare's DNS-over-HTTPS JSON API (no local resolver cache), then applies
 * `evaluateEmailDns` (src/core/emailDns.ts). Exits 0 when every check passes, 1 otherwise. Read-
 * only: it sends no mail and changes no record. A real send's Authentication-Results (the staging
 * deliverability check, RUNBOOK "Sign-in email") is still the proof of alignment; this is the
 * precondition.
 */
import { AUTH_EMAIL_DOMAIN } from "../src/core/emailSender.js";
import { emailDnsNames, evaluateEmailDns } from "../src/core/emailDns.js";

const DOH = "https://cloudflare-dns.com/dns-query";

interface DohAnswer {
  type: number;
  data: string;
}

async function resolve(name: string, type: "TXT" | "MX"): Promise<string[]> {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`${type} ${name}: HTTP ${res.status}`);
  const body = (await res.json()) as { Status: number; Answer?: DohAnswer[] };
  const want = type === "TXT" ? 16 : 15;
  return (body.Answer ?? [])
    .filter((a) => a.type === want)
    .map((a) =>
      type === "TXT"
        ? // A TXT record arrives as one or more quoted strings; join them (RFC 7208 §3.3).
          [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
            .map((m) => m[1]!.replace(/\\(.)/g, "$1"))
            .join("") || a.data
        : (a.data.split(/\s+/)[1] ?? "").replace(/\.$/, ""),
    );
}

const domain = (
  process.argv.slice(2).find((a) => a !== "--") ?? AUTH_EMAIL_DOMAIN
).toLowerCase();
const names = emailDnsNames(domain);
const report = evaluateEmailDns(domain, {
  bounceMx: await resolve(names.bounce, "MX"),
  bounceTxt: await resolve(names.bounce, "TXT"),
  dkimTxt: await resolve(names.dkim, "TXT"),
  dmarcTxt: await resolve(names.dmarc, "TXT"),
  ...(names.orgDmarc
    ? { orgDmarcTxt: await resolve(names.orgDmarc, "TXT") }
    : {}),
});
for (const f of report.findings)
  console.log(`${f.ok ? "PASS" : "FAIL"}  ${f.check.padEnd(9)} ${f.detail}`);
console.log(report.ok ? `${domain}: aligned` : `${domain}: NOT ready`);
process.exit(report.ok ? 0 : 1);
