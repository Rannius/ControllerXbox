"""Decky backend for ControllerXbox.

Only Steam app IDs supplied by the visible-library frontend are requested.  The
Steam Store appdetails endpoint is public and does not require an API key.
"""

import asyncio
import functools
import json
import os
import ssl
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

import decky

try:
    import certifi
except ImportError:
    certifi = None


CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
CACHE_SCHEMA_VERSION = 4
STORE_URL = "https://store.steampowered.com/api/appdetails?appids={app_id}&l=english&cc=us"


class Plugin:
    def __init__(self) -> None:
        self._cache: Dict[str, Dict[str, Any]] = {}
        # Recent Decky versions expose the settings directory as
        # ``decky_SETTINGS_DIR``.  Keep the older name as a fallback so a
        # manually installed plugin works on both Loader generations.
        settings_directory = getattr(decky, "decky_SETTINGS_DIR", None) or getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", None)
        if not settings_directory:
            raise RuntimeError("Decky settings directory is unavailable")
        self._cache_path = Path(settings_directory) / "controller-support-cache.json"
        self._lock = asyncio.Lock()

    async def _main(self) -> None:
        await self._load_cache()
        decky.logger.info("ControllerXbox backend loaded")

    async def _unload(self) -> None:
        await self._save_cache()

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
            await self._run_blocking(self._write_cache_atomically, payload)

    async def _run_blocking(self, function: Any, *args: Any) -> Any:
        """Run blocking file and network operations on Python 3.8 and newer."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, functools.partial(function, *args))

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

    def _fetch_support(self, app_id: str) -> Optional[bool]:
        request = urllib.request.Request(
            STORE_URL.format(app_id=app_id),
            headers={"User-Agent": "ControllerXbox Decky Plugin/1.0"},
        )
        try:
            ssl_context = ssl.create_default_context(cafile=certifi.where()) if certifi else ssl.create_default_context()
            try:
                response_stream = urllib.request.urlopen(request, timeout=10, context=ssl_context)
            except urllib.error.URLError as error:
                # Some Decky Python environments do not expose SteamOS's CA
                # bundle. Only retry certificate-verification failures; this
                # endpoint contains public compatibility metadata and no user
                # credentials or private data.
                if not isinstance(error.reason, ssl.SSLCertVerificationError):
                    raise
                response_stream = urllib.request.urlopen(request, timeout=10, context=ssl._create_unverified_context())
            with response_stream as response:
                result = json.load(response)
            app = result.get(app_id, {})
            if not app.get("success"):
                return None
            app_data = app.get("data", {})
            categories = app_data.get("categories", [])
            # Category 18 is Partial Controller Support and category 28 is
            # Full Controller Support. Both mean that the game can be played
            # with a controller, which is the compatibility this plugin marks.
            category_support = any(str(category.get("id")) in {"18", "28"} for category in categories if isinstance(category, dict))
            controller_support = str(app_data.get("controller_support", "")).lower()
            return category_support or controller_support in {"partial", "full"}
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
            decky.logger.debug("Steam lookup failed for %s: %s", app_id, error)
            return None

    async def get_controller_support(self, app_ids: Any) -> Dict[str, Any]:
        """Return official partial or full controller support for the supplied app IDs."""
        requested = self._valid_app_ids(app_ids)
        now = time.time()
        results: Dict[str, bool] = {}
        missing: List[str] = []
        unavailable: List[str] = []

        async with self._lock:
            for app_id in requested:
                entry = self._cache.get(app_id)
                if isinstance(entry, dict) and self._is_fresh(entry, now):
                    results[app_id] = bool(entry.get("controller_compatible"))
                else:
                    missing.append(app_id)

        fetched = await asyncio.gather(*(self._run_blocking(self._fetch_support, app_id) for app_id in missing))
        changed = False
        async with self._lock:
            for app_id, support in zip(missing, fetched):
                if support is not None:
                    self._cache[app_id] = {
                        "schema_version": CACHE_SCHEMA_VERSION,
                        "controller_compatible": support,
                        "checked_at": now,
                    }
                    results[app_id] = support
                    changed = True
                else:
                    unavailable.append(app_id)
        if changed:
            await self._save_cache()
        return {
            "success": True,
            "support": results,
            "unavailable": unavailable,
            "cached_for_days": 30,
        }

    def _delete_cache_file(self) -> None:
        try:
            self._cache_path.unlink()
        except FileNotFoundError:
            pass

    async def clear_cache(self) -> Dict[str, Any]:
        async with self._lock:
            removed = len(self._cache)
            self._cache = {}
            try:
                await self._run_blocking(self._delete_cache_file)
            except OSError as error:
                decky.logger.warning("Could not remove controller cache: %s", error)
        return {"success": True, "removed": removed}

    async def get_cache_stats(self) -> Dict[str, Any]:
        now = time.time()
        async with self._lock:
            fresh = sum(1 for entry in self._cache.values() if isinstance(entry, dict) and self._is_fresh(entry, now))
            return {"success": True, "entries": len(self._cache), "fresh_entries": fresh, "ttl_days": 30}

    async def get_backend_diagnostics(self) -> Dict[str, Any]:
        """Network-free health check for the manual frontend start button."""
        stats = await self.get_cache_stats()
        return {
            **stats,
            "backend": "ready",
            "settings_directory": str(self._cache_path.parent),
        }
