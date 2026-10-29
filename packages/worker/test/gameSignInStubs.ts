// I-14.8: stand-ins for the two game verifiers in the wiring tests (exchange, link). The verifiers
// have their own suites (gameCenter, playGames); a wiring test mocks both modules
// (a `vi.fn()` for the verifier) and sets the answer here. Every value is an obviously fake one.

import { vi } from "vitest";
import { OidcVerifyError } from "../src/core/oidc/client.js";
import { verifyGameCenterToken } from "../src/services/identity/providers/gameCenter.js";
import { verifyPlayGamesCode } from "../src/services/identity/providers/playGames.js";

/** Both verifiers refuse until a test says otherwise. */
export function refuseGameTokens(): void {
  vi.mocked(verifyGameCenterToken)
    .mockReset()
    .mockRejectedValue(new OidcVerifyError("x"));
  vi.mocked(verifyPlayGamesCode)
    .mockReset()
    .mockResolvedValue({ ok: false, reason: "invalid_grant" });
}

export function gameCenterIs(
  subject: string,
  scope: string,
  bundleId: string,
): void {
  vi.mocked(verifyGameCenterToken).mockResolvedValue({
    subject,
    scope,
    bundleId,
  });
}

export function playGamesIs(
  applicationId: string,
  subject: string,
  alternateSubject: string | null = null,
): void {
  vi.mocked(verifyPlayGamesCode).mockResolvedValue({
    ok: true,
    identity: {
      kind: "pgs",
      issuerKey: "pgs",
      subject,
      alternateSubject,
      tenantScopes: [`pgs-app:${applicationId}`],
      email: null,
      emailVerified: false,
      reach: "developer",
    },
  });
}
