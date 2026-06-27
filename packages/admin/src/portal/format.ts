export function formatDate(epoch: number | null | undefined): string {
  if (!epoch) return "No expiry";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(epoch * 1000));
}

export function formatStamp(epoch: number | null | undefined): string {
  if (!epoch) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epoch * 1000));
}

export function formatBytes(value: number | null | undefined): string {
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let n = value / 1024;
  for (const unit of units) {
    if (n < 1024) return `${n.toFixed(n >= 10 ? 0 : 1)} ${unit}`;
    n /= 1024;
  }
  return `${n.toFixed(1)} TB`;
}
