// ID-token verification constants. I-30: they belong to the one relying-party client
// (`core/oidc/client.ts`), which every OIDC sign-in now goes through; re-exported here for the
// Identity modules that name them.

export {
  ALLOWED_ID_TOKEN_ALGS,
  ID_TOKEN_CLOCK_TOLERANCE,
  ID_TOKEN_MAX_AGE,
} from "../../core/oidc/client.js";
