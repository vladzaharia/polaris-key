---
title: "Server-side licence checks"
description: "Verify a device's signed licence document on your own backend with the same verifier the SDKs use."
sidebar:
  order: 2
---

A backend that grants something to a device (a cloud save, a multiplayer seat, a download of its
own) should not trust a "licensed: true" flag sent by the client. It should verify the device's
signed licence document, a `pkey-license+jws`, exactly as the SDKs do.

## Verify the document

The verifier needs the JWS, the product's trust pins (the same `pinnedKeys` that
`pkey sdk` writes), the product slug (the audience) and the device id the document must name.

```ts
import { verifyLicenseDoc } from "@polaris-key/client-core/verify";

const doc = await verifyLicenseDoc(jws, {
  trust: polarisConfig.trust.pinnedKeys,
  expectedAud: polarisConfig.productSlug,
  deviceId, // the device this request claims to be
});
if (!doc) return deny(); // bad signature, wrong product or device, expired, malformed
const entitled = doc.entitlements["cloudSaves"]?.value === true;
```

```python
from polaris_key import verify_license_doc

import polaris_config

doc = verify_license_doc(
    jws,
    polaris_config.PINNED_KEYS,
    expected_aud=polaris_config.PRODUCT_SLUG,
    device_id=device_id,
)
entry = doc.entitlements.get("cloudSaves") if doc is not None else None
entitled = entry is not None and entry.value is True
```

A document that verifies has a valid signature from a pinned key, names this product and this
device, and is inside its freshness window (`expiresAt`). Revocation shows up as the server no
longer issuing a fresh document, so keep the window short and refuse a document you cannot
refresh. Read entitlements from `doc.entitlements`, each a `{ state, value }` entry.

## Where the JWS comes from

The app sends its document to your backend in an `X-PKey-License` header. The
`@polaris-key/server` package decides it for you, offline: the signature, the product, the
freshness window and the trust manifest, with a `401` or `403` problem body when it refuses. It has
drop-ins for Express, Hono and Next.js (framework docs follow with the drop-ins' own pages).
