# syntax=docker/dockerfile:1.7
#
# The pkey image (F-10, plans/F-01.md §5.1): Node 22 plus the standalone CLI bundle, published only
# to Polaris Key's OCI feed as pkg.plrs.im/polaris-key/pkey (deliverable oci.pkey, never Docker
# Hub or any other registry). The bundle is the committed, freshness-checked
# actions/publish/dist/index.js, so the image runs exactly the CLI the polaris-key/publish Action
# runs at the same commit.
#
# Built by .github/workflows/release-image.yml for linux/amd64 and linux/arm64 into an OCI image
# layout, which `pkey release publish --deliverable oci.pkey` publishes:
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-context action=actions/publish --build-arg VERSION=<version> \
#     --provenance=false --sbom=false \
#     --output type=oci,dest=build/pkey-image,tar=false packages/cli/image
#
# No RUN step, so a cross-platform build needs no emulation. Run it with the project mounted:
#
#   docker run --rm -v "$PWD:/work" pkg.plrs.im/polaris-key/pkey:<version> validate

# node:22-slim, pinned by its multi-arch index digest (bump the digest with the tag).
ARG NODE_IMAGE=node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
FROM ${NODE_IMAGE}

ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="pkey" \
      org.opencontainers.image.description="The Polaris Key platform CLI (pkey)" \
      org.opencontainers.image.source="https://github.com/vladzaharia/polaris-key" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

COPY --from=action dist/index.js /opt/pkey/pkey.mjs
COPY --from=action LICENSE THIRD_PARTY_NOTICES /opt/pkey/

WORKDIR /work
USER node
ENTRYPOINT ["node", "/opt/pkey/pkey.mjs"]
