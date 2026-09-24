# Deck Play Badges – saját árszerver Ubuntuhoz

A Decky a saját HTTPS-szerveredtől kér árakat. A szerver közös, lemezre mentett cache-t és egyetlen árlekérési sort használ, így két Deck ugyanarra a játékra nem indít két külső lekérést. A plugin AKS-illesztését és szűrését használja; nincs külön, eltérő árkereső implementáció. Az AKS-boltlistát a szerver szerzi be, a kiválasztott boltok szerinti szűrést minden Deck helyben végzi.

Ez a szerver **nem IP-forgató és nem tiltásmegkerülő szolgáltatás**. A DuckDNS a változó IP-címhez stabil nevet ad. A szolgáltatók továbbra is a szerver kimenő IP-címét látják, közös otthoni hálózaton ez megegyezhet a Deckével. A kisebb kérésmennyiség és a közös rate limit csökkenti a felesleges terhelést; a tiltásmentesség nem garantálható.

## Előkészítés

- Ubuntu Desktop 22.04 vagy újabb, Python 3, rendszergazdai jogosultság és működő internet.
- A `sajat-szerver.duckdns.org` a kapcsolat **nyilvános IPv4-címére** mutasson. A telepítőben opcionálisan megadható a DuckDNS-token; ekkor a rendszer ötpercenként frissíti a címet. Ha ezt a router már végzi, a mező üresen hagyható.
- A router DHCP-beállításában rögzítsd az Ubuntu helyi címét, például `192.168.1.50`.
- Porttovábbítás: **TCP 80 → Ubuntu 80**, **TCP 443 → Ubuntu 443**. A Python `8765` portját ne továbbítsd: csak `127.0.0.1`-en figyel.
- Aktív UFW esetén: `sudo ufw allow 80/tcp` és `sudo ufw allow 443/tcp`. A telepítő nem módosítja a tűzfalat.
- A 80/443 portot Caddy szolgálja ki. Ha más webszerver használja őket, előbb rendezd a portütközést. Meglévő Caddyfile esetén a telepítő mentést készít és egy külön konfigurációt importál, nem törli a többi webhelyet.
- A router WAN-címe és a DuckDNS nyilvános címe eltérése CGNAT-ra vagy dupla NAT-ra utalhat; ilyenkor a porttovábbítás önmagában nem biztosít bejövő elérést. Hibás, régi AAAA rekordot ne hagyj a domainen, ha az IPv6-elérés nincs beállítva.

## Telepítés a GitHub Release csomagjából

Az Ubuntu termináljában:

```bash
curl -fLO https://github.com/Rannius/ControllerXbox/releases/download/v1.0.87/DeckPriceServer-v1.0.87.tar.gz
tar -xzf DeckPriceServer-v1.0.87.tar.gz
cd DeckPriceServer
sudo bash install.sh sajat-szerver.duckdns.org
```

A telepítő ellenőrzi a csomag belső ellenőrzőösszegeit, telepíti a Python/Caddy függőségeket, külön rendszerfelhasználót hoz létre, és systemd szolgáltatásként indítja a backendet. A belső ellenőrzőösszeg sérülést észlel; a csomagot az eredeti HTTPS GitHub-kiadásból töltsd le.

A DuckDNS-token és a GG.deals-kulcs maszkolt terminálmezőben kérhető be. AllKeyShophoz nem kell GG.deals-kulcs. A telepítő egy **külön, véletlenszerű szervertokent** generál és kiír: ezt kell a Deckybe másolni. Az alkalmazáscsomag semmilyen személyes kulcsot nem tartalmaz. A konfigurációt csak root és a szolgáltatás felhasználója olvashatja.

Caddy automatikusan igényli és megújítja a HTTPS-tanúsítványt. Ehhez a domainnek a szerverre kell mutatnia, és a külső 80/443 elérésnek működnie kell. A tanúsítvány létrejötte néhány percet igénybe vehet; a telepítő sikere önmagában nem bizonyít külső elérést.

## Decky beállítása

1. Telepítsd a Deck Play Badges **1.0.84 vagy újabb** verzióját.
2. Beállítások → Játékárak → **Lekérés saját szerveren keresztül**.
3. Cím: `https://sajat-szerver.duckdns.org`.
4. Szervertoken: a telepítő által generált érték. **Nem a DuckDNS-token vagy a GG.deals-kulcs.**
5. Válaszd ki az AllKeyShopot vagy a GG.dealst, majd **Árbeállítások alkalmazása**.
6. **Mentett szerverkapcsolat tesztelése**: jelzi a kapcsolatot, a cache számlálóit és a szerveren beállított GG.deals-kulcs elérhetőségét.

Az AKS megbízhatóbolt- és Gift-beállításai megmaradnak. A GG.deals továbbra is összesített összehasonlító árakat ad, amelyek nem szűrhetők boltra vagy Steam-kulcs/Gift típusra; a felület ezt jelzi.

## Ellenőrzés és működés

Telefonon **mobilnetről** nyisd meg: `https://sajat-szerver.duckdns.org/health`. A `deck-price-server` nevű JSON-válasz a HTTPS-elérést bizonyítja, árakat és titkokat nem mutat. Az ár- és státuszvégpontokhoz már szervertoken kell.

Ha mobilnetről működik, az otthoni Wi-Fi-ről viszont nem, a router NAT loopback/hairpin funkcióját vagy a helyi DNS-t kell beállítani. Helyi DNS esetén ugyanazt a `sajat-szerver.duckdns.org` nevet irányítsd az Ubuntu belső címére; a Decky HTTPS-címét ne cseréld nyers IP-címre.

```bash
sudo systemctl status deck-price-server caddy
sudo journalctl -u deck-price-server -n 80 --no-pager
sudo journalctl -u caddy -n 80 --no-pager
systemctl list-timers deck-price-duckdns.timer
```

- Cache: `/var/lib/deck-price-server/`. Steam-adatok 24 óra, AKS-párosítás 7 nap, árak 24 óra.
- Konfiguráció: `/etc/deck-price-server/config.json`. Módosítás után: `sudo systemctl restart deck-price-server`.
- A szerver nem tárol Steam-fiókot, belépési adatot vagy kívánságlista-tagságot. A Deck a szükséges AppID-t, forrást és prioritást küldi.
- Nincs folyamatos teljes-katalógus letöltés. Külső lekérést az igényelt, hiányzó vagy lejárt ár indít. Már sorba állított feladatok az áruház bezárása után még befejeződhetnek.
- Egy közös kérési sor, legfeljebb 128 függő játék; az előtérben megnyitott játék megelőzi a háttérfeladatokat. A már futó kérés befejeződhet.
- Az AKS-kérések sorosak, 1,5 mp alapközzel, 429/Retry-After és fokozatos lassítás mellett. A GG.deals API-korlátait is a szerver kezeli.
- A friss ár a Deck helyi cache-éből hálózat nélkül megjelenhet. A saját szerver cache-találata egy rövid HTTPS-kérés; a még nem ismert játékot előbb a szolgáltatótól kell megszerezni.
- A Deck cache-törlése **csak a Deck helyi adatait** törli, a megosztott szerverét nem.
- Szerverhiba esetén megmarad a helyi mentett ár; nincs automatikus közvetlen AKS/GG-lekérés. Kézzel bármikor visszaválthatsz közvetlen módra.
- Az Ubuntu legyen bekapcsolva, és ne altassa el magát, amíg használni szeretnétek a szolgáltatást. Újraindítás után a szolgáltatások automatikusan elindulnak.
- IP-változáskor a DuckDNS frissítése és a DNS-cache lejárata idejére rövid kimaradás előfordulhat.

## Frissítés / visszaállítás

Az új vagy korábbi **GitHub Release** szervercsomagját külön könyvtárba bontsd ki, majd futtasd annak telepítőjét. A meglévő token és cache megmarad; a kulcsmezők üresen hagyva megtartják a korábbi értéket. Éles fájlokat ne írj felül kiadatlan fejlesztői kóddal. A helyi konfigurációt és cache-t külön mentsd, ezek nem részei a nyilvános release-nek.

## Home Assistant: élő állapot (1.0.85-től)

1.0.87-től AKS-kapcsolati hiba vagy hozzáférési korlátozás esetén a szerver a beállított GG.deals-kulccsal tartalék árat kér. A Decky és a szerver egyaránt 1.0.87-es legyen. A GG-kulcs az Ubuntu telepítőjével megadható, a többi mező üresen megtartja korábbi értékét. Hiányzó kulcs esetén a meglévő AKS-hibajelzés marad. Az AKS kiválasztva marad, az árat `GG.deals:` jelöli; a bolt- és Steam-kulcs/Gift-szűrők erre az összehasonlító árra nem alkalmazhatók. A friss GG tartalék ár 24 óráig használható, majd újra AKS-lekéréssel próbálkozunk. Az AKS- és GG-korlátokat egyaránt tiszteletben tartjuk. A saját szerver kiesése nem indít közvetlen lekérést a Decken.

A `GET /v1/status` végpont ugyanazzal a `Authorization: Bearer ...` szervertokennel olvasható, mint amit a Decky használ. Csak HTTPS-en, a saját beállított címeden érd el. Az állapot olvasása nem indít árlekérést, nem frissíti a cache-t és nem ír lemezre. A meglévő Decky 1.0.84 kliens továbbra is használható; ehhez a funkcióhoz csak a szerver frissítése szükséges.

1. Frissítsd az Ubuntu szervert az 1.0.85-ös release csomagjából. A telepítő az új kóddal újraindítja a szolgáltatást; a kulcsmezők üresen hagyva megtartják a korábbi beállításokat.
2. A Home Assistant `secrets.yaml` fájljába helyben írd be (a helyőrzőket cseréld):

   ```yaml
   deck_price_status_url: "https://YOUR_HOST/v1/status"
   deck_price_authorization: "Bearer YOUR_SERVER_TOKEN"
   ```

3. A csomag `home-assistant.yaml` fájljának tartalmát illeszd a HA `configuration.yaml` fájljába. Ha van már `rest:` szakasz, az új elemet abba tedd, ne legyen két azonos felső szintű kulcs. A megoldás egyetlen HTTP-kéréssel, 15 másodpercenként frissíti az összes szenzort. A HTTPS-tanúsítvány ellenőrzése bekapcsolva marad.
4. Ellenőrizd a HA konfigurációját, majd indítsd újra a Home Assistantot.
5. Irányítópult → Szerkesztés → Kártya hozzáadása → Kézi: másold be a `home-assistant-card.yaml` tartalmát. Ha a HA eltérő entitásazonosítót osztott ki, igazítsd a kártyában szereplő azonosítókat.

A kártya mutatja a futó játék nevét (ha már ismert), AppID-jét, forrását és eltelt idejét; a következő feladatokat, az utolsó feldolgozásokat, valamint a hiányzó eredményeket. Hálózati hiba esetén a HA-szenzor nem elérhető állapotba kerül.

Az API mezői:

| Mező | Jelentés |
| --- | --- |
| `state` | `idle`, `running`, `waiting` (szolgáltatói szünet miatt sorban áll), `merchants` |
| `current` | Futó feladat: AppID, ismert cím, forrás, kezdési idő és eltelt másodperc |
| `waiting_count`, `waiting` | Sorban álló feladatok a futó nélkül; prioritás és szolgáltatói várakozás másodpercben |
| `queue` | Visszafelé kompatibilis számláló: futó + sorban álló feladatok |
| `recent` | Legutóbbi 50 befejezett próbálkozás, legújabb elöl; kimenetel, időpont, időtartam, újrapróbálhatóság időpontja |
| `stored`, `fresh`, `stale` | Tárolt eredmények; 24 órán belüli és lejárt bejegyzések. Az AKS és GG ugyanahhoz a játékhoz két külön bejegyzés |
| `providers` | AKS/GG külön számlálók, kihagyott játékok száma, beállítottság és szolgáltatói várakozás |
| `metadata_entries`, `match_entries` | Steam metadata és ellenőrzött AKS-párosítások száma |
| `completed`, `failed`, `cache_hits` | Indulás óta sikeres (kihagyást is beleértve) és hibás munkák, illetve friss cache-ből kiszolgált klienskérések. Nem HTTP-kérésszámok |
| `observed_count`, `missing_count`, `missing` | A szerver indulása óta kért, legutóbbi legfeljebb 2048 külön AppID/forrás közül hányat ismer és melyikhez nincs tárolt eredmény. A hiányzó lista legfeljebb 50 elemes |
| `observed_evicted`, `missing_truncated` | Jelzi, ha a megfigyelési ablakból régi kérés kikerült, illetve a hiányzó lista csonkolva van |

Az eseménytörténet és a munkaszámlálók újraindításkor nullázódnak; az árak tartós cache-e megmarad. A `stored` tartalmazza a sikeresen ellenőrzött, kihagyott vagy találat nélküli eredményeket is, nem csak a tényleges árakat. A lejárt tárolt eredmény nem számít hiányzónak. A szerver nem ismeri a teljes könyvtárat vagy kívánságlistát: a Deck által még el nem küldött játékokról nem állítja, hogy feldolgozta őket, ezért nincs félrevezető teljeslistás százalék.

A `missing` lista okai: `queued`, `running`, `failed`, `provider_wait`, `missing_key`, `queue_full`. A jelzett idő az újrapróbálás legkorábbi ideje, nem határidő vagy garantált automatikus újraindítás: a már sorba vett munkák folytatódnak, a visszautasított kérést a Deck küldi újra.

Az élő systemd-napló is kiírja a munkák indulását és végét (AppID, forrás, kimenetel, időtartam):

```bash
sudo journalctl -u deck-price-server -n 50 -f
```

Személyes szervercím, token, kliens-IP és nyers szolgáltatói hiba nem kerül az új eseménynaplóba vagy az állapotválaszba. A HA-példákban csak helyőrzők vannak. A részletes attribútumok HA-előzménymentését igény esetén a Recorder beállításaival kizárhatod a `sensor.deck_price_server` entitásnál.

HA dokumentáció: [RESTful integráció](https://www.home-assistant.io/integrations/rest/).

Források: [DuckDNS API](https://www.duckdns.org/spec.jsp), [Caddy automatikus HTTPS](https://caddyserver.com/docs/automatic-https).
