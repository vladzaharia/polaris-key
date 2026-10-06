# Express: verify a client's licence on your backend

`requireLicense(entitlement?)` checks the licence document a desktop or CLI client presents,
with `verifyLicenseDocument` from `@polaris-key/node/server`: signature against the pinned keys,
audience, device binding, the gate (`ok` or `grace`) and an age bound. It needs no device state
and makes no call to Polaris Key.

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install && npm start
```

Replace `polaris.config.ts` with the file `pkey sdk --lang node --write` generates.
