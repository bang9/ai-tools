const UNITS = ["KB", "MB", "GB", "TB"];

/** Format a byte count as a short human-readable size (e.g. "1.4 MB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < UNITS.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = size < 10 ? size.toFixed(1) : Math.round(size).toString();
  return `${rounded} ${UNITS[unitIndex]}`;
}
