import { useMemo } from "react";
import { useResolvedSidebarSelection } from "./useResolvedSidebarSelection";
import {
  resolveSelectionCapabilities,
  type SelectionCapabilities,
} from "../lib/selection-capabilities";

export function useSelectionCapabilities(): SelectionCapabilities {
  const selection = useResolvedSidebarSelection();
  return useMemo(() => resolveSelectionCapabilities(selection), [selection]);
}
