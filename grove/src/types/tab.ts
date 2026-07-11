export type AppTabType = "terminal" | "changes" | "browser" | "file";

export interface AppTab {
  id: string;
  type: AppTabType;
  title: string;
  closable: boolean;
  /** Favicon URL for browser tabs, shown on the tab chip. */
  faviconUrl?: string;
}
