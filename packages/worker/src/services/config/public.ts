/**
 * Config's public surface for the console (P0-17): the one module under
 * `services/config/` that `console/` may import (`test/boundaries.test.ts`). It re-exports exactly
 * what the console uses; anything new the console needs from this service is added here.
 */

export {
  approvalMismatch,
  listEdgeMintRecipesWithApprovals,
  mintApprovalBasis,
  type MintPolicyProduct,
} from "./mint.js";
