// Maps a filename to a shiki bundled language id, or null for plain text.

const EXTENSION_TO_LANG: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  cjs: "js",
  mjs: "js",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  rs: "rust",
  go: "go",
  py: "python",
  pyi: "python",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
  xml: "xml",
  svg: "xml",
  ini: "ini",
  lua: "lua",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
  prisma: "prisma",
  php: "php",
  dart: "dart",
  scala: "scala",
  proto: "proto",
};

const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  "cmakelists.txt": "cmake",
  ".gitignore": "gitignore",
  ".dockerignore": "gitignore",
  ".env": "dotenv",
};

export function detectLanguage(filename: string): string | null {
  const base = (filename.split("/").pop() ?? filename).toLowerCase();

  const byName = FILENAME_TO_LANG[base];
  if (byName) return byName;

  // Dockerfiles are frequently suffixed (Dockerfile.dev) or prefixed.
  if (base.startsWith("dockerfile")) return "dockerfile";

  const dotIndex = base.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const ext = base.slice(dotIndex + 1);
  return EXTENSION_TO_LANG[ext] ?? null;
}
