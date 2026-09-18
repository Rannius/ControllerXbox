import ast
import importlib.util
import json
import logging
from pathlib import Path
import sys
import tempfile
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

    def test_backend_keeps_python38_syntax(self):
        ast.parse((ROOT / "main.py").read_text(encoding="utf-8"), feature_version=(3, 8))


if __name__ == "__main__":
    unittest.main()
