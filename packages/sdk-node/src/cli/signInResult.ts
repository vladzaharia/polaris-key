// The CLI's view of a device-code `wait()`: the outcome folded to the three endings its screens
// and JSON know (`ready`, `expired`, `error`). The session itself answers `signedIn | expired |
// cancelled` and throws `sign-in-denied` / `sign-in-failed`; I-10a.6 moves the CLI onto that shape.

import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";
import type {
  DeviceCodeSession,
  ShownIdentity,
  WaitOptions,
} from "../identity/signIn.js";

export type CliSignInResult =
  | {
      status: "ready";
      identity?: ShownIdentity;
      attached?: "claimed" | "migrated";
    }
  | { status: "expired" }
  | { status: "cancelled" }
  | {
      status: "error";
      message: string;
      code: typeof ErrorCode.signInDenied | typeof ErrorCode.signInFailed;
    };

export async function waitForCli(
  session: DeviceCodeSession,
  opts: WaitOptions = {},
): Promise<CliSignInResult> {
  try {
    const o = await session.wait(opts);
    switch (o.kind) {
      case "signedIn":
        return {
          status: "ready",
          ...(o.identity ? { identity: o.identity } : {}),
          ...(o.activation.attached ? { attached: o.activation.attached } : {}),
        };
      case "expired":
        return { status: "expired" };
      case "cancelled":
        return { status: "cancelled" };
      default:
        return { status: "expired" };
    }
  } catch (e) {
    if (
      e instanceof PolarisError &&
      (e.code === ErrorCode.signInDenied || e.code === ErrorCode.signInFailed)
    )
      return { status: "error", message: e.message, code: e.code };
    throw e;
  }
}
