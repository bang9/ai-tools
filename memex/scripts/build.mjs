import * as esbuild from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  external: ["@anthropic-ai/claude-agent-sdk", "@huggingface/transformers"],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
};

// MCP server
await esbuild.build({
  ...shared,
  entryPoints: ["src/mcp.ts"],
  outfile: "dist/mcp.js",
});

// Hook entry point (Stop hook)
await esbuild.build({
  ...shared,
  entryPoints: ["src/hook.ts"],
  outfile: "dist/hook.js",
});

// Tests
await esbuild.build({
  ...shared,
  entryPoints: [
    "src/__tests__/store.test.ts",
    "src/__tests__/collector.test.ts",
    "src/__tests__/analyzer.test.ts",
    "src/__tests__/mcp.test.ts",
    "src/__tests__/embedder.test.ts",
    "src/__tests__/routing.test.ts",
  ],
  outdir: "dist/__tests__",
  outExtension: { ".js": ".test.js" },
});

console.log("Build complete");
