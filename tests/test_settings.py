import ast
import importlib.util
import io
import json
import logging
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class SettingsTest(unittest.IsolatedAsyncioTestCase):
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
        self.plugin = module.Plugin()
        self.schema_version = module.SETTINGS_SCHEMA_VERSION
        self.cache_schema_version = module.CACHE_SCHEMA_VERSION

    async def asyncTearDown(self):
        self.directory.cleanup()

    async def test_legacy_refresh_setting_is_ignored_and_other_preferences_survive(self):
        self.plugin._settings_path.write_text(json.dumps({
            "schema_version": self.schema_version,
            "refresh_ui_after_resume": True,
            "show_gfn_badges": False,
            "show_boosteroid_badges": True,
            "notify_gfn_additions": False,
            "notify_boosteroid_additions": True,
            "notify_boosteroid_maintenance": False,
            "notify_plugin_updates": False,
        }), encoding="utf-8")
        await self.plugin._main()
        settings = await self.plugin.get_settings()
        self.assertNotIn("refresh_ui_after_resume", settings)
        self.assertFalse(settings["show_gfn_badges"])
        self.assertTrue(settings["show_boosteroid_badges"])
        self.assertFalse(settings["notify_gfn_additions"])
        self.assertTrue(settings["notify_boosteroid_additions"])
        self.assertFalse(settings["notify_boosteroid_maintenance"])
        self.assertFalse(settings["notify_plugin_updates"])
        await self.plugin._unload()
        persisted = json.loads(self.plugin._settings_path.read_text(encoding="utf-8"))
        self.assertNotIn("refresh_ui_after_resume", persisted)
        reloaded = self.plugin_type()
        await reloaded._load_settings()
        self.assertEqual(await reloaded.get_settings(), settings)

    async def test_badge_preferences_still_save_and_reload(self):
        result = await self.plugin.set_badge_visibility(False, False)
        self.assertTrue(result["success"])
        reloaded = self.plugin_type()
        await reloaded._load_settings()
        settings = await reloaded.get_settings()
        self.assertFalse(settings["show_gfn_badges"])
        self.assertFalse(settings["show_boosteroid_badges"])
        self.assertTrue(settings["show_hungarian_badges"])

    async def test_hungarian_preference_persists_and_old_callers_preserve_it(self):
        result = await self.plugin.set_badge_visibility(True, True, False)
        self.assertTrue(result["success"])
        await self.plugin.set_badge_visibility(False, True)
        reloaded = self.plugin_type()
        await reloaded._load_settings()
        self.assertFalse((await reloaded.get_settings())["show_hungarian_badges"])
        invalid = await self.plugin.set_badge_visibility(True, True, "true")
        self.assertFalse(invalid["success"])
        self.assertFalse((await self.plugin.get_settings())["show_hungarian_badges"])

    def test_only_explicit_official_hungarian_language_matches(self):
        cases = [
            ("English<strong>*</strong>, Hungarian, German<br><strong>*</strong>languages with full audio support", True),
            ("English, Hungarian<strong>*</strong><br />full audio support", True),
            ("English, &nbsp;Hungarian&nbsp;, German", True),
            ("English, German, French", False),
            ("English<BR />Hungarian community translation", False),
            ("English, Hungarian community translation", False),
            (None, None), ([], None), ("", None), ("<br>Hungarian", None),
        ]
        for languages, expected in cases:
            with self.subTest(languages=languages):
                self.assertIs(self.plugin._hungarian_support(languages), expected)

    def test_one_steam_request_supplies_controller_and_language_data(self):
        payload = {"292030": {"success": True, "data": {
            "categories": [{"id": 28}],
            "supported_languages": "English<strong>*</strong>, Hungarian",
        }}}
        with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(payload))) as request:
            self.assertEqual(self.plugin._fetch_support("292030"), {
                "controller_support_level": "full", "hungarian": True,
            })
        request.assert_called_once()
        self.assertIn("l=english", request.call_args.args[0].full_url)

    async def test_old_cache_is_refreshed_and_new_language_result_is_reused(self):
        self.plugin._cache["292030"] = {
            "schema_version": self.cache_schema_version - 1,
            "controller_support_level": "full", "checked_at": time.time(),
        }
        with patch.object(self.plugin, "_fetch_support", return_value={
            "controller_support_level": "full", "hungarian": True,
        }) as fetch:
            first = await self.plugin.get_controller_support(["292030"])
            second = await self.plugin.get_controller_support(["292030"])
        fetch.assert_called_once_with("292030")
        self.assertEqual(first, second)
        self.assertEqual(second["hungarian"], {"292030": True})
        self.assertEqual(second["levels"], {"292030": "full"})

    async def test_unknown_language_and_failed_fetch_never_claim_hungarian(self):
        with patch.object(self.plugin, "_fetch_support", side_effect=[
            {"controller_support_level": "partial", "hungarian": None}, None,
        ]):
            unknown = await self.plugin.get_controller_support(["10"])
            failed = await self.plugin.get_controller_support(["20"])
        self.assertEqual(unknown["hungarian"], {"10": None})
        self.assertEqual(unknown["levels"], {"10": "partial"})
        self.assertEqual(failed["hungarian"], {"20": None})
        self.assertEqual(failed["unavailable"], ["20"])

    def test_backend_keeps_python38_syntax(self):
        ast.parse((ROOT / "main.py").read_text(encoding="utf-8"), feature_version=(3, 8))

    async def test_library_snapshot_reads_only_fresh_requested_cache_without_network(self):
        self.plugin._cache = {
            "10": {"schema_version": self.cache_schema_version, "checked_at": time.time(), "hungarian": True},
            "20": {"schema_version": self.cache_schema_version, "checked_at": time.time(), "hungarian": False},
            "30": {"schema_version": self.cache_schema_version - 1, "checked_at": time.time(), "hungarian": True},
            "40": {"schema_version": self.cache_schema_version, "checked_at": 0, "hungarian": True},
            "50": {"schema_version": self.cache_schema_version, "checked_at": time.time(), "hungarian": None},
            "60": {"schema_version": self.cache_schema_version, "checked_at": time.time(), "hungarian": True},
        }
        with patch.object(self.plugin, "_fetch_support") as fetch:
            result = await self.plugin.get_hungarian_library_cache(["10", "20", "30", "40", "50", "bad"])
        fetch.assert_not_called()
        self.assertEqual(result, {"success": True, "hungarian": {"10": True, "20": False, "50": None}})


if __name__ == "__main__":
    unittest.main()
