import { ButtonItem, definePlugin, PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { callable, toaster } from "@decky/api";
import { useEffect, useState } from "react";

const BADGE_CLASS = "controller-xbox-badge";
const HOME_BADGE_ID = "controller-xbox-home-badge";
const CACHE_CHANGED_EVENT = "controller-xbox-cache-changed";
const REFRESH_EVENT = "controller-xbox-refresh";

type SupportResponse = { success: boolean; support?: Record<string, boolean> };
type CacheStats = {
  entries: number;
  memory_entries: number;
  session_loaded_entries: number;
  full_controller_supported_entries: number;
  fresh_entries: number;
  ttl_days: number;
};

const getControllerSupport = callable<[appIds: string[]], SupportResponse>("get_controller_support");
const clearCache = callable<[], { success: boolean; removed: number }>("clear_controller_cache");
const getCacheStats = callable<[], CacheStats>("get_cache_stats");

function appIdFrom(element: Element): string | undefined {
  const attributes = ["data-appid", "data-gameid", "data-detailed-appid", "data-app-id", "data-ds-appid"];
  const related = [
    element,
    element.closest("a"),
    element.closest("[data-appid], [data-gameid], [data-detailed-appid], [data-app-id], [data-ds-appid]"),
  ].filter((item): item is Element => item !== null);
  for (const item of related) {
    for (const attribute of attributes) {
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
  const candidates = document.querySelectorAll(
    "[data-appid], [data-gameid], [data-detailed-appid], [data-app-id], [data-ds-appid], a[href*='/app/'], a[href*='steam://rungameid/']",
  );
  const games = new Map<string, Element[]>();
  candidates.forEach((candidate) => {
    if (!isVisible(candidate)) return;
    const appId = appIdFrom(candidate);
    if (!appId) return;
    const target = candidate.closest("a, [class*='LibraryTile'], [class*='GameTile'], [class*='Capsule']") || candidate;
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
    .${BADGE_CLASS} { position:absolute; top:6px; right:6px; padding:3px 6px; font-size:12px; line-height:14px; pointer-events:none; }
    #${HOME_BADGE_ID} { display:inline-block; margin:8px 16px; padding:5px 9px; font-size:14px; }
  `;
  document.head.appendChild(style);
  return () => style.remove();
}

function startLibraryBadges(): () => void {
  const removeStyles = installStyles();
  let timer: number | undefined;
  let disposed = false;
  const refresh = async () => {
    if (disposed) return;
    const games = findVisibleGameElements();
    syncHomeLabel(games.size > 0);
    if (!games.size) return;
    try {
      const response = await getControllerSupport([...games.keys()]);
      if (disposed || !response.success) return;
      Object.entries(response.support || {}).forEach(([appId, supported]) => {
        if (supported) games.get(appId)?.forEach(addBadge);
      });
      window.dispatchEvent(new Event(CACHE_CHANGED_EVENT));
    } catch (error) {
      console.debug("ControllerXbox lookup failed", error);
    }
  };
  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 250); };
  const refreshNow = () => { document.querySelectorAll(`.${BADGE_CLASS}, #${HOME_BADGE_ID}`).forEach((node) => node.remove()); schedule(); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("hashchange", schedule);
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
  const [notice, setNotice] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const refreshStats = async () => {
    try { setStats(await getCacheStats()); } catch (error) { console.debug("ControllerXbox stats failed", error); }
  };
  useEffect(() => {
    void refreshStats();
    window.addEventListener(CACHE_CHANGED_EVENT, refreshStats);
    return () => window.removeEventListener(CACHE_CHANGED_EVENT, refreshStats);
  }, []);
  const clearAndRefresh = async () => {
    setClearing(true);
    setNotice("Cache törlése folyamatban…");
    try {
      const response = await clearCache();
      const message = `${response.removed} cache-bejegyzés törölve. A látható játékok adatai most újratöltődnek.`;
      setNotice(message);
      try { toaster.toast({ title: "Xbox Controller Check", body: message }); } catch (error) { console.debug("ControllerXbox toast failed", error); }
      window.dispatchEvent(new Event(CACHE_CHANGED_EVENT));
      window.dispatchEvent(new Event(REFRESH_EVENT));
      await refreshStats();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      setNotice(`A cache törlése nem sikerült: ${details}`);
      console.error("ControllerXbox cache clear failed", error);
    } finally {
      setClearing(false);
    }
  };
  return <PanelSection title="Xbox Controller Check">
    <PanelSectionRow><div>Blue ✓ Xbox badges mark games whose Steam Store listing has official Full Controller Support.</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? `${stats.memory_entries} játék van memóriában; ebből ${stats.full_controller_supported_entries} kapott Full Controller Support jelölést. Ebben az indításban ${stats.session_loaded_entries} játék töltődött be.` : "Cache állapot betöltése…"}</div></PanelSectionRow>
    <PanelSectionRow><div>{stats ? `${stats.fresh_entries}/${stats.entries} bejegyzés friss (${stats.ttl_days} napos érvényesség).` : ""}</div></PanelSectionRow>
    {notice && <PanelSectionRow><div>{notice}</div></PanelSectionRow>}
    <PanelSectionRow><ButtonItem layout="below" disabled={clearing} onClick={clearAndRefresh}>{clearing ? "Cache törlése…" : "Cache törlése és frissítése"}</ButtonItem></PanelSectionRow>
  </PanelSection>;
}

export default definePlugin(() => {
  const stopLibraryBadges = startLibraryBadges();
  return { name: "Xbox Controller Check", titleView: <div className={staticClasses.Title}>Xbox Controller Check</div>, content: <Content />, icon: <span>✓</span>, onDismount: stopLibraryBadges };
});
