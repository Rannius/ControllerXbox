import { ButtonItem, definePlugin, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { callable, executeInTab, toaster } from "@decky/api";
import { useEffect, useState } from "react";

const BACKEND_TIMEOUT_MS = 8_000;
const STEAM_TAB_NAME = "Steam";

type SupportResponse = { success: boolean; support?: Record<string, boolean> };
type CacheStats = { entries: number; fresh_entries: number; ttl_days: number };
type LibraryCheck = { visible: number; checked: number; supported: number; badged: number };
type BackendDiagnostics = CacheStats & { success: boolean; backend: string; settings_directory: string };
type SteamLibraryProbe = { ids: string[]; candidates: number; location: string };
type SteamBadgeResult = { badged: number; targets: number };

const getControllerSupport = callable<[appIds: string[]], SupportResponse>("get_controller_support");
const clearCache = callable<[], { success: boolean; removed: number }>("clear_cache");
const getCacheStats = callable<[], CacheStats>("get_cache_stats");
const getBackendDiagnostics = callable<[], BackendDiagnostics>("get_backend_diagnostics");

function withBackendTimeout<T>(request: Promise<T>): Promise<T> {
  return Promise.race([
    request,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("A Decky backend 8 másodpercen belül nem válaszolt.")), BACKEND_TIMEOUT_MS);
    }),
  ]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Fall through to the string representation below.
  }
  return String(error);
}

/*
 * The Decky quick-access panel has its own document.  These scripts deliberately
 * run in Decky's "Steam" tab, where the actual Steam Library tiles live.
 */
const STEAM_LIBRARY_PROBE_CODE = String.raw`(() => {
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

function steamBadgeCode(support: Record<string, boolean>): string {
  const supportJson = JSON.stringify(support).replace(/</g, "\\u003c");
  return String.raw`(() => {
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

async function runInSteamTab<T>(code: string): Promise<T> {
  const response = await executeInTab(STEAM_TAB_NAME, false, code);
  if (!response.success) {
    throw new Error(`A Steam lap kódja sikertelen volt: ${errorMessage(response.result)}`);
  }
  if (typeof response.result === "string") {
    try {
      return JSON.parse(response.result) as T;
    } catch {
      throw new Error(`A Steam lap nem értelmezhető választ adott: ${response.result}`);
    }
  }
  return response.result as T;
}

async function checkSteamLibrary(): Promise<{ check: LibraryCheck; probe: SteamLibraryProbe }> {
  const probe = await runInSteamTab<SteamLibraryProbe>(STEAM_LIBRARY_PROBE_CODE);
  const ids = Array.isArray(probe.ids) ? [...new Set(probe.ids.filter((id) => /^\d+$/.test(id)))] : [];
  if (ids.length === 0) {
    return { check: { visible: 0, checked: 0, supported: 0, badged: 0 }, probe };
  }

  const response = await withBackendTimeout(getControllerSupport(ids));
  if (!response.success) throw new Error("A Decky backend nem adott sikeres ellenőrzési választ.");
  const support = response.support || {};
  const badgeResult = await runInSteamTab<SteamBadgeResult>(steamBadgeCode(support));
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
  const [stats, setStats] = useState<CacheStats>();
  const [libraryCheck, setLibraryCheck] = useState<LibraryCheck>();
  const [statusError, setStatusError] = useState<string>();
  const [runStatus, setRunStatus] = useState("Kész az ellenőrzés indítására.");
  const [starting, setStarting] = useState(false);
  const [diagnosticLog, setDiagnosticLog] = useState("Nincs rögzített hiba.");
  const rememberError = (where: string, error: unknown) => {
    const message = errorMessage(error);
    setStatusError(message);
    setDiagnosticLog(`${where}: ${message}`);
    return message;
  };
  const refreshStats = async () => {
    try {
      setStats(await withBackendTimeout(getCacheStats()));
      setStatusError(undefined);
    } catch (error) {
      rememberError("Cache állapot", error);
    }
  };
  useEffect(() => {
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
      } else {
        setRunStatus(`Kész: ${result.check.checked}/${result.check.visible} játék ellenőrizve, ${result.check.badged} kék jelvény kihelyezve.`);
        setDiagnosticLog("Nincs rögzített hiba.");
      }
    } catch (error) {
      const message = rememberError("Steam Könyvtár ellenőrzése", error);
      setRunStatus(`Ellenőrzési hiba: ${message}`);
    } finally {
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
    } catch (error) {
      const message = rememberError("Cache törlése", error);
      setRunStatus(`Cache hiba: ${message}`);
      setStarting(false);
      return;
    }
    setStarting(false);
    await startCheck();
  };
  return <PanelSection title="Xbox Controller Check">
    <PanelSectionRow><div>A kék ✓ Xbox jelvény a Steam Áruház szerint teljes kontroller-támogatással rendelkező játékokat jelöli.</div></PanelSectionRow>
    <PanelSectionRow><div>{runStatus}</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? `${stats.entries} játék van memóriában; ${stats.fresh_entries} bejegyzés friss (${stats.ttl_days} napos cache).` : "A cache-számláló betöltése folyamatban..."}</div></PanelSectionRow>
    <PanelSectionRow><div>{libraryCheck ? `${libraryCheck.checked}/${libraryCheck.visible} látható játék ellenőrizve; ${libraryCheck.supported} támogatott, ${libraryCheck.badged} kék jelvény kihelyezve.` : "A játék-számláló az indítás után jelenik meg."}</div></PanelSectionRow>
    {statusError && <PanelSectionRow><div>Hiba: {statusError}</div></PanelSectionRow>}
    <PanelSectionRow><div style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>Hibanapló: {diagnosticLog}</div></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={starting} onClick={startCheck}>{starting ? "Ellenőrzés folyamatban..." : "Ellenőrzés indítása"}</ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={starting} onClick={clearAndRefresh}>Cache törlése és újraellenőrzés</ButtonItem></PanelSectionRow>
  </PanelSection>;
}

export default definePlugin(() => ({
  name: "Xbox Controller Check",
  titleView: <div className={staticClasses.Title}>Xbox Controller Check</div>,
  content: <Content />,
  icon: <span>✓</span>,
}));
