import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/steamUiRefresher.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext },
});
const { SteamUiRefresher } = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));

function fixture(options = {}) {
  let now = 0, nextTimer = 0, locked = false, unregisters = 0, restarts = 0;
  const timers = new Map(), reports = [];
  let resume, suspend;
  const browser = { RestartJSContext() { restarts++; } };
  const system = {
    RegisterForOnResumeFromSuspend(callback) {
      resume = callback;
      return { unregister() { unregisters++; resume = undefined; } };
    },
    RegisterForOnSuspendRequest(callback) {
      suspend = callback;
      return { unregister() { unregisters++; suspend = undefined; } };
    },
  };
  const refresher = new SteamUiRefresher({
    system: options.noSystem ? undefined : system, browser,
    isLocked: () => locked,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    report(status) { reports.push(status); },
    ...options.environment,
  });
  return {
    refresher, reports, browser, timers,
    resume: () => resume?.(), suspend: () => suspend?.(),
    lock: (value) => { locked = value; },
    unregisters: () => unregisters, restarts: () => restarts,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

test("resume is opt-in and requires an observed suspend", () => {
  const f = fixture();
  f.suspend(); f.resume(); f.advance(10_000);
  assert.equal(f.restarts(), 0);
  f.refresher.setEnabled(true);
  f.resume(); f.advance(10_000);
  assert.equal(f.restarts(), 0);
  f.suspend(); f.resume(); f.resume();
  f.advance(2_999);
  assert.equal(f.restarts(), 0);
  f.advance(1);
  assert.equal(f.restarts(), 1);
});

test("fresh UI after reload cannot loop on a replayed resume callback", () => {
  for (let i = 0; i < 3; i++) {
    const f = fixture();
    f.refresher.setEnabled(true); f.resume(); f.advance(60_000);
    assert.equal(f.restarts(), 0);
  }
});

test("manual refresh needs no resume and coalesces repeated requests", () => {
  const f = fixture();
  f.refresher.refresh(); f.refresher.refresh();
  f.advance(250);
  assert.equal(f.restarts(), 1);
  assert.match(f.refresher.status.message, /Újratöltés kérve/);
  f.refresher.refresh(); f.advance(10_000);
  assert.equal(f.restarts(), 1);
});

for (const action of ["disable", "suspend", "dispose"]) {
  test(`${action} cancels an automatic refresh before the native call`, () => {
    const f = fixture();
    f.refresher.setEnabled(true); f.suspend(); f.resume(); f.advance(2_999);
    if (action === "disable") f.refresher.setEnabled(false);
    if (action === "suspend") f.suspend();
    if (action === "dispose") f.refresher.dispose();
    f.advance(60_000);
    assert.equal(f.restarts(), 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.refresher.status.working, false);
    if (action === "dispose") assert.equal(f.unregisters(), 2);
  });
}

test("second suspend/resume replaces a cancelled attempt", () => {
  const f = fixture();
  f.refresher.setEnabled(true); f.suspend(); f.resume(); f.suspend();
  f.advance(5_000); f.resume(); f.advance(3_000);
  assert.equal(f.restarts(), 1);
});

test("locked screen or unknown lock state prevents refresh", () => {
  for (const unknown of [false, true]) {
    const f = fixture(unknown ? { environment: { isLocked() { throw new Error("unknown"); } } } : {});
    f.refresher.refresh(); f.lock(true); f.advance(1_000);
    assert.equal(f.restarts(), 0);
    assert.equal(f.refresher.status.working, false);
  }
});

test("missing restart API is reported; missing resume API still allows manual use", () => {
  const unsupported = fixture({ environment: { browser: undefined } });
  unsupported.refresher.refresh(); unsupported.advance(60_000);
  assert.equal(unsupported.restarts(), 0);
  assert.equal(unsupported.refresher.available, false);
  assert.equal(unsupported.refresher.automaticAvailable, false);
  const manual = fixture({ noSystem: true });
  assert.equal(manual.refresher.automaticAvailable, false);
  manual.refresher.refresh(); manual.advance(250);
  assert.equal(manual.restarts(), 1);
});

test("no-op native call times out without a success claim or automatic retry", () => {
  const f = fixture();
  f.refresher.setEnabled(true); f.suspend(); f.resume(); f.advance(60_000);
  assert.equal(f.restarts(), 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.refresher.status.working, false);
  assert.match(f.refresher.status.message, /nem sikerült visszaigazolni/);
  f.resume(); f.advance(60_000);
  assert.equal(f.restarts(), 1);
});

test("native error allows a later manual retry", () => {
  const f = fixture();
  f.browser.RestartJSContext = () => { throw new Error("native error"); };
  f.refresher.refresh(); f.advance(250);
  assert.match(f.refresher.status.message, /native error/);
  assert.equal(f.refresher.status.working, false);
  assert.equal(f.timers.size, 0);
  let retried = false;
  f.browser.RestartJSContext = () => { retried = true; };
  f.refresher.refresh(); f.advance(250);
  assert.equal(retried, true);
});

test("disposing after issuing a reload cancels the acknowledgement timer", () => {
  const f = fixture();
  f.refresher.refresh(); f.advance(250);
  f.refresher.dispose();
  const reports = f.reports.length;
  f.advance(60_000);
  assert.equal(f.reports.length, reports);
  assert.equal(f.timers.size, 0);
});

test("partial registration failure releases the first subscription", () => {
  let released = false;
  const f = fixture({ environment: { system: {
    RegisterForOnResumeFromSuspend() { return { unregister() { released = true; } }; },
    RegisterForOnSuspendRequest() { throw new Error("unavailable"); },
  } } });
  assert.equal(released, true);
  assert.equal(f.refresher.automaticAvailable, false);
});

function modernFixture(options = {}) {
  let prepare, resume, wake, active = 0;
  const subscription = () => {
    active++;
    return { unregister() { active--; } };
  };
  const user = {
    RegisterForPrepareForSystemSuspendProgress(callback) {
      assert.equal(this, user);
      prepare = callback;
      // Native APIs may emit their current state while registering.
      callback({ state: 5, bGameSuspended: false });
      return subscription();
    },
    RegisterForResumeSuspendedGamesProgress(callback) {
      assert.equal(this, user);
      resume = callback;
      callback({ state: 1, bGameSuspended: false });
      return subscription();
    },
  };
  const sleepManager = {
    RegisterForNotifyResumeFromSuspend(callback) {
      assert.equal(this, sleepManager);
      wake = callback;
      return subscription();
    },
  };
  const f = fixture({ noSystem: true, environment: {
    user,
    ...(options.sleepManager ? { sleepManager } : {}),
    ...options.environment,
  } });
  return {
    ...f,
    prepare: (state, bGameSuspended = false) => prepare?.({ state, bGameSuspended }),
    resumeProgress: (state) => resume?.({ state }),
    wake: () => wake?.(),
    active: () => active,
  };
}

test("modern Steam without System suspend APIs enables the automatic switch", () => {
  const f = modernFixture();
  assert.equal(f.refresher.automaticAvailable, true);
  f.refresher.setEnabled(true);
  f.prepare(5); f.prepare(1);
  f.resumeProgress(3); f.advance(5_000);
  assert.equal(f.restarts(), 0, "do not restart during resume progress");
  f.resumeProgress(1); f.resumeProgress(1);
  f.advance(2_999);
  assert.equal(f.restarts(), 0);
  f.advance(1);
  assert.equal(f.restarts(), 1);
  f.refresher.dispose();
  assert.equal(f.active(), 0);
});

test("modern registration and replayed completed states cannot cause a reload loop", () => {
  const f = modernFixture();
  f.refresher.setEnabled(true);
  f.prepare(0); f.prepare(1, true); f.resumeProgress(1);
  f.advance(60_000);
  assert.equal(f.restarts(), 0);
  assert.equal(f.refresher.status.working, false);
});

test("SleepManager wake works with User preparation and no legacy System APIs", () => {
  const f = modernFixture({ sleepManager: true });
  assert.equal(f.refresher.automaticAvailable, true);
  assert.equal(f.active(), 2, "subscribe to exactly one wake source");
  f.refresher.setEnabled(true);
  f.wake(); f.advance(10_000);
  assert.equal(f.restarts(), 0);
  f.prepare(2); f.prepare(5); f.prepare(1);
  f.wake(); f.wake(); f.advance(3_000);
  assert.equal(f.restarts(), 1);
  f.refresher.dispose();
  assert.equal(f.active(), 0);
});

test("throwing legacy stubs fall back to modern events; abandoned callbacks stay inert", () => {
  let legacyWake;
  const f = modernFixture({ environment: { system: {
    RegisterForOnResumeFromSuspend(callback) {
      legacyWake = callback;
      throw new Error("removed native method");
    },
    RegisterForOnSuspendRequest() { throw new Error("removed native method"); },
  } } });
  assert.equal(f.refresher.automaticAvailable, true);
  f.refresher.setEnabled(true); f.prepare(5); f.prepare(1);
  legacyWake(); f.advance(10_000);
  assert.equal(f.restarts(), 0);
  f.resumeProgress(1); f.advance(3_000);
  assert.equal(f.restarts(), 1);
});

test("modern pending wake is cancelled on another suspend or unload", () => {
  const f = modernFixture();
  f.refresher.setEnabled(true); f.prepare(5); f.resumeProgress(1);
  f.advance(2_999); f.prepare(2); f.advance(5_000);
  assert.equal(f.restarts(), 0);
  f.resumeProgress(1); f.refresher.dispose(); f.advance(5_000);
  assert.equal(f.restarts(), 0);
  assert.equal(f.active(), 0);
});
