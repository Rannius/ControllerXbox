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

const BADGE_CLASS = "controller-xbox-badge";
const HOME_BADGE_ID = "controller-xbox-home-badge";
const BACKEND_TIMEOUT_MS = 8_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const REFRESH_EVENT = "controller-xbox-refresh";
const APP_ID_ATTRIBUTES = ["data-appid", "data-gameid", "data-detailed-appid", "data-app-id", "data-ds-appid"];
const APP_ID_SELECTOR = "[data-appid], [data-gameid], [data-detailed-appid], [data-app-id], [data-ds-appid], a[href*='/app/'], a[href*='steam://rungameid/']";
const getControllerSupport = callable("get_controller_support");
const clearCache = callable("clear_cache");
const getCacheStats = callable("get_cache_stats");
const getBackendDiagnostics = callable("get_backend_diagnostics");
function withBackendTimeout(request) {
    return Promise.race([
        request,
        new Promise((_, reject) => {
            window.setTimeout(() => reject(new Error("A Decky backend 8 masodpercen belul nem valaszolt.")), BACKEND_TIMEOUT_MS);
        }),
    ]);
}
function errorMessage(error) {
    if (error instanceof Error)
        return `${error.name}: ${error.message}`;
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
function appIdFrom(element) {
    const related = [element, element.closest("a"), element.closest(APP_ID_SELECTOR)].filter((item) => item !== null);
    for (const item of related) {
        for (const attribute of APP_ID_ATTRIBUTES) {
            const match = item.getAttribute(attribute)?.match(/\d+/);
            if (match)
                return match[0];
        }
    }
    const href = element.getAttribute("href") || element.closest("a")?.getAttribute("href") || "";
    return href.match(/(?:\/app\/|steam:\/\/rungameid\/)(\d+)/)?.[1];
}
function isVisible(element) {
    const box = element.getBoundingClientRect();
    return box.width > 40 && box.height > 40 && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
}
function findVisibleGameElements() {
    const candidates = document.querySelectorAll(APP_ID_SELECTOR);
    const games = new Map();
    candidates.forEach((candidate) => {
        if (!isVisible(candidate))
            return;
        const appId = appIdFrom(candidate);
        if (!appId)
            return;
        const target = candidate.closest("[class*='LibraryTile'], [class*='GameTile'], [class*='Capsule'], a") || candidate;
        const elements = games.get(appId) || [];
        if (!elements.includes(target))
            elements.push(target);
        games.set(appId, elements);
    });
    return games;
}
function addBadge(target) {
    if (target.querySelector(`:scope > .${BADGE_CLASS}`))
        return;
    const htmlTarget = target;
    if (getComputedStyle(htmlTarget).position === "static")
        htmlTarget.style.position = "relative";
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.textContent = "\u2713 Xbox";
    badge.title = "Steam: Full Controller Support";
    htmlTarget.appendChild(badge);
}
function syncHomeLabel(hasGames) {
    const old = document.getElementById(HOME_BADGE_ID);
    const isHome = /library\/home/.test(location.hash) || /library\/home/.test(location.pathname);
    if (!hasGames || !isHome || old)
        return;
    const root = document.querySelector("[class*='Home'], [class*='home']");
    if (!root)
        return;
    const label = document.createElement("div");
    label.id = HOME_BADGE_ID;
    label.textContent = "\u2713 Xbox — Full Controller Support";
    root.prepend(label);
}
function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
    .${BADGE_CLASS}, #${HOME_BADGE_ID} { background:#107cde; color:#fff; font-weight:700; border-radius:4px; box-shadow:0 1px 4px #0009; font-family:Arial,sans-serif; z-index:20; }
    .${BADGE_CLASS} { position:absolute; top:6px; left:6px; padding:3px 6px; font-size:12px; line-height:14px; pointer-events:none; }
    #${HOME_BADGE_ID} { display:inline-block; margin:8px 16px; padding:5px 9px; font-size:14px; }
  `;
    document.head.appendChild(style);
    return () => style.remove();
}
function startLibraryBadges() {
    const removeStyles = installStyles();
    let timer;
    let disposed = false;
    let enabled = false;
    let lastCheckSignature = "";
    const refresh = async () => {
        if (disposed)
            return;
        const games = findVisibleGameElements();
        syncHomeLabel(games.size > 0);
        if (!games.size) {
            if (lastCheckSignature !== "0/0/0") {
                lastCheckSignature = "0/0/0";
                window.dispatchEvent(new CustomEvent(CACHE_CHANGED_EVENT, { detail: { visible: 0, checked: 0, supported: 0 } }));
            }
            return;
        }
        try {
            const response = await getControllerSupport([...games.keys()]);
            if (disposed || !response.success)
                return;
            Object.entries(response.support || {}).forEach(([appId, supported]) => {
                if (supported)
                    games.get(appId)?.forEach(addBadge);
            });
            const support = response.support || {};
            const detail = {
                visible: games.size,
                checked: Object.keys(support).length,
                supported: Object.values(support).filter(Boolean).length,
            };
            const signature = `${detail.visible}/${detail.checked}/${detail.supported}`;
            if (signature !== lastCheckSignature) {
                lastCheckSignature = signature;
                window.dispatchEvent(new CustomEvent(CACHE_CHANGED_EVENT, { detail }));
            }
        }
        catch (error) {
            console.debug("ControllerXbox lookup failed", error);
        }
    };
    const schedule = () => {
        if (!enabled)
            return;
        window.clearTimeout(timer);
        timer = window.setTimeout(refresh, 250);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("hashchange", schedule);
    const refreshNow = () => {
        enabled = true;
        document.querySelectorAll(`.${BADGE_CLASS}, #${HOME_BADGE_ID}`).forEach((node) => node.remove());
        schedule();
    };
    window.addEventListener(REFRESH_EVENT, refreshNow);
    return () => {
        disposed = true;
        observer.disconnect();
        window.removeEventListener("scroll", schedule, true);
        window.removeEventListener("hashchange", schedule);
        window.removeEventListener(REFRESH_EVENT, refreshNow);
        window.clearTimeout(timer);
        document.querySelectorAll(`.${BADGE_CLASS}, #${HOME_BADGE_ID}`).forEach((node) => node.remove());
        removeStyles();
    };
}
function Content() {
    const [stats, setStats] = SP_REACT.useState();
    const [libraryCheck, setLibraryCheck] = SP_REACT.useState();
    const [statusError, setStatusError] = SP_REACT.useState();
    const [runStatus, setRunStatus] = SP_REACT.useState("Kesz az ellenorzes inditasara.");
    const [starting, setStarting] = SP_REACT.useState(false);
    const [diagnosticLog, setDiagnosticLog] = SP_REACT.useState("Nincs rogzitett hiba.");
    const rememberError = (where, error) => {
        const message = errorMessage(error);
        setStatusError(message);
        setDiagnosticLog(`${where}: ${message}`);
        return message;
    };
    const refreshStats = async () => {
        try {
            setStats(await withBackendTimeout(getCacheStats()));
            setStatusError(undefined);
        }
        catch (error) {
            rememberError("Cache status", error);
        }
    };
    SP_REACT.useEffect(() => {
        const onCacheChanged = (event) => {
            const detail = event.detail;
            if (detail)
                setLibraryCheck(detail);
            void refreshStats();
        };
        window.addEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
        return () => window.removeEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
    }, []);
    const startCheck = async () => {
        setStarting(true);
        setStatusError(undefined);
        setRunStatus("Backend ellenorzese es a lathato jatekok vizsgalata folyamatban...");
        try {
            const diagnostics = await withBackendTimeout(getBackendDiagnostics());
            setStats(diagnostics);
            setRunStatus(`Backend rendben. Cache mappa: ${diagnostics.settings_directory}`);
            window.dispatchEvent(new Event(REFRESH_EVENT));
        }
        catch (error) {
            const message = rememberError("Backend onellenorzes", error);
            setRunStatus(`Backend hiba: ${message}`);
        }
        finally {
            setStarting(false);
        }
    };
    const clearAndRefresh = async () => {
        setStatusError(undefined);
        try {
            const response = await withBackendTimeout(clearCache());
            toaster.toast({ title: "Xbox Controller Check", body: `${response.removed} cached entries cleared.` });
            await startCheck();
        }
        catch (error) {
            const message = rememberError("Cache torles", error);
            setRunStatus(`Cache hiba: ${message}`);
        }
    };
    return SP_JSX.jsxs(DFL.PanelSection, { title: "Xbox Controller Check", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "Blue \u2713 Xbox badges mark games whose Steam Store listing has official Full Controller Support." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: runStatus }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: stats ? `${stats.entries} jatek van memoriaban; ${stats.fresh_entries} bejegyzes friss (${stats.ttl_days} napos cache).` : "A cache szamlalo az inditas utan jelenik meg." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: libraryCheck ? `${libraryCheck.checked}/${libraryCheck.visible} lathato jatek ellenorizve; ${libraryCheck.supported} kapott Xbox jelvenyt.` : "A jatek-szamlalo az inditas utan jelenik meg." }) }), statusError && SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { children: ["Cache status error: ", statusError] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { whiteSpace: "pre-wrap", userSelect: "text" }, children: ["Hibanaplo: ", diagnosticLog] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: starting, onClick: startCheck, children: starting ? "Ellenorzes folyamatban..." : "Ellenorzes inditasa" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: starting, onClick: clearAndRefresh, children: "Cache torlese es ujraellenorzes" }) })] });
}
var index = DFL.definePlugin(() => {
    const stopLibraryBadges = startLibraryBadges();
    return { name: "Xbox Controller Check", titleView: SP_JSX.jsx("div", { className: DFL.staticClasses.Title, children: "Xbox Controller Check" }), content: SP_JSX.jsx(Content, {}), icon: SP_JSX.jsx("span", { children: "\u2713" }), onDismount: stopLibraryBadges };
});

export { index as default };
//# sourceMappingURL=index.js.map
