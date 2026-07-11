export interface PipBroadcastDecisionInput {
  isTerminal: boolean;
  wasTerminal: boolean;
  focusedPtyId: string | null;
  hasActivePip: boolean;
  isFocusedPtyMirroring: boolean;
}

export function shouldAttachPrimaryRuntime(isBroadcasting: boolean): boolean {
  return !isBroadcasting;
}

/** PiP follows the user to every non-terminal tab (browser tabs included). */
export function shouldStartPipBroadcast({
  isTerminal,
  wasTerminal,
  focusedPtyId,
  hasActivePip,
  isFocusedPtyMirroring,
}: PipBroadcastDecisionInput): boolean {
  return (
    !isTerminal && wasTerminal && Boolean(focusedPtyId) && !hasActivePip && !isFocusedPtyMirroring
  );
}
