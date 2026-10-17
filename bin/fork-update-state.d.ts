export interface ForkUpdateConfig {
  configPath: string;
  repoDir: string;
  branch: string;
  upstreamRemote: string;
  upstreamBranch: string;
  forkRemote: string;
  releasesDir: string;
  stateDir: string;
  proxyConfig: string;
  nodeBin: string;
  ompBin: string;
  user: string;
  ports: [number, number];
  serverEnv: Record<string, string>;
}

export interface ForkRelease {
  service: string;
  port: number;
  releaseDir: string;
  commit: string;
  version: string;
}

export type ForkUpdateStage = "starting" | "fetching" | "merging" | "installing" | "typechecking" | "testing" | "building" | "smoke" | "publishing" | "deploying" | "complete";
export interface ForkUpdateStatus {
  attemptId: string;
  state: "running" | "succeeded" | "failed" | "up_to_date";
  stage: ForkUpdateStage;
  startedAt: string;
  finishedAt?: string;
  fromVersion?: string;
  targetVersion?: string;
  commit?: string;
  upstreamCommit?: string;
  releaseDir?: string;
  error?: string;
  logFile?: string;
}

export interface ForkUpdateInfo {
  supported: boolean;
  reason?: string;
  current: ForkRelease | null;
  status: ForkUpdateStatus | null;
}

export function loadConfig(configPath: string): ForkUpdateConfig;
export function readStatus(config: ForkUpdateConfig): ForkUpdateStatus | null;
export function writeStatus(config: ForkUpdateConfig, status: ForkUpdateStatus): void;
export function readActive(config: ForkUpdateConfig): ForkRelease | null;
export function writeActive(config: ForkUpdateConfig, release: ForkRelease): void;
export function acquireLock(config: ForkUpdateConfig): boolean;
export function releaseLock(config: ForkUpdateConfig, attemptId?: string): void;
export function updateUnitName(attemptId: string): string;
