---
title: "Build"
description: "Write the manifest, add an SDK, test the integration and go live."
type: "overview"
lastReviewed: "2026-10-16"
sidebar:
  order: 1
---

import CardGrid from "../../../components/docs/CardGrid.astro";
import { LinkCard } from "@astrojs/starlight/components";

This section is for the developer who adds Polaris Key to an app. A product is described as data in a `.pkey/` manifest, the Worker signs documents against it, and an SDK in your app verifies them and gates on the result.

**Requires:** a product in the console, and the **Platform admin** role to create one.

## Get started

<CardGrid>
  <LinkCard
    title="Register a product from its repo"
    href="/docs/build/manifest/register/"
    description="Scaffold .pkey/ and link the repository."
  />
  <LinkCard
    title="Choose your integration"
    href="/docs/start/choose-your-integration/"
    description="Drop-in UI kit or your own UI, and your SDK."
  />
</CardGrid>

## Build

<CardGrid>
  <LinkCard
    title="The .pkey/ manifest"
    href="/docs/build/manifest/"
    description="Product, catalog, release and distribution files."
  />
  <LinkCard
    title="SDKs"
    href="/docs/build/sdks/"
    description="Node, React, Python, Swift, Kotlin and Godot."
  />
  <LinkCard
    title="Drop-in UI kits"
    href="/docs/build/ui/"
    description="Prebuilt screens for each SDK."
  />
  <LinkCard
    title="Install the SDKs and the CLI"
    href="/docs/build/install/"
    description="Package feeds and package managers."
  />
  <LinkCard
    title="Web apps"
    href="/docs/build/web-apps/"
    description="Browser origins and CORS."
  />
  <LinkCard
    title="Run Polaris Key locally"
    href="/docs/build/local/"
    description="A local server with a test key for every state."
  />
</CardGrid>

## Ship

<CardGrid>
  <LinkCard
    title="Test your integration"
    href="/docs/build/test-your-integration/"
    description="Test licenses, offline, grace and a skewed clock."
  />
  <LinkCard
    title="Go live"
    href="/docs/build/go-live/"
    description="Pins, signing and CI."
  />
  <LinkCard
    title="Troubleshoot your integration"
    href="/docs/build/troubleshooting/"
    description="Find the cause from the status or code."
  />
  <LinkCard
    title="Reference"
    href="/docs/reference/"
    description="CLI, error codes, settings and the protocol."
  />
</CardGrid>
