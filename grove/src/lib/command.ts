import { useToastStore } from "../store/toast";
import { getCommandErrorMessage } from "./platform";

export interface CommandOptions {
  errorToast?: string | false;
}

export class CommandExecutionError extends Error {
  toastHandled: boolean;

  constructor(message: string, toastHandled: boolean, cause?: unknown) {
    super(message);
    this.name = "CommandExecutionError";
    this.toastHandled = toastHandled;
    if (cause !== undefined) {
      (this as CommandExecutionError & { cause?: unknown }).cause = cause;
    }
  }
}

function formatErrorToast(prefix: string | false | undefined, message: string): string | null {
  if (prefix === false) return null;
  if (typeof prefix === "string" && prefix.length > 0) {
    return `${prefix}: ${message}`;
  }
  return message;
}

export function isHandledCommandError(error: unknown): error is CommandExecutionError {
  return error instanceof CommandExecutionError && error.toastHandled;
}

export async function runCommand<T>(
  action: () => Promise<T>,
  options?: CommandOptions,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      throw error;
    }

    const message = getCommandErrorMessage(error);
    const toastMessage = formatErrorToast(options?.errorToast, message);

    if (toastMessage) {
      useToastStore.getState().addToast("error", toastMessage);
    }

    throw new CommandExecutionError(message, toastMessage !== null, error);
  }
}

export async function runCommandSafely<T>(
  action: () => Promise<T>,
  options?: CommandOptions,
): Promise<T | null> {
  try {
    return await runCommand(action, options);
  } catch {
    return null;
  }
}
