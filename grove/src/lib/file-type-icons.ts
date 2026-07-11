import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
  FileType2,
  FileVideo,
  Lock,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Icons keyed by exact filename (case-insensitive). */
const ICONS_BY_NAME: Record<string, LucideIcon> = {
  "package.json": FileJson,
  "tsconfig.json": FileJson,
  "pnpm-lock.yaml": Lock,
  "yarn.lock": Lock,
  "package-lock.json": Lock,
  "cargo.toml": FileCog,
  "cargo.lock": Lock,
  dockerfile: FileCode,
  makefile: FileCog,
  ".gitignore": Settings,
  ".gitattributes": Settings,
  license: FileText,
  "readme.md": FileText,
  "vite.config.ts": FileCog,
  ".env": FileLock,
};

/** Icons keyed by lowercase file extension (without the dot). */
const ICONS_BY_EXTENSION: Record<string, LucideIcon> = {
  // Code
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  rs: FileCode,
  go: FileCode,
  py: FileCode,
  rb: FileCode,
  java: FileCode,
  kt: FileCode,
  swift: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cs: FileCode,
  lua: FileCode,
  sql: FileCode,
  // Shell
  sh: FileTerminal,
  zsh: FileTerminal,
  bash: FileTerminal,
  // Markup / web templates
  html: FileCode2,
  xml: FileCode2,
  svelte: FileCode2,
  vue: FileCode2,
  astro: FileCode2,
  // Styles
  css: FileType2,
  scss: FileType2,
  less: FileType2,
  // Data
  json: FileJson,
  jsonl: FileJson,
  // Config
  yml: FileCog,
  yaml: FileCog,
  toml: FileCog,
  ini: FileCog,
  conf: FileCog,
  // Docs
  md: FileText,
  mdx: FileText,
  txt: FileText,
  pdf: FileText,
  // Images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  bmp: FileImage,
  ico: FileImage,
  avif: FileImage,
  svg: FileImage,
  // Archives
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  tgz: FileArchive,
  rar: FileArchive,
  "7z": FileArchive,
  // Lock files
  lock: Lock,
  // Media
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
  mkv: FileVideo,
  avi: FileVideo,
  mp3: FileAudio,
  wav: FileAudio,
  flac: FileAudio,
  aac: FileAudio,
  ogg: FileAudio,
};

export function getFileTypeIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();

  const exact = ICONS_BY_NAME[lower];
  if (exact) return exact;

  // Dotfile prefixes like ".env.local" share the ".env" icon.
  if (lower.startsWith(".env")) return FileLock;

  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex > 0) {
    const extension = lower.slice(dotIndex + 1);
    const byExtension = ICONS_BY_EXTENSION[extension];
    if (byExtension) return byExtension;
  }

  return File;
}
