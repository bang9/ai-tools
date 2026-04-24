import type { FileDiff, FileStatus } from "../types";

type FilePathEntry = Pick<FileStatus, "path">;

export function selectFilePathRange(
  files: readonly FilePathEntry[],
  anchorPath: string | null,
  targetPath: string,
): Set<string> | null {
  if (!anchorPath) return null;

  const anchorIndex = files.findIndex((file) => file.path === anchorPath);
  const targetIndex = files.findIndex((file) => file.path === targetPath);
  if (anchorIndex < 0 || targetIndex < 0) return null;

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const selected = new Set<string>();
  for (let index = start; index <= end; index++) {
    selected.add(files[index].path);
  }
  return selected;
}

export function firstSelectedFilePath(
  files: readonly FilePathEntry[],
  selectedPaths: Set<string>,
): string | null {
  return files.find((file) => selectedPaths.has(file.path))?.path ?? null;
}

export function filterDiffsBySelectedPaths(
  diffs: readonly FileDiff[],
  selectedPaths: Set<string>,
): FileDiff[] {
  if (selectedPaths.size === 0) return [];
  return diffs.filter((diff) => selectedPaths.has(diff.path));
}
