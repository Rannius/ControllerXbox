"""Decky backend for ControllerXbox.

Only Steam app IDs supplied by the visible-library frontend are checked. The
Steam Store, NVIDIA GeForce NOW, and Boosteroid catalog endpoints are public
and require no API key.
"""

import asyncio
import concurrent.futures
import functools
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
CACHE_SCHEMA_VERSION = 5
STORE_URL = "https://store.steampowered.com/api/appdetails?appids={app_id}&l=english&cc=us"
GFN_CACHE_TTL_SECONDS = 24 * 60 * 60
GFN_URL = "https://api-prod.nvidia.com/services/gfngames/v1/gameList"
BOOSTEROID_CACHE_TTL_SECONDS = 24 * 60 * 60
BOOSTEROID_CACHE_SCHEMA_VERSION = 3
SETTINGS_SCHEMA_VERSION = 1
NOTIFICATION_SCHEMA_VERSION = 1
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


class Plugin:
    def __init__(self) -> None:
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._gfn_app_ids: Set[str] = set()
        self._gfn_checked_at = 0.0
        self._gfn_last_error = ""
        self._boosteroid_app_ids: Set[str] = set()
        self._boosteroid_maintenance_app_ids: Set[str] = set()
        self._boosteroid_checked_at = 0.0
        self._boosteroid_last_error = ""
        self._settings: Dict[str, bool] = {
            "show_gfn_badges": True,
            "show_boosteroid_badges": True,
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
        self._cache_path = Path(settings_directory) / "controller-support-cache.json"
        self._gfn_cache_path = Path(settings_directory) / "geforce-now-catalog-cache.json"
        self._boosteroid_cache_path = Path(settings_directory) / "boosteroid-catalog-cache.json"
        self._settings_path = Path(settings_directory) / "controller-xbox-settings.json"
        self._notification_state_path = Path(settings_directory) / "controller-xbox-notifications.json"
        self._lock = asyncio.Lock()
        self._gfn_lock = asyncio.Lock()
        self._boosteroid_lock = asyncio.Lock()
        self._update_lock = asyncio.Lock()
        self._notification_lock = asyncio.Lock()

    async def _main(self) -> None:
        await self._load_cache()
        await self._load_gfn_cache()
        await self._load_boosteroid_cache()
        await self._load_settings()
        decky.logger.info("ControllerXbox backend loaded")

    async def _unload(self) -> None:
        await self._save_cache()
        await self._save_gfn_cache()
        await self._save_boosteroid_cache()
        await self._save_settings()

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

    async def _load_gfn_cache(self) -> None:
        try:
            contents = await self._run_blocking(lambda: self._gfn_cache_path.read_text(encoding="utf-8"))
            parsed = json.loads(contents)
            checked_at = parsed.get("checked_at") if isinstance(parsed, dict) else None
            app_ids = parsed.get("steam_app_ids") if isinstance(parsed, dict) else None
            if isinstance(checked_at, (int, float)) and isinstance(app_ids, list):
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
                {"checked_at": self._gfn_checked_at, "steam_app_ids": sorted(self._gfn_app_ids)},
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
                    "notify_gfn_additions",
                    "notify_boosteroid_additions",
                    "notify_boosteroid_maintenance",
                    "notify_plugin_updates",
                ):
                    if isinstance(parsed.get(key), bool):
                        self._settings[key] = parsed[key]
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

    async def set_badge_visibility(self, show_gfn_badges: Any, show_boosteroid_badges: Any) -> Dict[str, Any]:
        if not isinstance(show_gfn_badges, bool) or not isinstance(show_boosteroid_badges, bool):
            return {"success": False, "error": "A jelvénybeállítás értéke érvénytelen."}
        self._settings.update({
            "show_gfn_badges": show_gfn_badges,
            "show_boosteroid_badges": show_boosteroid_badges,
        })
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

    def _fetch_support(self, app_id: str) -> Optional[str]:
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
            categories = app_data.get("categories", [])
            category_ids = {str(category.get("id")) for category in categories if isinstance(category, dict)}
            controller_support = str(app_data.get("controller_support", "")).lower()
            if "28" in category_ids or controller_support == "full":
                return "full"
            if "18" in category_ids or controller_support == "partial":
                return "partial"
            return "none"
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
            decky.logger.debug("Steam lookup failed for %s: %s", app_id, error)
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
        if str(manifest.get("name", "")) != "ControllerXbox":
            raise ValueError("A ZIP nem a ControllerXbox plugin telepítője.")

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
            if str(current_manifest.get("name", "")) != "ControllerXbox":
                raise ValueError("A Decky pluginmappa nem a ControllerXboxhoz tartozik.")

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
            apps = result.get("data", {}).get("apps")
            if not isinstance(apps, dict):
                raise ValueError("Invalid GeForce NOW catalog response")
            for game in apps.get("items", []):
                if not isinstance(game, dict):
                    continue
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
            if not cursor:
                raise ValueError("GeForce NOW catalog cursor is missing")
        if has_next_page:
            raise ValueError("GeForce NOW catalog exceeded the page limit")
        if not steam_app_ids:
            raise ValueError("GeForce NOW catalog contained no Steam games")
        return steam_app_ids

    async def _ensure_gfn_catalog(self) -> bool:
        async with self._gfn_lock:
            now = time.time()
            if self._gfn_app_ids and now - self._gfn_checked_at < GFN_CACHE_TTL_SECONDS:
                return True
            try:
                fetched = await self._run_blocking(self._fetch_gfn_catalog)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
                self._gfn_last_error = str(error)
                decky.logger.warning("GeForce NOW catalog refresh failed: %s", error)
                return bool(self._gfn_app_ids)
            self._gfn_app_ids = fetched
            self._gfn_checked_at = now
            self._gfn_last_error = ""
            payload = json.dumps(
                {"checked_at": self._gfn_checked_at, "steam_app_ids": sorted(self._gfn_app_ids)},
                separators=(",", ":"),
            )
            await self._run_blocking(self._write_file_atomically, self._gfn_cache_path, "gfn-cache-", payload)
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
                "availability": {app_id: app_id in self._gfn_app_ids for app_id in requested},
                "unavailable": [],
                "catalog_entries": len(self._gfn_app_ids),
                "cached_for_hours": 24,
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
            for game in items:
                if not isinstance(game, dict):
                    continue
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

    async def _ensure_boosteroid_catalog(self) -> bool:
        async with self._boosteroid_lock:
            now = time.time()
            if (
                self._boosteroid_app_ids
                and now - self._boosteroid_checked_at < BOOSTEROID_CACHE_TTL_SECONDS
            ):
                return True
            try:
                fetched_app_ids, fetched_maintenance_ids = await self._run_blocking(
                    self._fetch_boosteroid_catalog
                )
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError) as error:
                self._boosteroid_last_error = str(error)
                decky.logger.warning("Boosteroid catalog refresh failed: %s", error)
                return bool(self._boosteroid_app_ids)
            self._boosteroid_app_ids = fetched_app_ids
            self._boosteroid_maintenance_app_ids = fetched_maintenance_ids
            self._boosteroid_checked_at = now
            self._boosteroid_last_error = ""
            payload = json.dumps(
                {
                    "schema_version": BOOSTEROID_CACHE_SCHEMA_VERSION,
                    "checked_at": self._boosteroid_checked_at,
                    "steam_app_ids": sorted(self._boosteroid_app_ids),
                    "maintenance_app_ids": sorted(self._boosteroid_maintenance_app_ids),
                },
                separators=(",", ":"),
            )
            await self._run_blocking(
                self._write_file_atomically,
                self._boosteroid_cache_path,
                "boosteroid-cache-",
                payload,
            )
            return True

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
                "availability": {app_id: app_id in self._boosteroid_app_ids for app_id in requested},
                "maintenance": {
                    app_id: app_id in self._boosteroid_maintenance_app_ids for app_id in requested
                },
                "unavailable": [],
                "catalog_entries": len(self._boosteroid_app_ids),
                "cached_for_hours": 24,
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

    async def get_notification_events(self, app_ids: Any) -> Dict[str, Any]:
        """Return each catalog/update change once for the user's Steam library."""
        library_app_ids = self._valid_library_app_ids(app_ids)
        gfn_available, boosteroid_available, update = await asyncio.gather(
            self._ensure_gfn_catalog(),
            self._ensure_boosteroid_catalog(),
            self._run_blocking(self._check_for_update_blocking),
        )

        async with self._gfn_lock:
            current_gfn = self._gfn_app_ids & library_app_ids
        async with self._boosteroid_lock:
            current_boosteroid = self._boosteroid_app_ids & library_app_ids
            current_maintenance = self._boosteroid_maintenance_app_ids & library_app_ids

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

            gfn_added = len(current_gfn - previous_gfn) if gfn_available and gfn_initialized else 0
            boosteroid_added = (
                len(current_boosteroid - previous_boosteroid)
                if boosteroid_available and boosteroid_initialized
                else 0
            )
            boosteroid_maintenance = (
                len(current_maintenance - previous_maintenance)
                if boosteroid_available and boosteroid_initialized
                else 0
            )

            last_notified_update = str(state.get("last_notified_update", "")) if valid_state else ""
            update_version = ""
            if (
                isinstance(update, dict)
                and update.get("success")
                and update.get("has_update")
                and self._settings.get("notify_plugin_updates", True)
                and re.fullmatch(r"\d+\.\d+\.\d+", str(update.get("latest_version", "")))
                and str(update.get("latest_version")) != last_notified_update
            ):
                update_version = str(update["latest_version"])
                last_notified_update = update_version

            next_state = {
                "schema_version": NOTIFICATION_SCHEMA_VERSION,
                "gfn_initialized": gfn_initialized or bool(gfn_available and library_app_ids),
                "boosteroid_initialized": boosteroid_initialized or bool(boosteroid_available and library_app_ids),
                "gfn_available": (
                    sorted(current_gfn | (previous_gfn - library_app_ids))
                    if gfn_available and library_app_ids
                    else sorted(previous_gfn)
                ),
                "boosteroid_available": (
                    sorted(current_boosteroid | (previous_boosteroid - library_app_ids))
                    if boosteroid_available and library_app_ids
                    else sorted(previous_boosteroid)
                ),
                "boosteroid_maintenance": (
                    sorted(current_maintenance | (previous_maintenance - library_app_ids))
                    if boosteroid_available and library_app_ids
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

        return {
            "success": True,
            "tracked_games": len(library_app_ids),
            "gfn_added": gfn_added if self._settings.get("notify_gfn_additions", True) else 0,
            "boosteroid_added": (
                boosteroid_added if self._settings.get("notify_boosteroid_additions", True) else 0
            ),
            "boosteroid_maintenance": (
                boosteroid_maintenance
                if self._settings.get("notify_boosteroid_maintenance", True)
                else 0
            ),
            "update_version": update_version,
        }

    async def get_controller_support(self, app_ids: Any) -> Dict[str, Any]:
        """Return official partial or full controller support for the supplied app IDs."""
        requested = self._valid_app_ids(app_ids)
        now = time.time()
        results: Dict[str, bool] = {}
        levels: Dict[str, str] = {}
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
                    else:
                        missing.append(app_id)
                else:
                    missing.append(app_id)

        fetched = await asyncio.gather(*(self._run_blocking(self._fetch_support, app_id) for app_id in missing))
        changed = False
        async with self._lock:
            for app_id, level in zip(missing, fetched):
                if level is not None:
                    self._cache[app_id] = {
                        "schema_version": CACHE_SCHEMA_VERSION,
                        "controller_support_level": level,
                        "checked_at": now,
                    }
                    levels[app_id] = level
                    results[app_id] = level != "none"
                    changed = True
                else:
                    unavailable.append(app_id)
        if changed:
            await self._save_cache()
        return {
            "success": True,
            "support": results,
            "levels": levels,
            "unavailable": unavailable,
            "cached_for_days": 30,
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
        async with self._lock:
            removed = len(self._cache)
            self._cache = {}
            try:
                await self._run_blocking(self._delete_cache_file)
            except OSError as error:
                decky.logger.warning("Could not remove controller cache: %s", error)
        async with self._gfn_lock:
            gfn_removed = len(self._gfn_app_ids)
            self._gfn_app_ids = set()
            self._gfn_checked_at = 0.0
            self._gfn_last_error = ""
            try:
                await self._run_blocking(self._delete_gfn_cache_file)
            except OSError as error:
                decky.logger.warning("Could not remove GeForce NOW cache: %s", error)
        async with self._boosteroid_lock:
            boosteroid_removed = len(self._boosteroid_app_ids)
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
