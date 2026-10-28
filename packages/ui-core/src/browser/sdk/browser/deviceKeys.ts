// The page's default device key store. The adapter loads this module on the first key use (ring, sign-in ladder or Connect),
// so the key store code stays out of the initial load of a page that never needs a device key.
import { createWebDeviceKeyStore } from "@polaris-key/client-core";
import type { DeviceKeyPort } from "@polaris-key/client-core";

export function webDeviceKeys(): DeviceKeyPort {
  return createWebDeviceKeyStore();
}
