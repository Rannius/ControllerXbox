import { ButtonItem, definePlugin, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { callable, toaster } from "@decky/api";
import { useEffect, useState } from "react";

const BADGE_CLASS = "controller-xbox-badge";
const HOME_BADGE_ID = "controller-xbox-home-badge";
const BACKEND_TIMEOUT_MS = 8_000;
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const REFRESH_EVENT = "controller-xbox-refresh";
const APP_ID_ATTRIBUTES = ["data-appid", "data-gameid", "data-detailed-appid", "data-app-id", "data-ds-appid"];
const APP_ID_SELECTOR = "[data-appid], [data-gameid], [data-detailed-appid], [data-app-id], [data-ds-appid], a[href*='/app/'], a[href*='steam://rungameid/']";
type SupportResponse = { success: boolean; support?: Record<string, boolean> };
type CacheStats = { entries: number; fresh_entries: number; ttl_days: number };
type LibraryCheck = { visible: number; checked: number; supported: number };

const getControllerSupport = callable<[appIds: string[]], SupportResponse>("get_controller_support");
const clearCache = callable<[], { success: boolean; removed: number }>("clear_cache");
const getCacheStats = callable<[], CacheStats>("get_cache_stats");

function withBackendTimeout<T>(request: Promise<T>): Promise<T> {
  return Promise.race([
    request,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("A Decky backend 8 masodpercen belul nem valaszolt.")), BACKEND_TIMEOUT_MS);
    }),
  ]);
}

function appIdFrom(element: Element): string | undefined {
  const related = [element, element.closest("a"), element.closest(APP_ID_SELECTOR)].filter((item): item is Element => item !== null);
  for (const item of related) {
    for (const attribute of APP_ID_ATTRIBUTES) {
      const match = item.getAttribute(attribute)?.match(/\d+/);
      if (match) return match[0];
    }
  }
  const href = element.getAttribute("href") || element.closest("a")?.getAttribute("href") || "";
  return href.match(/(?:\/app\/|steam:\/\/rungameid\/)(\d+)/)?.[1];
}

function isVisible(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 40 && box.height > 40 && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
}

function findVisibleGameElements(): Map<string, Element[]> {
  const candidates = document.querySelectorAll(APP_ID_SELECTOR);
  const games = new Map<string, Element[]>();
  candidates.forEach((candidate) => {
    if (!isVisible(candidate)) return;
    const appId = appIdFrom(candidate);
    if (!appId) return;
    const target = candidate.closest("[class*='LibraryTile'], [class*='GameTile'], [class*='Capsule'], a") || candidate;
    const elements = games.get(appId) || [];
    if (!elements.includes(target)) elements.push(target);
    games.set(appId, elements);
  });
  return games;
}

function addBadge(target: Element): void {
  if (target.querySelector(`:scope > .${BADGE_CLASS}`)) return;
  const htmlTarget = target as HTMLElement;
  if (getComputedStyle(htmlTarget).position === "static") htmlTarget.style.position = "relative";
  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.textContent = "\u2713 Xbox";
  badge.title = "Steam: Full Controller Support";
  htmlTarget.appendChild(badge);
}

function syncHomeLabel(hasGames: boolean): void {
  const old = document.getElementById(HOME_BADGE_ID);
  const isHome = /library\/home/.test(location.hash) || /library\/home/.test(location.pathname);
  if (!hasGames || !isHome || old) return;
  const root = document.querySelector("[class*='Home'], [class*='home']");
  if (!root) return;
  const label = document.createElement("div");
  label.id = HOME_BADGE_ID;
  label.textContent = "\u2713 Xbox — Full Controller Support";
  root.prepend(label);
}

function installStyles(): () => void {
  const style = document.createElement("style");
  style.textContent = `
    .${BADGE_CLASS}, #${HOME_BADGE_ID} { background:#107cde; color:#fff; font-weight:700; border-radius:4px; box-shadow:0 1px 4px #0009; font-family:Arial,sans-serif; z-index:20; }
    .${BADGE_CLASS} { position:absolute; top:6px; left:6px; padding:3px 6px; font-size:12px; line-height:14px; pointer-events:none; }
    #${HOME_BADGE_ID} { display:inline-block; margin:8px 16px; padding:5px 9px; font-size:14px; }
  `;
  document.head.appendChild(style);
  return () => style.remove();
}

function startLibraryBadges(): () => void {
  const removeStyles = installStyles();
  let timer: number | undefined;
  let disposed = false;
  let lastCheckSignature = "";
  const refresh = async () => {
    if (disposed) return;
    const games = findVisibleGameElements();
    syncHomeLabel(games.size > 0);
    if (!games.size) {
      if (lastCheckSignature !== "0/0/0") {
        lastCheckSignature = "0/0/0";
        window.dispatchEvent(new CustomEvent<LibraryCheck>(CACHE_CHANGED_EVENT, { detail: { visible: 0, checked: 0, supported: 0 } }));
      }
      return;
    }
    try {
      const response = await getControllerSupport([...games.keys()]);
      if (disposed || !response.success) return;
      Object.entries(response.support || {}).forEach(([appId, supported]) => {
        if (supported) games.get(appId)?.forEach(addBadge);
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
        window.dispatchEvent(new CustomEvent<LibraryCheck>(CACHE_CHANGED_EVENT, { detail }));
      }
    } catch (error) {
      console.debug("ControllerXbox lookup failed", error);
    }
  };
  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 250); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("hashchange", schedule);
  const refreshNow = () => {
    document.querySelectorAll(`.${BADGE_CLASS}, #${HOME_BADGE_ID}`).forEach((node) => node.remove());
    schedule();
  };
  window.addEventListener(REFRESH_EVENT, refreshNow);
  schedule();
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
  const [stats, setStats] = useState<CacheStats>();
  const [libraryCheck, setLibraryCheck] = useState<LibraryCheck>();
  const [statusError, setStatusError] = useState<string>();
  const refreshStats = async () => {
    try {
      setStats(await withBackendTimeout(getCacheStats()));
      setStatusError(undefined);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => {
    void refreshStats();
    const onCacheChanged = (event: Event) => {
      const detail = (event as CustomEvent<LibraryCheck>).detail;
      if (detail) setLibraryCheck(detail);
      void refreshStats();
    };
    window.addEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
    return () => window.removeEventListener(CACHE_CHANGED_EVENT, onCacheChanged);
  }, []);
  return <PanelSection title="Xbox Controller Check">
    <PanelSectionRow><div>Blue ✓ Xbox badges mark games whose Steam Store listing has official Full Controller Support.</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? `${stats.entries} jatek van memoriaban; ${stats.fresh_entries} bejegyzes friss (${stats.ttl_days} napos cache).` : "Cache status betoltese..."}</div></PanelSectionRow>
    <PanelSectionRow><div>{libraryCheck ? `${libraryCheck.checked}/${libraryCheck.visible} lathato jatek ellenorizve; ${libraryCheck.supported} kapott Xbox jelvenyt.` : "A lathato jatekok ellenorzese meg nem indult el."}</div></PanelSectionRow>
    {statusError && <PanelSectionRow><div>Cache status error: {statusError}</div></PanelSectionRow>}
    <PanelSectionRow><ButtonItem layout="below" onClick={async () => { const response = await clearCache(); toaster.toast({ title: "Xbox Controller Check", body: `${response.removed} cached entries cleared.` }); window.dispatchEvent(new Event(REFRESH_EVENT)); await refreshStats(); }}>Clear and refresh cache</ButtonItem></PanelSectionRow>
  </PanelSection>;
}

export default definePlugin(() => {
  const stopLibraryBadges = startLibraryBadges();
  return { name: "Xbox Controller Check", titleView: <div className={staticClasses.Title}>Xbox Controller Check</div>, content: <Content />, icon: <span>✓</span>, onDismount: stopLibraryBadges };
});
