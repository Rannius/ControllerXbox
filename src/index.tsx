import { ButtonItem, definePlugin, findInReactTree, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { callable, toaster } from "@decky/api";
import { createElement, ReactElement, useEffect, useState } from "react";

const BACKEND_TIMEOUT_MS = 15_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const TILE_STATUS_EVENT = "controller-xbox-tile-status";
const BADGE_KEY = "controller-xbox-tile-badge";

type SupportResponse = {
  success: boolean;
  support?: Record<string, boolean>;
  levels?: Record<string, "full" | "partial" | "none">;
  unavailable?: string[];
};
type CacheStats = { entries: number; fresh_entries: number; ttl_days: number };
type BackendDiagnostics = CacheStats & { success: boolean; backend: string; settings_directory: string };
type BadgeState = "loading" | "full" | "partial" | "unsupported" | "unavailable";

type TileOverview = {
  appid: number;
  BIsModOrShortcut?: () => boolean;
};
type TileProps = { app?: TileOverview };
type TileRender = (this: unknown, ...args: unknown[]) => ReactElement;
type TileMemo = {
  $$typeof: symbol;
  type: TileRender;
  __controllerXboxOriginalType?: TileRender;
};
type WrappedTileRender = TileRender & {
  __controllerXboxWrapper?: true;
  __controllerXboxMemo?: TileMemo;
};
type WebpackRequire = {
  (id: string): unknown;
  m: Record<string, unknown>;
};

const getControllerSupport = callable<[appIds: string[]], SupportResponse>("get_controller_support");
const clearCache = callable<[], { success: boolean; removed: number }>("clear_cache");
const getCacheStats = callable<[], CacheStats>("get_cache_stats");
const getBackendDiagnostics = callable<[], BackendDiagnostics>("get_backend_diagnostics");

const supportStates = new Map<string, BadgeState>();
const visibleAppIds = new Map<string, number>();
const supportListeners = new Set<() => void>();
const pendingAppIds = new Set<string>();
let batchTimer: number | undefined;
let tileMemo: TileMemo | null = null;
let originalTileType: TileRender | null = null;
let tileIconRowClass = "";

function withBackendTimeout<T>(request: Promise<T>): Promise<T> {
  return Promise.race([
    request,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("A Decky backend 15 másodpercen belül nem válaszolt.")), BACKEND_TIMEOUT_MS);
    }),
  ]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.name + ": " + error.message;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Fall through to the string representation below.
  }
  return String(error);
}

function notifyCacheChanged(): void {
  window.dispatchEvent(new Event(CACHE_CHANGED_EVENT));
}

function notifyTileStatus(message: string): void {
  window.dispatchEvent(new CustomEvent<string>(TILE_STATUS_EVENT, { detail: message }));
}

function publishSupportState(): void {
  for (const listener of supportListeners) listener();
  const visible = Array.from(visibleAppIds.keys());
  const checked = visible.filter((id) => ["full", "partial", "unsupported"].includes(supportStates.get(id) ?? "")).length;
  const full = visible.filter((id) => supportStates.get(id) === "full").length;
  const partial = visible.filter((id) => supportStates.get(id) === "partial").length;
  const unavailable = visible.filter((id) => supportStates.get(id) === "unavailable").length;
  notifyTileStatus(
    "Látható játékok ellenőrzése: " + String(checked) + "/" + String(visible.length) +
    ". Teljes támogatás: " + String(full) + ". Részleges támogatás: " + String(partial) +
    (unavailable ? ". Nem sikerült lekérdezni: " + String(unavailable) + "." : "."),
  );
}

async function flushSupportBatch(): Promise<void> {
  batchTimer = undefined;
  const appIds = Array.from(pendingAppIds);
  pendingAppIds.clear();
  if (!appIds.length) return;

  try {
    const response = await withBackendTimeout(getControllerSupport(appIds));
    for (const appId of appIds) {
      const level = response.levels?.[appId];
      const value = response.support?.[appId];
      if (level === "full") supportStates.set(appId, "full");
      else if (level === "partial") supportStates.set(appId, "partial");
      else if (level === "none") supportStates.set(appId, "unsupported");
      else if (value === true) supportStates.set(appId, "full");
      else if (value === false) supportStates.set(appId, "unsupported");
      else supportStates.set(appId, "unavailable");
    }
  } catch (error) {
    for (const appId of appIds) supportStates.set(appId, "unavailable");
    notifyTileStatus("A kompatibilitási adatok lekérése sikertelen: " + errorMessage(error));
    console.warn("ControllerXbox tile lookup failed", error);
  }
  publishSupportState();
  notifyCacheChanged();
}

function queueSupportLookup(appId: string): void {
  const current = supportStates.get(appId);
  if (current && current !== "unavailable") return;
  supportStates.set(appId, "loading");
  pendingAppIds.add(appId);
  if (batchTimer === undefined) batchTimer = window.setTimeout(() => void flushSupportBatch(), 120);
}

function resetVisibleSupport(): void {
  supportStates.clear();
  pendingAppIds.clear();
  for (const appId of visibleAppIds.keys()) queueSupportLookup(appId);
  publishSupportState();
}

function ControllerIcon({ level, appId }: { level: "full" | "partial"; appId: number }) {
  const halfClipId = "controller-xbox-half-" + String(appId);
  const controllerPath = "M5.4 5.5h13.2c1.5 0 2.8 1 3.2 2.5l1.1 5c.4 1.8-.9 3.5-2.7 3.5-.8 0-1.5-.3-2-.9L15.6 13H8.4l-2.6 2.6c-.5.6-1.2.9-2 .9-1.8 0-3.1-1.7-2.7-3.5l1.1-5c.4-1.5 1.7-2.5 3.2-2.5Z";
  const partial = level === "partial";
  return <svg width="24" height="20" viewBox="0 0 24 22" aria-hidden="true">
    {partial && <defs><clipPath id={halfClipId}><rect x="0" y="0" width="12" height="22" /></clipPath></defs>}
    <path d={controllerPath} fill={partial ? "none" : "currentColor"} stroke="currentColor" strokeWidth="1.4" />
    {partial && <path d={controllerPath} fill="currentColor" clipPath={"url(#" + halfClipId + ")"} />}
    <path d="M5.4 9.7h3.2M7 8.1v3.2" fill="none" stroke="#107cde" strokeWidth="1.25" strokeLinecap="round" />
    <circle cx="17.1" cy="8.7" r=".9" fill={partial ? "currentColor" : "#107cde"} />
    <circle cx="19.2" cy="10.7" r=".9" fill={partial ? "currentColor" : "#107cde"} />
  </svg>;
}

function XboxTileBadge({ appId }: { appId: number }) {
  const appIdText = String(appId);
  const [state, setState] = useState<BadgeState>(() => supportStates.get(appIdText) ?? "loading");

  useEffect(() => {
    visibleAppIds.set(appIdText, (visibleAppIds.get(appIdText) ?? 0) + 1);
    const listener = () => setState(supportStates.get(appIdText) ?? "loading");
    supportListeners.add(listener);
    queueSupportLookup(appIdText);
    publishSupportState();
    return () => {
      supportListeners.delete(listener);
      const remaining = (visibleAppIds.get(appIdText) ?? 1) - 1;
      if (remaining > 0) visibleAppIds.set(appIdText, remaining);
      else visibleAppIds.delete(appIdText);
      publishSupportState();
    };
  }, [appIdText]);

  const appearance: Record<BadgeState, { symbol: string; background: string; title: string }> = {
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
  return <span
    title={badge.title}
    style={{
      position: "absolute",
      top: "6px",
      left: "6px",
      zIndex: 100,
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
    }}
  >{controllerLevel ? <ControllerIcon level={controllerLevel} appId={appId} /> : badge.symbol}</span>;
}

function appendBadgeToTile(result: ReactElement, appId: number): ReactElement {
  const row = findInReactTree(result, (node: any) => {
    const className = node?.props?.className;
    return typeof className === "string" && className.includes(tileIconRowClass);
  }) as ReactElement | undefined;
  const props = row?.props as { children?: unknown } | undefined;
  if (!props) return result;
  const existing = Array.isArray(props.children) ? props.children : [props.children];
  if (existing.some((child: any) => child?.key === BADGE_KEY)) return result;
  const badge = createElement(XboxTileBadge, { key: BADGE_KEY, appId });
  if (Array.isArray(props.children)) props.children.push(badge);
  else if (props.children !== undefined && props.children !== null) props.children = [props.children, badge];
  else props.children = [badge];
  return result;
}

function resolveOriginalTileType(self: unknown): TileRender | null {
  const candidates = [
    (wrappedTileType as WrappedTileRender).__controllerXboxMemo?.__controllerXboxOriginalType,
    (self as TileMemo | null)?.__controllerXboxOriginalType,
    originalTileType,
    tileMemo?.__controllerXboxOriginalType,
  ];
  return candidates.find((candidate) => typeof candidate === "function" && candidate !== wrappedTileType) ?? null;
}

function wrappedTileType(this: unknown, ...args: unknown[]): ReactElement {
  const original = resolveOriginalTileType(this);
  if (!original) return createElement("div");
  const result = original.apply(this, args);
  try {
    const app = (args[0] as TileProps | undefined)?.app;
    if (!app || !Number.isInteger(app.appid) || app.appid <= 0 || app.BIsModOrShortcut?.()) return result;
    return appendBadgeToTile(result, app.appid);
  } catch (error) {
    console.debug("ControllerXbox tile injection skipped", error);
    return result;
  }
}

function getWebpackRequire(): WebpackRequire | null {
  const chunk = (window as unknown as { webpackChunksteamui?: unknown[] }).webpackChunksteamui;
  if (!Array.isArray(chunk)) return null;
  let webpackRequire: WebpackRequire | undefined;
  try {
    chunk.push([["controller_xbox_" + String(Date.now())], {}, (value: WebpackRequire) => { webpackRequire = value; }] as never);
  } catch {
    return null;
  }
  return webpackRequire?.m ? webpackRequire : null;
}

function findTileMemo(webpackRequire: WebpackRequire): TileMemo | null {
  const reactMemo = Symbol.for("react.memo");
  for (const id of Object.keys(webpackRequire.m)) {
    let source = "";
    try { source = String(webpackRequire.m[id]); } catch { continue; }
    if (!source.includes("LibraryItemIcons") || !source.includes("BIsModOrShortcut") || !source.includes("BIsMusicAlbum")) continue;
    let moduleValue: unknown;
    try { moduleValue = webpackRequire(id); } catch { continue; }
    if ((typeof moduleValue !== "object" || moduleValue === null) && typeof moduleValue !== "function") continue;
    let exportKeys: string[];
    try { exportKeys = Object.keys(moduleValue); } catch { continue; }
    for (const key of exportKeys) {
      let value: unknown;
      try { value = (moduleValue as Record<string, unknown>)[key]; } catch { continue; }
      const memo = value as TileMemo | null;
      if (memo?.$$typeof === reactMemo && typeof memo.type === "function") return memo;
    }
  }
  return null;
}

function resolveTileIconRowClass(webpackRequire: WebpackRequire): string {
  for (const id of Object.keys(webpackRequire.m)) {
    let source = "";
    try { source = String(webpackRequire.m[id]); } catch { continue; }
    if (!source.includes("LibraryItemIcons")) continue;
    let moduleValue: unknown;
    try { moduleValue = webpackRequire(id); } catch { continue; }
    if ((typeof moduleValue !== "object" || moduleValue === null) && typeof moduleValue !== "function") continue;
    let defaultExport: unknown;
    try { defaultExport = (moduleValue as Record<string, unknown>).default; } catch { defaultExport = undefined; }
    for (const candidate of [moduleValue, defaultExport]) {
      if (!candidate || typeof candidate !== "object") continue;
      let libraryItemIcons: unknown;
      try { libraryItemIcons = (candidate as Record<string, unknown>).LibraryItemIcons; } catch { continue; }
      if (typeof libraryItemIcons === "string") return libraryItemIcons;
    }
  }
  return "";
}

function patchLibraryTiles(): () => void {
  try {
    const webpackRequire = getWebpackRequire();
    const memo = webpackRequire ? findTileMemo(webpackRequire) : null;
    tileIconRowClass = webpackRequire ? resolveTileIconRowClass(webpackRequire) : "";
    if (!memo || !tileIconRowClass) {
      notifyTileStatus("A Steam könyvtári csempekomponens nem található; a jelölés nem aktív.");
      console.warn("ControllerXbox library tile component was not found");
      return () => {};
    }

    tileMemo = memo;
    const current = memo.type as WrappedTileRender;
    originalTileType = memo.__controllerXboxOriginalType ?? (current.__controllerXboxWrapper ? null : current);
    if (!originalTileType) {
      notifyTileStatus("A könyvtári csempe patch korábbi példánya nem állítható helyre.");
      return () => {};
    }
    memo.__controllerXboxOriginalType = originalTileType;
    const wrapper = wrappedTileType as WrappedTileRender;
    wrapper.__controllerXboxWrapper = true;
    wrapper.__controllerXboxMemo = memo;
    memo.type = wrapper;
    notifyTileStatus("A könyvtári csempejelölés aktív. Nyisd meg vagy frissítsd a Könyvtárat.");

    return () => {
      if (tileMemo?.type === wrapper && originalTileType) tileMemo.type = originalTileType;
      if (tileMemo?.type !== wrapper) delete tileMemo?.__controllerXboxOriginalType;
      tileMemo = null;
      originalTileType = null;
      tileIconRowClass = "";
      supportListeners.clear();
      visibleAppIds.clear();
      pendingAppIds.clear();
      if (batchTimer !== undefined) window.clearTimeout(batchTimer);
      batchTimer = undefined;
    };
  } catch (error) {
    notifyTileStatus("A könyvtári csempejelölés biztonságosan leállt: " + errorMessage(error));
    console.error("ControllerXbox library tile patch failed", error);
    return () => {};
  }
}

function Content() {
  const [stats, setStats] = useState<CacheStats>();
  const [status, setStatus] = useState("A könyvtári csempejelölés indul. Nyisd meg vagy frissítsd a Könyvtárat.");
  const [diagnosticLog, setDiagnosticLog] = useState("Nincs rögzített hiba.");
  const [working, setWorking] = useState(false);

  const refreshStats = async () => {
    try {
      setStats(await withBackendTimeout(getCacheStats()));
    } catch (error) {
      setDiagnosticLog("Cache állapot: " + errorMessage(error));
    }
  };

  useEffect(() => {
    void refreshStats();
    const onCacheChanged = () => void refreshStats();
    const onTileStatus = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) setStatus(detail);
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
    } catch (error) {
      const message = errorMessage(error);
      setStatus("Cache hiba: " + message);
      setDiagnosticLog("Cache törlése: " + message);
    } finally {
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
    } catch (error) {
      const message = errorMessage(error);
      setStatus("Backend hiba: " + message);
      setDiagnosticLog("Backend ellenőrzése: " + message);
    } finally {
      setWorking(false);
    }
  };

  return <PanelSection title="Xbox Controller Check">
    <PanelSectionRow><div>A könyvtári bélyegképek jelölése: teli kontroller = teljes támogatás; félig kitöltött kontroller = részleges támogatás; piros × = nincs támogatás; narancssárga ? = nincs Steam-adat.</div></PanelSectionRow>
    <PanelSectionRow><div>{status}</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? String(stats.entries) + " játék van memóriában; " + String(stats.fresh_entries) + " bejegyzés friss (" + String(stats.ttl_days) + " napos cache)." : "A cache-számláló betöltése folyamatban..."}</div></PanelSectionRow>
    <PanelSectionRow><div style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>Hibanapló: {diagnosticLog}</div></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={working} onClick={backendCheck}>Látható játékok újraellenőrzése</ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={working} onClick={clearAndRefresh}>Cache törlése és újraellenőrzés</ButtonItem></PanelSectionRow>
  </PanelSection>;
}

export default definePlugin(() => {
  const removeTilePatch = patchLibraryTiles();
  return {
    name: "Xbox Controller Check",
    titleView: <div className={staticClasses.Title}>Xbox Controller Check</div>,
    content: <Content />,
    icon: <span>✓</span>,
    onDismount: removeTilePatch,
  };
});
