const manifest = {"name":"ControllerXbox"};
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
const toaster = api.toaster;

const BACKEND_TIMEOUT_MS = 15_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const TILE_STATUS_EVENT = "controller-xbox-tile-status";
const BADGE_KEY = "controller-xbox-tile-badge";
const getControllerSupport = callable("get_controller_support");
const clearCache = callable("clear_cache");
const getCacheStats = callable("get_cache_stats");
const getBackendDiagnostics = callable("get_backend_diagnostics");
const supportStates = new Map();
const visibleAppIds = new Map();
const supportListeners = new Set();
const pendingAppIds = new Set();
let batchTimer;
let tileMemo = null;
let originalTileType = null;
let tileIconRowClass = "";
function withBackendTimeout(request) {
    return Promise.race([
        request,
        new Promise((_, reject) => {
            window.setTimeout(() => reject(new Error("A Decky backend 15 másodpercen belül nem válaszolt.")), BACKEND_TIMEOUT_MS);
        }),
    ]);
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
    const checked = visible.filter((id) => supportStates.get(id) === "supported" || supportStates.get(id) === "unsupported").length;
    const supported = visible.filter((id) => supportStates.get(id) === "supported").length;
    const unavailable = visible.filter((id) => supportStates.get(id) === "unavailable").length;
    notifyTileStatus("Látható játékok ellenőrzése: " + String(checked) + "/" + String(visible.length) +
        ". Xbox-kompatibilis: " + String(supported) +
        (unavailable ? ". Nem sikerült lekérdezni: " + String(unavailable) + "." : "."));
}
async function flushSupportBatch() {
    batchTimer = undefined;
    const appIds = Array.from(pendingAppIds);
    pendingAppIds.clear();
    if (!appIds.length)
        return;
    try {
        const response = await withBackendTimeout(getControllerSupport(appIds));
        for (const appId of appIds) {
            const value = response.support?.[appId];
            if (value === true)
                supportStates.set(appId, "supported");
            else if (value === false)
                supportStates.set(appId, "unsupported");
            else
                supportStates.set(appId, "unavailable");
        }
    }
    catch (error) {
        for (const appId of appIds)
            supportStates.set(appId, "unavailable");
        notifyTileStatus("A kompatibilitási adatok lekérése sikertelen: " + errorMessage(error));
        console.warn("ControllerXbox tile lookup failed", error);
    }
    publishSupportState();
    notifyCacheChanged();
}
function queueSupportLookup(appId) {
    const current = supportStates.get(appId);
    if (current && current !== "unavailable")
        return;
    supportStates.set(appId, "loading");
    pendingAppIds.add(appId);
    if (batchTimer === undefined)
        batchTimer = window.setTimeout(() => void flushSupportBatch(), 120);
}
function resetVisibleSupport() {
    supportStates.clear();
    pendingAppIds.clear();
    for (const appId of visibleAppIds.keys())
        queueSupportLookup(appId);
    publishSupportState();
}
function XboxTileBadge({ appId }) {
    const appIdText = String(appId);
    const [state, setState] = SP_REACT.useState(() => supportStates.get(appIdText) ?? "loading");
    SP_REACT.useEffect(() => {
        visibleAppIds.set(appIdText, (visibleAppIds.get(appIdText) ?? 0) + 1);
        const listener = () => setState(supportStates.get(appIdText) ?? "loading");
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
    const appearance = {
        supported: {
            symbol: "✓",
            background: "#107cde",
            title: "Steam: teljes kontroller-támogatás",
        },
        unsupported: {
            symbol: "×",
            background: "#a52a2a",
            title: "Steam: nincs teljes kontroller-támogatás",
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
    return SP_JSX.jsx("span", { title: badge.title, style: {
            position: "absolute",
            top: "6px",
            left: "6px",
            zIndex: 100,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: "24px",
            height: "24px",
            padding: "0 5px",
            borderRadius: "12px",
            background: badge.background,
            color: "white",
            boxShadow: "0 1px 5px rgba(0,0,0,.85)",
            font: "bold 17px/24px Arial, sans-serif",
            pointerEvents: "none",
        }, children: badge.symbol });
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
    const [stats, setStats] = SP_REACT.useState();
    const [status, setStatus] = SP_REACT.useState("A könyvtári csempejelölés indul. Nyisd meg vagy frissítsd a Könyvtárat.");
    const [diagnosticLog, setDiagnosticLog] = SP_REACT.useState("Nincs rögzített hiba.");
    const [working, setWorking] = SP_REACT.useState(false);
    const refreshStats = async () => {
        try {
            setStats(await withBackendTimeout(getCacheStats()));
        }
        catch (error) {
            setDiagnosticLog("Cache állapot: " + errorMessage(error));
        }
    };
    SP_REACT.useEffect(() => {
        void refreshStats();
        const onCacheChanged = () => void refreshStats();
        const onTileStatus = (event) => {
            const detail = event.detail;
            if (detail)
                setStatus(detail);
        };
        window.addEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
        window.addEventListener(TILE_STATUS_EVENT, onTileStatus);
        return () => {
            window.removeEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
            window.removeEventListener(TILE_STATUS_EVENT, onTileStatus);
        };
    }, []);
    const clearAndRefresh = async () => {
        setWorking(true);
        setStatus("Cache törlése folyamatban...");
        try {
            const response = await withBackendTimeout(clearCache());
            toaster.toast({ title: "Xbox Controller Check", body: String(response.removed) + " gyorsítótár-bejegyzés törölve." });
            resetVisibleSupport();
            notifyCacheChanged();
            await refreshStats();
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
    return SP_JSX.jsxs(DFL.PanelSection, { title: "Xbox Controller Check", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "A k\u00F6nyvt\u00E1ri b\u00E9lyegk\u00E9pek jel\u00F6l\u00E9se: k\u00E9k \u2713 = teljes t\u00E1mogat\u00E1s; piros \u00D7 = nincs teljes t\u00E1mogat\u00E1s; narancss\u00E1rga ? = nincs Steam-adat; sz\u00FCrke \u2026 = ellen\u0151rz\u00E9s alatt." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: status }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: stats ? String(stats.entries) + " játék van memóriában; " + String(stats.fresh_entries) + " bejegyzés friss (" + String(stats.ttl_days) + " napos cache)." : "A cache-számláló betöltése folyamatban..." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { whiteSpace: "pre-wrap", userSelect: "text" }, children: ["Hibanapl\u00F3: ", diagnosticLog] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working, onClick: backendCheck, children: "L\u00E1that\u00F3 j\u00E1t\u00E9kok \u00FAjraellen\u0151rz\u00E9se" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working, onClick: clearAndRefresh, children: "Cache t\u00F6rl\u00E9se \u00E9s \u00FAjraellen\u0151rz\u00E9s" }) })] });
}
var index = DFL.definePlugin(() => {
    const removeTilePatch = patchLibraryTiles();
    return {
        name: "Xbox Controller Check",
        titleView: SP_JSX.jsx("div", { className: DFL.staticClasses.Title, children: "Xbox Controller Check" }),
        content: SP_JSX.jsx(Content, {}),
        icon: SP_JSX.jsx("span", { children: "\u2713" }),
        onDismount: removeTilePatch,
    };
});

export { index as default };
//# sourceMappingURL=index.js.map
