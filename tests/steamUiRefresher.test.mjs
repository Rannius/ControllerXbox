import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/steamUiRefresher.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext },
});
const { SteamUiRefresher } = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(options = {}) {
  let now = 0, nextTimer = 0, locked = false, restarts = 0;
  const timers = new Map(), reports = [], claims = [], finishes = [];
  const backend = options.backend ?? {
    success: true, available: true, enabled: false, session_id: "backend-session", sequence: 0,
    pending: false, last_resume_at: 0, last_request_at: 0, last_outcome: "idle",
  };
  const browser = { RestartJSContext() { restarts++; if (options.nativeError) throw new Error("native failed"); } };
  const refresher = new SteamUiRefresher({
    browser,
    getResumeStatus: async () => ({ ...backend }),
    async beginRefresh(trigger, session, sequence, guard) {
      claims.push({ trigger, session, sequence, guard });
      if (trigger === "automatic" && (!backend.enabled || !backend.pending || session !== backend.session_id || sequence !== backend.sequence)) {
        return { success: true, allowed: false, reason: "stale" };
      }
      backend.pending = false;
      if (guard !== "ready") {
        backend.last_outcome = guard;
        return { success: true, allowed: false, reason: guard };
      }
      backend.last_request_at = 1 + now / 1000;
      backend.last_outcome = "requested";
      return { success: true, allowed: true, attempt_id: "attempt" };
    },
    async finishRefresh(id, outcome) { finishes.push({ id, outcome }); backend.last_outcome = outcome; },
    isLocked: () => locked,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    report(status) { reports.push(status); },
    ...options.environment,
  });
  return {
    refresher, reports, browser, timers, backend, claims, finishes,
    enable(value = true) { backend.enabled = value; refresher.setEnabled(value); },
    wake() {
      backend.sequence++; backend.pending = backend.enabled;
      backend.last_resume_at = 1 + now / 1000;
      backend.last_outcome = backend.enabled ? "detected" : "disabled";
    },
    lock: (value) => { locked = value; }, restarts: () => restarts,
    async advance(ms) {
      await drain();
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
        await drain();
      }
      now = end;
      await drain();
    },
  };
}

test("startup, idle time and disabled wakes do not reload the UI", async () => {
  const f = fixture();
  f.wake(); await f.advance(10_000);
  assert.equal(f.restarts(), 0);
  f.enable(); await f.advance(3_600_000);
  assert.equal(f.restarts(), 0);
  assert.equal(f.claims.length, 0);
  assert.equal(f.refresher.automaticAvailable, true);
  assert.ok(f.reports.length < 10, "unchanged status must not cause constant rerenders");
});

test("Linux wake reloads once after delay, without any Steam event APIs or mounted panel", async () => {
  const f = fixture();
  f.enable(); await f.advance(0); f.wake();
  await f.advance(4_999);
  assert.equal(f.restarts(), 0);
  await f.advance(1);
  assert.equal(f.restarts(), 1);
  assert.equal(f.claims[0].trigger, "automatic");
  assert.equal(f.claims[0].sequence, 1);
  await f.advance(60_000);
  assert.equal(f.restarts(), 1);
  assert.equal(f.refresher.status.resume.last_resume_at, 1);
  assert.ok(f.refresher.status.resume.last_request_at > 0);
});

test("recreating the frontend after reload cannot replay a backend-consumed wake", async () => {
  const first = fixture(); first.enable(); await first.advance(0); first.wake(); await first.advance(5_000);
  first.refresher.dispose();
  const second = fixture({ backend: first.backend });
  await second.advance(60_000);
  assert.equal(second.restarts(), 0);
  assert.equal(second.refresher.status.resume.last_outcome, "requested");
  assert.ok(second.refresher.status.resume.last_request_at > 0);
});

test("manual refresh coalesces clicks and consumes a pending wake", async () => {
  const f = fixture(); f.enable(); await f.advance(0); f.wake();
  f.refresher.refresh(); f.refresher.refresh(); await f.advance(250);
  assert.equal(f.restarts(), 1);
  assert.equal(f.claims.length, 1);
  assert.equal(f.claims[0].trigger, "manual");
  await f.advance(60_000);
  assert.equal(f.restarts(), 1);
});

for (const action of ["disable", "dispose"]) {
  test(`${action} cancels a scheduled automatic refresh`, async () => {
    const f = fixture(); f.enable(); await f.advance(0); f.wake(); await f.advance(4_999);
    if (action === "disable") f.enable(false); else f.refresher.dispose();
    await f.advance(60_000);
    assert.equal(f.restarts(), 0);
    assert.equal(f.refresher.status.working, false);
    if (action === "dispose") assert.equal(f.timers.size, 0);
  });
  test(`${action} during an asynchronous claim prevents the native call`, async () => {
    let resolve;
    const f = fixture({ environment: { beginRefresh: () => new Promise((r) => { resolve = r; }) } });
    f.enable(); await f.advance(0); f.wake(); await f.advance(5_000);
    assert.equal(typeof resolve, "function");
    if (action === "disable") f.enable(false); else f.refresher.dispose();
    resolve({ success: true, allowed: true, attempt_id: "late" }); await drain();
    assert.equal(f.restarts(), 0);
    assert.deepEqual(f.finishes, [{ id: "late", outcome: "cancelled" }]);
  });
}

for (const unknown of [false, true]) {
  test(`locked or unknown lock state skips and records a wake (${unknown})`, async () => {
    const f = fixture(unknown ? { environment: { isLocked() { throw new Error("unknown"); } } } : {});
    f.lock(true); f.enable(); await f.advance(0); f.wake(); await f.advance(60_000);
    assert.equal(f.restarts(), 0);
    assert.equal(f.backend.last_outcome, unknown ? "lock_unknown" : "locked");
    assert.equal(f.claims.length, 1);
  });
}

test("lock appearing while the backend claim is in flight prevents native reload", async () => {
  let resolve;
  const f = fixture({ environment: { beginRefresh: () => new Promise((r) => { resolve = r; }) } });
  f.refresher.refresh(); await f.advance(250); f.lock(true);
  resolve({ success: true, allowed: true, attempt_id: "late" }); await drain();
  assert.equal(f.restarts(), 0);
  assert.deepEqual(f.finishes, [{ id: "late", outcome: "locked" }]);
});

test("late status response cannot undo a toggle saved while the read was in flight", async () => {
  let resolve;
  const f = fixture({ environment: { getResumeStatus: () => new Promise((r) => { resolve = r; }) } });
  f.enable(false);
  resolve({ ...f.backend, enabled: true, pending: true, sequence: 1 });
  await f.advance(1_999);
  assert.equal(f.refresher.status.working, false);
  assert.equal(f.restarts(), 0);
  f.refresher.dispose();
});

test("unsupported monitor is visible and manual reload still works", async () => {
  const f = fixture(); f.backend.available = false; await f.advance(2_000);
  assert.equal(f.refresher.automaticAvailable, false);
  assert.match(f.refresher.status.monitorMessage, /nem érhető el/);
  f.refresher.refresh(); await f.advance(250);
  assert.equal(f.restarts(), 1);
});

test("backend polling failure is reported and can recover", async () => {
  let fail = true, active = 0, maxActive = 0;
  const f = fixture({ environment: { async getResumeStatus() {
    active++; maxActive = Math.max(active, maxActive);
    try { if (fail) throw new Error("offline"); return { ...f.backend }; } finally { active--; }
  } } });
  await f.advance(0);
  assert.match(f.refresher.status.monitorMessage, /offline/);
  assert.equal(f.refresher.automaticAvailable, false);
  fail = false; await f.advance(2_000);
  assert.equal(f.refresher.automaticAvailable, true);
  assert.equal(maxActive, 1);
});

test("native error consumes the wake and is not retried", async () => {
  const f = fixture({ nativeError: true }); f.enable(); await f.advance(0); f.wake(); await f.advance(60_000);
  assert.equal(f.restarts(), 1);
  assert.equal(f.backend.last_outcome, "native_error");
  assert.match(f.refresher.status.message, /native failed/);
});

test("native no-op is reported as unconfirmed without another attempt", async () => {
  const f = fixture(); f.enable(); await f.advance(0); f.wake(); await f.advance(60_000);
  assert.equal(f.restarts(), 1);
  assert.equal(f.backend.last_outcome, "unconfirmed");
  assert.match(f.refresher.status.message, /nem igazolható/);
});

test("stale automatic claim after backend restart never calls Steam", async () => {
  const f = fixture(); f.enable(); await f.advance(0); f.wake(); await f.advance(2_000);
  f.backend.session_id = "new-session"; f.backend.pending = false;
  await f.advance(20_000);
  assert.equal(f.restarts(), 0);
  assert.equal(f.claims.length, 1);
});

test("claim failure leaves the native API untouched", async () => {
  const f = fixture({ environment: { async beginRefresh() { throw new Error("claim timeout"); } } });
  f.refresher.refresh(); await f.advance(250);
  assert.equal(f.restarts(), 0);
  assert.equal(f.refresher.status.working, false);
  assert.match(f.refresher.status.message, /claim timeout/);
});

test("missing native API cannot schedule manual or automatic refresh", async () => {
  const f = fixture({ environment: { browser: {} } });
  f.enable(); await f.advance(0); f.wake(); f.refresher.refresh(); await f.advance(20_000);
  assert.equal(f.refresher.available, false);
  assert.equal(f.refresher.automaticAvailable, false);
  assert.equal(f.claims.length, 0);
});
