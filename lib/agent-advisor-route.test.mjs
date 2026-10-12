import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST } = await jiti.import("../app/api/agent/[id]/route.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

// Fake only the process boundary: routing, wrapper lifecycle, command dispatch,
// workspace registry reads and absent-session-file resolution are real.
async function freshSession(t, { workspaceAdvisor = false, advisorSpawned = false, location = "project", busy = false, hidden = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-advisor-route-"));
  const project = join(root, "project");
  mkdirSync(project);
  let cwd = project;
  if (location === "worktree") {
    cwd = join(`${project}-worktrees`, "topic");
    mkdirSync(cwd, { recursive: true });
  } else if (location === "symlink") {
    cwd = join(root, "project-link");
    symlinkSync(project, cwd, "dir");
  }
  writeFileSync(join(root, "projects.json"), JSON.stringify({
    version: 1,
    projects: [{ path: project, addedAt: "2026-01-01T00:00:00.000Z", hidden, launchConfig: { advisor: workspaceAdvisor } }],
  }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessions = globalThis.__ompSessions;
  const previousLocks = globalThis.__ompStartLocks;
  process.env.PI_CODING_AGENT_DIR = root;
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = new Map();
  const id = "fresh-advisor-session";
  const sessionFile = join(root, "sessions", "project", `${id}.jsonl`);
  const commands = [];
  let disposals = 0;
  let emit;
  const proc = {
    isAlive: true,
    onFrame(listener) { emit = listener; return () => {}; },
    waitReady: async () => ({}),
    negotiateProtocol: async () => {},
    async sendCommand(command) {
      commands.push(command);
      switch (command.type) {
        case "set_subagent_subscription":
        case "set_ask_dialog": return {};
        case "get_state": return { sessionId: id, sessionFile, isStreaming: false, isCompacting: false, messages: [] };
        case "set_fast_mode": return { enabled: true, active: true };
        case "predict_word": return { suffix: "completion" };
        case "get_skill_diagnostics": return { cwd, showStartupDiagnostics: false, diagnostics: [] };
        default: throw new Error(`Unexpected fake-process command: ${command.type}`);
      }
    },
    sendFrame() {},
    async dispose() { disposals++; proc.isAlive = false; },
  };
  const wrapper = new AgentSessionWrapper(proc, cwd, null, advisorSpawned, id, 0);
  t.after(async () => {
    await wrapper.destroyAndWait();
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompStartLocks = previousLocks;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  wrapper.start();
  await wrapper.waitUntilReady();
  globalThis.__ompSessions.set(id, wrapper);
  if (busy) emit({ type: "agent_start" });
  commands.length = 0;
  assert.equal(existsSync(sessionFile), false, "omp has not persisted the fresh session yet");
  assert.equal(wrapper.sessionFile, sessionFile);
  return { wrapper, commands, disposals: () => disposals, id };
}

function post(id, query = "", body = { type: "set_fast_mode", enabled: true }) {
  return POST(new Request(`http://localhost/api/agent/${id}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

for (const location of ["project", "worktree", "symlink"]) {
  test(`fresh workspace-forced advisor child survives a POST without advisor query (${location})`, async (t) => {
    const session = await freshSession(t, { workspaceAdvisor: true, advisorSpawned: true, location });
    assert.equal(session.wrapper.isRunning(), false);
    const response = await post(session.id);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: { enabled: true, active: true } });
    assert.equal(session.disposals(), 0, "the live child is never destroyed");
    assert.equal(session.wrapper.isAlive(), true);
    assert.equal(globalThis.__ompSessions.get(session.id), session.wrapper);
    assert.deepEqual(session.commands, [{ type: "set_fast_mode", enabled: true }]);
  });
}

for (const [advisorSpawned, query] of [[false, ""], [true, "?advisor=1"]]) {
  test(`matching per-chat advisor choice reuses a fresh child (${advisorSpawned})`, async (t) => {
    const session = await freshSession(t, { advisorSpawned });
    const response = await post(session.id, query);
    assert.equal(response.status, 200);
    assert.equal(session.disposals(), 0);
    assert.equal(session.commands.length, 1);
  });
}

for (const [advisorSpawned, query] of [[false, "?advisor=1"], [true, ""]]) {
  test(`real per-chat advisor mismatch disposes an idle child (${advisorSpawned})`, async (t) => {
    const session = await freshSession(t, { advisorSpawned });
    const response = await post(session.id, query);
    // Replacement still requires a saved session. Unlike a workspace-forced
    // match, this is a real toggle change, so the fresh wrapper is disposed.
    assert.equal(response.status, 404);
    assert.equal(session.disposals(), 1);
    assert.equal(session.wrapper.isAlive(), false);
    assert.deepEqual(session.commands, []);
  });
}

test("a hidden workspace does not force advisor mode", async (t) => {
  const session = await freshSession(t, { workspaceAdvisor: true, advisorSpawned: true, hidden: true });
  assert.equal((await post(session.id)).status, 404);
  assert.equal(session.disposals(), 1);
});

test("a busy child survives a real advisor mismatch", async (t) => {
  const session = await freshSession(t, { busy: true });
  assert.equal(session.wrapper.isRunning(), true);
  assert.equal((await post(session.id, "?advisor=1")).status, 200);
  assert.equal(session.disposals(), 0);
  assert.equal(session.commands.length, 1);
});

test("no-spawn predictions reuse a live child despite advisor mismatch", async (t) => {
  const session = await freshSession(t);
  const response = await post(session.id, "?advisor=1", { type: "predict_word", text: "test" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, data: { suffix: "completion" } });
  assert.equal(session.disposals(), 0);
});

test("live-only diagnostics reuse a live child despite advisor mismatch", async (t) => {
  const session = await freshSession(t);
  const response = await post(session.id, "?advisor=1", { type: "get_skill_diagnostics" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { cwd: session.wrapper.cwd, showStartupDiagnostics: false, diagnostics: [] });
  assert.equal(session.disposals(), 0);
  assert.deepEqual(session.commands, [{ type: "get_skill_diagnostics" }]);
});
