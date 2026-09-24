# A sergioalmela/allkeyshop-api vizsgálata

Vizsgálat: 2026-09-24, a projekt 2.0.0-s forrása. A könyvtárat nem telepítettük és a kódját nem vettük át.

Forrás: https://github.com/sergioalmela/allkeyshop-api

## Használt adatforrások

- `src/fetch.ts`: az AKS `api/v2/vaks.php?action=gameNames&currency=eur` katalógusát tölti le, helyben cache-eli.
- `src/gather.ts`: az `api/price_history_api.php` végpontot használja; a visszaadott `history` sorokat ajánlatokká alakítja.
- `src/filter.ts`: hasonlósági névkeresés. A feldolgozó az első találatot választja. A `store` szűrő a kereskedő nevét vizsgálja, nem a termék aktiválási platformját.

## Egyetlen Solarpunk-próba eredménye

A fejlesztői hálózaton a katalógus kb. 1,06 másodperc, 11,2 MB és 209373 bejegyzés volt. Külön Solarpunk, konzolos és Steam Account termék is szerepel benne. Az árhistorika kb. 0,36 másodperc alatt érkezett, 3381 történeti sorral.

A `lower_keyshops_price` 9,02 EUR értékéhez 2026-07-29-es időpont tartozott, a `lower_official_price` 13,10 EUR értékéhez 2026-08-09-es. Ezekből nem állítható, hogy ma ennyiért megvásárolható a játék. A régi történeti sorok közül a könyvtár nem csak egy bizonyítottan aktuális és elérhető ajánlatot választ ki.

## Döntés

Nem cseréljük erre a jelenlegi élőajánlat-lekérést. A felhasználó kérése szerint a pontos játék, engedélyezett kereskedő, Steam-kulcs vagy engedélyezett Gift és aktuális ár ellenőrzése megmarad. A történeti válasz nem tartalmazza a jelenlegi szűrésünk által megkövetelt account/aktiválási platform/elérhetőség mezőket. Ezeket nem helyettesítjük kitalált értékekkel.

A katalógus későbbi névfeloldáshoz, a historika külön jelölt ár-előzmény funkcióhoz hasznos lehet. Egyik sem garantálja a szolgáltatói IP-korlátozás megszűnését, mert továbbra is az AllKeyShop kiszolgálóit kérdezi.

Az ettől független, már kért AKS → GG.deals tartalék működés elkészült: kapcsolat/hozzáférés/rate limit hibák esetén külön, GG.deals jelölésű összesített ár jelenik meg. A GG-ár nem lesz AKS boltszűrésnek megfelelő ajánlatként feltüntetve.
