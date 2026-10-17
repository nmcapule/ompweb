import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  acquireLock,
  loadConfig,
  readActive,
  readStatus,
  releaseLock,
  updateUnitName,
  writeStatus,
  type ForkUpdateConfig,
  type ForkUpdateInfo,
  type ForkUpdateStatus,
} from "../bin/fork-update-state";
import { createChildProcessEnvironment } from "./project-command-env";
import { isRecord } from "./type-guards";

const execute = promisify(execFile);
const START_GRACE_MS = 30_000;

export class ForkUpdateError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus = 500) {
    super(message);
    this.name = "ForkUpdateError";
  }
}

function configured(): ForkUpdateConfig | null {
  const file = process.env.OMP_WEB_FORK_UPDATE_CONFIG;
  if (!file) return null;
  if (process.platform !== "linux") throw new Error("Fork updates require Linux and systemd.");
  const config = loadConfig(file);
  if (config.user !== userInfo().username) throw new Error("Fork updater user must match the web service user.");
  return config;
}

export function getForkUpdateSupport(): { supported: boolean; reason?: string } {
  try {
    return { supported: configured() !== null };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A missing/failed unit is evidence of an abandoned worker; a failed query is not. */
async function workerActive(status: ForkUpdateStatus): Promise<boolean> {
  let output: string;
  try {
    output = (await execute("systemctl", ["show", updateUnitName(status.attemptId), "--property=ActiveState", "--property=LoadState"], {
      timeout: 5_000,
      maxBuffer: 8_192,
      env: createChildProcessEnvironment(),
    })).stdout;
  } catch (error) {
    output = isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
    if (!/^ActiveState=(inactive|failed)$/m.test(output)) {
      throw new ForkUpdateError("Cannot inspect the fork update worker. The existing update lease was left intact.", "fork_update_worker_unavailable");
    }
  }
  const state = /^ActiveState=(.+)$/m.exec(output)?.[1];
  if (!state) throw new ForkUpdateError("The fork update worker state is unavailable.", "fork_update_worker_unavailable");
  return state !== "inactive" && state !== "failed";
}

async function reconcileWorker(config: ForkUpdateConfig): Promise<void> {
  const status = readStatus(config);
  if (status) {
    if (status.state === "running" && status.stage === "starting" && Date.now() - Date.parse(status.startedAt) < START_GRACE_MS) return;
    if (status.state === "running" && !await workerActive(status)) {
      const latest = readStatus(config);
      if (latest?.attemptId !== status.attemptId || latest.state !== "running") return;
      writeStatus(config, {
        ...status,
        state: "failed",
        finishedAt: new Date().toISOString(),
        error: "The fork update worker stopped before completing. The previous deployment is retained unless its cutover was already recorded; inspect the update log before retrying.",
      });
      releaseLock(config, status.attemptId);
    }
    if (status.state !== "running") {
      try {
        const lock = statSync(join(config.stateDir, "update.lock"));
        if (Date.now() - lock.mtimeMs > START_GRACE_MS && !await workerActive(status)) {
          const latest = readStatus(config);
          if (latest?.attemptId === status.attemptId && latest.state !== "running") releaseLock(config, status.attemptId);
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
    }
    return;
  }
  // A web process can die between exclusive mkdir and its first status write.
  // A new request never takes a fresh lease away from that narrow startup gap.
  try {
    const lock = statSync(join(config.stateDir, "update.lock"));
    if (Date.now() - lock.mtimeMs > START_GRACE_MS && readStatus(config) === null) releaseLock(config);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
}

export async function getForkUpdateInfo(): Promise<ForkUpdateInfo> {
  let config: ForkUpdateConfig | null;
  try {
    config = configured();
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error), current: null, status: null };
  }
  if (!config) return { supported: false, current: null, status: null };
  await reconcileWorker(config);
  return { supported: true, current: readActive(config), status: readStatus(config) };
}

export async function startForkUpdate(): Promise<ForkUpdateInfo> {
  let config: ForkUpdateConfig | null;
  try {
    config = configured();
  } catch (error) {
    throw new ForkUpdateError(error instanceof Error ? error.message : String(error), "fork_update_configuration");
  }
  if (!config) throw new ForkUpdateError("Fork updates are not configured for this installation.", "fork_update_unavailable", 503);
  await reconcileWorker(config);
  const active = readActive(config);
  if (!active) throw new ForkUpdateError("The active fork deployment has not been registered.", "fork_update_configuration");
  if (!acquireLock(config)) throw new ForkUpdateError("A fork update is already in progress.", "fork_update_in_progress", 409);

  const attemptId = randomUUID();
  const status: ForkUpdateStatus = {
    attemptId,
    state: "running",
    stage: "starting",
    startedAt: new Date().toISOString(),
    fromVersion: active.version,
  };
  try {
    writeStatus(config, status);
    await execute("sudo", [
      "-n", "systemd-run",
      `--unit=${updateUnitName(attemptId)}`,
      "--collect", `--uid=${config.user}`,
      `--setenv=HOME=${homedir()}`,
      `--setenv=PATH=${process.env.PATH ?? `${dirname(config.nodeBin)}:/usr/local/bin:/usr/bin:/bin`}`,
      `--property=WorkingDirectory=${config.repoDir}`,
      "--property=Type=exec",
      config.nodeBin, join(config.repoDir, "bin", "fork-update-worker.js"),
      "--config", config.configPath, "--attempt", attemptId,
    ], { timeout: 15_000, maxBuffer: 16_384, env: createChildProcessEnvironment() });
  } catch (error) {
    // systemd-run can time out after systemd accepted the job. Never release its
    // lease or label it failed while that worker can still own the deployment.
    if (await workerActive(status)) {
      return { supported: true, current: readActive(config), status: readStatus(config) };
    }
    const detail = isRecord(error) && typeof error.stderr === "string" && error.stderr
      ? error.stderr
      : error instanceof Error ? error.message : String(error);
    writeStatus(config, { ...status, state: "failed", finishedAt: new Date().toISOString(), error: `Cannot start the fork update worker: ${detail.slice(-4_000)}` });
    releaseLock(config, attemptId);
    throw new ForkUpdateError("Cannot start the fork update worker. Check its status for details.", "fork_update_launch_failed");
  }
  return { supported: true, current: readActive(config), status: readStatus(config) };
}
