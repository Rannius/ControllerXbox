# Deck Play Badges

A Decky Loader plugin for Steam Deck that adds controller, language, and cloud-gaming insights directly to the Steam interface. It marks visible Steam Library and Steam Store game tiles with their Steam controller-support level, GeForce NOW availability, and Boosteroid availability. A Hungarian flag appears when Steam lists official Hungarian support or the public Magyar Felirat curator recommends the game. Its tooltip identifies the source. On an opened Library game page, these badges appear at the top-right beside the ProtonDB badge. On an opened Steam Store game page, they appear at the bottom-right, aligned with the ProtonDB Store badge.

## Privacy and cache

App IDs visible on screen or explicitly added to the watchlist are sent to Steam's public `appdetails` endpoint. While **Magyar zászló** is enabled, the plugin also gradually checks the Steam games in the user's library to build the Hungarian-language collection; this uses the same public endpoint, existing cached results, and a continuous queue of up to four concurrent lookups, without fixed pauses between batches. Each completed lookup immediately frees a slot for the next game. Transport errors and Steam throttling pause new requests, honoring numeric Retry-After responses (60 seconds to one hour); unavailable individual game records are skipped and retried later. The public NVIDIA GeForce NOW and Boosteroid catalogs are downloaded without sending the user's library, watchlist, or app IDs to either service; Steam AppID matching happens locally. When a Boosteroid record omits both official Steam links, its public game title can be resolved through Steam's public store search without exposing the user's library. The plugin has no analytics endpoint and sends no account identifiers or playtime to catalog services. Controller results are cached for 30 days and the GeForce NOW cache normally lasts 24 hours and the Boosteroid cache lasts 15 minutes. Wake events and the watchlist’s **GFN és Boosteroid ellenőrzése most** button force a fresh download of both catalogs and update the watchlist, badges, and notifications. Background notification checks run every 15 minutes while the plugin is active. Failed refreshes preserve previous positive results without presenting old negative results as current facts. The Decky quick-access menu offers **Clear and refresh cache** at any time.

The controller badge reflects Steam's partial or full controller-support category. The adjacent green or gray GFN badge reflects whether the Steam AppID exists in NVIDIA's public GeForce NOW catalog. The Boosteroid logo is blue when the Steam game is available, yellow during maintenance, and gray when it is absent from the public catalog.

The Hungarian flag combines the official `supported_languages` list (from the same Steam request as controller support, cached for 30 days) with recommendations from the public [Magyar Felirat curator](https://store.steampowered.com/curator/34235089-Magyar-Felirat/). Following the curator or signing in is not required. The curator catalog is downloaded in full with pagination, matched locally by Steam AppID and cached for 24 hours. It receives no library or account data. Failed or incomplete refreshes retain the previous catalog and back off for 15 minutes. The tooltip distinguishes official Steam language data from a curator recommendation. Neither source implies Hungarian dubbing or verifies installed translation files. The flag is enabled by default and can be toggled independently using **Magyar zászló** in the quick-access panel. Version 1.0.51 refreshes older controller cache entries as games become visible, so their language data can be fetched.

Tile badges wrap into centered rows when they do not fit, in both the Library and Store. Settings offers separate **Könyvtár ikonmérete** (Library) and **Áruház ikonmérete** (Store) sliders from 50–200%, in 5% steps. **Ikonméretek alkalmazása** saves and applies both values to tiles and detail-page badges immediately, including the native Store home tiles; 100% preserves the original sizes. With **Magyar zászló** enabled, games confirmed by either language source are added to the native **🇭🇺 Magyar nyelvű játékok** collection under **Library → Collections**, starting with the first confirmed match. The scan covers the entire Steam game library, including uninstalled games and games not visible on screen; curator matches do not require individual app-detail lookups. The quick-access home panel shows live scan progress: visited/total and percentage, available language-result count, current game titles, confirmed matches, saved collection members, unknown language results, curator download counts, and a countdown until the next check. Reading progress never waits for catalog network requests. The collection worker waits for Steam storage initialization and avoids the shared `userCollections` computed getter. Unvisited games take priority over failed retries, including after RPC timeouts; missing data is shown separately and never presented as a confirmed language result. The initial scan of a large library may take some time; cached results survive plugin restarts. Disabling the flag pauses collection updates and leaves the existing collection in place. Missing language data or a failed request does not remove an already confirmed game; explicit negative language data does. Non-Steam shortcuts and non-game app types are excluded. The collection integration uses Steam's client collection API; if it is unavailable, the panel reports this and retries later.

GFN and Boosteroid badges can be enabled or disabled independently in the quick-access panel. The four notification categories can also be toggled separately. A persistent, change-based background check notifies the user once when a library or manually watched Steam game becomes available on GeForce NOW or Boosteroid, enters Boosteroid maintenance, or when a new stable Deck Play Badges release is available. Games can be found by title or Steam AppID and added to a persistent watchlist, with GFN and Boosteroid monitoring selected independently for every entry. The opened Library and Steam Store game pages also provide a one-click star button for adding or removing the current game. Game notifications list up to three affected titles and include the remaining count when more games changed. The latest 100 cloud-platform notification events are stored locally, with an unread counter, and can be reviewed or cleared from their own quick-access page. The cloud check repeats every 15 minutes; its first run creates a baseline and does not announce the entire existing catalog.

## Development

Version 1.0.62 moves the Store detail badges and the compact AllKeyShop price into a shared fixed bottom-left row. Opening the price badge expands offer details above the row; it no longer requires Steam's purchase container. A recognized fixed bottom ProtonDB badge is temporarily aligned to the left, with its original inline positioning restored on leaving the game page or unloading. Unknown ProtonDB renderers may not be detected. Icon refreshes preserve the price element, and narrow viewports wrap the row as needed.

The **Megbízható boltok (AllKeyShop)** menu replaces manual merchant-name entry with a searchable list of switches. It downloads the public merchant directory at most daily unless manually refreshed, persists known names locally, and adds merchants discovered in game offers. Saving the selection creates an explicit allowlist: an empty selection means no offers, and newly discovered merchants remain unselected. Existing manual selections are preserved; legacy unrestricted mode remains until the first selection save. Being listed is not a plugin endorsement of a merchant. Product/platform/region/edition filters still apply regardless of merchant selection.

Version 1.0.61 adds an AllKeyShop panel to opened Steam Store game pages. It reads public embedded offer JSON without a partner account or API key. Settings allow disabling the panel, excluding Steam Gifts, and entering an allowlist of exact merchant names separated by commas. It accepts only explicit non-account Steam offers with known Global/EU key or Gift classifications, in-stock Standard editions, and card-inclusive EUR prices. Coupon codes and observation times are shown. Other editions, unclear matches, accounts, other platforms and unknown product classifications are excluded. Matching uses a unique exact normalized Steam-title result among PC search results, not an AppID mapping. Some games will therefore have no result. Global/EU is the source's classification, not a per-offer guarantee of activation in Hungary. The linked AllKeyShop page has its own independent filters.

Only the opened game's name is sent to AllKeyShop; no library, account identifier or watchlist is sent. Steam receives that game's AppID to resolve its title. Results are cached in memory for 15 minutes (errors for one minute), with one frontend lookup at a time and a bounded backend cache. Source data is parsed as JSON, never executed. Source-supplied coupons may have conditions; final checkout prices may differ. This relies on a public page format that may change, not a supported AllKeyShop API, and uses no plugin affiliate identifier.

Version 1.0.60 adds opt-in controller-support monitoring per watchlist game, also usable without either cloud service. It notifies on none-to-partial/full and partial-to-full transitions and records the resulting level in notification history. The first successful observation establishes a baseline without a notification. Watched controller data is refreshed after every wake and manual catalog refresh, otherwise daily. Large watchlists continue through batches of eight using the shared four-request limit; failures retain the previous notification baseline and respect Steam backoff. Existing watchlist entries keep controller monitoring disabled until enabled explicitly.

Version 1.0.59 validates catalog pagination and record counts before accepting a cloud snapshot. Empty snapshots or losses exceeding both ten games and 20% of the previous catalog retain the last good data. Smaller removals need two successful downloads at least 15 minutes apart; reappearance clears the pending removal. Pending removals survive restarts, and Boosteroid maintenance remains separate. The home panel and watchlist show each provider's last successful refresh, freshness, and pending-removal count.

Library and visible-tile Steam lookups share a four-request limit and deduplicate simultaneous requests for the same AppID. Retry state and increasing transport-error backoff are saved locally alongside cached results. Completed library scans wait 15 minutes before checking ownership and expired data again; failed requests respect their retry time, and active curator downloads use shorter progress checks. The progress percentage counts games visited, while confirmed language results are counted separately. A completed pass with unknown results is labelled as waiting, not actively searching.

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

Wake refresh waits eight seconds for network reconnection and retries failures after 30 and 120 seconds. It listens to Steam resume notifications, with a timer-gap fallback, and combines duplicate wake signals. It refreshes data without reloading Steam or changing the running game.

## 1.0.63 – Elhelyezés és csempeárak

A Beállításokban az áruházi játékoldal minden jelvénye külön balra/jobbra állítható. Alapból csak az AllKeyShop ár van balra, a többi ikon jobbra. A felismert alsó ProtonDB-jelvény is állítható.

Az „Árak az áruházi csempék alatt” kapcsoló alapból kikapcsolt. Engedélyezve a látható, felismert webes áruházi csempék alatt ár és boltnév jelenik meg, a mentett boltszűréssel. A lekérések egymás után futnak, 15 perces közös gyorsítótárral; a játékoldal elsőbbséget kap. Az AllKeyShop árakat is engedélyezni kell. A natív Steam-csempékhez ez a funkció nem ad árat.

## 1.0.64 – Ár a vásárlási blokk alatt

Az AllKeyShop ársor a webes játékoldalon a Steam első felismert vásárlási blokkja alá került. Kiírja a Standard ajánlat árát és boltját, és helyben lenyitható. Az ár már nem lebeg a sarokban, bal/jobb kapcsolója megszűnt. A többi ikon oldala és az opcionális csempeárak változatlanul állíthatók.

## 1.0.65 – Ársor és csempefelismerés javítása

A játékoldal ársora az első látható vásárlási csempéhez tartozó burkolón belül marad. A csempeárak közös felismerése az alacsony listákat, nagy kiemelt elemeket, háttérképes és AppID-val jelölt csempéket is kezeli; a korábbi 40 elemes megjelenítési korlát megszűnt.

## 1.0.66 – Kontrolleres áruházi ármező

A GamepadMode játékoldalon az AllKeyShop sor a bal felső játékbemutató kártyán lévő Steam-ár alatt jelenik meg. A hagyományos webes vásárlási blokkra épülő korábbi felismerés önmagában nem kezelte ezt a nézetet. A kontrolleres áruház valódi Dressmaker-oldalával végzett böngészős elhelyezési próba sikeres.

## 1.0.67 – AllKeyShop kapcsolati hibák

Közös szolgáltatási hiba esetén nem várakoztatja végig egyenként az összes csempét: azonnal közös hibát mutat, majd 1–5 perces szünet után próbálkozik újra, ha az áruház nyitva marad. A hibatípus az ársorban és a lenyitott részletekben látható. A külső szolgáltatás elérhetetlenségét ez a módosítás nem oldja meg.

## 1.0.68 – Újrapróbálkozási visszaszámlálás

Az AllKeyShop ársorok kiírják az újrapróbálkozásig hátralévő másodperceket. Kapcsolati hibánál a közös szünet 15, 30, majd legfeljebb 60 másodperc; a játékspecifikus hibánál 30 másodperc. A számláló nem indít hálózati forgalmat.

## 1.0.69 – Kímélő árlekérési sor

A megnyitott játék elsőbbséget kap, utána a látható, még le nem kért csempék, végül az újra megjelent, lejárt adatú játékok következnek. Az AllKeyShop-kérések között legalább 5 másodperc szünet van. A sikeres adatok 30 percig használhatók új kérés nélkül (500 játék, a futó plugin memóriájában). A lejárat önmagában nem frissít: a játék későbbi újbóli megjelenése vagy adatlapjának újbóli megnyitása indítja a frissítést. A kibővített nézet mutatja az utolsó ellenőrzés idejét.

A Steam szerint meg nem jelent vagy ismeretlen megjelenési állapotú játékhoz nem indul AllKeyShop-kérés, a személyre szabott naptárban sem. Ehhez a Steam megjelenési adatát továbbra is lekéri.

## 1.0.70 – Ingyenes játékok kihagyása

A Steam által ingyenesként jelölt játékokhoz nem indul AllKeyShop-keresés vagy ajánlatlekérés, és nem jelenik meg AKS-ársor. A kihagyást 30 percig gyorsítótárazza. Az ingyenesség megállapításához a Steam adatait továbbra is ellenőrzi; a hiányzó ár önmagában nem jelent ingyenes játékot.

## 1.0.71 – Főoldali árlekérések kikapcsolása

Az áruház főoldalának csempéin nem jelennek meg AllKeyShop-árak, és ezekhez nem indul árlekérés akkor sem, ha a csempeárak be vannak kapcsolva. A megnyitott játék adatlapján megmarad az árösszehasonlítás. Más áruházi oldalakon továbbra is a külön csempeár-kapcsoló érvényes.

## 1.0.72 – Csempeárak kapcsolójának eltávolítása

Az áruházi csempeárak kapcsolója megszűnt. A csempék sem a főoldalon, sem más listákban nem indítanak AllKeyShop-árlekérést, a korábban elmentett bekapcsolt beállítástól függetlenül. Az árösszehasonlítás a megnyitott játék adatlapján továbbra is elérhető.

## 1.0.73 – Hosszabb árlekérési várakozás

Az AllKeyShop hálózati kéréseinek időkorlátja 12-ről 30 másodpercre nőtt. A felület 60 helyett 120 másodpercet vár a teljes műveletre. A kérések közötti 5 másodperces szünet, a 30 perces gyorsítótár és a kizárólag a játék adatlapján történő árlekérés változatlan.

## 1.0.80 – Kevesebb árlekérés, pontos várakozás

A már azonosított AllKeyShop-adatlap címét a plugin legfeljebb 24 óráig megjegyzi a memóriában. Az ár 30 perc utáni, láthatósághoz kötött frissítése így új keresés nélkül történhet. A Steam ingyenességi és megjelenési állapotát továbbra is ellenőrzi. Megváltozott játéknév, lejárt cím vagy 404/410 válasz esetén a korábbi azonosítás nem marad érvényben.

A hálózati hibát nem követi a folyamaton belül újabb rejtett kérés: az újrapróbálkozás a látható visszaszámláláshoz igazodik. A 30 másodperces AKS-időkorlát, 120 másodperces felületi várakozás és a kérések közötti 5 másodperc megmarad. A visszaszámláló most a backend legfeljebb 300 másodperces várakozását is helyesen kezeli.

Az azonnal mentő kapcsoló és az egyetlen legolcsóbb megfelelő ajánlat megjelenítése megmaradt. Az első, még ismeretlen játék lekéréséhez továbbra is szükséges a Steam-adat, az AKS-keresés és az ajánlatoldal.
