// The page's default device key store. The adapter loads this module on the first Connect call,
// so the key store code stays out of the initial load of a page that never uses Connect.
import { createWebDeviceKeyStore } from "@polaris-key/client-core";
import type { DeviceKeyPort } from "@polaris-key/client-core";

export function webDeviceKeys(): DeviceKeyPort {
  return createWebDeviceKeyStore();
}
