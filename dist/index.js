function getHungarianBadgeHtml(source = "steam") {
    return source === "curator"
        ? HUNGARIAN_BADGE_HTML.replace('aria-label="Hivatalos magyar nyelvi támogatás"', 'aria-label="Magyar nyelv a Magyar Felirat kurátor szerint"')
            .replace('title="Hivatalos magyar nyelvi támogatás a Steam adatai szerint"', 'title="Magyar nyelv – forrás: Magyar Felirat Steam-kurátor"')
        : HUNGARIAN_BADGE_HTML;
}
// The 2:1 tricolour remains crisp at the small sizes used on game covers.
const HUNGARIAN_BADGE_HTML = '<span role="img" aria-label="Hivatalos magyar nyelvi támogatás" title="Hivatalos magyar nyelvi támogatás a Steam adatai szerint" style="box-sizing:border-box;width:34px;height:24px;display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;border-radius:5px;background:rgba(6,9,18,.92);box-shadow:0 1px 5px rgba(0,0,0,.85),inset 0 0 0 1px rgba(255,255,255,.12);pointer-events:none"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="14" viewBox="0 0 30 15" aria-hidden="true" style="display:block;border-radius:2px;overflow:hidden"><path fill="#ce2939" d="M0 0h30v5H0z"/><path fill="#fff" d="M0 5h30v5H0z"/><path fill="#477050" d="M0 10h30v5H0z"/><rect x=".5" y=".5" width="29" height="14" rx="1.5" fill="none" stroke="#fff" stroke-opacity=".18"/></svg></span>';

// Refresh catalog data only. This never reloads Steam or changes game focus.
class CloudResumeRefresh {
    constructor(deps) {
        this.deps = deps;
        this.active = false;
        this.running = false;
        this.lastTick = 0;
        this.lastWake = 0;
    }
    start() {
        if (this.active)
            return;
        this.active = true;
        this.lastTick = Date.now();
        try {
            this.unregister = this.deps.register(() => this.wake());
        }
        catch (error) {
            this.deps.onError(error);
        }
        // Timer gaps also detect suspend when the Steam notification API is absent.
        this.interval = setInterval(() => {
            const now = Date.now();
            if (now - this.lastTick > 45_000)
                this.wake();
            this.lastTick = now;
        }, 15_000);
    }
    wake() {
        if (!this.active || this.running || this.timer !== undefined || Date.now() - this.lastWake < 60_000)
            return;
        this.lastWake = Date.now();
        this.schedule(8000, 0);
    }
    schedule(delay, attempt) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.run(attempt); }, delay);
    }
    async run(attempt) {
        if (!this.active)
            return;
        this.running = true;
        try {
            await this.deps.refresh();
        }
        catch (error) {
            this.deps.onError(error);
            // Wi-Fi may still be reconnecting after wake. Retry without overlapping.
            if (this.active && attempt < 2)
                this.schedule(attempt === 0 ? 30_000 : 120_000, attempt + 1);
        }
        finally {
            this.running = false;
        }
    }
    stop() {
        this.active = false;
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        if (this.interval !== undefined)
            clearInterval(this.interval);
        try {
            this.unregister?.();
        }
        catch { /* Steam may already be stopping. */ }
        this.timer = undefined;
        this.interval = undefined;
    }
}

function BadgeSizeSettings({ initial, save }) {
    const [draft, setDraft] = SP_REACT.useState(initial);
    const [saved, setSaved] = SP_REACT.useState(initial);
    const [working, setWorking] = SP_REACT.useState(false);
    const [error, setError] = SP_REACT.useState("");
    const dirty = draft.library_badge_percent !== saved.library_badge_percent || draft.store_badge_percent !== saved.store_badge_percent;
    SP_REACT.useEffect(() => {
        if (!dirty && !working) {
            setDraft(initial);
            setSaved(initial);
        }
    }, [initial.library_badge_percent, initial.store_badge_percent]);
    return SP_JSX.jsxs(SP_JSX.Fragment, { children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.SliderField, { label: "K\u00F6nyvt\u00E1r ikonm\u00E9rete", value: draft.library_badge_percent, min: 50, max: 200, step: 5, resetValue: 100, showValue: true, valueSuffix: "%", disabled: working, onChange: value => setDraft({ ...draft, library_badge_percent: Math.round(value) }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.SliderField, { label: "\u00C1ruh\u00E1z ikonm\u00E9rete", value: draft.store_badge_percent, min: 50, max: 200, step: 5, resetValue: 100, showValue: true, valueSuffix: "%", disabled: working, onChange: value => setDraft({ ...draft, store_badge_percent: Math.round(value) }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working || !dirty, onClick: async () => {
                        setWorking(true);
                        setError("");
                        try {
                            await save(draft);
                            setSaved(draft);
                        }
                        catch (e) {
                            setError(e instanceof Error ? e.message : String(e));
                        }
                        finally {
                            setWorking(false);
                        }
                    }, children: working ? "Méret mentése…" : "Ikonméretek alkalmazása" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: "12px", opacity: .8 }, children: error || "100% = eredeti méret. A két felület külön állítható; a nagyobb jelvények szükség esetén több sorba kerülnek." }) })] });
}

function HungarianProgress({ manager, loadCurator }) {
    const [scan, setScan] = SP_REACT.useState({ ...manager.progress, status: manager.status });
    const [curator, setCurator] = SP_REACT.useState();
    const [curatorError, setCuratorError] = SP_REACT.useState(false);
    const [now, setNow] = SP_REACT.useState(Date.now());
    SP_REACT.useEffect(() => manager.subscribe(status => setScan({ ...manager.progress, status })), [manager]);
    SP_REACT.useEffect(() => {
        if (scan.phase === "paused")
            return;
        let active = true;
        let timer;
        const poll = async () => {
            try {
                const result = await loadCurator();
                if (active) {
                    setCurator(result);
                    setCuratorError(!result.success);
                }
            }
            catch {
                if (active)
                    setCuratorError(true);
            }
            if (active)
                timer = setTimeout(() => void poll(), manager.progress.phase === "done" ? 60_000 : 2000);
        };
        void poll();
        return () => { active = false; clearTimeout(timer); };
    }, [loadCurator, scan.phase === "paused"]);
    SP_REACT.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const percent = scan.total ? Math.floor(scan.processed / scan.total * 100) : 0;
    const seconds = Math.max(0, Math.ceil((scan.nextCheckAt - now) / 1000));
    const titles = { waiting: "Várakozás a könyvtárra", cache: "Mentett adatok betöltése", checking: "Játékok ellenőrzése",
        saving: "Gyűjtemény mentése", between: "Következő ellenőrzésre vár", done: "Ellenőrzés kész", error: "Újrapróbálkozásra vár", paused: "Gyűjtés szünetel" };
    return SP_JSX.jsxs("div", { style: { padding: "12px", borderRadius: "8px", background: "rgba(0,0,0,.22)", fontSize: "12px", lineHeight: 1.5, overflowWrap: "anywhere" }, children: [SP_JSX.jsx("div", { style: { fontWeight: 700, fontSize: "14px" }, children: "\uD83C\uDDED\uD83C\uDDFA Magyar j\u00E1t\u00E9kok" }), SP_JSX.jsx("div", { role: "status", children: titles[scan.phase] }), SP_JSX.jsxs("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "8px" }, children: [SP_JSX.jsxs("span", { children: [scan.processed, " / ", scan.total, " sorra v\u00E9ve"] }), SP_JSX.jsxs("strong", { children: [percent, "%"] })] }), SP_JSX.jsx("div", { role: "progressbar", "aria-label": "K\u00F6nyvt\u00E1r ellen\u0151rz\u00E9se", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent, style: { height: "6px", background: "#394553", borderRadius: "4px", overflow: "hidden", margin: "5px 0 8px" }, children: SP_JSX.jsx("div", { style: { width: `${percent}%`, height: "100%", background: "#67c1f5", transition: "width .3s" } }) }), SP_JSX.jsxs("div", { children: [scan.checked, " j\u00E1t\u00E9khoz van nyelvi adat"] }), SP_JSX.jsxs("div", { children: [scan.found, " magyar tal\u00E1lat \u00B7 ", scan.collected, " a gy\u0171jtem\u00E9nyben"] }), scan.unknown > 0 && SP_JSX.jsxs("div", { children: [scan.unknown, " j\u00E1t\u00E9kn\u00E1l hi\u00E1nyz\u00F3 vagy bizonytalan nyelvi adat"] }), scan.current && SP_JSX.jsxs("div", { style: { marginTop: "8px" }, children: ["Most: ", scan.current] }), SP_JSX.jsx("div", { style: { opacity: .8, marginTop: "8px" }, children: scan.status }), scan.phase !== "paused" && SP_JSX.jsxs("div", { style: { marginTop: "8px" }, children: ["Magyar Felirat: ", curatorError ? "állapot nem érhető el; újrapróbáljuk"
                        : !curator ? "állapot betöltése…"
                            : curator.status === "loading" ? (curator.total ? `${curator.checked} / ${curator.total} ajánlás betöltve` : "lista letöltése…")
                                : curator.status === "cached" ? `${curator.entries} játék a listán${curator.stale ? " · korábbi lista, a frissítés később újraindul" : ""}`
                                    : "nem érhető el; később újrapróbáljuk"] }), scan.nextCheckAt > 0 && scan.phase !== "paused" && SP_JSX.jsx("div", { style: { opacity: .65, marginTop: "6px" }, children: seconds ? `Következő ${scan.phase === "done" ? "változásellenőrzés" : "ellenőrzés"}: ${Math.floor(seconds / 60)} p ${seconds % 60} mp` : "Következő ellenőrzésre vár…" })] });
}

const manifest = {"name":"Deck Play Badges"};
const API_VERSION = 2;
const internalAPIConnection = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;
if (!internalAPIConnection) {
    throw new Error('[@decky/api]: Failed to connect to the loader as as the loader API was not initialized. This is likely a bug in Decky Loader.');
}
let api;
try {
    api = internalAPIConnection.connect(API_VERSION, manifest.name);
}
catch {
    api = internalAPIConnection.connect(1, manifest.name);
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version 1. Some features may not work.`);
}
if (api._version != API_VERSION) {
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version ${api._version}. Some features may not work.`);
}
const callable = api.callable;
const routerHook = api.routerHook;
const toaster = api.toaster;
const fetchNoCors = api.fetchNoCors;

const load = callable("get_catalog_status");
function CatalogStatus() {
    const [status, setStatus] = SP_REACT.useState();
    const [failed, setFailed] = SP_REACT.useState(false);
    SP_REACT.useEffect(() => {
        let active = true;
        let timer;
        let timeout;
        const poll = async () => {
            try {
                const result = await Promise.race([load(), new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error("timeout")), 15000);
                    })]);
                if (active) {
                    setStatus(result);
                    setFailed(!result.success);
                }
            }
            catch {
                if (active)
                    setFailed(true);
            }
            finally {
                clearTimeout(timeout);
            }
            if (active)
                timer = setTimeout(() => void poll(), 10000);
        };
        void poll();
        return () => { active = false; clearTimeout(timer); clearTimeout(timeout); };
    }, []);
    return SP_JSX.jsxs("div", { style: { fontSize: "12px", lineHeight: 1.5, overflowWrap: "anywhere" }, children: [failed && SP_JSX.jsx("div", { children: "A katal\u00F3gusok \u00E1llapota most nem k\u00E9rdezhet\u0151 le." }), !status && !failed && SP_JSX.jsx("div", { children: "Katal\u00F3gusok \u00E1llapot\u00E1nak bet\u00F6lt\u00E9se\u2026" }), status && [['gfn', 'GFN'], ['boosteroid', 'Boosteroid']].map(([key, name]) => {
                const provider = status[key];
                return SP_JSX.jsxs("div", { style: { marginBottom: "6px" }, children: [SP_JSX.jsxs("strong", { children: [name, ": ", provider.stale ? "korábbi / még nem ellenőrzött adatok" : "naprakész"] }), SP_JSX.jsxs("div", { children: ["Utols\u00F3 sikeres friss\u00EDt\u00E9s: ", provider.checked_at ? new Date(provider.checked_at * 1000).toLocaleString("hu-HU") : "még nem történt"] }), SP_JSX.jsxs("div", { children: [provider.entries, " j\u00E1t\u00E9k", provider.pending_removals > 0 ? ` · ${provider.pending_removals} eltűnés megerősítésre vár` : ""] }), provider.error && SP_JSX.jsx("div", { children: "Friss\u00EDt\u00E9si hiba; az utols\u00F3 j\u00F3 katal\u00F3gus marad \u00E9rv\u00E9nyben." })] }, key);
            })] });
}

const getPreferences = callable("get_price_preferences");
const setPreferences = callable("set_price_preferences");
const getPrice = callable("get_allkeyshop_price");
async function timed(request) {
    let timer;
    try {
        return await Promise.race([request, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Az árlekérdezés nem válaszolt időben.")), 60000);
            })]);
    }
    finally {
        clearTimeout(timer);
    }
}
function AllKeyShopSettings() {
    const [prefs, setPrefs] = SP_REACT.useState();
    const [shops, setShops] = SP_REACT.useState("");
    const [busy, setBusy] = SP_REACT.useState(false);
    const [message, setMessage] = SP_REACT.useState("");
    SP_REACT.useEffect(() => {
        let active = true;
        void timed(getPreferences()).then(value => {
            if (active) {
                if (!value.success)
                    throw new Error(value.error || "Betöltési hiba");
                setPrefs(value);
                setShops(value.merchants.join(", "));
            }
        }).catch(error => { if (active)
            setMessage(String(error)); });
        return () => { active = false; };
    }, []);
    return SP_JSX.jsxs(SP_JSX.Fragment, { children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { marginTop: "12px", fontWeight: 700 }, children: "AllKeyShop \u00E1rak" }) }), prefs && SP_JSX.jsxs(SP_JSX.Fragment, { children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "\u00C1rak az \u00E1ruh\u00E1zi j\u00E1t\u00E9koldalon", checked: prefs.enabled, disabled: busy, onChange: enabled => setPrefs({ ...prefs, enabled }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Steam Gift is megengedett", checked: prefs.allow_gifts, disabled: busy, onChange: allow_gifts => setPrefs({ ...prefs, allow_gifts }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "El\u0151nyben r\u00E9szes\u00EDtett boltok", description: "Pontos boltnevek vessz\u0151vel elv\u00E1lasztva, pl. Eneba, GAMIVO. \u00DCresen minden megfelel\u0151 bolt.", value: shops, disabled: busy, onChange: event => setShops(event.currentTarget.value) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy, onClick: async () => {
                                setBusy(true);
                                setMessage("");
                                try {
                                    const value = await timed(setPreferences(prefs.enabled, prefs.allow_gifts, shops.split(",").map(s => s.trim()).filter(Boolean)));
                                    if (!value.success)
                                        throw new Error(value.error || "Mentési hiba");
                                    setPrefs(value);
                                    resetPriceView();
                                    setMessage("Árbeállítások mentve.");
                                }
                                catch (error) {
                                    setMessage(String(error));
                                }
                                finally {
                                    setBusy(false);
                                }
                            }, children: busy ? "Mentés…" : "Árbeállítások alkalmazása" }) })] }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: "12px", opacity: .8 }, children: message || "EUR · Standard kiadás · Global/EU Steam-kulcsok és opcionálisan Gift. Account és ismeretlen típus kizárva. Csak a megnyitott játékhoz kér le árat; 15 percig tárolja." }) })] });
}
// Keep this renderer independent of Steam selectors except for its insertion
// point. All third-party text is assigned through textContent, never HTML.
function buildPricePanelScript(appId, result) {
    return `(() => {
    const appId = ${JSON.stringify(appId)};
    const data = ${JSON.stringify(result ?? null).replace(/</g, "\\u003c")};
    const id = 'deck-play-badges-price';
    const pageId = location.pathname.match(/^\\/app\\/(\\d+)/)?.[1];
    let panel = document.getElementById(id);
    if (!appId || pageId !== appId || data?.disabled) { panel?.remove(); return; }
    const host = document.querySelector('.game_area_purchase');
    if (!host) { panel?.remove(); return; }
    const key = appId + ':' + JSON.stringify(data);
    if (panel?.dataset.state === key && panel.parentElement === host) return;
    panel?.remove(); panel = document.createElement('section'); panel.id = id; panel.dataset.state = key;
    panel.style.cssText = 'box-sizing:border-box;background:#162634;border:1px solid #4a6478;border-radius:6px;padding:14px;margin:12px 0;color:#dce6ed;font:14px/1.5 Arial,sans-serif;overflow-wrap:anywhere;max-width:100%';
    const line = (text, bold = false) => { const node = document.createElement('div'); node.textContent = text; if (bold) node.style.fontWeight = '700'; panel.appendChild(node); };
    line('AllKeyShop · Steam-kulcs / Gift', true);
    if (!data) line('Árak betöltése…');
    else if (!data.success) line(data.error || 'Az ár most nem érhető el.');
    else {
      line(data.preferred_only ? 'Legalacsonyabb ár a kiválasztott boltokból' : 'Legalacsonyabb megfelelő ajánlat');
      if (!data.offers?.length) line('Nincs megfelelő Steam-kulcs vagy Gift az aktuális szűrőkkel.');
      for (const [index, offer] of (data.offers || []).entries()) {
        line(offer.price.toFixed(2) + ' € · ' + offer.merchant, index === 0);
        line(offer.kind + ' · ' + offer.edition + (offer.coupon ? ' · Kupon: ' + offer.coupon : ''));
      }
      line('AKS szerinti, kártyadíjat tartalmazó ár; kupon esetén annak feltételeivel.');
      line('Global/EU besorolás. A végösszeget és a magyarországi aktiválhatóságot az eladónál ellenőrizd.');
      if (data.checked_at) line('Ellenőrizve: ' + new Date(data.checked_at * 1000).toLocaleString('hu-HU'));
      if (/^https:\\/\\/www\\.allkeyshop\\.com\\/blog\\/(?:buy-|compare-and-buy-cd-key-for-digital-download-)[a-z0-9-]+\\/$/.test(data.url || '')) {
        const link = document.createElement('a'); link.href = data.url; link.textContent = 'AllKeyShop adatlap megnyitása (az ottani lista külön szűrhető)';
        link.style.cssText = 'display:block;color:#67c1f5;padding:8px 0'; panel.appendChild(link);
      }
    }
    host.prepend(panel);
  })();`;
}
const prices = new Map();
let fetching = false;
let revision = 0;
let currentApp = "";
function resetPriceView() { prices.clear(); revision++; currentApp = ""; }
function updatePriceView(url, send) {
    let id = "";
    try {
        const parsed = new URL(url);
        if (parsed.hostname === "store.steampowered.com")
            id = parsed.pathname.match(/^\/app\/(\d+)/)?.[1] ?? "";
    }
    catch { /* no game */ }
    currentApp = id;
    const cached = prices.get(id);
    void send(buildPricePanelScript(id, cached?.value)).catch(() => { });
    if (!id || fetching || (cached && cached.expires > Date.now()))
        return;
    fetching = true;
    const requestRevision = revision;
    void timed(getPrice(id)).catch(error => ({ success: false, error: String(error) })).then(value => {
        if (requestRevision !== revision)
            return;
        if (prices.size >= 100)
            prices.delete(prices.keys().next().value);
        prices.set(id, { value, expires: Date.now() + (value.success && !value.disabled ? 900000 : 60000) });
        if (currentApp === id)
            void send(buildPricePanelScript(id, value)).catch(() => { });
    }).finally(() => { fetching = false; });
}

const HUNGARIAN_COLLECTION_NAME = "🇭🇺 Magyar nyelvű játékok";
// Steam's userCollections computed getter calls .values() before storage exists.
// Do not evaluate it, even inside try/catch: MobX shares that computed failure
// with Steam's own library views. Use the storage map after initialization.
function readyCollectionStore(store) {
    return !!store && typeof store.collectionsFromStorage?.values === "function"
        && typeof store.m_cloudStorageMap?.StoreObject === "function"
        && typeof store.NewUnsavedCollection === "function";
}
class HungarianCollection {
    constructor(deps) {
        this.deps = deps;
        this.status = "Magyar gyűjtemény: várakozás a beállításokra.";
        this.progress = { phase: "waiting", total: 0, processed: 0, checked: 0, found: 0, collected: 0, unknown: 0, current: "", nextCheckAt: 0 };
        this.listeners = new Set();
        this.enabled = false;
        this.revision = 0;
        this.running = false;
        this.retryAfter = new Map();
        this.attempted = new Map();
    }
    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.status);
        return () => { this.listeners.delete(listener); };
    }
    report(status, progress = {}) {
        this.progress = { ...this.progress, ...progress };
        this.status = status;
        for (const listener of this.listeners)
            listener(status);
    }
    settingsUnavailable() {
        if (!this.enabled)
            this.report("A backend nem válaszol. A beállítások betöltését újrapróbáljuk.", { phase: "error" });
    }
    setEnabled(enabled) {
        if (enabled === this.enabled) {
            if (!enabled)
                this.report("Gyűjtés szüneteltetve. A meglévő gyűjtemény megmarad.", { phase: "paused", current: "", nextCheckAt: 0 });
            return;
        }
        this.enabled = enabled;
        this.revision++;
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = undefined;
        if (enabled) {
            this.report("Könyvtár betöltése…", { phase: "waiting", current: "", nextCheckAt: 0 });
            this.schedule(1000);
        }
        else {
            this.report("Gyűjtés szüneteltetve. A meglévő gyűjtemény megmarad.", { phase: "paused", current: "", nextCheckAt: 0 });
        }
    }
    stop() {
        this.setEnabled(false);
        this.listeners.clear();
    }
    schedule(delay) {
        if (!this.enabled || this.timer !== undefined || this.running)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.tick();
        }, delay);
    }
    apps() {
        return Array.from(new Map(this.deps.getApps()
            .filter(app => Number.isInteger(app.appid) && app.appid > 0 && app.appid < 2147483648
            && !app.BIsModOrShortcut?.() && (app.app_type === undefined || app.app_type === 1))
            .map(app => [String(app.appid), app])).values());
    }
    async sync(store, apps, languages) {
        const positive = apps.filter(app => languages[String(app.appid)] === true);
        if (!readyCollectionStore(store))
            throw new Error("Várakozás a Steam gyűjteménykezelőjére.");
        const existing = Array.from(store.collectionsFromStorage.values()).find(c => c.displayName === HUNGARIAN_COLLECTION_NAME);
        const pending = this.unsaved?.store === store && this.unsaved.storage === store.collectionsFromStorage ? this.unsaved.collection : undefined;
        let collection = existing ?? pending;
        if (!collection && !positive.length)
            return 0;
        if (!collection) {
            collection = store.NewUnsavedCollection(HUNGARIAN_COLLECTION_NAME, undefined, []);
            this.unsaved = { store, storage: store.collectionsFromStorage, collection };
        }
        if (typeof collection?.apps?.has !== "function" || typeof collection.Save !== "function"
            || typeof collection.AsDragDropCollection !== "function") {
            throw new Error("A Steam gyűjteménykezelője nem kompatibilis.");
        }
        const add = positive.filter(app => !collection.apps.has(app.appid));
        // Missing/offline language data never removes an already confirmed game.
        const remove = apps.filter(app => languages[String(app.appid)] === false && collection.apps.has(app.appid));
        if (add.length || remove.length) {
            const editable = collection.AsDragDropCollection();
            if (typeof editable?.AddApps !== "function" || (remove.length && typeof editable.RemoveApps !== "function")) {
                throw new Error("A Steam gyűjtemény nem módosítható.");
            }
            this.unsaved = { store, storage: store.collectionsFromStorage, collection };
            if (add.length)
                editable.AddApps(add);
            if (remove.length)
                editable.RemoveApps(remove);
        }
        if (this.unsaved?.collection === collection) {
            await collection.Save();
            this.unsaved = undefined;
        }
        return apps.filter(app => collection.apps.has(app.appid)).length;
    }
    async tick() {
        if (!this.enabled || this.running)
            return;
        this.running = true;
        const revision = this.revision;
        const current = () => this.enabled && revision === this.revision;
        let delay = 15 * 60_000;
        try {
            const store = this.deps.getStore();
            if (!readyCollectionStore(store)) {
                throw new Error("Várakozás a Steam gyűjteménykezelőjére.");
            }
            const storage = store.collectionsFromStorage;
            if (this.scanStorage !== storage) {
                this.scanStorage = storage;
                this.attempted.clear();
                this.retryAfter.clear();
            }
            const apps = this.apps();
            if (!apps.length)
                throw new Error("Várakozás a Steam könyvtárára.");
            const ids = apps.map(app => String(app.appid));
            this.report("Mentett nyelvi adatok és kurátortalálatok betöltése…", { phase: "cache", total: ids.length, current: "", nextCheckAt: 0 });
            const cached = await this.deps.cached(ids);
            if (!current())
                return;
            if (!cached.success)
                throw new Error("A nyelvi gyorsítótár nem érhető el.");
            if (cached.scan_epoch !== undefined && cached.scan_epoch !== this.scanEpoch) {
                this.scanEpoch = cached.scan_epoch;
                this.attempted.clear();
                this.retryAfter.clear();
            }
            for (const [id, stamp] of Object.entries(cached.scan_attempts ?? {}))
                this.attempted.set(id, stamp * 1000);
            for (const [id, stamp] of Object.entries(cached.scan_retry_after ?? {}))
                this.retryAfter.set(id, stamp * 1000);
            const languages = { ...cached.hungarian };
            const sources = { ...cached.hungarian_sources };
            const counts = (list) => ({ total: list.length,
                processed: list.filter(app => this.attempted.has(String(app.appid)) || Object.prototype.hasOwnProperty.call(languages, String(app.appid))).length,
                checked: list.filter(app => typeof languages[String(app.appid)] === "boolean").length,
                found: list.filter(app => languages[String(app.appid)] === true).length,
                unknown: list.filter(app => languages[String(app.appid)] === null || (this.attempted.has(String(app.appid)) && !Object.prototype.hasOwnProperty.call(languages, String(app.appid)))).length });
            const pending = ids.filter(id => !Object.prototype.hasOwnProperty.call(languages, id));
            const queue = pending.filter(id => (this.retryAfter.get(id) ?? 0) <= Date.now())
                .sort((a, b) => (this.attempted.get(a) ?? 0) - (this.attempted.get(b) ?? 0));
            const valid = () => current() && this.deps.getStore() === store && store.collectionsFromStorage === storage;
            if (!valid())
                return;
            this.deps.onLanguages(languages, sources);
            // Cached and curator matches are collected before any network lookups.
            const collectedBefore = await this.sync(store, this.apps(), languages);
            if (!valid())
                return;
            this.report("Folyamatos ellenőrzés, legfeljebb 4 párhuzamos lekéréssel…", { ...counts(apps), collected: collectedBefore, phase: "checking" });
            const active = new Set();
            const names = new Map(apps.map(app => [String(app.appid), app.display_name || app.strDisplayName || app.name || `Steam AppID ${app.appid}`]));
            let cursor = 0;
            let pauseUntil = 0;
            let lookupError = "";
            const showProgress = () => this.report("Folyamatos ellenőrzés, legfeljebb 4 párhuzamos lekéréssel…", {
                ...counts(this.apps()), phase: "checking", current: Array.from(active, id => names.get(id) || id).join(" · "), nextCheckAt: 0,
            });
            const worker = async () => {
                while (valid() && !pauseUntil && cursor < queue.length) {
                    const id = queue[cursor++];
                    // Ownership may change while a long scan is running.
                    if (!this.apps().some(app => String(app.appid) === id))
                        continue;
                    active.add(id);
                    showProgress();
                    let result;
                    try {
                        result = await this.deps.lookup([id]);
                        if (!result.success)
                            throw new Error("A Steam nyelvi adatai nem érhetők el.");
                    }
                    catch (error) {
                        lookupError = error instanceof Error ? error.message : String(error);
                        result = { success: false, unavailable: [id], retry_after: 60 };
                    }
                    active.delete(id);
                    if (!valid())
                        return;
                    this.attempted.set(id, Date.now());
                    if ((result.retry_after ?? 0) > 0) {
                        pauseUntil = Math.max(pauseUntil, Date.now() + Math.min(3600, result.retry_after) * 1000);
                        lookupError = "A Steam átmenetileg nem fogad új lekérést";
                    }
                    if ((result.unavailable?.includes(id) && result.hungarian?.[id] !== true)
                        || !Object.prototype.hasOwnProperty.call(result.hungarian ?? {}, id)) {
                        this.retryAfter.set(id, Date.now() + ((result.retry_after ?? 0) > 0 ? Math.min(3600, result.retry_after) * 1000 : 15 * 60_000));
                    }
                    else {
                        languages[id] = result.hungarian[id];
                        sources[id] = result.hungarian_sources?.[id] ?? null;
                        this.retryAfter.delete(id);
                        this.deps.onLanguages({ [id]: languages[id] }, { [id]: sources[id] });
                    }
                    showProgress();
                }
            };
            // No batch barrier: a free worker immediately takes the next game.
            const workers = await Promise.allSettled(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
            const failed = workers.find((result) => result.status === "rejected");
            if (failed)
                throw failed.reason;
            if (pauseUntil)
                delay = Math.max(1000, pauseUntil - Date.now());
            else if (cached.curator_status === "loading")
                delay = 5000;
            else {
                const retries = pending.map(id => this.retryAfter.get(id) ?? 0).filter(stamp => stamp > Date.now());
                if (retries.length)
                    delay = Math.min(delay, Math.max(1000, Math.min(...retries) - Date.now()));
            }
            if (!current() || this.deps.getStore() !== store || store.collectionsFromStorage !== storage)
                return;
            this.deps.onLanguages(languages, sources);
            // Re-read ownership after I/O, including account/library changes.
            const currentApps = this.apps();
            this.report("Magyar gyűjtemény egyeztetése és mentése…", { ...counts(currentApps), phase: "saving", current: "" });
            const collected = await this.sync(store, currentApps, languages);
            if (!current())
                return;
            const checked = currentApps.filter(app => typeof languages[String(app.appid)] === "boolean").length;
            const found = currentApps.filter(app => languages[String(app.appid)] === true).length;
            this.report(`${found} magyar játék · ${checked}/${currentApps.length} játékhoz van nyelvi adat.`
                + (checked < currentApps.length ? " Az ellenőrzési kör kész; a hiányzó adatokat később újrapróbáljuk."
                    : " Kész. Új játékok és lejárt adatok ellenőrzése 15 percenként.")
                + (cached.curator_status === "loading" ? " Magyar Felirat: lista betöltése…"
                    : cached.curator_status === "unavailable" ? " A Magyar Felirat listája még nem érhető el; később újrapróbáljuk." : "")
                + (lookupError ? ` Átmeneti szünet: ${lookupError}.` : ""), { ...counts(currentApps), collected, current: "", phase: checked === currentApps.length && cached.curator_status !== "loading" && cached.curator_status !== "unavailable" ? "done" : "between", nextCheckAt: Date.now() + delay });
        }
        catch (error) {
            if (current())
                this.report(error instanceof Error ? error.message : String(error), { phase: "error", current: "", nextCheckAt: Date.now() + 60_000 });
            delay = 60_000;
        }
        finally {
            this.running = false;
            this.schedule(delay);
        }
    }
}

const BACKEND_TIMEOUT_MS = 15_000;
const CATALOG_BACKEND_TIMEOUT_MS = 60_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const TILE_STATUS_EVENT = "controller-xbox-tile-status";
const SETTINGS_CHANGED_EVENT = "controller-xbox-settings-changed";
const HISTORY_CHANGED_EVENT = "controller-xbox-history-changed";
const BADGE_KEY = "controller-xbox-tile-badge";
const DETAIL_BADGE_KEY = "controller-xbox-detail-badge";
const DETAIL_PATCH_FLAG = "__controllerXboxDetailPatched";
const STORE_DEBUGGER_URL = "http://localhost:8080/json";
const STORE_SCAN_INTERVAL_MS = 1_500;
const NOTIFICATION_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const getControllerSupport = callable("get_controller_support");
const getGfnAvailability = callable("get_gfn_availability");
const refreshCloudCatalogs = callable("refresh_cloud_catalogs");
const getBoosteroidAvailability = callable("get_boosteroid_availability");
const clearCache = callable("clear_cache");
const getCacheStats = callable("get_cache_stats");
const getBackendDiagnostics = callable("get_backend_diagnostics");
const checkForUpdate = callable("check_for_update");
const getUpdateNotification = callable("get_update_notification");
const acknowledgeUpdateNotification = callable("acknowledge_update_notification");
const applyUpdate = callable("apply_update");
const restartPluginLoader = callable("restart_plugin_loader");
const setBadgeSizes = callable("set_badge_sizes");
const getCuratorProgress = callable("get_hungarian_curator_progress");
const loadCuratorProgress = () => withBackendTimeout(getCuratorProgress());
const getSettings = callable("get_settings");
const setBadgeVisibility = callable("set_badge_visibility");
const setNotificationPreferences = callable("set_notification_preferences");
const getNotificationEvents = callable("get_notification_events");
const getWatchlist = callable("get_watchlist");
const addWatchlistGame = callable("add_watchlist_game");
const removeWatchlistGame = callable("remove_watchlist_game");
const setWatchlistPlatforms = callable("set_watchlist_platforms");
const searchSteamGames = callable("search_steam_games");
const getNotificationHistory = callable("get_notification_history");
const clearNotificationHistory = callable("clear_notification_history");
const markNotificationHistoryRead = callable("mark_notification_history_read");
const supportStates = new Map();
const hungarianStates = new Map();
const hungarianSources = new Map();
let curatorBadgeTimer;
const gfnStates = new Map();
const boosteroidStates = new Map();
const visibleAppIds = new Map();
const supportListeners = new Set();
const pendingAppIds = new Set();
let batchTimer;
let tileMemo = null;
let originalTileType = null;
let tileIconRowClass = "";
let storeWebSocket = null;
let storeMounted = false;
let nativeTilesInStore = false;
let storeWebSocketReady = false;
let storeMessageId = 1;
let storeScanTimer;
let storeReconnectTimer;
let storeCurrentAppIds = new Set();
let notificationTimer;
let notificationCheck;
let cloudViewRevision = 0;
let pluginActive = false;
let settingsLoading = false;
let settingsRetryTimer;
let settingsLoadFailures = 0;
let watchedGames = new Map();
const watchlistListeners = new Set();
const watchlistMutations = new Set();
let badgeVisibility = {
    show_gfn_badges: true,
    show_boosteroid_badges: true,
    show_hungarian_badges: true,
};
let notificationPreferences = {
    notify_gfn_additions: true,
    notify_boosteroid_additions: true,
    notify_boosteroid_maintenance: true,
    notify_plugin_updates: true,
};
const storeRuntimeRequests = new Map();
function withBackendTimeout(request, timeoutMs = BACKEND_TIMEOUT_MS) {
    let timer;
    return Promise.race([
        request,
        new Promise((_, reject) => {
            timer = window.setTimeout(() => reject(new Error("A Decky backend " + String(timeoutMs / 1000) + " másodpercen belül nem válaszolt.")), timeoutMs);
        }),
    ]).finally(() => { if (timer !== undefined)
        window.clearTimeout(timer); });
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.name + ": " + error.message;
    try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== "{}")
            return serialized;
    }
    catch {
        // Fall through to the string representation below.
    }
    return String(error);
}
async function reloadUpdatedPlugin() {
    try {
        await withBackendTimeout(restartPluginLoader(), 5_000);
    }
    catch {
        // A full Steam restart can still reload both plugin halves.
    }
    try {
        const steamSystem = window.SteamClient?.System;
        if (typeof steamSystem?.RestartSteamClient === "function") {
            steamSystem.RestartSteamClient();
            return "restarting";
        }
    }
    catch {
        // Try Decky's hot reload below.
    }
    try {
        const loader = window.DeckyPluginLoader;
        if (typeof loader?.reloadPlugin === "function") {
            for (const pluginName of ["Deck Play Badges", "ControllerXbox"]) {
                try {
                    await loader.reloadPlugin(pluginName);
                    return "reloaded";
                }
                catch {
                    // Try the other name while installations migrate between manifests.
                }
            }
        }
    }
    catch {
        // The UI will provide a manual restart instruction.
    }
    return "failed";
}
function applyBadgeVisibility(next) {
    badgeVisibility = next;
    hungarianCollection.setEnabled(pluginActive && next.show_hungarian_badges);
    if (!next.show_hungarian_badges && curatorBadgeTimer !== undefined) {
        window.clearTimeout(curatorBadgeTimer);
        curatorBadgeTimer = undefined;
    }
    for (const listener of supportListeners)
        listener();
    renderStoreBadges();
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: next }));
}
function applyNotificationPreferences(next) {
    notificationPreferences = next;
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: next }));
}
function applyWatchlistEntries(entries) {
    watchedGames = new Map(entries.map((entry) => [entry.app_id, entry]));
    for (const listener of watchlistListeners)
        listener();
    renderStoreBadges();
}
async function loadWatchlistState() {
    try {
        const response = await withBackendTimeout(getWatchlist(), 120_000);
        if (response.success)
            applyWatchlistEntries(response.entries ?? []);
    }
    catch (error) {
        console.warn("ControllerXbox watchlist could not be loaded", error);
    }
}
async function toggleWatchlistGame(appId) {
    if (watchlistMutations.has(appId))
        return;
    watchlistMutations.add(appId);
    try {
        const current = watchedGames.get(appId);
        const response = current
            ? await withBackendTimeout(removeWatchlistGame(appId), 120_000)
            : await withBackendTimeout(addWatchlistGame(appId, true, true, false), 120_000);
        if (!response.success)
            throw new Error(response.error || "A figyelőlista módosítása sikertelen.");
        applyWatchlistEntries(response.entries ?? []);
        toaster.toast({
            title: current ? "Figyelés kikapcsolva" : "Figyelőlistához adva",
            body: current?.title ?? watchedGames.get(appId)?.title ?? ("Steam AppID " + appId),
        });
    }
    catch (error) {
        toaster.toast({ title: "Figyelőlista hiba", body: errorMessage(error) });
    }
    finally {
        watchlistMutations.delete(appId);
    }
}
async function loadBadgeVisibility() {
    if (!pluginActive || settingsLoading)
        return;
    settingsLoading = true;
    if (settingsRetryTimer !== undefined)
        window.clearTimeout(settingsRetryTimer);
    settingsRetryTimer = undefined;
    try {
        const response = await withBackendTimeout(getSettings());
        if (!pluginActive)
            return;
        if (!response.success)
            throw new Error(response.error || "A beállítások betöltése sikertelen.");
        if (response.success) {
            applyBadgeVisibility({
                show_gfn_badges: response.show_gfn_badges,
                show_boosteroid_badges: response.show_boosteroid_badges,
                show_hungarian_badges: response.show_hungarian_badges ?? true,
                library_badge_percent: response.library_badge_percent ?? 100,
                store_badge_percent: response.store_badge_percent ?? 100,
            });
            applyNotificationPreferences({
                notify_gfn_additions: response.notify_gfn_additions ?? true,
                notify_boosteroid_additions: response.notify_boosteroid_additions ?? true,
                notify_boosteroid_maintenance: response.notify_boosteroid_maintenance ?? true,
                notify_plugin_updates: response.notify_plugin_updates ?? true,
            });
            if (settingsLoadFailures > 0) {
                resetVisibleSupport();
                notifyCacheChanged();
            }
            settingsLoadFailures = 0;
        }
    }
    catch (error) {
        console.warn("ControllerXbox badge settings could not be loaded", error);
        if (pluginActive) {
            settingsLoadFailures++;
            hungarianCollection.settingsUnavailable();
            settingsRetryTimer = window.setTimeout(() => {
                settingsRetryTimer = undefined;
                void loadBadgeVisibility();
            }, Math.min(30_000, settingsLoadFailures * 5000));
        }
    }
    finally {
        settingsLoading = false;
    }
}
function getSteamLibraryApps() {
    try {
        const store = globalThis.collectionStore;
        if (!readyCollectionStore(store))
            return [];
        const collection = store.allAppsCollection;
        const rawApps = collection?.allApps ?? collection?.apps;
        return Array.isArray(rawApps)
            ? rawApps
            : rawApps && typeof rawApps[Symbol.iterator] === "function"
                ? Array.from(rawApps)
                : [];
    }
    catch (error) {
        console.warn("ControllerXbox could not enumerate the Steam library", error);
        return [];
    }
}
function getSteamLibraryAppIds() {
    return Array.from(new Set(getSteamLibraryApps()
        .map((app) => String(app?.appid ?? ""))
        .filter((appId) => /^\d+$/.test(appId) && Number(appId) > 0)));
}
const getHungarianLibraryCache = callable("get_hungarian_library_cache");
function scheduleCuratorBadgeRefresh(status) {
    if (!pluginActive || !badgeVisibility.show_hungarian_badges || status === "cached"
        || !status || curatorBadgeTimer !== undefined)
        return;
    curatorBadgeTimer = window.setTimeout(() => {
        curatorBadgeTimer = undefined;
        void (async () => {
            try {
                const ids = Array.from(new Set([...visibleAppIds.keys(), ...storeCurrentAppIds]));
                if (!ids.length || !pluginActive || !badgeVisibility.show_hungarian_badges)
                    return;
                const response = await withBackendTimeout(getHungarianLibraryCache(ids));
                if (!pluginActive || !badgeVisibility.show_hungarian_badges)
                    return;
                if (response.success) {
                    for (const [id, value] of Object.entries(response.hungarian ?? {}))
                        hungarianStates.set(id, value);
                    for (const [id, source] of Object.entries(response.hungarian_sources ?? {}))
                        hungarianSources.set(id, source);
                    for (const listener of supportListeners)
                        listener();
                    renderStoreBadges();
                }
                scheduleCuratorBadgeRefresh(response.curator_status ?? "unavailable");
            }
            catch {
                scheduleCuratorBadgeRefresh("unavailable");
            }
        })();
    }, status === "loading" ? 5000 : 60_000);
}
const hungarianCollection = new HungarianCollection({
    getStore: () => globalThis.collectionStore,
    getApps: getSteamLibraryApps,
    cached: async (ids) => {
        const hungarian = {};
        const hungarian_sources = {};
        let curator_status;
        let scan_epoch;
        const scan_attempts = {};
        const scan_retry_after = {};
        for (let offset = 0; offset < ids.length; offset += 10000) {
            const result = await withBackendTimeout(getHungarianLibraryCache(ids.slice(offset, offset + 10000)));
            if (!result.success)
                return result;
            Object.assign(hungarian, result.hungarian);
            Object.assign(hungarian_sources, result.hungarian_sources);
            curator_status = result.curator_status;
            scan_epoch = result.scan_epoch;
            Object.assign(scan_attempts, result.scan_attempts);
            Object.assign(scan_retry_after, result.scan_retry_after);
            scheduleCuratorBadgeRefresh(curator_status);
        }
        return { success: true, hungarian, hungarian_sources, curator_status, scan_epoch, scan_attempts, scan_retry_after };
    },
    lookup: ids => withBackendTimeout(getControllerSupport(ids), 60_000),
    onLanguages: (languages, sources) => {
        for (const [id, value] of Object.entries(languages))
            hungarianStates.set(id, value);
        for (const [id, source] of Object.entries(sources))
            hungarianSources.set(id, source);
        for (const listener of supportListeners)
            listener();
        renderStoreBadges();
    },
});
function overviewGameName(overview) {
    const name = [overview?.display_name, overview?.strDisplayName, overview?.name, overview?.sort_as]
        .find((value) => typeof value === "string" && value.trim());
    return typeof name === "string" ? name.trim() : undefined;
}
function getSteamLibraryGameNames() {
    const names = {};
    for (const app of getSteamLibraryApps()) {
        const appId = String(app?.appid ?? "");
        const name = overviewGameName(app);
        if (/^\d+$/.test(appId) && name)
            names[appId] = name;
    }
    return names;
}
function resolveLibraryGameName(appId) {
    const numericAppId = Number(appId);
    const collectionOverview = getSteamLibraryApps().find((app) => Number(app?.appid) === numericAppId);
    const appStoreOverview = globalThis.appStore?.GetAppOverviewByAppID?.(numericAppId);
    const steamOverview = globalThis.SteamClient?.Apps?.GetAppOverviewByAppID?.(numericAppId);
    const name = [collectionOverview, appStoreOverview, steamOverview]
        .map(overviewGameName)
        .find(Boolean);
    return name ?? "Steam AppID " + appId;
}
function formatNotificationGameNames(appIds, count, backendNames) {
    const names = (appIds ?? []).slice(0, 3)
        .map((appId) => backendNames?.[appId] || resolveLibraryGameName(appId));
    if (!names.length)
        return String(count) + " játék";
    const remaining = Math.max(0, count - names.length);
    return names.join(", ") + (remaining ? " és még " + String(remaining) + " játék" : "");
}
function watchlistGfnLabel(state) {
    if (state === "available")
        return "elérhető";
    if (state === "not_available")
        return "nem elérhető";
    return "katalógushiba";
}
function watchlistBoosteroidLabel(state) {
    if (state === "available")
        return "elérhető";
    if (state === "maintenance")
        return "karbantartás alatt";
    if (state === "not_available")
        return "nem elérhető";
    return "katalógushiba";
}
function controllerWatchLabel(entry) {
    const label = { none: "nincs jelzett támogatás", partial: "részleges támogatás", full: "teljes támogatás", unknown: "még nem ellenőrzött" }[entry.controller] ?? "még nem ellenőrzött";
    return label + (entry.controller_checked_at && Date.now() / 1000 - entry.controller_checked_at >= 86400 ? " · korábbi adat" : "");
}
function historyEventLabel(entry) {
    if (entry.platform === "controller")
        return entry.event_type === "full" ? "Teljes kontroller-támogatást kapott" : "Részleges kontroller-támogatást kapott";
    if (entry.platform === "gfn")
        return "Felkerült a GeForce NOW-ra";
    if (entry.event_type === "maintenance")
        return "Boosteroid-karbantartás alá került";
    return "Felkerült a Boosteroidra";
}
function WatchStarButton({ appId }) {
    const appIdText = String(appId);
    const [watched, setWatched] = SP_REACT.useState(() => watchedGames.has(appIdText));
    const [working, setWorking] = SP_REACT.useState(false);
    SP_REACT.useEffect(() => {
        const listener = () => setWatched(watchedGames.has(appIdText));
        watchlistListeners.add(listener);
        listener();
        return () => { watchlistListeners.delete(listener); };
    }, [appIdText]);
    const toggle = async (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        setWorking(true);
        await toggleWatchlistGame(appIdText);
        setWorking(false);
    };
    return SP_JSX.jsx("button", { type: "button", title: watched ? "Eltávolítás a figyelőlistáról" : "Hozzáadás a figyelőlistához", disabled: working, onClick: (event) => void toggle(event), style: {
            width: "30px",
            height: "24px",
            padding: 0,
            border: 0,
            borderRadius: "6px",
            background: watched ? "#d9a400" : "rgba(24, 31, 40, .92)",
            color: watched ? "#111" : "#fff",
            fontSize: "18px",
            lineHeight: "24px",
            boxShadow: "0 1px 5px rgba(0,0,0,.85)",
            cursor: "pointer",
            pointerEvents: "auto",
            opacity: working ? 0.6 : 1,
        }, children: watched ? "★" : "☆" });
}
async function refreshCloudViews() {
    const revision = ++cloudViewRevision;
    const ids = Array.from(new Set([...gfnStates.keys(), ...boosteroidStates.keys(), ...visibleAppIds.keys(), ...storeCurrentAppIds, ...watchedGames.keys()]));
    for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const [gfn, boosteroid] = await Promise.allSettled([
            withBackendTimeout(getGfnAvailability(batch), CATALOG_BACKEND_TIMEOUT_MS),
            withBackendTimeout(getBoosteroidAvailability(batch), CATALOG_BACKEND_TIMEOUT_MS),
        ]);
        const response = boosteroid.status === "fulfilled" ? boosteroid.value : { success: false };
        const gfnResponse = gfn.status === "fulfilled" ? gfn.value : { success: false };
        if (!pluginActive || revision !== cloudViewRevision)
            return;
        for (const id of batch) {
            const gfnValue = gfnResponse.success ? gfnResponse.availability?.[id] : undefined;
            gfnStates.set(id, gfnValue === true ? "available" : gfnValue === false ? "not_available" : "unavailable");
            const value = response.success ? response.availability?.[id] : undefined;
            boosteroidStates.set(id, value === true ? (response.maintenance?.[id] ? "maintenance" : "available")
                : value === false ? "not_available" : "unavailable");
        }
    }
    if (!pluginActive || revision !== cloudViewRevision)
        return;
    publishSupportState();
    notifyCacheChanged();
    await loadWatchlistState();
}
let cloudRefresh;
function refreshCloudData() {
    if (cloudRefresh)
        return cloudRefresh;
    cloudRefresh = (async () => {
        if (notificationCheck)
            await notificationCheck;
        if (!pluginActive)
            return;
        const result = await withBackendTimeout(refreshCloudCatalogs(), 180_000);
        if (!pluginActive)
            return;
        await checkBackgroundNotifications(0, true);
        await refreshCloudViews();
        if (!result.success)
            throw new Error(result.error || "A felhőkatalógus frissítése sikertelen.");
    })().finally(() => { cloudRefresh = undefined; });
    return cloudRefresh;
}
function checkBackgroundNotifications(attempt = 0, refreshControllers = false) {
    if (notificationCheck)
        return notificationCheck;
    if (notificationTimer !== undefined)
        window.clearTimeout(notificationTimer);
    notificationTimer = undefined;
    notificationCheck = runBackgroundNotifications(attempt, refreshControllers).finally(() => { notificationCheck = undefined; });
    return notificationCheck;
}
async function runBackgroundNotifications(attempt = 0, refreshControllers = false) {
    let controllerPending = false;
    const appIds = getSteamLibraryAppIds();
    if (!pluginActive)
        return;
    if (!appIds.length && attempt < 3) {
        notificationTimer = window.setTimeout(() => void checkBackgroundNotifications(attempt + 1, refreshControllers), 10_000);
        return;
    }
    notificationTimer = undefined;
    try {
        const update = await withBackendTimeout(getUpdateNotification(), 30_000);
        if (!update.success)
            throw new Error(update.error || "A frissítésértesítés ellenőrzése sikertelen.");
        if (update.update_version) {
            toaster.toast({
                title: "Deck Play Badges frissítés",
                body: "Új pluginverzió érhető el: v" + update.update_version + ". Nyisd meg a plugint a telepítéshez.",
            });
            const acknowledgement = await withBackendTimeout(acknowledgeUpdateNotification(update.update_version));
            if (!acknowledgement.success) {
                throw new Error(acknowledgement.error || "A frissítésértesítés nyugtázása sikertelen.");
            }
        }
    }
    catch (error) {
        console.warn("Deck Play Badges update notification check failed", error);
    }
    try {
        const response = await withBackendTimeout(getNotificationEvents(appIds, getSteamLibraryGameNames(), refreshControllers), 180_000);
        if (!response.success)
            throw new Error(response.error || "Az értesítési ellenőrzés sikertelen.");
        controllerPending = (response.controller_pending ?? 0) > 0;
        const controllerIds = response.controller_improved_app_ids ?? [];
        if (controllerIds.length)
            toaster.toast({ title: "Javult a kontroller-támogatás",
                body: formatNotificationGameNames(controllerIds, controllerIds.length, response.app_names) + ". Részletek az előzményekben." });
        const gfnAdded = response.gfn_added ?? 0;
        if (gfnAdded > 0) {
            toaster.toast({
                title: "GeForce NOW újdonság",
                body: "Mostantól elérhető a GeForce NOW-on: "
                    + formatNotificationGameNames(response.gfn_added_app_ids, gfnAdded, response.app_names) + ".",
            });
        }
        const boosteroidAdded = response.boosteroid_added ?? 0;
        if (boosteroidAdded > 0) {
            toaster.toast({
                title: "Boosteroid újdonság",
                body: "Mostantól elérhető a Boosteroiden: "
                    + formatNotificationGameNames(response.boosteroid_added_app_ids, boosteroidAdded, response.app_names) + ".",
            });
        }
        const boosteroidMaintenance = response.boosteroid_maintenance ?? 0;
        if (boosteroidMaintenance > 0) {
            toaster.toast({
                title: "Boosteroid karbantartás",
                body: "Karbantartás alá került a Boosteroiden: "
                    + formatNotificationGameNames(response.boosteroid_maintenance_app_ids, boosteroidMaintenance, response.app_names) + ".",
            });
        }
        window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
        await refreshCloudViews();
    }
    catch (error) {
        console.warn("ControllerXbox background notification check failed", error);
    }
    finally {
        if (pluginActive) {
            notificationTimer = window.setTimeout(() => void checkBackgroundNotifications(), controllerPending ? 1000 : NOTIFICATION_CHECK_INTERVAL_MS);
        }
    }
}
function notifyCacheChanged() {
    window.dispatchEvent(new Event(CACHE_CHANGED_EVENT));
}
function notifyTileStatus(message) {
    window.dispatchEvent(new CustomEvent(TILE_STATUS_EVENT, { detail: message }));
}
function publishSupportState() {
    for (const listener of supportListeners)
        listener();
    const visible = Array.from(visibleAppIds.keys());
    const checked = visible.filter((id) => ["full", "partial", "unsupported"].includes(supportStates.get(id) ?? "")).length;
    const full = visible.filter((id) => supportStates.get(id) === "full").length;
    const partial = visible.filter((id) => supportStates.get(id) === "partial").length;
    const unavailable = visible.filter((id) => supportStates.get(id) === "unavailable").length;
    const gfnChecked = visible.filter((id) => ["available", "not_available"].includes(gfnStates.get(id) ?? "")).length;
    const gfnAvailable = visible.filter((id) => gfnStates.get(id) === "available").length;
    const gfnUnavailable = visible.filter((id) => gfnStates.get(id) === "unavailable").length;
    const boosteroidChecked = visible.filter((id) => ["available", "maintenance", "not_available"].includes(boosteroidStates.get(id) ?? "")).length;
    const boosteroidAvailable = visible.filter((id) => boosteroidStates.get(id) === "available").length;
    const boosteroidMaintenance = visible.filter((id) => boosteroidStates.get(id) === "maintenance").length;
    const boosteroidUnavailable = visible.filter((id) => boosteroidStates.get(id) === "unavailable").length;
    notifyTileStatus("Látható játékok ellenőrzése: " + String(checked) + "/" + String(visible.length) +
        ". Teljes támogatás: " + String(full) + ". Részleges támogatás: " + String(partial) +
        (unavailable ? ". Kontrolleradat-hiba: " + String(unavailable) + "." : ".") +
        " GFN: " + String(gfnAvailable) + "/" + String(gfnChecked) +
        (gfnUnavailable ? ". GFN-adathiba: " + String(gfnUnavailable) + "." : ".") +
        " Boosteroid: " + String(boosteroidAvailable) + "/" + String(boosteroidChecked) +
        (boosteroidMaintenance ? ". Karbantartás: " + String(boosteroidMaintenance) + "." : ".") +
        (boosteroidUnavailable ? " Boosteroid-adathiba: " + String(boosteroidUnavailable) + "." : ""));
}
async function flushSupportBatch() {
    const cloudRevision = cloudViewRevision;
    batchTimer = undefined;
    const appIds = Array.from(pendingAppIds);
    pendingAppIds.clear();
    if (!appIds.length)
        return;
    const [supportResult, gfnResult, boosteroidResult] = await Promise.allSettled([
        withBackendTimeout(getControllerSupport(appIds)),
        withBackendTimeout(getGfnAvailability(appIds), CATALOG_BACKEND_TIMEOUT_MS),
        withBackendTimeout(getBoosteroidAvailability(appIds), CATALOG_BACKEND_TIMEOUT_MS),
    ]);
    if (supportResult.status === "fulfilled") {
        const response = supportResult.value;
        scheduleCuratorBadgeRefresh(response.curator_status);
        for (const appId of appIds) {
            const language = response.hungarian?.[appId];
            hungarianStates.set(appId, typeof language === "boolean" ? language : null);
            hungarianSources.set(appId, response.hungarian_sources?.[appId] ?? null);
            const level = response.levels?.[appId];
            const value = response.support?.[appId];
            if (level === "full")
                supportStates.set(appId, "full");
            else if (level === "partial")
                supportStates.set(appId, "partial");
            else if (level === "none")
                supportStates.set(appId, "unsupported");
            else if (value === true)
                supportStates.set(appId, "full");
            else if (value === false)
                supportStates.set(appId, "unsupported");
            else
                supportStates.set(appId, "unavailable");
        }
    }
    else {
        for (const appId of appIds) {
            supportStates.set(appId, "unavailable");
            hungarianStates.set(appId, null);
            hungarianSources.set(appId, null);
        }
        console.warn("ControllerXbox controller lookup failed", supportResult.reason);
    }
    // A request started before a catalog refresh must not restore old cloud badges.
    if (cloudRevision === cloudViewRevision) {
        if (gfnResult.status === "fulfilled" && gfnResult.value.success) {
            const response = gfnResult.value;
            for (const appId of appIds) {
                const value = response.availability?.[appId];
                if (value === true)
                    gfnStates.set(appId, "available");
                else if (value === false)
                    gfnStates.set(appId, "not_available");
                else
                    gfnStates.set(appId, "unavailable");
            }
        }
        else {
            for (const appId of appIds)
                gfnStates.set(appId, "unavailable");
            const error = gfnResult.status === "rejected" ? gfnResult.reason : gfnResult.value.error;
            console.warn("ControllerXbox GeForce NOW lookup failed", error);
        }
        if (boosteroidResult.status === "fulfilled" && boosteroidResult.value.success) {
            const response = boosteroidResult.value;
            for (const appId of appIds) {
                const value = response.availability?.[appId];
                const maintenance = response.maintenance?.[appId];
                if (value === true && maintenance === true)
                    boosteroidStates.set(appId, "maintenance");
                else if (value === true)
                    boosteroidStates.set(appId, "available");
                else if (value === false)
                    boosteroidStates.set(appId, "not_available");
                else
                    boosteroidStates.set(appId, "unavailable");
            }
        }
        else {
            for (const appId of appIds)
                boosteroidStates.set(appId, "unavailable");
            const error = boosteroidResult.status === "rejected" ? boosteroidResult.reason : boosteroidResult.value.error;
            console.warn("ControllerXbox Boosteroid lookup failed", error);
        }
    }
    publishSupportState();
    notifyCacheChanged();
}
function queueSupportLookup(appId) {
    const controllerReady = Boolean(supportStates.get(appId) && supportStates.get(appId) !== "unavailable");
    const gfnReady = Boolean(gfnStates.get(appId) && gfnStates.get(appId) !== "unavailable");
    const boosteroidReady = Boolean(boosteroidStates.get(appId) && boosteroidStates.get(appId) !== "unavailable");
    if (controllerReady && gfnReady && boosteroidReady)
        return;
    if (!controllerReady)
        supportStates.set(appId, "loading");
    if (!gfnReady)
        gfnStates.set(appId, "loading");
    if (!boosteroidReady)
        boosteroidStates.set(appId, "loading");
    pendingAppIds.add(appId);
    if (batchTimer === undefined)
        batchTimer = window.setTimeout(() => void flushSupportBatch(), 120);
}
function resetVisibleSupport() {
    supportStates.clear();
    hungarianStates.clear();
    hungarianSources.clear();
    gfnStates.clear();
    boosteroidStates.clear();
    pendingAppIds.clear();
    for (const appId of visibleAppIds.keys())
        queueSupportLookup(appId);
    publishSupportState();
}
function ControllerIcon({ level, appId }) {
    const halfClipId = "controller-xbox-half-" + String(appId);
    const controllerPath = "M5.4 5.5h13.2c1.5 0 2.8 1 3.2 2.5l1.1 5c.4 1.8-.9 3.5-2.7 3.5-.8 0-1.5-.3-2-.9L15.6 13H8.4l-2.6 2.6c-.5.6-1.2.9-2 .9-1.8 0-3.1-1.7-2.7-3.5l1.1-5c.4-1.5 1.7-2.5 3.2-2.5Z";
    const partial = level === "partial";
    return SP_JSX.jsxs("svg", { width: "24", height: "20", viewBox: "0 0 24 22", "aria-hidden": "true", children: [partial && SP_JSX.jsx("defs", { children: SP_JSX.jsx("clipPath", { id: halfClipId, children: SP_JSX.jsx("rect", { x: "0", y: "0", width: "12", height: "22" }) }) }), SP_JSX.jsx("path", { d: controllerPath, fill: partial ? "none" : "currentColor", stroke: "currentColor", strokeWidth: "1.4" }), partial && SP_JSX.jsx("path", { d: controllerPath, fill: "currentColor", clipPath: "url(#" + halfClipId + ")" }), SP_JSX.jsx("path", { d: "M5.4 9.7h3.2M7 8.1v3.2", fill: "none", stroke: "#107cde", strokeWidth: "1.25", strokeLinecap: "round" }), SP_JSX.jsx("circle", { cx: "17.1", cy: "8.7", r: ".9", fill: partial ? "currentColor" : "#107cde" }), SP_JSX.jsx("circle", { cx: "19.2", cy: "10.7", r: ".9", fill: partial ? "currentColor" : "#107cde" })] });
}
function ControllerBadge({ state, appId }) {
    const appearance = {
        full: {
            symbol: "",
            background: "#107cde",
            title: "Steam: teljes kontroller-támogatás",
        },
        partial: {
            symbol: "",
            background: "#107cde",
            title: "Steam: részleges kontroller-támogatás",
        },
        unsupported: {
            symbol: "×",
            background: "#a52a2a",
            title: "Steam: nincs kontroller-támogatás",
        },
        unavailable: {
            symbol: "?",
            background: "#d97706",
            title: "A Steam kompatibilitási adata nem érhető el",
        },
        loading: {
            symbol: "…",
            background: "#5f6b78",
            title: "A kompatibilitás ellenőrzése folyamatban van",
        },
    };
    const badge = appearance[state];
    const controllerLevel = state === "full" || state === "partial" ? state : null;
    return SP_JSX.jsx("span", { title: badge.title, style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: controllerLevel ? "32px" : "24px",
            height: "24px",
            padding: "0 5px",
            borderRadius: "12px",
            background: badge.background,
            color: "white",
            boxShadow: "0 1px 5px rgba(0,0,0,.85)",
            font: "bold 17px/24px Arial, sans-serif",
            pointerEvents: "none",
        }, children: controllerLevel ? SP_JSX.jsx(ControllerIcon, { level: controllerLevel, appId: appId }) : badge.symbol });
}
function GfnBadge({ state }) {
    const appearance = {
        available: {
            label: "GFN",
            background: "#76b900",
            color: "#ffffff",
            title: "A játék elérhető a GeForce NOW kínálatában",
        },
        not_available: {
            label: "GFN",
            background: "#59616a",
            color: "#d7dce1",
            title: "A játék nem található a GeForce NOW kínálatában",
        },
        unavailable: {
            label: "GFN?",
            background: "#d97706",
            color: "#ffffff",
            title: "A GeForce NOW katalógus nem érhető el",
        },
        loading: {
            label: "GFN…",
            background: "#5f6b78",
            color: "#ffffff",
            title: "A GeForce NOW katalógus ellenőrzése folyamatban van",
        },
    };
    const badge = appearance[state];
    return SP_JSX.jsx("span", { title: badge.title, style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: "34px",
            height: "24px",
            padding: "0 5px",
            borderRadius: "5px",
            background: badge.background,
            color: badge.color,
            boxShadow: "0 1px 5px rgba(0,0,0,.85)",
            font: "italic 900 10px/24px Arial, sans-serif",
            letterSpacing: "-.3px",
            pointerEvents: "none",
        }, children: badge.label });
}
function BoosteroidIcon() {
    return SP_JSX.jsx("svg", { width: "19", height: "19", viewBox: "0 0 31 31", "aria-hidden": "true", children: SP_JSX.jsx("path", { fill: "currentColor", d: "M13.3259 3.30744C9.865 6.72998 9.549 12.1026 12.3773 15.8818L9.46609 18.7608C8.90018 19.3204 8.90018 20.2281 9.46609 20.7883C10.032 21.3479 10.9498 21.3479 11.5163 20.7883L14.4276 17.9093C18.2491 20.7063 23.682 20.3938 27.143 16.9713C30.9524 13.2041 30.9524 7.07459 27.143 3.30801C23.3336-.45857 17.1347-.459144 13.3259 3.30744ZM25.0927 14.9438C22.7653 17.2453 19.1705 17.5469 16.5103 15.8497L17.6595 14.7133C18.2254 14.1536 18.2254 13.246 17.6595 12.6858C17.0936 12.1261 16.1757 12.1261 15.6092 12.6858L14.46 13.8222C12.7438 11.1915 13.0488 7.63651 15.3762 5.33493C18.0549 2.68588 22.414 2.68588 25.0927 5.33493C27.7715 7.98398 27.7715 12.2947 25.0927 14.9438ZM16.2841 21.6272C16.85 22.1868 16.85 23.0945 16.2841 23.6547L10.1416 29.7291C9.57567 30.2887 8.65782 30.2887 8.09134 29.7291C7.52544 29.1695 7.52544 28.2618 8.09134 27.7016L14.2345 21.6272C14.8004 21.0675 15.7182 21.0675 16.2841 21.6272ZM.424426 22.1472C-.141475 21.5876-.141475 20.6799.424426 20.1197L6.56758 14.0447C7.13348 13.4851 8.05133 13.4851 8.61782 14.0447C9.18372 14.6043 9.18372 15.512 8.61782 16.0722L2.47466 22.1472C1.90818 22.7074.990907 22.7074.424426 22.1472Z" }) });
}
function BoosteroidBadge({ state }) {
    const appearance = {
        available: {
            background: "rgba(6,9,18,.9)",
            color: "#00a3ff",
            title: "A játék elérhető a Boosteroid kínálatában",
        },
        maintenance: {
            background: "rgba(6,9,18,.9)",
            color: "#f59e0b",
            title: "A játék elérhető a Boosteroiden, de jelenleg karbantartás alatt áll",
        },
        not_available: {
            background: "rgba(6,9,18,.9)",
            color: "#77808a",
            title: "A játék nem található a Boosteroid kínálatában",
        },
        unavailable: {
            background: "rgba(6,9,18,.9)",
            color: "#f59e0b",
            title: "A Boosteroid katalógus nem érhető el",
        },
        loading: {
            background: "rgba(6,9,18,.9)",
            color: "#5f6b78",
            title: "A Boosteroid katalógus ellenőrzése folyamatban van",
        },
    };
    const badge = appearance[state];
    return SP_JSX.jsx("span", { title: badge.title, style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "34px",
            height: "24px",
            padding: "0 3px",
            borderRadius: "5px",
            background: badge.background,
            color: badge.color,
            boxShadow: "0 1px 5px rgba(0,0,0,.85)",
            pointerEvents: "none",
        }, children: SP_JSX.jsx(BoosteroidIcon, {}) });
}
function XboxTileBadge({ appId }) {
    const appIdText = String(appId);
    const [inStore, setInStore] = SP_REACT.useState(nativeTilesInStore);
    const [visibility, setVisibility] = SP_REACT.useState(badgeVisibility);
    const [hungarian, setHungarian] = SP_REACT.useState(() => hungarianStates.get(appIdText) === true);
    const [hungarianSource, setHungarianSource] = SP_REACT.useState(() => hungarianSources.get(appIdText) ?? null);
    const [state, setState] = SP_REACT.useState(() => supportStates.get(appIdText) ?? "loading");
    const [gfnState, setGfnState] = SP_REACT.useState(() => gfnStates.get(appIdText) ?? "loading");
    const [boosteroidState, setBoosteroidState] = SP_REACT.useState(() => boosteroidStates.get(appIdText) ?? "loading");
    SP_REACT.useEffect(() => {
        visibleAppIds.set(appIdText, (visibleAppIds.get(appIdText) ?? 0) + 1);
        const listener = () => {
            setVisibility(badgeVisibility);
            setInStore(nativeTilesInStore);
            setHungarian(hungarianStates.get(appIdText) === true);
            setHungarianSource(hungarianSources.get(appIdText) ?? null);
            setState(supportStates.get(appIdText) ?? "loading");
            setGfnState(gfnStates.get(appIdText) ?? "loading");
            setBoosteroidState(boosteroidStates.get(appIdText) ?? "loading");
        };
        supportListeners.add(listener);
        queueSupportLookup(appIdText);
        publishSupportState();
        return () => {
            supportListeners.delete(listener);
            const remaining = (visibleAppIds.get(appIdText) ?? 1) - 1;
            if (remaining > 0)
                visibleAppIds.set(appIdText, remaining);
            else
                visibleAppIds.delete(appIdText);
            publishSupportState();
        };
    }, [appIdText]);
    const scale = 0.88 * (inStore ? (visibility.store_badge_percent ?? 100) : (visibility.library_badge_percent ?? 100)) / 100;
    return SP_JSX.jsxs("span", { style: {
            position: "absolute",
            top: "6px",
            left: "6px",
            // Compensate for the visual scale so wrapping follows the tile's real width.
            width: `calc((100% - 12px) / ${scale})`,
            zIndex: 100,
            display: "inline-flex",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "center",
            gap: "3px",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            pointerEvents: "none",
        }, children: [SP_JSX.jsx(ControllerBadge, { state: state, appId: appId }), visibility.show_gfn_badges ? SP_JSX.jsx(GfnBadge, { state: gfnState }) : null, visibility.show_boosteroid_badges ? SP_JSX.jsx(BoosteroidBadge, { state: boosteroidState }) : null, visibility.show_hungarian_badges && hungarian ? SP_JSX.jsx("span", { style: { display: "inline-flex" }, dangerouslySetInnerHTML: { __html: getHungarianBadgeHtml(hungarianSource) } }) : null] });
}
function LibraryDetailBadges({ appId }) {
    const appIdText = String(appId);
    const [visibility, setVisibility] = SP_REACT.useState(badgeVisibility);
    const [hungarian, setHungarian] = SP_REACT.useState(() => hungarianStates.get(appIdText) === true);
    const [hungarianSource, setHungarianSource] = SP_REACT.useState(() => hungarianSources.get(appIdText) ?? null);
    const [state, setState] = SP_REACT.useState(() => supportStates.get(appIdText) ?? "loading");
    const [gfnState, setGfnState] = SP_REACT.useState(() => gfnStates.get(appIdText) ?? "loading");
    const [boosteroidState, setBoosteroidState] = SP_REACT.useState(() => boosteroidStates.get(appIdText) ?? "loading");
    const [position, setPosition] = SP_REACT.useState({ top: 60, right: 20 });
    const [hidden, setHidden] = SP_REACT.useState(false);
    const ref = SP_REACT.useRef(null);
    SP_REACT.useEffect(() => {
        visibleAppIds.set(appIdText, (visibleAppIds.get(appIdText) ?? 0) + 1);
        const listener = () => {
            setVisibility(badgeVisibility);
            setHungarian(hungarianStates.get(appIdText) === true);
            setHungarianSource(hungarianSources.get(appIdText) ?? null);
            setState(supportStates.get(appIdText) ?? "loading");
            setGfnState(gfnStates.get(appIdText) ?? "loading");
            setBoosteroidState(boosteroidStates.get(appIdText) ?? "loading");
        };
        supportListeners.add(listener);
        queueSupportLookup(appIdText);
        publishSupportState();
        return () => {
            supportListeners.delete(listener);
            const remaining = (visibleAppIds.get(appIdText) ?? 1) - 1;
            if (remaining > 0)
                visibleAppIds.set(appIdText, remaining);
            else
                visibleAppIds.delete(appIdText);
            publishSupportState();
        };
    }, [appIdText]);
    SP_REACT.useLayoutEffect(() => {
        const element = ref.current;
        const parent = element?.parentElement;
        const documentRef = element?.ownerDocument;
        if (!element || !parent || !documentRef)
            return;
        const measure = () => {
            const duplicates = Array.from(documentRef.querySelectorAll("[data-controller-xbox-detail-badge]"));
            duplicates.sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
            });
            setHidden(duplicates.length > 1 && duplicates[0] !== element);
            const protonMarker = parent.querySelector(".protondb-decky-indicator-container, [data-pp-game-badge]");
            const protonBadge = protonMarker?.hasAttribute("data-pp-game-badge")
                ? protonMarker.parentElement
                : protonMarker;
            if (!protonBadge || protonBadge === element) {
                setPosition((current) => current.top === 60 && current.right === 20 ? current : { top: 60, right: 20 });
                return;
            }
            const inlineTop = Number.parseFloat(protonBadge.style.top);
            const inlineRight = Number.parseFloat(protonBadge.style.right);
            const width = protonBadge.getBoundingClientRect().width;
            const protonIsExplicitlyRightAligned = Number.isFinite(inlineRight);
            const next = {
                top: Number.isFinite(inlineTop) ? inlineTop : 60,
                right: protonIsExplicitlyRightAligned ? inlineRight + width + 8 : 20,
            };
            setPosition((current) => current.top === next.top && current.right === next.right ? current : next);
        };
        measure();
        const mutationObserver = new MutationObserver(measure);
        mutationObserver.observe(parent, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style"],
        });
        const resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(parent);
        for (const child of Array.from(parent.children))
            resizeObserver.observe(child);
        return () => {
            mutationObserver.disconnect();
            resizeObserver.disconnect();
        };
    }, [appId]);
    if (hidden)
        return null;
    return SP_JSX.jsxs("span", { ref: ref, "data-controller-xbox-detail-badge": "true", style: {
            position: "absolute",
            top: String(position.top) + "px",
            right: String(position.right) + "px",
            zIndex: 50,
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            transform: `scale(${0.95 * (visibility.library_badge_percent ?? 100) / 100})`,
            maxWidth: `calc((100% - ${position.right + 20}px) / ${0.95 * (visibility.library_badge_percent ?? 100) / 100})`,
            flexWrap: "wrap",
            justifyContent: "center",
            transformOrigin: "top right",
            pointerEvents: "auto",
        }, children: [SP_JSX.jsx(ControllerBadge, { state: state, appId: appId }), visibility.show_gfn_badges ? SP_JSX.jsx(GfnBadge, { state: gfnState }) : null, visibility.show_boosteroid_badges ? SP_JSX.jsx(BoosteroidBadge, { state: boosteroidState }) : null, visibility.show_hungarian_badges && hungarian ? SP_JSX.jsx("span", { style: { display: "inline-flex" }, dangerouslySetInnerHTML: { __html: getHungarianBadgeHtml(hungarianSource) } }) : null, SP_JSX.jsx(WatchStarButton, { appId: appId })] });
}
function patchLibraryDetails() {
    const renderPatches = new Set();
    const routePatch = routerHook.addPatch("/library/app/:appid", (tree) => {
        const routeProps = DFL.findInReactTree(tree, (node) => typeof node?.renderFunc === "function");
        if (!routeProps || routeProps[DETAIL_PATCH_FLAG])
            return tree;
        routeProps[DETAIL_PATCH_FLAG] = true;
        const patchHandler = DFL.createReactTreePatcher([
            (renderTree) => DFL.findInReactTree(renderTree, (node) => node?.props?.children?.props?.overview)?.props?.children,
        ], (_args, result) => {
            try {
                const match = window.location.pathname.match(/\/library\/app\/(\d+)/);
                const appId = Number(match?.[1] ?? 0);
                if (!Number.isInteger(appId) || appId <= 0)
                    return result;
                const innerClass = DFL.appDetailsClasses?.InnerContainer;
                if (!innerClass)
                    return result;
                const container = DFL.findInReactTree(result, (node) => Array.isArray(node?.props?.children) &&
                    typeof node?.props?.className === "string" &&
                    node.props.className.includes(innerClass));
                const children = container?.props?.children;
                if (!Array.isArray(children))
                    return result;
                if (children.some((child) => child?.key === DETAIL_BADGE_KEY))
                    return result;
                children.splice(1, 0, SP_REACT.createElement(LibraryDetailBadges, { key: DETAIL_BADGE_KEY, appId }));
            }
            catch (error) {
                console.debug("ControllerXbox library detail badge injection skipped", error);
            }
            return result;
        }, "ControllerXboxLibraryDetails");
        renderPatches.add(DFL.afterPatch(routeProps, "renderFunc", patchHandler));
        return tree;
    });
    return () => {
        try {
            routerHook.removePatch("/library/app/:appid", routePatch);
        }
        catch { /* The router may already be disposed. */ }
        for (const patch of renderPatches) {
            try {
                patch.unpatch();
            }
            catch { /* The route instance may already be gone. */ }
        }
        renderPatches.clear();
    };
}
function buildStoreScanScript() {
    return `
    (function() {
      const ids = new Set();
      const pageMatch = location.pathname.match(/\\/app\\/(\\d+)/);
      if (pageMatch) ids.add(pageMatch[1]);
      const nodes = document.querySelectorAll('[data-ds-appid], a[href*="/app/"]');
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom < -200 || rect.top > innerHeight + 200 || rect.right < -200 || rect.left > innerWidth + 200) continue;
        const raw = node.getAttribute('data-ds-appid') || node.closest('[data-ds-appid]')?.getAttribute('data-ds-appid') || '';
        const href = node.getAttribute('href') || node.closest('a[href*="/app/"]')?.getAttribute('href') || '';
        const match = raw.match(/\\d+/) || href.match(/\\/app\\/(\\d+)/);
        const id = match ? (match[1] || match[0]) : '';
        if (id && Number(id) > 0) ids.add(id);
        if (ids.size >= 80) break;
      }
      const watchActions = Array.isArray(window.__controllerXboxWatchActions)
        ? window.__controllerXboxWatchActions.splice(0, 20).map(String)
        : [];
      return { url: location.href, appIds: Array.from(ids), watchActions };
    })();
  `;
}
function buildStoreBadgeScript(states, visibility, watchedAppIds) {
    const scale = Math.max(50, Math.min(200, visibility.store_badge_percent ?? 100)) / 100;
    const serializedStates = JSON.stringify(states).replace(/</g, "\\u003c");
    const serializedWatchedAppIds = JSON.stringify(Array.from(watchedAppIds)).replace(/</g, "\\u003c");
    const controllerPath = "M5.4 5.5h13.2c1.5 0 2.8 1 3.2 2.5l1.1 5c.4 1.8-.9 3.5-2.7 3.5-.8 0-1.5-.3-2-.9L15.6 13H8.4l-2.6 2.6c-.5.6-1.2.9-2 .9-1.8 0-3.1-1.7-2.7-3.5l1.1-5c.4-1.5 1.7-2.5 3.2-2.5Z";
    const boosteroidPath = "M13.3259 3.30744C9.865 6.72998 9.549 12.1026 12.3773 15.8818L9.46609 18.7608C8.90018 19.3204 8.90018 20.2281 9.46609 20.7883C10.032 21.3479 10.9498 21.3479 11.5163 20.7883L14.4276 17.9093C18.2491 20.7063 23.682 20.3938 27.143 16.9713C30.9524 13.2041 30.9524 7.07459 27.143 3.30801C23.3336-.45857 17.1347-.459144 13.3259 3.30744ZM25.0927 14.9438C22.7653 17.2453 19.1705 17.5469 16.5103 15.8497L17.6595 14.7133C18.2254 14.1536 18.2254 13.246 17.6595 12.6858C17.0936 12.1261 16.1757 12.1261 15.6092 12.6858L14.46 13.8222C12.7438 11.1915 13.0488 7.63651 15.3762 5.33493C18.0549 2.68588 22.414 2.68588 25.0927 5.33493C27.7715 7.98398 27.7715 12.2947 25.0927 14.9438ZM16.2841 21.6272C16.85 22.1868 16.85 23.0945 16.2841 23.6547L10.1416 29.7291C9.57567 30.2887 8.65782 30.2887 8.09134 29.7291C7.52544 29.1695 7.52544 28.2618 8.09134 27.7016L14.2345 21.6272C14.8004 21.0675 15.7182 21.0675 16.2841 21.6272ZM.424426 22.1472C-.141475 21.5876-.141475 20.6799.424426 20.1197L6.56758 14.0447C7.13348 13.4851 8.05133 13.4851 8.61782 14.0447C9.18372 14.6043 9.18372 15.512 8.61782 16.0722L2.47466 22.1472C1.90818 22.7074.990907 22.7074.424426 22.1472Z";
    return `
    (function() {
      const states = ${serializedStates};
      const watchedAppIds = new Set(${serializedWatchedAppIds});
      const showGfn = ${visibility.show_gfn_badges ? "true" : "false"};
      const showBoosteroid = ${visibility.show_boosteroid_badges ? "true" : "false"};
      const showHungarian = ${visibility.show_hungarian_badges ? "true" : "false"};
      const hungarianBadge = ${JSON.stringify(getHungarianBadgeHtml("steam"))};
      const curatorBadge = ${JSON.stringify(getHungarianBadgeHtml("curator"))};
      const controllerPath = ${JSON.stringify(controllerPath)};
      const boosteroidPath = ${JSON.stringify(boosteroidPath)};
      const detailId = 'controller-xbox-store-detail-badges';
      const cardClass = 'controller-xbox-store-card-badges';

      function controllerBadge(state, appId, suffix) {
        const titles = {
          full: 'Steam: teljes kontroller-támogatás',
          partial: 'Steam: részleges kontroller-támogatás',
          unsupported: 'Steam: nincs kontroller-támogatás',
          unavailable: 'A Steam kompatibilitási adata nem érhető el',
          loading: 'A kompatibilitás ellenőrzése folyamatban van'
        };
        if (state !== 'full' && state !== 'partial') {
          const symbol = state === 'unsupported' ? '×' : state === 'unavailable' ? '?' : '…';
          const background = state === 'unsupported' ? '#a52a2a' : state === 'unavailable' ? '#d97706' : '#5f6b78';
          return '<span class="cxc-controller cxc-symbol" title="' + titles[state] + '" style="background:' + background + '">' + symbol + '</span>';
        }
        const gradientId = 'cxc-half-' + appId + '-' + suffix;
        const fill = state === 'full' ? 'white' : 'url(#' + gradientId + ')';
        const defs = state === 'partial' ? '<defs><linearGradient id="' + gradientId + '" x1="0" x2="1"><stop offset="50%" stop-color="white"/><stop offset="50%" stop-color="transparent"/></linearGradient></defs>' : '';
        return '<span class="cxc-controller" title="' + titles[state] + '"><svg width="24" height="20" viewBox="0 0 24 22" aria-hidden="true">' + defs + '<path d="' + controllerPath + '" fill="' + fill + '" stroke="white" stroke-width="1.4"/><path d="M5.4 9.7h3.2M7 8.1v3.2" fill="none" stroke="#107cde" stroke-width="1.25" stroke-linecap="round"/><circle cx="17.1" cy="8.7" r=".9" fill="#107cde"/><circle cx="19.2" cy="10.7" r=".9" fill="#107cde"/></svg></span>';
      }

      function gfnBadge(state) {
        const data = {
          available: ['GFN', '#76b900', '#fff', 'A játék elérhető a GeForce NOW kínálatában'],
          not_available: ['GFN', '#59616a', '#d7dce1', 'A játék nem található a GeForce NOW kínálatában'],
          unavailable: ['GFN?', '#d97706', '#fff', 'A GeForce NOW katalógus nem érhető el'],
          loading: ['GFN…', '#5f6b78', '#fff', 'A GeForce NOW katalógus ellenőrzése folyamatban van']
        }[state];
        return '<span class="cxc-gfn" title="' + data[3] + '" style="background:' + data[1] + ';color:' + data[2] + '">' + data[0] + '</span>';
      }

      function boosteroidBadge(state) {
        const data = {
          available: ['#00a3ff', 'A játék elérhető a Boosteroid kínálatában'],
          maintenance: ['#f59e0b', 'A játék elérhető a Boosteroiden, de jelenleg karbantartás alatt áll'],
          not_available: ['#77808a', 'A játék nem található a Boosteroid kínálatában'],
          unavailable: ['#f59e0b', 'A Boosteroid katalógus nem érhető el'],
          loading: ['#5f6b78', 'A Boosteroid katalógus ellenőrzése folyamatban van']
        }[state];
        return '<span class="cxc-boosteroid" title="' + data[1] + '" style="color:' + data[0] + '"><svg width="19" height="19" viewBox="0 0 31 31" aria-hidden="true"><path fill="currentColor" d="' + boosteroidPath + '"/></svg></span>';
      }

      function badgesHtml(appId, suffix) {
        const state = states[appId];
        if (!state) return '';
        return controllerBadge(state.controller, appId, suffix) +
          (showGfn ? gfnBadge(state.gfn) : '') +
          (showBoosteroid ? boosteroidBadge(state.boosteroid) : '') +
          (showHungarian && state.hungarian === true ? (state.hungarianSource === 'curator' ? curatorBadge : hungarianBadge) : '');
      }

      let style = document.getElementById('controller-xbox-store-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'controller-xbox-store-style';
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = '.cxc-store-badges{display:flex;align-items:center;gap:3px;pointer-events:none}.cxc-store-detail{position:fixed;right:20px;bottom:20px;z-index:999999;max-width:calc((100vw - 40px) / ${.95 * scale});flex-wrap:wrap;justify-content:center;transform:scale(${.95 * scale});transform-origin:bottom right}.cxc-store-card-badges{position:absolute;left:4px;top:4px;width:calc((100% - 8px) / ${.72 * scale});flex-wrap:wrap;justify-content:center;z-index:9999;transform:scale(${.72 * scale});transform-origin:top left}.cxc-store-card-badges>span{flex-shrink:0}.cxc-controller,.cxc-gfn,.cxc-boosteroid{box-sizing:border-box;height:24px;display:inline-flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 1px 5px rgba(0,0,0,.85);pointer-events:none}.cxc-controller{min-width:34px;padding:0 5px;border-radius:12px;background:#107cde}.cxc-symbol{min-width:24px;font:bold 17px/24px Arial,sans-serif}.cxc-gfn{min-width:34px;padding:0 5px;border-radius:5px;font:italic 900 10px/24px Arial,sans-serif;letter-spacing:-.3px}.cxc-boosteroid{width:34px;padding:0 3px;border-radius:5px;background:rgba(6,9,18,.9)}.cxc-watch{width:30px;height:24px;padding:0;border:0;border-radius:6px;background:rgba(24,31,40,.92);color:#fff;font:bold 18px/24px Arial,sans-serif;box-shadow:0 1px 5px rgba(0,0,0,.85);pointer-events:auto;cursor:pointer}.cxc-watch.is-watched{background:#d9a400;color:#111}';

      const pageMatch = location.pathname.match(/\\/app\\/(\\d+)/);
      const pageId = pageMatch ? pageMatch[1] : '';
      let detail = document.getElementById(detailId);
      if (pageId && states[pageId]) {
        if (!detail) {
          detail = document.createElement('div');
          detail.id = detailId;
          detail.className = 'cxc-store-badges cxc-store-detail';
          document.body.appendChild(detail);
        }
        const isWatched = watchedAppIds.has(pageId);
        const key = pageId + ':' + states[pageId].controller + ':' + states[pageId].gfn + ':' + states[pageId].boosteroid + ':' + states[pageId].hungarian + ':' + states[pageId].hungarianSource + ':' + showHungarian + ':' + showGfn + ':' + showBoosteroid + ':' + isWatched;
        if (detail.getAttribute('data-state-key') !== key) {
          detail.innerHTML = badgesHtml(pageId, 'detail');
          const watchButton = document.createElement('button');
          watchButton.type = 'button';
          watchButton.className = 'cxc-watch' + (isWatched ? ' is-watched' : '');
          watchButton.textContent = isWatched ? '★' : '☆';
          watchButton.title = isWatched ? 'Eltávolítás a figyelőlistáról' : 'Hozzáadás a figyelőlistához';
          watchButton.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            window.__controllerXboxWatchActions = window.__controllerXboxWatchActions || [];
            window.__controllerXboxWatchActions.push(pageId);
          });
          detail.appendChild(watchButton);
          detail.setAttribute('data-state-key', key);
        }
      } else if (detail) {
        detail.remove();
      }

      const candidates = document.querySelectorAll('[data-ds-appid], a[href*="/app/"]');
      const usedHosts = new Set();
      for (const node of candidates) {
        const raw = node.getAttribute('data-ds-appid') || node.closest('[data-ds-appid]')?.getAttribute('data-ds-appid') || '';
        const link = node.matches('a[href*="/app/"]') ? node : node.closest('a[href*="/app/"]');
        const href = link?.getAttribute('href') || '';
        const match = raw.match(/\\d+/) || href.match(/\\/app\\/(\\d+)/);
        const appId = match ? (match[1] || match[0]) : '';
        if (!appId || !states[appId]) continue;
        const host = link || node;
        if (usedHosts.has(host) || host.closest('#global_header, #store_header')) continue;
        const rect = host.getBoundingClientRect();
        if (rect.width < 90 || rect.height < 60 || rect.width > 700 || rect.height > 900) continue;
        if (rect.bottom < -200 || rect.top > innerHeight + 200 || rect.right < -200 || rect.left > innerWidth + 200) continue;
        if (pageId === appId && rect.width > 480) continue;
        usedHosts.add(host);
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        let badge = Array.from(host.children).find(function(child) { return child.classList?.contains(cardClass); });
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'cxc-store-badges cxc-store-card-badges ' + cardClass;
          host.appendChild(badge);
        }
        const key = appId + ':' + states[appId].controller + ':' + states[appId].gfn + ':' + states[appId].boosteroid + ':' + states[appId].hungarian + ':' + states[appId].hungarianSource + ':' + showHungarian + ':' + showGfn + ':' + showBoosteroid;
        badge.setAttribute('data-cxc-appid', appId);
        if (badge.getAttribute('data-state-key') !== key) {
          badge.innerHTML = badgesHtml(appId, 'card-' + usedHosts.size);
          badge.setAttribute('data-state-key', key);
        }
      }

      for (const badge of document.querySelectorAll('.' + cardClass)) {
        const id = badge.getAttribute('data-cxc-appid');
        if (!id || !states[id]) badge.remove();
      }
    })();
  `;
}
function sendStoreRuntime(expression, returnByValue = false) {
    const socket = storeWebSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !storeWebSocketReady) {
        return Promise.reject(new Error("A Steam Store böngészőkapcsolata nem aktív."));
    }
    const id = storeMessageId++;
    socket.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue, awaitPromise: true },
    }));
    if (!returnByValue)
        return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            storeRuntimeRequests.delete(id);
            reject(new Error("A Steam Store oldal nem válaszolt."));
        }, 5_000);
        storeRuntimeRequests.set(id, { resolve, reject, timeout });
    });
}
function renderStoreBadges() {
    if (!storeWebSocketReady || !storeCurrentAppIds.size)
        return;
    const states = {};
    for (const appId of storeCurrentAppIds) {
        states[appId] = {
            controller: supportStates.get(appId) ?? "loading",
            gfn: gfnStates.get(appId) ?? "loading",
            boosteroid: boosteroidStates.get(appId) ?? "loading",
            hungarian: hungarianStates.get(appId) === true,
            hungarianSource: hungarianSources.get(appId) ?? null,
        };
    }
    void sendStoreRuntime(buildStoreBadgeScript(states, badgeVisibility, new Set(watchedGames.keys()))).catch((error) => {
        console.debug("ControllerXbox store badge rendering skipped", error);
    });
}
function scheduleStoreScan(delay = STORE_SCAN_INTERVAL_MS) {
    if (storeScanTimer !== undefined)
        window.clearTimeout(storeScanTimer);
    if (!storeMounted)
        return;
    storeScanTimer = window.setTimeout(() => void scanStorePage(), delay);
}
async function scanStorePage() {
    storeScanTimer = undefined;
    if (!storeMounted || !storeWebSocketReady)
        return;
    try {
        const result = await sendStoreRuntime(buildStoreScanScript(), true);
        updatePriceView(result?.url ?? "", sendStoreRuntime);
        const nextIds = new Set((Array.isArray(result?.appIds) ? result.appIds : [])
            .map((value) => String(value))
            .filter((value) => /^\d+$/.test(value) && Number(value) > 0));
        storeCurrentAppIds = nextIds;
        const watchActions = (Array.isArray(result?.watchActions) ? result.watchActions : [])
            .map((value) => String(value))
            .filter((value) => /^\d+$/.test(value) && Number(value) > 0);
        for (const appId of watchActions)
            void toggleWatchlistGame(appId);
        for (const appId of nextIds)
            queueSupportLookup(appId);
        renderStoreBadges();
    }
    catch (error) {
        console.debug("ControllerXbox store scan skipped", error);
    }
    finally {
        scheduleStoreScan();
    }
}
function clearStoreRuntimeRequests(reason) {
    for (const request of storeRuntimeRequests.values()) {
        window.clearTimeout(request.timeout);
        request.reject(new Error(reason));
    }
    storeRuntimeRequests.clear();
}
function scheduleStoreReconnect(delay = 1_000) {
    if (storeReconnectTimer !== undefined)
        window.clearTimeout(storeReconnectTimer);
    if (!storeMounted)
        return;
    storeReconnectTimer = window.setTimeout(() => {
        storeReconnectTimer = undefined;
        void connectToStoreDebugger();
    }, delay);
}
async function connectToStoreDebugger() {
    if (!storeMounted || storeWebSocket)
        return;
    try {
        const response = await fetchNoCors(STORE_DEBUGGER_URL);
        const tabs = await response.json();
        const tab = Array.isArray(tabs) ? tabs.find((candidate) => candidate.url?.includes("store.steampowered.com")) : undefined;
        if (!tab?.webSocketDebuggerUrl) {
            scheduleStoreReconnect();
            return;
        }
        const socket = new WebSocket(tab.webSocketDebuggerUrl);
        storeWebSocket = socket;
        socket.onopen = () => {
            socket.send(JSON.stringify({ id: storeMessageId++, method: "Page.enable" }));
            socket.send(JSON.stringify({ id: storeMessageId++, method: "Runtime.enable" }));
            window.setTimeout(() => {
                if (storeWebSocket !== socket || !storeMounted)
                    return;
                storeWebSocketReady = true;
                scheduleStoreScan(0);
            }, 300);
        };
        socket.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                return;
            }
            if (typeof message.id === "number") {
                const request = storeRuntimeRequests.get(message.id);
                if (request) {
                    storeRuntimeRequests.delete(message.id);
                    window.clearTimeout(request.timeout);
                    if (message.error)
                        request.reject(message.error);
                    else
                        request.resolve(message.result?.result?.value);
                }
            }
            if (message.method === "Page.frameNavigated" && message.params?.frame?.url?.includes("store.steampowered.com")) {
                scheduleStoreScan(500);
            }
        };
        socket.onerror = () => {
            if (storeWebSocket === socket)
                console.debug("ControllerXbox store debugger connection error");
        };
        socket.onclose = () => {
            if (storeWebSocket === socket)
                storeWebSocket = null;
            storeWebSocketReady = false;
            clearStoreRuntimeRequests("A Steam Store böngészőkapcsolata megszakadt.");
            scheduleStoreReconnect();
        };
    }
    catch (error) {
        console.debug("ControllerXbox store debugger discovery failed", error);
        scheduleStoreReconnect();
    }
}
function disconnectStoreDebugger() {
    resetPriceView();
    if (storeScanTimer !== undefined)
        window.clearTimeout(storeScanTimer);
    if (storeReconnectTimer !== undefined)
        window.clearTimeout(storeReconnectTimer);
    storeScanTimer = undefined;
    storeReconnectTimer = undefined;
    if (storeWebSocketReady) {
        void sendStoreRuntime(`
      (function() {
        document.getElementById('controller-xbox-store-detail-badges')?.remove();
        document.getElementById('deck-play-badges-price')?.remove();
        document.querySelectorAll('.controller-xbox-store-card-badges').forEach(function(node) { node.remove(); });
        document.getElementById('controller-xbox-store-style')?.remove();
        delete window.__controllerXboxWatchActions;
      })();
    `).catch(() => { });
    }
    const socket = storeWebSocket;
    storeWebSocket = null;
    storeWebSocketReady = false;
    storeCurrentAppIds.clear();
    clearStoreRuntimeRequests("A Steam Store nézet bezárult.");
    try {
        socket?.close();
    }
    catch { /* The browser tab may already be gone. */ }
}
function patchSteamStore() {
    const storeListener = () => renderStoreBadges();
    supportListeners.add(storeListener);
    let unlisten;
    try {
        const historyModule = DFL.findModuleExport((value) => value?.m_history !== undefined);
        const history = historyModule?.m_history;
        const handleLocation = (pathname) => {
            const nextNativeStore = /^\/(store|steamweb)(\/|$)/.test(pathname);
            if (nextNativeStore !== nativeTilesInStore) {
                nativeTilesInStore = nextNativeStore;
                for (const listener of supportListeners)
                    listener();
            }
            const inStore = pathname === "/steamweb" || pathname.startsWith("/steamweb/");
            if (inStore && !storeMounted) {
                storeMounted = true;
                void connectToStoreDebugger();
            }
            else if (!inStore && storeMounted) {
                storeMounted = false;
                disconnectStoreDebugger();
            }
        };
        handleLocation(String(history?.location?.pathname ?? window.location.pathname ?? ""));
        if (typeof history?.listen === "function") {
            unlisten = history.listen((info) => {
                handleLocation(String(info?.pathname ?? info?.location?.pathname ?? ""));
            });
        }
    }
    catch (error) {
        console.warn("ControllerXbox Steam Store patch failed", error);
    }
    return () => {
        supportListeners.delete(storeListener);
        try {
            unlisten?.();
        }
        catch { /* Steam may already have disposed its history. */ }
        storeMounted = false;
        disconnectStoreDebugger();
    };
}
function appendBadgeToTile(result, appId) {
    const row = DFL.findInReactTree(result, (node) => {
        const className = node?.props?.className;
        return typeof className === "string" && className.includes(tileIconRowClass);
    });
    const props = row?.props;
    if (!props)
        return result;
    const existing = Array.isArray(props.children) ? props.children : [props.children];
    if (existing.some((child) => child?.key === BADGE_KEY))
        return result;
    const badge = SP_REACT.createElement(XboxTileBadge, { key: BADGE_KEY, appId });
    if (Array.isArray(props.children))
        props.children.push(badge);
    else if (props.children !== undefined && props.children !== null)
        props.children = [props.children, badge];
    else
        props.children = [badge];
    return result;
}
function resolveOriginalTileType(self) {
    const candidates = [
        wrappedTileType.__controllerXboxMemo?.__controllerXboxOriginalType,
        self?.__controllerXboxOriginalType,
        originalTileType,
        tileMemo?.__controllerXboxOriginalType,
    ];
    return candidates.find((candidate) => typeof candidate === "function" && candidate !== wrappedTileType) ?? null;
}
function wrappedTileType(...args) {
    const original = resolveOriginalTileType(this);
    if (!original)
        return SP_REACT.createElement("div");
    const result = original.apply(this, args);
    try {
        const app = args[0]?.app;
        if (!app || !Number.isInteger(app.appid) || app.appid <= 0 || app.BIsModOrShortcut?.())
            return result;
        return appendBadgeToTile(result, app.appid);
    }
    catch (error) {
        console.debug("ControllerXbox tile injection skipped", error);
        return result;
    }
}
function getWebpackRequire() {
    const chunk = window.webpackChunksteamui;
    if (!Array.isArray(chunk))
        return null;
    let webpackRequire;
    try {
        chunk.push([["controller_xbox_" + String(Date.now())], {}, (value) => { webpackRequire = value; }]);
    }
    catch {
        return null;
    }
    return webpackRequire?.m ? webpackRequire : null;
}
function findTileMemo(webpackRequire) {
    const reactMemo = Symbol.for("react.memo");
    for (const id of Object.keys(webpackRequire.m)) {
        let source = "";
        try {
            source = String(webpackRequire.m[id]);
        }
        catch {
            continue;
        }
        if (!source.includes("LibraryItemIcons") || !source.includes("BIsModOrShortcut") || !source.includes("BIsMusicAlbum"))
            continue;
        let moduleValue;
        try {
            moduleValue = webpackRequire(id);
        }
        catch {
            continue;
        }
        if ((typeof moduleValue !== "object" || moduleValue === null) && typeof moduleValue !== "function")
            continue;
        let exportKeys;
        try {
            exportKeys = Object.keys(moduleValue);
        }
        catch {
            continue;
        }
        for (const key of exportKeys) {
            let value;
            try {
                value = moduleValue[key];
            }
            catch {
                continue;
            }
            const memo = value;
            if (memo?.$$typeof === reactMemo && typeof memo.type === "function")
                return memo;
        }
    }
    return null;
}
function resolveTileIconRowClass(webpackRequire) {
    for (const id of Object.keys(webpackRequire.m)) {
        let source = "";
        try {
            source = String(webpackRequire.m[id]);
        }
        catch {
            continue;
        }
        if (!source.includes("LibraryItemIcons"))
            continue;
        let moduleValue;
        try {
            moduleValue = webpackRequire(id);
        }
        catch {
            continue;
        }
        if ((typeof moduleValue !== "object" || moduleValue === null) && typeof moduleValue !== "function")
            continue;
        let defaultExport;
        try {
            defaultExport = moduleValue.default;
        }
        catch {
            defaultExport = undefined;
        }
        for (const candidate of [moduleValue, defaultExport]) {
            if (!candidate || typeof candidate !== "object")
                continue;
            let libraryItemIcons;
            try {
                libraryItemIcons = candidate.LibraryItemIcons;
            }
            catch {
                continue;
            }
            if (typeof libraryItemIcons === "string")
                return libraryItemIcons;
        }
    }
    return "";
}
function patchLibraryTiles() {
    try {
        const webpackRequire = getWebpackRequire();
        const memo = webpackRequire ? findTileMemo(webpackRequire) : null;
        tileIconRowClass = webpackRequire ? resolveTileIconRowClass(webpackRequire) : "";
        if (!memo || !tileIconRowClass) {
            notifyTileStatus("A Steam könyvtári csempekomponens nem található; a jelölés nem aktív.");
            console.warn("ControllerXbox library tile component was not found");
            return () => { };
        }
        tileMemo = memo;
        const current = memo.type;
        originalTileType = memo.__controllerXboxOriginalType ?? (current.__controllerXboxWrapper ? null : current);
        if (!originalTileType) {
            notifyTileStatus("A könyvtári csempe patch korábbi példánya nem állítható helyre.");
            return () => { };
        }
        memo.__controllerXboxOriginalType = originalTileType;
        const wrapper = wrappedTileType;
        wrapper.__controllerXboxWrapper = true;
        wrapper.__controllerXboxMemo = memo;
        memo.type = wrapper;
        notifyTileStatus("A könyvtári csempejelölés aktív. Nyisd meg vagy frissítsd a Könyvtárat.");
        return () => {
            if (tileMemo?.type === wrapper && originalTileType)
                tileMemo.type = originalTileType;
            if (tileMemo?.type !== wrapper)
                delete tileMemo?.__controllerXboxOriginalType;
            tileMemo = null;
            originalTileType = null;
            tileIconRowClass = "";
            supportListeners.clear();
            supportStates.clear();
            hungarianStates.clear();
            hungarianSources.clear();
            gfnStates.clear();
            boosteroidStates.clear();
            visibleAppIds.clear();
            pendingAppIds.clear();
            if (batchTimer !== undefined)
                window.clearTimeout(batchTimer);
            batchTimer = undefined;
        };
    }
    catch (error) {
        notifyTileStatus("A könyvtári csempejelölés biztonságosan leállt: " + errorMessage(error));
        console.error("ControllerXbox library tile patch failed", error);
        return () => { };
    }
}
function Content() {
    const [page, setPage] = SP_REACT.useState("home");
    const pageRef = SP_REACT.useRef("home");
    const [stats, setStats] = SP_REACT.useState();
    const [status, setStatus] = SP_REACT.useState("A jelvények aktívak.");
    const [diagnosticLog, setDiagnosticLog] = SP_REACT.useState("Nincs rögzített hiba.");
    const [working, setWorking] = SP_REACT.useState(false);
    const [updateInfo, setUpdateInfo] = SP_REACT.useState();
    const [updateStatus, setUpdateStatus] = SP_REACT.useState("Frissítések keresése folyamatban...");
    const [updateWorking, setUpdateWorking] = SP_REACT.useState(false);
    const [installedUpdate, setInstalledUpdate] = SP_REACT.useState();
    const [visibility, setVisibility] = SP_REACT.useState({ ...badgeVisibility });
    const [notifications, setNotifications] = SP_REACT.useState({ ...notificationPreferences });
    const [settingsWorking, setSettingsWorking] = SP_REACT.useState(false);
    const [watchlist, setWatchlist] = SP_REACT.useState([]);
    const [watchWorking, setWatchWorking] = SP_REACT.useState(false);
    const [cloudRefreshing, setCloudRefreshing] = SP_REACT.useState(false);
    const [cloudRefreshStatus, setCloudRefreshStatus] = SP_REACT.useState("");
    const [searchQuery, setSearchQuery] = SP_REACT.useState("");
    const [searchResults, setSearchResults] = SP_REACT.useState([]);
    const [searchWorking, setSearchWorking] = SP_REACT.useState(false);
    const [newWatchGfn, setNewWatchGfn] = SP_REACT.useState(true);
    const [newWatchBoosteroid, setNewWatchBoosteroid] = SP_REACT.useState(true);
    const [newWatchController, setNewWatchController] = SP_REACT.useState(false);
    const [history, setHistory] = SP_REACT.useState([]);
    const [unreadHistoryCount, setUnreadHistoryCount] = SP_REACT.useState(0);
    const [historyWorking, setHistoryWorking] = SP_REACT.useState(false);
    const refreshStats = async () => {
        try {
            setStats(await withBackendTimeout(getCacheStats()));
        }
        catch (error) {
            setDiagnosticLog("Cache állapot: " + errorMessage(error));
        }
    };
    const refreshWatchlist = async () => {
        try {
            const response = await withBackendTimeout(getWatchlist(), 120_000);
            if (!response.success)
                throw new Error(response.error || "A figyelőlista betöltése sikertelen.");
            const entries = response.entries ?? [];
            setWatchlist(entries);
            applyWatchlistEntries(entries);
        }
        catch (error) {
            setDiagnosticLog("Figyelőlista: " + errorMessage(error));
        }
    };
    const refreshHistory = async (markRead = false) => {
        try {
            const response = await withBackendTimeout(markRead ? markNotificationHistoryRead() : getNotificationHistory());
            if (!response.success)
                throw new Error(response.error || "Az értesítési előzmények betöltése sikertelen.");
            setHistory(response.entries ?? []);
            setUnreadHistoryCount(response.unread_count ?? 0);
        }
        catch (error) {
            setDiagnosticLog("Értesítési előzmények: " + errorMessage(error));
        }
    };
    const refreshUpdateInfo = async (quiet = false) => {
        setUpdateWorking(true);
        if (!quiet)
            setUpdateStatus("Frissítések keresése folyamatban...");
        try {
            const response = await withBackendTimeout(checkForUpdate(), 30_000);
            setUpdateInfo(response);
            if (!response.success)
                throw new Error(response.error || "A frissítéskeresés sikertelen.");
            if (response.has_update && response.latest_version) {
                setUpdateStatus("Új stabil verzió érhető el: v" + response.latest_version + ".");
            }
            else {
                setUpdateStatus("A plugin naprakész (v" + String(response.current_version ?? "ismeretlen") + ").");
            }
        }
        catch (error) {
            setUpdateStatus("Frissítéskeresési hiba: " + errorMessage(error));
        }
        finally {
            setUpdateWorking(false);
        }
    };
    SP_REACT.useEffect(() => {
        void refreshStats();
        void refreshWatchlist();
        void refreshHistory();
        void refreshUpdateInfo(true);
        const onCacheChanged = () => void refreshStats();
        const onHistoryChanged = () => {
            void refreshHistory(pageRef.current === "history");
            void refreshWatchlist();
        };
        const onWatchlistChanged = () => {
            setWatchlist(Array.from(watchedGames.values()).sort((left, right) => left.title.localeCompare(right.title)));
        };
        const onTileStatus = (event) => {
            const detail = event.detail;
            if (detail)
                setStatus(detail);
        };
        const onSettingsChanged = (event) => {
            const detail = event.detail;
            if (!detail)
                return;
            if (typeof detail.show_gfn_badges === "boolean" || typeof detail.show_boosteroid_badges === "boolean" || typeof detail.show_hungarian_badges === "boolean") {
                setVisibility((current) => ({
                    show_gfn_badges: detail.show_gfn_badges ?? current.show_gfn_badges,
                    show_boosteroid_badges: detail.show_boosteroid_badges ?? current.show_boosteroid_badges,
                    show_hungarian_badges: detail.show_hungarian_badges ?? current.show_hungarian_badges,
                    library_badge_percent: detail.library_badge_percent ?? current.library_badge_percent,
                    store_badge_percent: detail.store_badge_percent ?? current.store_badge_percent,
                }));
            }
            if (typeof detail.notify_gfn_additions === "boolean" ||
                typeof detail.notify_boosteroid_additions === "boolean" ||
                typeof detail.notify_boosteroid_maintenance === "boolean" ||
                typeof detail.notify_plugin_updates === "boolean") {
                setNotifications((current) => ({
                    notify_gfn_additions: detail.notify_gfn_additions ?? current.notify_gfn_additions,
                    notify_boosteroid_additions: detail.notify_boosteroid_additions ?? current.notify_boosteroid_additions,
                    notify_boosteroid_maintenance: detail.notify_boosteroid_maintenance ?? current.notify_boosteroid_maintenance,
                    notify_plugin_updates: detail.notify_plugin_updates ?? current.notify_plugin_updates,
                }));
            }
        };
        window.addEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
        window.addEventListener(HISTORY_CHANGED_EVENT, onHistoryChanged);
        window.addEventListener(TILE_STATUS_EVENT, onTileStatus);
        window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
        watchlistListeners.add(onWatchlistChanged);
        return () => {
            window.removeEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
            window.removeEventListener(HISTORY_CHANGED_EVENT, onHistoryChanged);
            window.removeEventListener(TILE_STATUS_EVENT, onTileStatus);
            window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
            watchlistListeners.delete(onWatchlistChanged);
        };
    }, []);
    SP_REACT.useEffect(() => {
        pageRef.current = page;
    }, [page]);
    const updateVisibility = async (next) => {
        const previous = visibility;
        setSettingsWorking(true);
        setVisibility(next);
        applyBadgeVisibility(next);
        try {
            const response = await withBackendTimeout(setBadgeVisibility(next.show_gfn_badges, next.show_boosteroid_badges, next.show_hungarian_badges));
            if (!response.success)
                throw new Error(response.error || "A beállítás mentése sikertelen.");
            applyBadgeVisibility({
                show_gfn_badges: response.show_gfn_badges,
                show_boosteroid_badges: response.show_boosteroid_badges,
                show_hungarian_badges: response.show_hungarian_badges ?? true,
                library_badge_percent: response.library_badge_percent ?? 100,
                store_badge_percent: response.store_badge_percent ?? 100,
            });
        }
        catch (error) {
            setVisibility(previous);
            applyBadgeVisibility(previous);
            toaster.toast({ title: "Beállítási hiba", body: errorMessage(error) });
        }
        finally {
            setSettingsWorking(false);
        }
    };
    const updateNotifications = async (next) => {
        const previous = notifications;
        setSettingsWorking(true);
        setNotifications(next);
        applyNotificationPreferences(next);
        try {
            const response = await withBackendTimeout(setNotificationPreferences(next.notify_gfn_additions, next.notify_boosteroid_additions, next.notify_boosteroid_maintenance, next.notify_plugin_updates));
            if (!response.success)
                throw new Error(response.error || "Az értesítési beállítás mentése sikertelen.");
            applyNotificationPreferences({
                notify_gfn_additions: response.notify_gfn_additions,
                notify_boosteroid_additions: response.notify_boosteroid_additions,
                notify_boosteroid_maintenance: response.notify_boosteroid_maintenance,
                notify_plugin_updates: response.notify_plugin_updates,
            });
        }
        catch (error) {
            setNotifications(previous);
            applyNotificationPreferences(previous);
            toaster.toast({ title: "Beállítási hiba", body: errorMessage(error) });
        }
        finally {
            setSettingsWorking(false);
        }
    };
    const searchForGames = async () => {
        const query = searchQuery.trim();
        if (query.length < 2) {
            toaster.toast({ title: "Steam-keresés", body: "Írj be legalább két karaktert." });
            return;
        }
        setSearchWorking(true);
        try {
            const response = await withBackendTimeout(searchSteamGames(query), 30_000);
            if (!response.success)
                throw new Error(response.error || "A Steam-keresés sikertelen.");
            setSearchResults(response.entries ?? []);
        }
        catch (error) {
            setSearchResults([]);
            toaster.toast({ title: "Steam-keresési hiba", body: errorMessage(error) });
        }
        finally {
            setSearchWorking(false);
        }
    };
    const addWatchedGame = async (appId) => {
        if (!newWatchGfn && !newWatchBoosteroid && !newWatchController) {
            toaster.toast({ title: "Figyelőlista", body: "Legalább egy figyelési szempontot válassz ki." });
            return;
        }
        setWatchWorking(true);
        try {
            const response = await withBackendTimeout(addWatchlistGame(appId, newWatchGfn, newWatchBoosteroid, newWatchController), 120_000);
            if (!response.success)
                throw new Error(response.error || "A játék felvétele sikertelen.");
            const entries = response.entries ?? [];
            applyWatchlistEntries(entries);
            setWatchlist(entries);
            setSearchResults((current) => current.filter((entry) => entry.app_id !== appId));
            const added = entries.find((entry) => entry.app_id === appId);
            toaster.toast({ title: "Figyelőlistához adva", body: added?.title ?? ("Steam AppID " + appId) });
        }
        catch (error) {
            toaster.toast({ title: "Figyelőlista hiba", body: errorMessage(error) });
        }
        finally {
            setWatchWorking(false);
        }
    };
    const removeWatchedGame = async (appId) => {
        setWatchWorking(true);
        try {
            const response = await withBackendTimeout(removeWatchlistGame(appId), 120_000);
            if (!response.success)
                throw new Error(response.error || "A játék eltávolítása sikertelen.");
            const entries = response.entries ?? [];
            setWatchlist(entries);
            applyWatchlistEntries(entries);
        }
        catch (error) {
            toaster.toast({ title: "Figyelőlista hiba", body: errorMessage(error) });
        }
        finally {
            setWatchWorking(false);
        }
    };
    const updateWatchedPlatforms = async (entry, watchGfn, watchBoosteroid, watchController = entry.watch_controller ?? false) => {
        if (!watchGfn && !watchBoosteroid && !watchController) {
            toaster.toast({ title: "Figyelőlista", body: "Legalább egy figyelési szempontot hagyj bekapcsolva." });
            return;
        }
        setWatchWorking(true);
        try {
            const response = await withBackendTimeout(setWatchlistPlatforms(entry.app_id, watchGfn, watchBoosteroid, watchController), 120_000);
            if (!response.success)
                throw new Error(response.error || "A platformbeállítás mentése sikertelen.");
            const entries = response.entries ?? [];
            setWatchlist(entries);
            applyWatchlistEntries(entries);
        }
        catch (error) {
            toaster.toast({ title: "Figyelőlista hiba", body: errorMessage(error) });
        }
        finally {
            setWatchWorking(false);
        }
    };
    const openPage = (nextPage) => {
        setPage(nextPage);
        if (nextPage === "history")
            void refreshHistory(true);
    };
    const clearHistory = async () => {
        setHistoryWorking(true);
        try {
            const response = await withBackendTimeout(clearNotificationHistory());
            if (!response.success)
                throw new Error(response.error || "Az előzmények törlése sikertelen.");
            setHistory([]);
            setUnreadHistoryCount(0);
            toaster.toast({ title: "Értesítési előzmények", body: "Az előzmények törölve." });
        }
        catch (error) {
            toaster.toast({ title: "Előzménytörlési hiba", body: errorMessage(error) });
        }
        finally {
            setHistoryWorking(false);
        }
    };
    const clearAndRefresh = async () => {
        setWorking(true);
        setStatus("Cache törlése folyamatban...");
        try {
            const response = await withBackendTimeout(clearCache());
            toaster.toast({
                title: "Deck Play Badges",
                body: String(response.removed) + " kontrollerbejegyzés, " + String(response.gfn_removed ?? 0) +
                    " GFN-AppID és " + String(response.boosteroid_removed ?? 0) + " Boosteroid-AppID törölve.",
            });
            resetVisibleSupport();
            notifyCacheChanged();
            await refreshStats();
            await refreshWatchlist();
            setDiagnosticLog("Nincs rögzített hiba.");
        }
        catch (error) {
            const message = errorMessage(error);
            setStatus("Cache hiba: " + message);
            setDiagnosticLog("Cache törlése: " + message);
        }
        finally {
            setWorking(false);
        }
    };
    const backendCheck = async () => {
        setWorking(true);
        try {
            const diagnostics = await withBackendTimeout(getBackendDiagnostics());
            setStats(diagnostics);
            await loadBadgeVisibility();
            resetVisibleSupport();
            setDiagnosticLog("Nincs rögzített hiba.");
        }
        catch (error) {
            const message = errorMessage(error);
            setStatus("Backend hiba: " + message);
            setDiagnosticLog("Backend ellenőrzése: " + message);
        }
        finally {
            setWorking(false);
        }
    };
    const installAvailableUpdate = async () => {
        const version = updateInfo?.latest_version;
        if (!updateInfo?.has_update || !version)
            return;
        setUpdateWorking(true);
        setUpdateStatus("A v" + version + " frissítés letöltése, ellenőrzése és telepítése folyamatban...");
        try {
            const response = await withBackendTimeout(applyUpdate(version), 120_000);
            if (!response.success)
                throw new Error(response.error || "A frissítés telepítése sikertelen.");
            setInstalledUpdate(response.version ?? version);
            setUpdateStatus("A v" + String(response.version ?? version) + " telepítve. Indítsd újra a Steamet és a plugint az alábbi gombbal.");
            toaster.toast({
                title: "Deck Play Badges frissítve",
                body: "A v" + String(response.version ?? version) + " telepítve. A befejezéshez indítsd újra a Steamet.",
            });
        }
        catch (error) {
            setUpdateStatus("Frissítési hiba: " + errorMessage(error));
        }
        finally {
            setUpdateWorking(false);
        }
    };
    const reloadAfterUpdate = async () => {
        setUpdateWorking(true);
        setUpdateStatus("A Steam és a plugin újraindítása folyamatban...");
        const result = await reloadUpdatedPlugin();
        if (result === "failed") {
            setUpdateStatus("Az automatikus újratöltés nem érhető el. Indítsd újra kézzel a Steamet.");
            setUpdateWorking(false);
        }
        else {
            toaster.toast({
                title: "Deck Play Badges",
                body: result === "reloaded" ? "A plugin újratöltve." : "A Steam és a plugin újraindítása folyamatban...",
            });
        }
    };
    const saveSizes = async (sizes) => {
        const response = await withBackendTimeout(setBadgeSizes(sizes.library_badge_percent, sizes.store_badge_percent));
        if (!response.success)
            throw new Error(response.error || "Az ikonméret mentése sikertelen.");
        applyBadgeVisibility({ ...badgeVisibility, library_badge_percent: response.library_badge_percent ?? 100,
            store_badge_percent: response.store_badge_percent ?? 100 });
    };
    if (page === "settings")
        return SP_JSX.jsxs(DFL.PanelSection, { title: "Be\u00E1ll\u00EDt\u00E1sok", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: () => openPage("home"), children: "\u2190 F\u0151oldal" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontWeight: 700 }, children: "Jelv\u00E9nyek" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Magyar z\u00E1szl\u00F3", description: "Magyar nyelv a Steam nyelvi list\u00E1ja vagy a Magyar Felirat kur\u00E1tor alapj\u00E1n. A teljes k\u00F6nyvt\u00E1rb\u00F3l magyar gy\u0171jtem\u00E9nyt k\u00E9sz\u00EDt. Kikapcsolva a gy\u0171jt\u00E9s sz\u00FCnetel, a gy\u0171jtem\u00E9ny megmarad.", checked: visibility.show_hungarian_badges, disabled: settingsWorking, onChange: (checked) => void updateVisibility({ ...visibility, show_hungarian_badges: checked }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "GeForce NOW", checked: visibility.show_gfn_badges, disabled: settingsWorking, onChange: (checked) => void updateVisibility({ ...visibility, show_gfn_badges: checked }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Boosteroid", checked: visibility.show_boosteroid_badges, disabled: settingsWorking, onChange: (checked) => void updateVisibility({ ...visibility, show_boosteroid_badges: checked }) }) }), SP_JSX.jsx(BadgeSizeSettings, { initial: { library_badge_percent: visibility.library_badge_percent ?? 100,
                        store_badge_percent: visibility.store_badge_percent ?? 100 }, save: saveSizes }), SP_JSX.jsx(AllKeyShopSettings, {}), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { marginTop: "12px", fontWeight: 700 }, children: "\u00C9rtes\u00EDt\u00E9sek" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "\u00DAj GeForce NOW-j\u00E1t\u00E9kok", checked: notifications.notify_gfn_additions, disabled: settingsWorking, onChange: (checked) => void updateNotifications({ ...notifications, notify_gfn_additions: checked }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "\u00DAj Boosteroid-j\u00E1t\u00E9kok", checked: notifications.notify_boosteroid_additions, disabled: settingsWorking, onChange: (checked) => void updateNotifications({ ...notifications, notify_boosteroid_additions: checked }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Boosteroid-karbantart\u00E1s", checked: notifications.notify_boosteroid_maintenance, disabled: settingsWorking, onChange: (checked) => void updateNotifications({ ...notifications, notify_boosteroid_maintenance: checked }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Pluginfriss\u00EDt\u00E9sek", checked: notifications.notify_plugin_updates, disabled: settingsWorking, onChange: (checked) => void updateNotifications({ ...notifications, notify_plugin_updates: checked }) }) })] });
    const refreshWatchedClouds = async () => {
        setCloudRefreshing(true);
        setCloudRefreshStatus("A GFN és Boosteroid katalógusának letöltése…");
        try {
            await refreshCloudData();
            setCloudRefreshStatus("GFN és Boosteroid frissítve: " + new Date().toLocaleTimeString());
        }
        catch (error) {
            setCloudRefreshStatus("Frissítési hiba: " + errorMessage(error));
        }
        finally {
            setCloudRefreshing(false);
        }
    };
    if (page === "watchlist")
        return SP_JSX.jsxs(DFL.PanelSection, { title: "Figyel\u0151lista", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(CatalogStatus, {}) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: cloudRefreshing, onClick: () => void refreshWatchedClouds(), children: cloudRefreshing ? "Figyelt adatok frissítése…" : "Figyelőlista és katalógusok ellenőrzése most" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: "12px", opacity: .8 }, children: cloudRefreshStatus || "Ébredéskor mindkét katalógus frissül. Ellenőrzés 15 percenként is, amíg a plugin fut." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: () => openPage("home"), children: "\u2190 F\u0151oldal" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "J\u00E1t\u00E9kn\u00E9v vagy Steam AppID", value: searchQuery, bShowClearAction: true, disabled: searchWorking || watchWorking, onChange: (event) => setSearchQuery(event.currentTarget.value) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: searchWorking || watchWorking || searchQuery.trim().length < 2, onClick: searchForGames, children: "Keres\u00E9s" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "GeForce NOW figyel\u00E9se", checked: newWatchGfn, disabled: watchWorking, onChange: setNewWatchGfn }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Boosteroid figyel\u00E9se", checked: newWatchBoosteroid, disabled: watchWorking, onChange: setNewWatchBoosteroid }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Kontroller-t\u00E1mogat\u00E1s figyel\u00E9se", checked: newWatchController, disabled: watchWorking, onChange: setNewWatchController }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: "12px", opacity: .8 }, children: "Kontroller: a Steam szerinti t\u00E1mogat\u00E1s megjelen\u00E9sekor vagy javul\u00E1sakor jelez. Els\u0151 ellen\u0151rz\u00E9skor kiindul\u00F3 \u00E1llapotot ment. \u00C9bred\u00E9skor frissen ellen\u0151rzi a figyelt j\u00E1t\u00E9kokat, egy\u00E9bk\u00E9nt naponta. A sor folyamatosan halad; Steam-hib\u00E1n\u00E1l k\u00E9s\u0151bb \u00FAjrapr\u00F3b\u00E1lja." }) }), searchResults.map((entry) => {
                    const alreadyWatched = watchedGames.has(entry.app_id);
                    return SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", label: entry.title, description: "Steam AppID: " + entry.app_id, disabled: watchWorking || alreadyWatched, onClick: () => void addWatchedGame(entry.app_id), children: alreadyWatched ? "Már figyelve" : "Hozzáadás" }) }, "search-" + entry.app_id);
                }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { marginTop: "12px", fontWeight: 700 }, children: ["Figyelt j\u00E1t\u00E9kok (", watchlist.length, ")"] }) }), watchlist.length ? watchlist.map((entry) => SP_JSX.jsxs(SP_REACT.Fragment, { children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { paddingTop: "6px", fontWeight: 700 }, children: entry.title }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { opacity: 0.75 }, children: ["GFN: ", entry.watch_gfn ? watchlistGfnLabel(entry.gfn) : "kikapcsolva", " · Boosteroid: ", entry.watch_boosteroid ? watchlistBoosteroidLabel(entry.boosteroid) : "kikapcsolva", SP_JSX.jsxs("div", { children: ["Kontroller: ", entry.watch_controller ? controllerWatchLabel(entry) : "kikapcsolva"] })] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "GeForce NOW", checked: entry.watch_gfn, disabled: watchWorking, onChange: (checked) => void updateWatchedPlatforms(entry, checked, entry.watch_boosteroid) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Boosteroid", checked: entry.watch_boosteroid, disabled: watchWorking, onChange: (checked) => void updateWatchedPlatforms(entry, entry.watch_gfn, checked) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Kontroller-t\u00E1mogat\u00E1s", checked: entry.watch_controller ?? false, disabled: watchWorking, onChange: checked => void updateWatchedPlatforms(entry, entry.watch_gfn, entry.watch_boosteroid, checked) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: watchWorking, onClick: () => void removeWatchedGame(entry.app_id), children: "Elt\u00E1vol\u00EDt\u00E1s" }) })] }, entry.app_id)) : SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "A figyel\u0151lista \u00FCres." }) })] });
    if (page === "history")
        return SP_JSX.jsxs(DFL.PanelSection, { title: "El\u0151zm\u00E9nyek", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: () => openPage("home"), children: "\u2190 F\u0151oldal" }) }), history.length ? history.map((entry) => SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { padding: "6px 0" }, children: [SP_JSX.jsx("div", { style: { fontWeight: 700 }, children: entry.title }), SP_JSX.jsx("div", { children: historyEventLabel(entry) }), SP_JSX.jsxs("div", { style: { opacity: 0.7, fontSize: "12px" }, children: [new Date(entry.created_at * 1000).toLocaleString("hu-HU"), " \u00B7 Steam AppID: ", entry.app_id] })] }) }, entry.id)) : SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "M\u00E9g nincs r\u00F6gz\u00EDtett esem\u00E9ny." }) }), history.length ? SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: historyWorking, onClick: clearHistory, children: "El\u0151zm\u00E9nyek t\u00F6rl\u00E9se" }) }) : null] });
    return SP_JSX.jsxs(DFL.PanelSection, { title: "Deck Play Badges", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs(DFL.ButtonItem, { layout: "below", onClick: () => openPage("watchlist"), children: ["Figyel\u0151lista (", watchlist.length, ")"] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs(DFL.ButtonItem, { layout: "below", onClick: () => openPage("history"), children: ["El\u0151zm\u00E9nyek", unreadHistoryCount ? " (" + String(unreadHistoryCount) + ")" : ""] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: () => openPage("settings"), children: "Be\u00E1ll\u00EDt\u00E1sok" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: status }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(HungarianProgress, { manager: hungarianCollection, loadCurator: loadCuratorProgress }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(CatalogStatus, {}) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: stats
                        ? "Cache: " + String(stats.fresh_entries) + "/" + String(stats.entries)
                            + " · GFN: " + String(stats.gfn_catalog_entries ?? 0)
                            + " · Boosteroid: " + String(stats.boosteroid_catalog_entries ?? 0)
                        : "Állapot betöltése..." }) }), diagnosticLog !== "Nincs rögzített hiba." ?
                SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { whiteSpace: "pre-wrap", userSelect: "text" }, children: ["Hiba: ", diagnosticLog] }) }) : null, SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working, onClick: backendCheck, children: "J\u00E1t\u00E9kok \u00FAjraellen\u0151rz\u00E9se" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working, onClick: clearAndRefresh, children: "Cache t\u00F6rl\u00E9se" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { marginTop: "12px", fontWeight: 700 }, children: "Pluginfriss\u00EDt\u00E9s" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: updateStatus }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: updateWorking, onClick: () => void refreshUpdateInfo(), children: "Friss\u00EDt\u00E9sek keres\u00E9se" }) }), updateInfo?.has_update && updateInfo.latest_version && !installedUpdate ?
                SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs(DFL.ButtonItem, { layout: "below", disabled: updateWorking, onClick: installAvailableUpdate, children: ["Friss\u00EDt\u00E9s telep\u00EDt\u00E9se: v", updateInfo.latest_version] }) }) : null, installedUpdate ?
                SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: updateWorking, onClick: reloadAfterUpdate, children: "Steam \u00E9s plugin \u00FAjraind\u00EDt\u00E1sa" }) }) : null] });
}
var index = DFL.definePlugin(() => {
    pluginActive = true;
    void loadBadgeVisibility();
    void loadWatchlistState();
    notificationTimer = window.setTimeout(() => void checkBackgroundNotifications(), 10_000);
    const removeTilePatch = patchLibraryTiles();
    const removeLibraryDetailPatch = patchLibraryDetails();
    const removeStorePatch = patchSteamStore();
    const resumeRefresh = new CloudResumeRefresh({
        register: callback => {
            const sleepManager = DFL.findModuleExport((value) => typeof value?.RegisterForNotifyResumeFromSuspend === "function");
            const subscription = sleepManager?.RegisterForNotifyResumeFromSuspend(callback);
            return subscription ? () => subscription.unregister?.() : undefined;
        },
        refresh: refreshCloudData,
        onError: error => console.warn("Deck Play Badges wake catalog refresh failed", error),
    });
    resumeRefresh.start();
    return {
        name: "Deck Play Badges",
        titleView: SP_JSX.jsx("div", { className: DFL.staticClasses.Title, children: "Deck Play Badges" }),
        content: SP_JSX.jsx(Content, {}),
        icon: SP_JSX.jsx("span", { children: "\u2713" }),
        onDismount: () => {
            pluginActive = false;
            resumeRefresh.stop();
            if (settingsRetryTimer !== undefined)
                window.clearTimeout(settingsRetryTimer);
            settingsRetryTimer = undefined;
            hungarianCollection.stop();
            if (curatorBadgeTimer !== undefined)
                window.clearTimeout(curatorBadgeTimer);
            curatorBadgeTimer = undefined;
            if (notificationTimer !== undefined)
                window.clearTimeout(notificationTimer);
            notificationTimer = undefined;
            removeStorePatch();
            removeLibraryDetailPatch();
            removeTilePatch();
        },
    };
});

export { index as default };
//# sourceMappingURL=index.js.map
