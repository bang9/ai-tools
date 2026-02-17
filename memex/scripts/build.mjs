import * as esbuild from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  external: ["@anthropic-ai/claude-agent-sdk"],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
};

// MCP server
await esbuild.build({
  ...shared,
  entryPoints: ["src/mcp.ts"],
  outfile: "dist/mcp.js",
});

// CLI
await esbuild.build({
  ...shared,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node\n" + shared.banner.js },
});

// Tests
await esbuild.build({
  ...shared,
  entryPoints: ["src/__tests__/store.test.ts"],
  outdir: "dist/__tests__",
  outExtension: { ".js": ".test.js" },
});

console.log("Build complete");
