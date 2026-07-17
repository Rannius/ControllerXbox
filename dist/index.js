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

const BACKEND_TIMEOUT_MS = 8_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const getControllerSupport = callable("get_controller_support");
const clearCache = callable("clear_cache");
const getCacheStats = callable("get_cache_stats");
const getBackendDiagnostics = callable("get_backend_diagnostics");
function withBackendTimeout(request) {
    return Promise.race([
        request,
        new Promise((_, reject) => {
            window.setTimeout(() => reject(new Error("A Decky backend 8 másodpercen belül nem válaszolt.")), BACKEND_TIMEOUT_MS);
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
function XboxBadge({ appId }) {
    const [supported, setSupported] = SP_REACT.useState();
    SP_REACT.useEffect(() => {
        let disposed = false;
        const refresh = async () => {
            try {
                const response = await withBackendTimeout(getControllerSupport([String(appId)]));
                if (disposed)
                    return;
                setSupported(Boolean(response.success && response.support?.[String(appId)]));
                notifyCacheChanged();
            }
            catch (error) {
                console.debug("ControllerXbox app-detail lookup failed", error);
            }
        };
        void refresh();
        window.addEventListener(CACHE_CHANGED_EVENT, refresh);
        return () => {
            disposed = true;
            window.removeEventListener(CACHE_CHANGED_EVENT, refresh);
        };
    }, [appId]);
    if (!supported)
        return null;
    return SP_JSX.jsxs("div", { className: "controller-xbox-badge-container", children: [SP_JSX.jsx("style", { children: ".controller-xbox-badge-container{position:absolute;top:2.8vw;right:16px;z-index:50;pointer-events:none}.controller-xbox-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:5px;background:#107cde;color:#fff;box-shadow:0 1px 4px #0009;font:700 13px/16px Arial,sans-serif}" }), SP_JSX.jsx("span", { className: "controller-xbox-badge", title: "Steam: Full Controller Support", children: "\u2713 Xbox" })] });
}
function XboxBadgeAnchor({ appId }) {
    return SP_JSX.jsx("div", { id: "controller-xbox-badge-anchor", style: { position: "static", height: 0 }, children: SP_JSX.jsx(XboxBadge, { appId: appId }) });
}
function patchLibraryAppRoute() {
    const route = "/library/app/:appid";
    const routePatch = routerHook.addPatch(route, (tree) => {
        const routeProps = DFL.findInReactTree(tree, (node) => node?.renderFunc);
        if (!routeProps)
            return tree;
        const patchHandler = DFL.createReactTreePatcher([
            (renderTree) => {
                const children = DFL.findInReactTree(renderTree, (node) => node?.props?.children?.props?.overview)?.props?.children;
                return typeof children === "object" ? children : null;
            },
        ], (_, result) => {
            if (!result)
                return result;
            const parent = DFL.findInReactTree(result, (node) => Array.isArray(node?.props?.children) && typeof node?.props?.className === "string" && node.props.className.includes(DFL.appDetailsClasses.InnerContainer));
            if (!parent?.props?.children)
                return result;
            const appPanel = parent.props.children.find((child) => typeof child?.props?.overview?.appid === "number");
            const appId = appPanel?.props?.overview?.appid;
            if (!appPanel || typeof appId !== "number")
                return result;
            if (parent.props.children.some((child) => child?.props?.id === "controller-xbox-badge-anchor"))
                return result;
            const appPanelIndex = parent.props.children.indexOf(appPanel);
            parent.props.children.splice(Math.max(0, appPanelIndex), 0, SP_JSX.jsx(XboxBadgeAnchor, { appId: appId }, "controller-xbox-badge-anchor"));
            return result;
        });
        DFL.afterPatch(routeProps, "renderFunc", patchHandler);
        return tree;
    });
    return () => routerHook.removePatch(route, routePatch);
}
function Content() {
    const [stats, setStats] = SP_REACT.useState();
    const [status, setStatus] = SP_REACT.useState("Nyiss meg egy játék adatlapját a Könyvtárban; a jelvény ott automatikusan megjelenik.");
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
        window.addEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
        return () => window.removeEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
    }, []);
    const clearAndRefresh = async () => {
        setWorking(true);
        setStatus("Cache törlése folyamatban...");
        try {
            const response = await withBackendTimeout(clearCache());
            toaster.toast({ title: "Xbox Controller Check", body: String(response.removed) + " gyorsítótár-bejegyzés törölve." });
            notifyCacheChanged();
            await refreshStats();
            setStatus("Kész. Nyisd meg újra a játék adatlapját a friss ellenőrzéshez.");
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
            setStatus("Backend rendben. Nyiss meg egy játék adatlapját; a kék ✓ Xbox jelvény a jobb felső részen jelenik meg.");
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
    return SP_JSX.jsxs(DFL.PanelSection, { title: "Xbox Controller Check", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "A MoonDeckhez hasonl\u00F3, Steam-adatlapba illesztett k\u00E9k \u2713 Xbox jelv\u00E9ny." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: status }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: stats ? String(stats.entries) + " játék van memóriában; " + String(stats.fresh_entries) + " bejegyzés friss (" + String(stats.ttl_days) + " napos cache)." : "A cache-számláló betöltése folyamatban..." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { whiteSpace: "pre-wrap", userSelect: "text" }, children: ["Hibanapl\u00F3: ", diagnosticLog] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working, onClick: backendCheck, children: "Backend ellen\u0151rz\u00E9se" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: working, onClick: clearAndRefresh, children: "Cache t\u00F6rl\u00E9se \u00E9s friss\u00EDt\u00E9s" }) })] });
}
var index = DFL.definePlugin(() => {
    const removeLibraryPatch = patchLibraryAppRoute();
    return {
        name: "Xbox Controller Check",
        titleView: SP_JSX.jsx("div", { className: DFL.staticClasses.Title, children: "Xbox Controller Check" }),
        content: SP_JSX.jsx(Content, {}),
        icon: SP_JSX.jsx("span", { children: "\u2713" }),
        onDismount: removeLibraryPatch,
    };
});

export { index as default };
//# sourceMappingURL=index.js.map
