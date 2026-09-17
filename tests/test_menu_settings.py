import ast
import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]


class PluginTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        decky = types.ModuleType("decky")
        decky.DECKY_PLUGIN_SETTINGS_DIR = self.directory.name
        decky.logger = logging.getLogger("test")
        with patch.dict(sys.modules, {"decky": decky}):
            spec = importlib.util.spec_from_file_location("plugin_under_test", ROOT / "main.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.plugin_type = module.Plugin
        self.module = module
        self.plugin = module.Plugin()
        self.schema_version = module.SETTINGS_SCHEMA_VERSION

    async def asyncTearDown(self):
        self.directory.cleanup()


class MenuSettingsTest(PluginTestCase):
    async def test_old_settings_default_off_and_saved_choice_survives_reload(self):
        self.plugin._settings_path.write_text(json.dumps({
            "schema_version": self.schema_version, "show_gfn_badges": False,
        }), encoding="utf-8")
        await self.plugin._load_settings()
        self.assertFalse((await self.plugin.get_settings())["refresh_ui_after_resume"])
        result = await self.plugin.set_ui_refresh_enabled(True)
        self.assertTrue(result["success"])
        reloaded = self.plugin_type()
        await reloaded._load_settings()
        settings = await reloaded.get_settings()
        self.assertTrue(settings["refresh_ui_after_resume"])
        self.assertFalse(settings["show_gfn_badges"])

    async def test_invalid_values_and_failed_save_do_not_enable_feature(self):
        for value in (1, "true", None, []):
            self.assertFalse((await self.plugin.set_ui_refresh_enabled(value))["success"])
        with patch.object(self.plugin, "_save_settings", new=AsyncMock(side_effect=OSError("full"))):
            self.assertFalse((await self.plugin.set_ui_refresh_enabled(True))["success"])
        self.assertFalse((await self.plugin.get_settings())["refresh_ui_after_resume"])

    def test_backend_keeps_python38_syntax(self):
        ast.parse((ROOT / "main.py").read_text(encoding="utf-8"), feature_version=(3, 8))


class ResumeMonitorTest(PluginTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.elapsed = 100.0
        self.wall = 1700000000.0
        self.offset = 20.0
        self.module.time = types.SimpleNamespace(
            monotonic=lambda: self.elapsed, time=lambda: self.wall,
        )
        self.clock_patch = patch.object(self.plugin_type, "_read_ui_suspend_clock", side_effect=lambda: self.offset)
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        self.plugin = self.plugin_type()

    def wake(self, duration=10.0):
        self.offset += duration
        self.wall += duration
        self.plugin._sample_ui_resume_clock()

    async def enable(self):
        await self.plugin.set_ui_refresh_enabled(True)

    async def claim(self, **overrides):
        args = dict(trigger="automatic", session_id=self.plugin._ui_resume_session,
                    sequence=self.plugin._ui_resume_sequence, guard="ready")
        args.update(overrides)
        return await self.plugin.begin_ui_refresh(**args)

    async def test_startup_baseline_idle_and_wall_clock_jumps_never_arm_reload(self):
        await self.enable()
        for jump in (3600, -7200, 86400):
            self.wall += jump
            self.elapsed += 3600
            state = await self.plugin.get_ui_resume_status()
            self.assertTrue(state["available"])
            self.assertFalse(state["pending"])
            self.assertEqual(state["sequence"], 0)
        self.assertFalse((await self.claim())["allowed"])

    async def test_actual_sleep_detected_and_claimed_once_across_frontend_reloads(self):
        await self.enable()
        self.wake()
        state = await self.plugin.get_ui_resume_status()
        self.assertTrue(state["pending"])
        self.assertEqual(state["last_resume_at"], self.wall)
        self.assertEqual((await self.claim())["reason"], "too_early")
        self.elapsed += 3
        claim = await self.claim()
        self.assertTrue(claim["allowed"])
        self.assertTrue(claim["attempt_id"])
        for _ in range(3):
            state = await self.plugin.get_ui_resume_status()
            self.assertFalse(state["pending"])
            self.assertEqual(state["last_request_at"], self.wall)
            self.assertFalse((await self.claim())["allowed"])

    async def test_disabled_and_past_wakes_are_not_replayed_when_enabled(self):
        self.wake()
        self.assertEqual((await self.plugin.get_ui_resume_status())["last_outcome"], "disabled")
        await self.enable()
        self.elapsed += 5
        self.assertFalse((await self.claim())["allowed"])
        self.wake()
        await self.plugin.set_ui_refresh_enabled(False)
        await self.enable()
        self.elapsed += 5
        self.assertFalse((await self.claim())["allowed"])

    async def test_manual_request_consumes_wake_and_cooldown_limits_following_request(self):
        await self.enable()
        self.wake()
        self.assertTrue((await self.claim(trigger="manual"))["allowed"])
        self.elapsed += 5
        self.assertFalse((await self.claim())["allowed"])
        self.wake()
        self.elapsed += 3
        self.assertEqual((await self.claim())["reason"], "cooldown")
        self.elapsed += 7
        self.assertTrue((await self.claim())["allowed"])

    async def test_stale_session_or_sequence_cannot_consume_current_wake(self):
        await self.enable()
        self.wake()
        self.elapsed += 3
        for overrides in ({"session_id": "previous-backend"}, {"sequence": 0},
                          {"sequence": True}, {"sequence": "1"}):
            self.assertFalse((await self.claim(**overrides))["allowed"])
            self.assertTrue((await self.plugin.get_ui_resume_status())["pending"])
        self.assertTrue((await self.claim())["allowed"])

    async def test_locked_or_unknown_state_consumes_wake_without_reload_permission(self):
        await self.enable()
        for guard in ("locked", "lock_unknown"):
            self.wake()
            self.elapsed += 3
            self.assertFalse((await self.claim(guard=guard))["allowed"])
            state = await self.plugin.get_ui_resume_status()
            self.assertFalse(state["pending"])
            self.assertEqual(state["last_outcome"], guard)
            self.assertEqual(state["last_request_at"], 0)
            self.assertFalse((await self.claim())["allowed"])

    async def test_expired_wake_does_not_trigger_a_late_surprise_reload(self):
        await self.enable()
        self.wake()
        self.elapsed += 61
        self.assertFalse((await self.claim())["allowed"])
        self.assertEqual((await self.plugin.get_ui_resume_status())["last_outcome"], "expired")

    async def test_failed_clock_sample_and_short_jitter_do_not_arm_reload(self):
        await self.enable()
        self.offset = None
        self.assertFalse((await self.plugin.get_ui_resume_status())["pending"])
        self.offset = 20.02
        self.assertFalse((await self.plugin.get_ui_resume_status())["pending"])
        self.wake(5)
        self.assertTrue((await self.plugin.get_ui_resume_status())["pending"])

    async def test_unsupported_clock_disables_automatic_but_allows_manual_request(self):
        self.offset = None
        self.plugin = self.plugin_type()
        await self.enable()
        self.assertFalse((await self.plugin.get_ui_resume_status())["available"])
        self.assertFalse((await self.claim())["allowed"])
        self.assertTrue((await self.claim(trigger="manual"))["allowed"])

    async def test_outcome_updates_require_current_attempt_id(self):
        claim = await self.claim(trigger="manual")
        self.assertFalse((await self.plugin.finish_ui_refresh("stale", "native_error"))["success"])
        self.assertFalse((await self.plugin.finish_ui_refresh(claim["attempt_id"], "success"))["success"])
        self.assertTrue((await self.plugin.finish_ui_refresh(claim["attempt_id"], "unconfirmed"))["success"])
        self.assertEqual((await self.plugin.get_ui_resume_status())["last_outcome"], "unconfirmed")

    async def test_background_monitor_detects_wake_and_unload_stops_it(self):
        await self.enable()
        await self.plugin._main()
        self.offset += 10
        task = self.plugin._ui_resume_task
        await asyncio.sleep(0)
        self.assertEqual(self.plugin._ui_resume_sequence, 1)
        await self.plugin._unload()
        self.assertTrue(task.cancelled())
        self.assertIsNone(self.plugin._ui_resume_task)

    async def test_previous_attempt_cannot_overwrite_diagnostics_of_new_wake(self):
        await self.enable()
        claim = await self.claim(trigger="manual")
        self.wake()
        self.assertFalse((await self.plugin.finish_ui_refresh(claim["attempt_id"], "unconfirmed"))["success"])
        state = await self.plugin.get_ui_resume_status()
        self.assertEqual(state["last_outcome"], "detected")
        self.assertTrue(state["pending"])


class LinuxClockTest(PluginTestCase):
    def test_boottime_minus_monotonic_and_delayed_or_invalid_reads(self):
        for samples, expected in (([100, 120.001, 100.002], 20),
                                  ([100, 122, 103], None),
                                  ([100, float("nan"), 100], None),
                                  ([100, 120, 99], None)):
            values = iter(samples)
            self.module.time = types.SimpleNamespace(
                CLOCK_MONOTONIC=1, CLOCK_BOOTTIME=7, clock_gettime=lambda _: next(values),
            )
            actual = self.plugin_type._read_ui_suspend_clock()
            if expected is None:
                self.assertIsNone(actual)
            else:
                self.assertAlmostEqual(actual, expected)

    def test_unsupported_platform_is_handled(self):
        self.module.time = types.SimpleNamespace()
        self.assertIsNone(self.plugin_type._read_ui_suspend_clock())


if __name__ == "__main__":
    unittest.main()
