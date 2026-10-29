export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface SsecReport {
  verdict: "supported" | "fallback";
  supported: boolean;
  checks: ProbeCheck[];
}
export function probeSsec(
  bucket: R2Bucket,
  options?: { prefix?: string },
): Promise<SsecReport>;
