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
const routerHook = api.routerHook;
const toaster = api.toaster;
const fetchNoCors = api.fetchNoCors;

const BACKEND_TIMEOUT_MS = 15_000;
const CATALOG_BACKEND_TIMEOUT_MS = 60_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const TILE_STATUS_EVENT = "controller-xbox-tile-status";
const SETTINGS_CHANGED_EVENT = "controller-xbox-settings-changed";
const BADGE_KEY = "controller-xbox-tile-badge";
const DETAIL_BADGE_KEY = "controller-xbox-detail-badge";
const DETAIL_PATCH_FLAG = "__controllerXboxDetailPatched";
const STORE_DEBUGGER_URL = "http://localhost:8080/json";
const STORE_SCAN_INTERVAL_MS = 1_500;
const getControllerSupport = callable("get_controller_support");
const getGfnAvailability = callable("get_gfn_availability");
const getBoosteroidAvailability = callable("get_boosteroid_availability");
const clearCache = callable("clear_cache");
const getCacheStats = callable("get_cache_stats");
const getBackendDiagnostics = callable("get_backend_diagnostics");
const checkForUpdate = callable("check_for_update");
const applyUpdate = callable("apply_update");
const restartPluginLoader = callable("restart_plugin_loader");
const getSettings = callable("get_settings");
const setBadgeVisibility = callable("set_badge_visibility");
const getNotificationEvents = callable("get_notification_events");
const supportStates = new Map();
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
let storeWebSocketReady = false;
let storeMessageId = 1;
let storeScanTimer;
let storeReconnectTimer;
let storeCurrentAppIds = new Set();
let notificationTimer;
let badgeVisibility = {
    show_gfn_badges: true,
    show_boosteroid_badges: true,
};
const storeRuntimeRequests = new Map();
function withBackendTimeout(request, timeoutMs = BACKEND_TIMEOUT_MS) {
    return Promise.race([
        request,
        new Promise((_, reject) => {
            window.setTimeout(() => reject(new Error("A Decky backend " + String(timeoutMs / 1000) + " másodpercen belül nem válaszolt.")), timeoutMs);
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
async function reloadUpdatedPlugin() {
    try {
        const loader = window.DeckyPluginLoader;
        if (typeof loader?.reloadPlugin === "function") {
            await loader.reloadPlugin("ControllerXbox");
            return "reloaded";
        }
    }
    catch {
        // Try the backend service restart below.
    }
    try {
        const response = await withBackendTimeout(restartPluginLoader(), 5_000);
        if (response.success)
            return "restarting";
    }
    catch {
        // Try a full Steam restart below.
    }
    try {
        const steamSystem = window.SteamClient?.System;
        if (typeof steamSystem?.RestartSteamClient === "function") {
            steamSystem.RestartSteamClient();
            return "restarting";
        }
    }
    catch {
        // The UI will provide a manual restart instruction.
    }
    return "failed";
}
function applyBadgeVisibility(next) {
    badgeVisibility = next;
    for (const listener of supportListeners)
        listener();
    renderStoreBadges();
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: next }));
}
async function loadBadgeVisibility() {
    try {
        const response = await withBackendTimeout(getSettings());
        if (response.success) {
            applyBadgeVisibility({
                show_gfn_badges: response.show_gfn_badges,
                show_boosteroid_badges: response.show_boosteroid_badges,
            });
        }
    }
    catch (error) {
        console.warn("ControllerXbox badge settings could not be loaded", error);
    }
}
function getSteamLibraryAppIds() {
    try {
        const collection = globalThis.collectionStore?.allAppsCollection;
        const rawApps = collection?.allApps ?? collection?.apps;
        const apps = Array.isArray(rawApps)
            ? rawApps
            : rawApps && typeof rawApps[Symbol.iterator] === "function"
                ? Array.from(rawApps)
                : [];
        return Array.from(new Set(apps
            .map((app) => String(app?.appid ?? ""))
            .filter((appId) => /^\d+$/.test(appId) && Number(appId) > 0)));
    }
    catch (error) {
        console.warn("ControllerXbox could not enumerate the Steam library", error);
        return [];
    }
}
async function checkBackgroundNotifications(attempt = 0) {
    const appIds = getSteamLibraryAppIds();
    if (!appIds.length && attempt < 3) {
        notificationTimer = window.setTimeout(() => void checkBackgroundNotifications(attempt + 1), 10_000);
        return;
    }
    notificationTimer = undefined;
    try {
        const response = await withBackendTimeout(getNotificationEvents(appIds), 180_000);
        if (!response.success)
            throw new Error(response.error || "Az értesítési ellenőrzés sikertelen.");
        if ((response.gfn_added ?? 0) > 0) {
            toaster.toast({
                title: "GeForce NOW újdonság",
                body: String(response.gfn_added) + " játékod mostantól elérhető a GeForce NOW-on.",
            });
        }
        if ((response.boosteroid_added ?? 0) > 0) {
            toaster.toast({
                title: "Boosteroid újdonság",
                body: String(response.boosteroid_added) + " játékod mostantól elérhető a Boosteroiden.",
            });
        }
        if ((response.boosteroid_maintenance ?? 0) > 0) {
            toaster.toast({
                title: "Boosteroid karbantartás",
                body: String(response.boosteroid_maintenance) + " játékod karbantartás alá került a Boosteroiden.",
            });
        }
        if (response.update_version) {
            toaster.toast({
                title: "ControllerXbox frissítés",
                body: "Új pluginverzió érhető el: v" + response.update_version + ". Nyisd meg a plugint a telepítéshez.",
            });
        }
    }
    catch (error) {
        console.warn("ControllerXbox background notification check failed", error);
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
        for (const appId of appIds) {
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
        for (const appId of appIds)
            supportStates.set(appId, "unavailable");
        console.warn("ControllerXbox controller lookup failed", supportResult.reason);
    }
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
    const [state, setState] = SP_REACT.useState(() => supportStates.get(appIdText) ?? "loading");
    const [gfnState, setGfnState] = SP_REACT.useState(() => gfnStates.get(appIdText) ?? "loading");
    const [boosteroidState, setBoosteroidState] = SP_REACT.useState(() => boosteroidStates.get(appIdText) ?? "loading");
    SP_REACT.useEffect(() => {
        visibleAppIds.set(appIdText, (visibleAppIds.get(appIdText) ?? 0) + 1);
        const listener = () => {
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
    return SP_JSX.jsxs("span", { style: {
            position: "absolute",
            top: "6px",
            left: "6px",
            zIndex: 100,
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            transform: "scale(.88)",
            transformOrigin: "top left",
            pointerEvents: "none",
        }, children: [SP_JSX.jsx(ControllerBadge, { state: state, appId: appId }), badgeVisibility.show_gfn_badges ? SP_JSX.jsx(GfnBadge, { state: gfnState }) : null, badgeVisibility.show_boosteroid_badges ? SP_JSX.jsx(BoosteroidBadge, { state: boosteroidState }) : null] });
}
function LibraryDetailBadges({ appId }) {
    const appIdText = String(appId);
    const [state, setState] = SP_REACT.useState(() => supportStates.get(appIdText) ?? "loading");
    const [gfnState, setGfnState] = SP_REACT.useState(() => gfnStates.get(appIdText) ?? "loading");
    const [boosteroidState, setBoosteroidState] = SP_REACT.useState(() => boosteroidStates.get(appIdText) ?? "loading");
    const [position, setPosition] = SP_REACT.useState({ top: 60, right: 20 });
    const [hidden, setHidden] = SP_REACT.useState(false);
    const ref = SP_REACT.useRef(null);
    SP_REACT.useEffect(() => {
        visibleAppIds.set(appIdText, (visibleAppIds.get(appIdText) ?? 0) + 1);
        const listener = () => {
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
            transform: "scale(.95)",
            transformOrigin: "top right",
            pointerEvents: "none",
        }, children: [SP_JSX.jsx(ControllerBadge, { state: state, appId: appId }), badgeVisibility.show_gfn_badges ? SP_JSX.jsx(GfnBadge, { state: gfnState }) : null, badgeVisibility.show_boosteroid_badges ? SP_JSX.jsx(BoosteroidBadge, { state: boosteroidState }) : null] });
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
      return { url: location.href, appIds: Array.from(ids) };
    })();
  `;
}
function buildStoreBadgeScript(states, visibility) {
    const serializedStates = JSON.stringify(states).replace(/</g, "\\u003c");
    const controllerPath = "M5.4 5.5h13.2c1.5 0 2.8 1 3.2 2.5l1.1 5c.4 1.8-.9 3.5-2.7 3.5-.8 0-1.5-.3-2-.9L15.6 13H8.4l-2.6 2.6c-.5.6-1.2.9-2 .9-1.8 0-3.1-1.7-2.7-3.5l1.1-5c.4-1.5 1.7-2.5 3.2-2.5Z";
    const boosteroidPath = "M13.3259 3.30744C9.865 6.72998 9.549 12.1026 12.3773 15.8818L9.46609 18.7608C8.90018 19.3204 8.90018 20.2281 9.46609 20.7883C10.032 21.3479 10.9498 21.3479 11.5163 20.7883L14.4276 17.9093C18.2491 20.7063 23.682 20.3938 27.143 16.9713C30.9524 13.2041 30.9524 7.07459 27.143 3.30801C23.3336-.45857 17.1347-.459144 13.3259 3.30744ZM25.0927 14.9438C22.7653 17.2453 19.1705 17.5469 16.5103 15.8497L17.6595 14.7133C18.2254 14.1536 18.2254 13.246 17.6595 12.6858C17.0936 12.1261 16.1757 12.1261 15.6092 12.6858L14.46 13.8222C12.7438 11.1915 13.0488 7.63651 15.3762 5.33493C18.0549 2.68588 22.414 2.68588 25.0927 5.33493C27.7715 7.98398 27.7715 12.2947 25.0927 14.9438ZM16.2841 21.6272C16.85 22.1868 16.85 23.0945 16.2841 23.6547L10.1416 29.7291C9.57567 30.2887 8.65782 30.2887 8.09134 29.7291C7.52544 29.1695 7.52544 28.2618 8.09134 27.7016L14.2345 21.6272C14.8004 21.0675 15.7182 21.0675 16.2841 21.6272ZM.424426 22.1472C-.141475 21.5876-.141475 20.6799.424426 20.1197L6.56758 14.0447C7.13348 13.4851 8.05133 13.4851 8.61782 14.0447C9.18372 14.6043 9.18372 15.512 8.61782 16.0722L2.47466 22.1472C1.90818 22.7074.990907 22.7074.424426 22.1472Z";
    return `
    (function() {
      const states = ${serializedStates};
      const showGfn = ${visibility.show_gfn_badges ? "true" : "false"};
      const showBoosteroid = ${visibility.show_boosteroid_badges ? "true" : "false"};
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
          (showBoosteroid ? boosteroidBadge(state.boosteroid) : '');
      }

      let style = document.getElementById('controller-xbox-store-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'controller-xbox-store-style';
        style.textContent = '.cxc-store-badges{display:flex;align-items:center;gap:3px;pointer-events:none}.cxc-store-detail{position:fixed;right:20px;bottom:20px;z-index:999999;transform:scale(.95);transform-origin:bottom right}.cxc-store-card-badges{position:absolute;left:4px;top:4px;z-index:9999;transform:scale(.72);transform-origin:top left}.cxc-controller,.cxc-gfn,.cxc-boosteroid{box-sizing:border-box;height:24px;display:inline-flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 1px 5px rgba(0,0,0,.85);pointer-events:none}.cxc-controller{min-width:34px;padding:0 5px;border-radius:12px;background:#107cde}.cxc-symbol{min-width:24px;font:bold 17px/24px Arial,sans-serif}.cxc-gfn{min-width:34px;padding:0 5px;border-radius:5px;font:italic 900 10px/24px Arial,sans-serif;letter-spacing:-.3px}.cxc-boosteroid{width:34px;padding:0 3px;border-radius:5px;background:rgba(6,9,18,.9)}';
        (document.head || document.documentElement).appendChild(style);
      }

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
        const key = pageId + ':' + states[pageId].controller + ':' + states[pageId].gfn + ':' + states[pageId].boosteroid + ':' + showGfn + ':' + showBoosteroid;
        if (detail.getAttribute('data-state-key') !== key) {
          detail.innerHTML = badgesHtml(pageId, 'detail');
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
          badge.className = 'cxc-store-badges ' + cardClass;
          host.appendChild(badge);
        }
        const key = appId + ':' + states[appId].controller + ':' + states[appId].gfn + ':' + states[appId].boosteroid + ':' + showGfn + ':' + showBoosteroid;
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
        };
    }
    void sendStoreRuntime(buildStoreBadgeScript(states, badgeVisibility)).catch((error) => {
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
        const nextIds = new Set((Array.isArray(result?.appIds) ? result.appIds : [])
            .map((value) => String(value))
            .filter((value) => /^\d+$/.test(value) && Number(value) > 0));
        storeCurrentAppIds = nextIds;
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
        document.querySelectorAll('.controller-xbox-store-card-badges').forEach(function(node) { node.remove(); });
        document.getElementById('controller-xbox-store-style')?.remove();
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
    const [stats, setStats] = SP_REACT.useState();
    const [status, setStatus] = SP_REACT.useState("A könyvtári csempék, játékoldalak és Steam Áruház jelölése indul. Nyisd meg vagy frissítsd a kívánt nézetet.");
    const [diagnosticLog, setDiagnosticLog] = SP_REACT.useState("Nincs rögzített hiba.");
    const [working, setWorking] = SP_REACT.useState(false);
    const [updateInfo, setUpdateInfo] = SP_REACT.useState();
    const [updateStatus, setUpdateStatus] = SP_REACT.useState("Frissítések keresése folyamatban...");
    const [updateWorking, setUpdateWorking] = SP_REACT.useState(false);
    const [installedUpdate, setInstalledUpdate] = SP_REACT.useState();
    const [visibility, setVisibility] = SP_REACT.useState({ ...badgeVisibility });
    const [settingsWorking, setSettingsWorking] = SP_REACT.useState(false);
    const refreshStats = async () => {
        try {
            setStats(await withBackendTimeout(getCacheStats()));
        }
        catch (error) {
            setDiagnosticLog("Cache állapot: " + errorMessage(error));
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
        void refreshUpdateInfo(true);
        const onCacheChanged = () => void refreshStats();
        const onTileStatus = (event) => {
            const detail = event.detail;
            if (detail)
                setStatus(detail);
        };
        const onSettingsChanged = (event) => {
            const detail = event.detail;
            if (detail)
                setVisibility({ ...detail });
        };
        window.addEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
        window.addEventListener(TILE_STATUS_EVENT, onTileStatus);
        window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
        return () => {
            window.removeEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
            window.removeEventListener(TILE_STATUS_EVENT, onTileStatus);
            window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
        };
    }, []);
    const updateVisibility = async (next) => {
        const previous = visibility;
        setSettingsWorking(true);
        setVisibility(next);
        applyBadgeVisibility(next);
        try {
            const response = await withBackendTimeout(setBadgeVisibility(next.show_gfn_badges, next.show_boosteroid_badges));
            if (!response.success)
                throw new Error(response.error || "A beállítás mentése sikertelen.");
            applyBadgeVisibility({
                show_gfn_badges: response.show_gfn_badges,
                show_boosteroid_badges: response.show_boosteroid_badges,
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
    const clearAndRefresh = async () => {
        setWorking(true);
        setStatus("Cache törlése folyamatban...");
        try {
            const response = await withBackendTimeout(clearCache());
            toaster.toast({
                title: "Xbox Controller Check",
                body: String(response.removed) + " kontrollerbejegyzés, " + String(response.gfn_removed ?? 0) +
                    " GFN-AppID és " + String(response.boosteroid_removed ?? 0) + " Boosteroid-AppID törölve.",
            });
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
            setUpdateStatus("A v" + String(response.version ?? version) + " telepítve. Töltsd újra a plugint az alábbi gombbal.");
            toaster.toast({
                title: "ControllerXbox frissítve",
                body: "A v" + String(response.version ?? version) + " telepítve. A befejezéshez töltsd újra a plugint.",
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
        setUpdateStatus("A plugin újratöltése folyamatban...");
        const result = await reloadUpdatedPlugin();
        if (result === "failed") {
            setUpdateStatus("Az automatikus újratöltés nem érhető el. Indítsd újra kézzel a Steamet.");
            setUpdateWorking(false);
        }
        else {
            toaster.toast({
                title: "ControllerXbox",
                body: result === "reloaded" ? "A plugin újratöltve." : "A pluginbetöltő újraindítása folyamatban...",
            });
        }
    };
    return SP_JSX.jsxs(DFL.PanelSection, { title: "Xbox Controller Check", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontWeight: 700 }, children: "Megjelen\u00EDtett jelv\u00E9nyek" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "GeForce NOW jelv\u00E9nyek", description: "GFN-jelv\u00E9nyek megjelen\u00EDt\u00E9se a K\u00F6nyvt\u00E1rban \u00E9s a Steam \u00C1ruh\u00E1zban.", checked: visibility.show_gfn_badges, disabled: settingsWorking, onChange: (checked) => void updateVisibility({ ...visibility, show_gfn_badges: checked }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "Boosteroid jelv\u00E9nyek", description: "Boosteroid-jelv\u00E9nyek megjelen\u00EDt\u00E9se a K\u00F6nyvt\u00E1rban \u00E9s a Steam \u00C1ruh\u00E1zban.", checked: visibility.show_boosteroid_badges, disabled: settingsWorking, onChange: (checked) => void updateVisibility({ ...visibility, show_boosteroid_badges: checked }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "A k\u00F6nyvt\u00E1ri \u00E9s Steam \u00C1ruh\u00E1z-b\u00E9lyegk\u00E9pek jel\u00F6l\u00E9se: teli kontroller = teljes t\u00E1mogat\u00E1s; f\u00E9lig kit\u00F6lt\u00F6tt kontroller = r\u00E9szleges t\u00E1mogat\u00E1s; piros \u00D7 = nincs t\u00E1mogat\u00E1s; narancss\u00E1rga ? = nincs Steam-adat." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "A K\u00F6nyvt\u00E1rban megnyitott j\u00E1t\u00E9k oldal\u00E1n a h\u00E1rom jelv\u00E9ny jobb fel\u00FCl, a ProtonDB-jelv\u00E9nnyel egy vonalban jelenik meg." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "A megnyitott Steam \u00C1ruh\u00E1z-j\u00E1t\u00E9k oldal\u00E1n a h\u00E1rom jelv\u00E9ny jobb alul, a ProtonDB Store-jelv\u00E9nnyel egy vonalban jelenik meg." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "GeForce NOW: z\u00F6ld GFN = j\u00E1tszhat\u00F3; sz\u00FCrke GFN = nincs a katal\u00F3gusban; narancss\u00E1rga GFN? = a katal\u00F3gus nem \u00E9rhet\u0151 el." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "Boosteroid: k\u00E9k log\u00F3 = el\u00E9rhet\u0151; s\u00E1rga log\u00F3 = karbantart\u00E1s alatt; sz\u00FCrke log\u00F3 = nincs a katal\u00F3gusban; narancss\u00E1rga log\u00F3 = a katal\u00F3gus nem \u00E9rhet\u0151 el." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "A h\u00E1tt\u00E9rellen\u0151rz\u00E9s egyszer \u00E9rtes\u00EDt az \u00FAj GFN- \u00E9s Boosteroid-j\u00E1t\u00E9kokr\u00F3l, a Boosteroid-karbantart\u00E1sr\u00F3l \u00E9s az \u00FAj pluginverzi\u00F3kr\u00F3l." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: status }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: stats ? String(stats.entries) + " játék van memóriában; " + String(stats.fresh_entries) + " bejegyzés friss (" + String(stats.ttl_days) + " napos cache)." : "A cache-számláló betöltése folyamatban..." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: stats ? "GFN-katalógus: " + String(stats.gfn_catalog_entries ?? 0) + " Steam AppID; " + (stats.gfn_cache_fresh ? "friss (24 óránként ellenőrizve)." : "frissítésre vár.") : "A GFN-katalógus állapotának betöltése folyamatban..." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: stats ? "Boosteroid-katalógus: " + String(stats.boosteroid_catalog_entries ?? 0) + " Steam AppID; " + (stats.boosteroid_cache_fresh ? "friss (24 óránként ellenőrizve)." : "frissítésre vár.") : "A Boosteroid-katalógus állapotának betöltése folyamatban..." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { whiteSpace: "pre-wrap", userSelect: "text" }, children: ["Hibanapl\u00F3: ", diagnosticLog] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working, onClick: backendCheck, children: "L\u00E1that\u00F3 j\u00E1t\u00E9kok \u00FAjraellen\u0151rz\u00E9se" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working, onClick: clearAndRefresh, children: "Cache t\u00F6rl\u00E9se \u00E9s \u00FAjraellen\u0151rz\u00E9s" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { marginTop: "12px", fontWeight: 700 }, children: "Pluginfriss\u00EDt\u00E9s" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: updateStatus }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: updateWorking, onClick: () => void refreshUpdateInfo(), children: "Friss\u00EDt\u00E9sek keres\u00E9se" }) }), updateInfo?.has_update && updateInfo.latest_version && !installedUpdate ?
                SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs(DFL.ButtonItem, { layout: "below", disabled: updateWorking, onClick: installAvailableUpdate, children: ["Friss\u00EDt\u00E9s telep\u00EDt\u00E9se: v", updateInfo.latest_version] }) }) : null, installedUpdate ?
                SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: updateWorking, onClick: reloadAfterUpdate, children: "Plugin \u00FAjrat\u00F6lt\u00E9se" }) }) : null] });
}
var index = DFL.definePlugin(() => {
    void loadBadgeVisibility();
    notificationTimer = window.setTimeout(() => void checkBackgroundNotifications(), 10_000);
    const removeTilePatch = patchLibraryTiles();
    const removeLibraryDetailPatch = patchLibraryDetails();
    const removeStorePatch = patchSteamStore();
    return {
        name: "Xbox Controller Check",
        titleView: SP_JSX.jsx("div", { className: DFL.staticClasses.Title, children: "Xbox Controller Check" }),
        content: SP_JSX.jsx(Content, {}),
        icon: SP_JSX.jsx("span", { children: "\u2713" }),
        onDismount: () => {
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
