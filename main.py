"""Decky backend for ControllerXbox.

Steam app IDs supplied by the frontend are checked, including the library scan
for the optional Hungarian collection. The Steam Store, NVIDIA GeForce NOW,
and Boosteroid catalog endpoints, including the Magyar Felirat curator list,
are public and require no API key.
"""

import asyncio
import concurrent.futures
import email.utils
import functools
import html
import json
import os
import random
import re
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import decky

try:
    import certifi
except ImportError:
    certifi = None


CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
PRICE_TTL_SECONDS = 24 * 60 * 60
PRICE_METADATA_TTL_SECONDS = 86400
AKS_MATCH_TTL_SECONDS = 7 * 86400
AKS_CATALOG_TTL_SECONDS = 86400
AKS_CATALOG_URL = "https://www.allkeyshop.com/api/v2/vaks.php?action=gameNames&currency=eur"
AKS_REQUEST_GAP_SECONDS = 1.5
CACHE_SCHEMA_VERSION = 6
STORE_URL = "https://store.steampowered.com/api/appdetails?appids={app_id}&l=english&cc=us"
PRICE_MERCHANT_CHOICES = ("YUPLAY", "GAMESEAL", "GAMIVO", "G2A", "Kinguin", "Eneba", "HRK")
AKS_HISTORY_VERSION = 2
HUNGARIAN_CURATOR_ID = "34235089"
HUNGARIAN_CURATOR_URL = "https://store.steampowered.com/curator/34235089/ajaxgetfilteredrecommendations/?start={start}&count=100&l=english&cc=us&filter=all"
HUNGARIAN_CURATOR_TTL_SECONDS = 24 * 60 * 60
HUNGARIAN_CURATOR_RETRY_SECONDS = 15 * 60
GFN_CACHE_TTL_SECONDS = 24 * 60 * 60
GFN_URL = "https://api-prod.nvidia.com/services/gfngames/v1/gameList"
BOOSTEROID_CACHE_TTL_SECONDS = 15 * 60
BOOSTEROID_CACHE_SCHEMA_VERSION = 3
SETTINGS_SCHEMA_VERSION = 1
NOTIFICATION_SCHEMA_VERSION = 1
WATCHLIST_SCHEMA_VERSION = 1
NOTIFICATION_HISTORY_SCHEMA_VERSION = 1
WATCHLIST_MAX_ENTRIES = 200
NOTIFICATION_HISTORY_MAX_ENTRIES = 100
BOOSTEROID_URL = "https://cloud.boosteroid.com/api/v1/public/applications?page={page}&platforms=6"
STEAM_SEARCH_URL = "https://store.steampowered.com/api/storesearch/?term={term}&l=english&cc=us"
BOOSTEROID_STEAM_APP_ID_OVERRIDES = {
    303: "1172620",  # Sea of Thieves: 2025 Edition (delisted title variant)
    721: "1293830",  # Forza Horizon 4 (delisted from Steam search)
}
GITHUB_REPOSITORY = "Rannius/ControllerXbox"
GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/{}/releases/latest".format(GITHUB_REPOSITORY)
GITHUB_RELEASE_TAG_URL = "https://api.github.com/repos/{}/releases/tags/v{{}}".format(GITHUB_REPOSITORY)
GITHUB_DOWNLOAD_PREFIX = "https://github.com/{}/releases/download/".format(GITHUB_REPOSITORY)
UPDATE_MAX_BYTES = 15 * 1024 * 1024
PLUGIN_MANIFEST_NAMES = {"ControllerXbox", "Deck Play Badges"}
UPDATE_FILES = [
    ".gitignore",
    "LICENSE",
    "README.md",
    "main.py",
    "package.json",
    "plugin.json",
    "pnpm-lock.yaml",
    "dist/index.js",
    "dist/index.js.map",
]


class HungarianCuratorParser:
    """Read Steam recommendation fragments using modules bundled with Decky.

    Decky's frozen Python does not include html.parser or _markupbase. This
    tokenizer only needs tags and attributes; div nesting isolates each card.
    """

    _tags = re.compile(r"<!--.*?-->|<(/?)([A-Za-z][\w:-]*)((?:[^>'\"]|'[^']*'|\"[^\"]*\")*)>", re.S)
    _attributes = re.compile(r"([^\s=/>]+)(?:\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'=<>`]+)))?")

    def __init__(self) -> None:
        self.records: List[Dict[str, Any]] = []
        self._depth = 0
        self._record: Optional[Dict[str, Any]] = None
        self._fragments: List[str] = []

    def feed(self, fragment: str) -> None:
        self._fragments.append(fragment)

    def close(self) -> None:
        raw_tag = ""
        for match in self._tags.finditer("".join(self._fragments)):
            closing, tag, attribute_text = match.groups()
            if tag is None:  # Comment, including any fake cards inside it.
                continue
            tag = tag.lower()
            if raw_tag:
                if closing and tag == raw_tag:
                    raw_tag = ""
                continue
            if tag in {"script", "style"} and not closing:
                raw_tag = tag
                continue
            if closing:
                self.handle_endtag(tag)
                continue
            attrs = []
            for attribute in self._attributes.finditer(attribute_text):
                name, double_quoted, single_quoted, unquoted = attribute.groups()
                value = next((part for part in (double_quoted, single_quoted, unquoted) if part is not None), "")
                attrs.append((name.lower(), html.unescape(value)))
            self.handle_starttag(tag, attrs)
            if attribute_text.rstrip().endswith("/"):
                self.handle_endtag(tag)
        self._fragments.clear()

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        attributes = dict(attrs)
        classes = (attributes.get("class") or "").split()
        if tag == "div":
            if self._record is None and "recommendation" in classes:
                self._record = {"app_ids": set(), "recommended": False, "curator_link": False}
                self._depth = 1
            elif self._record is not None:
                self._depth += 1
        if self._record is None:
            return
        app_id = attributes.get("data-ds-appid") or ""
        if app_id.isdigit() and int(app_id) > 0:
            self._record["app_ids"].add(app_id)
        if "color_recommended" in classes:
            self._record["recommended"] = True
        href = attributes.get("href") or ""
        if tag == "a" and "curator_clanid=" + HUNGARIAN_CURATOR_ID in href:
            self._record["curator_link"] = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "div" and self._record is not None:
            self._depth -= 1
            if self._depth == 0:
                self.records.append(self._record)
                self._record = None


class Plugin:
    def __init__(self) -> None:
        self._price_connection = {"mode": "direct", "url": ""}
        self._price_server_token = ""
        self._price_server_retry_at = 0.0
        self._price_server_failures = 0
        self._price_server_error = ""
        self._price_server_error_code = "server"
        self._price_server_queue = 0
        self._price_preferences = {"enabled": True, "allow_gifts": True, "merchants": []}
        self._price_merchants: Set[str] = set()
        self._price_merchants_checked_at = 0.0
        self._price_merchants_lock = asyncio.Lock()
        self._price_cache: Dict[str, Dict[str, Any]] = {}
        self._gg_cache: Dict[str, Dict[str, Any]] = {}
        self._gg_api_key = ""
        self._gg_requests: List[float] = []
        self._gg_retry_at = 0.0
        self._gg_failures = 0
        self._gg_last_error = ""
        self._aks_matches: Dict[str, Dict[str, Any]] = {}
        self._aks_catalog: Dict[str, Optional[str]] = {}
        self._aks_catalog_checked_at = 0.0
        self._price_metadata: Dict[str, Dict[str, Any]] = {}
        self._price_tasks: Dict[str, asyncio.Task] = {}
        self._price_save_task: Optional[asyncio.Task] = None
        self._price_save_dirty = False
        self._price_lock = asyncio.Lock()
        self._price_disk_lock = asyncio.Lock()
        self._price_foreground_waiters = 0
        self._price_epoch = 0
        self._price_stopping = False
        self._price_wishlist: List[str] = []
        self._price_wishlist_owner = ""
        self._price_wishlist_lease = 0.0
        self._price_wishlist_retry: Dict[str, float] = {}
        self._price_wishlist_attempts: Dict[str, float] = {}
        self._price_wishlist_task: Optional[asyncio.Task] = None
        self._price_wishlist_current = ""
        self._price_wishlist_error = ""
        self._price_disk_error = ""
        self._price_last_error = ""
        self._aks_request_lock = threading.Lock()
        self._aks_next_request_at = 0.0
        self._aks_http_failures = 0
        self._aks_pause_until = 0.0
        self._price_service_error: Optional[Dict[str, Any]] = None
        self._price_service_retry_at = 0.0
        self._price_service_failures = 0
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._steam_backoff_until = 0.0
        self._steam_failures = 0
        self._steam_error_lock = threading.Lock()
        self._steam_gate = asyncio.Semaphore(4)
        self._steam_tasks: Dict[str, asyncio.Task] = {}
        self._steam_retry: Dict[str, Dict[str, float]] = {}
        self._steam_scan_epoch = time.time()
        self._steam_state_lock = asyncio.Lock()
        self._steam_stopping = False
        self._catalog_pending: Dict[str, Dict[str, float]] = {"gfn": {}, "boosteroid": {}}
        self._hungarian_curator_app_ids: Set[str] = set()
        self._hungarian_curator_checked_at = 0.0
        self._hungarian_curator_attempted_at = 0.0
        self._hungarian_curator_last_error = ""
        self._hungarian_curator_task: Optional[asyncio.Task] = None
        self._hungarian_curator_progress = {"checked": 0, "total": 0}
        self._gfn_app_ids: Set[str] = set()
        self._gfn_checked_at = 0.0
        self._gfn_last_error = ""
        self._gfn_attempted_at = 0.0
        self._boosteroid_app_ids: Set[str] = set()
        self._boosteroid_maintenance_app_ids: Set[str] = set()
        self._boosteroid_checked_at = 0.0
        self._boosteroid_last_error = ""
        self._boosteroid_attempted_at = 0.0
        self._settings: Dict[str, Any] = {
            "library_badge_percent": 100,
            "store_badge_percent": 100,
            "store_badge_sides": {},
            "show_store_tile_prices": False,
            "show_gfn_badges": True,
            "show_boosteroid_badges": True,
            "show_hungarian_badges": True,
            "notify_gfn_additions": True,
            "notify_boosteroid_additions": True,
            "notify_boosteroid_maintenance": True,
            "notify_plugin_updates": True,
        }
        # Recent Decky versions expose the settings directory as
        # ``decky_SETTINGS_DIR``.  Keep the older name as a fallback so a
        # manually installed plugin works on both Loader generations.
        settings_directory = getattr(decky, "decky_SETTINGS_DIR", None) or getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", None)
        if not settings_directory:
            raise RuntimeError("Decky settings directory is unavailable")
        self._price_connection_path = Path(settings_directory) / "price-connection.json"
        self._price_cache_path = Path(settings_directory) / "allkeyshop-price-cache.json"
        self._price_settings_path = Path(settings_directory) / "price-preferences.json"
        self._price_merchants_path = Path(settings_directory) / "price-merchants.json"
        self._steam_state_path = Path(settings_directory) / "steam-scan-state.json"
        self._cache_path = Path(settings_directory) / "controller-support-cache.json"
        self._hungarian_curator_cache_path = Path(settings_directory) / "hungarian-curator-cache.json"
        self._gfn_cache_path = Path(settings_directory) / "geforce-now-catalog-cache.json"
        self._boosteroid_cache_path = Path(settings_directory) / "boosteroid-catalog-cache.json"
        self._settings_path = Path(settings_directory) / "controller-xbox-settings.json"
        self._notification_state_path = Path(settings_directory) / "controller-xbox-notifications.json"
        self._watchlist_path = Path(settings_directory) / "controller-xbox-watchlist.json"
        self._notification_history_path = Path(settings_directory) / "controller-xbox-notification-history.json"
        self._watchlist: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._gfn_lock = asyncio.Lock()
        self._boosteroid_lock = asyncio.Lock()
        self._update_lock = asyncio.Lock()
        self._notification_lock = asyncio.Lock()
        self._watchlist_lock = asyncio.Lock()

    async def _main(self) -> None:
        await self._load_price_connection()
        await self._load_price_preferences()
        await self._load_price_merchants()
        await self._load_price_cache()
        await self._load_cache()
        await self._load_steam_scan_state()
        await self._load_hungarian_curator_cache()
        await self._load_gfn_cache()
        await self._load_boosteroid_cache()
        await self._load_settings()
        await self._load_watchlist()
        decky.logger.info("ControllerXbox backend loaded")

    async def _unload(self) -> None:
        self._price_stopping = True
        self._price_wishlist_lease = 0
        if self._price_wishlist_task:
            await self._price_wishlist_task
        await asyncio.gather(*list(self._price_tasks.values()), return_exceptions=True)
        if self._price_save_task:
            await self._price_save_task
        await self._save_price_cache()
        self._steam_stopping = True
        await asyncio.gather(*list(self._steam_tasks.values()), return_exceptions=True)
        await self._save_steam_scan_state()
        await self._stop_hungarian_curator_refresh()
        await self._save_cache()
        await self._save_gfn_cache()
        await self._save_boosteroid_cache()
        await self._save_settings()
        await self._save_watchlist()

    @staticmethod
    def _valid_pending(value: Any) -> Dict[str, float]:
        if not isinstance(value, dict):
            return {}
        now = time.time()
        return {str(key): float(stamp) for key, stamp in value.items()
                if str(key).isdigit() and type(stamp) in (int, float) and 0 < stamp <= now}

    async def _accept_catalog(self, provider: str, fetched: Set[str], maintenance: Optional[Set[str]] = None) -> None:
        old = getattr(self, "_" + provider + "_app_ids")
        missing = old - fetched
        if not fetched or len(missing) > max(10, len(old) * 0.2):
            raise ValueError("Suspicious catalog loss; retaining previous snapshot")
        now = time.time()
        previous = self._catalog_pending[provider]
        # Two successful snapshots, at least 15 minutes apart. A cache hit or
        # repeated manual click is never a second independent confirmation.
        pending = {app_id: previous.get(app_id, now) for app_id in missing
                   if app_id not in previous or now - previous[app_id] < 900}
        accepted = fetched | set(pending)
        payload = {"checked_at": now, "steam_app_ids": sorted(accepted), "pending_removals": pending}
        accepted_maintenance: Set[str] = set()
        if provider == "boosteroid":
            accepted_maintenance = (maintenance or set()) | (self._boosteroid_maintenance_app_ids & set(pending))
            payload.update({"schema_version": BOOSTEROID_CACHE_SCHEMA_VERSION,
                            "maintenance_app_ids": sorted(accepted_maintenance)})
        await self._run_blocking(self._write_file_atomically, getattr(self, "_" + provider + "_cache_path"),
                                 provider + "-cache-", json.dumps(payload, separators=(",", ":")))
        setattr(self, "_" + provider + "_app_ids", accepted)
        setattr(self, "_" + provider + "_checked_at", now)
        setattr(self, "_" + provider + "_last_error", "")
        self._catalog_pending[provider] = pending
        if provider == "boosteroid":
            self._boosteroid_maintenance_app_ids = accepted_maintenance

    async def get_catalog_status(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {"success": True}
        for provider, ttl in (("gfn", GFN_CACHE_TTL_SECONDS), ("boosteroid", BOOSTEROID_CACHE_TTL_SECONDS)):
            checked = getattr(self, "_" + provider + "_checked_at")
            error = getattr(self, "_" + provider + "_last_error")
            result[provider] = {"checked_at": checked, "error": error,
                                "stale": bool(error or not checked or time.time() - checked >= ttl),
                                "entries": len(getattr(self, "_" + provider + "_app_ids")),
                                "pending_removals": len(self._catalog_pending[provider])}
        return result

    async def _load_steam_scan_state(self) -> None:
        try:
            parsed = json.loads(await self._run_blocking(lambda: self._steam_state_path.read_text(encoding="utf-8")))
            if not isinstance(parsed, dict) or parsed.get("schema_version") != 1:
                return
            now = time.time()
            entries = parsed.get("retry", {})
            if isinstance(entries, dict):
                for key, value in entries.items():
                    if (str(key).isdigit() and isinstance(value, dict)
                            and type(value.get("attempted_at")) in (int, float)
                            and type(value.get("retry_at")) in (int, float)
                            and 0 < value["attempted_at"] <= now
                            and value["attempted_at"] <= value["retry_at"] <= now + 3600):
                        self._steam_retry[str(key)] = value
            backoff = parsed.get("backoff_until", 0)
            if type(backoff) in (int, float) and now < backoff <= now + 3600:
                self._steam_backoff_until = backoff
            failures = parsed.get("failures", 0)
            if type(failures) is int and 0 <= failures <= 100:
                self._steam_failures = failures
            epoch = parsed.get("epoch")
            if type(epoch) in (int, float) and 0 < epoch <= now:
                self._steam_scan_epoch = epoch
        except (OSError, ValueError, TypeError) as error:
            decky.logger.debug("Steam scan state could not be loaded: %s", error)

    async def _save_steam_scan_state(self) -> None:
        async with self._steam_state_lock:
            payload = json.dumps({"schema_version": 1, "epoch": self._steam_scan_epoch,
                                  "backoff_until": self._steam_backoff_until, "failures": self._steam_failures,
                                  "retry": self._steam_retry}, separators=(",", ":"))
            await self._run_blocking(self._write_file_atomically, self._steam_state_path, "steam-scan-", payload)

    async def _get_support_shared(self, app_id: str, max_age: float = CACHE_TTL_SECONDS) -> Optional[Dict[str, Any]]:
        if self._steam_stopping:
            return None
        task = self._steam_tasks.get(app_id)
        if task is None:
            task = asyncio.create_task(self._lookup_and_save_support(app_id, self._steam_scan_epoch, max_age))
            self._steam_tasks[app_id] = task
            def completed(done: asyncio.Task) -> None:
                if self._steam_tasks.get(app_id) is done:
                    self._steam_tasks.pop(app_id, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(completed)
        try:
            return await asyncio.shield(task)
        finally:
            if task.done() and self._steam_tasks.get(app_id) is task:
                self._steam_tasks.pop(app_id, None)

    async def _lookup_and_save_support(self, app_id: str, epoch: float, max_age: float = CACHE_TTL_SECONDS) -> Optional[Dict[str, Any]]:
        async with self._steam_gate:
            if self._steam_stopping or epoch != self._steam_scan_epoch:
                return None
            entry = self._cache.get(app_id)
            now = time.time()
            if isinstance(entry, dict) and self._is_fresh(entry, now) and now - entry["checked_at"] < max_age and entry.get("controller_support_level") in {"full", "partial", "none"}:
                return entry
            if self._steam_retry.get(app_id, {}).get("retry_at", 0) > now or self._steam_backoff_until > now:
                return None
            details = await self._run_blocking(self._fetch_support, app_id)
            if epoch != self._steam_scan_epoch or self._steam_stopping:
                return None
            now = time.time()
            async with self._lock:
                if details is not None:
                    self._cache[app_id] = {"schema_version": CACHE_SCHEMA_VERSION, **details, "checked_at": now}
                    self._steam_retry.pop(app_id, None)
                    if now >= self._steam_backoff_until:
                        self._steam_failures = 0
                else:
                    self._steam_retry[app_id] = {"attempted_at": now,
                        "retry_at": self._steam_backoff_until if self._steam_backoff_until > now else now + 900}
            if details is not None:
                await self._save_cache()
            await self._save_steam_scan_state()
            return details

    def _price_result(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        if entry.get("skipped"):
            return {"success": True, "skipped": entry["skipped"], "title": entry["title"],
                    "checked_at": entry["checked_at"], "offers": []}
        history = entry.get("source") == "aks_history"
        filtering: Dict[str, int] = {}
        offers = (self._aks_history_filter(entry["data"], self._price_preferences, filtering) if history
                  else self._aks_filter(entry["data"], self._price_preferences))
        return {"success": True, "provider": "aks", "offers": offers[:1], "matched_offers": len(offers),
                "filtering": filtering,
                "not_found": entry.get("not_found") is True, "match_status": entry.get("match_status", ""),
                "source": entry.get("source", "aks_page"), "source_updated_at": entry.get("source_updated_at", ""),
                "title": entry["title"], "url": entry["url"], "checked_at": entry["checked_at"],
                "currency": "EUR", "preferred_only": self._price_preferences.get("restrict_merchants", bool(self._price_preferences["merchants"]))}

    @staticmethod
    def _valid_price_entry(entry: Any) -> bool:
        if (not isinstance(entry, dict) or "error" in entry or not isinstance(entry.get("title"), str)
                or type(entry.get("checked_at")) not in (int, float)
                or not 0 < entry["checked_at"] <= time.time() + 60):
            return False
        if "skipped" in entry:
            return entry["skipped"] in ("free", "unreleased", "release_unknown")
        data = entry.get("data")
        valid_url = isinstance(entry.get("url"), str) and bool(re.fullmatch(
            r"https://www\.allkeyshop\.com/blog/(?:buy-|compare-and-buy-cd-key-for-digital-download-)[a-z0-9-]+/", entry["url"]))
        return ((valid_url or (entry.get("source") == "aks_history" and entry.get("url") == "https://www.allkeyshop.com/"))
            and isinstance(data, dict) and isinstance(data.get("prices"), list)
            and all(isinstance(data.get(key), dict) for key in ("merchants", "regions", "editions")))

    async def _load_price_cache(self) -> None:
        try:
            def read() -> str:
                if self._price_cache_path.stat().st_size > 64 * 1024 * 1024:
                    raise ValueError("Price cache too large")
                return self._price_cache_path.read_text(encoding="utf-8")
            payload = json.loads(await self._run_blocking(read))
            if not isinstance(payload, dict) or payload.get("version") != 1 or not isinstance(payload.get("entries"), dict):
                return
            self._price_cache = {key: value for key, value in list(payload["entries"].items())[-10000:]
                                 if key.isdigit() and 0 < int(key) < 10000000000 and self._valid_price_entry(value)
                                 and (value.get("source") != "aks_history" or value.get("history_version") == AKS_HISTORY_VERSION)}
            gg = payload.get("gg_entries", {})
            if isinstance(gg, dict):
                self._gg_cache = {k: v for k, v in list(gg.items())[-10000:]
                                  if k.isdigit() and 0 < int(k) < 10000000000 and self._valid_gg_entry(v)}
            limits = payload.get("gg_requests", [])
            if isinstance(limits, list):
                self._gg_requests = [v for v in limits[-1000:] if type(v) in (int, float) and 0 <= time.time() - v < 3600]
            aks_retry = payload.get("aks_retry_at", 0)
            if type(aks_retry) in (int, float) and time.time() < aks_retry < float("inf"):
                self._price_service_retry_at = aks_retry
                self._aks_pause_until = time.monotonic() + (aks_retry - time.time())
                self._price_service_error = {"error": "AllKeyShop: korábban kért lekérési szünet.", "error_code": "rate_limit", "global_error": True}
            retry = payload.get("gg_retry_at", 0)
            if type(retry) in (int, float) and retry > 0:
                self._gg_retry_at = retry
            now = time.time()
            # Older cache files can seed matches, but never extend their original age.
            candidates = payload.get("matches")
            if "matches" not in payload:
                candidates = {k: v for k, v in self._price_cache.items() if v.get("url")}
            if not isinstance(candidates, dict):
                candidates = {}
            self._aks_matches = {k: {f: v[f] for f in ("title", "url", "checked_at", "product_id") if f in v}
                                 for k, v in list(candidates.items())[-10000:] if self._valid_aks_match(k, v, now)}
            metadata = payload.get("metadata", {})
            if isinstance(metadata, dict):
                self._price_metadata = {k: v for k, v in list(metadata.items())[-10000:]
                                        if self._valid_price_metadata(k, v, now)}
        except (OSError, ValueError, TypeError):
            decky.logger.debug("AllKeyShop cache unavailable; starting empty")

    @staticmethod
    def _valid_aks_match(key: Any, value: Any, now: float) -> bool:
        return (isinstance(key, str) and key.isdigit() and 0 < int(key) < 10000000000
                and isinstance(value, dict) and isinstance(value.get("title"), str) and bool(value["title"])
                and type(value.get("checked_at")) in (int, float)
                and 0 <= now - value["checked_at"] < AKS_MATCH_TTL_SECONDS
                and ((isinstance(value.get("product_id"), str) and value["product_id"].isdigit()
                      and 0 < int(value["product_id"]) < 10000000000)
                or (isinstance(value.get("url"), str) and bool(re.fullmatch(
                    r"https://www\.allkeyshop\.com/blog/(?:buy-|compare-and-buy-cd-key-for-digital-download-)[a-z0-9-]+/", value["url"]))
                and "account" not in value["url"])))

    @staticmethod
    def _valid_price_metadata(key: Any, value: Any, now: float) -> bool:
        return (isinstance(key, str) and key.isdigit() and 0 < int(key) < 10000000000
                and isinstance(value, dict) and value.get("app_id") == key
                and isinstance(value.get("title"), str) and 0 < len(value["title"]) <= 200
                and type(value.get("is_free")) is bool
                and (value.get("coming_soon") is None or type(value["coming_soon"]) is bool)
                and type(value.get("checked_at")) in (int, float)
                and 0 <= now - value["checked_at"] < PRICE_METADATA_TTL_SECONDS)

    async def _save_price_cache(self) -> None:
        async with self._price_disk_lock:
            # Values are immutable snapshots. Encode/filter on the worker, not Steam's event loop.
            entries, matches, metadata = self._price_cache.copy(), self._aks_matches.copy(), self._price_metadata.copy()
            gg, requests, retry = self._gg_cache.copy(), self._gg_requests[:], self._gg_retry_at
            remaining = self._aks_pause_until - time.monotonic()
            aks_retry = max(self._price_service_retry_at, time.time() + remaining if remaining > 0 else 0)
            def write() -> None:
                valid = {key: value for key, value in entries.items() if self._valid_price_entry(value)}
                valid = {key: ({**value, "data": {field: value["data"][field] for field in
                         ("prices", "merchants", "regions", "editions")}} if "data" in value else value)
                         for key, value in valid.items()}
                now = time.time()
                payload = json.dumps({"version": 1, "entries": valid,
                    "gg_entries": {k: v for k, v in gg.items() if self._valid_gg_entry(v)},
                    "gg_requests": requests, "gg_retry_at": retry, "aks_retry_at": aks_retry,
                    "matches": {k: v for k, v in matches.items() if self._valid_aks_match(k, v, now)},
                    "metadata": {k: v for k, v in metadata.items() if self._valid_price_metadata(k, v, now)}}, ensure_ascii=False)
                if len(payload.encode("utf-8")) > 64 * 1024 * 1024:
                    raise OSError("Price cache exceeds disk limit")
                self._write_file_atomically(self._price_cache_path, "aks-cache-", payload)
            try:
                await self._run_blocking(write)
                self._price_disk_error = ""
            except OSError:
                self._price_disk_error = "Az árgyorsítótár lemezre mentése sikertelen."
                decky.logger.warning(self._price_disk_error)

    def _schedule_price_save(self) -> None:
        self._price_save_dirty = True
        if self._price_save_task is None or self._price_save_task.done():
            self._price_save_task = asyncio.create_task(self._flush_price_saves())

    async def _flush_price_saves(self) -> None:
        while self._price_save_dirty:
            await asyncio.sleep(0.25)
            self._price_save_dirty = False
            await self._save_price_cache()
            try:
                await self._save_price_merchants()
            except OSError:
                decky.logger.debug("Could not save discovered price merchants")

    async def get_cached_allkeyshop_price(self, app_id: Any) -> Dict[str, Any]:
        # No network and no price lock: a slow background lookup must not delay display.
        if not self._price_preferences["enabled"]:
            return {"success": True, "disabled": True}
        entry = self._effective_price_entry(str(app_id))
        if not entry or "error" in entry:
            return {"success": True, "missing": True}
        return {**self._active_price_result(entry), "stale": time.time() - entry["checked_at"] >= PRICE_TTL_SECONDS}

    async def clear_price_cache(self) -> Dict[str, Any]:
        self._price_epoch += 1
        self._price_cache.clear()
        self._gg_cache.clear()
        self._aks_matches.clear()
        self._price_metadata.clear()
        self._price_wishlist_retry.clear()
        self._price_wishlist_attempts.clear()
        await self._save_price_cache()
        return {"success": True, **self._price_stats()}

    def _price_stats(self) -> Dict[str, Any]:
        now = time.time()
        valid = {key: value for key, value in self._active_price_cache().items() if "error" not in value}
        fresh = {key for key, value in valid.items() if now - value["checked_at"] < PRICE_TTL_SECONDS}
        wishlist = set(self._price_wishlist)
        return {"price_connection": self._price_connection["mode"], "price_server_queue": self._price_server_queue,
                "price_provider": self._price_preferences.get("provider", "aks"),
                "price_metadata_entries": len(self._price_metadata), "price_match_entries": len(self._aks_matches),
                "price_entries": len(valid), "price_fresh_entries": len(fresh),
                "price_wishlist_total": len(wishlist), "price_wishlist_ready": len(wishlist & fresh),
                "price_wishlist_skipped": sum(bool(valid[key].get("skipped")) for key in wishlist & fresh),
                "price_wishlist_current": self._price_wishlist_current,
                "price_wishlist_deferred": sum(self._price_wishlist_retry.get(key, 0) > now for key in wishlist - fresh),
                "price_wishlist_active": self._price_preferences["enabled"] and time.monotonic() < self._price_wishlist_lease,
                "price_retry_after": max(0, int(self._active_price_retry_at() - now)),
                "price_wishlist_error": self._price_wishlist_error,
                "price_last_error": self._price_server_error if self._price_connection["mode"] == "server" else (
                    self._gg_last_error if self._price_preferences.get("provider") == "gg" else self._price_last_error),
                "price_disk_error": self._price_disk_error}

    async def get_price_cache_stats(self) -> Dict[str, Any]:
        return {"success": True, **self._price_stats()}

    async def sync_price_wishlist(self, owner: Any, app_ids: Any, error: Any = "") -> Dict[str, Any]:
        if (not isinstance(owner, str) or (owner and not re.fullmatch(r"\d{17}", owner))
                or not isinstance(app_ids, list) or len(app_ids) > 10000
                or any(not str(key).isdigit() or not 0 < int(str(key)) < 10000000000 for key in app_ids)):
            return {"success": False, "error": "Érvénytelen kívánságlista."}
        if owner != self._price_wishlist_owner:
            self._price_wishlist_retry.clear()
            self._price_wishlist_attempts.clear()
        self._price_wishlist_owner = owner
        self._price_wishlist_error = str(error)[:200] if isinstance(error, str) else ""
        self._price_wishlist = list(dict.fromkeys(str(key) for key in app_ids)) if owner else []
        self._price_wishlist_lease = time.monotonic() + 90 if owner else 0
        if self._price_wishlist and (self._price_wishlist_task is None or self._price_wishlist_task.done()):
            self._price_wishlist_task = asyncio.create_task(self._price_wishlist_worker())
        return {"success": True, **self._price_stats()}

    async def _price_wishlist_step(self) -> bool:
        if (self._price_stopping or not self._price_preferences["enabled"] or self._price_foreground_waiters
                or self._price_lock.locked() or time.monotonic() >= self._price_wishlist_lease
                or time.time() < self._active_price_retry_at()):
            return False
        now = time.time()
        # Unknown games first, then oldest entries: large lists must not keep
        # refreshing their first items while the tail has never been checked.
        for app_id in sorted(self._price_wishlist, key=lambda key: max(
                (self._effective_price_entry(key) or {}).get("checked_at", 0), self._price_wishlist_attempts.get(key, 0))):
            entry = self._effective_price_entry(app_id)
            if entry and "error" not in entry and now - entry["checked_at"] < PRICE_TTL_SECONDS:
                continue
            if self._price_wishlist_retry.get(app_id, 0) > now:
                continue
            self._price_wishlist_current = app_id
            self._price_wishlist_attempts[app_id] = now
            epoch = self._price_epoch
            try:
                result = await self._get_allkeyshop_price(app_id)
                if epoch == self._price_epoch:
                    if result.get("pending"):
                        self._price_wishlist_retry[app_id] = time.time() + result.get("retry_after", 3)
                    elif not result.get("success") and not result.get("global_error"):
                        self._price_wishlist_retry[app_id] = time.time() + 1800
            finally:
                self._price_wishlist_current = ""
            return True
        return False

    async def _price_wishlist_worker(self) -> None:
        while not self._price_stopping and time.monotonic() < self._price_wishlist_lease:
            try:
                progressed = await self._price_wishlist_step()
            except Exception as error:
                progressed = False
                decky.logger.warning("Wishlist price prefetch failed: %s", error)
                self._price_service_retry_at = max(self._price_service_retry_at, time.time() + 60)
            # Only idle polling sleeps; successful work is paced by the HTTP gate.
            await asyncio.sleep(0 if progressed else 2)

    @staticmethod
    def _valid_price_server_url(value: Any) -> str:
        if not isinstance(value, str) or len(value) > 250:
            raise ValueError("Invalid server URL")
        parsed = urllib.parse.urlparse(value.strip())
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", parsed.hostname)
                or (parsed.port is not None and not 1 <= parsed.port <= 65535)):
            raise ValueError("Invalid server URL")
        return "https://" + parsed.netloc.lower()

    async def _load_price_connection(self) -> None:
        try:
            value = json.loads(await self._run_blocking(lambda: self._price_connection_path.read_text(encoding="utf-8")))
            if not isinstance(value, dict):
                return
            url = self._valid_price_server_url(value["url"]) if value.get("url") else ""
            token = value.get("token", "")
            if not isinstance(token, str) or (token and not re.fullmatch(r"[A-Za-z0-9_-]{24,200}", token)):
                return
            self._price_connection = {"mode": "server" if value.get("mode") == "server" and url and token else "direct", "url": url}
            self._price_server_token = token
        except (OSError, ValueError, KeyError, TypeError):
            pass

    async def get_price_connection(self) -> Dict[str, Any]:
        return {"success": True, **self._price_connection, "token_configured": bool(self._price_server_token)}

    async def set_price_connection(self, mode: Any, url: Any, token: Any = None) -> Dict[str, Any]:
        try:
            if mode not in ("direct", "server"):
                raise ValueError("Invalid mode")
            address = self._valid_price_server_url(url) if url else ""
            if token is not None and (not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{24,200}", token)):
                raise ValueError("Invalid token")
            # Changing hosts requires an explicit new token; do not forward an existing secret to another host.
            if address != self._price_connection["url"] and token is None:
                key = ""
            else:
                key = self._price_server_token if token is None else token
            if mode == "server" and (not address or not key):
                raise ValueError("Missing settings")
            value = {"mode": mode, "url": address, "token": key}
            await self._run_blocking(self._write_file_atomically, self._price_connection_path, "price-connection-", json.dumps(value))
        except (ValueError, OSError):
            return {"success": False, "error": "HTTPS szervercím és legalább 24 karakteres hozzáférési token szükséges. Új címhez add meg a hozzá tartozó tokent."}
        self._price_connection = {"mode": mode, "url": address}
        self._price_server_token = key
        self._price_epoch += 1
        self._price_server_retry_at = 0
        self._price_server_failures = 0
        self._price_server_error = ""
        self._price_server_queue = 0
        self._price_wishlist_retry.clear()
        return await self.get_price_connection()

    def _price_server_request(self, address: str, token: str, path: str, data: Any = None) -> Dict[str, Any]:
        if path not in ("/v1/price", "/v1/status", "/v1/merchants"):
            raise ValueError("Invalid server endpoint")
        address = self._valid_price_server_url(address)
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
                raise urllib.error.HTTPError(req.full_url, code, "Redirect refused", headers, fp)
        context = ssl.create_default_context(cafile=certifi.where()) if certifi else ssl.create_default_context()
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), NoRedirect())
        request = urllib.request.Request(address + path, data=json.dumps(data).encode("utf-8") if data is not None else None,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": "Deck Play Badges/1.0"})
        with opener.open(request, timeout=10) as response:
            body = response.read(8000001)
        if len(body) > 8000000:
            raise ValueError("Oversized response")
        result = json.loads(body)
        if not isinstance(result, dict) or result.get("protocol") != 1:
            raise ValueError("Unsupported server protocol")
        return result

    @staticmethod
    def _price_server_error_text(error: Exception) -> str:
        if isinstance(error, urllib.error.HTTPError):
            if error.code in (401, 403):
                return "A saját szerver elutasította a hozzáférést. Ellenőrizd a tokent."
            return "Saját szerver: HTTP %s." % error.code
        cause = getattr(error, "reason", error)
        if isinstance(cause, ssl.SSLError):
            return "A saját szerver HTTPS-tanúsítványa nem ellenőrizhető."
        if isinstance(error, OSError):
            return "A saját szerver nem érhető el vagy időtúllépés történt. A mentett árak megmaradtak."
        return "A saját szerver válasza nem ellenőrizhető. Frissítsd mindkét oldalt."

    async def test_price_server(self) -> Dict[str, Any]:
        try:
            result = await self._run_blocking(self._price_server_request, self._price_connection["url"],
                                             self._price_server_token, "/v1/status")
            return {"success": True, "queue": int(result.get("queue", 0)), "gg_available": result.get("gg_available") is True,
                    "aks_entries": int(result.get("aks_entries", 0)), "gg_entries": int(result.get("gg_entries", 0))}
        except (OSError, ValueError, TypeError):
            return {"success": False, "error": "A szerverkapcsolat ellenőrzése sikertelen. Ellenőrizd a HTTPS címet, tokent és porttovábbítást."}

    async def _lookup_remote_price(self, app_id: str, epoch: int) -> Dict[str, Any]:
        provider = self._price_preferences.get("provider", "aks")
        if epoch != self._price_epoch:
            return {"success": True, "disabled": True}
        now = time.time()
        if now < self._price_server_retry_at:
            return {"success": False, "provider": provider, "global_error": True, "error_code": self._price_server_error_code,
                    "error": self._price_server_error, "retry_after": self._price_server_retry_at - now}
        try:
            response = await self._run_blocking(self._price_server_request, self._price_connection["url"], self._price_server_token,
                "/v1/price", {"provider": provider, "app_id": app_id, "priority": "foreground" if self._price_foreground_waiters else "background"})
            if epoch != self._price_epoch:
                return {"success": True, "disabled": True}
            if response.get("provider") != provider or response.get("app_id") != app_id:
                raise ValueError("Mismatched response")
            retry = response.get("retry_after", 3)
            if type(retry) not in (int, float) or not 0 <= retry <= 604800:
                raise ValueError("Invalid retry time")
            self._price_server_queue = max(0, int(response.get("queue", 0)))
            entry = response.get("entry")
            entry_provider = response.get("entry_provider", provider)
            if entry_provider != provider and not (provider == "aks" and entry_provider == "gg"
                    and isinstance(entry, dict) and entry.get("fallback_from") == "aks"):
                raise ValueError("Invalid fallback source")
            if entry is not None:
                if not (self._valid_gg_entry(entry) if entry_provider == "gg" else self._valid_price_entry(entry)):
                    raise ValueError("Invalid price data")
                if entry.get("source") == "aks_history" and entry.get("history_version") != AKS_HISTORY_VERSION:
                    return {"success": False, "provider": provider, "error_code": "server_version", "retry_after": 60,
                            "error": "Az árszerver régi, hiányosan szűrt árakat küld. Frissítsd az Ubuntu árszervert is 1.0.94 vagy újabb verzióra."}
                cache = self._gg_cache if entry_provider == "gg" else self._price_cache
                if app_id not in cache and len(cache) >= 10000:
                    cache.pop(next(iter(cache)))
                if cache.get(app_id) != entry:
                    cache[app_id] = entry
                    if entry_provider == "aks" and "data" in entry:
                        self._price_merchants.update(row["name"] for row in entry["data"]["merchants"].values()
                            if isinstance(row, dict) and isinstance(row.get("name"), str) and 0 < len(row["name"]) <= 80)
                    self._schedule_price_save()
            failure = response.get("failure")
            if failure:
                if not isinstance(failure, dict):
                    raise ValueError("Invalid failure")
                message = str(failure.get("error", "A szerver árlekérése sikertelen."))[:500]
                shared = failure.get("global_error") is True
                if shared:
                    self._price_server_retry_at = time.time() + max(1, retry)
                self._price_server_error = message
                code = failure.get("error_code")
                self._price_server_error_code = code if code in ("steam", "match", "connection", "rate_limit", "format", "http", "lookup") else "lookup"
                failed_provider = "gg" if provider == "aks" and failure.get("provider") == "gg" else provider
                return {"success": False, "provider": failed_provider, "global_error": shared, "error_code": self._price_server_error_code,
                        "error": message, "retry_after": max(1, retry)}
            self._price_server_failures = 0
            self._price_server_error = ""
            pending = response.get("pending") is True
            if entry:
                return {**self._active_price_result(entry),
                        "stale": time.time() - entry["checked_at"] >= PRICE_TTL_SECONDS,
                        "pending": pending, "retry_after": max(1, retry)}
            return {"success": False, "provider": provider, "pending": pending, "error_code": "pending" if pending else "server",
                    "error": "A saját szerver lekérési sorában vár." if pending else "A szerver nem adott áradatot.", "retry_after": max(1, retry)}
        except (OSError, ValueError, TypeError, KeyError) as error:
            if epoch != self._price_epoch:
                return {"success": True, "disabled": True}
            self._price_server_failures += 1
            delay = max(min(300, 10 * 2 ** min(5, self._price_server_failures - 1)), self._retry_after(getattr(error, "headers", None)))
            self._price_server_retry_at = time.time() + delay
            self._price_server_error = self._price_server_error_text(error)
            self._price_server_error_code = "server"
            return {"success": False, "provider": provider, "global_error": True, "error_code": "server",
                    "error": self._price_server_error, "retry_after": delay}

    async def _get_remote_merchants(self, refresh: bool) -> Dict[str, Any]:
        error = ""
        try:
            result = await self._run_blocking(self._price_server_request, self._price_connection["url"], self._price_server_token,
                                             "/v1/merchants", {"refresh": refresh})
            names = result.get("merchants")
            if not isinstance(names, list) or len(names) > 2000 or any(not isinstance(v, str) or not 0 < len(v) <= 80 for v in names):
                raise ValueError("Invalid merchant list")
            self._price_merchants.update(names)
            self._schedule_price_save()
            if result.get("pending"):
                error = "A szerver frissíti a boltlistát. A már ismert boltok választhatók; néhány másodperc múlva frissítsd a listát."
        except (OSError, ValueError, TypeError) as exc:
            error = self._price_server_error_text(exc)
        names = {name.casefold(): name for name in (*PRICE_MERCHANT_CHOICES, *self._price_merchants, *self._price_preferences["merchants"])}
        return {"success": True, "merchants": sorted(names.values(), key=str.casefold), "error": error}

    async def _load_price_preferences(self) -> None:
        try:
            value = json.loads(await self._run_blocking(lambda: self._price_settings_path.read_text(encoding="utf-8")))
            if (isinstance(value, dict) and type(value.get("enabled")) is bool
                    and type(value.get("allow_gifts")) is bool and isinstance(value.get("merchants"), list)
                    and all(isinstance(item, str) and len(item) <= 80 for item in value["merchants"])
                    and len(value["merchants"]) <= 2000):
                secret = value.pop("gg_api_key", "")
                self._gg_api_key = secret if isinstance(secret, str) and re.fullmatch(r"[A-Za-z0-9_-]{16,200}", secret) else ""
                value["provider"] = "gg" if value.get("provider") == "gg" else "aks"
                self._price_preferences = value
                self._price_preferences["restrict_merchants"] = value.get("restrict_merchants", bool(value["merchants"])) is True
        except (OSError, ValueError, TypeError):
            pass

    async def get_price_preferences(self) -> Dict[str, Any]:
        return {"success": True, **self._price_preferences, "gg_key_configured": bool(self._gg_api_key),
                "provider": self._price_preferences.get("provider", "aks"),
                "restrict_merchants": self._price_preferences.get("restrict_merchants", bool(self._price_preferences["merchants"]))}

    async def set_price_preferences(self, enabled: Any, allow_gifts: Any, merchants: Any, restrict_merchants: Any = None) -> Dict[str, Any]:
        if (type(enabled) is not bool or type(allow_gifts) is not bool or not isinstance(merchants, list)
                or len(merchants) > 2000 or any(not isinstance(item, str) or len(item) > 80 for item in merchants)
                or (restrict_merchants is not None and type(restrict_merchants) is not bool)):
            return {"success": False, "error": "Érvénytelen árfigyelési beállítás."}
        value = {"provider": self._price_preferences.get("provider", "aks"), "enabled": enabled, "allow_gifts": allow_gifts,
                 "restrict_merchants": bool(merchants) if restrict_merchants is None else restrict_merchants,
                 "merchants": sorted(set(item.strip() for item in merchants if item.strip()))}
        await self._run_blocking(self._write_file_atomically, self._price_settings_path,
                                 "price-preferences-", json.dumps({**value, "gg_api_key": self._gg_api_key}, ensure_ascii=False))
        self._price_preferences = value
        return await self.get_price_preferences()

    async def set_price_provider(self, provider: Any, api_key: Any = None) -> Dict[str, Any]:
        if provider not in ("aks", "gg") or (api_key is not None and (
                not isinstance(api_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,200}", api_key))):
            return {"success": False, "error": "Érvénytelen árforrás vagy API-kulcs."}
        key = self._gg_api_key if api_key is None else api_key
        if provider == "gg" and not key and self._price_connection["mode"] != "server":
            return {"success": False, "error": "Add meg a GG.deals API-kulcsot."}
        value = {**self._price_preferences, "provider": provider}
        await self._run_blocking(self._write_file_atomically, self._price_settings_path,
            "price-preferences-", json.dumps({**value, "gg_api_key": key}, ensure_ascii=False))
        # The secret is backend-only: never return it through get_preferences or prices.
        self._gg_api_key = key
        self._price_preferences = value
        self._price_epoch += 1
        self._price_server_retry_at = 0
        self._price_server_error = ""
        self._price_wishlist_retry.clear()
        self._price_wishlist_attempts.clear()
        return await self.get_price_preferences()

    def _active_price_cache(self) -> Dict[str, Dict[str, Any]]:
        if self._price_preferences.get("provider") == "gg":
            return self._gg_cache
        keys = set(self._price_cache) | {key for key, value in self._gg_cache.items() if value.get("fallback_from") == "aks"}
        return {key: self._effective_price_entry(key) for key in keys}

    def _effective_price_entry(self, app_id: str, provider: Optional[str] = None) -> Optional[Dict[str, Any]]:
        provider = provider or self._price_preferences.get("provider", "aks")
        if provider == "gg":
            return self._gg_cache.get(app_id)
        aks, gg = self._price_cache.get(app_id), self._gg_cache.get(app_id)
        if aks and "error" not in aks and 0 <= time.time() - aks["checked_at"] < PRICE_TTL_SECONDS:
            return aks
        if gg and gg.get("fallback_from") == "aks":
            if not aks or "error" in aks or gg["checked_at"] >= aks["checked_at"]:
                return gg
        return aks

    def _active_price_result(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        if entry.get("provider") == "gg":
            result = dict(entry)
            if self._price_preferences.get("provider") == "gg":
                result.pop("fallback_from", None)
            return result
        return self._price_result(entry)

    @staticmethod
    def _aks_fallback_allowed(result: Any) -> bool:
        return bool(isinstance(result, dict) and result.get("global_error") and (
            result.get("error_code") in ("connection", "rate_limit") or
            result.get("error_code") == "http" and (result.get("http_status") in (403, 408)
                or type(result.get("http_status")) is int and 500 <= result["http_status"] <= 599)))

    def _aks_fallback_available(self) -> bool:
        return bool(self._gg_api_key and self._aks_fallback_allowed(self._price_service_error)
                    and (self._price_service_retry_at > time.time() or self._aks_pause_until > time.monotonic()))

    def _active_price_retry_at(self) -> float:
        if self._price_connection["mode"] == "server":
            return self._price_server_retry_at
        if self._price_preferences.get("provider", "aks") == "aks" and self._aks_fallback_available():
            return self._gg_retry_at
        return self._gg_retry_at if self._price_preferences.get("provider") == "gg" else self._price_service_retry_at

    @staticmethod
    def _valid_gg_entry(entry: Any) -> bool:
        if (not isinstance(entry, dict) or entry.get("success") is not True or entry.get("provider") != "gg"
                or type(entry.get("checked_at")) not in (int, float) or not 0 < entry["checked_at"] <= time.time() + 60):
            return False
        if entry.get("skipped") in ("free", "unreleased", "release_unknown"):
            return True
        valid_url = isinstance(entry.get("url"), str) and bool(re.fullmatch(r"https://gg\.deals/game/[a-z0-9-]+/", entry["url"]))
        if entry.get("not_found") is True and entry.get("url") == "https://gg.deals/":
            valid_url = entry.get("retail_price") is None and entry.get("keyshop_price") is None
        return (valid_url
                and entry.get("currency") == "EUR" and isinstance(entry.get("title"), str)
                and all(entry.get(k) is None or (type(entry[k]) in (int, float) and 0 <= entry[k] < 100000)
                        for k in ("retail_price", "keyshop_price")))

    def _fetch_gg_prices(self, ids: List[str]) -> Dict[str, Any]:
        query = urllib.parse.urlencode({"key": self._gg_api_key, "ids": ",".join(ids), "region": "eu"})
        request = urllib.request.Request("https://api.gg.deals/v1/prices/by-steam-app-id/?" + query,
                                         headers={"User-Agent": "Deck Play Badges/1.0", "Accept": "application/json"})
        # Do not include this URL (which contains the key) in logs or returned errors.
        with self._open_verified_request(request, timeout=15) as response:
            if urllib.parse.urlparse(response.geturl()).hostname != "api.gg.deals":
                raise ValueError("Unexpected API redirect")
            body = response.read(2000001)
            if len(body) > 2000000:
                raise ValueError("Oversized API response")
            payload = json.loads(body)
            headers = dict(response.headers)
        if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(payload.get("data"), dict):
            raise ValueError("Invalid API response")
        return {"data": payload["data"], "headers": headers}

    def _gg_result(self, app_id: str, item: Any) -> Dict[str, Any]:
        if item is None:
            return {"success": True, "provider": "gg", "title": self._price_metadata[app_id]["title"],
                    "url": "https://gg.deals/", "not_found": True, "currency": "EUR", "retail_price": None, "keyshop_price": None,
                    "checked_at": time.time()}
        if not isinstance(item, dict) or not isinstance(item.get("prices"), dict):
            raise ValueError("Invalid API item")
        prices = item["prices"]
        def price(key: str) -> Optional[float]:
            value = prices.get(key)
            if value is None:
                return None
            if not isinstance(value, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value):
                raise ValueError("Invalid API price")
            number = float(value)
            if not 0 <= number < 100000:
                raise ValueError("Invalid API price")
            return number
        result = {"success": True, "provider": "gg", "title": item.get("title"), "url": item.get("url"),
                  "currency": prices.get("currency"), "retail_price": price("currentRetail"),
                  "keyshop_price": price("currentKeyshops"), "checked_at": time.time()}
        if not self._valid_gg_entry(result):
            raise ValueError("Invalid API product")
        return result

    async def _lookup_gg_price(self, app_id: str, epoch: int) -> Dict[str, Any]:
        async with self._price_lock:
            if epoch != self._price_epoch or self._price_stopping or not self._price_preferences["enabled"]:
                return {"success": True, "disabled": True, "provider": "gg"}
            entry = self._gg_cache.get(app_id)
            if entry and time.time() - entry["checked_at"] < PRICE_TTL_SECONDS:
                return dict(entry)
            if time.time() < self._gg_retry_at:
                return {"success": False, "provider": "gg", "global_error": True, "error_code": "rate_limit",
                        "error": self._gg_last_error or "GG.deals lekérési szünet.", "retry_after": self._gg_retry_at - time.time()}
            try:
                if not self._gg_api_key:
                    raise ValueError("Missing key")
                metadata = await self._run_blocking(self._fetch_price_metadata, app_id)
                skipped = self._price_skip(metadata)
                if skipped:
                    result = {"success": True, "provider": "gg", "skipped": skipped,
                              "title": metadata["title"], "checked_at": time.time()}
                else:
                    now = time.time()
                    self._gg_requests = [stamp for stamp in self._gg_requests if now - stamp < 3600]
                    minute = [stamp for stamp in self._gg_requests if now - stamp < 60]
                    capacity = min(100 - len(minute), 1000 - len(self._gg_requests))
                    if capacity <= 0:
                        self._gg_retry_at = max(minute[0] + 60 if len(minute) >= 100 else 0,
                                                self._gg_requests[0] + 3600 if len(self._gg_requests) >= 1000 else 0)
                        return {"success": False, "provider": "gg", "global_error": True, "error_code": "rate_limit",
                                "error": "GG.deals API-keret: a következő időablakra vár.", "retry_after": max(1, self._gg_retry_at - now)}
                    ids = [app_id]
                    # Include due wishlist items whose Steam eligibility is already known.
                    if time.monotonic() < self._price_wishlist_lease:
                        for key in self._price_wishlist:
                            cached = self._gg_cache.get(key)
                            meta = self._price_metadata.get(key)
                            if (key != app_id and len(ids) < capacity and self._valid_price_metadata(key, meta, now)
                                    and not self._price_skip(meta) and (not cached or now - cached["checked_at"] >= PRICE_TTL_SECONDS)):
                                ids.append(key)
                    self._gg_requests.extend([now] * len(ids))
                    self._schedule_price_save()
                    response = await self._run_blocking(self._fetch_gg_prices, ids)
                    headers = {k.lower(): v for k, v in response["headers"].items()}
                    if str(headers.get("x-ratelimit-remaining")) == "0":
                        reset = str(headers.get("x-ratelimit-reset", ""))
                        self._gg_retry_at = max(self._gg_retry_at, float(reset) if reset.isdigit() else now + 60)
                    results = {key: self._gg_result(key, response["data"][key]) for key in ids}
                    if epoch != self._price_epoch:
                        return {"success": True, "disabled": True, "provider": "gg"}
                    self._gg_cache.update(results)
                    result = results[app_id]
                if epoch != self._price_epoch:
                    return {"success": True, "disabled": True, "provider": "gg"}
                self._gg_cache[app_id] = result
                while len(self._gg_cache) > 10000:
                    self._gg_cache.pop(next(iter(self._gg_cache)))
                self._gg_failures = 0
                self._gg_last_error = ""
                self._schedule_price_save()
                return dict(result)
            except (OSError, ValueError, TypeError, KeyError) as error:
                code = "connection" if isinstance(error, OSError) else "format"
                if isinstance(error, urllib.error.HTTPError):
                    code = "rate_limit" if error.code == 429 else "http"
                    message = "GG.deals HTTP %s." % error.code
                    if error.code in (401, 403):
                        message += " Ellenőrizd az API-kulcsot és a hozzáférést."
                else:
                    message = "GG.deals: kapcsolati hiba vagy időtúllépés." if code == "connection" else "A GG.deals vagy a Steam válasza nem ellenőrizhető."
                self._gg_failures += 1
                delay = max(min(300, 10 * 2 ** min(5, self._gg_failures - 1)), self._retry_after(getattr(error, "headers", None)))
                self._gg_retry_at = max(self._gg_retry_at, time.time() + delay)
                self._gg_last_error = message
                self._schedule_price_save()
                return {"success": False, "provider": "gg", "global_error": True,
                        "error_code": code, "error": message, "retry_after": self._gg_retry_at - time.time()}

    async def _load_price_merchants(self) -> None:
        try:
            value = json.loads(await self._run_blocking(lambda: self._price_merchants_path.read_text(encoding="utf-8")))
            names = value.get("names", [])
            if isinstance(names, list):
                self._price_merchants = {name for name in names[:2000] if isinstance(name, str) and 0 < len(name) <= 80}
            checked = value.get("checked_at", 0)
            if type(checked) in (int, float) and 0 <= checked <= time.time():
                self._price_merchants_checked_at = checked
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    async def _save_price_merchants(self) -> None:
        await self._run_blocking(self._write_file_atomically, self._price_merchants_path, "price-merchants-",
            json.dumps({"names": sorted(self._price_merchants), "checked_at": self._price_merchants_checked_at}, ensure_ascii=False))

    async def get_price_merchants(self, refresh: Any = False) -> Dict[str, Any]:
        if self._price_connection["mode"] == "server":
            return await self._get_remote_merchants(refresh is True)
        # API responses already supply merchant names. Never scrape the old directory.
        names = {name.casefold(): name for name in (*PRICE_MERCHANT_CHOICES, *self._price_merchants)}
        for name in self._price_preferences["merchants"]:
            names.setdefault(name.casefold(), name)
        return {"success": True, "merchants": sorted(names.values(), key=str.casefold),
                "checked_at": self._price_merchants_checked_at, "error": ""}

    @staticmethod
    def _aks_title(value: str) -> str:
        value = html.unescape(re.sub(r"<[^>]*>", "", value)).replace("™", "").replace("®", "")
        return re.sub(r"[^\w]", "", unicodedata.normalize("NFKC", value).casefold())

    @staticmethod
    def _aks_search_name(value: str) -> str:
        # Omit trademark glyphs in the request too, preserving words, accents,
        # punctuation and edition names. Exact result/AppID validation is unchanged.
        return " ".join(html.unescape(value).replace("™", "").replace("®", "").split())

    @staticmethod
    def _retry_after(headers: Any) -> float:
        value = str((headers or {}).get("Retry-After", "")).strip()
        if value.isdigit():
            return float(value)
        try:
            stamp = email.utils.parsedate_to_datetime(value).timestamp()
            return max(0.0, stamp - time.time())
        except (ValueError, TypeError, OverflowError):
            return 0.0

    def _aks_read(self, url: str) -> str:
        parsed = urllib.parse.urlparse(url)
        if (parsed.scheme != "https" or parsed.netloc != "www.allkeyshop.com"
                or parsed.path not in ("/api/v2/vaks.php", "/api/price_history_api.php")):
            raise ValueError("Invalid AllKeyShop URL")
        request = urllib.request.Request(url, headers={"User-Agent": "Deck Play Badges price comparison/1.0",
                                                        "Accept-Encoding": "identity", "Accept": "application/json"})
        # Executed only in the blocking worker: one global AKS request at a time,
        # covering both the catalog and price-history API.
        with self._aks_request_lock:
            # The same cooldown applies to both API endpoints.
            remaining = self._aks_pause_until - time.monotonic()
            if remaining > 0:
                raise urllib.error.HTTPError(url, 429, "AKS cooldown", {"Retry-After": str(int(remaining) + 1)}, None)
            wait = max(0.0, self._aks_next_request_at - time.monotonic())
            if wait:
                time.sleep(wait)
            started = time.monotonic()
            try:
                with self._open_request(request, timeout=30) as response:
                    if response.geturl() != url:
                        raise ValueError("Unexpected AllKeyShop redirect")
                    limit = 32 * 1024 * 1024 if parsed.path == "/api/v2/vaks.php" else 16 * 1024 * 1024
                    body = response.read(limit + 1)
                if len(body) > limit:
                    raise ValueError("AllKeyShop page is too large")
                self._aks_http_failures = 0
                return body.decode("utf-8")
            except (OSError, ValueError) as error:
                if isinstance(error, urllib.error.HTTPError):
                    pause = self._retry_after(error.headers)
                    if error.code == 429:
                        self._aks_http_failures += 1
                        pause = max(pause, min(300, 10 * 2 ** min(5, self._aks_http_failures - 1)))
                    if pause:
                        self._aks_pause_until = max(self._aks_pause_until, time.monotonic() + pause)
                        self._aks_next_request_at = max(self._aks_next_request_at, self._aks_pause_until)
                error.price_stage = "AKS-katalógus" if parsed.path == "/api/v2/vaks.php" else "AKS-áradatok"
                error.price_elapsed = round(time.monotonic() - started, 1)
                raise
            finally:
                self._aks_next_request_at = max(self._aks_next_request_at, time.monotonic() + AKS_REQUEST_GAP_SECONDS)

    @classmethod
    def _aks_search_match(cls, fragment: str, title: str) -> str:
        matches: Set[str] = set()
        for row in re.findall(r'<li\b[^>]*data-platforms="pc"[^>]*>(.*?)</li>', fragment, re.S):
            name = re.search(r'<h2\b[^>]*class="ls-results-row-game-title"[^>]*>(.*?)</h2>', row, re.S)
            link = re.search(r'<a\b[^>]*href="(https://www\.allkeyshop\.com/blog/[^"]+)"', row)
            if name and link and cls._aks_title(name.group(1)) == cls._aks_title(title):
                url = html.unescape(link.group(1))
                if re.fullmatch(r"https://www\.allkeyshop\.com/blog/(?:buy-|compare-and-buy-cd-key-for-digital-download-)[a-z0-9-]+/", url) and "account" not in url:
                    matches.add(url)
        if len(matches) != 1:
            raise ValueError("Nincs egyértelmű AllKeyShop-találat ehhez a Steam-játékhoz.")
        return matches.pop()

    @staticmethod
    def _aks_parse(page: str) -> Dict[str, Any]:
        # Decode the site's public embedded JSON; never execute its JavaScript.
        match = re.search(r"\bvar\s+gamePageTrans\s*=\s*", page)
        if not match:
            raise ValueError("Az AllKeyShop ajánlatai most nem olvashatók.")
        data, _ = json.JSONDecoder().raw_decode(page[match.end():])
        if (not isinstance(data, dict) or not isinstance(data.get("prices"), list)
                or any(not isinstance(data.get(key), dict) for key in ("merchants", "regions", "editions"))):
            raise ValueError("Megváltozott az AllKeyShop adatformátuma.")
        return data

    @staticmethod
    def _aks_filter(data: Dict[str, Any], preferences: Dict[str, Any]) -> List[Dict[str, Any]]:
        # Exact allowlist: never infer that an unknown product is a key.
        regions = {"STEAM GLOBAL": "Steam-kulcs · Global", "STEAM EU": "Steam-kulcs · EU",
                   "STEAM GIFT GLOBAL": "Steam Gift · Global", "STEAM GIFT EU": "Steam Gift · EU"}
        allowed = {value.casefold() for value in preferences["merchants"]}
        restricted = preferences.get("restrict_merchants", bool(allowed))
        offers: List[Dict[str, Any]] = []
        for row in data["prices"]:
            if (not isinstance(row, dict) or row.get("account") is not False
                    or row.get("activationPlatform") != "steam" or row.get("dispo") != 1
                    or row.get("isFirstParty") is not False or row.get("allowCard") is not True):
                continue
            region = data["regions"].get(str(row.get("region")), {})
            edition = data["editions"].get(str(row.get("edition")), {})
            merchant = data["merchants"].get(str(row.get("merchant")), {})
            if not all(isinstance(item, dict) for item in (region, edition, merchant)):
                continue
            region_name = region.get("filter_name")
            name = merchant.get("name")
            if (region_name not in regions or edition.get("name") != "Standard" or not isinstance(name, str)
                    or not name or (restricted and name.casefold() not in allowed)
                    or ("GIFT" in region_name and not preferences["allow_gifts"])):
                continue
            price = row.get("priceCard")
            if type(price) not in (int, float) or not 0.02 < price < 100000:
                continue
            coupon = row.get("voucher_code")
            offers.append({"merchant": name[:80], "price": price, "kind": regions[region_name], "edition": "Standard",
                           "coupon": coupon[:80] if isinstance(coupon, str) else ""})
        return sorted(offers, key=lambda offer: (offer["price"], offer["merchant"]))

    @staticmethod
    def _steam_price_data(payload: Any, app_id: str) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("Invalid Steam metadata response")
        item = payload.get(app_id, {})
        data = item.get("data") if isinstance(item, dict) and item.get("success") is True else None
        if isinstance(data, dict) and str(data.get("steam_appid", app_id)) == app_id:
            return data
        # Steam can put the base game's data under a DLC key. Only its explicit
        # inner AppID can identify it; never accept the first unrelated result.
        matches = [item["data"] for item in payload.values() if isinstance(item, dict)
                   and item.get("success") is True and isinstance(item.get("data"), dict)
                   and str(item["data"].get("steam_appid", "")) == app_id]
        return matches[0] if len(matches) == 1 else {}

    def _fetch_price_metadata(self, app_id: str) -> Dict[str, Any]:
        cached = self._price_metadata.get(app_id)
        if self._valid_price_metadata(app_id, cached, time.time()):
            return cached
        request = urllib.request.Request(STORE_URL.format(app_id=app_id),
                                         headers={"User-Agent": "ControllerXbox Decky Plugin/1.0"})
        started = time.monotonic()
        try:
            with self._open_request(request, timeout=10) as response:
                payload = json.load(response)
            data = self._steam_price_data(payload, app_id)
            title = str(data.get("name", "")).strip()[:200]
            if not title:
                missing = ValueError("Missing Steam title")
                missing.price_local_error = True
                raise missing
            release = data.get("release_date")
            coming_soon = release.get("coming_soon") if isinstance(release, dict) else None
            result = {"app_id": app_id, "title": title, "is_free": data.get("is_free") is True,
                      "coming_soon": coming_soon if type(coming_soon) is bool else None, "checked_at": time.time()}
        except (OSError, ValueError, TypeError, AttributeError) as error:
            failure = ValueError("A Steam-játék neve most nem kérdezhető le.")
            failure.price_stage = "Steam-adatok"
            failure.price_elapsed = round(time.monotonic() - started, 1)
            failure.price_local_error = getattr(error, "price_local_error", False)
            raise failure from error
        if len(self._price_metadata) >= 10000:
            self._price_metadata.pop(next(iter(self._price_metadata)))
        self._price_metadata[app_id] = result
        return result

    @staticmethod
    def _price_skip(metadata: Dict[str, Any]) -> str:
        if metadata["is_free"]:
            return "free"
        if metadata["coming_soon"] is not False:
            return "unreleased" if metadata["coming_soon"] is True else "release_unknown"
        return ""

    @classmethod
    def _aks_page_matches(cls, page: str, title: str, app_id: str) -> bool:
        heading = re.search(r"<h1\b[^>]*>(.*?)</h1>", page, re.S | re.I)
        if not heading:
            raise ValueError("Megváltozott az AllKeyShop adatformátuma.")
        name = re.search(r'<[^>]+(?:data-)?itemprop=[\"\']name[\"\'][^>]*>(.*?)</[^>]+>', heading.group(1), re.S | re.I)
        if not name:
            raise ValueError("Megváltozott az AllKeyShop adatformátuma.")
        if cls._aks_title(name.group(1)) != cls._aks_title(title):
            return False
        # When an explicit Steam product link exists, never accept a different AppID.
        steam_ids = set(re.findall(r'https?://store\.steampowered\.com/app/(\+?\d+)', heading.group(1)))
        return not steam_ids or steam_ids == {app_id}

    def _load_aks_catalog(self, force: bool = False) -> Dict[str, Optional[str]]:
        # One shared exact-name index, independent of the frequently saved prices.
        now = time.time()
        if not force and self._aks_catalog and 0 <= now - self._aks_catalog_checked_at < AKS_CATALOG_TTL_SECONDS:
            return self._aks_catalog
        path = self._price_cache_path.with_name("aks-catalog.json")
        if not force and not self._aks_catalog:
            try:
                if path.stat().st_size > 32 * 1024 * 1024:
                    raise ValueError("Catalog too large")
                cached = json.loads(path.read_text(encoding="utf-8"))
                index, checked = cached.get("index"), cached.get("checked_at")
                if (cached.get("version") == 1 and isinstance(index, dict) and index
                        and type(checked) in (int, float) and 0 <= now - checked < AKS_CATALOG_TTL_SECONDS
                        and all(isinstance(k, str) and 0 < len(k) <= 300 and
                            (v is None or (isinstance(v, str) and v.isdigit() and 0 < int(v) < 10000000000))
                            for k, v in index.items())):
                    self._aks_catalog, self._aks_catalog_checked_at = index, checked
                    return index
            except (OSError, ValueError, TypeError, AttributeError):
                pass
        payload = json.loads(self._aks_read(AKS_CATALOG_URL))
        if not isinstance(payload, dict) or payload.get("status") != "success" or not isinstance(payload.get("games"), list):
            raise ValueError("Megváltozott az AllKeyShop adatformátuma.")
        index = {}
        for game in payload["games"]:
            if not isinstance(game, dict) or not isinstance(game.get("name"), str):
                continue
            product_id = str(game.get("id", ""))
            name = self._aks_title(game["name"])
            if not name or len(name) > 300 or not product_id.isdigit() or not 0 < int(product_id) < 10000000000:
                continue
            # Duplicate normalized names with different IDs are deliberately ambiguous.
            index[name] = product_id if name not in index or index[name] == product_id else None
        if not index:
            raise ValueError("Megváltozott az AllKeyShop adatformátuma.")
        self._aks_catalog, self._aks_catalog_checked_at = index, now
        try:
            self._write_file_atomically(path, "aks-catalog-", json.dumps(
                {"version": 1, "checked_at": now, "index": index}, ensure_ascii=False))
        except OSError:
            decky.logger.warning("Az AKS-katalógus nem menthető; a memóriában tovább használható.")
        return index

    @staticmethod
    def _aks_observed_time(value: Any) -> str:
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", value):
            return ""
        if not 2000 <= int(value[:4]) <= time.gmtime().tm_year + 1:
            return ""
        try:
            time.strptime(value, "%Y-%m-%d %H:%M:%S")
            return value
        except ValueError:
            return ""

    @classmethod
    def _aks_history_data(cls, payload: Any) -> Dict[str, Any]:
        # The API represents a game with no history using [] for these maps.
        # Accept that exact empty shape, but never accept malformed maps when
        # there are offers to match against merchants, regions and editions.
        if isinstance(payload, dict) and payload.get("history") == []:
            payload = {**payload, **{key: {} if payload.get(key) == [] else payload.get(key)
                                     for key in ("merchants", "regions", "editions")}}
        if (not isinstance(payload, dict) or not isinstance(payload.get("history"), list)
                or any(not isinstance(payload.get(k), dict) for k in ("merchants", "regions", "editions"))):
            raise ValueError("Megváltozott az AllKeyShop adatformátuma.")
        latest: Dict[Any, Dict[str, Any]] = {}
        for row in payload["history"]:
            if not isinstance(row, dict):  # The public response can contain false rows.
                continue
            ids = tuple(str(row.get(k, "")) for k in ("product_id", "merchant_id", "edition", "region"))
            if any(not item or len(item) > 80 for item in ids) or not ids[0].isdigit() or not ids[1].isdigit():
                continue
            start, end = cls._aks_observed_time(row.get("start")), cls._aks_observed_time(row.get("end"))
            if not start or not end or end < start:
                continue
            previous = latest.get(ids)
            rank = (end, start)
            if previous is None or rank > (previous["end"], previous["start"]):
                # Keep the newest observation even if its price is invalid: never resurrect an older price.
                latest[ids] = {key: row[key] for key in ("product_id", "merchant_id", "edition", "region",
                    "start", "end", "last_price", "min_discount_price", "best_discount_code") if key in row}
            elif rank == (previous["end"], previous["start"]) and any(
                    row.get(k) != previous.get(k) for k in ("last_price", "min_discount_price", "best_discount_code")):
                previous["ambiguous"] = True
        if any(row is not False for row in payload["history"]) and not latest:
            raise ValueError("Az AllKeyShop ajánlatai most nem olvashatók.")
        # Each product has its own observation date. Another shop's newer row
        # does not prove this product expired. Preserve the last known quote,
        # expose its date, and never describe historical quotes as live stock.
        prices = [row for row in latest.values() if not row.get("ambiguous")]
        return {"prices": prices, **{k: payload[k] for k in ("merchants", "regions", "editions")}}

    @classmethod
    def _aks_history_filter(cls, data: Dict[str, Any], preferences: Dict[str, Any],
                            filtering: Optional[Dict[str, int]] = None) -> List[Dict[str, Any]]:
        # Labels come from the API's region map, not from the merchant name.
        # Bare Steam is the unqualified/global group, not a per-country activation guarantee.
        regions = {"steam": "Steam-kulcs · Global (AKS: Steam)", "steam global": "Steam-kulcs · Global",
                   "steam eu": "Steam-kulcs · EU", "steam row": "Steam-kulcs · ROW",
                   "steam eu/us": "Steam-kulcs · EU/US",
                   "steam gift": "Steam Gift · Global (AKS: Steam Gift)",
                   "steam gift global": "Steam Gift · Global", "steam gift eu": "Steam Gift · EU",
                   "steam gift row": "Steam Gift · ROW"}
        allowed = {name.casefold() for name in preferences["merchants"]}
        restricted = preferences.get("restrict_merchants", bool(allowed))
        counts = {key: 0 for key in ("invalid", "region", "edition", "merchant", "gift", "price", "steam", "accepted")}
        counts["total"] = len(data["prices"])
        offers = []
        for row in data["prices"]:
            if not isinstance(row, dict) or not cls._aks_observed_time(row.get("end")):
                counts["invalid"] += 1
                continue
            region = data["regions"].get(str(row.get("region")), {})
            edition = data["editions"].get(str(row.get("edition")), {})
            merchant = data["merchants"].get(str(row.get("merchant_id")), {})
            if not all(isinstance(item, dict) for item in (region, edition, merchant)):
                counts["invalid"] += 1
                continue
            region_name = " ".join(str(region.get("name", "")).casefold().split())
            name = merchant.get("name")
            reason = ("steam" if isinstance(name, str) and name.strip().casefold() == "steam" else
                      "region" if region_name not in regions else
                      "edition" if edition.get("name") not in ("Standard", "Standard Edition", "Early Access") else
                      "invalid" if not isinstance(name, str) or not name or len(name) > 80 else
                      "gift" if "gift" in region_name and not preferences["allow_gifts"] else
                      "merchant" if restricted and name.casefold() not in allowed else "")
            if reason:
                counts[reason] += 1
                continue
            candidates = [(row.get(field), kind) for field, kind in
                          (("last_price", "regular"), ("min_discount_price", "discount"))]
            candidates = [(price, kind) for price, kind in candidates
                          if type(price) in (int, float) and 0.02 < price < 100000]
            if not candidates:
                counts["price"] += 1
                continue
            price, kind = min(candidates, key=lambda item: (item[0], item[1] != "regular"))
            price = round(price, 2)
            coupon = row.get("best_discount_code") if kind == "discount" else ""
            offers.append({"merchant": name, "price": price, "kind": regions[region_name],
                           "edition": "Early Access" if edition["name"] == "Early Access" else "Standard",
                           "coupon": coupon[:80] if isinstance(coupon, str) else "", "price_kind": kind,
                           "source_updated_at": row["end"]})
        counts["accepted"] = len(offers)
        if filtering is not None:
            filtering.update(counts)
        return sorted(offers, key=lambda offer: (offer["price"], offer["merchant"]))

    def _fetch_aks_game(self, app_id: str) -> Dict[str, Any]:
        metadata = self._fetch_price_metadata(app_id)
        title = metadata["title"]
        skipped = self._price_skip(metadata)
        if skipped:
            return {"title": title, "skipped": skipped, "checked_at": time.time()}
        match = self._aks_matches.get(app_id)
        if (not self._valid_aks_match(app_id, match, time.time()) or not match.get("product_id")
                or self._aks_title(match["title"]) != self._aks_title(title)):
            self._aks_matches.pop(app_id, None)
            match = None
        # New catalog data can invalidate an existing match before its seven-day TTL.
        if match and self._aks_catalog and self._aks_catalog.get(self._aks_title(title)) != match["product_id"]:
            self._aks_matches.pop(app_id, None)
            match = None
        for attempt in range(2):
            if match is None:
                catalog = self._load_aks_catalog(force=attempt > 0)
                product_id = catalog.get(self._aks_title(title))
                if not product_id:
                    return {"title": title, "url": "https://www.allkeyshop.com/", "source": "aks_history",
                            "history_version": AKS_HISTORY_VERSION,
                            "not_found": True, "match_status": "ambiguous" if self._aks_title(title) in catalog else "missing",
                            "data": {"prices": [], "merchants": {}, "regions": {}, "editions": {}},
                            "checked_at": time.time()}
                match = {"title": title, "product_id": product_id, "checked_at": time.time()}
                if len(self._aks_matches) >= 10000:
                    self._aks_matches.pop(next(iter(self._aks_matches)))
                self._aks_matches[app_id] = match
            query = urllib.parse.urlencode({"normalised_name": match["product_id"], "currency": "EUR",
                                            "database": "allkeyshop.com", "v2": "1"})
            try:
                payload = json.loads(self._aks_read("https://www.allkeyshop.com/api/price_history_api.php?" + query))
            except urllib.error.HTTPError as error:
                if error.code not in (404, 410):
                    raise
                self._aks_matches.pop(app_id, None)
                match = None
                if attempt == 0:
                    continue
                raise
            data = self._aks_history_data(payload)
            return {"title": title, "url": "https://www.allkeyshop.com/", "data": data,
                    "history_version": AKS_HISTORY_VERSION,
                    "source": "aks_history", "source_updated_at": max((row["end"] for row in data["prices"]), default=""),
                    "checked_at": time.time()}
        raise ValueError("Nincs egyértelmű AllKeyShop-találat ehhez a Steam-játékhoz.")

    @staticmethod
    def _aks_error_details(error: Exception) -> Dict[str, Any]:
        code, message, shared = "lookup", "Az AllKeyShop válasza nem dolgozható fel.", False
        if isinstance(error, urllib.error.HTTPError):
            code, shared = ("rate_limit" if error.code == 429 else "http"), error.code not in (404, 410)
            message = "Az AllKeyShop HTTP %s választ adott." % error.code
            if error.code == 429:
                message += " Túl sok kérés: a szolgáltató szünetet kér."
            elif error.code == 403:
                message += " A szolgáltató megtagadta a hozzáférést."
            elif error.code in (404, 410):
                message += " Ez az adatlap nem érhető el; a többi játék ellenőrizhető."
        elif isinstance(error, (urllib.error.URLError, OSError)):
            code, shared = "connection", True
            message = "Nem sikerült kapcsolódni az AllKeyShophoz, vagy a kapcsolat túllépte az időkorlátot. Ez nem jelenti azt, hogy nincs ajánlat."
        elif isinstance(error, ValueError):
            # Keep our specific validation messages; do not expose raw response bodies.
            safe_messages = ("A Steam-játék neve most nem kérdezhető le.",
                             "Nincs egyértelmű AllKeyShop-találat ehhez a Steam-játékhoz.",
                             "Az AllKeyShop ajánlatai most nem olvashatók.",
                             "Megváltozott az AllKeyShop adatformátuma.",
                             "Az AllKeyShop keresője nem válaszolt megfelelően.",
                             "Az AllKeyShop pénzneme nem ellenőrizhető.")
            if str(error) in safe_messages:
                message = str(error)
            if message == safe_messages[0]:
                code, shared = "steam", not getattr(error, "price_local_error", False)
            elif message == safe_messages[1]:
                code = "match"
            else:
                code, shared = "format", True
        cause = error.__cause__ or error
        reason = getattr(cause, "reason", cause)
        network = ""
        if isinstance(reason, TimeoutError) or getattr(reason, "errno", None) in (110, 10060):
            network = "Időtúllépés: a kapcsolat nem válaszolt időben."
        elif type(reason).__name__ == "gaierror":
            network = "DNS-hiba: a kiszolgáló címe nem oldható fel."
        elif isinstance(reason, ssl.SSLError):
            network = "TLS-hiba: a biztonságos kapcsolat nem hozható létre."
        elif isinstance(reason, ConnectionRefusedError):
            network = "A kiszolgáló elutasította a kapcsolatot."
        elif isinstance(reason, (ConnectionResetError, BrokenPipeError)):
            network = "A kapcsolat adatátvitel közben megszakadt."
        if network:
            message = network
        stage = getattr(error, "price_stage", "Steam-adatok" if code == "steam" else "AllKeyShop")
        elapsed = getattr(error, "price_elapsed", None)
        message = stage + (" (%.1f mp)" % elapsed if isinstance(elapsed, (int, float)) else "") + ": " + message
        details = {"error": message, "error_code": code, "global_error": shared}
        if isinstance(cause, urllib.error.HTTPError):
            details["http_status"] = cause.code
            retry = Plugin._retry_after(cause.headers)
            if retry:
                details["retry_after"] = retry
        return details

    async def get_allkeyshop_price(self, app_id: Any) -> Dict[str, Any]:
        self._price_foreground_waiters += 1
        try:
            return await self._get_allkeyshop_price(app_id)
        finally:
            self._price_foreground_waiters -= 1

    async def _get_allkeyshop_price(self, app_id: Any) -> Dict[str, Any]:
        normalized = str(app_id)
        if not normalized.isdigit() or not 0 < int(normalized) < 10000000000:
            return {"success": False, "error": "Érvénytelen Steam AppID."}
        if not self._price_preferences["enabled"] or self._price_stopping:
            return {"success": True, "disabled": True}
        entry = self._effective_price_entry(normalized)
        if entry and "error" not in entry and 0 <= time.time() - entry["checked_at"] < PRICE_TTL_SECONDS:
            return self._active_price_result(entry)
        task_key = str(self._price_epoch) + ":" + normalized
        task = self._price_tasks.get(task_key)
        if task is None:
            task = asyncio.create_task(self._lookup_price_with_fallback(normalized, self._price_epoch))
            self._price_tasks[task_key] = task
            def completed(done: asyncio.Task) -> None:
                if self._price_tasks.get(task_key) is done:
                    self._price_tasks.pop(task_key, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(completed)
        return await asyncio.shield(task)

    async def _lookup_price_with_fallback(self, app_id: str, epoch: int) -> Dict[str, Any]:
        # Server mode delegates fallback to that server; never bypass it locally.
        if self._price_connection["mode"] == "server":
            return await self._lookup_remote_price(app_id, epoch)
        if self._price_preferences.get("provider") == "gg":
            return await self._lookup_gg_price(app_id, epoch)
        result = await self._lookup_allkeyshop_price(app_id, epoch)
        if (epoch != self._price_epoch or self._price_stopping or not self._price_preferences["enabled"]
                or not self._gg_api_key or not self._aks_fallback_allowed(result)):
            return result
        # The AKS lock has been released; GG has its own limits and uses the same
        # lookup lock. One outer single-flight still covers the entire operation.
        decky.logger.info("Price fallback provider=gg app_id=%s", app_id)
        fallback = await self._lookup_gg_price(app_id, epoch)
        if epoch != self._price_epoch or fallback.get("disabled"):
            return {"success": True, "disabled": True}
        fallback = {**fallback, "provider": "gg", "fallback_from": "aks"}
        if fallback.get("success"):
            self._gg_cache[app_id] = fallback
            self._schedule_price_save()
        return fallback

    async def _lookup_allkeyshop_price(self, app_id: Any, request_epoch: int) -> Dict[str, Any]:
        normalized = str(app_id)
        if not normalized.isdigit() or not 0 < int(normalized) < 10000000000:
            return {"success": False, "error": "Érvénytelen Steam AppID."}
        if not self._price_preferences["enabled"]:
            return {"success": True, "disabled": True}
        async with self._price_lock:
            if not self._price_preferences["enabled"] or self._price_stopping or request_epoch != self._price_epoch:
                return {"success": True, "disabled": True}
            entry = self._price_cache.get(normalized)
            previous = entry
            epoch = self._price_epoch
            if not entry or time.time() - entry["checked_at"] >= (30 if "error" in entry else PRICE_TTL_SECONDS):
                if self._price_service_error and time.time() < self._price_service_retry_at:
                    return {"success": False, **self._price_service_error,
                            "retry_after": max(1, int(self._price_service_retry_at - time.time()))}
                try:
                    entry = await self._run_blocking(self._fetch_aks_game, normalized)
                    if epoch != self._price_epoch:
                        self._aks_matches.pop(normalized, None)
                        self._price_metadata.pop(normalized, None)
                        return {"success": False, "error": "Az árgyorsítótár törölve lett.", "retry_after": 30}
                    if not entry.get("skipped"):
                        self._price_last_error = ""
                        self._price_service_error = None
                        self._price_service_failures = 0
                        self._price_service_retry_at = 0.0
                except (OSError, ValueError, TypeError, KeyError) as error:
                    if epoch != self._price_epoch:
                        self._aks_matches.pop(normalized, None)
                        self._price_metadata.pop(normalized, None)
                        return {"success": True, "disabled": True}
                    self._schedule_price_save()  # Persist metadata/match progress even when offers fail.
                    decky.logger.debug("AllKeyShop lookup failed: %s", error)
                    details = self._aks_error_details(error)
                    self._price_last_error = "Steam %s · %s" % (normalized, details["error"])
                    entry = {**details, "checked_at": time.time()}
                    if details["global_error"]:
                        self._price_service_failures += 1
                        # Equal jitter exponential backoff (AWS/Google best practice).
                        # Base 10 s, cap 300 s, with 50-100 % randomised jitter to
                        # prevent synchronised retry storms across instances.
                        raw = min(300, 10 * (2 ** min(5, self._price_service_failures - 1)))
                        delay = max(raw // 2 + random.uniform(0, raw / 2), details.get("retry_after", 0))
                        self._price_service_retry_at = time.time() + delay
                        self._price_service_error = details
                        return {"success": False, **details, "retry_after": delay}
                if "error" not in entry or not previous or "error" in previous:
                    if normalized not in self._price_cache and len(self._price_cache) >= 10000:
                        self._price_cache.pop(next(iter(self._price_cache)))
                    self._price_cache[normalized] = entry
                if "error" not in entry:
                    self._schedule_price_save()
            if "error" in entry:
                return {"success": False, "error": entry["error"], "error_code": entry.get("error_code", "lookup"),
                        "global_error": False, "retry_after": max(1, int(30 - (time.time() - entry["checked_at"])))}
            if entry.get("skipped"):
                return {"success": True, "skipped": entry["skipped"], "title": entry["title"],
                        "checked_at": entry["checked_at"], "offers": []}
            discovered = {row["name"] for row in entry["data"]["merchants"].values()
                          if isinstance(row, dict) and isinstance(row.get("name"), str) and 0 < len(row["name"]) <= 80}
            self._price_merchants_checked_at = max(self._price_merchants_checked_at, entry["checked_at"])
            if discovered - self._price_merchants:
                self._price_merchants.update(discovered)
                self._schedule_price_save()
            return self._price_result(entry)


    async def _load_cache(self) -> None:
        try:
            contents = await self._run_blocking(lambda: self._cache_path.read_text(encoding="utf-8"))
            parsed = json.loads(contents)
            if isinstance(parsed, dict):
                self._cache = parsed
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as error:
            decky.logger.warning("Ignoring invalid controller cache: %s", error)

    async def _save_cache(self) -> None:
        async with self._lock:
            payload = json.dumps(self._cache, separators=(",", ":"))
            await self._run_blocking(self._write_file_atomically, self._cache_path, "controller-cache-", payload)

    async def _load_hungarian_curator_cache(self) -> None:
        try:
            contents = await self._run_blocking(lambda: self._hungarian_curator_cache_path.read_text(encoding="utf-8"))
            data = json.loads(contents)
            if (isinstance(data, dict) and data.get("curator_id") == HUNGARIAN_CURATOR_ID
                    and data.get("schema_version") == 1 and isinstance(data.get("app_ids"), list)
                    and isinstance(data.get("checked_at"), (int, float)) and data["checked_at"] > 0):
                self._hungarian_curator_app_ids = {str(value) for value in data["app_ids"] if str(value).isdigit()}
                self._hungarian_curator_checked_at = data["checked_at"]
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as error:
            decky.logger.warning("Ignoring invalid Hungarian curator cache: %s", error)

    def _fetch_hungarian_curator_catalog(self) -> Set[str]:
        app_ids: Set[str] = set()
        seen: Set[str] = set()
        start = 0
        expected_total: Optional[int] = None
        deadline = time.monotonic() + 60
        for _page in range(100):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Hungarian curator catalog timed out")
            request = urllib.request.Request(HUNGARIAN_CURATOR_URL.format(start=start),
                                             headers={"User-Agent": "Deck Play Badges/1.0", "Accept-Encoding": "identity"})
            with self._open_request(request, timeout=min(10, remaining)) as response:
                data = json.load(response)
            if not isinstance(data, dict) or data.get("success") != 1 or not isinstance(data.get("results_html"), str):
                raise ValueError("Invalid Hungarian curator response")
            total = int(data.get("total_count", -1))
            page_size = int(data.get("pagesize", 0))
            if int(data.get("start", -1)) != start or not 0 < total <= 10000 or not 0 < page_size <= 100:
                raise ValueError("Invalid Hungarian curator pagination")
            if expected_total is not None and total != expected_total:
                raise ValueError("Hungarian curator catalog changed during pagination")
            expected_total = total
            parser = HungarianCuratorParser()
            parser.feed(data["results_html"])
            parser.close()
            if len(parser.records) != min(page_size, total - start):
                raise ValueError("Incomplete Hungarian curator page")
            for record in parser.records:
                if len(record["app_ids"]) != 1 or not record["curator_link"]:
                    raise ValueError("Invalid Hungarian curator recommendation")
                app_id = next(iter(record["app_ids"]))
                if app_id in seen:
                    raise ValueError("Repeated Hungarian curator page")
                seen.add(app_id)
                if record["recommended"]:
                    app_ids.add(app_id)
            start += len(parser.records)
            self._hungarian_curator_progress = {"checked": start, "total": total}
            if start == total:
                if not app_ids:
                    raise ValueError("Empty Hungarian curator catalog")
                return app_ids
        raise ValueError("Hungarian curator catalog exceeds page limit")

    def _start_hungarian_curator_refresh(self) -> None:
        now = time.time()
        if (not self._settings.get("show_hungarian_badges", True)
                or (self._hungarian_curator_checked_at and now - self._hungarian_curator_checked_at < HUNGARIAN_CURATOR_TTL_SECONDS)
                or (self._hungarian_curator_task is not None and not self._hungarian_curator_task.done())
                or now - self._hungarian_curator_attempted_at < HUNGARIAN_CURATOR_RETRY_SECONDS):
            return
        self._hungarian_curator_attempted_at = now
        self._hungarian_curator_progress = {"checked": 0, "total": 0}
        self._hungarian_curator_task = asyncio.create_task(self._refresh_hungarian_curator())

    async def _refresh_hungarian_curator(self) -> None:
        try:
            app_ids = await self._run_blocking(self._fetch_hungarian_curator_catalog)
            checked_at = time.time()
            payload = json.dumps({"schema_version": 1, "curator_id": HUNGARIAN_CURATOR_ID,
                                  "checked_at": checked_at, "app_ids": sorted(app_ids)}, separators=(",", ":"))
            await self._run_blocking(self._write_file_atomically, self._hungarian_curator_cache_path, "hu-curator-", payload)
            self._hungarian_curator_app_ids = app_ids
            self._hungarian_curator_checked_at = checked_at
            self._hungarian_curator_last_error = ""
        except Exception as error:
            self._hungarian_curator_last_error = str(error)
            decky.logger.warning("Hungarian curator refresh failed; retaining previous catalog: %s", error)

    async def _stop_hungarian_curator_refresh(self) -> None:
        task = self._hungarian_curator_task
        self._hungarian_curator_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def get_hungarian_curator_progress(self) -> Dict[str, Any]:
        # Memory-only snapshot: opening the panel never waits for an HTTP request.
        loading = self._hungarian_curator_task is not None and not self._hungarian_curator_task.done()
        return {"success": True, **self._hungarian_curator_progress,
                "status": "loading" if loading else ("cached" if self._hungarian_curator_checked_at else "unavailable"),
                "entries": len(self._hungarian_curator_app_ids),
                "stale": bool(self._hungarian_curator_last_error)}

    def _merge_hungarian_sources(self, requested: Any, official: Dict[str, Optional[bool]]) -> Dict[str, Any]:
        languages = dict(official)
        sources: Dict[str, Optional[str]] = {}
        for app_id in requested:
            if official.get(app_id) is True:
                languages[app_id], sources[app_id] = True, "steam"
            elif app_id in self._hungarian_curator_app_ids:
                languages[app_id], sources[app_id] = True, "curator"
            elif app_id in official:
                # Until a catalog is available, a Steam-only negative is not a
                # confirmed combined negative: it must not empty a collection.
                languages[app_id] = official[app_id] if self._hungarian_curator_checked_at else None
                sources[app_id] = None
        status = "loading" if self._hungarian_curator_task is not None and not self._hungarian_curator_task.done() else (
            "cached" if self._hungarian_curator_checked_at else "unavailable")
        return {"hungarian": languages, "hungarian_sources": sources, "curator_status": status}

    async def _load_gfn_cache(self) -> None:
        try:
            contents = await self._run_blocking(lambda: self._gfn_cache_path.read_text(encoding="utf-8"))
            parsed = json.loads(contents)
            checked_at = parsed.get("checked_at") if isinstance(parsed, dict) else None
            app_ids = parsed.get("steam_app_ids") if isinstance(parsed, dict) else None
            if isinstance(checked_at, (int, float)) and isinstance(app_ids, list):
                self._catalog_pending["gfn"] = self._valid_pending(parsed.get("pending_removals"))
                self._gfn_checked_at = float(checked_at)
                self._gfn_app_ids = {str(app_id) for app_id in app_ids if str(app_id).isdigit()}
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as error:
            decky.logger.warning("Ignoring invalid GeForce NOW cache: %s", error)

    async def _save_gfn_cache(self) -> None:
        async with self._gfn_lock:
            if not self._gfn_checked_at or not self._gfn_app_ids:
                return
            payload = json.dumps(
                {"checked_at": self._gfn_checked_at, "steam_app_ids": sorted(self._gfn_app_ids), "pending_removals": self._catalog_pending["gfn"]},
                separators=(",", ":"),
            )
            await self._run_blocking(self._write_file_atomically, self._gfn_cache_path, "gfn-cache-", payload)

    async def _load_boosteroid_cache(self) -> None:
        try:
            contents = await self._run_blocking(lambda: self._boosteroid_cache_path.read_text(encoding="utf-8"))
            parsed = json.loads(contents)
            schema_version = parsed.get("schema_version") if isinstance(parsed, dict) else None
            checked_at = parsed.get("checked_at") if isinstance(parsed, dict) else None
            app_ids = parsed.get("steam_app_ids") if isinstance(parsed, dict) else None
            maintenance_ids = parsed.get("maintenance_app_ids") if isinstance(parsed, dict) else None
            if (
                schema_version == BOOSTEROID_CACHE_SCHEMA_VERSION
                and isinstance(checked_at, (int, float))
                and isinstance(app_ids, list)
            ):
                self._catalog_pending["boosteroid"] = self._valid_pending(parsed.get("pending_removals"))
                self._boosteroid_checked_at = float(checked_at)
                self._boosteroid_app_ids = {str(app_id) for app_id in app_ids if str(app_id).isdigit()}
                if isinstance(maintenance_ids, list):
                    self._boosteroid_maintenance_app_ids = {
                        str(app_id)
                        for app_id in maintenance_ids
                        if str(app_id).isdigit() and str(app_id) in self._boosteroid_app_ids
                    }
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as error:
            decky.logger.warning("Ignoring invalid Boosteroid cache: %s", error)

    async def _save_boosteroid_cache(self) -> None:
        async with self._boosteroid_lock:
            if not self._boosteroid_checked_at or not self._boosteroid_app_ids:
                return
            payload = json.dumps(
                {
                    "schema_version": BOOSTEROID_CACHE_SCHEMA_VERSION,
                    "checked_at": self._boosteroid_checked_at,
                    "steam_app_ids": sorted(self._boosteroid_app_ids),
                    "maintenance_app_ids": sorted(self._boosteroid_maintenance_app_ids),
                    "pending_removals": self._catalog_pending["boosteroid"],
                },
                separators=(",", ":"),
            )
            await self._run_blocking(
                self._write_file_atomically,
                self._boosteroid_cache_path,
                "boosteroid-cache-",
                payload,
            )

    async def _load_settings(self) -> None:
        try:
            contents = await self._run_blocking(lambda: self._settings_path.read_text(encoding="utf-8"))
            parsed = json.loads(contents)
            if isinstance(parsed, dict) and parsed.get("schema_version") == SETTINGS_SCHEMA_VERSION:
                for key in (
                    "show_store_tile_prices",
                    "show_gfn_badges",
                    "show_boosteroid_badges",
                    "show_hungarian_badges",
                    "notify_gfn_additions",
                    "notify_boosteroid_additions",
                    "notify_boosteroid_maintenance",
                    "notify_plugin_updates",
                ):
                    if isinstance(parsed.get(key), bool):
                        self._settings[key] = parsed[key]
                sides = parsed.get("store_badge_sides")
                if isinstance(sides, dict):
                    self._settings["store_badge_sides"] = {key: value for key, value in sides.items()
                        if key in ("price", "controller", "gfn", "boosteroid", "hungarian", "watch", "proton") and value in ("left", "right")}
                for key in ("library_badge_percent", "store_badge_percent"):
                    value = parsed.get(key)
                    if type(value) is int and 50 <= value <= 200:
                        self._settings[key] = value
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as error:
            decky.logger.warning("Ignoring invalid ControllerXbox settings: %s", error)

    async def _save_settings(self) -> None:
        payload = json.dumps(
            {"schema_version": SETTINGS_SCHEMA_VERSION, **self._settings},
            separators=(",", ":"),
        )
        await self._run_blocking(
            self._write_file_atomically,
            self._settings_path,
            "controller-settings-",
            payload,
        )

    async def get_settings(self) -> Dict[str, Any]:
        return {"success": True, **self._settings}

    async def set_store_tile_prices(self, enabled: Any) -> Dict[str, Any]:
        if not isinstance(enabled, bool):
            return {"success": False, "error": "Érvénytelen kapcsolóérték."}
        previous = self._settings.get("show_store_tile_prices", False)
        self._settings["show_store_tile_prices"] = enabled
        try:
            await self._save_settings()
        except Exception:
            self._settings["show_store_tile_prices"] = previous
            raise
        return {"success": True, **self._settings}

    async def set_badge_sides(self, sides: Any) -> Dict[str, Any]:
        if not isinstance(sides, dict) or any(key not in ("price", "controller", "gfn", "boosteroid", "hungarian", "watch", "proton")
                or value not in ("left", "right") for key, value in sides.items()):
            return {"success": False, "error": "Érvénytelen jelvényoldal."}
        previous = self._settings.get("store_badge_sides", {})
        self._settings["store_badge_sides"] = dict(sides)
        try:
            await self._save_settings()
        except Exception:
            self._settings["store_badge_sides"] = previous
            raise
        return {"success": True, **self._settings}

    async def set_badge_sizes(self, library_badge_percent: Any, store_badge_percent: Any) -> Dict[str, Any]:
        if not all(type(value) is int and 50 <= value <= 200 for value in (library_badge_percent, store_badge_percent)):
            return {"success": False, "error": "Az ikonméret 50 és 200% közötti egész szám lehet."}
        self._settings.update({"library_badge_percent": library_badge_percent, "store_badge_percent": store_badge_percent})
        await self._save_settings()
        return {"success": True, **self._settings}

    async def set_badge_visibility(self, show_gfn_badges: Any, show_boosteroid_badges: Any,
                                   show_hungarian_badges: Any = None) -> Dict[str, Any]:
        if (not isinstance(show_gfn_badges, bool) or not isinstance(show_boosteroid_badges, bool)
                or (show_hungarian_badges is not None and not isinstance(show_hungarian_badges, bool))):
            return {"success": False, "error": "A jelvénybeállítás értéke érvénytelen."}
        self._settings.update({
            "show_gfn_badges": show_gfn_badges,
            "show_boosteroid_badges": show_boosteroid_badges,
        })
        if show_hungarian_badges is not None:
            self._settings["show_hungarian_badges"] = show_hungarian_badges
        await self._save_settings()
        return {"success": True, **self._settings}

    async def set_notification_preferences(
        self,
        notify_gfn_additions: Any,
        notify_boosteroid_additions: Any,
        notify_boosteroid_maintenance: Any,
        notify_plugin_updates: Any,
    ) -> Dict[str, Any]:
        values = (
            notify_gfn_additions,
            notify_boosteroid_additions,
            notify_boosteroid_maintenance,
            notify_plugin_updates,
        )
        if not all(isinstance(value, bool) for value in values):
            return {"success": False, "error": "Az értesítési beállítás értéke érvénytelen."}
        self._settings.update({
            "notify_gfn_additions": notify_gfn_additions,
            "notify_boosteroid_additions": notify_boosteroid_additions,
            "notify_boosteroid_maintenance": notify_boosteroid_maintenance,
            "notify_plugin_updates": notify_plugin_updates,
        })
        await self._save_settings()
        return {"success": True, **self._settings}

    async def _load_watchlist(self) -> None:
        try:
            contents = await self._run_blocking(lambda: self._watchlist_path.read_text(encoding="utf-8"))
            parsed = json.loads(contents)
            if not isinstance(parsed, dict) or parsed.get("schema_version") != WATCHLIST_SCHEMA_VERSION:
                return
            entries = parsed.get("entries", [])
            if not isinstance(entries, list):
                return
            loaded: Dict[str, Dict[str, Any]] = {}
            for entry in entries[:WATCHLIST_MAX_ENTRIES]:
                if not isinstance(entry, dict):
                    continue
                app_id = str(entry.get("app_id", ""))
                title = str(entry.get("title", "")).strip()
                added_at = entry.get("added_at", 0)
                if (
                    app_id.isdigit()
                    and 0 < int(app_id) < 10000000000
                    and title
                    and len(title) <= 200
                    and isinstance(added_at, (int, float))
                ):
                    loaded[app_id] = {
                        "app_id": app_id,
                        "title": title,
                        "added_at": float(added_at),
                        "watch_controller": entry.get("watch_controller") is True,
                        "controller_refresh_after": entry.get("controller_refresh_after", 0)
                        if type(entry.get("controller_refresh_after", 0)) in (int, float) else 0,
                        "watch_gfn": entry.get("watch_gfn")
                        if isinstance(entry.get("watch_gfn"), bool)
                        else True,
                        "watch_boosteroid": entry.get("watch_boosteroid")
                        if isinstance(entry.get("watch_boosteroid"), bool)
                        else True,
                    }
            self._watchlist = loaded
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError) as error:
            decky.logger.warning("Ignoring invalid ControllerXbox watchlist: %s", error)

    async def _save_watchlist(self) -> None:
        payload = json.dumps(
            {
                "schema_version": WATCHLIST_SCHEMA_VERSION,
                "entries": sorted(self._watchlist.values(), key=lambda entry: entry["title"].casefold()),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        await self._run_blocking(
            self._write_file_atomically,
            self._watchlist_path,
            "controller-watchlist-",
            payload,
        )

    async def get_watchlist(self) -> Dict[str, Any]:
        async with self._watchlist_lock:
            entries = [dict(entry) for entry in self._watchlist.values()]
        if not entries:
            return {"success": True, "entries": []}
        gfn_available, boosteroid_available = await asyncio.gather(
            self._ensure_gfn_catalog(),
            self._ensure_boosteroid_catalog(),
        )
        async with self._gfn_lock:
            gfn_app_ids = set(self._gfn_app_ids)
        async with self._boosteroid_lock:
            boosteroid_app_ids = set(self._boosteroid_app_ids)
            maintenance_app_ids = set(self._boosteroid_maintenance_app_ids)
        return {
            "success": True,
            "entries": [
                {
                    **entry,
                    "controller": self._cache.get(entry["app_id"], {}).get("controller_support_level", "unknown"),
                    "controller_checked_at": self._cache.get(entry["app_id"], {}).get("checked_at", 0),
                    "gfn": (
                        "available" if entry["app_id"] in gfn_app_ids else "unavailable" if self._gfn_last_error else "not_available"
                    ) if gfn_available else "unavailable",
                    "boosteroid": (
                        "maintenance"
                        if entry["app_id"] in maintenance_app_ids
                        else "available"
                        if entry["app_id"] in boosteroid_app_ids
                        else "unavailable" if self._boosteroid_last_error else "not_available"
                    ) if boosteroid_available else "unavailable",
                }
                for entry in sorted(entries, key=lambda item: item["title"].casefold())
            ],
        }

    async def add_watchlist_game(
        self,
        app_id: Any,
        watch_gfn: Any = True,
        watch_boosteroid: Any = True,
        watch_controller: Any = False,
    ) -> Dict[str, Any]:
        normalized = str(app_id).strip()
        if not normalized.isdigit() or not 0 < int(normalized) < 10000000000:
            return {"success": False, "error": "Adj meg egy érvényes Steam AppID-t."}
        if not all(isinstance(value, bool) for value in (watch_gfn, watch_boosteroid, watch_controller)):
            return {"success": False, "error": "A platformbeállítás érvénytelen."}
        if not watch_gfn and not watch_boosteroid and not watch_controller:
            return {"success": False, "error": "Legalább egy figyelési szempontot válassz ki."}
        async with self._watchlist_lock:
            already_present = normalized in self._watchlist
            if not already_present and len(self._watchlist) >= WATCHLIST_MAX_ENTRIES:
                return {"success": False, "error": "A figyelőlista legfeljebb 200 játékot tartalmazhat."}
        if already_present:
            return await self.set_watchlist_platforms(normalized, watch_gfn, watch_boosteroid, watch_controller)
        title = await self._run_blocking(self._fetch_steam_title, normalized)
        if not title:
            return {"success": False, "error": "A Steam-játék nem található vagy az Áruház nem válaszolt."}
        async with self._watchlist_lock:
            self._watchlist[normalized] = {
                "app_id": normalized,
                "title": title,
                "added_at": time.time(),
                "watch_gfn": watch_gfn,
                "watch_boosteroid": watch_boosteroid,
                "watch_controller": watch_controller,
            }
            await self._save_watchlist()
        await asyncio.gather(self._ensure_gfn_catalog(), self._ensure_boosteroid_catalog())
        await self._baseline_notification_app(normalized, watch_gfn, watch_boosteroid)
        await self._reset_controller_baseline(normalized)
        return await self.get_watchlist()

    async def set_watchlist_platforms(
        self,
        app_id: Any,
        watch_gfn: Any,
        watch_boosteroid: Any,
        watch_controller: Any = False,
    ) -> Dict[str, Any]:
        normalized = str(app_id).strip()
        if not all(isinstance(value, bool) for value in (watch_gfn, watch_boosteroid, watch_controller)):
            return {"success": False, "error": "A platformbeállítás érvénytelen."}
        if not watch_gfn and not watch_boosteroid and not watch_controller:
            return {"success": False, "error": "Legalább egy figyelési szempontot hagyj bekapcsolva."}
        async with self._watchlist_lock:
            entry = self._watchlist.get(normalized)
            if entry is None:
                return {"success": False, "error": "A játék nincs a figyelőlistán."}
            controller_enabled = watch_controller and not entry.get("watch_controller", False)
            entry["watch_controller"] = watch_controller
            entry["watch_gfn"] = watch_gfn
            entry["watch_boosteroid"] = watch_boosteroid
            await self._save_watchlist()
        await asyncio.gather(self._ensure_gfn_catalog(), self._ensure_boosteroid_catalog())
        await self._baseline_notification_app(normalized, watch_gfn, watch_boosteroid)
        if controller_enabled or not watch_controller:
            await self._reset_controller_baseline(normalized)
        return await self.get_watchlist()

    async def remove_watchlist_game(self, app_id: Any) -> Dict[str, Any]:
        normalized = str(app_id).strip()
        async with self._watchlist_lock:
            removed = self._watchlist.pop(normalized, None)
            if removed is not None:
                await self._save_watchlist()
        return await self.get_watchlist()

    def _search_steam_games_blocking(self, query: str) -> List[Dict[str, str]]:
        request = urllib.request.Request(
            STEAM_SEARCH_URL.format(term=urllib.parse.quote(query)),
            headers={"User-Agent": "ControllerXbox Decky Plugin/1.0"},
        )
        with self._open_request(request, timeout=15) as response:
            result = json.load(response)
        items = result.get("items", []) if isinstance(result, dict) else []
        matches: List[Dict[str, str]] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            app_id = str(item.get("id", ""))
            title = str(item.get("name", "")).strip()
            if app_id.isdigit() and title:
                matches.append({"app_id": app_id, "title": title[:200]})
            if len(matches) >= 8:
                break
        return matches

    async def search_steam_games(self, query: Any) -> Dict[str, Any]:
        normalized = str(query).strip()
        if len(normalized) < 2:
            return {"success": False, "error": "Írj be legalább két karaktert."}
        if len(normalized) > 100:
            return {"success": False, "error": "A keresés túl hosszú."}
        try:
            if normalized.isdigit() and 0 < int(normalized) < 10000000000:
                title = await self._run_blocking(self._fetch_steam_title, normalized)
                return {
                    "success": True,
                    "entries": [{"app_id": normalized, "title": title}] if title else [],
                }
            entries = await self._run_blocking(self._search_steam_games_blocking, normalized)
            return {"success": True, "entries": entries}
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
            return {"success": False, "error": "A Steam-keresés sikertelen: {}".format(error)}

    async def _run_blocking(self, function: Any, *args: Any) -> Any:
        """Run blocking file and network operations on Python 3.8 and newer."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, functools.partial(function, *args))

    @staticmethod
    def _write_file_atomically(path: Path, prefix: str, payload: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_path = tempfile.mkstemp(prefix=prefix, dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(payload)
            os.replace(temporary_path, path)
        finally:
            if os.path.exists(temporary_path):
                os.unlink(temporary_path)

    @staticmethod
    def _valid_app_ids(app_ids: Any) -> List[str]:
        if not isinstance(app_ids, list):
            return []
        return list(dict.fromkeys(str(app_id) for app_id in app_ids if str(app_id).isdigit()))[:100]

    @staticmethod
    def _is_fresh(entry: Dict[str, Any], now: float) -> bool:
        return (
            entry.get("schema_version") == CACHE_SCHEMA_VERSION
            and isinstance(entry.get("checked_at"), (int, float))
            and now - entry["checked_at"] < CACHE_TTL_SECONDS
        )

    @staticmethod
    def _hungarian_support(languages: Any) -> Optional[bool]:
        # STORE_URL explicitly requests English. Only parse the actual language
        # list; the HTML after <br> describes the full-audio asterisk.
        if not isinstance(languages, str) or not languages.strip():
            return None
        language_list = re.split(r"<br\s*/?>", languages, maxsplit=1, flags=re.IGNORECASE)[0]
        plain = html.unescape(re.sub(r"<[^>]*>", "", language_list))
        names = [name.strip().rstrip("*").strip().casefold() for name in plain.split(",")]
        return "hungarian" in names if any(names) else None

    def _fetch_support(self, app_id: str) -> Optional[Dict[str, Any]]:
        if time.time() < self._steam_backoff_until:
            return None
        request = urllib.request.Request(
            STORE_URL.format(app_id=app_id),
            headers={"User-Agent": "ControllerXbox Decky Plugin/1.0"},
        )
        try:
            with self._open_request(request, timeout=10) as response:
                result = json.load(response)
            app = result.get(app_id, {})
            if not app.get("success"):
                return None
            app_data = app.get("data", {})
            if not isinstance(app_data, dict):
                return None
            categories = app_data.get("categories", [])
            category_ids = {str(category.get("id")) for category in categories if isinstance(category, dict)}
            controller_support = str(app_data.get("controller_support", "")).lower()
            if "28" in category_ids or controller_support == "full":
                level = "full"
            elif "18" in category_ids or controller_support == "partial":
                level = "partial"
            else:
                level = "none"
            return {
                "controller_support_level": level,
                "hungarian": self._hungarian_support(app_data.get("supported_languages")),
            }
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
            if not isinstance(error, urllib.error.HTTPError) or error.code == 429 or error.code >= 500:
                with self._steam_error_lock:
                    self._steam_failures += 1
                    retry_seconds = min(900, 60 * (2 ** min(self._steam_failures - 1, 4)))
                if isinstance(error, urllib.error.HTTPError):
                    try:
                        retry_seconds = max(retry_seconds, min(3600, int(error.headers.get("Retry-After", "60"))))
                    except (TypeError, ValueError, AttributeError):
                        pass
                with self._steam_error_lock:
                    self._steam_backoff_until = max(self._steam_backoff_until, time.time() + retry_seconds)
            decky.logger.debug("Steam lookup failed for %s: %s", app_id, error)
            return None

    def _fetch_steam_title(self, app_id: str) -> Optional[str]:
        request = urllib.request.Request(
            STORE_URL.format(app_id=app_id),
            headers={"User-Agent": "ControllerXbox Decky Plugin/1.0"},
        )
        try:
            with self._open_request(request, timeout=10) as response:
                result = json.load(response)
            app = result.get(app_id, {})
            app_data = app.get("data", {}) if app.get("success") else {}
            title = str(app_data.get("name", "")).strip()
            return title[:200] if title else None
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
            decky.logger.debug("Steam title lookup failed for %s: %s", app_id, error)
            return None

    @staticmethod
    def _open_request(request: urllib.request.Request, timeout: int) -> Any:
        ssl_context = ssl.create_default_context(cafile=certifi.where()) if certifi else ssl.create_default_context()
        try:
            return urllib.request.urlopen(request, timeout=timeout, context=ssl_context)
        except urllib.error.URLError as error:
            # Some Decky Python environments do not expose SteamOS's CA
            # bundle. Only retry certificate-verification failures; both
            # endpoints contain public catalog data and no user credentials.
            if not isinstance(error.reason, ssl.SSLCertVerificationError):
                raise
            return urllib.request.urlopen(request, timeout=timeout, context=ssl._create_unverified_context())

    @staticmethod
    def _open_verified_request(request: urllib.request.Request, timeout: int) -> Any:
        """Open executable update data with strict TLS verification."""
        ssl_context = ssl.create_default_context(cafile=certifi.where()) if certifi else ssl.create_default_context()
        return urllib.request.urlopen(request, timeout=timeout, context=ssl_context)

    @staticmethod
    def _version_tuple(version: str) -> Any:
        match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", str(version).strip())
        if not match:
            return (0, 0, 0)
        return tuple(int(part) for part in match.groups())

    @staticmethod
    def _current_plugin_version() -> str:
        plugin_directory = getattr(decky, "DECKY_PLUGIN_DIR", "")
        try:
            package = json.loads((Path(plugin_directory) / "package.json").read_text(encoding="utf-8"))
            version = str(package.get("version", "")).strip()
            if re.fullmatch(r"\d+\.\d+\.\d+", version):
                return version
        except (OSError, ValueError, AttributeError):
            pass
        decky_version = str(getattr(decky, "DECKY_PLUGIN_VERSION", "")).lstrip("v")
        return decky_version if re.fullmatch(r"\d+\.\d+\.\d+", decky_version) else "0.0.0"

    def _fetch_release(self, version: Optional[str] = None) -> Dict[str, Any]:
        url = GITHUB_LATEST_RELEASE_URL if version is None else GITHUB_RELEASE_TAG_URL.format(version)
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "ControllerXbox Decky Plugin Updater",
            },
        )
        with self._open_verified_request(request, timeout=20) as response:
            release = json.load(response)
        if not isinstance(release, dict):
            raise ValueError("A GitHub hibás kiadási adatot küldött.")
        latest = str(release.get("tag_name", "")).strip().lstrip("v")
        if not re.fullmatch(r"\d+\.\d+\.\d+", latest):
            raise ValueError("A legújabb kiadás verziószáma érvénytelen.")
        expected_asset_name = "ControllerXbox-v{}.zip".format(latest)
        assets = release.get("assets", [])
        asset = next(
            (
                item
                for item in assets
                if isinstance(item, dict) and str(item.get("name", "")) == expected_asset_name
            ),
            None,
        )
        if not isinstance(asset, dict):
            raise ValueError("A kiadáshoz nem található ellenőrzött Decky ZIP.")
        download_url = str(asset.get("browser_download_url", ""))
        expected_prefix = GITHUB_DOWNLOAD_PREFIX + "v{}/".format(latest)
        if not download_url.startswith(expected_prefix) or not download_url.endswith("/" + expected_asset_name):
            raise ValueError("A kiadási ZIP címe nem megbízható.")
        return {
            "version": latest,
            "zip_url": download_url,
            "asset_size": asset.get("size"),
            "release_url": str(release.get("html_url", "")),
            "release_notes": str(release.get("body", "") or ""),
        }

    def _check_for_update_blocking(self) -> Dict[str, Any]:
        current = self._current_plugin_version()
        try:
            release = self._fetch_release()
            latest = str(release["version"])
            return {
                "success": True,
                "current_version": current,
                "latest_version": latest,
                "has_update": self._version_tuple(latest) > self._version_tuple(current),
                "asset_size": release.get("asset_size"),
                "release_url": release.get("release_url", ""),
                "release_notes": release.get("release_notes", ""),
            }
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
            decky.logger.error("Update check failed: %s", error)
            return {"success": False, "current_version": current, "error": str(error)}

    @staticmethod
    def _validate_update_archive(archive: zipfile.ZipFile, expected_version: str) -> None:
        expected_names = ["ControllerXbox/" + relative for relative in UPDATE_FILES]
        entries = archive.infolist()
        if [entry.filename for entry in entries] != expected_names:
            raise ValueError("A ZIP fájlszerkezete nem egyezik a ControllerXbox telepítőével.")
        if sum(entry.file_size for entry in entries) > UPDATE_MAX_BYTES:
            raise ValueError("A kicsomagolt frissítés túl nagy.")
        for entry in entries:
            if entry.is_dir() or entry.flag_bits != 0:
                raise ValueError("A ZIP nem támogatott vagy titkosított bejegyzést tartalmaz.")
            if (
                entry.compress_type != zipfile.ZIP_DEFLATED
                or entry.create_system != 0
                or entry.extract_version != 20
                or entry.external_attr != 0
            ):
                raise ValueError("A ZIP metaadatai nem egyeznek a biztonságos Decky-csomaggal.")
            path = Path(entry.filename)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("A ZIP veszélyes útvonalat tartalmaz.")
        invalid_entry = archive.testzip()
        if invalid_entry:
            raise ValueError("A ZIP sérült fájlt tartalmaz: {}".format(invalid_entry))
        package = json.loads(archive.read("ControllerXbox/package.json").decode("utf-8"))
        if str(package.get("version", "")) != expected_version:
            raise ValueError("A ZIP verziószáma nem egyezik a kiadással.")
        manifest = json.loads(archive.read("ControllerXbox/plugin.json").decode("utf-8"))
        if str(manifest.get("name", "")) not in PLUGIN_MANIFEST_NAMES:
            raise ValueError("A ZIP nem a Deck Play Badges plugin telepítője.")

    def _apply_update_blocking(self, expected_version: str) -> Dict[str, Any]:
        if not re.fullmatch(r"\d+\.\d+\.\d+", str(expected_version)):
            return {"success": False, "error": "Érvénytelen verziószám."}
        temporary_update_files: List[Path] = []
        replaced_files: List[str] = []
        try:
            release = self._fetch_release(str(expected_version))
            if str(release["version"]) != str(expected_version):
                raise ValueError("A GitHub kiadás verziószáma megváltozott.")
            plugin_directory_value = getattr(decky, "DECKY_PLUGIN_DIR", "")
            plugin_directory = Path(plugin_directory_value).resolve()
            if not plugin_directory.is_dir():
                raise OSError("A Decky pluginmappa nem található.")
            current_manifest = json.loads((plugin_directory / "plugin.json").read_text(encoding="utf-8"))
            if str(current_manifest.get("name", "")) not in PLUGIN_MANIFEST_NAMES:
                raise ValueError("A Decky pluginmappa nem a Deck Play Badgeshez tartozik.")

            with tempfile.TemporaryDirectory(prefix="controllerxbox-update-") as temporary_directory_value:
                temporary_directory = Path(temporary_directory_value)
                archive_path = temporary_directory / "update.zip"
                request = urllib.request.Request(
                    str(release["zip_url"]),
                    headers={"User-Agent": "ControllerXbox Decky Plugin Updater"},
                )
                with self._open_verified_request(request, timeout=120) as response, archive_path.open("wb") as stream:
                    declared_size = int(response.headers.get("Content-Length", "0") or 0)
                    if declared_size > UPDATE_MAX_BYTES:
                        raise ValueError("A letöltendő frissítés túl nagy.")
                    downloaded = 0
                    while True:
                        chunk = response.read(64 * 1024)
                        if not chunk:
                            break
                        downloaded += len(chunk)
                        if downloaded > UPDATE_MAX_BYTES:
                            raise ValueError("A letöltött frissítés túllépte a méretkorlátot.")
                        stream.write(chunk)

                extracted_directory = temporary_directory / "extracted"
                backup_directory = temporary_directory / "backup"
                extracted_directory.mkdir()
                backup_directory.mkdir()
                with zipfile.ZipFile(str(archive_path), "r") as archive:
                    self._validate_update_archive(archive, str(expected_version))
                    archive.extractall(str(extracted_directory))
                source_root = extracted_directory / "ControllerXbox"

                for relative in UPDATE_FILES:
                    source = source_root / relative
                    destination = plugin_directory / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    backup = backup_directory / relative
                    if destination.is_file():
                        backup.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(str(destination), str(backup))
                    staged = destination.with_name(destination.name + ".controllerxbox-update")
                    if staged.exists():
                        staged.unlink()
                    shutil.copy2(str(source), str(staged))
                    temporary_update_files.append(staged)

                try:
                    for relative in UPDATE_FILES:
                        destination = plugin_directory / relative
                        staged = destination.with_name(destination.name + ".controllerxbox-update")
                        os.replace(str(staged), str(destination))
                        replaced_files.append(relative)
                except Exception:
                    for relative in reversed(replaced_files):
                        destination = plugin_directory / relative
                        backup = backup_directory / relative
                        if backup.is_file():
                            restore = destination.with_name(destination.name + ".controllerxbox-restore")
                            shutil.copy2(str(backup), str(restore))
                            os.replace(str(restore), str(destination))
                        elif destination.exists():
                            destination.unlink()
                    raise

            decky.logger.info("ControllerXbox updated to %s", expected_version)
            return {"success": True, "version": str(expected_version), "restart_required": True}
        except Exception as error:
            decky.logger.exception("Update installation failed: %s", error)
            return {"success": False, "error": str(error)}
        finally:
            for temporary_path in temporary_update_files:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass

    async def check_for_update(self) -> Dict[str, Any]:
        return await self._run_blocking(self._check_for_update_blocking)

    async def get_update_notification(self) -> Dict[str, Any]:
        """Return an unseen update without coupling it to catalog refreshes."""
        update = await self._run_blocking(self._check_for_update_blocking)
        if not update.get("success"):
            return {
                "success": False,
                "update_version": "",
                "error": str(update.get("error", "A frissítés ellenőrzése sikertelen.")),
            }
        latest = str(update.get("latest_version", ""))
        if (
            not update.get("has_update")
            or not self._settings.get("notify_plugin_updates", True)
            or not re.fullmatch(r"\d+\.\d+\.\d+", latest)
        ):
            return {"success": True, "update_version": ""}
        async with self._notification_lock:
            state = await self._run_blocking(self._read_notification_state)
            last_notified_update = (
                str(state.get("last_notified_update", ""))
                if state.get("schema_version") == NOTIFICATION_SCHEMA_VERSION
                else ""
            )
        return {
            "success": True,
            "update_version": "" if latest == last_notified_update else latest,
        }

    async def acknowledge_update_notification(self, version: Any) -> Dict[str, Any]:
        """Mark an update as notified only after the frontend displayed it."""
        normalized = str(version).strip()
        if not re.fullmatch(r"\d+\.\d+\.\d+", normalized):
            return {"success": False, "error": "Érvénytelen verziószám."}
        async with self._notification_lock:
            state = await self._run_blocking(self._read_notification_state)
            if state.get("schema_version") != NOTIFICATION_SCHEMA_VERSION:
                state = {"schema_version": NOTIFICATION_SCHEMA_VERSION}
            state["last_notified_update"] = normalized
            state["checked_at"] = time.time()
            await self._run_blocking(
                self._write_file_atomically,
                self._notification_state_path,
                "controller-notifications-",
                json.dumps(state, separators=(",", ":")),
            )
        return {"success": True, "version": normalized}

    async def apply_update(self, expected_version: str) -> Dict[str, Any]:
        async with self._update_lock:
            return await self._run_blocking(self._apply_update_blocking, expected_version)

    async def restart_plugin_loader(self) -> Dict[str, Any]:
        """Reload the updated backend without requiring the user's sudo password."""
        def restart_after_response() -> None:
            time.sleep(1.5)
            try:
                subprocess.run(
                    ["sudo", "-n", "/usr/bin/systemctl", "restart", "plugin_loader"],
                    timeout=10,
                    check=True,
                )
            except Exception as error:
                decky.logger.error("Plugin loader restart failed: %s", error)

        threading.Thread(
            target=restart_after_response,
            daemon=True,
            name="controllerxbox-restart-loader",
        ).start()
        return {"success": True}

    def _fetch_gfn_catalog(self) -> Set[str]:
        steam_app_ids: Set[str] = set()
        seen_cursors: Set[str] = set()
        cursor: Optional[str] = None
        has_next_page = True
        for _ in range(20):
            after_clause = ", after:" + json.dumps(cursor) if cursor else ""
            query = (
                "{ apps(country:\"HU\" language:\"en_US\"" + after_clause + ") { "
                "numberReturned pageInfo { endCursor hasNextPage } "
                "items { variants { appStore storeId storeUrl } } } }"
            )
            request = urllib.request.Request(
                GFN_URL,
                data=query.encode("utf-8"),
                headers={
                    "Accept": "*/*",
                    "Content-Type": "application/json",
                    "Origin": "https://www.nvidia.com",
                    "Referer": "https://www.nvidia.com/",
                    "User-Agent": "ControllerXbox Decky Plugin/1.0",
                },
                method="POST",
            )
            with self._open_request(request, timeout=20) as response:
                result = json.load(response)
            if not isinstance(result, dict) or result.get("errors") or not isinstance(result.get("data"), dict):
                raise ValueError("Invalid GeForce NOW catalog response")
            apps = result["data"].get("apps")
            if not isinstance(apps, dict):
                raise ValueError("Invalid GeForce NOW catalog response")
            items = apps.get("items")
            page_info = apps.get("pageInfo")
            if (not isinstance(items, list) or not items or apps.get("numberReturned") != len(items)
                    or not isinstance(page_info, dict) or type(page_info.get("hasNextPage")) is not bool):
                raise ValueError("Incomplete GeForce NOW catalog page")
            for game in items:
                if not isinstance(game, dict):
                    raise ValueError("Invalid GeForce NOW game")
                if not isinstance(game.get("variants"), list):
                    raise ValueError("Invalid GeForce NOW variants")
                for variant in game.get("variants", []):
                    if not isinstance(variant, dict) or variant.get("appStore") != "STEAM":
                        continue
                    store_id = str(variant.get("storeId", "")).strip()
                    if store_id.isdigit():
                        steam_app_ids.add(store_id)
                        continue
                    match = re.search(r"/app/(\d+)", str(variant.get("storeUrl", "")))
                    if match:
                        steam_app_ids.add(match.group(1))
            page_info = apps.get("pageInfo", {})
            has_next_page = bool(page_info.get("hasNextPage")) if isinstance(page_info, dict) else False
            cursor = str(page_info.get("endCursor", "")) if isinstance(page_info, dict) else ""
            if not has_next_page:
                break
            if not cursor or cursor in seen_cursors:
                raise ValueError("GeForce NOW catalog cursor is missing")
            seen_cursors.add(cursor)
        if has_next_page:
            raise ValueError("GeForce NOW catalog exceeded the page limit")
        if not steam_app_ids:
            raise ValueError("GeForce NOW catalog contained no Steam games")
        return steam_app_ids

    async def _ensure_gfn_catalog(self, force: bool = False) -> bool:
        requested_at = time.time()
        async with self._gfn_lock:
            now = time.time()
            if self._gfn_app_ids and ((not force and not self._gfn_last_error and now - self._gfn_checked_at < GFN_CACHE_TTL_SECONDS) or self._gfn_checked_at >= requested_at):
                return True
            if not force and self._gfn_last_error and now - self._gfn_attempted_at < 60:
                return bool(self._gfn_app_ids)
            self._gfn_attempted_at = now
            try:
                fetched = await self._run_blocking(self._fetch_gfn_catalog)
                await self._accept_catalog("gfn", fetched)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
                self._gfn_last_error = str(error)
                decky.logger.warning("GeForce NOW catalog refresh failed: %s", error)
                return bool(self._gfn_app_ids)
            return True

    async def get_gfn_availability(self, app_ids: Any) -> Dict[str, Any]:
        requested = self._valid_app_ids(app_ids)
        available = await self._ensure_gfn_catalog()
        async with self._gfn_lock:
            if not available:
                return {
                    "success": False,
                    "availability": {},
                    "unavailable": requested,
                    "catalog_entries": 0,
                    "error": self._gfn_last_error or "GeForce NOW catalog unavailable",
                }
            return {
                "success": True,
                "availability": {app_id: True if app_id in self._gfn_app_ids else (None if self._gfn_last_error else False) for app_id in requested},
                "unavailable": [],
                "catalog_entries": len(self._gfn_app_ids),
                "cached_for_hours": GFN_CACHE_TTL_SECONDS / 3600,
                "checked_at": self._gfn_checked_at,
                "stale": bool(self._gfn_last_error),
            }

    @staticmethod
    def _normalize_game_name(name: str) -> str:
        without_platform = re.sub(r"\s*\(Steam\)\s*$", "", name, flags=re.IGNORECASE)
        decomposed = unicodedata.normalize("NFKD", without_platform)
        without_marks = "".join(character for character in decomposed if not unicodedata.combining(character))
        return "".join(character for character in without_marks.casefold() if character.isalnum())

    def _resolve_steam_app_id_by_name(self, title: str) -> Optional[str]:
        clean_title = re.sub(r"\s*\(Steam\)\s*$", "", title, flags=re.IGNORECASE).strip()
        request = urllib.request.Request(
            STEAM_SEARCH_URL.format(term=urllib.parse.quote(clean_title)),
            headers={"User-Agent": "ControllerXbox Decky Plugin/1.0"},
        )
        try:
            with self._open_request(request, timeout=15) as response:
                result = json.load(response)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
            decky.logger.debug("Steam title lookup failed for %s: %s", clean_title, error)
            return None
        items = result.get("items") if isinstance(result, dict) else None
        if not isinstance(items, list):
            return None
        normalized_title = self._normalize_game_name(clean_title)
        matches = {
            str(item.get("id"))
            for item in items
            if isinstance(item, dict)
            and str(item.get("id", "")).isdigit()
            and self._normalize_game_name(str(item.get("name", ""))) == normalized_title
        }
        return next(iter(matches)) if len(matches) == 1 else None

    def _fetch_boosteroid_catalog(self) -> Any:
        steam_app_ids: Set[str] = set()
        active_app_ids: Set[str] = set()
        maintenance_app_ids: Set[str] = set()
        unresolved_titles: Dict[str, List[bool]] = {}
        last_page: Optional[int] = None
        expected_total: Optional[int] = None
        seen_games: Set[int] = set()
        for page in range(1, 51):
            request = urllib.request.Request(
                BOOSTEROID_URL.format(page=page),
                headers={
                    "Accept": "application/json",
                    "Origin": "https://boosteroid.com",
                    "Referer": "https://boosteroid.com/games/",
                    "User-Agent": "ControllerXbox Decky Plugin/1.0",
                },
            )
            with self._open_request(request, timeout=20) as response:
                result = json.load(response)
            items = result.get("data") if isinstance(result, dict) else None
            meta = result.get("meta") if isinstance(result, dict) else None
            if not isinstance(items, list) or not isinstance(meta, dict):
                raise ValueError("Invalid Boosteroid catalog response")
            current_page = meta.get("current_page")
            reported_last_page = meta.get("last_page")
            if not isinstance(current_page, int) or current_page != page:
                raise ValueError("Boosteroid catalog page number is invalid")
            if not isinstance(reported_last_page, int) or reported_last_page < 1 or reported_last_page > 50:
                raise ValueError("Boosteroid catalog page count is invalid")
            if last_page is None:
                last_page = reported_last_page
            elif reported_last_page != last_page:
                raise ValueError("Boosteroid catalog page count changed during refresh")
            if page < reported_last_page and not items:
                raise ValueError("Boosteroid catalog page is empty")
            total, per_page = meta.get("total"), meta.get("per_page")
            if (type(total) is not int or total < 1 or type(per_page) is not int or per_page < 1
                    or (total + per_page - 1) // per_page != reported_last_page
                    or len(items) != min(per_page, total - (page - 1) * per_page)):
                raise ValueError("Incomplete Boosteroid catalog page")
            if expected_total is not None and total != expected_total:
                raise ValueError("Boosteroid catalog size changed during refresh")
            expected_total = total
            for game in items:
                if not isinstance(game, dict) or type(game.get("id")) is not int or game["id"] in seen_games:
                    raise ValueError("Invalid or repeated Boosteroid game")
                seen_games.add(game["id"])
                stores = game.get("stores")
                steam_url = stores.get("steam") if isinstance(stores, dict) else None
                match = re.search(r"/app/(\d+)", str(steam_url or ""))
                if not match:
                    match = re.search(
                        r"store\.steampowered\.com/app/(\d+)",
                        str(game.get("applicationLink") or ""),
                        re.IGNORECASE,
                    )
                if not match:
                    boosteroid_id = game.get("id")
                    app_id = (
                        BOOSTEROID_STEAM_APP_ID_OVERRIDES.get(boosteroid_id)
                        if isinstance(boosteroid_id, int)
                        else None
                    )
                    if not app_id:
                        title = str(game.get("name") or "").strip()
                        if title:
                            unresolved_titles.setdefault(title, []).append(bool(game.get("maintenance")))
                        continue
                else:
                    app_id = match.group(1)
                steam_app_ids.add(app_id)
                if game.get("maintenance"):
                    maintenance_app_ids.add(app_id)
                else:
                    active_app_ids.add(app_id)
            if page >= reported_last_page:
                break
        if last_page is None or page < last_page:
            raise ValueError("Boosteroid catalog exceeded the page limit")
        if unresolved_titles:
            resolved_titles: Dict[str, Optional[str]] = {}
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
                future_titles = {
                    executor.submit(self._resolve_steam_app_id_by_name, title): title
                    for title in unresolved_titles
                }
                for future, title in future_titles.items():
                    try:
                        resolved_titles[title] = future.result()
                    except Exception as error:
                        decky.logger.debug("Steam title resolver failed for %s: %s", title, error)
                        resolved_titles[title] = None
            for title, maintenance_states in unresolved_titles.items():
                app_id = resolved_titles.get(title)
                if not app_id:
                    continue
                steam_app_ids.add(app_id)
                if all(maintenance_states):
                    maintenance_app_ids.add(app_id)
                else:
                    active_app_ids.add(app_id)
        if not steam_app_ids:
            raise ValueError("Boosteroid catalog contained no Steam games")
        return steam_app_ids, maintenance_app_ids - active_app_ids

    async def _ensure_boosteroid_catalog(self, force: bool = False) -> bool:
        requested_at = time.time()
        async with self._boosteroid_lock:
            now = time.time()
            if (
                self._boosteroid_app_ids
                and ((not force and not self._boosteroid_last_error and now - self._boosteroid_checked_at < BOOSTEROID_CACHE_TTL_SECONDS)
                     or self._boosteroid_checked_at >= requested_at)
            ):
                return True
            if not force and self._boosteroid_last_error and now - self._boosteroid_attempted_at < 60:
                return bool(self._boosteroid_app_ids)
            self._boosteroid_attempted_at = now
            try:
                fetched_app_ids, fetched_maintenance_ids = await self._run_blocking(
                    self._fetch_boosteroid_catalog
                )
                await self._accept_catalog("boosteroid", fetched_app_ids, fetched_maintenance_ids)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
                self._boosteroid_last_error = str(error)
                decky.logger.warning("Boosteroid catalog refresh failed: %s", error)
                return bool(self._boosteroid_app_ids)
            return True

    async def refresh_cloud_catalogs(self) -> Dict[str, Any]:
        results = await asyncio.gather(self._ensure_gfn_catalog(force=True),
                                       self._ensure_boosteroid_catalog(force=True), return_exceptions=True)
        gfn_ok = results[0] is True and not self._gfn_last_error
        boosteroid_ok = results[1] is True and not self._boosteroid_last_error
        errors = []
        if not gfn_ok:
            errors.append("GFN: " + (self._gfn_last_error or str(results[0])))
        if not boosteroid_ok:
            errors.append("Boosteroid: " + (self._boosteroid_last_error or str(results[1])))
        return {"success": bool(gfn_ok and boosteroid_ok), "gfn_success": gfn_ok,
                "boosteroid_success": boosteroid_ok, "checked_at": time.time(), "error": "; ".join(errors)}

    async def get_boosteroid_availability(self, app_ids: Any) -> Dict[str, Any]:
        requested = self._valid_app_ids(app_ids)
        available = await self._ensure_boosteroid_catalog()
        async with self._boosteroid_lock:
            if not available:
                return {
                    "success": False,
                    "availability": {},
                    "maintenance": {},
                    "unavailable": requested,
                    "catalog_entries": 0,
                    "error": self._boosteroid_last_error or "Boosteroid catalog unavailable",
                }
            return {
                "success": True,
                "availability": {app_id: True if app_id in self._boosteroid_app_ids else (None if self._boosteroid_last_error else False) for app_id in requested},
                "maintenance": {
                    app_id: app_id in self._boosteroid_maintenance_app_ids for app_id in requested
                },
                "unavailable": [],
                "catalog_entries": len(self._boosteroid_app_ids),
                "cached_for_hours": BOOSTEROID_CACHE_TTL_SECONDS / 3600,
                "checked_at": self._boosteroid_checked_at,
                "stale": bool(self._boosteroid_last_error),
            }

    @staticmethod
    def _valid_library_app_ids(app_ids: Any) -> Set[str]:
        if not isinstance(app_ids, list):
            return set()
        return {
            str(app_id)
            for app_id in app_ids[:10000]
            if str(app_id).isdigit() and 0 < int(str(app_id)) < 10000000000
        }

    def _read_notification_state(self) -> Dict[str, Any]:
        try:
            parsed = json.loads(self._notification_state_path.read_text(encoding="utf-8"))
            return parsed if isinstance(parsed, dict) else {}
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError) as error:
            decky.logger.warning("Ignoring invalid notification state: %s", error)
            return {}

    def _read_notification_history(self) -> Dict[str, Any]:
        try:
            parsed = json.loads(self._notification_history_path.read_text(encoding="utf-8"))
            return parsed if isinstance(parsed, dict) else {}
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError) as error:
            decky.logger.warning("Ignoring invalid notification history: %s", error)
            return {}

    @staticmethod
    def _valid_app_names(app_names: Any) -> Dict[str, str]:
        if not isinstance(app_names, dict):
            return {}
        valid: Dict[str, str] = {}
        for app_id, value in list(app_names.items())[:10000]:
            normalized = str(app_id)
            title = str(value).strip()
            if normalized.isdigit() and title:
                valid[normalized] = title[:200]
        return valid

    @staticmethod
    def _valid_notification_history_entries(entries: Any) -> List[Dict[str, Any]]:
        if not isinstance(entries, list):
            return []
        valid: List[Dict[str, Any]] = []
        for entry in entries[:NOTIFICATION_HISTORY_MAX_ENTRIES]:
            if not isinstance(entry, dict):
                continue
            app_id = str(entry.get("app_id", ""))
            title = str(entry.get("title", "")).strip()
            platform = str(entry.get("platform", ""))
            event_type = str(entry.get("event_type", ""))
            created_at = entry.get("created_at")
            event_id = str(entry.get("id", ""))
            if (
                app_id.isdigit()
                and title
                and platform in {"gfn", "boosteroid", "controller"}
                and event_type in {"available", "maintenance", "partial", "full"}
                and isinstance(created_at, (int, float))
                and event_id
            ):
                valid.append({
                    "id": event_id[:300],
                    "platform": platform,
                    "event_type": event_type,
                    "app_id": app_id,
                    "title": title[:200],
                    "created_at": float(created_at),
                })
        return valid

    async def get_notification_history(self) -> Dict[str, Any]:
        async with self._notification_lock:
            history = await self._run_blocking(self._read_notification_history)
        entries = history.get("entries", []) if history.get("schema_version") == NOTIFICATION_HISTORY_SCHEMA_VERSION else []
        valid_entries = self._valid_notification_history_entries(entries)
        last_read_at = history.get("last_read_at", 0)
        if not isinstance(last_read_at, (int, float)):
            last_read_at = 0
        return {
            "success": True,
            "entries": valid_entries,
            "unread_count": sum(entry["created_at"] > float(last_read_at) for entry in valid_entries),
        }

    async def mark_notification_history_read(self) -> Dict[str, Any]:
        async with self._notification_lock:
            history = await self._run_blocking(self._read_notification_history)
            entries = self._valid_notification_history_entries(
                history.get("entries", [])
                if history.get("schema_version") == NOTIFICATION_HISTORY_SCHEMA_VERSION
                else []
            )
            await self._run_blocking(
                self._write_file_atomically,
                self._notification_history_path,
                "controller-notification-history-",
                json.dumps(
                    {
                        "schema_version": NOTIFICATION_HISTORY_SCHEMA_VERSION,
                        "entries": entries,
                        "last_read_at": time.time(),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            )
        return {"success": True, "entries": entries, "unread_count": 0}

    async def clear_notification_history(self) -> Dict[str, Any]:
        async with self._notification_lock:
            await self._run_blocking(
                self._write_file_atomically,
                self._notification_history_path,
                "controller-notification-history-",
                json.dumps(
                    {
                        "schema_version": NOTIFICATION_HISTORY_SCHEMA_VERSION,
                        "entries": [],
                        "last_read_at": time.time(),
                    },
                    separators=(",", ":"),
                ),
            )
        return {"success": True, "entries": [], "unread_count": 0}

    async def _baseline_notification_app(
        self,
        app_id: str,
        baseline_gfn: bool = True,
        baseline_boosteroid: bool = True,
    ) -> None:
        async with self._gfn_lock:
            in_gfn = app_id in self._gfn_app_ids
        async with self._boosteroid_lock:
            in_boosteroid = app_id in self._boosteroid_app_ids
            in_maintenance = app_id in self._boosteroid_maintenance_app_ids
        async with self._notification_lock:
            state = await self._run_blocking(self._read_notification_state)
            if state.get("schema_version") != NOTIFICATION_SCHEMA_VERSION:
                return
            for key, present in (
                ("gfn_available", in_gfn if baseline_gfn else None),
                ("boosteroid_available", in_boosteroid if baseline_boosteroid else None),
                ("boosteroid_maintenance", in_maintenance if baseline_boosteroid else None),
            ):
                if present is None:
                    continue
                values = {str(value) for value in state.get(key, []) if str(value).isdigit()}
                if present:
                    values.add(app_id)
                else:
                    values.discard(app_id)
                state[key] = sorted(values, key=int)
            await self._run_blocking(
                self._write_file_atomically,
                self._notification_state_path,
                "controller-notifications-",
                json.dumps(state, separators=(",", ":")),
            )

    async def _reset_controller_baseline(self, app_id: str) -> None:
        async with self._notification_lock:
            state = await self._run_blocking(self._read_notification_state)
            levels = state.get("controller_levels", {})
            if isinstance(levels, dict):
                levels.pop(app_id, None)
                state["controller_levels"] = levels
                await self._run_blocking(self._write_file_atomically, self._notification_state_path,
                                         "controller-notifications-", json.dumps(state, separators=(",", ":")))

    async def _watched_controller_levels(self, watchlist: Dict[str, Dict[str, Any]]) -> Dict[str, str]:
        ids = [key for key, entry in watchlist.items() if entry.get("watch_controller", False)]
        now = time.time()
        pending = sorted((key for key in ids if not self._is_fresh(self._cache.get(key, {}), now)
                          or self._cache[key].get("controller_support_level") not in {"none", "partial", "full"}
                          or now - self._cache[key]["checked_at"] >= 86400
                          or self._cache[key]["checked_at"] < watchlist[key].get("controller_refresh_after", 0)),
                         key=lambda key: self._cache.get(key, {}).get("checked_at", 0))
        # Bound notification latency even for a large watchlist; failed entries
        # in backoff must not starve the remaining games.
        pending = [key for key in pending if self._steam_retry.get(key, {}).get("retry_at", 0) <= now]
        await asyncio.gather(*(self._get_support_shared(key, 0) for key in pending[:8]))
        return {key: self._cache[key]["controller_support_level"] for key in ids
                if self._is_fresh(self._cache.get(key, {}), time.time())
                and time.time() - self._cache[key]["checked_at"] < 86400
                and self._cache[key]["checked_at"] >= watchlist[key].get("controller_refresh_after", 0)
                and self._cache[key].get("controller_support_level") in {"none", "partial", "full"}}

    async def get_notification_events(self, app_ids: Any, app_names: Any = None, refresh_controllers: Any = False) -> Dict[str, Any]:
        """Return each catalog/update change once for the library and watchlist."""
        library_app_ids = self._valid_library_app_ids(app_ids)
        supplied_names = self._valid_app_names(app_names)
        async with self._watchlist_lock:
            if refresh_controllers is True:
                for entry in self._watchlist.values():
                    if entry.get("watch_controller", False):
                        entry["controller_refresh_after"] = time.time()
                await self._save_watchlist()
            watchlist = {app_id: dict(entry) for app_id, entry in self._watchlist.items()}
        current_controller = await self._watched_controller_levels(watchlist)
        tracked_app_ids = library_app_ids | set(watchlist)
        gfn_tracked_app_ids = library_app_ids | {
            app_id for app_id, entry in watchlist.items() if entry.get("watch_gfn", True)
        }
        boosteroid_tracked_app_ids = library_app_ids | {
            app_id for app_id, entry in watchlist.items() if entry.get("watch_boosteroid", True)
        }
        known_names = {
            app_id: supplied_names.get(app_id, str(entry.get("title", "")).strip())
            for app_id, entry in watchlist.items()
        }
        known_names.update(supplied_names)
        gfn_available, boosteroid_available = await asyncio.gather(
            self._ensure_gfn_catalog(),
            self._ensure_boosteroid_catalog(),
        )

        gfn_available = gfn_available and not self._gfn_last_error
        boosteroid_available = boosteroid_available and not self._boosteroid_last_error
        async with self._gfn_lock:
            current_gfn = self._gfn_app_ids & gfn_tracked_app_ids
        async with self._boosteroid_lock:
            current_boosteroid = self._boosteroid_app_ids & boosteroid_tracked_app_ids
            current_maintenance = self._boosteroid_maintenance_app_ids & boosteroid_tracked_app_ids

        async with self._notification_lock:
            state = await self._run_blocking(self._read_notification_state)
            valid_state = state.get("schema_version") == NOTIFICATION_SCHEMA_VERSION
            previous_gfn = {
                str(app_id) for app_id in state.get("gfn_available", []) if str(app_id).isdigit()
            } if valid_state else set()
            previous_boosteroid = {
                str(app_id) for app_id in state.get("boosteroid_available", []) if str(app_id).isdigit()
            } if valid_state else set()
            previous_maintenance = {
                str(app_id) for app_id in state.get("boosteroid_maintenance", []) if str(app_id).isdigit()
            } if valid_state else set()
            gfn_initialized = bool(state.get("gfn_initialized")) if valid_state else False
            boosteroid_initialized = bool(state.get("boosteroid_initialized")) if valid_state else False

            gfn_added_app_ids = (
                sorted(current_gfn - previous_gfn, key=int)
                if gfn_available and gfn_initialized
                else []
            )
            boosteroid_added_app_ids = (
                sorted(current_boosteroid - previous_boosteroid, key=int)
                if boosteroid_available and boosteroid_initialized
                else []
            )
            boosteroid_maintenance_app_ids = (
                sorted(current_maintenance - previous_maintenance, key=int)
                if boosteroid_available and boosteroid_initialized
                else []
            )

            previous_controller = state.get("controller_levels", {}) if valid_state else {}
            if not isinstance(previous_controller, dict):
                previous_controller = {}
            previous_controller = {key: value for key, value in previous_controller.items()
                                   if key in watchlist and watchlist[key].get("watch_controller", False)
                                   and value in {"none", "partial", "full"}}
            ranks = {"none": 0, "partial": 1, "full": 2}
            controller_improved = sorted(key for key, value in current_controller.items()
                                         if key in previous_controller and ranks[value] > ranks[previous_controller[key]])
            previous_controller.update(current_controller)
            last_notified_update = str(state.get("last_notified_update", "")) if valid_state else ""

            next_state = {
                "schema_version": NOTIFICATION_SCHEMA_VERSION,
                "controller_levels": previous_controller,
                "gfn_initialized": gfn_initialized or bool(gfn_available and gfn_tracked_app_ids),
                "boosteroid_initialized": boosteroid_initialized or bool(
                    boosteroid_available and boosteroid_tracked_app_ids
                ),
                "gfn_available": (
                    sorted(current_gfn | (previous_gfn - gfn_tracked_app_ids), key=int)
                    if gfn_available and gfn_tracked_app_ids
                    else sorted(previous_gfn)
                ),
                "boosteroid_available": (
                    sorted(current_boosteroid | (previous_boosteroid - boosteroid_tracked_app_ids), key=int)
                    if boosteroid_available and boosteroid_tracked_app_ids
                    else sorted(previous_boosteroid)
                ),
                "boosteroid_maintenance": (
                    sorted(current_maintenance | (previous_maintenance - boosteroid_tracked_app_ids), key=int)
                    if boosteroid_available and boosteroid_tracked_app_ids
                    else sorted(previous_maintenance)
                ),
                "last_notified_update": last_notified_update,
                "checked_at": time.time(),
            }
            await self._run_blocking(
                self._write_file_atomically,
                self._notification_state_path,
                "controller-notifications-",
                json.dumps(next_state, separators=(",", ":")),
            )

            history_events = [("controller", current_controller[key], key) for key in controller_improved] + [
                ("gfn", "available", app_id) for app_id in gfn_added_app_ids
            ] + [
                ("boosteroid", "available", app_id) for app_id in boosteroid_added_app_ids
            ] + [
                ("boosteroid", "maintenance", app_id) for app_id in boosteroid_maintenance_app_ids
            ]
            if history_events:
                history = await self._run_blocking(self._read_notification_history)
                previous_entries = self._valid_notification_history_entries(
                    history.get("entries", [])
                    if history.get("schema_version") == NOTIFICATION_HISTORY_SCHEMA_VERSION
                    else []
                )
                created_at = time.time()
                new_entries = [
                    {
                        "id": "{}-{}-{}-{}".format(int(created_at * 1000), platform, event_type, app_id),
                        "platform": platform,
                        "event_type": event_type,
                        "app_id": app_id,
                        "title": known_names.get(app_id) or "Steam AppID {}".format(app_id),
                        "created_at": created_at,
                    }
                    for platform, event_type, app_id in history_events
                ]
                await self._run_blocking(
                    self._write_file_atomically,
                    self._notification_history_path,
                    "controller-notification-history-",
                    json.dumps(
                        {
                            "schema_version": NOTIFICATION_HISTORY_SCHEMA_VERSION,
                            "entries": (new_entries + previous_entries)[:NOTIFICATION_HISTORY_MAX_ENTRIES],
                            "last_read_at": history.get("last_read_at", 0)
                            if isinstance(history.get("last_read_at", 0), (int, float))
                            else 0,
                        },
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                )

        event_app_ids = set(controller_improved) | set(gfn_added_app_ids) | set(boosteroid_added_app_ids) | set(boosteroid_maintenance_app_ids)
        event_names = {
            app_id: known_names.get(app_id) or "Steam AppID {}".format(app_id)
            for app_id in event_app_ids
        }

        return {
            "success": True,
            "tracked_games": len(tracked_app_ids),
            "controller_improved_app_ids": controller_improved,
            "controller_pending": sum(1 for key, entry in watchlist.items()
                                      if entry.get("watch_controller", False) and key not in current_controller
                                      and self._steam_retry.get(key, {}).get("retry_at", 0) <= time.time())
                                      if self._steam_backoff_until <= time.time() else 0,
            "gfn_added": (
                len(gfn_added_app_ids) if self._settings.get("notify_gfn_additions", True) else 0
            ),
            "gfn_added_app_ids": (
                gfn_added_app_ids if self._settings.get("notify_gfn_additions", True) else []
            ),
            "boosteroid_added": (
                len(boosteroid_added_app_ids)
                if self._settings.get("notify_boosteroid_additions", True)
                else 0
            ),
            "boosteroid_added_app_ids": (
                boosteroid_added_app_ids
                if self._settings.get("notify_boosteroid_additions", True)
                else []
            ),
            "boosteroid_maintenance": (
                len(boosteroid_maintenance_app_ids)
                if self._settings.get("notify_boosteroid_maintenance", True)
                else 0
            ),
            "boosteroid_maintenance_app_ids": (
                boosteroid_maintenance_app_ids
                if self._settings.get("notify_boosteroid_maintenance", True)
                else []
            ),
            "app_names": event_names,
        }

    async def get_hungarian_library_cache(self, app_ids: Any) -> Dict[str, Any]:
        """Match the entire supplied library against both cached language sources."""
        requested = self._valid_library_app_ids(app_ids)
        self._start_hungarian_curator_refresh()
        now = time.time()
        languages: Dict[str, Optional[bool]] = {}
        async with self._lock:
            for app_id in requested:
                entry = self._cache.get(app_id)
                if isinstance(entry, dict) and self._is_fresh(entry, now):
                    value = entry.get("hungarian")
                    languages[app_id] = value if isinstance(value, bool) else None
        return {"success": True, **self._merge_hungarian_sources(requested, languages),
                "scan_epoch": self._steam_scan_epoch,
                "scan_attempts": {key: value["attempted_at"] for key, value in self._steam_retry.items() if key in requested},
                "scan_retry_after": {key: value["retry_at"] for key, value in self._steam_retry.items() if key in requested}}

    async def get_controller_support(self, app_ids: Any) -> Dict[str, Any]:
        """Return official controller and Hungarian language support from one Steam lookup."""
        requested = self._valid_app_ids(app_ids)
        self._start_hungarian_curator_refresh()
        now = time.time()
        results: Dict[str, bool] = {}
        levels: Dict[str, str] = {}
        hungarian: Dict[str, Optional[bool]] = {}
        missing: List[str] = []
        unavailable: List[str] = []

        async with self._lock:
            for app_id in requested:
                entry = self._cache.get(app_id)
                if isinstance(entry, dict) and self._is_fresh(entry, now):
                    level = entry.get("controller_support_level")
                    if level in {"full", "partial", "none"}:
                        levels[app_id] = level
                        results[app_id] = level != "none"
                        language = entry.get("hungarian")
                        hungarian[app_id] = language if isinstance(language, bool) else None
                    else:
                        missing.append(app_id)
                else:
                    missing.append(app_id)

        fetched = await asyncio.gather(*(self._get_support_shared(app_id) for app_id in missing))
        for app_id, details in zip(missing, fetched):
            if details is not None:
                level = details["controller_support_level"]
                levels[app_id] = level
                results[app_id] = level != "none"
                hungarian[app_id] = details["hungarian"]
            else:
                unavailable.append(app_id)
                hungarian[app_id] = None
        return {
            "success": True,
            "support": results,
            "levels": levels,
            **self._merge_hungarian_sources(requested, hungarian),
            "unavailable": unavailable,
            "cached_for_days": 30,
            "retry_after": max(0, int(self._steam_backoff_until - time.time() + 0.999)),
        }

    def _delete_cache_file(self) -> None:
        try:
            self._cache_path.unlink()
        except FileNotFoundError:
            pass

    def _delete_gfn_cache_file(self) -> None:
        try:
            self._gfn_cache_path.unlink()
        except FileNotFoundError:
            pass

    def _delete_boosteroid_cache_file(self) -> None:
        try:
            self._boosteroid_cache_path.unlink()
        except FileNotFoundError:
            pass

    async def clear_cache(self) -> Dict[str, Any]:
        await self.clear_price_cache()
        self._steam_scan_epoch = time.time()
        self._steam_retry.clear()
        self._steam_backoff_until = 0.0
        self._steam_failures = 0
        await self._save_steam_scan_state()
        await self._stop_hungarian_curator_refresh()
        self._hungarian_curator_app_ids = set()
        self._hungarian_curator_checked_at = 0.0
        self._hungarian_curator_attempted_at = 0.0
        self._hungarian_curator_last_error = ""
        try:
            await self._run_blocking(self._hungarian_curator_cache_path.unlink)
        except FileNotFoundError:
            pass
        except OSError as error:
            decky.logger.warning("Could not remove Hungarian curator cache: %s", error)
        async with self._lock:
            removed = len(self._cache)
            self._cache = {}
            try:
                await self._run_blocking(self._delete_cache_file)
            except OSError as error:
                decky.logger.warning("Could not remove controller cache: %s", error)
        async with self._gfn_lock:
            gfn_removed = len(self._gfn_app_ids)
            self._catalog_pending["gfn"] = {}
            self._gfn_app_ids = set()
            self._gfn_checked_at = 0.0
            self._gfn_last_error = ""
            try:
                await self._run_blocking(self._delete_gfn_cache_file)
            except OSError as error:
                decky.logger.warning("Could not remove GeForce NOW cache: %s", error)
        async with self._boosteroid_lock:
            boosteroid_removed = len(self._boosteroid_app_ids)
            self._catalog_pending["boosteroid"] = {}
            self._boosteroid_app_ids = set()
            self._boosteroid_maintenance_app_ids = set()
            self._boosteroid_checked_at = 0.0
            self._boosteroid_last_error = ""
            try:
                await self._run_blocking(self._delete_boosteroid_cache_file)
            except OSError as error:
                decky.logger.warning("Could not remove Boosteroid cache: %s", error)
        return {
            "success": True,
            "removed": removed,
            "gfn_removed": gfn_removed,
            "boosteroid_removed": boosteroid_removed,
        }

    async def get_cache_stats(self) -> Dict[str, Any]:
        now = time.time()
        async with self._lock:
            fresh = sum(1 for entry in self._cache.values() if isinstance(entry, dict) and self._is_fresh(entry, now))
        async with self._gfn_lock:
            gfn_fresh = bool(self._gfn_app_ids and now - self._gfn_checked_at < GFN_CACHE_TTL_SECONDS)
        async with self._boosteroid_lock:
            boosteroid_fresh = bool(
                self._boosteroid_app_ids
                and now - self._boosteroid_checked_at < BOOSTEROID_CACHE_TTL_SECONDS
            )
            return {
                "success": True,
                **self._price_stats(),
                "entries": len(self._cache),
                "fresh_entries": fresh,
                "ttl_days": 30,
                "gfn_catalog_entries": len(self._gfn_app_ids),
                "gfn_cache_fresh": gfn_fresh,
                "boosteroid_catalog_entries": len(self._boosteroid_app_ids),
                "boosteroid_cache_fresh": boosteroid_fresh,
            }

    async def get_backend_diagnostics(self) -> Dict[str, Any]:
        """Network-free health check for the manual frontend start button."""
        stats = await self.get_cache_stats()
        return {
            **stats,
            "backend": "ready",
            "settings_directory": str(self._cache_path.parent),
        }
