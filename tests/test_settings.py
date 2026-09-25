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
    async def test_portal_bento_quotes_and_remote_filter_changes(self):
        # Minimal rows from the API response captured on 2026-09-25. Steam's
        # Portal history says 1.95; different shops update on different days.
        row = {"product_id": 118234, "merchant_id": 1, "edition": "1", "region": "2",
               "min_discount_price": 1.95, "start": "2026-03-26 05:31:17", "end": "2026-09-24 01:12:41"}
        payload = {"history": [row], "regions": {"2": {"name": "Steam"}},
                   "merchants": {"1": {"name": "Steam"}, "47": {"name": "Kinguin"}, "272": {"name": "Eneba"}},
                   "editions": {"1": {"name": "Standard Edition"}}}
        prefs = {"merchants": [], "allow_gifts": True}
        counts = {}
        self.assertEqual(self.plugin._aks_history_filter(self.plugin._aks_history_data(payload), prefs, counts), [])
        self.assertEqual(counts["steam"], 1)
        payload["history"] = [{**row, "min_discount_price": 13.99},
            {**row, "product_id": 140380495, "merchant_id": 272, "min_discount_price": 4.37,
             "start": "2026-09-22 17:33:42", "end": "2026-09-22 19:48:06"},
            {**row, "product_id": 138751917, "merchant_id": 47, "last_price": 3.46,
             "min_discount_price": 3.4, "best_discount_code": "AKSPLAY",
             "start": "2026-09-04 12:46:36", "end": "2026-09-04 12:46:36"}]
        entry = {"title": "Bento Blocks", "source": "aks_history", "history_version": 2,
                 "url": "https://www.allkeyshop.com/", "checked_at": time.time(),
                 "data": self.plugin._aks_history_data(payload)}
        await self.plugin.set_price_connection("server", "https://example.com", "test_server_token_1234567890")
        with patch.object(self.plugin, "_price_server_request", return_value={"protocol": 1, "provider": "aks", "app_id": "3311670", "entry": entry}) as network:
            await self.plugin.set_price_preferences(True, True, ["Steam", "Kinguin", "Eneba"], True)
            result = await self.plugin.get_allkeyshop_price("3311670")
            self.assertEqual((result["offers"][0]["merchant"], result["offers"][0]["price"]), ("Kinguin", 3.4))
            self.assertEqual(result["offers"][0]["source_updated_at"], "2026-09-04 12:46:36")
            await self.plugin.set_price_preferences(True, True, ["Eneba"], True)
            result = await self.plugin.get_cached_allkeyshop_price("3311670")
            self.assertEqual((result["offers"][0]["merchant"], result["offers"][0]["price"]), ("Eneba", 4.37))
            await self.plugin.set_price_preferences(True, True, [], True)
            self.assertEqual((await self.plugin.get_cached_allkeyshop_price("3311670"))["offers"], [])
            self.assertEqual(network.call_count, 1)

    async def test_remote_provider_error_is_not_reported_as_server_connection(self):
        await self.plugin.set_price_connection("server", "https://example.com", "test_server_token_1234567890")
        response = {"protocol": 1, "provider": "aks", "app_id": "10", "entry": None, "retry_after": 30,
                    "failure": {"error_code": "format", "error": "Invalid provider format", "global_error": True}}
        with patch.object(self.plugin, "_price_server_request", return_value=response) as network:
            self.assertEqual((await self.plugin.get_allkeyshop_price("10"))["error_code"], "format")
            self.assertEqual((await self.plugin.get_allkeyshop_price("20"))["error_code"], "format")
            self.assertEqual(network.call_count, 1)

    async def test_old_pruned_history_cache_is_invalidated_without_losing_other_caches(self):
        old = {"title": "Example", "url": "https://www.allkeyshop.com/", "source": "aks_history",
               "data": self.plugin._aks_history_data(self.history_fixture()), "checked_at": time.time()}
        self.plugin._price_cache = {"10": old, "20": {**old, "history_version": 2}}
        await self.plugin._save_price_cache()
        restarted = self.plugin_type()
        await restarted._load_price_cache()
        self.assertNotIn("10", restarted._price_cache)
        self.assertIn("20", restarted._price_cache)
        await self.plugin.set_price_connection("server", "https://example.com", "test_server_token_1234567890")
        with patch.object(self.plugin, "_price_server_request", return_value={"protocol": 1, "provider": "aks", "app_id": "30", "entry": old}):
            self.assertEqual((await self.plugin.get_allkeyshop_price("30"))["error_code"], "server_version")

    async def test_global_failure_rotates_wishlist_after_shared_pause(self):
        self.plugin._price_wishlist = ["10", "20"]
        self.plugin._price_wishlist_lease = time.monotonic() + 90
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=[TimeoutError("slow"),
                {"title": "Second", "skipped": "free", "checked_at": time.time()}]) as fetch:
            await self.plugin._price_wishlist_step()
            self.assertFalse(await self.plugin._price_wishlist_step())
            self.plugin._price_service_retry_at = 0
            await self.plugin._price_wishlist_step()
        self.assertEqual([call.args[0] for call in fetch.call_args_list], ["10", "20"])
        self.assertIn("20", self.plugin._price_cache)

    def test_network_diagnostic_identifies_step_elapsed_and_timeout(self):
        with patch.object(self.plugin, "_open_request", side_effect=urllib.error.URLError(TimeoutError("slow"))), patch("time.monotonic", side_effect=[100, 100, 100, 130, 130]):
            try:
                self.plugin._aks_read("https://www.allkeyshop.com/api/price_history_api.php?normalised_name=10")
            except urllib.error.URLError as error:
                details = self.plugin._aks_error_details(error)
        self.assertEqual(details["error_code"], "connection")
        self.assertIn("AKS-áradatok (30.0 mp)", details["error"])
        self.assertIn("Időtúllépés", details["error"])

    async def test_server_retry_after_is_honored_and_missing_game_does_not_pause_others(self):
        error = urllib.error.HTTPError("https://www.allkeyshop.com/", 429, "slow", {"Retry-After": "600"}, None)
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=error) as fetch:
            result = await self.plugin.get_allkeyshop_price("10")
            self.assertEqual(result["retry_after"], 600)
            await self.plugin.get_allkeyshop_price("20")
            self.assertEqual(fetch.call_count, 1)
        self.plugin._price_service_retry_at = 0
        missing = urllib.error.HTTPError("https://www.allkeyshop.com/", 404, "missing", {}, None)
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=missing):
            result = await self.plugin.get_allkeyshop_price("30")
        self.assertFalse(result["global_error"])
        self.assertEqual(self.plugin._price_service_retry_at, 0)

    async def test_price_cache_survives_restart_and_respects_current_merchant_filters(self):
        entry = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/",
                 "data": self.aks_fixture(), "checked_at": time.time()}
        self.plugin._price_cache = {"10": entry, "20": {"title": "Free", "skipped": "free", "checked_at": time.time()},
                                    "30": {"error": "offline", "checked_at": time.time()}}
        await self.plugin._save_price_cache()
        restarted = self.plugin_type()
        await restarted._load_price_cache()
        self.assertEqual(set(restarted._price_cache), {"10", "20"})
        with patch.object(restarted, "_fetch_aks_game") as fetch:
            async with restarted._price_lock:
                cached = await asyncio.wait_for(restarted.get_cached_allkeyshop_price("10"), 1)
            self.assertTrue(cached["success"])
            self.assertFalse(cached["stale"])
            self.assertTrue(cached["offers"])
            restarted._price_preferences.update({"restrict_merchants": True, "merchants": []})
            self.assertEqual((await restarted.get_cached_allkeyshop_price("10"))["offers"], [])
            restarted._price_cache["10"]["checked_at"] -= 86401
            self.assertTrue((await restarted.get_cached_allkeyshop_price("10"))["stale"])
            fetch.assert_not_called()
        self.assertEqual((await restarted.get_price_cache_stats())["price_entries"], 2)
        await restarted.clear_price_cache()
        empty = self.plugin_type()
        await empty._load_price_cache()
        self.assertEqual(empty._price_cache, {})

    async def test_invalid_persistent_price_entries_do_not_load(self):
        self.plugin._price_cache_path.write_text(json.dumps({"version": 1, "entries": {
            "10": {"title": "Bad", "checked_at": time.time(), "url": "https://evil.invalid/", "data": self.aks_fixture()},
            "20": {"title": "Future", "checked_at": time.time() + 10000, "skipped": "free"},
            "oops": {"title": "Bad ID", "checked_at": time.time(), "skipped": "free"}}}), encoding="utf-8")
        await self.plugin._load_price_cache()
        self.assertEqual(self.plugin._price_cache, {})
        self.plugin._price_cache_path.write_text("broken", encoding="utf-8")
        await self.plugin._load_price_cache()
        self.assertEqual(self.plugin._price_cache, {})

    async def test_wishlist_only_refreshes_due_games_and_yields_to_foreground(self):
        self.plugin._price_wishlist = ["10", "20", "30"]
        self.plugin._price_wishlist_lease = time.monotonic() + 90
        self.plugin._price_cache["10"] = {"title": "Free", "skipped": "free", "checked_at": time.time()}
        self.plugin._price_cache["20"] = {"title": "Old", "skipped": "unreleased", "checked_at": time.time() - 86401}
        with patch.object(self.plugin, "_fetch_aks_game", return_value={"title": "Skipped", "skipped": "free", "checked_at": time.time()}) as fetch:
            self.plugin._price_foreground_waiters = 1
            self.assertFalse(await self.plugin._price_wishlist_step())
            fetch.assert_not_called()
            self.plugin._price_foreground_waiters = 0
            self.assertTrue(await self.plugin._price_wishlist_step())
            self.assertEqual(fetch.call_args.args, ("30",))
            self.assertTrue(await self.plugin._price_wishlist_step())
            self.assertEqual(fetch.call_args.args, ("20",))
            self.assertFalse(await self.plugin._price_wishlist_step())
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual((await self.plugin.get_price_cache_stats())["price_wishlist_ready"], 3)
            self.plugin._price_cache.clear()
            self.plugin._price_wishlist_lease = 0
            self.assertFalse(await self.plugin._price_wishlist_step())
            self.plugin._price_wishlist_lease = time.monotonic() + 90
            self.plugin._price_preferences["enabled"] = False
            self.assertFalse(await self.plugin._price_wishlist_step())

    async def test_wishlist_failure_pauses_and_preserves_previous_price(self):
        entry = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/",
                 "data": self.aks_fixture(), "checked_at": time.time() - 86401}
        self.plugin._price_cache["10"] = entry
        self.plugin._price_wishlist = ["10"]
        self.plugin._price_wishlist_lease = time.monotonic() + 90
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=OSError("offline")) as fetch:
            await self.plugin._price_wishlist_step()
            self.assertFalse(await self.plugin._price_wishlist_step())
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(self.plugin._price_cache["10"], entry)
        self.plugin._price_service_retry_at = 0
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=ValueError("Nincs egyértelmű AllKeyShop-találat ehhez a Steam-játékhoz.")):
            await self.plugin._price_wishlist_step()
        self.assertEqual(self.plugin._price_cache["10"], entry)
        self.assertGreater(self.plugin._price_wishlist_retry["10"], time.time())

    async def test_wishlist_account_change_and_stop_replace_pending_ids(self):
        owner = "76561198000000001"
        with patch.object(self.plugin, "_price_wishlist_worker", return_value=None):
            await self.plugin.sync_price_wishlist(owner, ["10", "10", "20"])
            await self.plugin._price_wishlist_task
            self.assertEqual(self.plugin._price_wishlist, ["10", "20"])
            self.plugin._price_wishlist_retry["10"] = time.time() + 1800
            await self.plugin.sync_price_wishlist("76561198000000002", ["30"])
            await self.plugin._price_wishlist_task
            self.assertEqual(self.plugin._price_wishlist, ["30"])
            self.assertEqual(self.plugin._price_wishlist_retry, {})
            await self.plugin.sync_price_wishlist("", [])
            self.assertFalse((await self.plugin.get_price_cache_stats())["price_wishlist_active"])

    async def test_cache_clear_discards_a_price_lookup_already_in_flight(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def blocking(function, *args):
            if function == self.plugin._fetch_aks_game:
                started.set()
                await finish.wait()
                return {"title": "Late", "skipped": "free", "checked_at": time.time()}
            return function(*args)
        with patch.object(self.plugin, "_run_blocking", side_effect=blocking):
            request = asyncio.create_task(self.plugin.get_allkeyshop_price("10"))
            await started.wait()
            await self.plugin.clear_price_cache()
            finish.set()
            response = await request
        self.assertFalse(response["success"])
        self.assertEqual(self.plugin._price_cache, {})

    def test_aks_timeout_does_not_hide_another_thirty_second_attempt(self):
        with patch.object(self.plugin, "_open_request", side_effect=TimeoutError("slow")) as fetch, patch("time.sleep") as sleep:
            with self.assertRaises(TimeoutError):
                self.plugin._aks_read("https://www.allkeyshop.com/api/price_history_api.php")
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(fetch.call_args.kwargs["timeout"], 30)
        sleep.assert_not_called()

    def test_known_aks_product_skips_catalog_but_rechecks_free_status(self):
        body = {"10": {"success": True, "data": {"name": "Example", "is_free": False,
                "release_date": {"coming_soon": False}}}}
        with patch.object(self.plugin, "_open_request", side_effect=lambda *a, **kw: io.StringIO(json.dumps(body))) as steam, patch.object(self.plugin, "_aks_read", side_effect=self.history_response) as aks:
            self.plugin._fetch_aks_game("10")
            self.assertEqual(aks.call_count, 2)
            aks.reset_mock()
            self.plugin._fetch_aks_game("10")
            self.assertEqual(aks.call_count, 1)
            self.assertIn("price_history_api.php?normalised_name=140254", aks.call_args.args[0])
            aks.reset_mock()
            self.plugin._aks_matches["10"]["checked_at"] -= 7 * 86400 + 1
            self.plugin._fetch_aks_game("10")
            self.assertEqual(aks.call_count, 1)  # still-fresh shared catalog needs no network
            aks.reset_mock()
            self.plugin._price_metadata["10"]["checked_at"] -= 86401
            body["10"]["data"]["is_free"] = True
            self.assertEqual(self.plugin._fetch_aks_game("10")["skipped"], "free")
            aks.assert_not_called()
            self.assertEqual(steam.call_count, 2)

    def test_missing_known_aks_product_is_forgotten(self):
        self.plugin._price_metadata["10"] = self.price_metadata()
        self.plugin._aks_matches["10"] = {"title": "Example", "product_id": "140254", "checked_at": time.time()}
        error = urllib.error.HTTPError("https://www.allkeyshop.com/", 404, "missing", {}, None)
        with patch.object(self.plugin, "_aks_read", side_effect=[error, self.history_response("vaks.php"), error]) as aks:
            with self.assertRaises(urllib.error.HTTPError):
                self.plugin._fetch_aks_game("10")
        self.assertNotIn("10", self.plugin._aks_matches)
        self.assertEqual(aks.call_count, 3)

    def test_aks_requests_have_a_shared_one_and_a_half_second_gap(self):
        class Response(io.BytesIO):
            def __init__(self, request):
                super().__init__(b"{}")
                self.url = request.full_url
            def geturl(self):
                return self.url
        with patch.object(self.plugin, "_open_request", side_effect=lambda request, **kwargs: Response(request)) as fetch, patch("time.monotonic", return_value=100.0), patch("time.sleep") as sleep:
            self.plugin._aks_read("https://www.allkeyshop.com/api/price_history_api.php?normalised_name=1")
            self.plugin._aks_read("https://www.allkeyshop.com/api/price_history_api.php?normalised_name=2")
        self.assertEqual(fetch.call_count, 2)
        sleep.assert_called_once_with(1.5)

    async def test_aks_prices_are_cached_for_thirty_minutes(self):
        data = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/",
                "data": self.aks_fixture(), "checked_at": time.time() - 1200}
        self.plugin._price_cache["10"] = data
        with patch.object(self.plugin, "_fetch_aks_game", return_value={**data, "checked_at": time.time()}) as fetch:
            await self.plugin.get_allkeyshop_price("10")
            fetch.assert_not_called()
            self.plugin._price_cache["10"]["checked_at"] = time.time() - 86401
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
        self.assertTrue(5 <= first["retry_after"] <= 10)
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

    async def test_aks_retry_delay_is_equal_jitter_capped_at_300_seconds(self):
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=OSError("offline")):
            for expected_raw in (10, 20, 40, 80, 160, 300, 300):
                self.plugin._price_service_retry_at = 0
                response = await self.plugin.get_allkeyshop_price("10")
                self.assertTrue(expected_raw // 2 <= response["retry_after"] <= expected_raw)

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

    async def test_aks_merchants_use_only_saved_api_names_and_keep_selection(self):
        self.plugin._price_merchants = {"Eneba", "New store"}
        await self.plugin.set_price_preferences(True, True, ["Eneba"], True)
        await self.plugin._save_price_merchants()
        restarted = self.plugin_type()
        await restarted._load_price_merchants()
        with patch.object(restarted, "_aks_read") as network:
            result = await restarted.get_price_merchants(True)
            self.assertEqual(set(result["merchants"]), {"YUPLAY", "GAMESEAL", "GAMIVO", "G2A", "Kinguin", "Eneba", "HRK", "New store"})
            network.assert_not_called()
        self.assertEqual(self.plugin._price_preferences["merchants"], ["Eneba"])
        with patch.object(self.plugin, "_open_request") as network:
            for url in ("https://www.allkeyshop.com/blog/", "https://www.allkeyshop.com/blog/wp-admin/admin-ajax.php"):
                with self.assertRaises(ValueError):
                    self.plugin._aks_read(url)
            network.assert_not_called()

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

    def history_fixture(self):
        return {"history": [False,
            {"product_id": 100, "merchant_id": 1, "region": "2", "edition": "1", "min_discount_price": 10,
             "start": "2026-09-24 09:00:00", "end": "2026-09-24 12:00:00"}],
            "regions": {"2": {"name": "Steam"}, "9": {"name": "Steam EU"}, "row": {"name": "Steam ROW"},
                        "gift": {"name": "Steam Gift EU"}, "giftrow": {"name": "Steam Gift ROW"},
                        "account": {"name": "Steam Account"}, "xbox": {"name": "XBOX EU"}},
            "merchants": {"1": {"name": "Kinguin"}, "2": {"name": "GAMIVO"}},
            "editions": {"1": {"name": "Standard Edition"}, "2": {"name": "Deluxe"}}}

    def history_response(self, url):
        return json.dumps({"status": "success", "games": [{"id": 140254, "name": "Example"}]}
                          if "vaks.php" in url else self.history_fixture())

    def test_history_latest_before_cheapest_with_all_product_filters(self):
        payload = self.history_fixture()
        row = payload["history"][1]
        payload["history"] += [
            {**row, "min_discount_price": 1, "best_discount_code": "OLD", "end": "2026-09-24 10:00:00"},
            {**row, "product_id": 101, "merchant_id": 2, "region": "9", "min_discount_price": 9},
            {**row, "product_id": 102, "region": "row", "min_discount_price": 8},
            {**row, "product_id": 103, "region": "gift", "min_discount_price": 7},
            {**row, "product_id": 104, "region": "giftrow", "min_discount_price": 6},
            {**row, "product_id": 105, "region": "account", "min_discount_price": .5},
            {**row, "product_id": 106, "region": "xbox", "min_discount_price": .5},
            {**row, "product_id": 107, "edition": "2", "min_discount_price": .5},
            {**row, "product_id": 108, "region": "unknown", "min_discount_price": .5},
            {**row, "product_id": 109, "min_discount_price": .5, "start": "2026-07-01 09:00:00", "end": "2026-07-01 12:00:00"}]
        data = self.plugin._aks_history_data(payload)
        prefs = {"merchants": [], "allow_gifts": True}
        offers = self.plugin._aks_history_filter(data, prefs)
        self.assertEqual([x["price"] for x in offers], [.5, 6, 7, 8, 9, 10])
        self.assertEqual(offers[-1]["coupon"], "")  # no coupon inherited from an older row
        prefs.update(allow_gifts=False, merchants=["KINGUIN"])
        self.assertEqual([x["price"] for x in self.plugin._aks_history_filter(data, prefs)], [.5, 8, 10])
        prefs.update(merchants=["GAMIVO"])
        self.assertEqual(self.plugin._aks_history_filter(data, prefs)[0]["price"], 9)
        prefs.update(merchants=[], restrict_merchants=True)
        self.assertEqual(self.plugin._aks_history_filter(data, prefs), [])
        payload["history"].reverse()
        self.assertEqual(self.plugin._aks_history_filter(self.plugin._aks_history_data(payload),
            {"merchants": [], "allow_gifts": True}), offers)

    def test_history_newest_invalid_or_conflicting_price_never_resurrects_old_minimum(self):
        payload = self.history_fixture()
        row = payload["history"][1]
        payload["history"].append({**row, "end": "2026-09-24 13:00:00", "min_discount_price": None})
        self.assertEqual(self.plugin._aks_history_filter(self.plugin._aks_history_data(payload),
            {"merchants": [], "allow_gifts": True}), [])
        payload = self.history_fixture()
        payload["history"].append({**payload["history"][1], "min_discount_price": 3})
        self.assertEqual(self.plugin._aks_history_data(payload)["prices"], [])
        self.assertEqual(self.plugin._aks_history_data({**payload, "history": [False]})["prices"], [])
        # Live AKS responses use empty arrays for maps when a product has no history.
        empty = {"history": [], "merchants": [], "regions": [], "editions": []}
        self.assertEqual(self.plugin._aks_history_data(empty),
                         {"prices": [], "merchants": {}, "regions": {}, "editions": {}})
        with self.assertRaises(ValueError):
            self.plugin._aks_history_data({**empty, "history": payload["history"]})
        for value in ({"history": []}, {**payload, "history": [{}]}, {**payload, "history": "broken"}):
            with self.assertRaises(ValueError):
                self.plugin._aks_history_data(value)

    def test_price_metadata_identifies_inner_appid_without_accepting_other_games(self):
        data = {"name": "Blue Prince", "steam_appid": 1569580, "is_free": False, "release_date": {"coming_soon": False}}
        payload = {"3711820": {"success": True, "data": data}}
        with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(payload))):
            result = self.plugin._fetch_price_metadata("1569580")
        self.assertEqual(result["title"], "Blue Prince")
        self.assertEqual(result["app_id"], "1569580")
        for invalid in ({"999": {"success": True, "data": {**data, "steam_appid": 999}}},
                        {"1569580": {"success": True, "data": {**data, "steam_appid": 999}}},
                        {"1": payload["3711820"], "2": payload["3711820"]}):
            self.plugin._price_metadata.clear()
            with patch.object(self.plugin, "_open_request", return_value=io.StringIO(json.dumps(invalid))):
                with self.assertRaises(ValueError) as caught:
                    self.plugin._fetch_price_metadata("1569580")
            self.assertFalse(self.plugin._aks_error_details(caught.exception)["global_error"])

    async def test_missing_catalog_game_is_cached_without_pausing_other_games(self):
        self.plugin._price_metadata["10"] = self.price_metadata(title="Not in API")
        self.plugin._price_metadata["20"] = self.price_metadata("20")
        with patch.object(self.plugin, "_aks_read", side_effect=self.history_response) as network:
            result = await self.plugin.get_allkeyshop_price("10")
            self.assertTrue(result["success"])
            self.assertTrue(result["not_found"])
            self.assertEqual(result["match_status"], "missing")
            await self.plugin.get_allkeyshop_price("10")
            self.assertEqual(network.call_count, 1)
            found = await self.plugin.get_allkeyshop_price("20")
            self.assertTrue(found["success"])
            self.assertFalse(found["not_found"])
            self.assertEqual(network.call_count, 2)
        await self.plugin._price_save_task
        restarted = self.plugin_type()
        await restarted._load_price_cache()
        self.assertTrue((await restarted.get_cached_allkeyshop_price("10"))["not_found"])

    def test_wardogs_early_access_base_game_retains_merchant_gift_and_region_filters(self):
        payload = self.history_fixture()
        payload["editions"] = {"5": {"name": "Early Access"}, "supporter": {"name": "Supporter Edition"}}
        payload["regions"]["28"] = {"name": "STEAM EU/US"}
        row = {**payload["history"][1], "edition": "5", "min_discount_price": 33.09}
        payload["history"] = [row,
            {**row, "product_id": 101, "merchant_id": 2, "min_discount_price": 32.56, "region": "28"},
            {**row, "product_id": 102, "edition": "supporter", "min_discount_price": 1},
            {**row, "product_id": 103, "region": "gift", "min_discount_price": 30},
            {**row, "product_id": 104, "region": "account", "min_discount_price": 2}]
        data = self.plugin._aks_history_data(payload)
        prefs = {"merchants": ["GAMIVO", "Kinguin"], "restrict_merchants": True, "allow_gifts": False}
        offers = self.plugin._aks_history_filter(data, prefs)
        self.assertEqual([o["price"] for o in offers], [32.56, 33.09])
        self.assertEqual(offers[0]["edition"], "Early Access")
        self.assertEqual(offers[0]["kind"], "Steam-kulcs · EU/US")
        prefs["merchants"] = ["Kinguin"]
        self.assertEqual(self.plugin._aks_history_filter(data, prefs)[0]["price"], 33.09)
        prefs["allow_gifts"] = True
        self.assertEqual(self.plugin._aks_history_filter(data, prefs)[0]["price"], 30)
        prefs["merchants"] = []
        counts = {}
        self.assertEqual(self.plugin._aks_history_filter(data, prefs, counts), [])
        self.assertEqual(counts, {"total": 5, "accepted": 0, "edition": 1, "region": 1,
                                  "merchant": 3, "gift": 0, "price": 0, "invalid": 0, "steam": 0})

    def price_metadata(self, app_id="10", title="Example"):
        return {"app_id": app_id, "title": title, "is_free": False, "coming_soon": False, "checked_at": time.time()}

    def price_page(self, title="Example"):
        return '<h1><span data-itemprop="name">' + title + '</span></h1>"currency":"eur"; var gamePageTrans = ' + json.dumps(self.aks_fixture())

    def test_catalog_trademarks_accounts_editions_and_ambiguity(self):
        self.plugin._price_metadata["10"] = self.price_metadata(title="Solarpunk™")
        catalog = {"status": "success", "games": [{"id": 140254, "name": "Solarpunk"},
            {"id": 2, "name": "Solarpunk Steam Account"}, {"id": 3, "name": "Solarpunk PS5"}]}
        with patch.object(self.plugin, "_aks_read", side_effect=[json.dumps(catalog), json.dumps(self.history_fixture())]) as fetch:
            result = self.plugin._fetch_aks_game("10")
        self.assertEqual(result["title"], "Solarpunk™")
        self.assertIn("normalised_name=140254", fetch.call_args.args[0])
        self.assertEqual(fetch.call_count, 2)
        for games in ([{"id": 2, "name": "Solarpunk Steam Account"}],
                      [{"id": 1, "name": "Solarpunk"}, {"id": 2, "name": "Solarpunk®"}]):
            with patch.object(self.plugin, "_aks_read", return_value=json.dumps({"status": "success", "games": games})):
                index = self.plugin._load_aks_catalog(force=True)
            self.assertFalse(index.get(self.plugin._aks_title("Solarpunk™")))

    async def test_day_price_cache_serves_twenty_three_hours_then_refreshes(self):
        self.plugin._price_cache["10"] = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/",
            "data": self.aks_fixture(), "checked_at": time.time() - 23 * 3600}
        with patch.object(self.plugin, "_fetch_aks_game", return_value={"title": "Free", "skipped": "free", "checked_at": time.time()}) as fetch:
            self.assertFalse((await self.plugin.get_cached_allkeyshop_price("10"))["stale"])
            self.assertTrue((await self.plugin.get_allkeyshop_price("10"))["success"])
            self.assertEqual(self.plugin._price_stats()["price_fresh_entries"], 1)
            fetch.assert_not_called()
            self.plugin._price_cache["10"]["checked_at"] = time.time() - 86401
            self.assertTrue((await self.plugin.get_cached_allkeyshop_price("10"))["stale"])
            self.assertTrue((await self.plugin.get_allkeyshop_price("10"))["success"])
            fetch.assert_called_once()

    async def test_three_price_cache_layers_survive_restart_and_skip_known_http_steps(self):
        self.plugin._price_metadata["10"] = self.price_metadata()
        self.plugin._aks_matches["10"] = {"title": "Example", "product_id": "140254", "checked_at": time.time() - 2 * 86400}
        await self.plugin._save_price_cache()
        restarted = self.plugin_type()
        await restarted._load_price_cache()
        with patch.object(restarted, "_open_request") as steam, patch.object(restarted, "_aks_read", side_effect=self.history_response) as aks:
            result = await restarted.get_allkeyshop_price("10")
            self.assertTrue(result["success"])
            self.assertEqual(result["source"], "aks_history")
            steam.assert_not_called()
            self.assertEqual(aks.call_count, 1)
            self.assertIn("normalised_name=140254", aks.call_args.args[0])
            async with restarted._price_lock:
                cached = await asyncio.wait_for(restarted.get_allkeyshop_price("10"), 0.2)
            self.assertEqual(cached, result)
            self.assertEqual(aks.call_count, 1)
        await restarted._price_save_task
        again = self.plugin_type()
        await again._load_price_cache()
        again._price_preferences.update(merchants=["Kinguin"], restrict_merchants=True)
        with patch.object(again, "_aks_read") as network:
            cached = await again.get_cached_allkeyshop_price("10")
            self.assertEqual(cached["offers"][0]["merchant"], "Kinguin")
            self.assertEqual(cached["offers"][0]["source_updated_at"], "2026-09-24 12:00:00")
            network.assert_not_called()

    async def test_invalidated_match_is_not_resurrected_from_stale_price_after_restart(self):
        self.plugin._price_cache["10"] = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-old-cd-key-compare-prices/",
            "data": self.aks_fixture(), "checked_at": time.time() - 86401}
        self.plugin._aks_matches.clear()
        await self.plugin._save_price_cache()
        restarted = self.plugin_type()
        await restarted._load_price_cache()
        self.assertIn("10", restarted._price_cache)
        self.assertNotIn("10", restarted._aks_matches)

    def test_cached_wrong_title_or_missing_product_resolves_again_once(self):
        self.plugin._price_metadata["10"] = self.price_metadata()
        self.plugin._aks_matches["10"] = {"title": "Wrong", "product_id": "9", "checked_at": time.time()}
        with patch.object(self.plugin, "_aks_read", side_effect=self.history_response) as fetch:
            self.plugin._fetch_aks_game("10")
            self.assertEqual(fetch.call_count, 2)
        self.assertEqual(self.plugin._aks_matches["10"]["product_id"], "140254")
        for code in (404, 410):
            self.plugin._aks_matches["10"] = {"title": "Example", "product_id": "9", "checked_at": time.time()}
            self.plugin._aks_catalog = {}
            error = urllib.error.HTTPError("https://www.allkeyshop.com/", code, "missing", {}, None)
            with patch.object(self.plugin, "_aks_read", side_effect=[error, self.history_response("vaks.php"), json.dumps(self.history_fixture())]) as fetch:
                self.plugin._fetch_aks_game("10")
            self.assertEqual(fetch.call_count, 3)
            self.assertEqual(self.plugin._aks_matches["10"]["product_id"], "140254")

    async def test_failed_offers_keep_verified_search_match_and_metadata_on_disk(self):
        self.plugin._price_metadata["10"] = self.price_metadata()
        with patch.object(self.plugin, "_aks_read", side_effect=[self.history_response("vaks.php"), TimeoutError("timeout")]):
            await self.plugin.get_allkeyshop_price("10")
        await self.plugin._price_save_task
        restarted = self.plugin_type()
        await restarted._load_price_cache()
        self.assertEqual(restarted._aks_matches["10"]["product_id"], "140254")
        self.assertIn("10", restarted._price_metadata)
        self.assertNotIn("10", restarted._price_cache)
        with patch.object(restarted, "_aks_read") as network:
            self.assertEqual(restarted._load_aks_catalog()["example"], "140254")
            network.assert_not_called()
        restarted._aks_catalog_checked_at -= 86401
        with patch.object(restarted, "_aks_read", side_effect=self.history_response) as network:
            restarted._load_aks_catalog()
            self.assertEqual(network.call_count, 1)

    async def test_shared_price_lookup_survives_cancelled_waiter_and_does_not_wait_for_disk(self):
        release, started, save_started, save_release = (asyncio.Event() for _ in range(4))
        original = self.plugin._run_blocking
        entry = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/", "data": self.aks_fixture(), "checked_at": time.time()}
        count = 0
        async def blocking(function, *args):
            nonlocal count
            if function == self.plugin._fetch_aks_game:
                count += 1
                started.set()
                await release.wait()
                return entry
            return await original(function, *args)
        async def save():
            save_started.set()
            await save_release.wait()
        with patch.object(self.plugin, "_run_blocking", side_effect=blocking), patch.object(self.plugin, "_save_price_cache", side_effect=save) as disk:
            first = asyncio.create_task(self.plugin.get_allkeyshop_price("10"))
            await started.wait()
            second = asyncio.create_task(self.plugin.get_allkeyshop_price("10"))
            await asyncio.sleep(0)
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)
            release.set()
            result = await asyncio.wait_for(second, .2)
            self.assertTrue(result["success"])
            self.assertEqual(count, 1)
            for _ in range(10):
                self.plugin._schedule_price_save()
            await asyncio.wait_for(save_started.wait(), 1)
            self.assertEqual(disk.call_count, 1)
            save_release.set()
            await self.plugin._price_save_task

    def test_retry_after_http_date_and_directory_share_cooldown_without_blocking_sleep(self):
        import email.utils
        value = email.utils.formatdate(time.time() + 120, usegmt=True)
        error = urllib.error.HTTPError("https://www.allkeyshop.com/", 429, "slow", {"Retry-After": value}, None)
        with patch.object(self.plugin, "_open_request", side_effect=error) as request, patch("time.sleep") as sleep:
            for url in ("https://www.allkeyshop.com/api/v2/vaks.php", "https://www.allkeyshop.com/api/price_history_api.php"):
                with self.assertRaises(urllib.error.HTTPError):
                    self.plugin._aks_read(url)
            self.assertEqual(request.call_count, 1)
            sleep.assert_not_called()
        self.assertGreater(self.plugin._aks_error_details(error)["retry_after"], 118)

    async def test_gg_provider_secret_is_private_and_aks_selection_survives_switching(self):
        await self.plugin.set_price_preferences(True, False, ["Eneba"], True)
        key = "test_key_not_a_real_secret_123"
        result = await self.plugin.set_price_provider("gg", key)
        self.assertTrue(result["success"])
        self.assertNotIn(key, json.dumps(result))
        restarted = self.plugin_type()
        await restarted._load_price_preferences()
        self.assertEqual(restarted._gg_api_key, key)
        self.assertNotIn(key, json.dumps(await restarted.get_price_preferences()))
        await restarted.set_price_preferences(True, True, ["Eneba"], True)
        self.assertEqual(restarted._gg_api_key, key)
        switched = await restarted.set_price_provider("aks")
        self.assertEqual(switched["merchants"], ["Eneba"])
        self.assertTrue(switched["restrict_merchants"])

    async def test_gg_bulk_known_wishlist_and_persistent_separate_cache(self):
        await self.plugin.set_price_provider("gg", "test_key_not_a_real_secret")
        self.plugin._price_wishlist = ["10", "20"]
        self.plugin._price_wishlist_lease = time.monotonic() + 90
        for key in ("10", "20"):
            self.plugin._price_metadata[key] = self.price_metadata(key)
        response = {"headers": {}, "data": {"10": {"title": "Example", "url": "https://gg.deals/game/example/",
            "prices": {"currentRetail": "5.99", "currentKeyshops": "3.20", "currency": "EUR"}}, "20": None}}
        with patch.object(self.plugin, "_fetch_gg_prices", return_value=response) as fetch, patch.object(self.plugin, "_fetch_aks_game") as aks:
            result = await self.plugin.get_allkeyshop_price("10")
            self.assertEqual(result["keyshop_price"], 3.2)
            fetch.assert_called_once_with(["10", "20"])
            self.assertNotIn("offers", result)  # Never present an aggregate as a filtered Steam key.
            self.assertTrue((await self.plugin.get_allkeyshop_price("20"))["not_found"])
            aks.assert_not_called()
        await self.plugin._price_save_task
        restarted = self.plugin_type()
        await restarted._load_price_preferences()
        await restarted._load_price_cache()
        self.assertEqual(len(restarted._gg_cache), 2)
        self.assertEqual(restarted._price_cache, {})
        self.assertEqual((await restarted.get_cached_allkeyshop_price("10"))["keyshop_price"], 3.2)
        await restarted.set_price_provider("aks")
        self.assertTrue((await restarted.get_cached_allkeyshop_price("10"))["missing"])

    async def test_gg_limits_and_retry_after_preserve_old_price_without_leaking_key(self):
        await self.plugin.set_price_provider("gg", "test_key_not_a_real_secret")
        self.plugin._price_metadata["10"] = self.price_metadata()
        self.plugin._gg_requests = [time.time()] * 100
        with patch.object(self.plugin, "_fetch_gg_prices") as fetch:
            result = await self.plugin.get_allkeyshop_price("10")
            self.assertEqual(result["error_code"], "rate_limit")
            fetch.assert_not_called()
        self.plugin._gg_requests = []
        self.plugin._gg_retry_at = 0
        error = urllib.error.HTTPError("https://api.gg.deals/?key=test_key_not_a_real_secret", 429, "secret detail", {"Retry-After": "600"}, None)
        with patch.object(self.plugin, "_fetch_gg_prices", side_effect=error):
            result = await self.plugin.get_allkeyshop_price("10")
        self.assertGreater(result["retry_after"], 599)
        self.assertNotIn("test_key", json.dumps(result))
        self.assertNotIn("secret detail", json.dumps(result))

    async def test_aks_fallback_is_single_flight_persistent_and_keeps_sources_separate(self):
        self.plugin._gg_api_key = "test_key_not_a_real_secret"
        self.plugin._price_metadata["10"] = self.price_metadata()
        response = {"headers": {}, "data": {"10": {"title": "Example", "url": "https://gg.deals/game/example/",
            "prices": {"currentRetail": "5.99", "currentKeyshops": "3.20", "currency": "EUR"}}}}
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=TimeoutError()) as aks, patch.object(self.plugin, "_fetch_gg_prices", return_value=response) as gg:
            first, second = await asyncio.gather(self.plugin.get_allkeyshop_price("10"), self.plugin.get_allkeyshop_price("10"))
            self.assertEqual(first, second)
            self.assertEqual(first["provider"], "gg")
            self.assertEqual(first["fallback_from"], "aks")
            self.assertNotIn("offers", first)
            self.assertNotIn("10", self.plugin._price_cache)
            self.assertEqual(self.plugin._price_preferences.get("provider", "aks"), "aks")
            await self.plugin.get_allkeyshop_price("10")
            aks.assert_called_once()
            gg.assert_called_once()
        await self.plugin._price_save_task
        restarted = self.plugin_type()
        await restarted._load_price_cache()
        with patch.object(restarted, "_fetch_aks_game") as aks, patch.object(restarted, "_fetch_gg_prices") as gg:
            self.assertEqual((await restarted.get_cached_allkeyshop_price("10"))["provider"], "gg")
            self.assertEqual((await restarted.get_allkeyshop_price("10"))["keyshop_price"], 3.2)
            self.assertEqual(restarted._price_stats()["price_fresh_entries"], 1)
            aks.assert_not_called(); gg.assert_not_called()
        restarted._price_cache["10"] = {"title": "Example", "skipped": "free", "checked_at": time.time()}
        self.assertEqual((await restarted.get_cached_allkeyshop_price("10"))["skipped"], "free")
        restarted._price_cache.clear()
        restarted._gg_cache["10"]["checked_at"] = time.time() - 86401
        restarted._price_service_retry_at = 0
        restarted._aks_pause_until = 0
        recovered = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/",
                     "data": self.aks_fixture(), "checked_at": time.time()}
        with patch.object(restarted, "_fetch_aks_game", return_value=recovered) as aks, patch.object(restarted, "_fetch_gg_prices") as gg:
            self.assertIn("offers", await restarted.get_allkeyshop_price("10"))
            aks.assert_called_once(); gg.assert_not_called()

    def test_aks_fallback_only_for_connection_and_access_failures(self):
        for status in (403, 408, 429, 500, 502, 503):
            detail = self.plugin._aks_error_details(urllib.error.HTTPError("https://www.allkeyshop.com/", status, "", {}, None))
            self.assertTrue(self.plugin._aks_fallback_allowed(detail), status)
        for status in (400, 401, 404, 410):
            detail = self.plugin._aks_error_details(urllib.error.HTTPError("https://www.allkeyshop.com/", status, "", {}, None))
            self.assertFalse(self.plugin._aks_fallback_allowed(detail), status)
        for error in (ValueError("Nincs egyértelmű AllKeyShop-találat ehhez a Steam-játékhoz."), ValueError("A Steam-játék neve most nem kérdezhető le.")):
            self.assertFalse(self.plugin._aks_fallback_allowed(self.plugin._aks_error_details(error)))

    async def test_aks_fallback_missing_key_and_gg_rate_limit_do_not_loop(self):
        with patch.object(self.plugin, "_fetch_aks_game", side_effect=TimeoutError()), patch.object(self.plugin, "_fetch_gg_prices") as gg:
            self.assertEqual((await self.plugin.get_allkeyshop_price("10"))["error_code"], "connection")
            gg.assert_not_called()
        self.plugin._gg_api_key = "test_key_not_a_real_secret"
        self.plugin._gg_retry_at = time.time() + 120
        with patch.object(self.plugin, "_fetch_aks_game") as aks, patch.object(self.plugin, "_fetch_gg_prices") as gg:
            result = await self.plugin.get_allkeyshop_price("20")
            self.assertEqual(result["provider"], "gg")
            self.assertEqual(result["error_code"], "rate_limit")
            self.assertGreater(result["retry_after"], 119)
            aks.assert_not_called(); gg.assert_not_called()
        self.plugin._price_service_retry_at = 0
        self.plugin._aks_pause_until = 0
        self.assertFalse(self.plugin._aks_fallback_available())

    async def test_remote_aks_fallback_entry_is_validated_and_never_fetches_locally(self):
        await self.plugin.set_price_connection("server", "https://sajat-szerver.duckdns.org", "test_server_token_1234567890")
        entry = {"success": True, "provider": "gg", "fallback_from": "aks", "title": "Example", "currency": "EUR",
                 "url": "https://gg.deals/game/example/", "retail_price": 5.99, "keyshop_price": 3.2, "checked_at": time.time()}
        response = {"provider": "aks", "entry_provider": "gg", "app_id": "10", "entry": entry, "pending": False}
        with patch.object(self.plugin, "_price_server_request", return_value=response), patch.object(self.plugin, "_fetch_gg_prices") as gg:
            result = await self.plugin.get_allkeyshop_price("10")
            self.assertEqual(result["provider"], "gg")
            self.assertNotIn("10", self.plugin._price_cache)
            self.assertEqual((await self.plugin.get_cached_allkeyshop_price("10"))["provider"], "gg")
            gg.assert_not_called()
        self.plugin._gg_cache.clear()
        response["entry"] = {k: v for k, v in entry.items() if k != "fallback_from"}
        with patch.object(self.plugin, "_price_server_request", return_value=response):
            self.assertFalse((await self.plugin.get_allkeyshop_price("10"))["success"])

    async def test_private_server_settings_roundtrip_and_host_change_requires_new_token(self):
        token = "private_server_test_token_12345"
        result = await self.plugin.set_price_connection("server", "https://sajat-szerver.duckdns.org/", token)
        self.assertTrue(result["success"])
        self.assertNotIn(token, json.dumps(result))
        self.assertEqual(result["url"], "https://sajat-szerver.duckdns.org")
        restarted = self.plugin_type()
        await restarted._load_price_connection()
        self.assertEqual(restarted._price_server_token, token)
        self.assertNotIn(token, json.dumps(await restarted.get_price_connection()))
        changed = await restarted.set_price_connection("server", "https://other.duckdns.org")
        self.assertFalse(changed["success"])
        self.assertEqual(restarted._price_connection["url"], "https://sajat-szerver.duckdns.org")
        for url in ("http://example.com", "https://user:pass@example.com", "https://example.com/?token=x", "https://example.com/path", "https://example.com/#x"):
            self.assertFalse((await restarted.set_price_connection("server", url, token))["success"])
        await restarted.set_price_connection("direct", "https://sajat-szerver.duckdns.org")
        self.assertEqual(restarted._price_server_token, token)

    async def test_remote_prices_preserve_local_filters_and_cache_only_is_network_free(self):
        await self.plugin.set_price_connection("server", "https://sajat-szerver.duckdns.org", "test_server_token_1234567890")
        await self.plugin.set_price_preferences(True, False, ["Kinguin"], True)
        entry = {"title": "Example", "url": "https://www.allkeyshop.com/", "source": "aks_history",
                 "history_version": 2, "data": self.plugin._aks_history_data(self.history_fixture()), "checked_at": time.time()}
        response = {"protocol": 1, "provider": "aks", "app_id": "10", "entry": entry, "pending": False}
        with patch.object(self.plugin, "_price_server_request", return_value=response) as remote, patch.object(self.plugin, "_fetch_aks_game") as direct:
            result = await self.plugin.get_allkeyshop_price("10")
            self.assertTrue(result["success"])
            self.assertEqual(result["offers"][0]["merchant"], "Kinguin")
            self.assertEqual(result["offers"][0]["source_updated_at"], "2026-09-24 12:00:00")
            await self.plugin.get_allkeyshop_price("10")
            await self.plugin.get_cached_allkeyshop_price("10")
            await self.plugin.get_cached_allkeyshop_price("20")
            self.assertEqual(remote.call_count, 1)
            direct.assert_not_called()
            self.plugin._price_preferences["merchants"] = []
            self.assertEqual((await self.plugin.get_cached_allkeyshop_price("10"))["offers"], [])

    async def test_remote_pending_wishlist_retries_soon_and_mismatched_response_is_rejected(self):
        await self.plugin.set_price_connection("server", "https://sajat-szerver.duckdns.org", "test_server_token_1234567890")
        self.plugin._price_wishlist = ["10"]
        self.plugin._price_wishlist_lease = time.monotonic() + 90
        response = {"protocol": 1, "provider": "aks", "app_id": "10", "entry": None, "pending": True, "retry_after": 4}
        with patch.object(self.plugin, "_price_server_request", return_value=response):
            await self.plugin._price_wishlist_step()
            self.assertLess(self.plugin._price_wishlist_retry["10"] - time.time(), 5)
            self.assertFalse(await self.plugin._price_wishlist_step())
        response["app_id"] = "20"
        with patch.object(self.plugin, "_price_server_request", return_value=response):
            result = await self.plugin.get_allkeyshop_price("10")
            self.assertFalse(result["success"])
        self.assertNotIn("10", self.plugin._price_cache)

    async def test_server_offline_retains_stale_price_and_never_falls_back_to_provider(self):
        await self.plugin.set_price_connection("server", "https://sajat-szerver.duckdns.org", "test_server_token_1234567890")
        entry = {"title": "Example", "url": "https://www.allkeyshop.com/blog/buy-example-cd-key-compare-prices/",
                 "data": self.aks_fixture(), "checked_at": time.time() - 86401}
        self.plugin._price_cache["10"] = entry
        with patch.object(self.plugin, "_price_server_request", side_effect=TimeoutError("sensitive URL")) as remote, patch.object(self.plugin, "_fetch_aks_game") as direct:
            self.assertTrue((await self.plugin.get_cached_allkeyshop_price("10"))["stale"])
            result = await self.plugin.get_allkeyshop_price("10")
            self.assertFalse(result["success"])
            self.assertTrue(result["global_error"])
            self.assertNotIn("sensitive", result["error"])
            await self.plugin.get_allkeyshop_price("20")
            self.assertEqual(remote.call_count, 1)
            direct.assert_not_called()
            self.assertEqual(self.plugin._price_cache["10"], entry)

    async def test_server_gg_mode_does_not_require_or_transmit_local_gg_key(self):
        await self.plugin.set_price_connection("server", "https://sajat-szerver.duckdns.org", "test_server_token_1234567890")
        self.assertTrue((await self.plugin.set_price_provider("gg"))["success"])
        entry = {"success": True, "provider": "gg", "title": "Example", "url": "https://gg.deals/game/example/",
                 "currency": "EUR", "keyshop_price": 3.2, "retail_price": 5.1, "checked_at": time.time()}
        with patch.object(self.plugin, "_price_server_request", return_value={"protocol": 1, "provider": "gg", "app_id": "10", "entry": entry}) as remote:
            self.assertEqual((await self.plugin.get_allkeyshop_price("10"))["keyshop_price"], 3.2)
            self.assertEqual(set(remote.call_args.args[-1]), {"provider", "app_id", "priority"})

    async def test_remote_bolt_directory_uses_server_only(self):
        await self.plugin.set_price_connection("server", "https://sajat-szerver.duckdns.org", "test_server_token_1234567890")
        with patch.object(self.plugin, "_price_server_request", return_value={"protocol": 1, "merchants": ["Eneba", "GAMIVO"]}) as remote, patch.object(self.plugin, "_aks_read") as aks:
            result = await self.plugin.get_price_merchants(True)
            self.assertEqual(set(result["merchants"]), {"YUPLAY", "GAMESEAL", "GAMIVO", "G2A", "Kinguin", "Eneba", "HRK"})
            self.assertEqual(remote.call_args.args[2], "/v1/merchants")
            aks.assert_not_called()

    async def test_aks_server_cooldown_survives_backend_restart(self):
        self.plugin._aks_pause_until = time.monotonic() + 120
        await self.plugin._save_price_cache()
        restarted = self.plugin_type()
        await restarted._load_price_cache()
        self.assertGreater(restarted._price_service_retry_at - time.time(), 119)
        self.assertGreater(restarted._aks_pause_until - time.monotonic(), 119)
        with patch.object(restarted, "_fetch_aks_game") as lookup:
            result = await restarted.get_allkeyshop_price("10")
            self.assertTrue(result["global_error"])
            lookup.assert_not_called()

    def test_server_token_uses_verified_tls_header_and_redirect_is_refused(self):
        import ssl
        with patch("urllib.request.build_opener") as build:
            build.return_value.open.return_value = io.BytesIO(b'{"protocol":1}')
            self.plugin._price_server_request("https://sajat-szerver.duckdns.org", "test_server_token_1234567890", "/v1/status")
            request = build.return_value.open.call_args.args[0]
            self.assertNotIn("test_server_token", request.full_url)
            self.assertEqual(request.get_header("Authorization"), "Bearer test_server_token_1234567890")
            https, redirect = build.call_args.args
            self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(https._context.check_hostname)
            with self.assertRaises(urllib.error.HTTPError):
                redirect.redirect_request(request, None, 302, "redirect", {}, "https://other.example/")

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
        if self.plugin._price_save_task:
            await self.plugin._price_save_task
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



