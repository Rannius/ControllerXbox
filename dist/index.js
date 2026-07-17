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
const executeInTab = api.executeInTab;

const BACKEND_TIMEOUT_MS = 8_000;
const STEAM_TAB_NAME = "Steam";
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
/*
 * The Decky quick-access panel has its own document.  These scripts deliberately
 * run in Decky's "Steam" tab, where the actual Steam Library tiles live.
 */
const STEAM_LIBRARY_PROBE_CODE = String.raw `(() => {
  const attributes = ["data-appid", "data-gameid", "data-detailed-appid", "data-app-id", "data-ds-appid"];
  const selector = "[data-appid], [data-gameid], [data-detailed-appid], [data-app-id], [data-ds-appid], [id*='app_'], [id*='app-'], [id*='game_'], [id*='game-'], [class*='app_'], [class*='app-'], [class*='game_'], [class*='game-'], a[href*='/app/'], a[href*='steam://rungameid/']";
  const appId = (element) => {
    const related = [element, element.closest("a")].filter(Boolean);
    for (const item of related) {
      for (const attribute of attributes) {
        const match = (item.getAttribute(attribute) || "").match(/\d+/);
        if (match) return match[0];
      }
      const idMatch = (item.id || "").match(/(?:app|game)[_-](\d+)/i);
      if (idMatch) return idMatch[1];
      const classMatch = (typeof item.className === "string" ? item.className : "").match(/(?:^|\s)(?:app|game)[_-](\d+)/i);
      if (classMatch) return classMatch[1];
      const href = item.getAttribute("href") || "";
      const hrefMatch = href.match(/(?:\/app\/|steam:\/\/rungameid\/)(\d+)/);
      if (hrefMatch) return hrefMatch[1];
    }
    return undefined;
  };
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 40 && box.height > 40 && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
  };
  const nodes = Array.from(document.querySelectorAll(selector));
  const ids = Array.from(new Set(nodes.filter(visible).map(appId).filter(Boolean)));
  return JSON.stringify({ ids, candidates: nodes.length, location: window.location.href });
})()`;
function steamBadgeCode(support) {
    const supportJson = JSON.stringify(support).replace(/</g, "\\u003c");
    return String.raw `(() => {
    const support = ${supportJson};
    const badgeClass = "controller-xbox-badge";
    const styleId = "controller-xbox-badge-style";
    const attributes = ["data-appid", "data-gameid", "data-detailed-appid", "data-app-id", "data-ds-appid"];
    const selector = "[data-appid], [data-gameid], [data-detailed-appid], [data-app-id], [data-ds-appid], [id*='app_'], [id*='app-'], [id*='game_'], [id*='game-'], [class*='app_'], [class*='app-'], [class*='game_'], [class*='game-'], a[href*='/app/'], a[href*='steam://rungameid/']";
    const appId = (element) => {
      const related = [element, element.closest("a")].filter(Boolean);
      for (const item of related) {
        for (const attribute of attributes) {
          const match = (item.getAttribute(attribute) || "").match(/\d+/);
          if (match) return match[0];
        }
        const idMatch = (item.id || "").match(/(?:app|game)[_-](\d+)/i);
        if (idMatch) return idMatch[1];
        const classMatch = (typeof item.className === "string" ? item.className : "").match(/(?:^|\s)(?:app|game)[_-](\d+)/i);
        if (classMatch) return classMatch[1];
        const href = item.getAttribute("href") || "";
        const hrefMatch = href.match(/(?:\/app\/|steam:\/\/rungameid\/)(\d+)/);
        if (hrefMatch) return hrefMatch[1];
      }
      return undefined;
    };
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 40 && box.height > 40 && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
    };
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = "." + badgeClass + "{position:absolute;top:6px;left:6px;z-index:9999;padding:3px 6px;border-radius:4px;background:#107cde;color:#fff;font:700 12px/14px Arial,sans-serif;box-shadow:0 1px 4px #0009;pointer-events:none}";
      document.head.appendChild(style);
    }
    document.querySelectorAll("." + badgeClass).forEach((badge) => badge.remove());
    const marked = new Set();
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      if (!visible(node)) continue;
      const id = appId(node);
      if (!id || !support[id]) continue;
      const target = node.closest("[class*='LibraryTile'], [class*='GameTile'], [class*='Capsule'], a") || node.closest("a") || node;
      if (marked.has(target)) continue;
      marked.add(target);
      if (getComputedStyle(target).position === "static") target.style.position = "relative";
      const badge = document.createElement("span");
      badge.className = badgeClass;
      badge.textContent = "✓ Xbox";
      badge.title = "Steam: Full Controller Support";
      target.appendChild(badge);
    }
    return JSON.stringify({ badged: marked.size, targets: nodes.length });
  })()`;
}
async function runInSteamTab(code) {
    const response = await executeInTab(STEAM_TAB_NAME, false, code);
    if (!response.success) {
        throw new Error(`A Steam lap kódja sikertelen volt: ${errorMessage(response.result)}`);
    }
    if (typeof response.result === "string") {
        try {
            return JSON.parse(response.result);
        }
        catch {
            throw new Error(`A Steam lap nem értelmezhető választ adott: ${response.result}`);
        }
    }
    return response.result;
}
async function checkSteamLibrary() {
    const probe = await runInSteamTab(STEAM_LIBRARY_PROBE_CODE);
    const ids = Array.isArray(probe.ids) ? [...new Set(probe.ids.filter((id) => /^\d+$/.test(id)))] : [];
    if (ids.length === 0) {
        return { check: { visible: 0, checked: 0, supported: 0, badged: 0 }, probe };
    }
    const response = await withBackendTimeout(getControllerSupport(ids));
    if (!response.success)
        throw new Error("A Decky backend nem adott sikeres ellenőrzési választ.");
    const support = response.support || {};
    const badgeResult = await runInSteamTab(steamBadgeCode(support));
    return {
        check: {
            visible: ids.length,
            checked: Object.keys(support).length,
            supported: Object.values(support).filter(Boolean).length,
            badged: badgeResult.badged,
        },
        probe,
    };
}
function Content() {
    const [stats, setStats] = SP_REACT.useState();
    const [libraryCheck, setLibraryCheck] = SP_REACT.useState();
    const [statusError, setStatusError] = SP_REACT.useState();
    const [runStatus, setRunStatus] = SP_REACT.useState("Kész az ellenőrzés indítására.");
    const [starting, setStarting] = SP_REACT.useState(false);
    const [diagnosticLog, setDiagnosticLog] = SP_REACT.useState("Nincs rögzített hiba.");
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
            rememberError("Cache állapot", error);
        }
    };
    SP_REACT.useEffect(() => {
        void refreshStats();
    }, []);
    const startCheck = async () => {
        setStarting(true);
        setStatusError(undefined);
        setRunStatus("Backend ellenőrzése és a Steam Könyvtár csempéinek keresése folyamatban...");
        try {
            const diagnostics = await withBackendTimeout(getBackendDiagnostics());
            setStats(diagnostics);
            setRunStatus("Steam Könyvtár vizsgálata folyamatban...");
            const result = await checkSteamLibrary();
            setLibraryCheck(result.check);
            await refreshStats();
            if (result.check.visible === 0) {
                setRunStatus(`A Steam lap elérhető, de 0 játékcsempe azonosítható (${result.probe.candidates} jelölt elem). Nyisd meg a Könyvtár > Kezdőlap nézetet, majd indítsd újra.`);
            }
            else {
                setRunStatus(`Kész: ${result.check.checked}/${result.check.visible} játék ellenőrizve, ${result.check.badged} kék jelvény kihelyezve.`);
                setDiagnosticLog("Nincs rögzített hiba.");
            }
        }
        catch (error) {
            const message = rememberError("Steam Könyvtár ellenőrzése", error);
            setRunStatus(`Ellenőrzési hiba: ${message}`);
        }
        finally {
            setStarting(false);
        }
    };
    const clearAndRefresh = async () => {
        setStatusError(undefined);
        setStarting(true);
        setRunStatus("Cache törlése folyamatban...");
        try {
            const response = await withBackendTimeout(clearCache());
            toaster.toast({ title: "Xbox Controller Check", body: `${response.removed} gyorsítótár-bejegyzés törölve.` });
        }
        catch (error) {
            const message = rememberError("Cache törlése", error);
            setRunStatus(`Cache hiba: ${message}`);
            setStarting(false);
            return;
        }
        setStarting(false);
        await startCheck();
    };
    return SP_JSX.jsxs(DFL.PanelSection, { title: "Xbox Controller Check", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: "A k\u00E9k \u2713 Xbox jelv\u00E9ny a Steam \u00C1ruh\u00E1z szerint teljes kontroller-t\u00E1mogat\u00E1ssal rendelkez\u0151 j\u00E1t\u00E9kokat jel\u00F6li." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: runStatus }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: stats ? `${stats.entries} játék van memóriában; ${stats.fresh_entries} bejegyzés friss (${stats.ttl_days} napos cache).` : "A cache-számláló betöltése folyamatban..." }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { children: libraryCheck ? `${libraryCheck.checked}/${libraryCheck.visible} látható játék ellenőrizve; ${libraryCheck.supported} támogatott, ${libraryCheck.badged} kék jelvény kihelyezve.` : "A játék-számláló az indítás után jelenik meg." }) }), statusError && SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { children: ["Hiba: ", statusError] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { whiteSpace: "pre-wrap", userSelect: "text" }, children: ["Hibanapl\u00F3: ", diagnosticLog] }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: starting, onClick: startCheck, children: starting ? "Ellenőrzés folyamatban..." : "Ellenőrzés indítása" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: starting, onClick: clearAndRefresh, children: "Cache t\u00F6rl\u00E9se \u00E9s \u00FAjraellen\u0151rz\u00E9s" }) })] });
}
var index = DFL.definePlugin(() => ({
    name: "Xbox Controller Check",
    titleView: SP_JSX.jsx("div", { className: DFL.staticClasses.Title, children: "Xbox Controller Check" }),
    content: SP_JSX.jsx(Content, {}),
    icon: SP_JSX.jsx("span", { children: "\u2713" }),
}));

export { index as default };
//# sourceMappingURL=index.js.map
