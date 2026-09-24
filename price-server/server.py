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
    engine._gg_api_key = gg_key
    return engine


class PriceBroker:
    def __init__(self, engine):
        self.engine = engine
        self.pending = {}
        self.failures = {}
        self.sequence = 0
        self.current = None
        self.wake = asyncio.Event()
        self.stopping = False
        self.worker = None
        self.directory_task = None
        self.directory_retry = 0

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

    @staticmethod
    def entry_copy(entry):
        if entry is None or "error" in entry:
            return None
        if "data" not in entry:
            return dict(entry)
        return {**entry, "data": {key: entry["data"][key] for key in ("prices", "merchants", "regions", "editions")}}

    def status(self):
        return {"protocol": PROTOCOL, "gg_available": bool(self.engine._gg_api_key), "queue": len(self.pending),
                "aks_entries": len(self.engine._price_cache), "gg_entries": len(self.engine._gg_cache)}

    async def price(self, request):
        if not isinstance(request, dict) or set(request) - {"provider", "app_id", "priority"}:
            raise ValueError("Invalid request")
        provider, app_id = request.get("provider"), request.get("app_id")
        if (provider not in ("aks", "gg") or not isinstance(app_id, str) or not app_id.isascii()
                or not app_id.isdigit() or not 0 < int(app_id) < 10000000000
                or request.get("priority", "background") not in ("foreground", "background")):
            raise ValueError("Invalid product")
        now = time.time()
        key = (provider, app_id)
        entry = self.entry_copy(self.cache(provider).get(app_id))
        response = {"protocol": PROTOCOL, "provider": provider, "app_id": app_id, "entry": entry,
                    "pending": False, "retry_after": 3, "queue": len(self.pending)}
        if entry and 0 <= now - entry["checked_at"] < 1800:
            return response
        if provider == "gg" and not self.engine._gg_api_key:
            return {**response, "failure": {"global_error": True, "error": "A szerveren nincs beállítva GG.deals API-kulcs."}, "retry_after": 60}
        self.failures = {k: v for k, v in self.failures.items() if v[0] > now}
        failure = self.failures.get(key)
        if failure:
            return {**response, "failure": failure[1], "retry_after": max(1, failure[0] - now)}
        cooldown = self.cooldown(provider)
        if cooldown > now:
            message = self.engine._gg_last_error if provider == "gg" else self.engine._price_last_error
            return {**response, "failure": {"global_error": True, "error": message or "Az árforrás várakozást kér."}, "retry_after": cooldown - now}
        priority = 0 if request.get("priority") == "foreground" else 1
        if key not in self.pending:
            if len(self.pending) >= MAX_QUEUE:
                return {**response, "failure": {"global_error": True, "error": "A szerver lekérési sora megtelt."}, "retry_after": 15}
            self.sequence += 1
            self.pending[key] = (priority, self.sequence)
        else:
            old_priority, sequence = self.pending[key]
            self.pending[key] = (min(priority, old_priority), sequence)
        self.wake.set()
        ahead = sum(value < self.pending[key] for value in self.pending.values())
        return {**response, "pending": True, "queue": len(self.pending), "retry_after": min(30, max(3, ahead * 2))}

    async def run(self):
        while not self.stopping:
            ready = [key for key in self.pending if self.cooldown(key[0]) <= time.time()]
            if not ready:
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), 2)
                except asyncio.TimeoutError:
                    pass
                continue
            key = min(ready, key=lambda candidate: self.pending[candidate])
            self.current = key
            provider, app_id = key
            try:
                # One worker means this provider selection cannot race another lookup.
                self.engine._price_preferences["provider"] = provider
                result = await self.engine._get_allkeyshop_price(app_id)
                if not result.get("success"):
                    delay = max(1, result.get("retry_after", 30))
                    self.failures[key] = (time.time() + delay, {
                        "global_error": result.get("global_error") is True,
                        "error": str(result.get("error", "Az árlekérés sikertelen."))[:500]})
                    while len(self.failures) > 512:
                        self.failures.pop(next(iter(self.failures)))
            except Exception:
                # No request headers, URLs, provider credentials or exception body in logs.
                LOG.error("Price job failed")
                self.failures[key] = (time.time() + 30, {"global_error": False, "error": "Szerveroldali feldolgozási hiba."})
            finally:
                self.pending.pop(key, None)
                self.current = None
            await asyncio.sleep(0)

    async def merchants(self, request):
        if not isinstance(request, dict) or set(request) - {"refresh"} or type(request.get("refresh", False)) is not bool:
            raise ValueError("Invalid request")
        now = time.time()
        due = request.get("refresh") or now - self.engine._price_merchants_checked_at >= 86400
        if (due and now >= max(self.directory_retry, self.cooldown("aks"))
                and (self.directory_task is None or self.directory_task.done())):
            self.directory_retry = now + 60
            self.directory_task = asyncio.create_task(self.refresh_directory())
        return {"protocol": PROTOCOL, "merchants": sorted(self.engine._price_merchants),
                "pending": bool(self.directory_task and not self.directory_task.done())}

    async def refresh_directory(self):
        try:
            await self.engine.get_price_merchants(True)
        except Exception:
            LOG.warning("Merchant directory refresh failed")
        finally:
            self.engine._schedule_price_save()

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
