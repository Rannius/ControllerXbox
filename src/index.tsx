import { ButtonItem, definePlugin, findInReactTree, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { callable, toaster } from "@decky/api";
import { createElement, ReactElement, useEffect, useState } from "react";

const BACKEND_TIMEOUT_MS = 15_000;
const CATALOG_BACKEND_TIMEOUT_MS = 60_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const TILE_STATUS_EVENT = "controller-xbox-tile-status";
const BADGE_KEY = "controller-xbox-tile-badge";

type SupportResponse = {
  success: boolean;
  support?: Record<string, boolean>;
  levels?: Record<string, "full" | "partial" | "none">;
  unavailable?: string[];
};
type GfnResponse = {
  success: boolean;
  availability?: Record<string, boolean>;
  unavailable?: string[];
  catalog_entries?: number;
  error?: string;
};
type BoosteroidResponse = {
  success: boolean;
  availability?: Record<string, boolean>;
  maintenance?: Record<string, boolean>;
  unavailable?: string[];
  catalog_entries?: number;
  error?: string;
};
type CacheStats = {
  entries: number;
  fresh_entries: number;
  ttl_days: number;
  gfn_catalog_entries?: number;
  gfn_cache_fresh?: boolean;
  boosteroid_catalog_entries?: number;
  boosteroid_cache_fresh?: boolean;
};
type BackendDiagnostics = CacheStats & { success: boolean; backend: string; settings_directory: string };
type BadgeState = "loading" | "full" | "partial" | "unsupported" | "unavailable";
type GfnState = "loading" | "available" | "not_available" | "unavailable";
type BoosteroidState = "loading" | "available" | "maintenance" | "not_available" | "unavailable";

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
const getGfnAvailability = callable<[appIds: string[]], GfnResponse>("get_gfn_availability");
const getBoosteroidAvailability = callable<[appIds: string[]], BoosteroidResponse>("get_boosteroid_availability");
const clearCache = callable<[], { success: boolean; removed: number; gfn_removed?: number; boosteroid_removed?: number }>("clear_cache");
const getCacheStats = callable<[], CacheStats>("get_cache_stats");
const getBackendDiagnostics = callable<[], BackendDiagnostics>("get_backend_diagnostics");

const supportStates = new Map<string, BadgeState>();
const gfnStates = new Map<string, GfnState>();
const boosteroidStates = new Map<string, BoosteroidState>();
const visibleAppIds = new Map<string, number>();
const supportListeners = new Set<() => void>();
const pendingAppIds = new Set<string>();
let batchTimer: number | undefined;
let tileMemo: TileMemo | null = null;
let originalTileType: TileRender | null = null;
let tileIconRowClass = "";

function withBackendTimeout<T>(request: Promise<T>, timeoutMs = BACKEND_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    request,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("A Decky backend " + String(timeoutMs / 1000) + " másodpercen belül nem válaszolt.")), timeoutMs);
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
  const gfnChecked = visible.filter((id) => ["available", "not_available"].includes(gfnStates.get(id) ?? "")).length;
  const gfnAvailable = visible.filter((id) => gfnStates.get(id) === "available").length;
  const gfnUnavailable = visible.filter((id) => gfnStates.get(id) === "unavailable").length;
  const boosteroidChecked = visible.filter((id) => ["available", "maintenance", "not_available"].includes(boosteroidStates.get(id) ?? "")).length;
  const boosteroidAvailable = visible.filter((id) => boosteroidStates.get(id) === "available").length;
  const boosteroidMaintenance = visible.filter((id) => boosteroidStates.get(id) === "maintenance").length;
  const boosteroidUnavailable = visible.filter((id) => boosteroidStates.get(id) === "unavailable").length;
  notifyTileStatus(
    "Látható játékok ellenőrzése: " + String(checked) + "/" + String(visible.length) +
    ". Teljes támogatás: " + String(full) + ". Részleges támogatás: " + String(partial) +
    (unavailable ? ". Kontrolleradat-hiba: " + String(unavailable) + "." : ".") +
    " GFN: " + String(gfnAvailable) + "/" + String(gfnChecked) +
    (gfnUnavailable ? ". GFN-adathiba: " + String(gfnUnavailable) + "." : ".") +
    " Boosteroid: " + String(boosteroidAvailable) + "/" + String(boosteroidChecked) +
    (boosteroidMaintenance ? ". Karbantartás: " + String(boosteroidMaintenance) + "." : ".") +
    (boosteroidUnavailable ? " Boosteroid-adathiba: " + String(boosteroidUnavailable) + "." : ""),
  );
}

async function flushSupportBatch(): Promise<void> {
  batchTimer = undefined;
  const appIds = Array.from(pendingAppIds);
  pendingAppIds.clear();
  if (!appIds.length) return;

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
      if (level === "full") supportStates.set(appId, "full");
      else if (level === "partial") supportStates.set(appId, "partial");
      else if (level === "none") supportStates.set(appId, "unsupported");
      else if (value === true) supportStates.set(appId, "full");
      else if (value === false) supportStates.set(appId, "unsupported");
      else supportStates.set(appId, "unavailable");
    }
  } else {
    for (const appId of appIds) supportStates.set(appId, "unavailable");
    console.warn("ControllerXbox controller lookup failed", supportResult.reason);
  }

  if (gfnResult.status === "fulfilled" && gfnResult.value.success) {
    const response = gfnResult.value;
    for (const appId of appIds) {
      const value = response.availability?.[appId];
      if (value === true) gfnStates.set(appId, "available");
      else if (value === false) gfnStates.set(appId, "not_available");
      else gfnStates.set(appId, "unavailable");
    }
  } else {
    for (const appId of appIds) gfnStates.set(appId, "unavailable");
    const error = gfnResult.status === "rejected" ? gfnResult.reason : gfnResult.value.error;
    console.warn("ControllerXbox GeForce NOW lookup failed", error);
  }

  if (boosteroidResult.status === "fulfilled" && boosteroidResult.value.success) {
    const response = boosteroidResult.value;
    for (const appId of appIds) {
      const value = response.availability?.[appId];
      const maintenance = response.maintenance?.[appId];
      if (value === true && maintenance === true) boosteroidStates.set(appId, "maintenance");
      else if (value === true) boosteroidStates.set(appId, "available");
      else if (value === false) boosteroidStates.set(appId, "not_available");
      else boosteroidStates.set(appId, "unavailable");
    }
  } else {
    for (const appId of appIds) boosteroidStates.set(appId, "unavailable");
    const error = boosteroidResult.status === "rejected" ? boosteroidResult.reason : boosteroidResult.value.error;
    console.warn("ControllerXbox Boosteroid lookup failed", error);
  }
  publishSupportState();
  notifyCacheChanged();
}

function queueSupportLookup(appId: string): void {
  const controllerReady = Boolean(supportStates.get(appId) && supportStates.get(appId) !== "unavailable");
  const gfnReady = Boolean(gfnStates.get(appId) && gfnStates.get(appId) !== "unavailable");
  const boosteroidReady = Boolean(boosteroidStates.get(appId) && boosteroidStates.get(appId) !== "unavailable");
  if (controllerReady && gfnReady && boosteroidReady) return;
  if (!controllerReady) supportStates.set(appId, "loading");
  if (!gfnReady) gfnStates.set(appId, "loading");
  if (!boosteroidReady) boosteroidStates.set(appId, "loading");
  pendingAppIds.add(appId);
  if (batchTimer === undefined) batchTimer = window.setTimeout(() => void flushSupportBatch(), 120);
}

function resetVisibleSupport(): void {
  supportStates.clear();
  gfnStates.clear();
  boosteroidStates.clear();
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

function ControllerBadge({ state, appId }: { state: BadgeState; appId: number }) {
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

function GfnBadge({ state }: { state: GfnState }) {
  const appearance: Record<GfnState, { label: string; background: string; color: string; title: string }> = {
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
  return <span
    title={badge.title}
    style={{
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
    }}
  >{badge.label}</span>;
}

function BoosteroidIcon() {
  return <svg width="27" height="18" viewBox="0 0 49 31" aria-hidden="true">
    <path
      fill="currentColor"
      d="M13.3259 3.30744C9.865 6.72998 9.549 12.1026 12.3773 15.8818L9.46609 18.7608C8.90018 19.3204 8.90018 20.2281 9.46609 20.7883C10.032 21.3479 10.9498 21.3479 11.5163 20.7883L14.4276 17.9093C18.2491 20.7063 23.682 20.3938 27.143 16.9713C30.9524 13.2041 30.9524 7.07459 27.143 3.30801C23.3336-.45857 17.1347-.459144 13.3259 3.30744ZM25.0927 14.9438C22.7653 17.2453 19.1705 17.5469 16.5103 15.8497L17.6595 14.7133C18.2254 14.1536 18.2254 13.246 17.6595 12.6858C17.0936 12.1261 16.1757 12.1261 15.6092 12.6858L14.46 13.8222C12.7438 11.1915 13.0488 7.63651 15.3762 5.33493C18.0549 2.68588 22.414 2.68588 25.0927 5.33493C27.7715 7.98398 27.7715 12.2947 25.0927 14.9438ZM16.2841 21.6272C16.85 22.1868 16.85 23.0945 16.2841 23.6547L10.1416 29.7291C9.57567 30.2887 8.65782 30.2887 8.09134 29.7291C7.52544 29.1695 7.52544 28.2618 8.09134 27.7016L14.2345 21.6272C14.8004 21.0675 15.7182 21.0675 16.2841 21.6272ZM.424426 22.1472C-.141475 21.5876-.141475 20.6799.424426 20.1197L6.56758 14.0447C7.13348 13.4851 8.05133 13.4851 8.61782 14.0447C9.18372 14.6043 9.18372 15.512 8.61782 16.0722L2.47466 22.1472C1.90818 22.7074.990907 22.7074.424426 22.1472Z"
    />
  </svg>;
}

function BoosteroidBadge({ state }: { state: BoosteroidState }) {
  const appearance: Record<BoosteroidState, { background: string; color: string; title: string }> = {
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
  return <span
    title={badge.title}
    style={{
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
    }}
  ><BoosteroidIcon /></span>;
}

function XboxTileBadge({ appId }: { appId: number }) {
  const appIdText = String(appId);
  const [state, setState] = useState<BadgeState>(() => supportStates.get(appIdText) ?? "loading");
  const [gfnState, setGfnState] = useState<GfnState>(() => gfnStates.get(appIdText) ?? "loading");
  const [boosteroidState, setBoosteroidState] = useState<BoosteroidState>(() => boosteroidStates.get(appIdText) ?? "loading");

  useEffect(() => {
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
      if (remaining > 0) visibleAppIds.set(appIdText, remaining);
      else visibleAppIds.delete(appIdText);
      publishSupportState();
    };
  }, [appIdText]);

  return <span style={{
    position: "absolute",
    top: "6px",
    left: "6px",
    zIndex: 100,
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    pointerEvents: "none",
  }}>
    <ControllerBadge state={state} appId={appId} />
    <GfnBadge state={gfnState} />
    <BoosteroidBadge state={boosteroidState} />
  </span>;
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
      supportStates.clear();
      gfnStates.clear();
      boosteroidStates.clear();
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
      toaster.toast({
        title: "Xbox Controller Check",
        body: String(response.removed) + " kontrollerbejegyzés, " + String(response.gfn_removed ?? 0) +
          " GFN-AppID és " + String(response.boosteroid_removed ?? 0) + " Boosteroid-AppID törölve.",
      });
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
    <PanelSectionRow><div>GeForce NOW: zöld GFN = játszható; szürke GFN = nincs a katalógusban; narancssárga GFN? = a katalógus nem érhető el.</div></PanelSectionRow>
    <PanelSectionRow><div>Boosteroid: kék logó = elérhető; sárga logó = karbantartás alatt; szürke logó = nincs a katalógusban; narancssárga logó = a katalógus nem érhető el.</div></PanelSectionRow>
    <PanelSectionRow><div>{status}</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? String(stats.entries) + " játék van memóriában; " + String(stats.fresh_entries) + " bejegyzés friss (" + String(stats.ttl_days) + " napos cache)." : "A cache-számláló betöltése folyamatban..."}</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? "GFN-katalógus: " + String(stats.gfn_catalog_entries ?? 0) + " Steam AppID; " + (stats.gfn_cache_fresh ? "friss (24 óránként ellenőrizve)." : "frissítésre vár.") : "A GFN-katalógus állapotának betöltése folyamatban..."}</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? "Boosteroid-katalógus: " + String(stats.boosteroid_catalog_entries ?? 0) + " Steam AppID; " + (stats.boosteroid_cache_fresh ? "friss (24 óránként ellenőrizve)." : "frissítésre vár.") : "A Boosteroid-katalógus állapotának betöltése folyamatban..."}</div></PanelSectionRow>
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
