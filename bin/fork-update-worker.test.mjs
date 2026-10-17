import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import worker from "./fork-update-worker.js";
import state from "./fork-update-state.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
function commit(directory, message) {
  git(directory, "add", "--all");
  git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", message);
}
function packageFiles(directory, version, extra = {}) {
  const pkg = { name: "fork-fixture", version, scripts: { typecheck: "node checks.cjs typecheck", test: "node checks.cjs test", build: "node checks.cjs build" }, ...extra };
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(directory, "package-lock.json"), `${JSON.stringify({ name: pkg.name, version, lockfileVersion: 3, requires: true, packages: { "": { name: pkg.name, version } } }, null, 2)}\n`);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "fork-update-test-"));
  const seed = join(root, "seed"), upstream = join(root, "upstream.git"), origin = join(root, "origin.git"), repo = join(root, "source");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  packageFiles(seed, "1.0.0");
  writeFileSync(join(seed, ".gitignore"), "node_modules/\n.next/\n");
  writeFileSync(join(seed, "session.json"), JSON.stringify({ resumeMissingSession: false }));
  writeFileSync(join(seed, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0\n\n- Initial release.\n");
  writeFileSync(join(seed, "checks.cjs"), 'const assert = require("node:assert/strict"); const fs = require("node:fs"); assert.equal(JSON.parse(fs.readFileSync("session.json", "utf8")).resumeMissingSession, true); if (process.argv[2] === "test") throw new Error("fixture regression fails verification");\n');
  commit(seed, "upstream base");
  git(root, "clone", "--bare", seed, upstream);
  git(root, "clone", "--bare", seed, origin);
  git(root, "clone", origin, repo);
  git(repo, "remote", "add", "upstream", upstream);
  packageFiles(repo, "1.0.0-habi.1");
  writeFileSync(join(repo, "session.json"), JSON.stringify({ resumeMissingSession: true }));
  commit(repo, "retain fork session lifecycle fix");
  git(repo, "push", "origin", "main");
  const head = git(repo, "rev-parse", "HEAD");
  const releasesDir = join(root, "releases"); mkdirSync(releasesDir);
  const live = join(releasesDir, "live"); mkdirSync(live);
  writeFileSync(join(live, "sentinel"), "live build must remain unchanged");
  const configPath = join(root, "config.json");
  const plain = { repoDir: repo, branch: "main", upstreamRemote: "upstream", upstreamBranch: "main", forkRemote: "origin", releasesDir, stateDir: join(root, "state"), proxyConfig: join(root, "nginx.conf"), nodeBin: process.execPath, ompBin: process.execPath, user: process.env.USER || "exedev", ports: [30178, 30179], serverEnv: {} };
  writeFileSync(configPath, JSON.stringify(plain), { mode: 0o600 });
  writeFileSync(plain.proxyConfig, "proxy_pass http://127.0.0.1:30179;\n");
  const config = state.loadConfig(configPath);
  const active = { service: "fixture-live.service", port: 30179, releaseDir: live, commit: head, version: "1.0.0-habi.1" };
  state.writeActive(config, active);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const updateUpstream = (change) => {
    const directory = join(root, `upstream-edit-${randomUUID()}`);
    git(root, "clone", upstream, directory);
    change(directory);
    commit(directory, "upstream update");
    git(directory, "push", "origin", "main");
    return git(directory, "rev-parse", "HEAD");
  };
  return { root, config, active, repo, origin, head, live, updateUpstream, run: worker.createRunner(config) };
}

test("real worktree merge retains fork session fix and resolves only version-local package conflicts", async (t) => {
  const f = fixture(t);
  const upstreamCommit = f.updateUpstream((directory) => {
    packageFiles(directory, "1.1.0", { description: "new upstream package metadata" });
    writeFileSync(join(directory, "new-upstream.js"), "export const newUpstream = true;\n");
  });
  const candidate = await worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {});
  assert.equal(candidate.version, "1.1.0-habi.1");
  assert.equal(candidate.upstreamCommit, upstreamCommit);
  assert.equal(JSON.parse(readFileSync(join(candidate.directory, "session.json"))).resumeMissingSession, true);
  assert.equal(JSON.parse(readFileSync(join(candidate.directory, "package.json"))).description, "new upstream package metadata");
  const lock = JSON.parse(readFileSync(join(candidate.directory, "package-lock.json")));
  assert.equal(lock.version, candidate.version); assert.equal(lock.packages[""].version, candidate.version);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.head, "preparation cannot change source HEAD");
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  assert.equal(git(candidate.directory, "merge-base", "--is-ancestor", f.head, "HEAD"), "");
});

test("same upstream base increments fork revision", async (t) => {
  const f = fixture(t);
  f.updateUpstream((directory) => writeFileSync(join(directory, "upstream-fix.js"), "export const fixed = true;\n"));
  const candidate = await worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {});
  assert.equal(candidate.version, "1.0.0-habi.2");
});

test("independent fork and upstream release notes survive a real upstream version merge", async (t) => {
  const f = fixture(t);
  const file = join(f.repo, "CHANGELOG.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("## 1.0.0", "## Fork notes\n\n- Retain the session fix.\n\n## 1.0.0"));
  commit(f.repo, "fork release notes");
  const sourceHead = git(f.repo, "rev-parse", "HEAD");
  f.updateUpstream((directory) => {
    packageFiles(directory, "1.1.0");
    const upstreamFile = join(directory, "CHANGELOG.md");
    writeFileSync(upstreamFile, readFileSync(upstreamFile, "utf8").replace("## 1.0.0", "## 1.1.0\n\n- New upstream feature.\n\n## 1.0.0"));
  });
  const candidate = await worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {});
  const notes = readFileSync(join(candidate.directory, "CHANGELOG.md"), "utf8");
  assert.equal(notes.includes("- Retain the session fix."), true);
  assert.equal(notes.includes("- New upstream feature."), true);
  assert.equal(notes.includes("- Initial release."), true);
  assert.equal(notes.includes("<<<<<<<"), false);
  assert.equal(candidate.version, "1.1.0-habi.1");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), sourceHead);
});

test("competing edits to existing release notes cannot be silently combined", async (t) => {
  const f = fixture(t);
  const file = join(f.repo, "CHANGELOG.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("- Initial release.", "- Fork correction to the existing release."));
  commit(f.repo, "fork correction");
  const sourceHead = git(f.repo, "rev-parse", "HEAD");
  f.updateUpstream((directory) => {
    const upstreamFile = join(directory, "CHANGELOG.md");
    writeFileSync(upstreamFile, readFileSync(upstreamFile, "utf8").replace("- Initial release.", "- Upstream correction to the existing release."));
  });
  await assert.rejects(worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {}));
  assert.equal(git(f.repo, "rev-parse", "HEAD"), sourceHead);
  assert.equal(readFileSync(file, "utf8").includes("- Fork correction to the existing release."), true);
  assert.deepEqual(state.readActive(f.config), f.active);
});

test("ambiguous source conflicts fail and remove only the candidate worktree", async (t) => {
  const f = fixture(t);
  f.updateUpstream((directory) => writeFileSync(join(directory, "session.json"), JSON.stringify({ resumeMissingSession: "incompatible" })));
  const id = randomUUID();
  await assert.rejects(worker.prepareCandidate(f.config, id, f.active, f.run, () => {}));
  assert.equal(existsSync(join(f.config.releasesDir, `fork-${id}`)), false);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.head);
  assert.deepEqual(state.readActive(f.config), f.active);
  assert.equal(readFileSync(join(f.live, "sentinel"), "utf8"), "live build must remain unchanged");
});

test("non-version fork package edits cannot be discarded by conflict resolution", async (t) => {
  const f = fixture(t);
  packageFiles(f.repo, "1.0.0-habi.1", { description: "fork-specific policy" });
  commit(f.repo, "fork package customization"); git(f.repo, "push", "origin", "main");
  f.updateUpstream((directory) => packageFiles(directory, "1.1.0", { description: "upstream policy" }));
  await assert.rejects(worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {}));
  assert.equal(JSON.parse(readFileSync(join(f.repo, "package.json"))).description, "fork-specific policy");
});

for (const tracked of [false, true]) test(`dirty ${tracked ? "tracked" : "untracked"} source is never stashed or overwritten`, async (t) => {
  const f = fixture(t);
  const file = join(f.repo, tracked ? "session.json" : "user-draft.txt");
  writeFileSync(file, "user-owned unsaved work\n");
  await assert.rejects(worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {}));
  assert.equal(readFileSync(file, "utf8"), "user-owned unsaved work\n");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.head);
});

test("up-to-date requires source HEAD to be the deployed commit", async (t) => {
  const f = fixture(t);
  const noop = await worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {});
  assert.equal(noop.upToDate, true);
  writeFileSync(join(f.repo, "feature.js"), "export const updaterFeature = true;\n"); commit(f.repo, "new fork feature");
  const candidate = await worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {});
  assert.notEqual(candidate.upToDate, true);
  assert.equal(candidate.commit, git(f.repo, "rev-parse", "HEAD"));
  assert.equal(candidate.version, "1.0.0-habi.1");
});

test("fork remote fast-forward is staged in candidate without mutating source", async (t) => {
  const f = fixture(t);
  const other = join(f.root, "other-fork"); git(f.root, "clone", f.origin, other);
  writeFileSync(join(other, "fork-addition.js"), "export const addition = true;\n"); commit(other, "remote fork work"); git(other, "push", "origin", "main");
  const candidate = await worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {});
  assert.equal(candidate.commit, git(other, "rev-parse", "HEAD"));
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.head);
});

test("real npm verification failure cannot publish, touch live files, or change proxy/active state", async (t) => {
  const f = fixture(t);
  f.updateUpstream((directory) => writeFileSync(join(directory, "upstream-fix.js"), "export const fix = true;\n"));
  const id = randomUUID();
  assert.equal(state.acquireLock(f.config), true);
  state.writeStatus(f.config, { attemptId: id, state: "running", stage: "starting", startedAt: new Date().toISOString() });
  const status = await worker.runUpdate(f.config, id);
  assert.equal(status.state, "failed"); assert.equal(status.stage, "testing");
  assert.match(status.error, /fixture regression fails verification/);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.head);
  assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.head);
  assert.deepEqual(state.readActive(f.config), f.active);
  assert.equal(readFileSync(f.config.proxyConfig, "utf8"), "proxy_pass http://127.0.0.1:30179;\n");
  assert.equal(readFileSync(join(f.live, "sentinel"), "utf8"), "live build must remain unchanged");
  assert.equal(existsSync(join(f.config.releasesDir, `fork-${id}`)), false);
  assert.equal(state.acquireLock(f.config), true); state.releaseLock(f.config);
});

test("changed source refuses publication before contacting fork remote", async (t) => {
  const f = fixture(t);
  f.updateUpstream((directory) => writeFileSync(join(directory, "new-upstream.js"), "export const change = true;\n"));
  const candidate = await worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {});
  writeFileSync(join(f.repo, "later.js"), "export const userChange = true;\n"); commit(f.repo, "concurrent user commit");
  await assert.rejects(worker.publishCandidate(f.config, candidate, f.run));
  assert.equal(git(f.origin, "rev-parse", "refs/heads/main"), f.head);
});

test("non-fast-forward push failure never advances source checkout", async (t) => {
  const f = fixture(t);
  f.updateUpstream((directory) => writeFileSync(join(directory, "new-upstream.js"), "export const change = true;\n"));
  const candidate = await worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {});
  const other = join(f.root, "racing-fork"); git(f.root, "clone", f.origin, other);
  writeFileSync(join(other, "race.js"), "export const remoteChange = true;\n"); commit(other, "race remote"); git(other, "push", "origin", "main");
  await assert.rejects(worker.publishCandidate(f.config, candidate, f.run));
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.head);
  assert.deepEqual(state.readActive(f.config), f.active);
});

test("repository subprocess environment excludes web secrets and Next runtime settings", () => {
  const result = worker.commandEnvironment({ nodeBin: "/node/bin/node", ompBin: "/agent/omp" }, {
    PATH: "/usr/bin", HOME: "/home/test", OMP_WEB_PASSWORD_HASH: "private", OMP_WEB_TRUSTED_HEADER_SHA256: "private", OMP_WEB_PASSWORD: "private", OMP_WEB_TRUSTED_HEADER_SECRET: "private", PORT: "1234", NODE_ENV: "production", NEXT_RUNTIME: "nodejs", NODE_OPTIONS: "--require evil", USER_VALUE: "keep",
  });
  for (const key of ["OMP_WEB_PASSWORD_HASH", "OMP_WEB_TRUSTED_HEADER_SHA256", "OMP_WEB_PASSWORD", "OMP_WEB_TRUSTED_HEADER_SECRET", "PORT", "NODE_ENV", "NEXT_RUNTIME", "NODE_OPTIONS"]) assert.equal(key in result, false);
  assert.equal(result.USER_VALUE, "keep"); assert.equal(result.HOME, "/home/test");
});

test("drain timer resets on a busy SSE event and requires five continuously idle seconds", async (t) => {
  const clients = new Set(); let idleSentAt;
  const server = createServer((_request, response) => {
    clients.add(response); response.on("close", () => clients.delete(response));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"type":"running","runningSessionIds":[]}\n\n');
    const busy = setTimeout(() => response.write('data: {"type":"running","runningSessionIds":["chat"]}\n\n'), 50);
    const idle = setTimeout(() => { idleSentAt = Date.now(); response.write('data: {"type":"running","runningSessionIds":[]}\n\n'); }, 100);
    response.on("close", () => { clearTimeout(busy); clearTimeout(idle); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const client of clients) client.destroy(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  await worker.waitForIdleStream({ serverEnv: {} }, { port: address.port });
  assert.ok(Date.now() - idleSentAt >= 4950);
});

test("no-update worker persists explicit terminal result and releases its lease", async (t) => {
  const f = fixture(t); const id = randomUUID();
  state.acquireLock(f.config);
  state.writeStatus(f.config, { attemptId: id, state: "running", stage: "starting", startedAt: new Date().toISOString() });
  const result = await worker.runUpdate(f.config, id);
  assert.equal(result.state, "up_to_date"); assert.equal(result.stage, "complete");
  assert.deepEqual(state.readStatus(f.config), result);
  assert.deepEqual(state.readActive(f.config), f.active);
  assert.equal(existsSync(join(f.config.stateDir, "update.lock")), false);
});

test("a diverged fork remote cannot be merged automatically", async (t) => {
  const f = fixture(t); const other = join(f.root, "diverged-fork");
  git(f.root, "clone", f.origin, other);
  writeFileSync(join(other, "remote.js"), "export const remote = true;\n"); commit(other, "remote divergence"); git(other, "push", "origin", "main");
  writeFileSync(join(f.repo, "local.js"), "export const local = true;\n"); commit(f.repo, "local divergence");
  const head = git(f.repo, "rev-parse", "HEAD");
  await assert.rejects(worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {}));
  assert.equal(git(f.repo, "rev-parse", "HEAD"), head);
});

test("wrong checked-out branch is protected before fetching", async (t) => {
  const f = fixture(t); git(f.repo, "switch", "-c", "user-work");
  await assert.rejects(worker.prepareCandidate(f.config, randomUUID(), f.active, f.run, () => {}));
  assert.equal(git(f.repo, "symbolic-ref", "--short", "HEAD"), "user-work");
});

test("an existing slot directory remains reusable, but a free draining slot is withheld until retirement", async (t) => {
  const f = fixture(t);
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  f.config.ports = [port, f.active.port];
  const directory = join(f.config.stateDir, "draining");
  mkdirSync(directory, { mode: 0o700 });
  assert.equal(await worker.choosePort(f.config, f.active), port);
  const marker = join(directory, "old.service.json");
  writeFileSync(marker, JSON.stringify({ ...f.active, service: "old.service", port }), { mode: 0o600 });
  await assert.rejects(worker.choosePort(f.config, f.active));
  assert.deepEqual(state.readActive(f.config), f.active);
  rmSync(marker);
  assert.equal(await worker.choosePort(f.config, f.active), port);
});
