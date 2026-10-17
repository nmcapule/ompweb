#!/usr/bin/env node
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const cp = require("node:child_process");
const { createHmac, randomBytes } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const state = require("./fork-update-state.js");
const { serializeServiceEnv } = require("./service-env.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRET_NAMES = new Set(["OMP_WEB_PASSWORD", "OMP_WEB_PASSWORD_HASH", "OMP_WEB_TRUSTED_HEADER_SECRET", "OMP_WEB_TRUSTED_HEADER_SHA256"]);
// Mirrors lib/project-command-env.ts without loading TypeScript into the worker.
function commandEnvironment(config, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (SECRET_NAMES.has(key.toUpperCase()) || ["PORT", "NODE_ENV", "NODE_OPTIONS", "HOSTNAME"].includes(key.toUpperCase()) || key.toUpperCase().startsWith("NEXT_") || key.toUpperCase().startsWith("GIT_")) delete env[key];
  env.PATH = `${path.dirname(config.nodeBin)}:${path.dirname(config.ompBin)}:${env.PATH || "/usr/bin:/bin"}`;
  env.OMP_WEB_DISABLE_AUTOUPDATE = "1";
  env.OMP_WEB_OMP_BIN = config.ompBin;
  env.GIT_TERMINAL_PROMPT = "0";
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  return env;
}
function createRunner(config, logFile) {
  const env = commandEnvironment(config);
  return function run(file, args, options = {}) {
    const { cwd = config.repoDir, timeout = 120000, allowFailure = false } = options;
    return new Promise((resolve, reject) => {
      let stdout = "", stderr = "", timedOut = false, cancelled = false, settled = false, killTimer;
      const log = (chunk) => { if (logFile) fs.appendFileSync(logFile, chunk, { mode: 0o600 }); };
      log(`\n$ ${JSON.stringify([file, ...args])}\n`);
      const child = cp.spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") log(`${error.message}\n`); } };
      const terminate = () => { killGroup("SIGTERM"); killTimer = setTimeout(() => killGroup("SIGKILL"), 15000); };
      const interrupted = () => { cancelled = true; terminate(); };
      process.once("SIGTERM", interrupted);
      process.once("SIGINT", interrupted);
      const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
      child.stdout.on("data", (chunk) => { log(chunk); stdout = (stdout + chunk.toString()).slice(-1024 * 1024); });
      child.stderr.on("data", (chunk) => { log(chunk); stderr = (stderr + chunk.toString()).slice(-8192); });
      const finish = (error, code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(killTimer);
        process.removeListener("SIGTERM", interrupted); process.removeListener("SIGINT", interrupted);
        // Also reap grandchildren that retained pipes after the direct child failed.
        if (error || code !== 0 || timedOut || cancelled) killGroup("SIGKILL");
        const result = { code, signal, stdout, stderr };
        if (!error && code === 0 && !timedOut && !cancelled) resolve(result);
        else if (allowFailure && !error && !timedOut && !cancelled) resolve(result);
        else reject(new Error(`${path.basename(file)} ${args[0] || ""} ${cancelled ? "was interrupted" : timedOut ? "timed out" : `failed (${error?.message || signal || code})`}: ${(stderr || stdout).trim().slice(-6000)}`));
      };
      child.on("error", (error) => finish(error, null, null));
      child.on("close", (code, signal) => finish(null, code, signal));
    });
  };
}
function gitRunner(config, run) {
  return async (cwd, args, allowFailure = false) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, allowFailure });
}
async function assertSource(config, git, expected) {
  const branch = (await git(config.repoDir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (branch !== config.branch) throw new Error(`Source must be on configured branch ${config.branch}, not ${branch}`);
  const dirty = (await git(config.repoDir, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
  if (dirty) throw new Error(`Source checkout has uncommitted files; refusing to stash or overwrite: ${dirty.slice(0, 1500)}`);
  const head = (await git(config.repoDir, ["rev-parse", "HEAD"])).stdout.trim();
  if (expected && expected !== head) throw new Error("Source HEAD changed during verification; not publishing this attempt");
  return head;
}
function withoutVersions(value, lock) {
  const result = structuredClone(value);
  delete result.version;
  if (lock && result.packages?.[""]) delete result.packages[""].version;
  return result;
}
function forkVersion(ours, upstream) {
  const match = /^(\d+\.\d+\.\d+)-habi\.(\d+)$/.exec(ours);
  const base = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(upstream);
  if (!match || !base) throw new Error("Expected a fork -habi.N version and a valid upstream package version");
  return `${base[1]}-habi.${match[1] === base[1] ? Number(match[2]) + 1 : 1}`;
}
async function resolveMergeConflicts(directory, git) {
  const files = (await git(directory, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim().split("\n").filter(Boolean);
  if (!files.length) throw new Error("Upstream merge failed without resolvable version conflicts");
  if (files.some((file) => !["package.json", "package-lock.json", "CHANGELOG.md"].includes(file))) throw new Error(`Ambiguous upstream merge conflicts: ${files.join(", ")}`);
  const resolved = [];
  for (const file of files) {
    if (file === "CHANGELOG.md") {
      let additions = 0;
      const text = fs.readFileSync(path.join(directory, file), "utf8");
      const combined = text.replace(/^<<<<<<<[^\n]*\n([\s\S]*?)^\|\|\|\|\|\|\|[^\n]*\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm, (_block, ours, base, theirs) => {
        if (base.trim()) throw new Error("Ambiguous CHANGELOG.md conflict: existing release notes were edited on both sides");
        additions++;
        return ours + theirs;
      });
      if (!additions || /^<<<<<<< /m.test(combined)) throw new Error("Unrecognized CHANGELOG.md merge conflict");
      resolved.push([file, combined]);
      continue;
    }
    const versions = [];
    for (const stage of [1, 2, 3]) {
      const result = await git(directory, ["show", `:${stage}:${file}`], true);
      if (result.code !== 0) throw new Error(`Cannot resolve added/deleted ${file} conflict`);
      try { versions.push(JSON.parse(result.stdout)); } catch { throw new Error(`Invalid JSON in ${file} merge stages`); }
    }
    const [base, ours, theirs] = versions;
    if (!isDeepStrictEqual(withoutVersions(base, file === "package-lock.json"), withoutVersions(ours, file === "package-lock.json"))) throw new Error(`Ambiguous ${file} conflict: fork changed more than its package version`);
    resolved.push([file, `${JSON.stringify(theirs, null, 2)}\n`]);
  }
  for (const [file, contents] of resolved) fs.writeFileSync(path.join(directory, file), contents);
  await git(directory, ["add", "--", ...files]);
}
async function prepareCandidate(config, attemptId, active, run, stage) {
  const git = gitRunner(config, run);
  const sourceHead = await assertSource(config, git);
  for (const name of [config.branch, config.upstreamBranch]) await git(config.repoDir, ["check-ref-format", "--branch", name]);
  stage("fetching");
  await git(config.repoDir, ["fetch", "--no-tags", config.upstreamRemote, `+refs/heads/${config.upstreamBranch}:refs/remotes/${config.upstreamRemote}/${config.upstreamBranch}`]);
  await git(config.repoDir, ["fetch", "--no-tags", config.forkRemote, `+refs/heads/${config.branch}:refs/remotes/${config.forkRemote}/${config.branch}`]);
  await assertSource(config, git, sourceHead);
  const remoteHead = (await git(config.repoDir, ["rev-parse", `refs/remotes/${config.forkRemote}/${config.branch}`])).stdout.trim();
  const upstreamCommit = (await git(config.repoDir, ["rev-parse", `refs/remotes/${config.upstreamRemote}/${config.upstreamBranch}`])).stdout.trim();
  const ancestor = async (a, b) => (await git(config.repoDir, ["merge-base", "--is-ancestor", a, b], true)).code === 0;
  let base = sourceHead;
  if (await ancestor(sourceHead, remoteHead)) base = remoteHead;
  else if (!await ancestor(remoteHead, sourceHead)) throw new Error("Source and fork remote diverged; refusing an automatic reconciliation");
  const upstreamDelta = !await ancestor(upstreamCommit, base);
  if (!upstreamDelta && sourceHead === active.commit && base === sourceHead) return { upToDate: true, sourceHead, upstreamCommit };
  const directory = path.join(config.releasesDir, `fork-${attemptId}`);
  if (fs.existsSync(directory)) throw new Error("Candidate release path already exists; refusing to overwrite it");
  fs.mkdirSync(config.releasesDir, { recursive: true });
  stage("merging", { upstreamCommit, releaseDir: directory });
  await git(config.repoDir, ["worktree", "add", "--detach", directory, base]);
  try {
    const ours = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version;
    if (!/^\d+\.\d+\.\d+-habi\.\d+$/.test(ours)) throw new Error("Source package version must retain the -habi.N fork suffix");
    let version = ours;
    if (upstreamDelta) {
      const upstreamPackage = JSON.parse((await git(directory, ["show", `${upstreamCommit}:package.json`])).stdout);
      version = forkVersion(ours, upstreamPackage.version);
      const merged = await git(directory, ["-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-commit", upstreamCommit], true);
      if (merged.code !== 0) await resolveMergeConflicts(directory, git);
      for (const file of ["package.json", "package-lock.json"]) {
        const filePath = path.join(directory, file);
        const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
        value.version = version;
        if (file === "package-lock.json" && value.packages?.[""]) value.packages[""].version = version;
        fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
      }
      await git(directory, ["add", "--", "package.json", "package-lock.json"]);
      await git(directory, ["-c", "user.name=OMP Web Fork Updater", "-c", "user.email=ompweb-updater@localhost", "commit", "-m", `Merge upstream ${upstreamCommit.slice(0, 12)} (${version})`]);
    }
    const commit = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
    return { directory, sourceHead, upstreamCommit, commit, version };
  } catch (error) {
    await git(config.repoDir, ["worktree", "remove", "--force", directory], true);
    throw error;
  }
}
async function verifyCandidate(config, candidate, run, stage) {
  const npmCli = path.resolve(path.dirname(config.nodeBin), "../lib/node_modules/npm/bin/npm-cli.js");
  if (!fs.existsSync(npmCli)) throw new Error(`npm CLI not found beside configured Node: ${npmCli}`);
  for (const [phase, args, timeout] of [
    ["installing", ["ci"], 15 * 60000],
    ["typechecking", ["run", "typecheck"], 5 * 60000],
    ["testing", ["test"], 20 * 60000],
    ["building", ["run", "build"], 20 * 60000],
  ]) {
    stage(phase);
    await run(config.nodeBin, [npmCli, ...args], { cwd: candidate.directory, timeout });
  }
  stage("smoke");
  // Run the trusted worker's helper against candidate build artifacts.
  await run(config.nodeBin, [path.join(__dirname, "fork-update-smoke.js"), "--release", candidate.directory, "--omp", config.ompBin, "--agent-dir", agentDirectory(config)], { cwd: candidate.directory, timeout: 180000 });
  const git = gitRunner(config, run);
  if ((await git(candidate.directory, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim()) throw new Error("Verification modified candidate tracked files or produced untracked files");
}
async function publishCandidate(config, candidate, run) {
  const git = gitRunner(config, run);
  await assertSource(config, git, candidate.sourceHead);
  // Plain fast-forward-only push: no force flags, even when the remote races us.
  await git(candidate.directory, ["push", config.forkRemote, `${candidate.commit}:refs/heads/${config.branch}`]);
  await assertSource(config, git, candidate.sourceHead);
  await git(config.repoDir, ["merge", "--ff-only", candidate.commit]);
}
function agentDirectory(config) {
  const env = config.serverEnv;
  return env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), env.PI_CONFIG_DIR || ".omp", "agent");
}
function authenticationHeaders(config) {
  const hash = config.serverEnv.OMP_WEB_PASSWORD_HASH;
  if (!hash) return {};
  // Same documented cookie format as lib/web-auth{,-secret}.ts; never execute
  // candidate code with host authentication material to obtain a probe cookie.
  const secret = JSON.parse(fs.readFileSync(path.join(agentDirectory(config), "omp-web", "web-auth-secret.json"), "utf8"));
  if (typeof secret.key !== "string" || typeof secret.salt !== "string") throw new Error("Invalid web-auth signing secret");
  const key = createHmac("sha256", Buffer.from(secret.key, "base64url")).update(`omp-web-session-v1\0${secret.salt}\0${hash}`).digest("base64url");
  const payload = `v1.${Date.now() + 600000}.${randomBytes(16).toString("base64url")}`;
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return { Cookie: `omp_web_session=${payload}.${signature}` };
}
function systemdQuote(value) { return `"${String(value).replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
function drainingDirectory(config) { return path.join(config.stateDir, "draining"); }
async function choosePort(config, active) {
  const directory = drainingDirectory(config);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const draining = fs.readdirSync(directory).map((name) => {
    if (!state.SERVICE.test(name.replace(/\.json$/, ""))) throw new Error("Unexpected entry in draining state");
    const file = path.join(directory, name); state.trustedFile(file);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  });
  for (const port of config.ports) if (port !== active.port && !draining.some((entry) => entry.port === port) && await portFree(port)) return port;
  throw new Error("The other deployment slot is busy or draining sessions; wait for it to drain before updating");
}
async function probeRelease(config, port, version) {
  let last = "not ready";
  for (let index = 0; index < 90; index++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/app-update`, { headers: authenticationHeaders(config), signal: AbortSignal.timeout(4000), redirect: "error" });
      const body = await response.json();
      if (response.ok && body.currentVersion === version) return;
      last = `HTTP ${response.status}, version ${body.currentVersion}`;
    } catch (error) { last = error.message; }
    await sleep(1000);
  }
  throw new Error(`Candidate version probe failed: ${last}`);
}
async function installFile(run, source, target, mode) { await run("sudo", ["-n", "install", "-m", mode, "--", source, target]); }
function drainUnitName(service) { return `ompweb-fork-drain-${service.slice(0, -8)}.service`; }
async function deployCandidate(config, attemptId, candidate, active, run, attemptDir) {
  const port = await choosePort(config, active);
  const service = `ompweb-fork-${attemptId}.service`;
  const release = { service, port, releaseDir: candidate.directory, commit: candidate.commit, version: candidate.version };
  const environment = {
    ...config.serverEnv,
    PORT: String(port), OMP_WEB_HOSTNAME: "127.0.0.1", OMP_WEB_NO_OPEN: "1", OMP_WEB_OMP_BIN: config.ompBin,
    OMP_WEB_FORK_UPDATE_CONFIG: config.configPath, OMP_WEB_DISABLE_AUTOUPDATE: "1",
  };
  const envPath = path.join(attemptDir, "server.env");
  fs.writeFileSync(envPath, serializeServiceEnv(environment), { mode: 0o600, flag: "wx" });
  const unitFile = path.join(attemptDir, service);
  fs.writeFileSync(unitFile, `[Unit]\nDescription=OMP Web fork ${candidate.version}\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nUser=${config.user}\nWorkingDirectory=${systemdQuote(candidate.directory)}\nEnvironmentFile=${systemdQuote(envPath)}\nExecStart=:${systemdQuote(config.nodeBin)} ${systemdQuote(path.join(candidate.directory, "bin/omp-web.js"))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n\n[Install]\nWantedBy=multi-user.target\n`, { mode: 0o600, flag: "wx" });
  let drainScheduled = false, cutover = false, markerCreated = false;
  const marker = path.join(drainingDirectory(config), `${active.service}.json`);
  const proxyBackup = path.join(attemptDir, "nginx.original");
  let proxyChanged = false;
  try {
    await installFile(run, unitFile, `/etc/systemd/system/${service}`, "0644");
    await run("sudo", ["-n", "systemctl", "daemon-reload"]);
    await run("sudo", ["-n", "systemctl", "enable", "--now", service]);
    await probeRelease(config, port, candidate.version);
    const original = fs.readFileSync(config.proxyConfig, "utf8");
    const matches = [...original.matchAll(/\bproxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)\s*;/g)];
    if (matches.length !== 1 || Number(matches[0][1]) !== active.port) throw new Error("nginx proxy does not point uniquely at the recorded active release");
    fs.writeFileSync(proxyBackup, original, { mode: 0o600, flag: "wx" });
    const replacement = original.replace(/(\bproxy_pass\s+http:\/\/127\.0\.0\.1:)\d+(\s*;)/, (_match, prefix, suffix) => `${prefix}${port}${suffix}`);
    const proxyCandidate = path.join(attemptDir, "nginx.candidate");
    fs.writeFileSync(proxyCandidate, replacement, { mode: 0o600, flag: "wx" });
    if (fs.existsSync(marker)) throw new Error("The active release already has a pending drain; refusing to overwrite its state");
    state.atomicJson(marker, active);
    markerCreated = true;
    await run("sudo", ["-n", "systemd-run", `--unit=${drainUnitName(active.service)}`, `--uid=${config.user}`, "--collect", "--property=Restart=on-failure", "--property=RestartSec=5s", config.nodeBin, path.join(__dirname, "fork-update-worker.js"), "--config", config.configPath, "--drain", active.service]);
    drainScheduled = true;
    proxyChanged = true;
    await installFile(run, proxyCandidate, config.proxyConfig, "0644");
    await run("sudo", ["-n", "nginx", "-t"]);
    await run("sudo", ["-n", "systemctl", "reload", "nginx"]);
    state.writeActive(config, release);
    cutover = true;
    return release;
  } catch (error) {
    if (proxyChanged && !cutover) {
      try {
        await installFile(run, proxyBackup, config.proxyConfig, "0644");
        await run("sudo", ["-n", "nginx", "-t"]);
        await run("sudo", ["-n", "systemctl", "reload", "nginx"]);
        state.writeActive(config, active);
      } catch (rollback) {
        // Keep both services and their releases alive if traffic ownership is uncertain.
        error.keepCandidate = true;
        throw new Error(`${error.message}; nginx rollback failed, both services retained: ${rollback.message}`, { cause: error });
      }
    }
    if (drainScheduled) await run("sudo", ["-n", "systemctl", "stop", drainUnitName(active.service)], { allowFailure: true });
    if (markerCreated) fs.rmSync(marker, { force: true });
    await run("sudo", ["-n", "systemctl", "disable", "--now", service], { allowFailure: true });
    await run("sudo", ["-n", "rm", "-f", "--", `/etc/systemd/system/${service}`], { allowFailure: true });
    await run("sudo", ["-n", "systemctl", "daemon-reload"], { allowFailure: true });
    throw error;
  }
}
async function waitForIdleStream(config, release) {
  const controller = new AbortController();
  let idleTimer, watchdog;
  try {
    return await new Promise((resolve, reject) => {
      const fail = (error) => { clearTimeout(idleTimer); controller.abort(); reject(error); };
      watchdog = setTimeout(() => fail(new Error("Running-session stream stopped sending heartbeats")), 45000);
      const heartbeat = () => { clearTimeout(watchdog); watchdog = setTimeout(() => fail(new Error("Running-session stream stopped sending heartbeats")), 45000); };
      (async () => {
        const response = await fetch(`http://127.0.0.1:${release.port}/api/agent/running/events`, { headers: authenticationHeaders(config), signal: controller.signal, redirect: "error" });
        if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new Error(`Running-session stream returned HTTP ${response.status}`);
        const decoder = new TextDecoder(); let buffer = "";
        for await (const chunk of response.body) {
          heartbeat(); buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
          if (buffer.length > 1024 * 1024) throw new Error("Running-session stream frame is too large");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const value = JSON.parse(data);
            if (value.type !== "running") continue;
            if (!Array.isArray(value.runningSessionIds) || !value.runningSessionIds.every((id) => typeof id === "string")) throw new Error("Malformed running-session snapshot");
            if (value.runningSessionIds.length) { clearTimeout(idleTimer); idleTimer = undefined; }
            else if (!idleTimer) idleTimer = setTimeout(() => { resolve(); controller.abort(); }, 5000);
          }
        }
        throw new Error("Running-session stream disconnected before a safe drain");
      })().catch(fail);
    });
  } finally { clearTimeout(idleTimer); clearTimeout(watchdog); controller.abort(); }
}
async function drainRelease(config, service) {
  if (!state.SERVICE.test(service)) throw new Error("Invalid drain service");
  const marker = path.join(drainingDirectory(config), `${service}.json`);
  state.trustedFile(marker);
  const release = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (release.service !== service || !config.ports.includes(release.port) || typeof release.releaseDir !== "string" || !release.releaseDir.startsWith(`${config.releasesDir}/`)) throw new Error("Invalid draining release");
  // The unit is armed before cutover. It cannot touch the active service.
  while (state.readActive(config)?.service === service) await sleep(1000);
  await waitForIdleStream(config, release);
  if (state.readActive(config)?.service === service) throw new Error("Release became active again; refusing to stop it");
  const run = createRunner(config, path.join(config.stateDir, `drain-${service}.log`));
  await run("sudo", ["-n", "systemctl", "disable", "--now", service]);
  // Retain the old worktree for rollback; retirement only removes the unit.
  await run("sudo", ["-n", "rm", "-f", "--", `/etc/systemd/system/${service}`]);
  await run("sudo", ["-n", "systemctl", "daemon-reload"]);
  fs.rmSync(marker);
}
async function runUpdate(config, attemptId) {
  state.updateUnitName(attemptId);
  const initial = state.readStatus(config);
  if (!initial || initial.attemptId !== attemptId || initial.state !== "running") throw new Error("No matching API-owned update lease");
  const lock = path.join(config.stateDir, "update.lock");
  const lockStat = fs.lstatSync(lock);
  if (!lockStat.isDirectory() || lockStat.uid !== process.getuid() || (lockStat.mode & 0o077)) throw new Error("Unsafe or missing update lease");
  const attemptDir = path.join(config.stateDir, "attempts", attemptId);
  let status = { ...initial }, candidate, succeeded = false;
  const stage = (phase, patch = {}) => { status = { ...status, ...patch, stage: phase }; state.writeStatus(config, status); };
  try {
    state.atomicJson(path.join(lock, "owner.json"), { pid: process.pid, attemptId, acquiredAt: initial.startedAt });
    fs.mkdirSync(path.dirname(attemptDir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(attemptDir, { mode: 0o700 });
    const logFile = path.join(attemptDir, "update.log");
    fs.writeFileSync(logFile, "", { mode: 0o600, flag: "wx" });
    const run = createRunner(config, logFile);
    stage("starting", { logFile });
    const active = state.readActive(config);
    if (!active) throw new Error("No active deployment recorded; host setup is required");
    stage("starting", { fromVersion: active.version });
    candidate = await prepareCandidate(config, attemptId, active, run, stage);
    if (candidate.upToDate) {
      status = { ...status, state: "up_to_date", stage: "complete", commit: candidate.sourceHead, upstreamCommit: candidate.upstreamCommit, finishedAt: new Date().toISOString() };
      state.writeStatus(config, status); return status;
    }
    stage("installing", { targetVersion: candidate.version, commit: candidate.commit, upstreamCommit: candidate.upstreamCommit, releaseDir: candidate.directory });
    await verifyCandidate(config, candidate, run, stage);
    stage("publishing");
    await publishCandidate(config, candidate, run);
    stage("deploying");
    await deployCandidate(config, attemptId, candidate, active, run, attemptDir);
    succeeded = true;
    status = { ...status, state: "succeeded", stage: "complete", finishedAt: new Date().toISOString() };
    state.writeStatus(config, status);
    return status;
  } catch (error) {
    const keepCandidate = error.keepCandidate || error.cause?.keepCandidate;
    if (candidate?.directory && !succeeded && !keepCandidate) {
      try { await gitRunner(config, createRunner(config, status.logFile))(config.repoDir, ["worktree", "remove", "--force", candidate.directory]); }
      catch (cleanup) { error.message += `; own worktree cleanup failed: ${cleanup.message}`; }
    }
    status = { ...status, state: "failed", error: error.message.slice(-8000), finishedAt: new Date().toISOString() };
    state.writeStatus(config, status);
    return status;
  } finally { state.releaseLock(config, attemptId); }
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!["--config", "--attempt", "--drain"].includes(flag) || !argv[index + 1] || result[flag]) throw new Error("Expected --config PATH and exactly one --attempt UUID or --drain SERVICE");
    result[flag] = argv[index + 1];
  }
  if (!result["--config"] || Boolean(result["--attempt"]) === Boolean(result["--drain"])) throw new Error("Expected one worker mode");
  return result;
}
if (require.main === module) {
  (async () => {
    process.umask(0o077);
    const args = parseArgs(process.argv.slice(2));
    const config = state.loadConfig(args["--config"]);
    if (args["--drain"]) await drainRelease(config, args["--drain"]);
    else if ((await runUpdate(config, args["--attempt"])).state === "failed") process.exitCode = 1;
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { commandEnvironment, createRunner, assertSource, prepareCandidate, verifyCandidate, publishCandidate, forkVersion, choosePort, waitForIdleStream, runUpdate, parseArgs };
