# AllKeyShop JSON-adapter, 1.0.88

Forrásvizsgálat: 2026-09-24, [sergioalmela/allkeyshop-api 2.0.0](https://github.com/sergioalmela/allkeyshop-api). A nyilvános adatvégpontokhoz saját Python-illesztés készült; a könyvtár kódját nem másoltuk és nem telepítjük. Az Ubuntu és Decky ugyanazt a backendet használja.

## Adatút és gyorsítótár

- `https://www.allkeyshop.com/api/v2/vaks.php?action=gameNames&currency=eur`: közös játéknév-katalógus, külön fájlban és memóriában, 24 órás TTL. Nincs játékonkénti keresőkérés. A nagy katalógus nem kerül minden ármentéskor újraírásra.
- Pontos normalizált címillesztés (™/® nélkül), több eltérő termékazonosítóra illeszkedő cím elutasítása. Nincs fuzzy elsőtalálat-választás. A konzolos és Steam Account utótagokat nem töröljük.
- Steam AppID → katalógus-termékazonosító: 7 napos tartós cache. A Steam-metaadatok 24 órásak. Címeltérés vagy új katalógusban megváltozott párosítás érvényteleníti a találatot. HTTP 404/410 után legfeljebb egy friss katalógusos újrakeresés történik.
- `https://www.allkeyshop.com/api/price_history_api.php?normalised_name=<ID>&currency=EUR&database=allkeyshop.com&v2=1`: ismert játék esetén egyetlen AKS-lekérés. A válaszokat 24 óráig használjuk. A friss ár olvasása teljesen hálózatmentes, a lejárt mentett ár azonnal látható a háttérfrissítés alatt.
- Megmarad az egyetlen AKS HTTP-lock, 1,5 másodperces pacing, Retry-After, backoff, AppID single-flight és deduplikált háttérmentés. 1.0.89-től a boltlista az API-ban megismert és korábban mentett nevekből áll. A régi HTML-boltlista nem kérdezhető le: az AKS HTTP-réteg csak a két JSON-végpontot engedi.

## A legutóbbi megfelelő minimum kiválasztása

1. A `history` nem feltétlenül csak objektumokat tartalmaz: a hibás sorok kimaradnak.
2. Kereskedő + termék + kiadás + régió szerint az `end`, majd `start` időponttal legújabb sort vesszük. Érvénytelen új ár nem hozza vissza a régi olcsó árat. Egyező időpontú, ellentmondásos sorok kizárva.
3. 1.0.94-tól nincs boltok közötti 24 órás dátumszűrés: a Bento Blocks esetén ez a Kinguin/Eneba utolsó ajánlatát tévesen kizárta. A termék legutolsó sora megmarad, dátuma látszik; jelenlegi elérhetőséget a historika nem bizonyít. A Steam történeti sorai kizárva: az összehasonlítás a megnyitott Steam-oldal EUR árával történik.
4. A kiválasztott boltok listája és az üres explicit kiválasztás működése megmarad. Csak Standard / Standard Edition, Steam-kulcs és engedélyezett Gift: EU, Global vagy ROW régió. Az egyszerű `Steam` / `Steam Gift` az AKS általános, régiómegkötés nélküli csoportja; a felület az eredeti jelölést is kiírja. Ez és a ROW nem garantál magyarországi aktiválhatóságot.
5. A legutóbbi sor `last_price` / `min_discount_price` értékei közül választunk. Nincs régi rekordból átvett kupon. Hiányzó kupon esetén a kedvezményes árat ezzel a megjegyzéssel jelenítjük meg. A `lower_keyshops_price` és `lower_official_price` történeti minimumokat nem használjuk.
6. A szűrés után legalacsonyabb ár jelenik meg. A kiválasztott ajánlat `end` dátuma külön látszik a saját `checked_at` lekérési időpontunktól. A forrás nem ad időzónát, ezért a dátumát nem alakítjuk át kitalált UTC-idővé.

A végpont nem ad megbízható jelenlegi készlet- vagy teljes fizetésidíj-adatot. Nem gyártunk hozzá `dispo`, `account` vagy `priceCard` mezőket. A terméktípus szűrése a pontos katalógusillesztés és a régió/kiadás engedélylistája alapján történik. A katalógus nem tartalmaz ellenőrzött boltoldal-URL-t, ezért az új eredmény AllKeyShop-főoldali forráshivatkozást kap.

## Ellenőrzés

A 2026-09-24-én letöltött Solarpunk-mintában 3381 történeti sorból 40 legutóbbi, időablakon belüli sor maradt. A felsorolt hét bolt (YUPLAY, GAMESEAL, GAMIVO, G2A, Kinguin, Eneba, HRK) szűrésével 16 ajánlatból a Kinguin EU kedvezményes 10,05 EUR volt a minimum; forrásidő 2026-09-24 09:52:39, kuponkód nélkül. Ez rögzített tesztminta, nem folyamatosan frissülő árígéret. Célzott tesztek ellenőrzik a sorrendfüggetlenséget, régi minimumok kizárását, boltokat, Gift-kapcsolót, EU/Global/ROW besorolást, hibás adatokat, cache-visszatöltést és szerveres továbbítást.

A régi HTML-árak érvényes cache-e lejáratig megmarad; utána már az új JSON-adapter fut. A GG.deals kapcsolati hiba esetére meglévő tartalék működés változatlan, külön jelölt összesített árat ad. Az új végpont ugyanazon szolgáltatóé, ezért IP-korlátozás továbbra is előfordulhat.

## 2026-09-25 célzott ellenőrzés

Portal (AKS 4773): a legutóbbi Steam-sor maga 1,95 EUR értéket tartalmazott (2026-03-26–2026-09-24), ezért nem tekinthető a megnyitott oldali aktuális Steam-árnak. Bento Blocks (AKS 205196): Kinguin 3,40 EUR, AKSPLAY, 2026-09-04 12:46:36; Eneba 4,37 EUR, 2026-09-22 19:48:06. Mindkettő kiesett a más bolthoz viszonyított dátumszűrésen. Ezek a letöltött API-minta értékei, nem az eladónál igazolt mai végösszegek. A szolgáltatótól kapott régi/hibás adatot helyi számítás nem tudja hiteles élő árrá alakítani.
