import { callable } from "@decky/api";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type VersionInfo = { version: string; source: "game" | "project" };
type BuildResponse = { success: boolean; builds?: Record<string, string>; versions?: Record<string, VersionInfo> };
const getInstalledBuilds = callable<[string[]], BuildResponse>("get_installed_builds");
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { build: string; version: string; source: string; expires: number }>();
const queued = new Set<string>();
const mounted = new Map<string, number>();
const listeners = new Set<() => void>();
let enabled = false;
let inStore = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let fetching = false;

function notify(): void { for (const listener of listeners) listener(); }

export function configureInstalledBuilds(show: boolean, store: boolean): void {
  const changed = enabled !== show || inStore !== store;
  enabled = show;
  inStore = store;
  if (!show || store) {
    queued.clear();
    clearTimeout(timer);
    timer = undefined;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  if (changed) notify();
}

export function stopInstalledBuilds(): void {
  configureInstalledBuilds(false, false);
  cache.clear();
  mounted.clear();
  listeners.clear();
}

function trackBuild(appId: string): () => void {
  mounted.set(appId, (mounted.get(appId) ?? 0) + 1);
  if (!refreshTimer) refreshTimer = setInterval(() => {
    for (const id of mounted.keys()) queueBuild(id);
  }, CACHE_MS);
  return () => {
    const count = (mounted.get(appId) ?? 1) - 1;
    if (count) mounted.set(appId, count);
    else { mounted.delete(appId); queued.delete(appId); }
    if (!mounted.size) { clearInterval(refreshTimer); refreshTimer = undefined; }
  };
}

function queueBuild(appId: string): void {
  const cached = cache.get(appId);
  if (!enabled || inStore || (cached && cached.expires > Date.now())) return;
  queued.add(appId);
  if (!fetching && !timer) timer = setTimeout(() => void flushBuilds(), 120);
}

async function flushBuilds(): Promise<void> {
  timer = undefined;
  if (fetching || !enabled || inStore || !queued.size) return;
  fetching = true;
  const ids = Array.from(queued).slice(0, 100);
  for (const id of ids) queued.delete(id);
  try {
    const response = await getInstalledBuilds(ids);
    if (response.success) {
      const expires = Date.now() + CACHE_MS;
      for (const id of ids) {
        const build = response.builds?.[id];
        const info = response.versions?.[id];
        const version = (info?.source === "game" || info?.source === "project") && typeof info.version === "string" && /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.]+)?$/.test(info.version) ? info.version : "";
        cache.set(id, { build: typeof build === "string" && /^\d{1,20}$/.test(build) ? build : "",
          version, source: version ? info?.source ?? "" : "", expires });
      }
      notify();
    }
  } catch { /* A következő megnyitáskor ismét megpróbáljuk. */ }
  finally {
    fetching = false;
    if (queued.size && enabled && !inStore) timer = setTimeout(() => void flushBuilds(), 120);
  }
}

function findTileHost(marker: HTMLElement): HTMLElement | null {
  let candidate = marker.parentElement;
  let best: HTMLElement | null = null;
  let bestWidth = 0;
  for (let depth = 0; candidate && depth < 7; depth++, candidate = candidate.parentElement) {
    const rect = candidate.getBoundingClientRect();
    if (rect.width > 520 || rect.height > 700) break;
    if (rect.width < 90 || rect.height < 90) continue;
    if (candidate.querySelectorAll("[data-dpb-build-marker]").length > 1 || (best && rect.width > bestWidth * 1.25)) break;
    best = candidate;
    bestWidth = rect.width;
  }
  return best;
}

export function InstalledBuildLabel({ appId, installedHint }: { appId: number; installedHint?: boolean }) {
  const id = String(appId);
  const [view, setView] = useState(() => ({ enabled, inStore }));
  const [result, setResult] = useState(() => ({ id, build: cache.get(id)?.build ?? "",
    version: cache.get(id)?.version ?? "", source: cache.get(id)?.source ?? "", resolved: cache.has(id) }));
  const marker = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement | null>(null);
  const build = result.id === id ? result.build : cache.get(id)?.build ?? "";
  const version = result.id === id ? result.version : cache.get(id)?.version ?? "";
  const source = result.id === id ? result.source : cache.get(id)?.source ?? "";
  const display = version ? version : build ? "Build: " + build : "";
  const resolved = result.id === id ? result.resolved : cache.has(id);
  const active = view.enabled && !view.inStore && installedHint !== false;
  const showArea = active && (Boolean(display) || (installedHint === true && !resolved));

  useEffect(() => {
    const listener = () => {
      setView(current => current.enabled === enabled && current.inStore === inStore ? current : { enabled, inStore });
      const next = { id, build: cache.get(id)?.build ?? "", version: cache.get(id)?.version ?? "",
        source: cache.get(id)?.source ?? "", resolved: cache.has(id) };
      setResult(current => current.id === next.id && current.build === next.build && current.version === next.version
        && current.source === next.source && current.resolved === next.resolved ? current : next);
    };
    listeners.add(listener);
    listener();
    const untrack = active ? trackBuild(id) : undefined;
    if (active) queueBuild(id);
    return () => { listeners.delete(listener); untrack?.(); };
  }, [id, active]);

  useLayoutEffect(() => {
    const element = marker.current;
    if (!showArea || !element) return;
    const host = findTileHost(element);
    if (!host) return;
    const style = host.style;
    const saved = Object.fromEntries(["position", "overflow", "margin-bottom"].map(key =>
      [key, { value: style.getPropertyValue(key), priority: style.getPropertyPriority(key) }]));
    const computed = element.ownerDocument.defaultView!.getComputedStyle(host);
    if (computed.position === "static") style.setProperty("position", "relative");
    if (computed.overflow === "hidden") style.setProperty("overflow", "visible");
    if ((parseFloat(computed.marginBottom) || 0) < 28) style.setProperty("margin-bottom", "28px");
    const row = element.ownerDocument.createElement("span");
    row.className = "dpb-installed-build";
    row.style.cssText = "position:absolute;top:calc(100% + 3px);left:0;width:100%;height:23px;box-sizing:border-box;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#162634;color:#dce6ed;padding:2px 6px;font:11px/19px Arial,sans-serif;pointer-events:none;z-index:2";
    row.textContent = display;
    row.style.visibility = display ? "visible" : "hidden";
    host.appendChild(row);
    label.current = row;
    return () => {
      if (label.current === row) label.current = null;
      row.remove();
      for (const [key, old] of Object.entries(saved)) {
        const current = style.getPropertyValue(key);
        if (current === (key === "position" ? "relative" : key === "overflow" ? "visible" : "28px")) {
          if (old.value) style.setProperty(key, old.value, old.priority);
          else style.removeProperty(key);
        }
      }
    };
  }, [showArea, id]);

  useLayoutEffect(() => {
    if (!label.current) return;
    label.current.textContent = display;
    label.current.style.visibility = display ? "visible" : "hidden";
    label.current.title = version ? "Játék saját verzióadata: "
      + version + (build ? " · Steam-build: " + build : "") : build ? "Telepített Steam-build: " + build : "";
  }, [build, version, source, display]);

  return active ? <span ref={marker} data-dpb-build-marker="true" style={{ display: "none" }} /> : null;
}
