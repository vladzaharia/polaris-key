// The QR encoder, apart from the gate's entry: the build bundles it into dist/kit/qr.js and the kit
// loads it the first time a view draws a QR (an offline request, a no-browser hand-off), the way a
// launch locale's copy loads. (scripts/bundle-contract.mjs; the SP-47 size budget.)
export { encodeQr } from "@polaris-key/elements/contract";
