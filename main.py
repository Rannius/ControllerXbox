"""Decky backend for ControllerXbox.

Steam app IDs supplied by the frontend are checked, including the library scan
for the optional Hungarian collection. The Steam Store, NVIDIA GeForce NOW,
and Boosteroid catalog endpoints, including the Magyar Felirat curator list,
are public and require no API key.
"""

import asyncio
import concurrent.futures
import functools
import html
import json
import os
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
CACHE_SCHEMA_VERSION = 6
STORE_URL = "https://store.steampowered.com/api/appdetails?appids={app_id}&l=english&cc=us"
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
        await self._load_cache()
        await self._load_steam_scan_state()
        await self._load_hungarian_curator_cache()
        await self._load_gfn_cache()
        await self._load_boosteroid_cache()
        await self._load_settings()
        await self._load_watchlist()
        decky.logger.info("ControllerXbox backend loaded")

    async def _unload(self) -> None:
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

    async def _get_support_shared(self, app_id: str) -> Optional[Dict[str, Any]]:
        if self._steam_stopping:
            return None
        task = self._steam_tasks.get(app_id)
        if task is None:
            task = asyncio.create_task(self._lookup_and_save_support(app_id, self._steam_scan_epoch))
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

    async def _lookup_and_save_support(self, app_id: str, epoch: float) -> Optional[Dict[str, Any]]:
        async with self._steam_gate:
            if self._steam_stopping or epoch != self._steam_scan_epoch:
                return None
            entry = self._cache.get(app_id)
            now = time.time()
            if isinstance(entry, dict) and self._is_fresh(entry, now) and entry.get("controller_support_level") in {"full", "partial", "none"}:
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
    ) -> Dict[str, Any]:
        normalized = str(app_id).strip()
        if not normalized.isdigit() or not 0 < int(normalized) < 10000000000:
            return {"success": False, "error": "Adj meg egy érvényes Steam AppID-t."}
        if not isinstance(watch_gfn, bool) or not isinstance(watch_boosteroid, bool):
            return {"success": False, "error": "A platformbeállítás érvénytelen."}
        if not watch_gfn and not watch_boosteroid:
            return {"success": False, "error": "Legalább egy platformot válassz ki."}
        async with self._watchlist_lock:
            already_present = normalized in self._watchlist
            if not already_present and len(self._watchlist) >= WATCHLIST_MAX_ENTRIES:
                return {"success": False, "error": "A figyelőlista legfeljebb 200 játékot tartalmazhat."}
        if already_present:
            return await self.set_watchlist_platforms(normalized, watch_gfn, watch_boosteroid)
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
            }
            await self._save_watchlist()
        await asyncio.gather(self._ensure_gfn_catalog(), self._ensure_boosteroid_catalog())
        await self._baseline_notification_app(normalized, watch_gfn, watch_boosteroid)
        return await self.get_watchlist()

    async def set_watchlist_platforms(
        self,
        app_id: Any,
        watch_gfn: Any,
        watch_boosteroid: Any,
    ) -> Dict[str, Any]:
        normalized = str(app_id).strip()
        if not isinstance(watch_gfn, bool) or not isinstance(watch_boosteroid, bool):
            return {"success": False, "error": "A platformbeállítás érvénytelen."}
        if not watch_gfn and not watch_boosteroid:
            return {"success": False, "error": "Legalább egy platformot hagyj bekapcsolva."}
        async with self._watchlist_lock:
            entry = self._watchlist.get(normalized)
            if entry is None:
                return {"success": False, "error": "A játék nincs a figyelőlistán."}
            entry["watch_gfn"] = watch_gfn
            entry["watch_boosteroid"] = watch_boosteroid
            await self._save_watchlist()
        await asyncio.gather(self._ensure_gfn_catalog(), self._ensure_boosteroid_catalog())
        await self._baseline_notification_app(normalized, watch_gfn, watch_boosteroid)
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
                and platform in {"gfn", "boosteroid"}
                and event_type in {"available", "maintenance"}
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

    async def get_notification_events(self, app_ids: Any, app_names: Any = None) -> Dict[str, Any]:
        """Return each catalog/update change once for the library and watchlist."""
        library_app_ids = self._valid_library_app_ids(app_ids)
        supplied_names = self._valid_app_names(app_names)
        async with self._watchlist_lock:
            watchlist = {app_id: dict(entry) for app_id, entry in self._watchlist.items()}
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

            last_notified_update = str(state.get("last_notified_update", "")) if valid_state else ""

            next_state = {
                "schema_version": NOTIFICATION_SCHEMA_VERSION,
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

            history_events = [
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

        event_app_ids = set(gfn_added_app_ids) | set(boosteroid_added_app_ids) | set(boosteroid_maintenance_app_ids)
        event_names = {
            app_id: known_names.get(app_id) or "Steam AppID {}".format(app_id)
            for app_id in event_app_ids
        }

        return {
            "success": True,
            "tracked_games": len(tracked_app_ids),
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
