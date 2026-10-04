/** RFC 4180 CSV: every field quoted when it holds a comma, quote or line break; CRLF rows. */
export function toCsv(header: string[], rows: string[][]): string {
  const field = (v: string): string =>
    /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [header, ...rows].map((r) => r.map(field).join(",")).join("\r\n");
}

/** A CSV cell value from anything an accessor returns. */
export function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(csvValue).join("; ");
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Save `csv` as a file. A Blob URL on a temporary `<a download>`; the page never navigates.
 * Returns false when the browser cannot create object URLs.
 */
export function downloadCsv(filename: string, csv: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
