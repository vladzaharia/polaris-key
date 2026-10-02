// workerd and wrangler import a `.wasm` file as a compiled `WebAssembly.Module`.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
