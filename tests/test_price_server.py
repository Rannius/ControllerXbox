import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("private_price_server", ROOT / "price-server/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class PriceServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.release_events = []
        self.engine = server.load_engine(self.directory.name)
        self.broker = server.PriceBroker(self.engine)
        await self.broker.start()
        self.token = "server_test_token_1234567890123456"
        self.http = server.PrivateHTTPServer(("127.0.0.1", 0), self.broker, asyncio.get_event_loop(), self.token)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    async def asyncTearDown(self):
        for event in self.release_events:
            event.set()
        await asyncio.get_event_loop().run_in_executor(None, self.http.shutdown)
        self.http.server_close()
        self.thread.join(2)
        await self.broker.close()
        self.directory.cleanup()

    async def request(self, path, data=None, token=True):
        def send():
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = "Bearer " + self.token
            req = urllib.request.Request("http://127.0.0.1:%s%s" % (self.http.server_port, path),
                data=json.dumps(data).encode() if data is not None else None, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                return error.code, json.load(error)
        return await asyncio.get_event_loop().run_in_executor(None, send)

    def entry(self, age=0):
        return {"title": "Example", "checked_at": time.time() - age,
                "url": "https://www.allkeyshop.com/", "source": "aks_history",
                "source_updated_at": "2026-09-24 12:00:00",
                "data": {"prices": [], "merchants": {}, "regions": {}, "editions": {}}}

    async def test_foreground_receives_quick_result_in_first_response(self):
        async def lookup(app_id):
            await asyncio.sleep(.01)
            self.engine._price_cache[app_id] = self.entry()
            return {"success": True}
        with patch.object(self.engine, "_get_allkeyshop_price", side_effect=lookup) as fetch:
            _, response = await asyncio.wait_for(self.request("/v1/price",
                {"provider": "aks", "app_id": "10", "priority": "foreground"}), 1)
            self.assertFalse(response["pending"])
            self.assertEqual(response["entry"]["source"], "aks_history")
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(self.broker.finished, {})

    async def test_foreground_wait_timeout_keeps_shared_job_running(self):
        release = asyncio.Event()
        self.release_events.append(release)
        async def lookup(app_id):
            await release.wait()
            self.engine._price_cache[app_id] = self.entry()
            return {"success": True}
        request = {"provider": "aks", "app_id": "10", "priority": "foreground"}
        with patch.object(self.engine, "_get_allkeyshop_price", side_effect=lookup) as fetch, patch.object(server, "FOREGROUND_WAIT_SECONDS", .02):
            _, first = await self.request("/v1/price", request)
            self.assertTrue(first["pending"])
            self.assertEqual(first["retry_after"], 1)
            self.assertIn(("aks", "10"), self.broker.pending)
            done = self.broker.finished[("aks", "10")]
            release.set()
            await asyncio.wait_for(done.wait(), 1)
            _, second = await self.request("/v1/price", request)
            self.assertFalse(second["pending"])
            self.assertEqual(fetch.call_count, 1)

    async def test_authentication_validation_health_and_no_arbitrary_proxy(self):
        self.assertEqual((await self.request("/health", token=False))[0], 200)
        self.assertEqual((await self.request("/v1/status", token=False))[0], 401)
        self.assertEqual((await self.request("/v1/status"))[0], 200)
        self.assertEqual((await self.request("/v1/price", {"provider": "aks", "app_id": "10", "url": "http://localhost/private"}))[0], 400)
        self.assertEqual((await self.request("/v1/price", {"provider": "other", "app_id": "10"}))[0], 400)
        self.assertEqual((await self.request("/v1/price", {"provider": "aks", "app_id": "-10"}))[0], 400)
        self.assertEqual((await self.request("/anything", {"url": "http://localhost"}))[0], 404)
        self.assertEqual((await self.request("/v1/price", {"padding": "x" * 3000}))[0], 413)
        self.assertEqual(self.broker.pending, {})

    async def test_two_clients_share_one_job_and_fresh_price_never_fetches_again(self):
        started, release = asyncio.Event(), asyncio.Event()
        self.release_events.append(release)
        calls = []
        async def lookup(app_id):
            calls.append(app_id)
            started.set()
            await release.wait()
            self.engine._price_cache[app_id] = self.entry()
            return {"success": True}
        with patch.object(self.engine, "_get_allkeyshop_price", side_effect=lookup):
            _, first = await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            self.assertTrue(first["pending"])
            await asyncio.wait_for(started.wait(), 1)
            _, second = await self.request("/v1/price", {"provider": "aks", "app_id": "10", "priority": "foreground"})
            self.assertTrue(second["pending"])
            self.assertEqual(calls, ["10"])
            release.set()
            await asyncio.sleep(.02)
            _, cached = await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            self.assertFalse(cached["pending"])
            self.assertEqual(cached["entry"]["title"], "Example")
            self.assertEqual(cached["entry"]["source"], "aks_history")
            self.assertEqual(cached["entry"]["source_updated_at"], "2026-09-24 12:00:00")
            self.assertEqual(calls, ["10"])

    async def test_stale_price_is_immediate_and_foreground_overtakes_waiting_jobs(self):
        release, started = asyncio.Event(), asyncio.Event()
        self.release_events.append(release)
        calls = []
        self.engine._price_cache["10"] = self.entry(age=86401)
        async def lookup(app_id):
            calls.append(app_id)
            started.set()
            await release.wait()
            self.engine._price_cache[app_id] = self.entry()
            return {"success": True}
        with patch.object(self.engine, "_get_allkeyshop_price", side_effect=lookup):
            _, value = await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            self.assertTrue(value["pending"])
            self.assertIsNotNone(value["entry"])
            await asyncio.wait_for(started.wait(), 1)
            await self.request("/v1/price", {"provider": "aks", "app_id": "20"})
            await self.request("/v1/price", {"provider": "aks", "app_id": "30", "priority": "foreground"})
            release.set()
            await asyncio.sleep(.05)
            self.assertEqual(calls, ["10", "30", "20"])

    async def test_provider_pause_and_missing_gg_key_do_not_trigger_network(self):
        self.assertEqual(self.broker.cooldown("aks"), 0)
        self.engine._price_service_retry_at = time.time() + 120
        with patch.object(self.engine, "_get_allkeyshop_price") as lookup:
            _, aks = await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            self.assertTrue(aks["failure"]["global_error"])
            self.assertGreater(aks["retry_after"], 119)
            _, gg = await self.request("/v1/price", {"provider": "gg", "app_id": "10"})
            self.assertIn("API", gg["failure"]["error"])
            lookup.assert_not_called()
        self.assertEqual(self.broker.pending, {})

    async def test_request_limits_and_status_never_disclose_secrets(self):
        self.engine._gg_api_key = "private_gg_secret"
        _, status = await self.request("/v1/status")
        self.assertTrue(status["gg_available"])
        self.assertNotIn("private_gg_secret", json.dumps(status))
        self.assertNotIn(self.token, json.dumps(status))
        self.http.requests.extend([time.monotonic()] * 300)
        self.assertEqual((await self.request("/v1/status"))[0], 429)

    async def test_day_old_cache_boundary_matches_monitor(self):
        self.engine._price_cache["10"] = self.entry(age=23 * 3600)
        self.engine._price_cache["20"] = self.entry(age=86401)
        with patch.object(self.engine, "_get_allkeyshop_price") as lookup:
            _, result = await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            self.assertFalse(result["pending"])
            self.assertIsNotNone(result["entry"])
            _, status = await self.request("/v1/status")
            self.assertEqual(status["price_ttl_seconds"], 86400)
            self.assertEqual(status["fresh"], 1)
            self.assertEqual(status["stale"], 1)
            lookup.assert_not_called()

    async def test_aks_fallback_runs_during_aks_pause_and_reports_actual_source(self):
        self.engine._gg_api_key = "test_gg_key_for_fallback"
        self.engine._price_metadata["10"] = {"app_id": "10", "title": "Example", "is_free": False, "coming_soon": False, "checked_at": time.time()}
        self.engine._price_service_error = {"global_error": True, "error_code": "connection", "error": "Unavailable"}
        self.engine._price_service_retry_at = time.time() + 120
        response = {"headers": {}, "data": {"10": {"title": "Example", "url": "https://gg.deals/game/example/",
                    "prices": {"currentRetail": "5.99", "currentKeyshops": "3.20", "currency": "EUR"}}}}
        with patch.object(self.engine, "_fetch_aks_game") as aks, patch.object(self.engine, "_fetch_gg_prices", return_value=response) as gg:
            _, first = await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            self.assertTrue(first["pending"])
            for _ in range(30):
                if self.broker.completed: break
                await asyncio.sleep(.01)
            _, final = await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            self.assertEqual(final["provider"], "aks")
            self.assertEqual(final["entry_provider"], "gg")
            self.assertEqual(final["entry"]["fallback_from"], "aks")
            self.assertFalse(final["pending"])
            _, status = await self.request("/v1/status")
            self.assertEqual(status["missing_count"], 0)
            self.assertEqual(status["recent"][0]["provider"], "gg")
            self.assertEqual(status["recent"][0]["requested_provider"], "aks")
            self.assertEqual(status["gg_entries"], 1)
            aks.assert_not_called(); gg.assert_called_once()

    async def test_monitor_shows_running_waiting_results_and_cache_without_fetching(self):
        started, release = asyncio.Event(), asyncio.Event()
        self.release_events.append(release)
        calls = []
        async def lookup(app_id):
            calls.append(app_id)
            started.set()
            await release.wait()
            self.engine._price_cache[app_id] = self.entry()
            return {"success": True}
        self.engine._price_cache["90"] = self.entry(age=86401)
        with patch.object(self.engine, "_get_allkeyshop_price", side_effect=lookup):
            await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            await asyncio.wait_for(started.wait(), 1)
            await self.request("/v1/price", {"provider": "aks", "app_id": "20"})
            for _ in range(2):
                code, status = await self.request("/v1/status")
                self.assertEqual(code, 200)
                self.assertEqual(status["state"], "running")
                self.assertEqual(status["current"]["app_id"], "10")
                self.assertEqual([item["app_id"] for item in status["waiting"]], ["20"])
                self.assertEqual(status["missing_count"], 2)
                self.assertEqual(status["stale"], 1)
                self.assertEqual(status["fresh"], 0)
                self.assertEqual(status["completed"], 0)
            self.assertEqual(calls, ["10"])
            release.set()
            await asyncio.sleep(.05)
            _, status = await self.request("/v1/status")
            self.assertEqual(status["state"], "idle")
            self.assertEqual(status["completed"], 2)
            self.assertEqual(status["stored"], 3)
            self.assertEqual(status["fresh"], 2)
            self.assertEqual(status["missing_count"], 0)
            self.assertEqual([item["app_id"] for item in status["recent"]], ["20", "10"])
            await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
            self.assertEqual(self.broker.status()["cache_hits"], 1)
            self.assertEqual(calls, ["10", "20"])

    async def test_monitor_failure_cooldown_redaction_and_bounded_history(self):
        async def fail(app_id):
            return {"success": False, "error": "secret_in_raw_provider_error", "retry_after": 60}
        with patch.object(self.engine, "_get_allkeyshop_price", side_effect=fail):
            with self.assertLogs(server.LOG, level="INFO") as logs:
                await self.request("/v1/price", {"provider": "aks", "app_id": "10"})
                await asyncio.sleep(.05)
            self.assertNotIn("secret_in_raw_provider_error", str(logs.output))
            self.assertIn("app_id=10", str(logs.output))
        self.engine._price_service_retry_at = time.time() + 120
        await self.request("/v1/price", {"provider": "aks", "app_id": "20"})
        _, status = await self.request("/v1/status")
        self.assertEqual(status["failed"], 1)
        self.assertEqual(status["completed"], 0)
        self.assertGreaterEqual(status["providers"]["aks"]["retry_after"], 119)
        self.assertEqual(status["missing_count"], 2)
        self.assertEqual(status["recent"][0]["outcome"], "failed")
        self.assertNotIn("secret_in_raw_provider_error", json.dumps(status))
        self.assertEqual(self.broker.pending, {})
        for i in range(server.MAX_OBSERVED + 1):
            self.broker.observe(("aks", str(i + 1)), "provider_wait")
        self.assertEqual(len(self.broker.observed), server.MAX_OBSERVED)
        status = self.broker.status()
        self.assertTrue(status["missing_truncated"])
        self.assertEqual(len(status["missing"]), 50)
        self.assertGreater(status["observed_evicted"], 0)


if __name__ == "__main__":
    unittest.main()
