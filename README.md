# Xbox Controller Check

A Decky Loader plugin for Steam Deck. It adds a blue **✓ Xbox** badge to visible Steam Library game tiles and the Library Home screen when Steam Store officially lists the game as **Full Controller Support**.

## Privacy and cache

Only app IDs present on the current visible screen are sent to Steam's public `appdetails` endpoint. No account, library, playtime, or other personal data is collected or transmitted. Results are cached locally for 30 days. The Decky quick-access menu offers **Clear and refresh cache** at any time.

The badge means Steam indicates the game can be downloaded, launched, and played through exclusively with a controller, whether through Steam Input or native gamepad support.

## Development

Install Node.js and pnpm, then run `pnpm install` and `pnpm build`. Copy the resulting plugin directory (including `dist/`, `main.py`, `package.json`, and `plugin.json`) into Decky's plugin location.

## Releases and updates

Pushing a version tag such as `v1.0.2` starts the release workflow. It builds a fresh Decky-installable ZIP, creates a GitHub Release, and attaches that ZIP as the immutable backup for that version.

Developer-mode ZIP installations do not receive automatic in-Decky updates. For the Decky **Update** button and managed automatic updates, the plugin must be accepted into the official Decky Plugin Store (the Decky plugin database). After it has been approved there, each published store version is offered by Decky as an update.

## Decky ZIP packaging contract

Every installable ZIP must contain exactly one `ControllerXbox/` root directory. Its entries must be written in this fixed order: `.gitignore`, `LICENSE`, `README.md`, `main.py`, `package.json`, `plugin.json`, `pnpm-lock.yaml`, `dist/index.js`, and `dist/index.js.map`. The ZIP layout, entry order, compression method, and metadata must be checked against the working `ControllerXbox-v1.0.0.zip` before publishing. A recursive or filesystem-order ZIP command is prohibited because it caused Decky to install the archive without listing the plugin.

The Python backend targets Decky's Python 3.8 runtime. Do not use Python 3.9+ typing syntax or `asyncio.to_thread`; use `typing.Dict`/`Optional` and an executor-backed helper instead.

`plugin.json` sets `"api_version": 1` so the modern `@decky/api` frontend can call the Python backend.
