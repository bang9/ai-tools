export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface FileStatus {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
}

export interface DirectoryFileEntry {
  path: string;
  name: string;
  entryType: "directory" | "file";
  depth: number;
}

export interface DeepDirectoryListing {
  entries: DirectoryFileEntry[];
  /** True when the listing hit the backend entry cap and is incomplete. */
  truncated: boolean;
}

export type WorkspaceFileKind = "text" | "image" | "binary" | "tooLarge";

export interface WorkspaceFileContent {
  kind: WorkspaceFileKind;
  /** UTF-8 text for kind=text, base64 payload for kind=image, empty otherwise. */
  content: string;
  size: number;
  mimeType: string | null;
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  index: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface BehindInfo {
  behind: number;
  defaultBranch: string;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus["status"];
  hunks: DiffHunk[];
  displayLineCount: number;
}
