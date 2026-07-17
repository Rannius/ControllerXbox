# Xbox Controller Check

A Decky Loader plugin for Steam Deck. It adds a blue **✓ Xbox** badge to visible Steam Library game tiles and the Library Home screen when Steam Store officially lists the game as **Full Controller Support**.

## Privacy and cache

Only app IDs present on the current visible screen are sent to Steam's public `appdetails` endpoint. No account, library, playtime, or other personal data is collected or transmitted. Results are cached locally for 30 days. The Decky quick-access menu offers **Clear and refresh cache** at any time.

The badge means Steam indicates the game can be downloaded, launched, and played through exclusively with a controller, whether through Steam Input or native gamepad support.

## Development

Install Node.js and pnpm, then run `pnpm install` and `pnpm build`. Copy the resulting plugin directory (including `dist/`, `main.py`, `package.json`, and `plugin.json`) into Decky's plugin location.
