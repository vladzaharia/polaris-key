# polaris-storefront (S-21)

The reference eligibility engine for [S-21](../../notes/S-21-polaris-storefront.md). It models
§6.3 of the note: the obtain paths (`store_owned`, `group`, `product_idp`, `email_domain`,
`auto_issue`, `open`), the listing modes (`auto`, `listed`, `unlisted`), audience `everyone`,
the held-product rule and the identical answer for unknown, unlisted and ineligible products.
PS-03 ports it to the Worker as `services/identity/portal/store/obtain.ts`.

It requires Node 22, has no dependencies and writes nothing.

```sh
mise exec node@22 -- node obtain.mjs --self-test
```

The table in `selfTest()` is the acceptance table for PS-03's unit test. The two must not drift
apart. S-21 §5 records the measured run.
