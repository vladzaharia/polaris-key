# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm gen:services` (tools/gen-services.ts) from tools/services.json, the
# one declaration of the opt-in services. `pnpm gen:services -- --check` fails the green
# gate on any difference. To change a service, edit the table and regenerate.
class_name PKeyServices
extends RefCounted
## The opt-in Polaris Key services, generated from the service table.

## The opt-in services, in canonical order. Core is not a service — it is always on.
const SLUGS := ["license", "config", "release", "distribution", "update", "identity"]

## What a product runs when it has never said otherwise, in canonical order.
const DEFAULT_ENABLED := ["license", "config"]
