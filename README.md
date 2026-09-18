# Deck Play Badges

A Decky Loader plugin for Steam Deck that adds controller and cloud-gaming insights directly to the Steam interface. It marks visible Steam Library and Steam Store game tiles with their Steam controller-support level, GeForce NOW availability, and Boosteroid availability. On an opened Library game page, the same three badges appear at the top-right beside the ProtonDB badge. On an opened Steam Store game page, they appear at the bottom-right, aligned with the ProtonDB Store badge.

## Privacy and cache

Only app IDs present on the current visible screen or explicitly added to the watchlist are sent to Steam's public `appdetails` endpoint. The public NVIDIA GeForce NOW and Boosteroid catalogs are downloaded without sending the user's library, watchlist, or app IDs to either service; Steam AppID matching happens locally. When a Boosteroid record omits both official Steam links, its public game title can be resolved through Steam's public store search without exposing the user's library. No account, library, playtime, or other personal data is collected. Controller results are cached for 30 days and both cloud-gaming catalogs are checked every 24 hours while remaining available as stale fallbacks if a refresh fails. The Decky quick-access menu offers **Clear and refresh cache** at any time.

The controller badge reflects Steam's partial or full controller-support category. The adjacent green or gray GFN badge reflects whether the Steam AppID exists in NVIDIA's public GeForce NOW catalog. The Boosteroid logo is blue when the Steam game is available, yellow during maintenance, and gray when it is absent from the public catalog.

GFN and Boosteroid badges can be enabled or disabled independently in the quick-access panel. The four notification categories can also be toggled separately. A persistent, change-based background check notifies the user once when a library or manually watched Steam game becomes available on GeForce NOW or Boosteroid, enters Boosteroid maintenance, or when a new stable Deck Play Badges release is available. Games can be found by title or Steam AppID and added to a persistent watchlist, with GFN and Boosteroid monitoring selected independently for every entry. The opened Library and Steam Store game pages also provide a one-click star button for adding or removing the current game. Game notifications list up to three affected titles and include the remaining count when more games changed. The latest 100 cloud-platform notification events are stored locally, with an unread counter, and can be reviewed or cleared from their own quick-access page. The check repeats every six hours; its first run creates a baseline and does not announce the entire existing catalog.

## Development

Install Node.js and pnpm, then run `pnpm install` and `pnpm build`. Copy the resulting plugin directory (including `dist/`, `main.py`, `package.json`, and `plugin.json`) into Decky's plugin location.

## Releases and updates

Pushing a version tag such as `v1.0.2` starts the release workflow. It builds a fresh Decky-installable ZIP, creates a GitHub Release, and attaches that ZIP as the immutable backup for that version.

Version 1.0.36 adds a built-in updater for developer-mode installations. Install 1.0.36 manually once; future stable versions can be checked and installed from the plugin's quick-access panel. The updater only accepts the exact ZIP asset belonging to an immutable release in this repository, validates its fixed file list and metadata, and never asks for a sudo password. After installation it reloads the plugin, restarts Decky's plugin loader, or offers a Steam restart as a compatibility fallback.

Version 1.0.43 introduces the **Deck Play Badges** display name. Its update notification is checked separately from the slower cloud catalogs and is only marked as delivered after the frontend has displayed it, preventing catalog timeouts from silently consuming an update alert.

Version 1.0.44 is the compatibility bridge for changing Decky's manifest-level plugin identifier. Its updater accepts both the legacy `ControllerXbox` name and the new `Deck Play Badges` name, and its reload path can address either identity. Install this bridge before a release that changes the manifest name.

Version 1.0.45 changes the Decky manifest name itself to **Deck Play Badges**, so the new name appears in Decky's plugin sidebar after a full Steam restart. The package name, ZIP root, release asset name, repository, and settings location retain their legacy identifiers to preserve update and data compatibility.

Official Decky Plugin Store publication can still provide Decky's own managed update button later, but it is no longer required for updating a developer-mode installation.

## Decky ZIP packaging contract

Every installable ZIP must contain exactly one `ControllerXbox/` root directory. Its entries must be written in this fixed order: `.gitignore`, `LICENSE`, `README.md`, `main.py`, `package.json`, `plugin.json`, `pnpm-lock.yaml`, `dist/index.js`, and `dist/index.js.map`. The ZIP layout, entry order, compression method, and metadata must be checked against the working `ControllerXbox-v1.0.0.zip` before publishing. A recursive or filesystem-order ZIP command is prohibited because it caused Decky to install the archive without listing the plugin.

`ControllerXbox` remains the internal package and ZIP identifier for compatibility with existing developer-mode installations and their built-in updater. The user-facing plugin name is **Deck Play Badges**.

The Python backend targets Decky's Python 3.8 runtime. Do not use Python 3.9+ typing syntax or `asyncio.to_thread`; use `typing.Dict`/`Optional` and an executor-backed helper instead.

`plugin.json` sets `"api_version": 1` so the modern `@decky/api` frontend can call the Python backend. Its `root` flag lets the updater replace only the validated files inside its own plugin directory and restart Decky's plugin loader without asking for the user's sudo password.
