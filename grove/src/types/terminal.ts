export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  fontFamily: string;
  fontSize: number;
}

export interface PtySession {
  id: string;
  worktreePath: string;
}

export interface SplitNode {
  id: string;
  type: "leaf" | "horizontal" | "vertical";
  ptyId?: string;
  label?: string;
  children?: SplitNode[];
  sizes?: number[];
}
