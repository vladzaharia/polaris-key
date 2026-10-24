import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  type AppConsentView,
  type LicenseChoiceView,
  type ReplaceView,
  type SignInRequestView,
} from "./api.js";
import { pq } from "./queries.js";

/** The app asking (works before sign-in: the binder cookie, not a session). */
export function useSignInRequest(
  handle: string | null,
): UseQueryResult<SignInRequestView> {
  return useQuery(pq.signinRequest(handle));
}

export function useSignInLicenses(
  handle: string,
  enabled: boolean,
): UseQueryResult<LicenseChoiceView> {
  return useQuery(pq.signinLicenses(handle, enabled));
}

export function useSignInDevices(
  handle: string,
  licenseId: string,
): UseQueryResult<ReplaceView> {
  return useQuery(pq.signinDevices(handle, licenseId));
}

export function useSignInConsent(
  handle: string,
  enabled: boolean,
): UseQueryResult<AppConsentView> {
  return useQuery(pq.signinConsent(handle, enabled));
}
