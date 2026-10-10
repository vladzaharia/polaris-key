// The sending subdomain's DNS, checked (I-18). Pure: the caller resolves the records (the
// operator script `scripts/check-email-dns.ts` over DNS-over-HTTPS) and this module decides
// whether mail from `noreply@<domain>` can pass SPF, DKIM and DMARC with alignment.
//
// What Cloudflare Email Sending publishes when the owner onboards a (sub)domain D
// (developers.cloudflare.com/email-service/configuration/domains/, checked 2026-10-04):
//
//   MX   cf-bounce.D             route1/route2/route3.mx.cloudflare.net   (bounce processing)
//   TXT  cf-bounce.D             "v=spf1 include:_spf.mx.cloudflare.net ~all"
//   TXT  cf-bounce._domainkey.D  "v=DKIM1; h=sha256; k=rsa; p=<public key>"
//   TXT  _dmarc.D                "v=DMARC1; p=reject;"   (the onboarding default)
//
// The envelope sender (Return-Path) is on `cf-bounce.D`, so SPF passes for `cf-bounce.D` and
// aligns with the `From` domain D only under RELAXED SPF alignment (`aspf=r`, the default). DKIM
// signs as `d=D` with selector `cf-bounce`, so DKIM aligns under either mode. DMARC passes when
// either aligns; this check requires both, so one failing path cannot go unnoticed.

/** The selector Cloudflare Email Sending signs with. */
export const EMAIL_SENDING_DKIM_SELECTOR = "cf-bounce";
/** The SPF mechanism that authorises Cloudflare's sending infrastructure. */
export const EMAIL_SENDING_SPF_INCLUDE = "include:_spf.mx.cloudflare.net";
/** Cloudflare's bounce MX hosts. */
export const EMAIL_SENDING_BOUNCE_MX = [
  "route1.mx.cloudflare.net",
  "route2.mx.cloudflare.net",
  "route3.mx.cloudflare.net",
];

/** The names a check has to resolve for a sending domain. */
export function emailDnsNames(domain: string): {
  bounce: string;
  dkim: string;
  dmarc: string;
  /** Null when the domain is itself the organizational domain (two labels, as `plrs.im`). */
  orgDmarc: string | null;
} {
  const d = domain.replace(/\.$/, "").toLowerCase();
  const labels = d.split(".");
  return {
    bounce: `cf-bounce.${d}`,
    dkim: `${EMAIL_SENDING_DKIM_SELECTOR}._domainkey.${d}`,
    dmarc: `_dmarc.${d}`,
    orgDmarc: labels.length > 2 ? `_dmarc.${labels.slice(-2).join(".")}` : null,
  };
}

/** The resolved records: TXT strings already joined per record, MX hosts without the dot. */
export interface EmailDnsRecords {
  bounceMx: string[];
  bounceTxt: string[];
  dkimTxt: string[];
  dmarcTxt: string[];
  /** `_dmarc.<organizational domain>`, the RFC 7489 §6.6.3 fallback when `dmarcTxt` has no
   *  record; its `sp=` (else `p=`) then governs the subdomain. Omit when D is itself the
   *  organizational domain. */
  orgDmarcTxt?: string[];
}

export interface EmailDnsFinding {
  check: "bounce_mx" | "spf" | "dkim" | "dmarc";
  ok: boolean;
  detail: string;
}

export interface EmailDnsReport {
  domain: string;
  /** Every check passed. */
  ok: boolean;
  findings: EmailDnsFinding[];
}

/** `k=v; k=v` tags of a DKIM or DMARC record, keys lower-cased. */
export function parseTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key !== "" && !tags.has(key)) tags.set(key, part.slice(eq + 1).trim());
  }
  return tags;
}

function checkSpf(txt: string[]): EmailDnsFinding {
  const spf = txt.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (spf.length === 0)
    return { check: "spf", ok: false, detail: "no v=spf1 record" };
  if (spf.length > 1)
    return {
      check: "spf",
      ok: false,
      detail: `${spf.length} v=spf1 records (RFC 7208 §4.5: a permerror)`,
    };
  const terms = spf[0]!.trim().toLowerCase().split(/\s+/);
  if (!terms.includes(EMAIL_SENDING_SPF_INCLUDE))
    return {
      check: "spf",
      ok: false,
      detail: `missing ${EMAIL_SENDING_SPF_INCLUDE}`,
    };
  if (terms.includes("+all") || terms.includes("all"))
    return {
      check: "spf",
      ok: false,
      detail: "passes every sender (+all)",
    };
  return { check: "spf", ok: true, detail: spf[0]!.trim() };
}

function checkDkim(txt: string[]): EmailDnsFinding {
  const dkim = txt.filter((t) => /^v=DKIM1(\s*;|$)/i.test(t.trim()));
  if (dkim.length !== 1)
    return {
      check: "dkim",
      ok: false,
      detail:
        dkim.length === 0
          ? "no v=DKIM1 record"
          : `${dkim.length} v=DKIM1 records`,
    };
  const tags = parseTags(dkim[0]!);
  const p = tags.get("p") ?? "";
  if (p === "")
    return {
      check: "dkim",
      ok: false,
      detail: "empty p= (the key is revoked)",
    };
  if ((tags.get("k") ?? "rsa").toLowerCase() !== "rsa")
    return {
      check: "dkim",
      ok: false,
      detail: `k=${tags.get("k")} (Cloudflare signs with rsa)`,
    };
  return { check: "dkim", ok: true, detail: `rsa key, ${p.length} chars` };
}

const isDmarc = (t: string): boolean => /^v=DMARC1(\s*;|$)/i.test(t.trim());

function checkDmarc(txt: string[], orgTxt?: string[]): EmailDnsFinding {
  const own = txt.filter(isDmarc);
  const inherited = own.length === 0 && (orgTxt ?? []).some(isDmarc);
  const dmarc = inherited ? (orgTxt ?? []).filter(isDmarc) : own;
  if (dmarc.length !== 1)
    return {
      check: "dmarc",
      ok: false,
      detail:
        dmarc.length === 0
          ? "no v=DMARC1 record at _dmarc"
          : `${dmarc.length} v=DMARC1 records (RFC 7489 §6.6.3: none applies)`,
    };
  const tags = parseTags(dmarc[0]!);
  const p = (
    (inherited ? tags.get("sp") : undefined) ??
    tags.get("p") ??
    ""
  ).toLowerCase();
  if (p !== "quarantine" && p !== "reject")
    return {
      check: "dmarc",
      ok: false,
      detail: `p=${p || "(missing)"}: not enforcing (want quarantine or reject)`,
    };
  const pct = tags.get("pct");
  if (pct !== undefined && pct.trim() !== "100")
    return {
      check: "dmarc",
      ok: false,
      detail: `pct=${pct}: the policy applies to only part of the mail`,
    };
  if ((tags.get("aspf") ?? "r").toLowerCase() === "s")
    return {
      check: "dmarc",
      ok: false,
      detail:
        "aspf=s: SPF passes for cf-bounce.<domain>, which aligns only under relaxed SPF alignment",
    };
  return {
    check: "dmarc",
    ok: true,
    detail: `${inherited ? "inherited from the organizational domain: " : ""}${dmarc[0]!.trim()}`,
  };
}

function checkBounceMx(mx: string[]): EmailDnsFinding {
  const hosts = new Set(mx.map((h) => h.replace(/\.$/, "").toLowerCase()));
  const missing = EMAIL_SENDING_BOUNCE_MX.filter((h) => !hosts.has(h));
  return missing.length === 0
    ? { check: "bounce_mx", ok: true, detail: [...hosts].sort().join(", ") }
    : {
        check: "bounce_mx",
        ok: false,
        detail: `missing ${missing.join(", ")}`,
      };
}

/** Decide whether `noreply@<domain>` passes SPF, DKIM and DMARC with alignment. */
export function evaluateEmailDns(
  domain: string,
  records: EmailDnsRecords,
): EmailDnsReport {
  const findings = [
    checkBounceMx(records.bounceMx),
    checkSpf(records.bounceTxt),
    checkDkim(records.dkimTxt),
    checkDmarc(records.dmarcTxt, records.orgDmarcTxt),
  ];
  return { domain, ok: findings.every((f) => f.ok), findings };
}
