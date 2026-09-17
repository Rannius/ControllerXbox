import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const { outputText } = ts.transpileModule(readFileSync(new URL("../src/steamGameFocus.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext },
});
const { currentRunningGame, isGameRunning, returnToRunningGame } = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));

test("capture Steam's primary game, including numeric strings and non-Steam IDs", () => {
  assert.equal(currentRunningGame({ MainRunningAppID: "570", RunningApps: [{ appid: 123 }] }), 570);
  assert.equal(currentRunningGame({ MainRunningApp: { appid: 4000000000 } }), 4000000000);
  assert.equal(currentRunningGame({ RunningApps: [{ appid: "570" }] }), 570);
  assert.equal(currentRunningGame({ RunningApps: [{ appid: 123 }, { appid: 570 }] }), undefined);
  for (const id of [0, -1, true, {}, "", "bad", 4294967296, 1.5]) {
    assert.equal(currentRunningGame({ MainRunningAppID: id }), undefined);
  }
});

test("missing or throwing stores cannot break the existing reload", () => {
  for (const store of [undefined, {}, { get RunningApps() { throw new Error("loading"); } }, { RunningApps: null }]) {
    assert.equal(currentRunningGame(store), undefined);
    assert.equal(isGameRunning(store, 570), false);
  }
});

test("Game Mode return selects exact live app before navigating, with method binding", () => {
  const calls = [];
  const store = { RunningApps: [{ appid: "570" }, { appid: 123 }],
    SetRunningApp(id) { assert.equal(this, store); calls.push(id); },
    NavigateToRunningApp() { assert.equal(this, store); calls.push("resume"); },
  };
  assert.equal(returnToRunningGame(store, 570, () => assert.fail("unneeded fallback")), true);
  assert.deepEqual(calls, [570, "resume"]);
});

test("older Steam navigation uses the running-app route only after selection", () => {
  const calls = [];
  const store = { RunningApps: [{ appid: 570 }], SetRunningApp(id) { calls.push(id); } };
  assert.equal(returnToRunningGame(store, 570, (route) => calls.push(route)), true);
  assert.deepEqual(calls, [570, "/apprunning"]);
});

test("exited games and unavailable selection cannot navigate to another game", () => {
  assert.equal(returnToRunningGame({ RunningApps: [{ appid: 123 }] }, 570, () => assert.fail()), false);
  assert.throws(() => returnToRunningGame({ RunningApps: [{ appid: 570 }] }, 570, () => assert.fail()), /nem érhető el/);
});
