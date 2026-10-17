#!/usr/bin/env node
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

async function smoke({ release, omp, agentDir }) {
  for (const [name, value] of Object.entries({ release, omp, agentDir })) if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ompweb-fork-smoke-"));
  fs.chmodSync(temporary, 0o700);
  const agent = path.join(temporary, "agent");
  const project = path.join(temporary, "project");
  fs.mkdirSync(agent, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 });
  let cleaning;
  const cleanup = () => {
    if (!cleaning) cleaning = (async () => {
      const wrappers = new Set(globalThis.__ompSessions?.values() || []);
      await Promise.all([...wrappers].map((wrapper) => wrapper.destroyAndWait()));
      fs.rmSync(temporary, { recursive: true, force: true });
    })();
    return cleaning;
  };
  const interrupted = () => { cleanup().finally(() => process.exit(1)); };
  process.once("SIGTERM", interrupted); process.once("SIGINT", interrupted);
  try {
    // No sessions, auth databases, extensions, instructions or project settings
    // are copied. The real catalog/config supplies a valid startup model, but
    // every command below is local control RPC and performs no inference.
    for (const name of ["models.yml", "config.yml"]) {
      const source = path.join(agentDir, name);
      if (!fs.existsSync(source)) continue;
      if (!fs.statSync(source).isFile()) throw new Error(`Not a regular agent configuration: ${name}`);
      fs.copyFileSync(source, path.join(agent, name), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(agent, name), 0o600);
    }
    fs.writeFileSync(path.join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, addedAt: new Date().toISOString(), launchConfig: { advisor: true } }] }), { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.HOME = temporary;
    process.env.XDG_CONFIG_HOME = path.join(temporary, "config");
    process.env.XDG_DATA_HOME = path.join(temporary, "data");
    process.env.XDG_CACHE_HOME = path.join(temporary, "cache");
    process.env.OMP_WEB_OMP_BIN = omp;
    process.env.OMP_WEB_DISABLE_AUTOUPDATE = "1";
    delete process.env.OMP_PROFILE; delete process.env.PI_PROFILE; delete process.env.PI_CONFIG_DIR;
    for (const key of Object.keys(process.env)) if (/^(?:NEXT_|OMP_WEB_(?:PASSWORD|TRUSTED_HEADER))/.test(key) || ["PORT", "NODE_ENV", "NODE_OPTIONS"].includes(key)) delete process.env[key];
    const route = (relative) => {
      const built = require(path.join(release, ".next/server/app", relative, "route.js"));
      if (!built.routeModule?.userland) throw new Error(`Missing built route userland: ${relative}`);
      return built.routeModule.userland;
    };
    const create = route("api/agent/new");
    const commands = route("api/agent/[id]");
    const context = route("api/sessions/[id]/context");
    const created = await create.POST(new Request("http://localhost/api/agent/new", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: project, type: "ensure_session" }),
    }));
    const createdBody = await created.json();
    assert.equal(created.status, 200, JSON.stringify(createdBody));
    assert.equal(createdBody.success, true);
    const id = createdBody.sessionId;
    assert.equal(typeof id, "string");
    const live = globalThis.__ompSessions?.get(id);
    assert.ok(live?.isAlive(), "real omp wrapper is registered under its live ID");
    assert.equal(live.advisorSpawned, true, "fixture workspace forces advisor mode");
    assert.equal(fs.existsSync(live.sessionFile), false, "fresh session has no persisted transcript");
    const params = { params: Promise.resolve({ id }) };
    // No ?advisor=1: this catches the fork's fresh-session replacement bug.
    const posted = await commands.POST(new Request(`http://localhost/api/agent/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "get_state" }),
    }), params);
    const postedBody = await posted.json();
    assert.equal(posted.status, 200, JSON.stringify(postedBody));
    assert.equal(postedBody.success, true);
    assert.equal(postedBody.data.sessionId, id);
    assert.equal(globalThis.__ompSessions.get(id), live, "flagless POST reuses the same wrapper");
    assert.equal(live.isAlive(), true);
    const boundary = await context.GET(new Request(`http://localhost/api/sessions/${id}/context?boundary=1`), params);
    assert.equal(boundary.status, 200, await boundary.clone().text());
    assert.deepEqual(await boundary.json(), { entryIds: [] });
    const missing = randomUUID();
    const absent = await context.GET(new Request(`http://localhost/api/sessions/${missing}/context?boundary=1`), { params: Promise.resolve({ id: missing }) });
    assert.equal(absent.status, 404, "an unrelated missing session remains a real 404");
    return { sessionId: id, advisor: true, flaglessPost: 200, boundary: 200, missing: 404 };
  } finally {
    await cleanup();
    process.removeListener("SIGTERM", interrupted); process.removeListener("SIGINT", interrupted);
  }
}
if (require.main === module) {
  (async () => {
    const values = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index];
      if (!["--release", "--omp", "--agent-dir"].includes(flag) || !process.argv[index + 1] || values[flag]) throw new Error("Expected --release PATH --omp PATH --agent-dir PATH");
      values[flag] = process.argv[index + 1];
    }
    console.log(JSON.stringify(await smoke({ release: values["--release"], omp: values["--omp"], agentDir: values["--agent-dir"] })));
  })().then(() => process.exit(0), (error) => { console.error(error.stack || error.message); process.exit(1); });
}
module.exports = { smoke };
