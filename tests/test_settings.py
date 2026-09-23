import ast
import asyncio
import builtins
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
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class SettingsTest(unittest.IsolatedAsyncioTestCase):
    def test_aks_requests_have_a_shared_five_second_gap(self):
        class Response(io.BytesIO):
            def geturl(self):
                return "https://www.allkeyshop.com/blog/"
        with patch.object(self.plugin, "_open_request", side_effect=lambda *args, **kwargs: Response(b"{}")) as fetch, patch("time.monotonic", return_value=100.0), patch("time.sleep") as sleep:
            self.plugin._aks_read("https://www.allkeyshop.com/blog/?search=one")
            self.plugin._aks_read("https://www.allkeyshop.com/blog/?search=two")
        self.assertEqual(fetch.call_count, 2)
        sleep.assert_called_once_with(5.0)

    async def test_aks_prices_are_cached_for_thirty_minutes(self):
        data = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/",
                "data": self.aks_fixture(), "checked_at": time.time() - 1200}
        self.plugin._price_cache["10"] = data
        with patch.object(self.plugin, "_fetch_aks_game", return_value={**data, "checked_at": time.time()}) as fetch:
            await self.plugin.get_allkeyshop_price("10")
            fetch.assert_not_called()
            self.plugin._price_cache["10"]["checked_at"] = time.time() - 1801
            await self.plugin.get_allkeyshop_price("10")
            self.assertEqual(fetch.call_count, 1)

    async def test_unreleased_and_unknown_release_never_query_allkeyshop(self):
        for app_id, release in (("10", {"coming_soon": True}), ("20", {}), ("30", None)):
            body = {app_id: {"success": True, "data": {"name": "Future game", "release_date": release}}}
            with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(body))) as steam, patch.object(self.plugin, "_aks_read") as aks:
                response = await self.plugin.get_allkeyshop_price(app_id)
                cached = await self.plugin.get_allkeyshop_price(app_id)
            self.assertTrue(response["success"])
            self.assertIn(response["skipped"], ("unreleased", "release_unknown"))
            self.assertEqual(cached["skipped"], response["skipped"])
            self.assertEqual(steam.call_count, 1)
            aks.assert_not_called()

    async def test_free_game_never_queries_allkeyshop_and_is_cached(self):
        body = {"10": {"success": True, "data": {"name": "Free game", "is_free": True,
                "release_date": {"coming_soon": False}}}}
        with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(body))) as steam, patch.object(self.plugin, "_aks_read") as aks:
            response = await self.plugin.get_allkeyshop_price("10")
            cached = await self.plugin.get_allkeyshop_price("10")
        self.assertTrue(response["success"])
        self.assertEqual(response["skipped"], "free")
        self.assertEqual(response["offers"], [])
        self.assertEqual(cached, response)
        self.assertEqual(steam.call_count, 1)
        aks.assert_not_called()

    def test_released_game_still_queries_allkeyshop(self):
        body = {"10": {"success": True, "data": {"name": "Released game", "release_date": {"coming_soon": False}}}}
        with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(body))), patch.object(self.plugin, "_aks_read", side_effect=OSError("test stop")) as aks:
            with self.assertRaises(OSError):
                self.plugin._fetch_aks_game("10")
        self.assertEqual(aks.call_count, 1)

    async def test_aks_connection_failure_is_shared_and_recovers(self):
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=urllib.error.URLError(TimeoutError("timed out"))) as fetch:
            first = await self.plugin.get_allkeyshop_price("10")
            second = await self.plugin.get_allkeyshop_price("20")
        self.assertEqual(fetch.call_count, 1)
        self.assertTrue(first["global_error"])
        self.assertEqual(first["retry_after"], 60)
        self.assertEqual(second["error_code"], "connection")
        self.assertGreater(second["retry_after"], 0)
        self.plugin._price_service_retry_at = 0
        data = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/",
                "data": self.aks_fixture(), "checked_at": time.time()}
        with patch.object(self.plugin, "_fetch_aks_game", return_value=data):
            recovered = await self.plugin.get_allkeyshop_price("20")
        self.assertTrue(recovered["success"])
        self.assertIsNone(self.plugin._price_service_error)
        self.assertEqual(self.plugin._price_service_failures, 0)

    async def test_aks_retry_delay_is_60_120_240_480_960_then_capped_at_1800_seconds(self):
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=OSError("offline")):
            for expected in (60, 120, 240, 480, 960, 1800, 1800):
                self.plugin._price_service_retry_at = 0
                response = await self.plugin.get_allkeyshop_price("10")
                self.assertEqual(response["retry_after"], expected)

    def test_aks_errors_distinguish_matching_http_and_format(self):
        details = self.plugin._aks_error_details(ValueError("Nincs egyértelmű AllKeyShop-találat ehhez a Steam-játékhoz."))
        self.assertFalse(details["global_error"])
        self.assertEqual(details["error_code"], "match")
        details = self.plugin._aks_error_details(urllib.error.HTTPError("https://www.allkeyshop.com/", 429, "slow down", {}, None))
        self.assertEqual(details["error_code"], "rate_limit")
        self.assertTrue(details["global_error"])
        self.assertEqual(self.plugin._aks_error_details(ValueError("changed"))["error_code"], "format")

    async def test_store_sides_and_tile_opt_in_survive_restart(self):
        self.assertFalse((await self.plugin.get_settings())["show_store_tile_prices"])
        sides = {"price": "right", "controller": "left", "proton": "left"}
        self.assertTrue((await self.plugin.set_badge_sides(sides))["success"])
        self.assertTrue((await self.plugin.set_store_tile_prices(True))["success"])
        self.assertFalse((await self.plugin.set_badge_sides({"price": "top"}))["success"])
        self.assertFalse((await self.plugin.set_store_tile_prices(1))["success"])
        restarted = self.plugin_type()
        await restarted._load_settings()
        self.assertEqual((await restarted.get_settings())["store_badge_sides"], sides)
        self.assertTrue((await restarted.get_settings())["show_store_tile_prices"])
        with patch.object(self.plugin, "_save_settings", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                await self.plugin.set_badge_sides({})
        self.assertEqual((await self.plugin.get_settings())["store_badge_sides"], sides)

    async def test_aks_merchant_directory_preserves_selection_and_offline_cache(self):
        page = '<a class="merchant-card " href="/review/eneba" aria-label="Eneba"></a><a class="merchant-card is-official" aria-label="A &amp; B"></a><a aria-label="Not a store"></a>'
        with patch.object(self.plugin, "_aks_read", return_value=page) as fetch:
            directory = await self.plugin.get_price_merchants()
            await self.plugin.get_price_merchants()
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(directory["merchants"], ["A & B", "Eneba"])
        await self.plugin.set_price_preferences(True, True, ["Eneba"], True)
        self.plugin._price_merchants.add("New store")
        self.assertEqual(self.plugin._price_preferences["merchants"], ["Eneba"])
        restarted = self.plugin_type()
        await restarted._load_price_merchants()
        self.assertIn("Eneba", restarted._price_merchants)
        with patch.object(restarted, "_aks_read", side_effect=OSError("offline")):
            offline = await restarted.get_price_merchants(True)
        self.assertIn("Eneba", offline["merchants"])
        self.assertTrue(offline["error"])

    async def test_aks_empty_selection_is_none_and_survives_restart(self):
        await self.plugin.set_price_preferences(True, True, [], True)
        restarted = self.plugin_type()
        await restarted._load_price_preferences()
        self.assertTrue((await restarted.get_price_preferences())["restrict_merchants"])
        self.assertEqual(restarted._aks_filter(self.aks_fixture(), restarted._price_preferences), [])
        # Existing releases' empty list retains its original all-shops meaning.
        self.assertEqual(len(restarted._aks_filter(self.aks_fixture(), {"merchants": [], "allow_gifts": True})), 1)

    @staticmethod
    def aks_fixture():
        return {"merchants": {"1": {"name": "Eneba"}, "2": {"name": "GAMIVO"}},
                "editions": {"1": {"name": "Standard"}, "2": {"name": "Deluxe"}},
                "regions": {"2": {"filter_name": "STEAM GLOBAL"}, "25": {"filter_name": "STEAM GIFT GLOBAL"},
                            "412": {"filter_name": "STEAM ACCOUNT"}, "9": {"filter_name": "STEAM EU"}},
                "prices": [{"account": False, "activationPlatform": "steam", "dispo": 1, "isFirstParty": False,
                            "allowCard": True, "region": "2", "merchant": 1, "edition": "1", "priceCard": 10,
                            "voucher_code": "SAVE"}]}

    def test_aks_filters_exclude_accounts_other_platforms_unknown_types_and_wrong_editions(self):
        data = self.aks_fixture()
        base = data["prices"][0]
        invalid = [{"account": True}, {"account": None}, {"activationPlatform": "epic"}, {"region": "412"},
                   {"region": "unknown"}, {"edition": "2"}, {"dispo": 0}, {"isFirstParty": True},
                   {"priceCard": 0.02}, {"priceCard": float("nan")}, {"priceCard": -1}, {"allowCard": False}]
        data["prices"] += [{**base, **change} for change in invalid]
        data["prices"].append({**base, "region": "25", "priceCard": 8, "merchant": 2})
        result = self.plugin._aks_filter(data, {"merchants": [], "allow_gifts": True})
        self.assertEqual([r["price"] for r in result], [8, 10])
        self.assertIn("Gift", result[0]["kind"])
        self.assertEqual(len(self.plugin._aks_filter(data, {"merchants": [], "allow_gifts": False})), 1)
        self.assertEqual(self.plugin._aks_filter(data, {"merchants": ["ENEBA"], "allow_gifts": True})[0]["price"], 10)
        self.assertEqual(self.plugin._aks_filter(data, {"merchants": ["missing"], "allow_gifts": True}), [])

    def test_aks_requires_unique_exact_pc_title_and_decodes_json_without_execution(self):
        row = '<li data-platforms="pc"><a href="https://www.allkeyshop.com/blog/buy-satisfactory-cd-key-compare-prices/"><h2 class="ls-results-row-game-title">Satisfactory</h2></a></li>'
        self.assertIn('satisfactory', self.plugin._aks_search_match(row, 'Satisfactory™'))
        legacy = row.replace('buy-satisfactory-cd-key-compare-prices', 'compare-and-buy-cd-key-for-digital-download-portal-2').replace('Satisfactory', 'Portal 2')
        self.assertIn('portal-2', self.plugin._aks_search_match(legacy, 'Portal 2'))
        for fragment in (row.replace('Satisfactory</h2>', 'Satisfactory Steam Account</h2>'),
                         row.replace('data-platforms="pc"', 'data-platforms="ps5"'),
                         row + row.replace('buy-satisfactory-cd-key', 'buy-satisfactory-key')):
            with self.assertRaises(ValueError):
                self.plugin._aks_search_match(fragment, 'Satisfactory')
        page = '<script>var gamePageTrans = ' + json.dumps(self.aks_fixture()) + '; throw Error("must not run");</script>'
        self.assertEqual(self.plugin._aks_parse(page)["prices"][0]["priceCard"], 10)
        with self.assertRaises(ValueError):
            self.plugin._aks_parse('<html>temporary error</html>')

    async def test_aks_preferences_persist_and_cached_offers_refilter_without_network(self):
        data = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-key/",
                "data": self.aks_fixture(), "checked_at": time.time()}
        with patch.object(self.plugin, "_fetch_aks_game", return_value=data) as fetch:
            first, duplicate = await asyncio.gather(self.plugin.get_allkeyshop_price('10'), self.plugin.get_allkeyshop_price('10'))
            self.assertEqual(first["offers"], duplicate["offers"])
            await self.plugin.set_price_preferences(True, False, ["GAMIVO"])
            filtered = await self.plugin.get_allkeyshop_price('10')
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(filtered["offers"], [])
        restarted = self.plugin_type()
        await restarted._load_price_preferences()
        self.assertEqual(restarted._price_preferences["merchants"], ["GAMIVO"])
        await self.plugin.set_price_preferences(False, True, [])
        with patch.object(self.plugin, "_fetch_aks_game") as fetch:
            self.assertTrue((await self.plugin.get_allkeyshop_price('20'))["disabled"])
        fetch.assert_not_called()

    async def test_aks_failure_backoff_does_not_return_an_unfiltered_price(self):
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=ValueError("changed schema")) as fetch:
            first = await self.plugin.get_allkeyshop_price('10')
            second = await self.plugin.get_allkeyshop_price('10')
        self.assertFalse(first["success"])
        self.assertFalse(second["success"])
        self.assertNotIn("offers", first)
        self.assertEqual(fetch.call_count, 1)

    async def test_wake_refreshes_all_watched_controllers_even_with_fresh_cache(self):
        self.prepare_boosteroid_watch()
        self.plugin._watchlist = {str(i): {"app_id": str(i), "title": str(i), "added_at": time.time(),
            "watch_gfn": False, "watch_boosteroid": False, "watch_controller": True} for i in range(12)}
        for key in self.plugin._watchlist:
            self.plugin._cache[key] = {"schema_version": self.cache_schema_version, "checked_at": time.time(),
                "controller_support_level": "none", "hungarian": False}
        await self.plugin.get_notification_events([])
        with patch.object(self.plugin, "_fetch_support", return_value={"controller_support_level": "full", "hungarian": False}) as fetch:
            first = await self.plugin.get_notification_events([], {}, True)
            self.assertEqual(first["controller_pending"], 4)
            second = await self.plugin.get_notification_events([])
            self.assertEqual(second["controller_pending"], 0)
            self.assertEqual(fetch.call_count, 12)
        self.assertEqual(len(first["controller_improved_app_ids"] + second["controller_improved_app_ids"]), 12)

    async def test_controller_watch_notifies_improvements_once_and_keeps_baseline_on_failure(self):
        self.prepare_boosteroid_watch()
        self.plugin._watchlist["4126040"]["watch_controller"] = True
        def details(level):
            return {"controller_support_level": level, "hungarian": False}
        with patch.object(self.plugin, "_fetch_support", return_value=details("none")):
            first = await self.plugin.get_notification_events([])
        self.assertEqual(first["controller_improved_app_ids"], [])
        self.plugin._cache["4126040"]["checked_at"] -= 86401
        with patch.object(self.plugin, "_fetch_support", return_value=None):
            failed = await self.plugin.get_notification_events([])
        self.assertEqual(failed["controller_improved_app_ids"], [])
        self.assertEqual(self.plugin._read_notification_state()["controller_levels"]["4126040"], "none")
        self.plugin._steam_retry.clear()
        for level in ("partial", "full"):
            self.plugin._cache["4126040"]["checked_at"] -= 86401
            with patch.object(self.plugin, "_fetch_support", return_value=details(level)) as fetch:
                result = await self.plugin.get_notification_events([])
                repeated = await self.plugin.get_notification_events([])
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(result["controller_improved_app_ids"], ["4126040"])
            self.assertEqual(repeated["controller_improved_app_ids"], [])
        history = await self.plugin.get_notification_history()
        self.assertEqual([entry["event_type"] for entry in history["entries"] if entry["platform"] == "controller"], ["full", "partial"])

    async def test_controller_only_watch_persists_and_reenable_resets_baseline(self):
        self.prepare_boosteroid_watch()
        result = await self.plugin.set_watchlist_platforms("4126040", False, False, True)
        self.assertTrue(result["success"])
        restarted = self.plugin_type()
        await restarted._load_watchlist()
        self.assertTrue(restarted._watchlist["4126040"]["watch_controller"])
        self.assertFalse(restarted._watchlist["4126040"]["watch_gfn"])
        with patch.object(self.plugin, "_fetch_support", return_value={"controller_support_level": "none", "hungarian": False}):
            await self.plugin.get_notification_events([])
        await self.plugin.set_watchlist_platforms("4126040", True, False, False)
        self.plugin._cache["4126040"]["controller_support_level"] = "full"
        await self.plugin.set_watchlist_platforms("4126040", False, False, True)
        result = await self.plugin.get_notification_events([])
        self.assertEqual(result["controller_improved_app_ids"], [])
        invalid = await self.plugin.set_watchlist_platforms("4126040", False, False, False)
        self.assertFalse(invalid["success"])

    async def test_controller_queue_bounds_work_and_skips_backoff_games(self):
        watchlist = {str(i): {"watch_controller": True} for i in range(20)}
        self.plugin._steam_retry["0"] = {"attempted_at": time.time(), "retry_at": time.time() + 900}
        with patch.object(self.plugin, "_fetch_support", return_value={"controller_support_level": "full", "hungarian": False}) as fetch:
            levels = await self.plugin._watched_controller_levels(watchlist)
        self.assertEqual(fetch.call_count, 8)
        self.assertNotIn("0", levels)
        self.assertEqual(len(levels), 8)

    async def test_catalog_loss_requires_two_spaced_successes_and_survives_restart(self):
        for provider in ("gfn", "boosteroid"):
            setattr(self.plugin, "_" + provider + "_app_ids", {"1", "2"})
            await self.plugin._accept_catalog(provider, {"2"})
            self.assertIn("1", getattr(self.plugin, "_" + provider + "_app_ids"))
            await self.plugin._accept_catalog(provider, {"2"})
            self.assertIn("1", getattr(self.plugin, "_" + provider + "_app_ids"))
            restarted = self.plugin_type()
            await getattr(restarted, "_load_" + provider + "_cache")()
            self.assertIn("1", restarted._catalog_pending[provider])
            restarted._catalog_pending[provider]["1"] -= 901
            await restarted._accept_catalog(provider, {"2"})
            self.assertNotIn("1", getattr(restarted, "_" + provider + "_app_ids"))

    async def test_bulk_loss_and_disk_failure_leave_last_good_catalog_untouched(self):
        await self.plugin._accept_catalog("gfn", {str(i) for i in range(100)})
        checked = self.plugin._gfn_checked_at
        with patch.object(self.plugin, "_fetch_gfn_catalog", return_value={"1"}):
            await self.plugin._ensure_gfn_catalog(force=True)
        self.assertEqual(len(self.plugin._gfn_app_ids), 100)
        self.assertEqual(self.plugin._gfn_checked_at, checked)
        self.assertTrue((await self.plugin.get_catalog_status())["gfn"]["stale"])
        with patch.object(self.plugin, "_write_file_atomically", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                await self.plugin._accept_catalog("gfn", self.plugin._gfn_app_ids | {"100"})
        self.assertNotIn("100", self.plugin._gfn_app_ids)
        self.assertEqual(self.plugin._gfn_checked_at, checked)

    async def test_reappearance_clears_pending_and_maintenance_is_not_removal(self):
        await self.plugin._accept_catalog("boosteroid", {"1", "2"}, {"1"})
        await self.plugin._accept_catalog("boosteroid", {"2"})
        self.assertIn("1", self.plugin._boosteroid_maintenance_app_ids)
        await self.plugin._accept_catalog("boosteroid", {"1", "2"})
        self.assertFalse(self.plugin._catalog_pending["boosteroid"])
        self.assertFalse(self.plugin._boosteroid_maintenance_app_ids)

    async def test_shared_steam_queue_deduplicates_callers_and_limits_four_requests(self):
        release = asyncio.Event()
        active = 0
        maximum = 0
        seen = []
        original = self.plugin._run_blocking
        async def blocking(function, *args):
            nonlocal active, maximum
            if function == self.plugin._fetch_support:
                seen.append(args[0])
                active += 1
                maximum = max(maximum, active)
                await release.wait()
                active -= 1
                return {"controller_support_level": "full", "hungarian": True}
            return await original(function, *args)
        with patch.object(self.plugin, "_run_blocking", side_effect=blocking):
            callers = [asyncio.create_task(self.plugin._get_support_shared(str(i))) for i in range(12)]
            callers += [asyncio.create_task(self.plugin._get_support_shared("0")) for _ in range(3)]
            for _ in range(20):
                await asyncio.sleep(0)
            self.assertEqual(len(seen), 4)
            callers[-1].cancel()
            release.set()
            await asyncio.gather(*callers, return_exceptions=True)
        self.assertEqual(maximum, 4)
        self.assertEqual(len(seen), 12)
        self.assertEqual(len(set(seen)), 12)
        self.assertFalse(self.plugin._steam_tasks)
        restarted = self.plugin_type()
        await restarted._load_cache()
        self.assertEqual(len(restarted._cache), 12)

    async def test_failed_scan_and_backoff_survive_restart_without_new_http(self):
        error = urllib.error.HTTPError("https://store.steampowered.com", 429, "slow", {}, None)
        with patch.object(self.plugin, "_open_request", side_effect=error):
            await self.plugin.get_controller_support(["10"])
        restarted = self.plugin_type()
        restarted._hungarian_curator_checked_at = time.time()
        await restarted._load_steam_scan_state()
        self.assertEqual(restarted._steam_scan_epoch, self.plugin._steam_scan_epoch)
        with patch.object(restarted, "_open_request") as request:
            cached = await restarted.get_hungarian_library_cache(["10"])
            await restarted.get_controller_support(["10", "20"])
        request.assert_not_called()
        self.assertIn("10", cached["scan_attempts"])
        self.assertGreater(cached["scan_retry_after"]["10"], time.time())
        restarted._steam_backoff_until = 0
        with patch.object(restarted, "_open_request", side_effect=error):
            result = await restarted.get_controller_support(["20"])
        self.assertGreaterEqual(result["retry_after"], 119)

    def test_gfn_partial_or_repeated_pages_are_rejected(self):
        game = {"variants": [{"appStore": "STEAM", "storeId": "10"}]}
        page = {"data": {"apps": {"items": [game], "numberReturned": 2,
                "pageInfo": {"hasNextPage": False, "endCursor": "x"}}}}
        with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(page))):
            with self.assertRaises(ValueError):
                self.plugin._fetch_gfn_catalog()
        page["data"]["apps"].update(numberReturned=1, pageInfo={"hasNextPage": True, "endCursor": "x"})
        with patch.object(self.plugin, "_open_request", side_effect=lambda *a, **k: io.StringIO(json.dumps(page))):
            with self.assertRaises(ValueError):
                self.plugin._fetch_gfn_catalog()

    def test_boosteroid_truncated_and_duplicate_pages_are_rejected(self):
        page = {"meta": {"current_page": 1, "last_page": 1, "total": 2, "per_page": 100},
                "data": [{"id": 1, "stores": {"steam": "https://store.steampowered.com/app/10"}}]}
        for duplicate in (False, True):
            if duplicate:
                page["data"] *= 2
            with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(page))):
                with self.assertRaises(ValueError):
                    self.plugin._fetch_boosteroid_catalog()

    async def test_steam_rate_limit_honors_retry_after_and_stops_new_http_requests(self):
        error = urllib.error.HTTPError("https://store.steampowered.com/api/appdetails", 429, "rate limit", {"Retry-After": "120"}, None)
        with patch.object(self.plugin, "_open_request", side_effect=error) as request:
            result = await self.plugin.get_controller_support(["10"])
            blocked = await self.plugin.get_controller_support(["20"])
        self.assertEqual(request.call_count, 1)
        self.assertGreaterEqual(result["retry_after"], 119)
        self.assertGreaterEqual(blocked["retry_after"], 119)
        self.assertIn("10", result["unavailable"])
        self.plugin._steam_backoff_until = 0
        payload = {"20": {"success": True, "data": {"supported_languages": "Hungarian", "categories": []}}}
        with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(payload))):
            recovered = await self.plugin.get_controller_support(["20"])
        self.assertTrue(recovered["hungarian"]["20"])
        self.assertEqual(recovered["retry_after"], 0)

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

    def prepare_boosteroid_watch(self):
        self.plugin._gfn_app_ids = {"1"}
        self.plugin._gfn_checked_at = time.time()
        self.plugin._boosteroid_app_ids = {"1"}
        self.plugin._boosteroid_checked_at = time.time()
        self.plugin._watchlist = {"4126040": {"app_id": "4126040", "title": "Aniimo",
            "added_at": time.time(), "watch_gfn": False, "watch_boosteroid": True}}

    async def test_boosteroid_new_game_updates_watchlist_badge_and_notifies_once(self):
        self.prepare_boosteroid_watch()
        await self.plugin.get_notification_events([])
        self.assertEqual((await self.plugin.get_watchlist())["entries"][0]["boosteroid"], "not_available")
        self.plugin._boosteroid_checked_at = time.time() - 901
        with patch.object(self.plugin, "_fetch_boosteroid_catalog", return_value=({"1", "4126040"}, set())) as fetch:
            watch = await self.plugin.get_watchlist()
            badge = await self.plugin.get_boosteroid_availability(["4126040"])
            events = await self.plugin.get_notification_events([])
            repeated = await self.plugin.get_notification_events([])
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(watch["entries"][0]["boosteroid"], "available")
        self.assertTrue(badge["availability"]["4126040"])
        self.assertEqual(events["boosteroid_added_app_ids"], ["4126040"])
        self.assertEqual(repeated["boosteroid_added_app_ids"], [])

    async def test_manual_boosteroid_refresh_bypasses_fresh_cache_without_erasing_notification_baseline(self):
        self.prepare_boosteroid_watch()
        await self.plugin.get_notification_events([])
        with patch.object(self.plugin, "_fetch_boosteroid_catalog", return_value=({"4126040"}, set())) as fetch, \
                patch.object(self.plugin, "_fetch_gfn_catalog", return_value={"1"}):
            result = await self.plugin.refresh_cloud_catalogs()
        self.assertTrue(result["success"])
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual((await self.plugin.get_notification_events([]))["boosteroid_added_app_ids"], ["4126040"])

    async def test_wake_refresh_fetches_both_fresh_catalogs_and_keeps_timestamps_separate(self):
        self.prepare_boosteroid_watch()
        with patch.object(self.plugin, "_fetch_gfn_catalog", return_value={"10"}) as gfn, \
                patch.object(self.plugin, "_fetch_boosteroid_catalog", return_value=({"4126040"}, set())) as boosteroid:
            result = await self.plugin.refresh_cloud_catalogs()
        self.assertTrue(result["success"])
        self.assertEqual(gfn.call_count, 1)
        self.assertEqual(boosteroid.call_count, 1)
        self.plugin._gfn_checked_at = time.time() - 100
        gfn_result = await self.plugin.get_gfn_availability(["10"])
        boosteroid_result = await self.plugin.get_boosteroid_availability(["4126040"])
        self.assertEqual(gfn_result["checked_at"], self.plugin._gfn_checked_at)
        self.assertEqual(gfn_result["cached_for_hours"], 24)
        self.assertEqual(boosteroid_result["cached_for_hours"], 0.25)

    async def test_failed_boosteroid_refresh_does_not_present_old_negative_as_current_or_erase_baseline(self):
        self.prepare_boosteroid_watch()
        self.plugin._boosteroid_app_ids.add("4126040")
        await self.plugin.get_notification_events([])
        self.plugin._boosteroid_app_ids = {"1"}
        self.plugin._boosteroid_checked_at = time.time() - 901
        with patch.object(self.plugin, "_fetch_boosteroid_catalog", side_effect=OSError("offline")) as fetch:
            badge = await self.plugin.get_boosteroid_availability(["4126040"])
            watch = await self.plugin.get_watchlist()
            await self.plugin.get_notification_events([])
        self.assertEqual(fetch.call_count, 1)
        self.assertIsNone(badge["availability"]["4126040"])
        self.assertEqual(watch["entries"][0]["boosteroid"], "unavailable")
        self.assertIn("4126040", self.plugin._read_notification_state()["boosteroid_available"])

    def test_aniimo_official_boosteroid_record_maps_to_steam_without_title_guess(self):
        payload = {"meta": {"current_page": 1, "last_page": 1, "total": 1, "per_page": 100}, "data": [
            {"id": 3144, "name": "Aniimo", "platform": [6], "applicationLink": None,
             "maintenance": False, "stores": {"steam": "https://store.steampowered.com/app/4126040"}}]}
        with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(payload))), \
                patch.object(self.plugin, "_resolve_steam_app_id_by_name", side_effect=AssertionError("must use official ID")):
            ids, maintenance = self.plugin._fetch_boosteroid_catalog()
        self.assertEqual(ids, {"4126040"})
        self.assertEqual(maintenance, set())

    async def test_independent_badge_sizes_persist_and_reject_invalid_values(self):
        self.assertEqual((await self.plugin.get_settings())["store_badge_percent"], 100)
        result = await self.plugin.set_badge_sizes(85, 175)
        self.assertTrue(result["success"])
        reloaded = self.plugin_type()
        await reloaded._load_settings()
        settings = await reloaded.get_settings()
        self.assertEqual(settings["library_badge_percent"], 85)
        self.assertEqual(settings["store_badge_percent"], 175)
        for invalid in (True, None, "150", 49, 201, 150.5):
            self.assertFalse((await self.plugin.set_badge_sizes(100, invalid))["success"])
        self.assertEqual((await self.plugin.get_settings())["library_badge_percent"], 85)

    async def test_curator_progress_is_memory_only_even_while_fetch_is_blocked(self):
        self.plugin._hungarian_curator_checked_at = 0
        self.plugin._hungarian_curator_progress = {"checked": 100, "total": 775}
        blocked = asyncio.Event()
        self.plugin._hungarian_curator_task = asyncio.create_task(blocked.wait())
        with patch.object(self.plugin, "_open_request", side_effect=AssertionError("must not network")):
            result = await asyncio.wait_for(self.plugin.get_hungarian_curator_progress(), timeout=0.2)
        self.assertEqual(result["status"], "loading")
        self.assertEqual(result["checked"], 100)
        self.assertEqual(result["total"], 775)

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

    async def test_backend_starts_without_html_parser_in_decky_frozen_runtime(self):
        original_import = builtins.__import__

        def decky_import(name, *args, **kwargs):
            if name in {"html.parser", "_markupbase"}:
                raise ModuleNotFoundError("Not bundled with Decky: " + name)
            return original_import(name, *args, **kwargs)

        decky = types.ModuleType("decky")
        decky.DECKY_PLUGIN_SETTINGS_DIR = self.directory.name
        decky.logger = logging.getLogger("test")
        with patch.dict(sys.modules, {"decky": decky}), patch("builtins.__import__", side_effect=decky_import):
            spec = importlib.util.spec_from_file_location("frozen_plugin_test", ROOT / "main.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            plugin = module.Plugin()
            await asyncio.wait_for(plugin._main(), timeout=2)
            settings = await asyncio.wait_for(plugin.get_settings(), timeout=1)
            self.assertTrue(settings["success"])
            parser = module.HungarianCuratorParser()
            parser.feed(self.curator_card("526870"))
            parser.close()
            self.assertEqual(parser.records[0]["app_ids"], {"526870"})
            await plugin._unload()

    def test_curator_tokenizer_handles_quotes_entities_comments_and_raw_text(self):
        parser = self.parser_type()
        fake = self.curator_card("999")
        valid = self.curator_card("526870").replace('<div class="recommendation">',
            "<DIV data-note='a > b' CLASS='recommendation'>").replace(
                'curator_clanid=34235089', 'other=1&amp;curator_clanid=34235089')
        parser.feed('<!--' + fake + '--><script>' + fake + '</script><style>' + fake + '</style>')
        parser.feed(valid[:45])
        parser.feed(valid[45:])
        parser.close()
        self.assertEqual(len(parser.records), 1)
        self.assertEqual(parser.records[0]["app_ids"], {"526870"})
        self.assertTrue(parser.records[0]["curator_link"])
        self.assertTrue(parser.records[0]["recommended"])


if __name__ == "__main__":
    unittest.main()



