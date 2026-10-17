"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,180}\.service$/;
const STAGES = new Set(["starting", "fetching", "merging", "installing", "typechecking", "testing", "building", "smoke", "publishing", "deploying", "complete"]);
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value) || path.normalize(value) !== value || value === "/") throw new Error(`${label} must be a normalized absolute path`);
  return value;
}
function trustedFile(file, ownerOnly = true) {
  const stat = fs.lstatSync(file);
  const uid = process.getuid();
  if (!stat.isFile() || (stat.uid !== uid && stat.uid !== 0) || (stat.mode & (ownerOnly ? 0o077 : 0o022))) throw new Error(`Unsafe ownership or permissions: ${file}`);
  return stat;
}
function ensureState(config) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(config.stateDir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Updater state directory must be owned by this user with mode 0700");
}
function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
function readJson(config, name) {
  ensureState(config);
  const file = path.join(config.stateDir, name);
  try {
    trustedFile(file);
    if (fs.statSync(file).size > 65536) throw new Error(`Updater state is too large: ${name}`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function loadConfig(configPath) {
  safePath(configPath, "Config path");
  const stat = trustedFile(configPath);
  if (stat.size > 65536) throw new Error("Updater config is too large");
  const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!record(value)) throw new Error("Updater config must be an object");
  const config = { ...value, configPath };
  for (const field of ["repoDir", "releasesDir", "stateDir", "proxyConfig", "nodeBin", "ompBin"]) safePath(config[field], field);
  for (const field of ["branch", "upstreamBranch"]) {
    if (typeof config[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(config[field]) || config[field].includes("..") || config[field].endsWith("/") || config[field].endsWith(".lock")) throw new Error(`Invalid ${field}`);
  }
  for (const field of ["upstreamRemote", "forkRemote"]) if (typeof config[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(config[field])) throw new Error(`Invalid ${field}`);
  if (typeof config.user !== "string" || !/^[a-z_][a-z0-9_-]*[$]?$/.test(config.user)) throw new Error("Invalid service user");
  if (!Array.isArray(config.ports) || config.ports.length !== 2 || new Set(config.ports).size !== 2 || !config.ports.every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535)) throw new Error("Configure two distinct unprivileged loopback ports");
  if (!record(config.serverEnv)) throw new Error("serverEnv must be an object");
  for (const [key, value] of Object.entries(config.serverEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || /[\0\r\n]/.test(value)) throw new Error("Invalid server environment entry");
  }
  const roots = [config.repoDir, config.releasesDir, config.stateDir];
  if (new Set(roots).size !== roots.length || config.repoDir.startsWith(`${config.stateDir}/`) || config.releasesDir.startsWith(`${config.stateDir}/`) || config.stateDir.startsWith(`${config.repoDir}/`)) throw new Error("Source, releases, and private state must be separate directories");
  ensureState(config);
  return config;
}
function validateRelease(config, value) {
  if (!record(value) || !SERVICE.test(value.service) || !config.ports.includes(value.port) || typeof value.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(value.commit) || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) throw new Error("Invalid active release state");
  safePath(value.releaseDir, "Release directory");
  if (!value.releaseDir.startsWith(`${config.releasesDir}/`)) throw new Error("Active release is outside releasesDir");
  return value;
}
function validateStatus(value) {
  if (!record(value) || !UUID.test(value.attemptId) || !["running", "succeeded", "failed", "up_to_date"].includes(value.state) || !STAGES.has(value.stage) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) throw new Error("Invalid updater status");
  if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 8192)) throw new Error("Invalid updater error");
  return value;
}
function readStatus(config) { const value = readJson(config, "status.json"); return value === null ? null : validateStatus(value); }
function readActive(config) { const value = readJson(config, "active.json"); return value === null ? null : validateRelease(config, value); }
function writeStatus(config, value) { ensureState(config); atomicJson(path.join(config.stateDir, "status.json"), validateStatus(value)); }
function writeActive(config, value) { ensureState(config); atomicJson(path.join(config.stateDir, "active.json"), validateRelease(config, value)); }
function acquireLock(config) {
  ensureState(config);
  const directory = path.join(config.stateDir, "update.lock");
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code === "EEXIST") return false; throw error; }
  try { atomicJson(path.join(directory, "owner.json"), { pid: process.pid, acquiredAt: new Date().toISOString() }); }
  catch (error) { fs.rmSync(path.join(directory, "owner.json"), { force: true }); fs.rmdirSync(directory); throw error; }
  return true;
}
function releaseLock(config, attemptId) {
  const directory = path.join(config.stateDir, "update.lock");
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Unsafe updater lock directory");
    if (attemptId !== undefined) {
      if (!UUID.test(attemptId)) throw new Error("Invalid lease attempt ID");
      const latest = readStatus(config);
      const ownerFile = path.join(directory, "owner.json");
      trustedFile(ownerFile);
      const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      if (latest?.attemptId !== attemptId || (owner.attemptId !== undefined && owner.attemptId !== attemptId)) throw new Error("Updater lease belongs to a different attempt");
    }
    fs.rmSync(path.join(directory, "owner.json"), { force: true });
    fs.rmdirSync(directory);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
function updateUnitName(attemptId) {
  if (!UUID.test(attemptId)) throw new Error("Invalid update attempt ID");
  return `ompweb-fork-update-${attemptId}.service`;
}
module.exports = { loadConfig, readStatus, writeStatus, readActive, writeActive, acquireLock, releaseLock, updateUnitName, atomicJson, ensureState, trustedFile, SERVICE, UUID };
