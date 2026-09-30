import { defineConfig } from "tsdown";

export default defineConfig({
  // Library (import { Tubeship } from "tubeship") and the CLI (bin: tubeship).
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  platform: "node",
  clean: true,
  dts: true,
  // package.json declares "type": "module", so plain .js is unambiguous: keep
  // dist/index.js and dist/cli.js instead of tsdown's default .mjs.
  fixedExtension: false,
});
