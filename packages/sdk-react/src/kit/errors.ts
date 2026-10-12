/** The error fields the SDK-driven kit gate needs to map a refusal to an input state. */
export interface ErrorLike {
  code?: string;
  wireCode?: string;
  manageUrl?: string;
  activation?: {
    kind: string;
    code: string;
    limit?: number;
    deviceCount?: number;
    retryAfterSeconds?: number;
  };
}
