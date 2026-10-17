import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tryNative: false, tsconfigPaths: true });
const { ForkUpdateControl } = await jiti.import("./ForkUpdateControl.tsx");
afterEach(cleanup);

const current = { service: "ompweb-old", port: 30179, releaseDir: "/releases/old", commit: "old", version: "0.5.2-habi.1" };
function status(state = "running", stage = "fetching", extra = {}) {
  return { attemptId: "attempt-1", state, stage, startedAt: "2026-10-17T01:00:00Z", ...extra };
}
function info(savedStatus = null) {
  return { supported: true, current, status: savedStatus };
}
function response(value, code = 200) {
  return new Response(JSON.stringify(value), { status: code, headers: { "Content-Type": "application/json" } });
}
function clock(t) {
  let id = 0;
  const timers = new Map();
  t.mock.method(window, "setTimeout", (callback, delay) => {
    assert.equal(delay, 2_000, "status polling uses the two-second interval");
    timers.set(++id, callback);
    return id;
  });
  t.mock.method(window, "clearTimeout", (timerId) => timers.delete(timerId));
  return {
    async tick() {
      const callbacks = [...timers.values()];
      timers.clear();
      await act(async () => { for (const callback of callbacks) await callback(); });
    },
    get pending() { return timers.size; },
  };
}
async function mount() {
  let view;
  await act(async () => { view = render(React.createElement(ForkUpdateControl, { currentVersion: current.version })); });
  return view;
}
const updateButton = () => screen.getByRole("button", { name: "Update from upstream" });
const clickUpdate = () => act(async () => { updateButton().click(); });

test("only one update is submitted while a request or persisted update is active", async (t) => {
  clock(t);
  let saved = info();
  let finishPost;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    assert.equal(url, "/api/fork-update");
    if (options.method !== "POST") return response(saved);
    posts++;
    assert.deepEqual(JSON.parse(options.body), { action: "update" });
    assert.equal(options.headers["Content-Type"], "application/json");
    return new Promise((resolve) => { finishPost = resolve; });
  });
  await mount();
  assert.equal(updateButton().disabled, false);
  assert.match(screen.getByRole("region", { name: "ompweb fork updates" }).textContent, /0\.5\.2-habi\.1/);
  await clickUpdate();
  await clickUpdate();
  assert.equal(posts, 1);
  assert.equal(updateButton().disabled, true);
  saved = info(status());
  await act(async () => { finishPost(response(saved, 202)); });
  assert.match(screen.getByRole("status").textContent, /Fetching upstream/);
  await clickUpdate();
  assert.equal(posts, 1);
  assert.equal(updateButton().disabled, true);
});

test("persisted phases advance to success and offer a working reload action", async (t) => {
  const timer = clock(t);
  let saved = info(status("running", "testing"));
  t.mock.method(globalThis, "fetch", async () => response(saved));
  await mount();
  assert.match(screen.getByRole("status").textContent, /Running the full test suite/);
  saved = info(status("running", "deploying"));
  await timer.tick();
  assert.match(screen.getByRole("status").textContent, /Deploying the staged release/);
  saved = { ...info(status("succeeded", "complete")), current: { ...current, version: "0.5.2-habi.2" } };
  await timer.tick();
  assert.match(screen.getByRole("status").textContent, /Update deployed successfully/);
  assert.match(screen.getByRole("region").textContent, /0\.5\.2-habi\.2/);
  assert.equal(timer.pending, 0, "terminal updates stop polling");
  let reloads = 0;
  const originalWindow = globalThis.window;
  // jsdom's Location is non-configurable. Substitute only the browser boundary
  // during the click, leaving the rendered component and DOM untouched.
  globalThis.window = new Proxy(originalWindow, {
    get(target, key) { return key === "location" ? { reload() { reloads++; } } : Reflect.get(target, key); },
  });
  try {
    await act(async () => { screen.getByRole("button", { name: "Reload" }).click(); });
    assert.equal(reloads, 1);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("failed updates keep technical details visible and allow retry", async (t) => {
  clock(t);
  let saved = info(status("failed", "merging", { error: "Merge conflict in components/SessionSidebar.tsx\nResolve the fork checkout before retrying." }));
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url, options = {}) => {
    if (options.method === "POST") {
      posts++;
      saved = info(status("running", "starting", { attemptId: "attempt-2" }));
      return response(saved, 202);
    }
    return response(saved);
  });
  await mount();
  assert.match(screen.getByRole("status").textContent, /Update failed/);
  const error = screen.getByRole("alert");
  assert.match(error.textContent, /SessionSidebar\.tsx/);
  assert.equal(error.style.overflowWrap, "anywhere");
  assert.equal(updateButton().disabled, false);
  await clickUpdate();
  assert.equal(posts, 1);
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(updateButton().disabled, true);
  assert.match(screen.getByRole("status").textContent, /Preparing update/);
});

test("transient status failures preserve the running phase and never claim completion", async (t) => {
  const timer = clock(t);
  let offline = false;
  let saved = info(status("running", "building"));
  t.mock.method(globalThis, "fetch", async () => {
    if (offline) throw new TypeError("Failed to fetch");
    return response(saved);
  });
  await mount();
  offline = true;
  await timer.tick();
  const text = screen.getAllByRole("status").map((node) => node.textContent).join(" ");
  assert.match(text, /Building the release/);
  assert.match(text, /Reconnecting automatically/);
  assert.doesNotMatch(text, /successfully|Already up to date/);
  assert.equal(screen.queryByRole("button", { name: "Reload" }), null);
  assert.equal(updateButton().disabled, true);
  offline = false;
  saved = info(status("running", "smoke"));
  await timer.tick();
  assert.match(screen.getByRole("status").textContent, /Smoke-testing OMP/);
  saved = info(status("succeeded", "complete"));
  await timer.tick();
  assert.ok(screen.getByRole("button", { name: "Reload" }));
});

test("mount and remount attach to saved running status without submitting", async (t) => {
  clock(t);
  let posts = 0;
  const signals = [];
  t.mock.method(globalThis, "fetch", async (_url, options = {}) => {
    if (options.method === "POST") posts++;
    signals.push(options.signal);
    return response(info(status("running", "typechecking")));
  });
  const first = await mount();
  assert.match(screen.getByRole("status").textContent, /Checking TypeScript/);
  first.unmount();
  assert.equal(signals[0].aborted, true);
  await mount();
  assert.equal(updateButton().disabled, true);
  assert.match(screen.getByRole("status").textContent, /Checking TypeScript/);
  assert.equal(posts, 0);
});

test("a 409 response attaches to the update another client already started", async (t) => {
  clock(t);
  let saved = info();
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url, options = {}) => {
    if (options.method === "POST") {
      posts++;
      saved = info(status("running", "installing"));
      return response(saved, 409);
    }
    return response(saved);
  });
  await mount();
  await clickUpdate();
  assert.match(screen.getByRole("status").textContent, /Installing dependencies/);
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(updateButton().disabled, true);
  await clickUpdate();
  assert.equal(posts, 1);
});

test("a lost POST response reconciles status instead of allowing duplicate submissions", async (t) => {
  const timer = clock(t);
  let saved = info();
  let disconnected = false;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url, options = {}) => {
    if (options.method === "POST") {
      posts++;
      saved = info(status("running", "publishing"));
      disconnected = true;
      throw new TypeError("Proxy connection closed");
    }
    if (disconnected) throw new TypeError("Proxy connection closed");
    return response(saved);
  });
  await mount();
  await clickUpdate();
  assert.equal(updateButton().disabled, true);
  assert.match(screen.getAllByRole("status").map((node) => node.textContent).join(" "), /Checking whether the update started/);
  await clickUpdate();
  assert.equal(posts, 1);
  disconnected = false;
  await timer.tick();
  assert.match(screen.getByRole("status").textContent, /Publishing the fork branch/);
  assert.equal(updateButton().disabled, true);
});

test("up-to-date is explicit, retryable, and not presented as a deployment", async (t) => {
  clock(t);
  t.mock.method(globalThis, "fetch", async () => response(info(status("up_to_date", "complete"))));
  await mount();
  assert.match(screen.getByRole("status").textContent, /Already up to date/);
  assert.equal(updateButton().disabled, false);
  assert.equal(screen.queryByRole("button", { name: "Reload" }), null);
});

test("malformed status responses preserve progress until a valid response arrives", async (t) => {
  const timer = clock(t);
  let saved = info(status("running", "testing"));
  t.mock.method(globalThis, "fetch", async () => response(saved));
  await mount();
  saved = { supported: true, status: { state: "succeeded" } };
  await timer.tick();
  const text = screen.getAllByRole("status").map((node) => node.textContent).join(" ");
  assert.match(text, /Running the full test suite/);
  assert.match(text, /Reconnecting automatically/);
  assert.equal(updateButton().disabled, true);
  assert.equal(screen.queryByRole("button", { name: "Reload" }), null);
  saved = info(status("succeeded", "complete"));
  await timer.tick();
  assert.ok(screen.getByRole("button", { name: "Reload" }));
});

test("unmount aborts an in-flight update request", async (t) => {
  clock(t);
  let postSignal;
  t.mock.method(globalThis, "fetch", async (_url, options = {}) => {
    if (options.method !== "POST") return response(info());
    postSignal = options.signal;
    return new Promise((_resolve, reject) => {
      postSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const view = await mount();
  await clickUpdate();
  await act(async () => { view.unmount(); });
  assert.equal(postSignal.aborted, true);
});
