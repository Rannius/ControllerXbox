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


class MenuSettingsTest(unittest.IsolatedAsyncioTestCase):
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


if __name__ == "__main__":
    unittest.main()
