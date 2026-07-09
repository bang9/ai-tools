export interface PipBroadcastDecisionInput {
  isTerminal: boolean;
  wasTerminal: boolean;
  focusedPtyId: string | null;
  hasActivePip: boolean;
  isFocusedPtyMirroring: boolean;
  /** Active tab is a native browser webview, which would cover the PiP. */
  activeTabIsBrowser: boolean;
}

export function shouldAttachPrimaryRuntime(isBroadcasting: boolean): boolean {
  return !isBroadcasting;
}

export function shouldStartPipBroadcast({
  isTerminal,
  wasTerminal,
  focusedPtyId,
  hasActivePip,
  isFocusedPtyMirroring,
  activeTabIsBrowser,
}: PipBroadcastDecisionInput): boolean {
  return (
    !isTerminal &&
    wasTerminal &&
    Boolean(focusedPtyId) &&
    !hasActivePip &&
    !isFocusedPtyMirroring &&
    !activeTabIsBrowser
  );
}
