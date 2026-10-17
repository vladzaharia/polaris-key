# Express: verify a client's licence on your backend

`polarisKey()` and `requireEntitlement()` from `@polaris-key/server/express` check the licence
document a desktop or CLI client sends in `X-PKey-License`: signature against the pinned keys and
the signed trust manifest, audience, freshness. No device state. The fuller app, with a sign-in
route and a `/whoami` probe, is `server-express`.

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install && npm start
```

Replace `polaris.config.ts` with the file `pkey sdk --lang node --write` generates.
