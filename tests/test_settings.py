import ast
import asyncio
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
        self.parser_type = module.HungarianCuratorParser
        # Ordinary tests use an already-fetched empty catalog and never network.
        self.plugin._hungarian_curator_checked_at = time.time()

    async def asyncTearDown(self):
        await self.plugin._stop_hungarian_curator_refresh()
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
        self.assertTrue(result["success"])
        self.assertEqual(result["hungarian"], {"10": True, "20": False, "50": None})

    @staticmethod
    def curator_card(app_id, recommended=True):
        return ('<div class="recommendation"><div><a data-ds-appid="{0}" '
                'href="https://store.steampowered.com/app/{0}/?curator_clanid=34235089">Game</a></div>'
                '<span class="{1}">Review</span><div class="recommendation_desc">Magyar Felirat</div></div>').format(
                    app_id, "color_recommended" if recommended else "color_not_recommended")

    def test_curator_pagination_uses_only_recommended_cards_and_no_account_data(self):
        first = {"success": 1, "start": "0", "pagesize": "2", "total_count": 3,
                 "results_html": '<a data-ds-appid="999">Unrelated</a>' + self.curator_card("526870") + self.curator_card("20", False)}
        second = {"success": 1, "start": "2", "pagesize": "2", "total_count": 3,
                  "results_html": self.curator_card("30")}
        with patch.object(self.plugin, "_open_request", side_effect=[io.StringIO(json.dumps(first)), io.StringIO(json.dumps(second))]) as request:
            self.assertEqual(self.plugin._fetch_hungarian_curator_catalog(), {"526870", "30"})
        self.assertIn("start=2", request.call_args_list[1].args[0].full_url)
        self.assertNotIn("Cookie", dict(request.call_args.args[0].header_items()))

    def test_curator_incomplete_page_is_rejected(self):
        data = {"success": 1, "start": 0, "pagesize": 2, "total_count": 2,
                "results_html": self.curator_card("526870")}
        with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(data))):
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                self.plugin._fetch_hungarian_curator_catalog()

    async def test_curator_matches_whole_library_even_with_old_negative_or_missing_steam_cache(self):
        self.plugin._hungarian_curator_app_ids = {"526870", "999"}
        self.plugin._cache["526870"] = {"schema_version": self.cache_schema_version,
                                        "checked_at": time.time(), "hungarian": False, "controller_support_level": "full"}
        with patch.object(self.plugin, "_fetch_support") as fetch:
            library = await self.plugin.get_hungarian_library_cache(["526870", "999", "10"])
            tile = await self.plugin.get_controller_support(["526870"])
        fetch.assert_not_called()
        self.assertEqual(library["hungarian"], {"526870": True, "999": True})
        self.assertEqual(tile["hungarian"], {"526870": True})
        self.assertEqual(tile["hungarian_sources"], {"526870": "curator"})

    async def test_curator_success_persists_and_failure_retains_previous_catalog(self):
        with patch.object(self.plugin, "_fetch_hungarian_curator_catalog", return_value={"526870"}):
            await self.plugin._refresh_hungarian_curator()
        reloaded = self.plugin_type()
        await reloaded._load_hungarian_curator_cache()
        self.assertEqual(reloaded._hungarian_curator_app_ids, {"526870"})
        checked_at = self.plugin._hungarian_curator_checked_at
        with patch.object(self.plugin, "_fetch_hungarian_curator_catalog", side_effect=ValueError("incomplete catalog")):
            await self.plugin._refresh_hungarian_curator()
        self.assertEqual(self.plugin._hungarian_curator_app_ids, {"526870"})
        self.assertEqual(self.plugin._hungarian_curator_checked_at, checked_at)

    def test_source_priority_and_missing_curator_does_not_claim_combined_negative(self):
        self.plugin._hungarian_curator_app_ids = {"10", "20"}
        self.plugin._hungarian_curator_checked_at = 0
        result = self.plugin._merge_hungarian_sources(["10", "20", "30"], {"10": True, "20": False, "30": False})
        self.assertEqual(result["hungarian"], {"10": True, "20": True, "30": None})
        self.assertEqual(result["hungarian_sources"], {"10": "steam", "20": "curator", "30": None})

    async def test_curator_refresh_is_single_flight_and_does_not_block_library_response(self):
        self.plugin._hungarian_curator_checked_at = 0
        release = asyncio.Event()

        async def held_refresh():
            await release.wait()

        with patch.object(self.plugin, "_refresh_hungarian_curator", side_effect=held_refresh) as refresh:
            first = await self.plugin.get_hungarian_library_cache(["526870"])
            second = await self.plugin.get_hungarian_library_cache(["526870"])
            self.assertEqual(first["curator_status"], "loading")
            self.assertEqual(second["curator_status"], "loading")
            refresh.assert_called_once()
            await self.plugin._stop_hungarian_curator_refresh()
        self.assertIsNone(self.plugin._hungarian_curator_task)


if __name__ == "__main__":
    unittest.main()
