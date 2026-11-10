import type {
  AppConsentView,
  EndSessionRedirect,
  EndSessionView,
  LicenseChoiceView,
  ReplaceView,
  SignInContinueRequest,
  SignInRedirect,
  SignInRequestView,
} from "@polaris-key/protocol/identity";
import { call, enc } from "./transport.js";

export const requestApi = {
  /** PX-14a: the app asking to sign in (SIGN-IN.md §3.1). The binder cookie, not a session. */
  signinRequest: (handle: string) =>
    call<SignInRequestView>(`/api/signin/requests/${enc(handle)}`),

  /** What the app gets if the person continues (§3.8). */
  signinConsent: (handle: string) =>
    call<AppConsentView>(`/api/signin/requests/${enc(handle)}/consent`),

  /** The licence choice for this account (§3.6). */
  signinLicenses: (handle: string) =>
    call<LicenseChoiceView>(`/api/signin/requests/${enc(handle)}/licenses`),

  /** A full licence's seat-holding devices (§3.7). */
  signinDevices: (handle: string, licenseId: string) =>
    call<ReplaceView>(
      `/api/signin/requests/${enc(handle)}/licenses/${enc(licenseId)}/devices`,
    ),

  /** Continue to the app: records consent and the choice, answers where to go. */
  signinContinue: (handle: string, body: SignInContinueRequest) =>
    call<SignInRedirect>(`/api/signin/requests/${enc(handle)}/continue`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Cancel: `access_denied` goes back to the app. */
  signinCancel: (handle: string) =>
    call<SignInRedirect>(`/api/signin/requests/${enc(handle)}/cancel`, {
      method: "POST",
      body: "{}",
    }),

  /** I-21.12: the end-session request the sign-out page shows (works without a session: the binder cookie). */
  signoutRequest: (handle: string) =>
    call<EndSessionView>(`/api/signout/requests/${enc(handle)}`),

  /** Sign out: ends this browser's Polaris Locker session, answers where to go. */
  signoutConfirm: (handle: string) =>
    call<EndSessionRedirect>(`/api/signout/requests/${enc(handle)}/confirm`, {
      method: "POST",
      body: "{}",
    }),

  /** Stay signed in: ends nothing, answers where to go. */
  signoutCancel: (handle: string) =>
    call<EndSessionRedirect>(`/api/signout/requests/${enc(handle)}/cancel`, {
      method: "POST",
      body: "{}",
    }),
};
