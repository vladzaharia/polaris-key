# Examples

Runnable samples per SDK and host (SDK parity pass §5.7, SP-D02). Each is a standalone package
that installs the SDKs from Polaris Key's npm feed
(`@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/` in `.npmrc`).

| Sample                             | Shows                                                                |
| ---------------------------------- | -------------------------------------------------------------------- |
| [`node-express`](./node-express)   | Verifying a client's licence on a backend (`verifyLicenseDocument`)  |
| [`node-cli`](./node-cli)           | A commander CLI with the full kit, sign-in and device-limit recovery |
| [`node-electron`](./node-electron) | Electron main + preload + the React kit over the PolarisBridge       |
| [`ui`](./ui)                       | The UI-kit samples hub: one runnable sample per kit                  |

`packages/sdk-node/test/examples.test.ts` checks that every name these samples import from
`@polaris-key/node` exists, so a rename fails the SDK's tests instead of the sample.
