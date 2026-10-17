import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import state from "./fork-update-state.js";

function fixture(t, patch = {}) {
  const root = mkdtempSync(join(tmpdir(), "fork-state-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "config.json");
  const config = { repoDir: join(root, "repo"), branch: "fix/fresh-session-lifecycle", upstreamRemote: "upstream", upstreamBranch: "main", forkRemote: "origin", releasesDir: join(root, "releases"), stateDir: join(root, "state"), proxyConfig: join(root, "nginx.conf"), nodeBin: process.execPath, ompBin: "/usr/local/bin/omp", user: "exedev", ports: [30178, 30179], serverEnv: { CUSTOM: "preserved", OMP_WEB_PASSWORD_HASH: "host-owned-secret" }, ...patch };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { root, file, config };
}
function status(attemptId = randomUUID()) { return { attemptId, state: "running", stage: "starting", startedAt: new Date().toISOString() }; }

test("config loads the trusted host-owned file and creates owner-only persistent state", (t) => {
  const f = fixture(t); const config = state.loadConfig(f.file);
  assert.equal(config.configPath, f.file);
  assert.deepEqual(config.serverEnv, f.config.serverEnv);
  assert.equal(statSync(config.stateDir).mode & 0o777, 0o700);
  assert.equal(state.readStatus(config), null); assert.equal(state.readActive(config), null);
});

for (const mode of [0o644, 0o620, 0o666]) test(`config rejects nonprivate mode ${mode.toString(8)}`, (t) => {
  const f = fixture(t); chmodSync(f.file, mode);
  assert.throws(() => state.loadConfig(f.file), /ownership or permissions/);
});

test("symlinked config and symlinked state directory are refused", (t) => {
  const f = fixture(t);
  const linked = join(f.root, "config-link.json"); symlinkSync(f.file, linked);
  assert.throws(() => state.loadConfig(linked), /ownership or permissions/);
  const elsewhere = join(f.root, "elsewhere"); mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, f.config.stateDir);
  assert.throws(() => state.loadConfig(f.file), /state directory/);
});

for (const patch of [
  { branch: "-malicious" }, { branch: "main..other" }, { upstreamRemote: "--upload-pack=evil" },
  { repoDir: "/tmp/source\nExecStart=evil" }, { nodeBin: "node" }, { ports: [30179, 30179] },
  { ports: [80, 30179] }, { user: "root\nExecStart=evil" }, { serverEnv: { "BAD=KEY": "x" } },
  { serverEnv: { VALUE: "one\nTWO=two" } }, { serverEnv: { VALUE: 123 } },
]) test(`config rejects unsafe boundary ${JSON.stringify(patch)}`, (t) => {
  const f = fixture(t, patch); assert.throws(() => state.loadConfig(f.file));
});

test("status and active state are atomically replaced and remain private", (t) => {
  const f = fixture(t); const config = state.loadConfig(f.file); const initial = status();
  state.writeStatus(config, initial);
  assert.deepEqual(state.readStatus(config), initial);
  const terminal = { ...initial, state: "failed", stage: "testing", error: "real verification failed", finishedAt: new Date().toISOString() };
  state.writeStatus(config, terminal);
  assert.deepEqual(state.readStatus(config), terminal);
  const release = { service: "ompweb-fork-active.service", port: 30179, releaseDir: join(config.releasesDir, "1.0.0-habi.1"), commit: "a".repeat(40), version: "1.0.0-habi.1" };
  state.writeActive(config, release); assert.deepEqual(state.readActive(config), release);
  for (const file of ["status.json", "active.json"]) assert.equal(statSync(join(config.stateDir, file)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(config.stateDir, "status.json"), "utf8").includes("host-owned-secret"), false);
});

test("exclusive lease coalesces clicks, cannot be stolen, and releases after terminal state", (t) => {
  const f = fixture(t); const config = state.loadConfig(f.file);
  assert.equal(state.acquireLock(config), true);
  assert.equal(state.acquireLock(config), false);
  assert.equal(statSync(join(config.stateDir, "update.lock")).mode & 0o777, 0o700);
  const owner = JSON.parse(readFileSync(join(config.stateDir, "update.lock/owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid); assert.ok(Number.isFinite(Date.parse(owner.acquiredAt)));
  const running = status(); state.writeStatus(config, running);
  assert.throws(() => state.releaseLock(config, randomUUID()), /different attempt/);
  assert.equal(state.acquireLock(config), false);
  state.writeStatus(config, { ...running, state: "succeeded", stage: "complete" });
  state.releaseLock(config, running.attemptId);
  assert.equal(state.acquireLock(config), true); state.releaseLock(config);
});

test("lease metadata protects another worker's identity even if status was replaced", (t) => {
  const f = fixture(t); const config = state.loadConfig(f.file);
  state.acquireLock(config); const current = status(); state.writeStatus(config, current);
  writeFileSync(join(config.stateDir, "update.lock/owner.json"), JSON.stringify({ pid: process.pid, attemptId: randomUUID() }), { mode: 0o600 });
  assert.throws(() => state.releaseLock(config, current.attemptId), /different attempt/);
  assert.equal(existsSync(join(config.stateDir, "update.lock")), true);
});

test("malformed and nonprivate persistent state fails closed instead of becoming idle", (t) => {
  const f = fixture(t); const config = state.loadConfig(f.file);
  writeFileSync(join(config.stateDir, "status.json"), '{"state":"running"}', { mode: 0o600 });
  assert.throws(() => state.readStatus(config), /Invalid updater status/);
  state.writeStatus(config, status()); chmodSync(join(config.stateDir, "status.json"), 0o644);
  assert.throws(() => state.readStatus(config), /ownership or permissions/);
  assert.throws(() => state.writeActive(config, { service: "bad.service", port: 30179, releaseDir: "/tmp/foreign", commit: "a".repeat(40), version: "1.0.0-habi.1" }), /outside releasesDir/);
});

test("unit names cannot accept browser-controlled command fragments", () => {
  const id = randomUUID(); assert.equal(state.updateUnitName(id), `ompweb-fork-update-${id}.service`);
  for (const value of ["../unit", "--help", "x; reboot", "not-a-uuid", ""]) assert.throws(() => state.updateUnitName(value), /Invalid update attempt/);
});
