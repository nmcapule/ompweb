import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { acquireLock, loadConfig, readStatus, releaseLock, writeActive, writeStatus } from "../bin/fork-update-state.js";

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const route = await jiti.import("../app/api/fork-update/route.ts");

async function withConfiguration(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-fork-update-api-"));
  const source = join(root, "source");
  mkdirSync(source);
  execFileSync("git", ["init", "-q", source]);
  const previous = process.env.OMP_WEB_FORK_UPDATE_CONFIG;
  const file = join(root, "config.json");
  writeFileSync(file, JSON.stringify({
    repoDir: source,
    branch: "fix/fresh-session-lifecycle",
    upstreamRemote: "upstream",
    upstreamBranch: "main",
    forkRemote: "origin",
    releasesDir: join(root, "releases"),
    stateDir: join(root, "state"),
    proxyConfig: join(root, "nginx.conf"),
    nodeBin: process.execPath,
    ompBin: process.execPath,
    user: userInfo().username,
    ports: [30178, 30179],
    serverEnv: {},
  }), { mode: 0o600 });
  writeFileSync(join(root, "nginx.conf"), "proxy_pass http://127.0.0.1:30178;\n");
  process.env.OMP_WEB_FORK_UPDATE_CONFIG = file;
  const config = loadConfig(file);
  writeActive(config, { service: "ompweb-fork-fixture.service", port: 30178, releaseDir: join(root, "releases", "active"), commit: "1".repeat(40), version: "0.5.2-habi.1" });
  try {
    await run(config);
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_FORK_UPDATE_CONFIG;
    else process.env.OMP_WEB_FORK_UPDATE_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function request(body, headers = {}) {
  return new Request("http://localhost/api/fork-update", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const linux = { skip: process.platform !== "linux" };

test("a running persisted update is resumed on GET and duplicate start keeps the same lease", linux, async () => {
  await withConfiguration(async (config) => {
    const attemptId = randomUUID();
    const status = { attemptId, state: "running", stage: "starting", startedAt: new Date().toISOString(), fromVersion: "0.5.2-habi.1" };
    assert.equal(acquireLock(config), true);
    writeStatus(config, status);
    const fetched = await route.GET();
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("Cache-Control"), "no-store");
    assert.deepEqual((await fetched.json()).status, status);
    const duplicate = await route.POST(request({ action: "update" }));
    assert.equal(duplicate.status, 409);
    const body = await duplicate.json();
    assert.equal(body.code, "fork_update_in_progress");
    assert.equal(body.status.attemptId, attemptId);
    assert.deepEqual(readStatus(config), status);
    assert.equal(existsSync(join(config.stateDir, "update.lock")), true);
    releaseLock(config);
  });
});

test("cross-site callers cannot trigger an updater even with a valid installation", linux, async () => {
  await withConfiguration(async (config) => {
    for (const headers of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
      const response = await route.POST(request({ action: "update" }, headers));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "cross_origin_forbidden");
    }
    assert.equal(readStatus(config), null);
    assert.equal(existsSync(join(config.stateDir, "update.lock")), false);
  });
});

test("update API refuses browser-supplied commands, unsupported actions and malformed requests", async () => {
  for (const body of [{ action: "update", command: "anything" }, { action: "deploy", version: "evil" }, null, [], "{"]) {
    const response = await route.POST(request(body));
    assert.equal(response.status, 400);
  }
  assert.equal((await route.POST(request({ action: "update" }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await route.POST(request(JSON.stringify({ action: "update", padding: "x".repeat(4_096) })))).status, 413);
});

test("an unconfigured installation cannot start an update", async () => {
  const previous = process.env.OMP_WEB_FORK_UPDATE_CONFIG;
  delete process.env.OMP_WEB_FORK_UPDATE_CONFIG;
  try {
    assert.deepEqual(await (await route.GET()).json(), { supported: false, current: null, status: null });
    const response = await route.POST(request({ action: "update" }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "fork_update_unavailable");
  } finally {
    if (previous !== undefined) process.env.OMP_WEB_FORK_UPDATE_CONFIG = previous;
  }
});
