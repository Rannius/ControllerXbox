import { afterPatch, appDetailsClasses, basicAppDetailsSectionStylerClasses, ButtonItem, createReactTreePatcher, definePlugin, findInReactTree, Focusable, joinClassNames, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { callable, RoutePatch, routerHook, toaster } from "@decky/api";
import { ReactElement, useEffect, useState } from "react";

const BACKEND_TIMEOUT_MS = 8_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const DETAIL_STATUS_EVENT = "controller-xbox-detail-status";

type SupportResponse = { success: boolean; support?: Record<string, boolean> };
type CacheStats = { entries: number; fresh_entries: number; ttl_days: number };
type BackendDiagnostics = CacheStats & { success: boolean; backend: string; settings_directory: string };

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

function notifyDetailStatus(message: string): void {
  window.dispatchEvent(new CustomEvent<string>(DETAIL_STATUS_EVENT, { detail: message }));
}

function XboxBadge({ appId }: { appId: number }) {
  const [supported, setSupported] = useState<boolean>();

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await withBackendTimeout(getControllerSupport([String(appId)]));
        if (disposed) return;
        const hasSupport = Boolean(response.success && response.support?.[String(appId)]);
        setSupported(hasSupport);
        notifyDetailStatus("Játékadatlap patch aktív. AppID: " + String(appId) + ". Steam teljes kontroller-támogatás: " + (hasSupport ? "igen." : "nem."));
        notifyCacheChanged();
      } catch (error) {
        if (!disposed) notifyDetailStatus("Játékadatlap ellenőrzési hiba (AppID " + String(appId) + "): " + errorMessage(error));
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

  if (!supported) return null;
  return <Focusable className={joinClassNames(basicAppDetailsSectionStylerClasses.AppButtons, "controller-xbox-badge-container")}>
    <style>{".controller-xbox-badge-container{position:absolute;top:2.8vw;right:16px;z-index:50;pointer-events:none}.controller-xbox-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:5px;background:#107cde;color:#fff;box-shadow:0 1px 4px #0009;font:700 13px/16px Arial,sans-serif}"}</style>
    <span className="controller-xbox-badge" title="Steam: Full Controller Support">✓ Xbox</span>
  </Focusable>;
}

function XboxBadgeAnchor({ appId }: { appId: number }) {
  return <div id="controller-xbox-badge-anchor" style={{ position: "static", height: 0 }}>
    <XboxBadge appId={appId} />
  </div>;
}

function patchLibraryAppRoute(): () => void {
  const route = "/library/app/:appid";
  const routePatch: RoutePatch = routerHook.addPatch(route, (tree: unknown) => {
    const routeProps = findInReactTree(tree, (node: any) => node?.renderFunc);
    if (!routeProps) return tree;

    let appId: number | undefined;
    const patchHandler = createReactTreePatcher([
      (renderTree: any) => {
        const children = findInReactTree(renderTree, (node: any) => node?.props?.children?.props?.overview)?.props?.children;
        const overview = children?.props?.overview;
        if (typeof overview?.appid !== "number") return null;
        appId = overview.appid;
        return children;
      },
    ], (_: Array<Record<string, unknown>>, result?: ReactElement) => {
      if (!result) return result;
      type ParentElement = ReactElement<{ children: Array<ReactElement<{ id?: string; overview?: unknown; onShowLaunchingDetails?: unknown }>>; className: string }>;
      const parent = findInReactTree(
        result,
        (node: ParentElement) => Array.isArray(node?.props?.children) && typeof node?.props?.className === "string" && node.props.className.includes(appDetailsClasses.InnerContainer),
      ) as ParentElement;
      if (!parent?.props?.children) return result;
      if (typeof appId !== "number") return result;
      if (parent.props.children.some((child) => child?.props?.id === "controller-xbox-badge-anchor")) return result;

      const appPanelIndex = parent.props.children.findIndex((child) => child?.props?.overview && child?.props?.onShowLaunchingDetails);
      const insertAt = appPanelIndex < 0 ? parent.props.children.length : Math.max(0, appPanelIndex - 1);
      parent.props.children.splice(insertAt, 0, <XboxBadgeAnchor key="controller-xbox-badge-anchor" appId={appId} />);
      return result;
    });
    afterPatch(routeProps, "renderFunc", patchHandler);
    return tree;
  });
  return () => routerHook.removePatch(route, routePatch);
}

function Content() {
  const [stats, setStats] = useState<CacheStats>();
  const [status, setStatus] = useState("Nyiss meg egy játék adatlapját a Könyvtárban; a jelvény ott automatikusan megjelenik.");
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
    const onDetailStatus = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) setStatus(detail);
    };
    window.addEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
    window.addEventListener(DETAIL_STATUS_EVENT, onDetailStatus);
    return () => {
      window.removeEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
      window.removeEventListener(DETAIL_STATUS_EVENT, onDetailStatus);
    };
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
      setStatus("Backend rendben. Nyiss meg egy játék adatlapját; a kék ✓ Xbox jelvény a jobb felső részen jelenik meg.");
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
    <PanelSectionRow><div>A MoonDeckhez hasonló, Steam-adatlapba illesztett kék ✓ Xbox jelvény.</div></PanelSectionRow>
    <PanelSectionRow><div>{status}</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? String(stats.entries) + " játék van memóriában; " + String(stats.fresh_entries) + " bejegyzés friss (" + String(stats.ttl_days) + " napos cache)." : "A cache-számláló betöltése folyamatban..."}</div></PanelSectionRow>
    <PanelSectionRow><div style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>Hibanapló: {diagnosticLog}</div></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={working} onClick={backendCheck}>Backend ellenőrzése</ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={working} onClick={clearAndRefresh}>Cache törlése és frissítés</ButtonItem></PanelSectionRow>
  </PanelSection>;
}

export default definePlugin(() => {
  const removeLibraryPatch = patchLibraryAppRoute();
  return {
    name: "Xbox Controller Check",
    titleView: <div className={staticClasses.Title}>Xbox Controller Check</div>,
    content: <Content />,
    icon: <span>✓</span>,
    onDismount: removeLibraryPatch,
  };
});
