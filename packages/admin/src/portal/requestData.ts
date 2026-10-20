import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  portalApi,
  type AppConsentView,
  type LicenseChoiceView,
  type ReplaceView,
  type SignInRequestView,
} from "./api.js";

/**
 * The app card's reads (PX-14a). One family per read, every key under "portal" and the request's
 * handle, so a new request never shows the last one's answer. Nothing retries silently; a failed
 * read shows its error and a Try again.
 */
const rk = {
  request: (h: string) => ["portal", "signinRequest", h] as const,
  licenses: (h: string) => ["portal", "signinLicenses", h] as const,
  devices: (h: string, license: string) =>
    ["portal", "signinDevices", h, license] as const,
  consent: (h: string) => ["portal", "signinConsent", h] as const,
};

export const requestKeys = rk;

/** The app asking (works before sign-in: the binder cookie, not a session). */
export function useSignInRequest(
  handle: string | null,
): UseQueryResult<SignInRequestView> {
  return useQuery({
    queryKey: rk.request(handle ?? ""),
    queryFn: () => portalApi.signinRequest(handle!),
    enabled: handle !== null,
    staleTime: 60_000,
  });
}

export function useSignInLicenses(
  handle: string,
  enabled: boolean,
): UseQueryResult<LicenseChoiceView> {
  return useQuery({
    queryKey: rk.licenses(handle),
    queryFn: () => portalApi.signinLicenses(handle),
    enabled,
    staleTime: 0,
  });
}

export function useSignInDevices(
  handle: string,
  licenseId: string,
): UseQueryResult<ReplaceView> {
  return useQuery({
    queryKey: rk.devices(handle, licenseId),
    queryFn: () => portalApi.signinDevices(handle, licenseId),
    staleTime: 0,
  });
}

export function useSignInConsent(
  handle: string,
  enabled: boolean,
): UseQueryResult<AppConsentView> {
  return useQuery({
    queryKey: rk.consent(handle),
    queryFn: () => portalApi.signinConsent(handle),
    enabled,
    staleTime: 0,
  });
}
