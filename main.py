"""Decky backend for ControllerXbox.

Only Steam app IDs supplied by the visible-library frontend are requested.  The
Steam Store appdetails endpoint is public and does not require an API key.
"""

import asyncio
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import decky


CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
STORE_URL = "https://store.steampowered.com/api/appdetails?appids={app_id}&l=english&cc=us"


class Plugin:
    def __init__(self) -> None:
        self._cache: dict[str, dict[str, Any]] = {}
        self._session_loaded_app_ids: set[str] = set()
        self._cache_path = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "controller-support-cache.json"
        self._lock = asyncio.Lock()

    async def _main(self) -> None:
        await self._load_cache()
        decky.logger.info("ControllerXbox backend loaded")

    async def _unload(self) -> None:
        await self._save_cache()

    async def _load_cache(self) -> None:
        try:
            contents = await asyncio.to_thread(self._cache_path.read_text, encoding="utf-8")
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
            await asyncio.to_thread(self._write_cache_atomically, payload)

    def _write_cache_atomically(self, payload: str) -> None:
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_path = tempfile.mkstemp(prefix="controller-cache-", dir=self._cache_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(payload)
            os.replace(temporary_path, self._cache_path)
        finally:
            if os.path.exists(temporary_path):
                os.unlink(temporary_path)

    @staticmethod
    def _valid_app_ids(app_ids: Any) -> list[str]:
        if not isinstance(app_ids, list):
            return []
        return list(dict.fromkeys(str(app_id) for app_id in app_ids if str(app_id).isdigit()))[:100]

    @staticmethod
    def _is_fresh(entry: dict[str, Any], now: float) -> bool:
        return isinstance(entry.get("checked_at"), (int, float)) and now - entry["checked_at"] < CACHE_TTL_SECONDS

    def _fetch_support(self, app_id: str) -> bool | None:
        request = urllib.request.Request(
            STORE_URL.format(app_id=app_id),
            headers={"User-Agent": "ControllerXbox Decky Plugin/1.0"},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.load(response)
            app = result.get(app_id, {})
            if not app.get("success"):
                return None
            categories = app.get("data", {}).get("categories", [])
            # Steam category 28 is the Store's official "Full controller support".
            return any(category.get("id") == 28 for category in categories if isinstance(category, dict))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
            decky.logger.debug("Steam lookup failed for %s: %s", app_id, error)
            return None

    async def get_controller_support(self, app_ids: Any) -> dict[str, Any]:
        """Return official Full Controller Support data for the supplied visible app IDs."""
        requested = self._valid_app_ids(app_ids)
        now = time.time()
        results: dict[str, bool] = {}
        missing: list[str] = []

        async with self._lock:
            for app_id in requested:
                entry = self._cache.get(app_id)
                if isinstance(entry, dict) and self._is_fresh(entry, now):
                    results[app_id] = bool(entry.get("full_controller_support"))
                else:
                    missing.append(app_id)

        fetched = await asyncio.gather(*(asyncio.to_thread(self._fetch_support, app_id) for app_id in missing))
        changed = False
        async with self._lock:
            for app_id, support in zip(missing, fetched):
                if support is not None:
                    self._cache[app_id] = {"full_controller_support": support, "checked_at": now}
                    self._session_loaded_app_ids.add(app_id)
                    results[app_id] = support
                    changed = True
        if changed:
            await self._save_cache()
        return {"success": True, "support": results, "cached_for_days": 30}

    async def clear_cache(self) -> dict[str, Any]:
        async with self._lock:
            removed = len(self._cache)
            self._cache = {}
            self._session_loaded_app_ids = set()
            try:
                await asyncio.to_thread(self._cache_path.unlink, missing_ok=True)
            except OSError as error:
                decky.logger.warning("Could not remove controller cache: %s", error)
        return {"success": True, "removed": removed}

    async def get_cache_stats(self) -> dict[str, Any]:
        now = time.time()
        async with self._lock:
            fresh = sum(1 for entry in self._cache.values() if isinstance(entry, dict) and self._is_fresh(entry, now))
            full_controller_supported = sum(
                1
                for entry in self._cache.values()
                if isinstance(entry, dict) and entry.get("full_controller_support") is True
            )
            return {
                "success": True,
                "entries": len(self._cache),
                "memory_entries": len(self._cache),
                "session_loaded_entries": len(self._session_loaded_app_ids),
                "full_controller_supported_entries": full_controller_supported,
                "fresh_entries": fresh,
                "ttl_days": 30,
            }
