# Közreműködési szabályok

## Commit üzenetek

Minden Git commit üzenetét kizárólag magyar nyelven kell megírni. Ezek a GitHub Release-ek „Módosítások” szakaszában is megjelenhetnek, ezért legyenek rövidek, egyértelműek és magyarul érthetők.

## Kiadások és biztonsági mentések

Minden új GitHub Release a projekt teljes, stabil biztonsági mentése és egyben visszaállítási pont. A kiadás a szerveren lévő kód állapotát rögzíti, ezért hiba esetén ebből kell rollbackelni.

Éles szerveren közvetlen, GitHub Release nélküli módosítás nem megengedett. Minden éles változtatást előbb a repóban kell commitolni, majd GitHub Release-en keresztül kiadni.

## Decky ZIP csomagolasi szabaly

A kiadhato Decky ZIP-ekben a `ControllerXbox/` gyokermappa es a fajlok sorrendje kotott: `.gitignore`, `LICENSE`, `README.md`, `main.py`, `package.json`, `plugin.json`, `pnpm-lock.yaml`, `dist/index.js`, `dist/index.js.map`. Kiadás előtt a ZIP fajlsorrendjet, tomoriteset es metaadatait a mukodo `ControllerXbox-v1.0.0.zip`-hez kell hasonlitani. Rekurziv vagy fajlrendszer szerinti ZIP-keszites tilos.

## Decky Python kompatibilitasi szabaly

A backendnek Python 3.8-kompatibilisnek kell maradnia. Tilos a `dict[str, ...]`, `list[str]`, `X | None`, az `asyncio.to_thread` es minden Python 3.9+ nyelvi vagy asyncio API hasznalata. Fajl- es halozati muveletekhez a `run_in_executor` kompatibilis segedet kell hasznalni. Kiadás előtt a `main.py` Python 3.8 szintaxisat kulon ellenorizni kell.

## Decky frontend-backend API szabaly

A `plugin.json`-ban kotelezo az `"api_version": 1` mezo. Enelkul a modern `@decky/api` `callable(...)` hivasok nem erik el a Python backendet, es csak altalanos "Python exception" hibat adnak vissza.
