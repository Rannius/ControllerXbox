import { getHungarianBadgeHtml, HungarianSource } from "./hungarianBadge";
import { CloudResumeRefresh } from "./cloudResumeRefresh";
import { BadgeSizeSettings, BadgeSizes } from "./BadgeSizeSettings";
import { HungarianProgress, CuratorProgress } from "./HungarianProgress";
import { CatalogStatus } from "./CatalogStatus";
import { HungarianCollection, readyCollectionStore } from "./hungarianCollection";
import { afterPatch, appDetailsClasses, ButtonItem, createReactTreePatcher, definePlugin, findInReactTree, findModuleExport, PanelSection, PanelSectionRow, staticClasses, TextField, ToggleField } from "@decky/ui";
import { callable, fetchNoCors, routerHook, toaster } from "@decky/api";
import { createElement, Fragment, ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react";

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

type SupportResponse = {
  success: boolean;
  scan_epoch?: number;
  scan_attempts?: Record<string, number>;
  scan_retry_after?: Record<string, number>;
  support?: Record<string, boolean>;
  levels?: Record<string, "full" | "partial" | "none">;
  hungarian?: Record<string, boolean | null>;
  hungarian_sources?: Record<string, HungarianSource>;
  curator_status?: "loading" | "cached" | "unavailable";
  unavailable?: string[];
};
type GfnResponse = {
  success: boolean;
  availability?: Record<string, boolean | null>;
  unavailable?: string[];
  catalog_entries?: number;
  error?: string;
};
type BoosteroidResponse = {
  success: boolean;
  availability?: Record<string, boolean | null>;
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
type UpdateCheckResponse = {
  success: boolean;
  current_version?: string;
  latest_version?: string;
  has_update?: boolean;
  asset_size?: number;
  release_url?: string;
  release_notes?: string;
  error?: string;
};
type UpdateApplyResponse = {
  success: boolean;
  version?: string;
  restart_required?: boolean;
  error?: string;
};
type UpdateNotificationResponse = {
  success: boolean;
  update_version?: string;
  error?: string;
};
type BadgeVisibility = {
  library_badge_percent?: number;
  store_badge_percent?: number;
  show_gfn_badges: boolean;
  show_boosteroid_badges: boolean;
  show_hungarian_badges: boolean;
};
type NotificationPreferences = {
  notify_gfn_additions: boolean;
  notify_boosteroid_additions: boolean;
  notify_boosteroid_maintenance: boolean;
  notify_plugin_updates: boolean;
};
type PluginSettings = BadgeVisibility & NotificationPreferences;
type SettingsResponse = PluginSettings & { success: boolean; error?: string };
type NotificationEventsResponse = {
  success: boolean;
  tracked_games?: number;
  gfn_added?: number;
  gfn_added_app_ids?: string[];
  boosteroid_added?: number;
  boosteroid_added_app_ids?: string[];
  boosteroid_maintenance?: number;
  boosteroid_maintenance_app_ids?: string[];
  app_names?: Record<string, string>;
  error?: string;
};
type WatchlistEntry = {
  app_id: string;
  title: string;
  added_at: number;
  watch_gfn: boolean;
  watch_boosteroid: boolean;
  gfn: "available" | "not_available" | "unavailable";
  boosteroid: "available" | "maintenance" | "not_available" | "unavailable";
};
type WatchlistResponse = { success: boolean; entries?: WatchlistEntry[]; error?: string };
type SteamSearchEntry = { app_id: string; title: string };
type SteamSearchResponse = { success: boolean; entries?: SteamSearchEntry[]; error?: string };
type NotificationHistoryEntry = {
  id: string;
  platform: "gfn" | "boosteroid";
  event_type: "available" | "maintenance";
  app_id: string;
  title: string;
  created_at: number;
};
type NotificationHistoryResponse = {
  success: boolean;
  entries?: NotificationHistoryEntry[];
  unread_count?: number;
  error?: string;
};
type PluginPage = "home" | "watchlist" | "history" | "settings";
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
type StoreDebuggerTab = {
  url: string;
  webSocketDebuggerUrl: string;
};
type StorePageScan = {
  url?: string;
  appIds?: string[];
  watchActions?: string[];
};
type StoreRuntimeResponse = {
  id?: number;
  result?: { result?: { value?: unknown } };
  error?: unknown;
  method?: string;
  params?: { frame?: { url?: string } };
};

const getControllerSupport = callable<[appIds: string[]], SupportResponse>("get_controller_support");
const getGfnAvailability = callable<[appIds: string[]], GfnResponse>("get_gfn_availability");
const refreshCloudCatalogs = callable<[], { success: boolean; checked_at: number; error?: string }>("refresh_cloud_catalogs");
const getBoosteroidAvailability = callable<[appIds: string[]], BoosteroidResponse>("get_boosteroid_availability");
const clearCache = callable<[], { success: boolean; removed: number; gfn_removed?: number; boosteroid_removed?: number }>("clear_cache");
const getCacheStats = callable<[], CacheStats>("get_cache_stats");
const getBackendDiagnostics = callable<[], BackendDiagnostics>("get_backend_diagnostics");
const checkForUpdate = callable<[], UpdateCheckResponse>("check_for_update");
const getUpdateNotification = callable<[], UpdateNotificationResponse>("get_update_notification");
const acknowledgeUpdateNotification = callable<
  [version: string],
  { success: boolean; version?: string; error?: string }
>("acknowledge_update_notification");
const applyUpdate = callable<[expectedVersion: string], UpdateApplyResponse>("apply_update");
const restartPluginLoader = callable<[], { success: boolean }>("restart_plugin_loader");
const setBadgeSizes = callable<[library: number, store: number], SettingsResponse>("set_badge_sizes");
const getCuratorProgress = callable<[], CuratorProgress>("get_hungarian_curator_progress");
const loadCuratorProgress = () => withBackendTimeout(getCuratorProgress());
const getSettings = callable<[], SettingsResponse>("get_settings");
const setBadgeVisibility = callable<[showGfnBadges: boolean, showBoosteroidBadges: boolean, showHungarianBadges: boolean], SettingsResponse>("set_badge_visibility");
const setNotificationPreferences = callable<[
  notifyGfnAdditions: boolean,
  notifyBoosteroidAdditions: boolean,
  notifyBoosteroidMaintenance: boolean,
  notifyPluginUpdates: boolean,
], SettingsResponse>("set_notification_preferences");
const getNotificationEvents = callable<[
  appIds: string[],
  appNames: Record<string, string>,
], NotificationEventsResponse>("get_notification_events");
const getWatchlist = callable<[], WatchlistResponse>("get_watchlist");
const addWatchlistGame = callable<[
  appId: string,
  watchGfn: boolean,
  watchBoosteroid: boolean,
], WatchlistResponse>("add_watchlist_game");
const removeWatchlistGame = callable<[appId: string], WatchlistResponse>("remove_watchlist_game");
const setWatchlistPlatforms = callable<[
  appId: string,
  watchGfn: boolean,
  watchBoosteroid: boolean,
], WatchlistResponse>("set_watchlist_platforms");
const searchSteamGames = callable<[query: string], SteamSearchResponse>("search_steam_games");
const getNotificationHistory = callable<[], NotificationHistoryResponse>("get_notification_history");
const clearNotificationHistory = callable<[], NotificationHistoryResponse>("clear_notification_history");
const markNotificationHistoryRead = callable<[], NotificationHistoryResponse>("mark_notification_history_read");

const supportStates = new Map<string, BadgeState>();
const hungarianStates = new Map<string, boolean | null>();
const hungarianSources = new Map<string, HungarianSource>();
let curatorBadgeTimer: number | undefined;
const gfnStates = new Map<string, GfnState>();
const boosteroidStates = new Map<string, BoosteroidState>();
const visibleAppIds = new Map<string, number>();
const supportListeners = new Set<() => void>();
const pendingAppIds = new Set<string>();
let batchTimer: number | undefined;
let tileMemo: TileMemo | null = null;
let originalTileType: TileRender | null = null;
let tileIconRowClass = "";
let storeWebSocket: WebSocket | null = null;
let storeMounted = false;
let nativeTilesInStore = false;
let storeWebSocketReady = false;
let storeMessageId = 1;
let storeScanTimer: number | undefined;
let storeReconnectTimer: number | undefined;
let storeCurrentAppIds = new Set<string>();
let notificationTimer: number | undefined;
let notificationCheck: Promise<void> | undefined;
let cloudViewRevision = 0;
let pluginActive = false;
let settingsLoading = false;
let settingsRetryTimer: number | undefined;
let settingsLoadFailures = 0;
let watchedGames = new Map<string, WatchlistEntry>();
const watchlistListeners = new Set<() => void>();
const watchlistMutations = new Set<string>();
let badgeVisibility: BadgeVisibility = {
  show_gfn_badges: true,
  show_boosteroid_badges: true,
  show_hungarian_badges: true,
};
let notificationPreferences: NotificationPreferences = {
  notify_gfn_additions: true,
  notify_boosteroid_additions: true,
  notify_boosteroid_maintenance: true,
  notify_plugin_updates: true,
};
const storeRuntimeRequests = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: number;
}>();

function withBackendTimeout<T>(request: Promise<T>, timeoutMs = BACKEND_TIMEOUT_MS): Promise<T> {
  let timer: number | undefined;
  return Promise.race([
    request,
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("A Decky backend " + String(timeoutMs / 1000) + " másodpercen belül nem válaszolt.")), timeoutMs);
    }),
  ]).finally(() => { if (timer !== undefined) window.clearTimeout(timer); });
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

async function reloadUpdatedPlugin(): Promise<"reloaded" | "restarting" | "failed"> {
  try {
    await withBackendTimeout(restartPluginLoader(), 5_000);
  } catch {
    // A full Steam restart can still reload both plugin halves.
  }
  try {
    const steamSystem = (window as any).SteamClient?.System;
    if (typeof steamSystem?.RestartSteamClient === "function") {
      steamSystem.RestartSteamClient();
      return "restarting";
    }
  } catch {
    // Try Decky's hot reload below.
  }
  try {
    const loader = (window as any).DeckyPluginLoader;
    if (typeof loader?.reloadPlugin === "function") {
      for (const pluginName of ["Deck Play Badges", "ControllerXbox"]) {
        try {
          await loader.reloadPlugin(pluginName);
          return "reloaded";
        } catch {
          // Try the other name while installations migrate between manifests.
        }
      }
    }
  } catch {
    // The UI will provide a manual restart instruction.
  }
  return "failed";
}

function applyBadgeVisibility(next: BadgeVisibility): void {
  badgeVisibility = next;
  hungarianCollection.setEnabled(pluginActive && next.show_hungarian_badges);
  if (!next.show_hungarian_badges && curatorBadgeTimer !== undefined) {
    window.clearTimeout(curatorBadgeTimer);
    curatorBadgeTimer = undefined;
  }
  for (const listener of supportListeners) listener();
  renderStoreBadges();
  window.dispatchEvent(new CustomEvent<Partial<PluginSettings>>(SETTINGS_CHANGED_EVENT, { detail: next }));
}

function applyNotificationPreferences(next: NotificationPreferences): void {
  notificationPreferences = next;
  window.dispatchEvent(new CustomEvent<Partial<PluginSettings>>(SETTINGS_CHANGED_EVENT, { detail: next }));
}

function applyWatchlistEntries(entries: WatchlistEntry[]): void {
  watchedGames = new Map(entries.map((entry) => [entry.app_id, entry]));
  for (const listener of watchlistListeners) listener();
  renderStoreBadges();
}

async function loadWatchlistState(): Promise<void> {
  try {
    const response = await withBackendTimeout(getWatchlist(), 120_000);
    if (response.success) applyWatchlistEntries(response.entries ?? []);
  } catch (error) {
    console.warn("ControllerXbox watchlist could not be loaded", error);
  }
}

async function toggleWatchlistGame(appId: string): Promise<void> {
  if (watchlistMutations.has(appId)) return;
  watchlistMutations.add(appId);
  try {
    const current = watchedGames.get(appId);
    const response = current
      ? await withBackendTimeout(removeWatchlistGame(appId), 120_000)
      : await withBackendTimeout(addWatchlistGame(appId, true, true), 120_000);
    if (!response.success) throw new Error(response.error || "A figyelőlista módosítása sikertelen.");
    applyWatchlistEntries(response.entries ?? []);
    toaster.toast({
      title: current ? "Figyelés kikapcsolva" : "Figyelőlistához adva",
      body: current?.title ?? watchedGames.get(appId)?.title ?? ("Steam AppID " + appId),
    });
  } catch (error) {
    toaster.toast({ title: "Figyelőlista hiba", body: errorMessage(error) });
  } finally {
    watchlistMutations.delete(appId);
  }
}

async function loadBadgeVisibility(): Promise<void> {
  if (!pluginActive || settingsLoading) return;
  settingsLoading = true;
  if (settingsRetryTimer !== undefined) window.clearTimeout(settingsRetryTimer);
  settingsRetryTimer = undefined;
  try {
    const response = await withBackendTimeout(getSettings());
    if (!pluginActive) return;
    if (!response.success) throw new Error(response.error || "A beállítások betöltése sikertelen.");
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
  } catch (error) {
    console.warn("ControllerXbox badge settings could not be loaded", error);
    if (pluginActive) {
      settingsLoadFailures++;
      hungarianCollection.settingsUnavailable();
      settingsRetryTimer = window.setTimeout(() => {
        settingsRetryTimer = undefined;
        void loadBadgeVisibility();
      }, Math.min(30_000, settingsLoadFailures * 5000));
    }
  } finally {
    settingsLoading = false;
  }
}

function getSteamLibraryApps(): any[] {
  try {
    const store = (globalThis as any).collectionStore;
    if (!readyCollectionStore(store)) return [];
    const collection = store.allAppsCollection;
    const rawApps = collection?.allApps ?? collection?.apps;
    return Array.isArray(rawApps)
      ? rawApps
      : rawApps && typeof rawApps[Symbol.iterator] === "function"
        ? Array.from(rawApps)
        : [];
  } catch (error) {
    console.warn("ControllerXbox could not enumerate the Steam library", error);
    return [];
  }
}

function getSteamLibraryAppIds(): string[] {
  return Array.from(new Set(
    getSteamLibraryApps()
      .map((app: any) => String(app?.appid ?? ""))
      .filter((appId: string) => /^\d+$/.test(appId) && Number(appId) > 0),
  ));
}

const getHungarianLibraryCache = callable<[appIds: string[]], SupportResponse>("get_hungarian_library_cache");

function scheduleCuratorBadgeRefresh(status: SupportResponse["curator_status"]): void {
  if (!pluginActive || !badgeVisibility.show_hungarian_badges || status === "cached"
      || !status || curatorBadgeTimer !== undefined) return;
  curatorBadgeTimer = window.setTimeout(() => {
    curatorBadgeTimer = undefined;
    void (async () => {
      try {
        const ids = Array.from(new Set([...visibleAppIds.keys(), ...storeCurrentAppIds]));
        if (!ids.length || !pluginActive || !badgeVisibility.show_hungarian_badges) return;
        const response = await withBackendTimeout(getHungarianLibraryCache(ids));
        if (!pluginActive || !badgeVisibility.show_hungarian_badges) return;
        if (response.success) {
          for (const [id, value] of Object.entries(response.hungarian ?? {})) hungarianStates.set(id, value);
          for (const [id, source] of Object.entries(response.hungarian_sources ?? {})) hungarianSources.set(id, source);
          for (const listener of supportListeners) listener();
          renderStoreBadges();
        }
        scheduleCuratorBadgeRefresh(response.curator_status ?? "unavailable");
      } catch {
        scheduleCuratorBadgeRefresh("unavailable");
      }
    })();
  }, status === "loading" ? 5000 : 60_000);
}

const hungarianCollection = new HungarianCollection({
  getStore: () => (globalThis as any).collectionStore,
  getApps: getSteamLibraryApps,
  cached: async ids => {
    const hungarian: NonNullable<SupportResponse["hungarian"]> = {};
    const hungarian_sources: NonNullable<SupportResponse["hungarian_sources"]> = {};
    let curator_status: SupportResponse["curator_status"];
    let scan_epoch: number | undefined;
    const scan_attempts: Record<string, number> = {};
    const scan_retry_after: Record<string, number> = {};
    for (let offset = 0; offset < ids.length; offset += 10000) {
      const result = await withBackendTimeout(getHungarianLibraryCache(ids.slice(offset, offset + 10000)));
      if (!result.success) return result;
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
    for (const [id, value] of Object.entries(languages)) hungarianStates.set(id, value);
    for (const [id, source] of Object.entries(sources)) hungarianSources.set(id, source);
    for (const listener of supportListeners) listener();
    renderStoreBadges();
  },
});

function overviewGameName(overview: any): string | undefined {
  const name = [overview?.display_name, overview?.strDisplayName, overview?.name, overview?.sort_as]
    .find((value) => typeof value === "string" && value.trim());
  return typeof name === "string" ? name.trim() : undefined;
}

function getSteamLibraryGameNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const app of getSteamLibraryApps()) {
    const appId = String(app?.appid ?? "");
    const name = overviewGameName(app);
    if (/^\d+$/.test(appId) && name) names[appId] = name;
  }
  return names;
}

function resolveLibraryGameName(appId: string): string {
  const numericAppId = Number(appId);
  const collectionOverview = getSteamLibraryApps().find((app: any) => Number(app?.appid) === numericAppId);
  const appStoreOverview = (globalThis as any).appStore?.GetAppOverviewByAppID?.(numericAppId);
  const steamOverview = (globalThis as any).SteamClient?.Apps?.GetAppOverviewByAppID?.(numericAppId);
  const name = [collectionOverview, appStoreOverview, steamOverview]
    .map(overviewGameName)
    .find(Boolean);
  return name ?? "Steam AppID " + appId;
}

function formatNotificationGameNames(
  appIds: string[] | undefined,
  count: number,
  backendNames?: Record<string, string>,
): string {
  const names = (appIds ?? []).slice(0, 3)
    .map((appId) => backendNames?.[appId] || resolveLibraryGameName(appId));
  if (!names.length) return String(count) + " játék";
  const remaining = Math.max(0, count - names.length);
  return names.join(", ") + (remaining ? " és még " + String(remaining) + " játék" : "");
}

function watchlistGfnLabel(state: WatchlistEntry["gfn"]): string {
  if (state === "available") return "elérhető";
  if (state === "not_available") return "nem elérhető";
  return "katalógushiba";
}

function watchlistBoosteroidLabel(state: WatchlistEntry["boosteroid"]): string {
  if (state === "available") return "elérhető";
  if (state === "maintenance") return "karbantartás alatt";
  if (state === "not_available") return "nem elérhető";
  return "katalógushiba";
}

function historyEventLabel(entry: NotificationHistoryEntry): string {
  if (entry.platform === "gfn") return "Felkerült a GeForce NOW-ra";
  if (entry.event_type === "maintenance") return "Boosteroid-karbantartás alá került";
  return "Felkerült a Boosteroidra";
}

function WatchStarButton({ appId }: { appId: number }) {
  const appIdText = String(appId);
  const [watched, setWatched] = useState(() => watchedGames.has(appIdText));
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const listener = () => setWatched(watchedGames.has(appIdText));
    watchlistListeners.add(listener);
    listener();
    return () => { watchlistListeners.delete(listener); };
  }, [appIdText]);

  const toggle = async (event: any) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setWorking(true);
    await toggleWatchlistGame(appIdText);
    setWorking(false);
  };

  return <button
    type="button"
    title={watched ? "Eltávolítás a figyelőlistáról" : "Hozzáadás a figyelőlistához"}
    disabled={working}
    onClick={(event) => void toggle(event)}
    style={{
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
    }}
  >{watched ? "★" : "☆"}</button>;
}

async function refreshCloudViews(): Promise<void> {
  const revision = ++cloudViewRevision;
  const ids = Array.from(new Set([...gfnStates.keys(), ...boosteroidStates.keys(), ...visibleAppIds.keys(), ...storeCurrentAppIds, ...watchedGames.keys()]));
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const [gfn, boosteroid] = await Promise.allSettled([
      withBackendTimeout(getGfnAvailability(batch), CATALOG_BACKEND_TIMEOUT_MS),
      withBackendTimeout(getBoosteroidAvailability(batch), CATALOG_BACKEND_TIMEOUT_MS),
    ]);
    const response = boosteroid.status === "fulfilled" ? boosteroid.value : { success: false } as BoosteroidResponse;
    const gfnResponse = gfn.status === "fulfilled" ? gfn.value : { success: false } as GfnResponse;
    if (!pluginActive || revision !== cloudViewRevision) return;
    for (const id of batch) {
      const gfnValue = gfnResponse.success ? gfnResponse.availability?.[id] : undefined;
      gfnStates.set(id, gfnValue === true ? "available" : gfnValue === false ? "not_available" : "unavailable");
      const value = response.success ? response.availability?.[id] : undefined;
      boosteroidStates.set(id, value === true ? (response.maintenance?.[id] ? "maintenance" : "available")
        : value === false ? "not_available" : "unavailable");
    }
  }
  if (!pluginActive || revision !== cloudViewRevision) return;
  publishSupportState();
  notifyCacheChanged();
  await loadWatchlistState();
}

let cloudRefresh: Promise<void> | undefined;
function refreshCloudData(): Promise<void> {
  if (cloudRefresh) return cloudRefresh;
  cloudRefresh = (async () => {
    if (notificationCheck) await notificationCheck;
    if (!pluginActive) return;
    const result = await withBackendTimeout(refreshCloudCatalogs(), 180_000);
    if (!pluginActive) return;
    await checkBackgroundNotifications();
    await refreshCloudViews();
    if (!result.success) throw new Error(result.error || "A felhőkatalógus frissítése sikertelen.");
  })().finally(() => { cloudRefresh = undefined; });
  return cloudRefresh;
}

function checkBackgroundNotifications(attempt = 0): Promise<void> {
  if (notificationCheck) return notificationCheck;
  if (notificationTimer !== undefined) window.clearTimeout(notificationTimer);
  notificationTimer = undefined;
  notificationCheck = runBackgroundNotifications(attempt).finally(() => { notificationCheck = undefined; });
  return notificationCheck;
}

async function runBackgroundNotifications(attempt = 0): Promise<void> {
  const appIds = getSteamLibraryAppIds();
  if (!pluginActive) return;
  if (!appIds.length && attempt < 3) {
    notificationTimer = window.setTimeout(() => void checkBackgroundNotifications(attempt + 1), 10_000);
    return;
  }
  notificationTimer = undefined;
  try {
    const update = await withBackendTimeout(getUpdateNotification(), 30_000);
    if (!update.success) throw new Error(update.error || "A frissítésértesítés ellenőrzése sikertelen.");
    if (update.update_version) {
      toaster.toast({
        title: "Deck Play Badges frissítés",
        body: "Új pluginverzió érhető el: v" + update.update_version + ". Nyisd meg a plugint a telepítéshez.",
      });
      const acknowledgement = await withBackendTimeout(
        acknowledgeUpdateNotification(update.update_version),
      );
      if (!acknowledgement.success) {
        throw new Error(acknowledgement.error || "A frissítésértesítés nyugtázása sikertelen.");
      }
    }
  } catch (error) {
    console.warn("Deck Play Badges update notification check failed", error);
  }
  try {
    const response = await withBackendTimeout(
      getNotificationEvents(appIds, getSteamLibraryGameNames()),
      180_000,
    );
    if (!response.success) throw new Error(response.error || "Az értesítési ellenőrzés sikertelen.");
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
          + formatNotificationGameNames(
            response.boosteroid_maintenance_app_ids,
            boosteroidMaintenance,
            response.app_names,
          ) + ".",
      });
    }
    window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
    await refreshCloudViews();
  } catch (error) {
    console.warn("ControllerXbox background notification check failed", error);
  } finally {
    if (pluginActive) {
      notificationTimer = window.setTimeout(
        () => void checkBackgroundNotifications(),
        NOTIFICATION_CHECK_INTERVAL_MS,
      );
    }
  }
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
  const cloudRevision = cloudViewRevision;
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
    scheduleCuratorBadgeRefresh(response.curator_status);
    for (const appId of appIds) {
      const language = response.hungarian?.[appId];
      hungarianStates.set(appId, typeof language === "boolean" ? language : null);
      hungarianSources.set(appId, response.hungarian_sources?.[appId] ?? null);
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
  hungarianStates.clear();
  hungarianSources.clear();
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
  return <svg width="19" height="19" viewBox="0 0 31 31" aria-hidden="true">
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
  const [inStore, setInStore] = useState(nativeTilesInStore);
  const [visibility, setVisibility] = useState(badgeVisibility);
  const [hungarian, setHungarian] = useState(() => hungarianStates.get(appIdText) === true);
  const [hungarianSource, setHungarianSource] = useState(() => hungarianSources.get(appIdText) ?? null);
  const [state, setState] = useState<BadgeState>(() => supportStates.get(appIdText) ?? "loading");
  const [gfnState, setGfnState] = useState<GfnState>(() => gfnStates.get(appIdText) ?? "loading");
  const [boosteroidState, setBoosteroidState] = useState<BoosteroidState>(() => boosteroidStates.get(appIdText) ?? "loading");

  useEffect(() => {
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
      if (remaining > 0) visibleAppIds.set(appIdText, remaining);
      else visibleAppIds.delete(appIdText);
      publishSupportState();
    };
  }, [appIdText]);

  const scale = 0.88 * (inStore ? (visibility.store_badge_percent ?? 100) : (visibility.library_badge_percent ?? 100)) / 100;
  return <span style={{
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
  }}>
    <ControllerBadge state={state} appId={appId} />
    {visibility.show_gfn_badges ? <GfnBadge state={gfnState} /> : null}
    {visibility.show_boosteroid_badges ? <BoosteroidBadge state={boosteroidState} /> : null}
    {visibility.show_hungarian_badges && hungarian ? <span style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: getHungarianBadgeHtml(hungarianSource) }} /> : null}
  </span>;
}

function LibraryDetailBadges({ appId }: { appId: number }) {
  const appIdText = String(appId);
  const [visibility, setVisibility] = useState(badgeVisibility);
  const [hungarian, setHungarian] = useState(() => hungarianStates.get(appIdText) === true);
  const [hungarianSource, setHungarianSource] = useState(() => hungarianSources.get(appIdText) ?? null);
  const [state, setState] = useState<BadgeState>(() => supportStates.get(appIdText) ?? "loading");
  const [gfnState, setGfnState] = useState<GfnState>(() => gfnStates.get(appIdText) ?? "loading");
  const [boosteroidState, setBoosteroidState] = useState<BoosteroidState>(() => boosteroidStates.get(appIdText) ?? "loading");
  const [position, setPosition] = useState({ top: 60, right: 20 });
  const [hidden, setHidden] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
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
      if (remaining > 0) visibleAppIds.set(appIdText, remaining);
      else visibleAppIds.delete(appIdText);
      publishSupportState();
    };
  }, [appIdText]);

  useLayoutEffect(() => {
    const element = ref.current;
    const parent = element?.parentElement;
    const documentRef = element?.ownerDocument;
    if (!element || !parent || !documentRef) return;

    const measure = () => {
      const duplicates = Array.from(documentRef.querySelectorAll<HTMLElement>("[data-controller-xbox-detail-badge]"));
      duplicates.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
      });
      setHidden(duplicates.length > 1 && duplicates[0] !== element);

      const protonMarker = parent.querySelector<HTMLElement>(
        ".protondb-decky-indicator-container, [data-pp-game-badge]",
      );
      const protonBadge = protonMarker?.hasAttribute("data-pp-game-badge")
        ? protonMarker.parentElement as HTMLElement | null
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
    for (const child of Array.from(parent.children)) resizeObserver.observe(child);
    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [appId]);

  if (hidden) return null;
  return <span
    ref={ref}
    data-controller-xbox-detail-badge="true"
    style={{
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
    }}
  >
    <ControllerBadge state={state} appId={appId} />
    {visibility.show_gfn_badges ? <GfnBadge state={gfnState} /> : null}
    {visibility.show_boosteroid_badges ? <BoosteroidBadge state={boosteroidState} /> : null}
    {visibility.show_hungarian_badges && hungarian ? <span style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: getHungarianBadgeHtml(hungarianSource) }} /> : null}
    <WatchStarButton appId={appId} />
  </span>;
}

function patchLibraryDetails(): () => void {
  const renderPatches = new Set<{ unpatch: () => void }>();
  const routePatch = routerHook.addPatch("/library/app/:appid", (tree: any) => {
    const routeProps = findInReactTree(tree, (node: any) => typeof node?.renderFunc === "function") as Record<string, any> | undefined;
    if (!routeProps || routeProps[DETAIL_PATCH_FLAG]) return tree;
    routeProps[DETAIL_PATCH_FLAG] = true;
    const patchHandler = createReactTreePatcher([
      (renderTree: any) => findInReactTree(renderTree, (node: any) => node?.props?.children?.props?.overview)?.props?.children,
    ], (_args: unknown[], result?: ReactElement) => {
      try {
        const match = window.location.pathname.match(/\/library\/app\/(\d+)/);
        const appId = Number(match?.[1] ?? 0);
        if (!Number.isInteger(appId) || appId <= 0) return result;
        const innerClass = appDetailsClasses?.InnerContainer;
        if (!innerClass) return result;
        const container = findInReactTree(result, (node: any) =>
          Array.isArray(node?.props?.children) &&
          typeof node?.props?.className === "string" &&
          node.props.className.includes(innerClass),
        ) as ReactElement | undefined;
        const children = (container?.props as { children?: unknown[] } | undefined)?.children;
        if (!Array.isArray(children)) return result;
        if (children.some((child: any) => child?.key === DETAIL_BADGE_KEY)) return result;
        children.splice(1, 0, createElement(LibraryDetailBadges, { key: DETAIL_BADGE_KEY, appId }));
      } catch (error) {
        console.debug("ControllerXbox library detail badge injection skipped", error);
      }
      return result;
    }, "ControllerXboxLibraryDetails");
    renderPatches.add(afterPatch(routeProps, "renderFunc", patchHandler));
    return tree;
  });

  return () => {
    try { routerHook.removePatch("/library/app/:appid", routePatch); } catch { /* The router may already be disposed. */ }
    for (const patch of renderPatches) {
      try { patch.unpatch(); } catch { /* The route instance may already be gone. */ }
    }
    renderPatches.clear();
  };
}

function buildStoreScanScript(): string {
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

function buildStoreBadgeScript(
  states: Record<string, { controller: BadgeState; gfn: GfnState; boosteroid: BoosteroidState; hungarian: boolean; hungarianSource: HungarianSource }>,
  visibility: BadgeVisibility,
  watchedAppIds: Set<string>,
): string {
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

function sendStoreRuntime(expression: string, returnByValue = false): Promise<unknown> {
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
  if (!returnByValue) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      storeRuntimeRequests.delete(id);
      reject(new Error("A Steam Store oldal nem válaszolt."));
    }, 5_000);
    storeRuntimeRequests.set(id, { resolve, reject, timeout });
  });
}

function renderStoreBadges(): void {
  if (!storeWebSocketReady || !storeCurrentAppIds.size) return;
  const states: Record<string, { controller: BadgeState; gfn: GfnState; boosteroid: BoosteroidState; hungarian: boolean; hungarianSource: HungarianSource }> = {};
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

function scheduleStoreScan(delay = STORE_SCAN_INTERVAL_MS): void {
  if (storeScanTimer !== undefined) window.clearTimeout(storeScanTimer);
  if (!storeMounted) return;
  storeScanTimer = window.setTimeout(() => void scanStorePage(), delay);
}

async function scanStorePage(): Promise<void> {
  storeScanTimer = undefined;
  if (!storeMounted || !storeWebSocketReady) return;
  try {
    const result = await sendStoreRuntime(buildStoreScanScript(), true) as StorePageScan | undefined;
    const nextIds = new Set(
      (Array.isArray(result?.appIds) ? result.appIds : [])
        .map((value) => String(value))
        .filter((value) => /^\d+$/.test(value) && Number(value) > 0),
    );
    storeCurrentAppIds = nextIds;
    const watchActions = (Array.isArray(result?.watchActions) ? result.watchActions : [])
      .map((value) => String(value))
      .filter((value) => /^\d+$/.test(value) && Number(value) > 0);
    for (const appId of watchActions) void toggleWatchlistGame(appId);
    for (const appId of nextIds) queueSupportLookup(appId);
    renderStoreBadges();
  } catch (error) {
    console.debug("ControllerXbox store scan skipped", error);
  } finally {
    scheduleStoreScan();
  }
}

function clearStoreRuntimeRequests(reason: string): void {
  for (const request of storeRuntimeRequests.values()) {
    window.clearTimeout(request.timeout);
    request.reject(new Error(reason));
  }
  storeRuntimeRequests.clear();
}

function scheduleStoreReconnect(delay = 1_000): void {
  if (storeReconnectTimer !== undefined) window.clearTimeout(storeReconnectTimer);
  if (!storeMounted) return;
  storeReconnectTimer = window.setTimeout(() => {
    storeReconnectTimer = undefined;
    void connectToStoreDebugger();
  }, delay);
}

async function connectToStoreDebugger(): Promise<void> {
  if (!storeMounted || storeWebSocket) return;
  try {
    const response = await fetchNoCors(STORE_DEBUGGER_URL);
    const tabs = await response.json() as StoreDebuggerTab[];
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
        if (storeWebSocket !== socket || !storeMounted) return;
        storeWebSocketReady = true;
        scheduleStoreScan(0);
      }, 300);
    };
    socket.onmessage = (event) => {
      let message: StoreRuntimeResponse;
      try { message = JSON.parse(String(event.data)) as StoreRuntimeResponse; } catch { return; }
      if (typeof message.id === "number") {
        const request = storeRuntimeRequests.get(message.id);
        if (request) {
          storeRuntimeRequests.delete(message.id);
          window.clearTimeout(request.timeout);
          if (message.error) request.reject(message.error);
          else request.resolve(message.result?.result?.value);
        }
      }
      if (message.method === "Page.frameNavigated" && message.params?.frame?.url?.includes("store.steampowered.com")) {
        scheduleStoreScan(500);
      }
    };
    socket.onerror = () => {
      if (storeWebSocket === socket) console.debug("ControllerXbox store debugger connection error");
    };
    socket.onclose = () => {
      if (storeWebSocket === socket) storeWebSocket = null;
      storeWebSocketReady = false;
      clearStoreRuntimeRequests("A Steam Store böngészőkapcsolata megszakadt.");
      scheduleStoreReconnect();
    };
  } catch (error) {
    console.debug("ControllerXbox store debugger discovery failed", error);
    scheduleStoreReconnect();
  }
}

function disconnectStoreDebugger(): void {
  if (storeScanTimer !== undefined) window.clearTimeout(storeScanTimer);
  if (storeReconnectTimer !== undefined) window.clearTimeout(storeReconnectTimer);
  storeScanTimer = undefined;
  storeReconnectTimer = undefined;
  if (storeWebSocketReady) {
    void sendStoreRuntime(`
      (function() {
        document.getElementById('controller-xbox-store-detail-badges')?.remove();
        document.querySelectorAll('.controller-xbox-store-card-badges').forEach(function(node) { node.remove(); });
        document.getElementById('controller-xbox-store-style')?.remove();
        delete window.__controllerXboxWatchActions;
      })();
    `).catch(() => {});
  }
  const socket = storeWebSocket;
  storeWebSocket = null;
  storeWebSocketReady = false;
  storeCurrentAppIds.clear();
  clearStoreRuntimeRequests("A Steam Store nézet bezárult.");
  try { socket?.close(); } catch { /* The browser tab may already be gone. */ }
}

function patchSteamStore(): () => void {
  const storeListener = () => renderStoreBadges();
  supportListeners.add(storeListener);
  let unlisten: (() => void) | undefined;
  try {
    const historyModule = findModuleExport((value: any) => value?.m_history !== undefined);
    const history = historyModule?.m_history;
    const handleLocation = (pathname: string) => {
      const nextNativeStore = /^\/(store|steamweb)(\/|$)/.test(pathname);
      if (nextNativeStore !== nativeTilesInStore) {
        nativeTilesInStore = nextNativeStore;
        for (const listener of supportListeners) listener();
      }
      const inStore = pathname === "/steamweb" || pathname.startsWith("/steamweb/");
      if (inStore && !storeMounted) {
        storeMounted = true;
        void connectToStoreDebugger();
      } else if (!inStore && storeMounted) {
        storeMounted = false;
        disconnectStoreDebugger();
      }
    };
    handleLocation(String(history?.location?.pathname ?? window.location.pathname ?? ""));
    if (typeof history?.listen === "function") {
      unlisten = history.listen((info: { pathname?: string; location?: { pathname?: string } }) => {
        handleLocation(String(info?.pathname ?? info?.location?.pathname ?? ""));
      });
    }
  } catch (error) {
    console.warn("ControllerXbox Steam Store patch failed", error);
  }
  return () => {
    supportListeners.delete(storeListener);
    try { unlisten?.(); } catch { /* Steam may already have disposed its history. */ }
    storeMounted = false;
    disconnectStoreDebugger();
  };
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
      hungarianStates.clear();
      hungarianSources.clear();
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
  const [page, setPage] = useState<PluginPage>("home");
  const pageRef = useRef<PluginPage>("home");
  const [stats, setStats] = useState<CacheStats>();
  const [status, setStatus] = useState("A jelvények aktívak.");
  const [diagnosticLog, setDiagnosticLog] = useState("Nincs rögzített hiba.");
  const [working, setWorking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse>();
  const [updateStatus, setUpdateStatus] = useState("Frissítések keresése folyamatban...");
  const [updateWorking, setUpdateWorking] = useState(false);
  const [installedUpdate, setInstalledUpdate] = useState<string>();
  const [visibility, setVisibility] = useState<BadgeVisibility>({ ...badgeVisibility });
  const [notifications, setNotifications] = useState<NotificationPreferences>({ ...notificationPreferences });
  const [settingsWorking, setSettingsWorking] = useState(false);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [watchWorking, setWatchWorking] = useState(false);
  const [cloudRefreshing, setCloudRefreshing] = useState(false);
  const [cloudRefreshStatus, setCloudRefreshStatus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SteamSearchEntry[]>([]);
  const [searchWorking, setSearchWorking] = useState(false);
  const [newWatchGfn, setNewWatchGfn] = useState(true);
  const [newWatchBoosteroid, setNewWatchBoosteroid] = useState(true);
  const [history, setHistory] = useState<NotificationHistoryEntry[]>([]);
  const [unreadHistoryCount, setUnreadHistoryCount] = useState(0);
  const [historyWorking, setHistoryWorking] = useState(false);

  const refreshStats = async () => {
    try {
      setStats(await withBackendTimeout(getCacheStats()));
    } catch (error) {
      setDiagnosticLog("Cache állapot: " + errorMessage(error));
    }
  };

  const refreshWatchlist = async () => {
    try {
      const response = await withBackendTimeout(getWatchlist(), 120_000);
      if (!response.success) throw new Error(response.error || "A figyelőlista betöltése sikertelen.");
      const entries = response.entries ?? [];
      setWatchlist(entries);
      applyWatchlistEntries(entries);
    } catch (error) {
      setDiagnosticLog("Figyelőlista: " + errorMessage(error));
    }
  };

  const refreshHistory = async (markRead = false) => {
    try {
      const response = await withBackendTimeout(
        markRead ? markNotificationHistoryRead() : getNotificationHistory(),
      );
      if (!response.success) throw new Error(response.error || "Az értesítési előzmények betöltése sikertelen.");
      setHistory(response.entries ?? []);
      setUnreadHistoryCount(response.unread_count ?? 0);
    } catch (error) {
      setDiagnosticLog("Értesítési előzmények: " + errorMessage(error));
    }
  };

  const refreshUpdateInfo = async (quiet = false) => {
    setUpdateWorking(true);
    if (!quiet) setUpdateStatus("Frissítések keresése folyamatban...");
    try {
      const response = await withBackendTimeout(checkForUpdate(), 30_000);
      setUpdateInfo(response);
      if (!response.success) throw new Error(response.error || "A frissítéskeresés sikertelen.");
      if (response.has_update && response.latest_version) {
        setUpdateStatus("Új stabil verzió érhető el: v" + response.latest_version + ".");
      } else {
        setUpdateStatus("A plugin naprakész (v" + String(response.current_version ?? "ismeretlen") + ").");
      }
    } catch (error) {
      setUpdateStatus("Frissítéskeresési hiba: " + errorMessage(error));
    } finally {
      setUpdateWorking(false);
    }
  };

  useEffect(() => {
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
    const onTileStatus = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) setStatus(detail);
    };
    const onSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<Partial<PluginSettings>>).detail;
      if (!detail) return;
      if (typeof detail.show_gfn_badges === "boolean" || typeof detail.show_boosteroid_badges === "boolean" || typeof detail.show_hungarian_badges === "boolean") {
        setVisibility((current) => ({
          show_gfn_badges: detail.show_gfn_badges ?? current.show_gfn_badges,
          show_boosteroid_badges: detail.show_boosteroid_badges ?? current.show_boosteroid_badges,
          show_hungarian_badges: detail.show_hungarian_badges ?? current.show_hungarian_badges,
          library_badge_percent: detail.library_badge_percent ?? current.library_badge_percent,
          store_badge_percent: detail.store_badge_percent ?? current.store_badge_percent,
        }));
      }
      if (
        typeof detail.notify_gfn_additions === "boolean" ||
        typeof detail.notify_boosteroid_additions === "boolean" ||
        typeof detail.notify_boosteroid_maintenance === "boolean" ||
        typeof detail.notify_plugin_updates === "boolean"
      ) {
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

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  const updateVisibility = async (next: BadgeVisibility) => {
    const previous = visibility;
    setSettingsWorking(true);
    setVisibility(next);
    applyBadgeVisibility(next);
    try {
      const response = await withBackendTimeout(
        setBadgeVisibility(next.show_gfn_badges, next.show_boosteroid_badges, next.show_hungarian_badges),
      );
      if (!response.success) throw new Error(response.error || "A beállítás mentése sikertelen.");
      applyBadgeVisibility({
        show_gfn_badges: response.show_gfn_badges,
        show_boosteroid_badges: response.show_boosteroid_badges,
        show_hungarian_badges: response.show_hungarian_badges ?? true,
        library_badge_percent: response.library_badge_percent ?? 100,
        store_badge_percent: response.store_badge_percent ?? 100,
      });
    } catch (error) {
      setVisibility(previous);
      applyBadgeVisibility(previous);
      toaster.toast({ title: "Beállítási hiba", body: errorMessage(error) });
    } finally {
      setSettingsWorking(false);
    }
  };

  const updateNotifications = async (next: NotificationPreferences) => {
    const previous = notifications;
    setSettingsWorking(true);
    setNotifications(next);
    applyNotificationPreferences(next);
    try {
      const response = await withBackendTimeout(setNotificationPreferences(
        next.notify_gfn_additions,
        next.notify_boosteroid_additions,
        next.notify_boosteroid_maintenance,
        next.notify_plugin_updates,
      ));
      if (!response.success) throw new Error(response.error || "Az értesítési beállítás mentése sikertelen.");
      applyNotificationPreferences({
        notify_gfn_additions: response.notify_gfn_additions,
        notify_boosteroid_additions: response.notify_boosteroid_additions,
        notify_boosteroid_maintenance: response.notify_boosteroid_maintenance,
        notify_plugin_updates: response.notify_plugin_updates,
      });
    } catch (error) {
      setNotifications(previous);
      applyNotificationPreferences(previous);
      toaster.toast({ title: "Beállítási hiba", body: errorMessage(error) });
    } finally {
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
      if (!response.success) throw new Error(response.error || "A Steam-keresés sikertelen.");
      setSearchResults(response.entries ?? []);
    } catch (error) {
      setSearchResults([]);
      toaster.toast({ title: "Steam-keresési hiba", body: errorMessage(error) });
    } finally {
      setSearchWorking(false);
    }
  };

  const addWatchedGame = async (appId: string) => {
    if (!newWatchGfn && !newWatchBoosteroid) {
      toaster.toast({ title: "Figyelőlista", body: "Legalább egy platformot válassz ki." });
      return;
    }
    setWatchWorking(true);
    try {
      const response = await withBackendTimeout(
        addWatchlistGame(appId, newWatchGfn, newWatchBoosteroid),
        120_000,
      );
      if (!response.success) throw new Error(response.error || "A játék felvétele sikertelen.");
      const entries = response.entries ?? [];
      applyWatchlistEntries(entries);
      setWatchlist(entries);
      setSearchResults((current) => current.filter((entry) => entry.app_id !== appId));
      const added = entries.find((entry) => entry.app_id === appId);
      toaster.toast({ title: "Figyelőlistához adva", body: added?.title ?? ("Steam AppID " + appId) });
    } catch (error) {
      toaster.toast({ title: "Figyelőlista hiba", body: errorMessage(error) });
    } finally {
      setWatchWorking(false);
    }
  };

  const removeWatchedGame = async (appId: string) => {
    setWatchWorking(true);
    try {
      const response = await withBackendTimeout(removeWatchlistGame(appId), 120_000);
      if (!response.success) throw new Error(response.error || "A játék eltávolítása sikertelen.");
      const entries = response.entries ?? [];
      setWatchlist(entries);
      applyWatchlistEntries(entries);
    } catch (error) {
      toaster.toast({ title: "Figyelőlista hiba", body: errorMessage(error) });
    } finally {
      setWatchWorking(false);
    }
  };

  const updateWatchedPlatforms = async (
    entry: WatchlistEntry,
    watchGfn: boolean,
    watchBoosteroid: boolean,
  ) => {
    if (!watchGfn && !watchBoosteroid) {
      toaster.toast({ title: "Figyelőlista", body: "Legalább egy platformot hagyj bekapcsolva." });
      return;
    }
    setWatchWorking(true);
    try {
      const response = await withBackendTimeout(
        setWatchlistPlatforms(entry.app_id, watchGfn, watchBoosteroid),
        120_000,
      );
      if (!response.success) throw new Error(response.error || "A platformbeállítás mentése sikertelen.");
      const entries = response.entries ?? [];
      setWatchlist(entries);
      applyWatchlistEntries(entries);
    } catch (error) {
      toaster.toast({ title: "Figyelőlista hiba", body: errorMessage(error) });
    } finally {
      setWatchWorking(false);
    }
  };

  const openPage = (nextPage: PluginPage) => {
    setPage(nextPage);
    if (nextPage === "history") void refreshHistory(true);
  };

  const clearHistory = async () => {
    setHistoryWorking(true);
    try {
      const response = await withBackendTimeout(clearNotificationHistory());
      if (!response.success) throw new Error(response.error || "Az előzmények törlése sikertelen.");
      setHistory([]);
      setUnreadHistoryCount(0);
      toaster.toast({ title: "Értesítési előzmények", body: "Az előzmények törölve." });
    } catch (error) {
      toaster.toast({ title: "Előzménytörlési hiba", body: errorMessage(error) });
    } finally {
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
      await loadBadgeVisibility();
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

  const installAvailableUpdate = async () => {
    const version = updateInfo?.latest_version;
    if (!updateInfo?.has_update || !version) return;
    setUpdateWorking(true);
    setUpdateStatus("A v" + version + " frissítés letöltése, ellenőrzése és telepítése folyamatban...");
    try {
      const response = await withBackendTimeout(applyUpdate(version), 120_000);
      if (!response.success) throw new Error(response.error || "A frissítés telepítése sikertelen.");
      setInstalledUpdate(response.version ?? version);
      setUpdateStatus("A v" + String(response.version ?? version) + " telepítve. Indítsd újra a Steamet és a plugint az alábbi gombbal.");
      toaster.toast({
        title: "Deck Play Badges frissítve",
        body: "A v" + String(response.version ?? version) + " telepítve. A befejezéshez indítsd újra a Steamet.",
      });
    } catch (error) {
      setUpdateStatus("Frissítési hiba: " + errorMessage(error));
    } finally {
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
    } else {
      toaster.toast({
        title: "Deck Play Badges",
        body: result === "reloaded" ? "A plugin újratöltve." : "A Steam és a plugin újraindítása folyamatban...",
      });
    }
  };

  const saveSizes = async (sizes: BadgeSizes) => {
    const response = await withBackendTimeout(setBadgeSizes(sizes.library_badge_percent, sizes.store_badge_percent));
    if (!response.success) throw new Error(response.error || "Az ikonméret mentése sikertelen.");
    applyBadgeVisibility({ ...badgeVisibility, library_badge_percent: response.library_badge_percent ?? 100,
      store_badge_percent: response.store_badge_percent ?? 100 });
  };

  if (page === "settings") return <PanelSection title="Beállítások">
    <PanelSectionRow><ButtonItem layout="below" onClick={() => openPage("home")}>← Főoldal</ButtonItem></PanelSectionRow>
    <PanelSectionRow><div style={{ fontWeight: 700 }}>Jelvények</div></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="Magyar zászló"
      description="Magyar nyelv a Steam nyelvi listája vagy a Magyar Felirat kurátor alapján. A teljes könyvtárból magyar gyűjteményt készít. Kikapcsolva a gyűjtés szünetel, a gyűjtemény megmarad."
      checked={visibility.show_hungarian_badges}
      disabled={settingsWorking}
      onChange={(checked) => void updateVisibility({ ...visibility, show_hungarian_badges: checked })}
    /></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="GeForce NOW"
      checked={visibility.show_gfn_badges}
      disabled={settingsWorking}
      onChange={(checked) => void updateVisibility({ ...visibility, show_gfn_badges: checked })}
    /></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="Boosteroid"
      checked={visibility.show_boosteroid_badges}
      disabled={settingsWorking}
      onChange={(checked) => void updateVisibility({ ...visibility, show_boosteroid_badges: checked })}
    /></PanelSectionRow>
    <BadgeSizeSettings initial={{ library_badge_percent: visibility.library_badge_percent ?? 100,
      store_badge_percent: visibility.store_badge_percent ?? 100 }} save={saveSizes} />
    <PanelSectionRow><div style={{ marginTop: "12px", fontWeight: 700 }}>Értesítések</div></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="Új GeForce NOW-játékok"
      checked={notifications.notify_gfn_additions}
      disabled={settingsWorking}
      onChange={(checked) => void updateNotifications({ ...notifications, notify_gfn_additions: checked })}
    /></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="Új Boosteroid-játékok"
      checked={notifications.notify_boosteroid_additions}
      disabled={settingsWorking}
      onChange={(checked) => void updateNotifications({ ...notifications, notify_boosteroid_additions: checked })}
    /></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="Boosteroid-karbantartás"
      checked={notifications.notify_boosteroid_maintenance}
      disabled={settingsWorking}
      onChange={(checked) => void updateNotifications({ ...notifications, notify_boosteroid_maintenance: checked })}
    /></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="Pluginfrissítések"
      checked={notifications.notify_plugin_updates}
      disabled={settingsWorking}
      onChange={(checked) => void updateNotifications({ ...notifications, notify_plugin_updates: checked })}
    /></PanelSectionRow>
  </PanelSection>;

  const refreshWatchedClouds = async () => {
    setCloudRefreshing(true);
    setCloudRefreshStatus("A GFN és Boosteroid katalógusának letöltése…");
    try {
      await refreshCloudData();
      setCloudRefreshStatus("GFN és Boosteroid frissítve: " + new Date().toLocaleTimeString());
    } catch (error) { setCloudRefreshStatus("Frissítési hiba: " + errorMessage(error)); }
    finally { setCloudRefreshing(false); }
  };

  if (page === "watchlist") return <PanelSection title="Figyelőlista">
    <PanelSectionRow><CatalogStatus /></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={cloudRefreshing}
      onClick={() => void refreshWatchedClouds()}>{cloudRefreshing ? "Katalógusok frissítése…" : "GFN és Boosteroid ellenőrzése most"}</ButtonItem></PanelSectionRow>
    <PanelSectionRow><div style={{ fontSize: "12px", opacity: .8 }}>{cloudRefreshStatus || "Ébredéskor mindkét katalógus frissül. Ellenőrzés 15 percenként is, amíg a plugin fut."}</div></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" onClick={() => openPage("home")}>← Főoldal</ButtonItem></PanelSectionRow>
    <PanelSectionRow><TextField
      label="Játéknév vagy Steam AppID"
      value={searchQuery}
      bShowClearAction
      disabled={searchWorking || watchWorking}
      onChange={(event) => setSearchQuery(event.currentTarget.value)}
    /></PanelSectionRow>
    <PanelSectionRow><ButtonItem
      layout="below"
      disabled={searchWorking || watchWorking || searchQuery.trim().length < 2}
      onClick={searchForGames}
    >Keresés</ButtonItem></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="GeForce NOW figyelése"
      checked={newWatchGfn}
      disabled={watchWorking}
      onChange={setNewWatchGfn}
    /></PanelSectionRow>
    <PanelSectionRow><ToggleField
      label="Boosteroid figyelése"
      checked={newWatchBoosteroid}
      disabled={watchWorking}
      onChange={setNewWatchBoosteroid}
    /></PanelSectionRow>
    {searchResults.map((entry) => {
      const alreadyWatched = watchedGames.has(entry.app_id);
      return <PanelSectionRow key={"search-" + entry.app_id}><ButtonItem
        layout="below"
        label={entry.title}
        description={"Steam AppID: " + entry.app_id}
        disabled={watchWorking || alreadyWatched}
        onClick={() => void addWatchedGame(entry.app_id)}
      >{alreadyWatched ? "Már figyelve" : "Hozzáadás"}</ButtonItem></PanelSectionRow>;
    })}
    <PanelSectionRow><div style={{ marginTop: "12px", fontWeight: 700 }}>
      Figyelt játékok ({watchlist.length})
    </div></PanelSectionRow>
    {watchlist.length ? watchlist.map((entry) => <Fragment key={entry.app_id}>
      <PanelSectionRow><div style={{ paddingTop: "6px", fontWeight: 700 }}>{entry.title}</div></PanelSectionRow>
      <PanelSectionRow><div style={{ opacity: 0.75 }}>
        GFN: {entry.watch_gfn ? watchlistGfnLabel(entry.gfn) : "kikapcsolva"}
        {" · Boosteroid: "}{entry.watch_boosteroid ? watchlistBoosteroidLabel(entry.boosteroid) : "kikapcsolva"}
      </div></PanelSectionRow>
      <PanelSectionRow><ToggleField
        label="GeForce NOW"
        checked={entry.watch_gfn}
        disabled={watchWorking}
        onChange={(checked) => void updateWatchedPlatforms(entry, checked, entry.watch_boosteroid)}
      /></PanelSectionRow>
      <PanelSectionRow><ToggleField
        label="Boosteroid"
        checked={entry.watch_boosteroid}
        disabled={watchWorking}
        onChange={(checked) => void updateWatchedPlatforms(entry, entry.watch_gfn, checked)}
      /></PanelSectionRow>
      <PanelSectionRow><ButtonItem
        layout="below"
        disabled={watchWorking}
        onClick={() => void removeWatchedGame(entry.app_id)}
      >Eltávolítás</ButtonItem></PanelSectionRow>
    </Fragment>) : <PanelSectionRow><div>A figyelőlista üres.</div></PanelSectionRow>}
  </PanelSection>;

  if (page === "history") return <PanelSection title="Előzmények">
    <PanelSectionRow><ButtonItem layout="below" onClick={() => openPage("home")}>← Főoldal</ButtonItem></PanelSectionRow>
    {history.length ? history.map((entry) =>
      <PanelSectionRow key={entry.id}><div style={{ padding: "6px 0" }}>
        <div style={{ fontWeight: 700 }}>{entry.title}</div>
        <div>{historyEventLabel(entry)}</div>
        <div style={{ opacity: 0.7, fontSize: "12px" }}>
          {new Date(entry.created_at * 1000).toLocaleString("hu-HU")} · Steam AppID: {entry.app_id}
        </div>
      </div></PanelSectionRow>,
    ) : <PanelSectionRow><div>Még nincs rögzített esemény.</div></PanelSectionRow>}
    {history.length ? <PanelSectionRow><ButtonItem
      layout="below"
      disabled={historyWorking}
      onClick={clearHistory}
    >Előzmények törlése</ButtonItem></PanelSectionRow> : null}
  </PanelSection>;

  return <PanelSection title="Deck Play Badges">
    <PanelSectionRow><ButtonItem layout="below" onClick={() => openPage("watchlist")}>
      Figyelőlista ({watchlist.length})
    </ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" onClick={() => openPage("history")}>
      Előzmények{unreadHistoryCount ? " (" + String(unreadHistoryCount) + ")" : ""}
    </ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" onClick={() => openPage("settings")}>Beállítások</ButtonItem></PanelSectionRow>
    <PanelSectionRow><div>{status}</div></PanelSectionRow>
    <PanelSectionRow><HungarianProgress manager={hungarianCollection} loadCurator={loadCuratorProgress} /></PanelSectionRow>
    <PanelSectionRow><CatalogStatus /></PanelSectionRow>
    <PanelSectionRow><div>{stats
      ? "Cache: " + String(stats.fresh_entries) + "/" + String(stats.entries)
        + " · GFN: " + String(stats.gfn_catalog_entries ?? 0)
        + " · Boosteroid: " + String(stats.boosteroid_catalog_entries ?? 0)
      : "Állapot betöltése..."}</div></PanelSectionRow>
    {diagnosticLog !== "Nincs rögzített hiba." ?
      <PanelSectionRow><div style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>Hiba: {diagnosticLog}</div></PanelSectionRow> : null}
    <PanelSectionRow><ButtonItem layout="below" disabled={working} onClick={backendCheck}>Játékok újraellenőrzése</ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={working} onClick={clearAndRefresh}>Cache törlése</ButtonItem></PanelSectionRow>
    <PanelSectionRow><div style={{ marginTop: "12px", fontWeight: 700 }}>Pluginfrissítés</div></PanelSectionRow>
    <PanelSectionRow><div>{updateStatus}</div></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={updateWorking} onClick={() => void refreshUpdateInfo()}>Frissítések keresése</ButtonItem></PanelSectionRow>
    {updateInfo?.has_update && updateInfo.latest_version && !installedUpdate ?
      <PanelSectionRow><ButtonItem layout="below" disabled={updateWorking} onClick={installAvailableUpdate}>Frissítés telepítése: v{updateInfo.latest_version}</ButtonItem></PanelSectionRow> : null}
    {installedUpdate ?
      <PanelSectionRow><ButtonItem layout="below" disabled={updateWorking} onClick={reloadAfterUpdate}>Steam és plugin újraindítása</ButtonItem></PanelSectionRow> : null}
  </PanelSection>;
}

export default definePlugin(() => {
  pluginActive = true;
  void loadBadgeVisibility();
  void loadWatchlistState();
  notificationTimer = window.setTimeout(() => void checkBackgroundNotifications(), 10_000);
  const removeTilePatch = patchLibraryTiles();
  const removeLibraryDetailPatch = patchLibraryDetails();
  const removeStorePatch = patchSteamStore();
  const resumeRefresh = new CloudResumeRefresh({
    register: callback => {
      const sleepManager = findModuleExport((value: any) => typeof value?.RegisterForNotifyResumeFromSuspend === "function");
      const subscription = sleepManager?.RegisterForNotifyResumeFromSuspend(callback);
      return subscription ? () => subscription.unregister?.() : undefined;
    },
    refresh: refreshCloudData,
    onError: error => console.warn("Deck Play Badges wake catalog refresh failed", error),
  });
  resumeRefresh.start();
  return {
    name: "Deck Play Badges",
    titleView: <div className={staticClasses.Title}>Deck Play Badges</div>,
    content: <Content />,
    icon: <span>✓</span>,
    onDismount: () => {
      pluginActive = false;
      resumeRefresh.stop();
      if (settingsRetryTimer !== undefined) window.clearTimeout(settingsRetryTimer);
      settingsRetryTimer = undefined;
      hungarianCollection.stop();
      if (curatorBadgeTimer !== undefined) window.clearTimeout(curatorBadgeTimer);
      curatorBadgeTimer = undefined;
      if (notificationTimer !== undefined) window.clearTimeout(notificationTimer);
      notificationTimer = undefined;
      removeStorePatch();
      removeLibraryDetailPatch();
      removeTilePatch();
    },
  };
});
