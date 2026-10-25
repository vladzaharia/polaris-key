# Polaris Key agent kit

Skills that teach a coding agent to set up Polaris Key licensing and config in your app. The kit is a Claude Code plugin named `polaris-key`.

## Skills

- `authoring-pkey-manifests`: create or edit a product's `.pkey/` manifest, validate it until clean, and register it in the console.
- `adding-a-catalog-entry`: add or change a key in a product's config catalog, with its schema fragment, delivery and publish step.

## Install

Add the marketplace this kit ships with, then install the plugin:

```text
/plugin marketplace add <source>
/plugin install polaris-key@polaris-key
```

`<source>` is the marketplace you downloaded this kit from: a URL to its `marketplace.json`, or a local directory.

Docs: https://key.plrs.im/docs/
