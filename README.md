# Xbox Controller Check

A Decky Loader plugin for Steam Deck. It marks visible Steam Library and Steam Store game tiles with their Steam controller-support level, GeForce NOW availability, and Boosteroid availability. On an opened Library game page, the same three badges appear at the top-right beside the ProtonDB badge. On an opened Steam Store game page, they appear at the bottom-right, aligned with the ProtonDB Store badge.

## Privacy and cache

Only app IDs present on the current visible screen are sent to Steam's public `appdetails` endpoint. The public NVIDIA GeForce NOW and Boosteroid catalogs are downloaded without sending the user's library or app IDs to either service; Steam AppID matching happens locally. When a Boosteroid record omits both official Steam links, its public game title can be resolved through Steam's public store search without exposing the user's library. No account, library, playtime, or other personal data is collected. Controller results are cached for 30 days and both cloud-gaming catalogs are checked every 24 hours while remaining available as stale fallbacks if a refresh fails. The Decky quick-access menu offers **Clear and refresh cache** at any time.

The controller badge reflects Steam's partial or full controller-support category. The adjacent green or gray GFN badge reflects whether the Steam AppID exists in NVIDIA's public GeForce NOW catalog. The Boosteroid logo is blue when the Steam game is available, yellow during maintenance, and gray when it is absent from the public catalog.

## Development

Install Node.js and pnpm, then run `pnpm install` and `pnpm build`. Copy the resulting plugin directory (including `dist/`, `main.py`, `package.json`, and `plugin.json`) into Decky's plugin location.

## Releases and updates

Pushing a version tag such as `v1.0.2` starts the release workflow. It builds a fresh Decky-installable ZIP, creates a GitHub Release, and attaches that ZIP as the immutable backup for that version.

Version 1.0.36 adds a built-in updater for developer-mode installations. Install 1.0.36 manually once; future stable versions can be checked and installed from the plugin's quick-access panel. The updater only accepts the exact ZIP asset belonging to an immutable release in this repository, validates its fixed file list and metadata, and never asks for a sudo password. After installation it reloads the plugin, restarts Decky's plugin loader, or offers a Steam restart as a compatibility fallback.

Official Decky Plugin Store publication can still provide Decky's own managed update button later, but it is no longer required for updating a developer-mode installation.

## Decky ZIP packaging contract

Every installable ZIP must contain exactly one `ControllerXbox/` root directory. Its entries must be written in this fixed order: `.gitignore`, `LICENSE`, `README.md`, `main.py`, `package.json`, `plugin.json`, `pnpm-lock.yaml`, `dist/index.js`, and `dist/index.js.map`. The ZIP layout, entry order, compression method, and metadata must be checked against the working `ControllerXbox-v1.0.0.zip` before publishing. A recursive or filesystem-order ZIP command is prohibited because it caused Decky to install the archive without listing the plugin.

The Python backend targets Decky's Python 3.8 runtime. Do not use Python 3.9+ typing syntax or `asyncio.to_thread`; use `typing.Dict`/`Optional` and an executor-backed helper instead.

`plugin.json` sets `"api_version": 1` so the modern `@decky/api` frontend can call the Python backend. Its `root` flag lets the updater replace only the validated files inside its own plugin directory and restart Decky's plugin loader without asking for the user's sudo password.
