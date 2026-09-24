"""Private price-cache API. Bind only to loopback, behind Caddy HTTPS.

The released Decky backend is the single implementation of matching, filtering,
provider pacing and disk caches. This host supplies the small Decky environment
it needs; no Steam account or Steam credentials are required.
"""
import argparse
import asyncio
import concurrent.futures
import hmac
import importlib.util
import json
import logging
import signal
import sys
import threading
import time
import types
import urllib.parse
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROTOCOL = 1
MAX_QUEUE = 128
MAX_BODY = 2048
MAX_OBSERVED = 2048
RECENT_JOBS = 50
FOREGROUND_WAIT_SECONDS = 2.5
LOG = logging.getLogger("deck-price-server")


def load_engine(data_directory, gg_key=""):
    directory = Path(data_directory)
    directory.mkdir(parents=True, exist_ok=True)
    decky = types.ModuleType("decky")
    decky.decky_SETTINGS_DIR = str(directory)
    decky.logger = LOG
    sys.modules["decky"] = decky
    local = Path(__file__).resolve().parent / "main.py"
    source = local if local.exists() else local.parent.parent / "main.py"
    spec = importlib.util.spec_from_file_location("price_engine", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = module.Plugin()
    engine.price_ttl_seconds = module.PRICE_TTL_SECONDS
    engine._gg_api_key = gg_key
    return engine


class PriceBroker:
    def __init__(self, engine):
        self.engine = engine
        self.pending = {}
        self.finished = {}
        self.failures = {}
        self.sequence = 0
        self.current = None
        self.wake = asyncio.Event()
        self.stopping = False
        self.worker = None
        self.directory_task = None
        self.directory_retry = 0
        self.started_at = time.time()
        self.current_started_at = None
        self.observed = {}
        self.observed_evicted = 0
        self.recent = deque(maxlen=RECENT_JOBS)
        self.completed = 0
        self.failed = 0
        self.cache_hits = 0

    async def start(self):
        await self.engine._load_price_cache()
        await self.engine._load_price_merchants()
        self.worker = asyncio.create_task(self.run())

    def cache(self, provider):
        return self.engine._gg_cache if provider == "gg" else self.engine._price_cache

    def cooldown(self, provider):
        if provider == "gg":
            return self.engine._gg_retry_at
        remaining = self.engine._aks_pause_until - time.monotonic()
        return max(self.engine._price_service_retry_at, time.time() + remaining if remaining > 0 else 0)

    def work_cooldown(self, provider):
        # AKS may be paused while independent GG fallback can still serve work.
        return self.cooldown("gg") if provider == "aks" and self.engine._aks_fallback_available() else self.cooldown(provider)

    @staticmethod
    def entry_copy(entry):
        if entry is None or "error" in entry:
            return None
        if "data" not in entry:
            return dict(entry)
        return {**entry, "data": {key: entry["data"][key] for key in ("prices", "merchants", "regions", "editions")}}

    def describe(self, key):
        provider, app_id = key
        entry = self.engine._effective_price_entry(app_id, provider) or self.engine._price_metadata.get(app_id) or {}
        return {"provider": provider, "app_id": app_id, "title": str(entry.get("title", ""))[:160]}

    def observe(self, key, state, retry_at=0):
        self.observed.pop(key, None)
        self.observed[key] = {"state": state, "retry_at": retry_at}
        if len(self.observed) > MAX_OBSERVED:
            self.observed.pop(next(iter(self.observed)))
            self.observed_evicted += 1

    def status(self):
        # Read-only snapshot: never enqueue work, refresh caches or write files.
        now = time.time()
        providers = {}
        for provider in ("aks", "gg"):
            entries = [entry for entry in self.cache(provider).values() if "error" not in entry]
            fresh = sum(0 <= now - entry["checked_at"] < self.engine.price_ttl_seconds for entry in entries)
            providers[provider] = {"stored": len(entries), "fresh": fresh, "stale": len(entries) - fresh,
                                   "skipped": sum(bool(entry.get("skipped")) for entry in entries),
                                   "retry_after": max(0, round(self.cooldown(provider) - now)),
                                   "configured": provider == "aks" or bool(self.engine._gg_api_key)}
        waiting = [{**self.describe(key), "priority": "foreground" if priority[0] == 0 else "background",
                    "retry_after": max(0, round(self.work_cooldown(key[0]) - now))}
                   for key, priority in sorted(self.pending.items(), key=lambda pair: pair[1]) if key != self.current]
        missing = []
        for key, observation in self.observed.items():
            entry = self.engine._effective_price_entry(key[1], key[0])
            if entry and "error" not in entry:
                continue
            missing.append({**self.describe(key), **observation,
                            "error": self.failures.get(key, (0, {}))[1].get("error", ""),
                            "state": "running" if key == self.current else "queued" if key in self.pending else observation["state"],
                            "retry_after": max(0, round(observation["retry_at"] - now))})
        current = None
        if self.current:
            current = {**self.describe(self.current), "started_at": self.current_started_at,
                       "elapsed_seconds": round(now - self.current_started_at, 1)}
        directory_running = bool(self.directory_task and not self.directory_task.done())
        state = "running" if current else "waiting" if waiting else "merchants" if directory_running else "idle"
        stored = sum(value["stored"] for value in providers.values())
        fresh = sum(value["fresh"] for value in providers.values())
        return {"protocol": PROTOCOL, "gg_available": bool(self.engine._gg_api_key), "queue": len(self.pending),
                "aks_entries": len(self.engine._price_cache), "gg_entries": len(self.engine._gg_cache),
                "state": state, "started_at": self.started_at, "updated_at": now,
                "current": current, "waiting_count": len(waiting), "waiting": waiting,
                "recent": list(reversed(self.recent)), "providers": providers,
                "stored": stored, "fresh": fresh, "stale": stored - fresh, "price_ttl_seconds": self.engine.price_ttl_seconds,
                "metadata_entries": len(self.engine._price_metadata), "match_entries": len(self.engine._aks_matches),
                "completed": self.completed, "failed": self.failed, "cache_hits": self.cache_hits,
                "observed_count": len(self.observed), "observed_evicted": self.observed_evicted,
                "missing_count": len(missing), "missing": missing[:50], "missing_truncated": len(missing) > 50,
                "scope": "requested_since_restart", "merchant_refresh": directory_running}

    async def price(self, request, wait_for_result=True):
        if not isinstance(request, dict) or set(request) - {"provider", "app_id", "priority"}:
            raise ValueError("Invalid request")
        provider, app_id = request.get("provider"), request.get("app_id")
        if (provider not in ("aks", "gg") or not isinstance(app_id, str) or not app_id.isascii()
                or not app_id.isdigit() or not 0 < int(app_id) < 10000000000
                or request.get("priority", "background") not in ("foreground", "background")):
            raise ValueError("Invalid product")
        now = time.time()
        key = (provider, app_id)
        self.observe(key, "requested")
        entry = self.entry_copy(self.engine._effective_price_entry(app_id, provider))
        response = {"protocol": PROTOCOL, "provider": provider, "app_id": app_id, "entry": entry,
                    "entry_provider": "gg" if entry and entry.get("provider") == "gg" else provider,
                    "pending": False, "retry_after": 3, "queue": len(self.pending)}
        if entry and 0 <= now - entry["checked_at"] < self.engine.price_ttl_seconds:
            self.cache_hits += 1
            self.observe(key, "cached")
            return response
        if provider == "gg" and not self.engine._gg_api_key:
            self.observe(key, "missing_key", now + 60)
            return {**response, "failure": {"global_error": True, "error": "A szerveren nincs beállítva GG.deals API-kulcs."}, "retry_after": 60}
        self.failures = {k: v for k, v in self.failures.items() if v[0] > now}
        failure = self.failures.get(key)
        if failure:
            self.observe(key, "failed", failure[0])
            return {**response, "failure": failure[1], "retry_after": max(1, failure[0] - now)}
        cooldown = self.work_cooldown(provider)
        if cooldown > now:
            self.observe(key, "provider_wait", cooldown)
            source = "gg" if provider == "gg" or self.engine._aks_fallback_available() else "aks"
            message = self.engine._gg_last_error if source == "gg" else self.engine._price_last_error
            return {**response, "failure": {"provider": source, "global_error": True, "error": message or "Az árforrás várakozást kér."}, "retry_after": cooldown - now}
        priority = 0 if request.get("priority") == "foreground" else 1
        if key not in self.pending:
            if len(self.pending) >= MAX_QUEUE:
                self.observe(key, "queue_full", now + 15)
                return {**response, "failure": {"global_error": True, "error": "A szerver lekérési sora megtelt."}, "retry_after": 15}
            self.sequence += 1
            self.pending[key] = (priority, self.sequence)
            self.finished[key] = asyncio.Event()
        else:
            old_priority, sequence = self.pending[key]
            self.pending[key] = (min(priority, old_priority), sequence)
        self.wake.set()
        self.observe(key, "queued")
        # An opened game can receive a fast lookup in this HTTP response, without
        # an extra polling interval. Cached/stale data and background jobs return
        # immediately. Timing out the event wait never cancels the shared worker.
        if priority == 0 and entry is None and wait_for_result:
            try:
                await asyncio.wait_for(self.finished[key].wait(), FOREGROUND_WAIT_SECONDS)
            except asyncio.TimeoutError:
                pass
            if key not in self.pending:
                return await self.price(request, wait_for_result=False)
        ahead = sum(value < self.pending[key] for value in self.pending.values())
        return {**response, "pending": True, "queue": len(self.pending),
                "retry_after": 1 if priority == 0 else min(30, max(3, ahead * 2))}

    async def run(self):
        while not self.stopping:
            ready = [key for key in self.pending if self.work_cooldown(key[0]) <= time.time()]
            if not ready:
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), 2)
                except asyncio.TimeoutError:
                    pass
                continue
            key = min(ready, key=lambda candidate: self.pending[candidate])
            self.current = key
            self.current_started_at = time.time()
            provider, app_id = key
            outcome, retry_at, actual_provider = "failed", 0, provider
            error_message, error_code = "", ""
            LOG.info("Price job started provider=%s app_id=%s waiting=%d", provider, app_id, len(self.pending) - 1)
            try:
                # One worker means this provider selection cannot race another lookup.
                self.engine._price_preferences["provider"] = provider
                result = await self.engine._get_allkeyshop_price(app_id)
                actual_provider = result.get("provider", provider)
                if result.get("success"):
                    outcome = "skipped" if result.get("skipped") else "not_found" if result.get("not_found") else "completed"
                if not result.get("success"):
                    error_message = str(result.get("error", "Az árlekérés sikertelen."))[:500]
                    error_code = str(result.get("error_code", "lookup"))[:40]
                    if error_code == "match":
                        outcome = "not_found"
                    delay = max(1, result.get("retry_after", 30))
                    retry_at = time.time() + delay
                    self.failures[key] = (time.time() + delay, {
                        "provider": actual_provider,
                        "error_code": error_code,
                        "global_error": result.get("global_error") is True,
                        "error": error_message})
                    while len(self.failures) > 512:
                        self.failures.pop(next(iter(self.failures)))
            except Exception:
                # No request headers, URLs, provider credentials or exception body in logs.
                LOG.error("Price job failed")
                error_message, error_code = "Szerveroldali feldolgozási hiba.", "server"
                retry_at = time.time() + 30
                self.failures[key] = (time.time() + 30, {"global_error": False, "error": "Szerveroldali feldolgozási hiba."})
            finally:
                finished_at = time.time()
                duration = round(finished_at - self.current_started_at, 2)
                self.failed += int(outcome == "failed")
                self.completed += int(outcome != "failed")
                self.observe(key, outcome, retry_at)
                self.recent.append({**self.describe(key), "provider": actual_provider, "requested_provider": provider,
                                    "outcome": outcome, "finished_at": finished_at,
                                    "error": error_message, "error_code": error_code,
                                    "duration_seconds": duration, "retry_at": retry_at})
                LOG.info("Price job finished provider=%s app_id=%s outcome=%s seconds=%.2f", actual_provider, app_id, outcome, duration)
                self.pending.pop(key, None)
                finished = self.finished.pop(key, None)
                if finished:
                    finished.set()
                self.current = None
                self.current_started_at = None
            await asyncio.sleep(0)

    async def merchants(self, request):
        if not isinstance(request, dict) or set(request) - {"refresh"} or type(request.get("refresh", False)) is not bool:
            raise ValueError("Invalid request")
        result = await self.engine.get_price_merchants(request.get("refresh", False))
        return {"protocol": PROTOCOL, "merchants": result["merchants"], "pending": False}

    async def close(self):
        self.stopping = True
        self.wake.set()
        if self.worker:
            await self.worker
        if self.directory_task:
            await self.directory_task
        await self.engine._unload()


class PrivateHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, broker, loop, token):
        self.broker, self.loop, self.token = broker, loop, token
        self.slots = threading.BoundedSemaphore(16)
        self.rate_lock = threading.Lock()
        self.requests = deque()
        super().__init__(address, APIHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def allowed(self):
        with self.rate_lock:
            now = time.monotonic()
            while self.requests and now - self.requests[0] >= 60:
                self.requests.popleft()
            if len(self.requests) >= 300:
                return False
            self.requests.append(now)
            return True

    def handle_error(self, request, client_address):
        LOG.warning("HTTP request interrupted")


class APIHandler(BaseHTTPRequestHandler):
    server_version = "DeckPriceServer"
    sys_version = ""

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, format_string, *args):
        pass  # Never log caller-controlled paths or credentials.

    def reply(self, code, payload, retry=None):
        body = json.dumps({"protocol": PROTOCOL, **payload}, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        if retry:
            self.send_header("Retry-After", str(retry))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + self.server.token
        if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
            self.reply(401, {"error": "Authentication required"})
            return False
        if not self.server.allowed():
            self.reply(429, {"error": "Request limit"}, retry=30)
            return False
        return True

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"service": "deck-price-server"})
            return
        if not self.authorized():
            return
        if self.path != "/v1/status":
            self.reply(404, {"error": "Not found"})
            return
        async def status():
            return self.server.broker.status()
        self.dispatch(status())

    def do_POST(self):
        if not self.authorized():
            return
        if self.path not in ("/v1/price", "/v1/merchants"):
            self.reply(404, {"error": "Not found"})
            return
        length = self.headers.get("Content-Length", "")
        if (self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1
                or not length.isdigit() or not 0 < int(length) <= MAX_BODY):
            self.reply(413, {"error": "Invalid request size"})
            return
        if self.headers.get_content_type() != "application/json":
            self.reply(415, {"error": "JSON required"})
            return
        try:
            data = json.loads(self.rfile.read(int(length)))
        except (ValueError, OSError):
            self.reply(400, {"error": "Invalid JSON"})
            return
        handler = self.server.broker.price if self.path == "/v1/price" else self.server.broker.merchants
        self.dispatch(handler(data))

    def dispatch(self, coroutine):
        future = asyncio.run_coroutine_threadsafe(coroutine, self.server.loop)
        try:
            self.reply(200, future.result(timeout=4))
        except ValueError:
            self.reply(400, {"error": "Invalid request"})
        except concurrent.futures.TimeoutError:
            future.cancel()
            self.reply(503, {"error": "Server busy"}, retry=5)
        except Exception:
            self.reply(500, {"error": "Server error"})


def read_config(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    token = value.get("api_token")
    if not isinstance(token, str) or len(token) < 24 or len(token) > 200 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in token):
        raise ValueError("Configure a strong api_token")
    return value


def update_dns(config):
    domain = config.get("domain", "")
    token = config.get("duckdns_token", "")
    if not token:
        return
    if not domain.endswith(".duckdns.org") or not domain[:-12] or "." in domain[:-12]:
        raise ValueError("Invalid DuckDNS hostname")
    query = urllib.parse.urlencode({"domains": domain[:-12], "token": token})
    try:
        with urllib.request.urlopen("https://www.duckdns.org/update?" + query, timeout=15) as response:
            if response.read(1024).decode().strip() != "OK":
                raise ValueError("DuckDNS update rejected")
    except Exception:
        raise RuntimeError("DuckDNS update failed; check configuration and network") from None


async def serve(config):
    engine = load_engine(config.get("data_directory", "/var/lib/deck-price-server"), config.get("gg_api_key", ""))
    broker = PriceBroker(engine)
    await broker.start()
    loop = asyncio.get_event_loop()
    httpd = PrivateHTTPServer(("127.0.0.1", 8765), broker, loop, config["api_token"])
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    LOG.info("Price service ready on loopback port 8765")
    try:
        await stop.wait()
    finally:
        await loop.run_in_executor(None, httpd.shutdown)
        httpd.server_close()
        await broker.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/deck-price-server/config.json")
    parser.add_argument("--update-dns", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    try:
        config = read_config(args.config)
        if args.update_dns:
            update_dns(config)
        else:
            asyncio.run(serve(config))
    except Exception:
        LOG.error("Service failed. Check configuration, permissions and network; credentials are not logged.")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
