export type EnvValueSource = "process" | "launchctl" | "ancestorProcess" | "interactiveShell";

export interface SubprocessEnvVar {
  key: string;
  value: string;
}

export interface PathDiagnostics {
  processEnv: string | null;
  interactiveShellEnv: string | null;
  loginShellEnv: string | null;
  preferredEnvSource: EnvValueSource | null;
  preferredEnvValue: string | null;
  mergedBaseValue: string;
  finalValue: string;
}

export interface SshAuthSockDiagnostics {
  processEnv: string | null;
  launchctlEnv: string | null;
  ancestorProcessEnv: string | null;
  interactiveShellEnv: string | null;
  selectedSource: EnvValueSource | null;
  selectedValue: string | null;
}

export interface ProcessEnvDiagnostics {
  shell: string | null;
  zdotdir: string | null;
  groveZdotdir: string | null;
  path: PathDiagnostics;
  sshAuthSock: SshAuthSockDiagnostics;
  subprocessEnv: SubprocessEnvVar[];
}
