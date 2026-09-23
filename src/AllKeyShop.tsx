import { allowsStoreTilePrices, storePriceTilesScript } from "./storePriceTiles";
import { useEffect, useState } from "react";
import { ButtonItem, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { callable } from "@decky/api";


type Preferences = { success: boolean; enabled: boolean; allow_gifts: boolean; merchants: string[]; restrict_merchants: boolean; error?: string };
export type PriceResult = { success: boolean; skipped?: "unreleased" | "release_unknown" | "free"; error_code?: string; global_error?: boolean; retry_after?: number; retry_at?: number; disabled?: boolean; error?: string; title?: string; url?: string;
  checked_at?: number; currency?: string; preferred_only?: boolean; matched_offers?: number;
  offers?: { merchant: string; price: number; kind: string; edition: string; coupon: string }[] };
const getPreferences = callable<[], Preferences>("get_price_preferences");
const setPreferences = callable<[boolean, boolean, string[], boolean], Preferences>("set_price_preferences");
const getMerchants = callable<[boolean], { success: boolean; merchants: string[]; error?: string }>("get_price_merchants");
const getPrice = callable<[string], PriceResult>("get_allkeyshop_price");

async function timed<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([request, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Az árlekérdezés nem válaszolt időben.")), 120000);
  })]); } finally { clearTimeout(timer!); }
}

export function AllKeyShopSettings({ openMerchants }: { openMerchants(): void }) {
  const [prefs, setPrefs] = useState<Preferences>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void timed(getPreferences()).then(value => {
      if (active) { if (!value.success) throw new Error(value.error || "Betöltési hiba"); setPrefs(value); }
    }).catch(error => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, []);
  return <>
    <PanelSectionRow><div style={{ marginTop: "12px", fontWeight: 700 }}>AllKeyShop árak</div></PanelSectionRow>
    {prefs && <>
      <PanelSectionRow><ToggleField label="Árak az áruházi játékoldalon" checked={prefs.enabled} disabled={busy}
        onChange={async (enabled) => {
          const updated = { ...prefs, enabled };
          setPrefs(updated); setBusy(true); setMessage("");
          try {
            const current = await timed(getPreferences());
            if (!current.success) throw new Error(current.error || "Betöltési hiba");
            const value = await timed(setPreferences(enabled, updated.allow_gifts, current.merchants, current.restrict_merchants));
            if (!value.success) throw new Error(value.error || "Mentési hiba");
            setPrefs(value); resetPriceView(); setMessage(enabled ? "Árlekérés bekapcsolva." : "Árlekérés kikapcsolva.");
          } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
        }} /></PanelSectionRow>
      <PanelSectionRow><ToggleField label="Steam Gift is megengedett" checked={prefs.allow_gifts} disabled={busy}
        onChange={allow_gifts => setPrefs({ ...prefs, allow_gifts })} /></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" onClick={openMerchants}>Megbízható boltok kiválasztása</ButtonItem></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={busy} onClick={async () => {
        setBusy(true); setMessage("");
        try {
          const current = await timed(getPreferences());
          if (!current.success) throw new Error(current.error || "Betöltési hiba");
          const value = await timed(setPreferences(prefs.enabled, prefs.allow_gifts, current.merchants, current.restrict_merchants));
          if (!value.success) throw new Error(value.error || "Mentési hiba");
          setPrefs(value); resetPriceView(); setMessage("Árbeállítások mentve.");
        } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
      }}>{busy ? "Mentés…" : "Árbeállítások alkalmazása"}</ButtonItem></PanelSectionRow>
    </>}
    <PanelSectionRow><div style={{ fontSize: "12px", opacity: .8 }}>{message || "EUR · Standard kiadás · Global/EU Steam-kulcsok és opcionálisan Gift. Account és ismeretlen típus kizárva. Alapból a megnyitott játékhoz, külön engedéllyel a látható áruházi csempékhez is kér árat; 30 percig tárolja. Az AllKeyShop-kérések között legalább 5 másodperc szünet van."}</div></PanelSectionRow>
  </>;
}

export function AllKeyShopMerchants({ onBack }: { onBack(): void }) {
  const [names, setNames] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([timed(getPreferences()), timed(getMerchants(false))]).then(([prefs, list]) => {
      if (!active) return;
      if (!prefs.success || !list.success) throw new Error("A boltlista nem tölthető be.");
      setNames(list.merchants);
      setSelected(new Set((prefs.restrict_merchants ? prefs.merchants : list.merchants).map(name => name.toLowerCase())));
      setMessage(list.error || ""); setReady(true);
    }).catch(error => { if (active) setMessage(String(error)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const visible = names.filter(name => name.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <PanelSectionRow><ButtonItem layout="below" onClick={onBack}>← Vissza</ButtonItem></PanelSectionRow>
    <PanelSectionRow><div style={{ fontSize: "12px", lineHeight: 1.5 }}>
      Te döntöd el, mely boltokban bízol. A mentés után kizárólag a bepipált boltok megfelelő Steam-kulcs/Gift ajánlatait mutatjuk. Ha egyet sem választasz, nem jelenik meg ajánlat. Az újonnan talált boltokat külön engedélyezheted.
    </div></PanelSectionRow>
    <PanelSectionRow><TextField label="Bolt keresése" value={query} onChange={event => setQuery(event.currentTarget.value)} /></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const list = await timed(getMerchants(true));
        if (!list.success) throw new Error(list.error || "Frissítési hiba");
        setNames(list.merchants); setMessage(list.error || "Boltlista frissítve.");
        if (!ready) {
          const prefs = await timed(getPreferences());
          if (!prefs.success) throw new Error("Beállításbetöltési hiba");
          setSelected(new Set((prefs.restrict_merchants ? prefs.merchants : list.merchants).map(name => name.toLowerCase()))); setReady(true);
        }
      } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
    }}>Boltlista frissítése</ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={busy || !ready} onClick={() => setSelected(new Set(names.map(name => name.toLowerCase())))}>Összes kijelölése</ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={busy || !ready} onClick={() => setSelected(new Set())}>Kijelölések törlése</ButtonItem></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={busy || !ready} onClick={async () => {
      setBusy(true);
      try {
        const prefs = await timed(getPreferences());
        if (!prefs.success) throw new Error("Beállításbetöltési hiba");
        const saved = await timed(setPreferences(prefs.enabled, prefs.allow_gifts, names.filter(name => selected.has(name.toLowerCase())), true));
        if (!saved.success) throw new Error(saved.error || "Mentési hiba");
        resetPriceView(); setMessage("Kijelölések mentve. Az árak ezekből a boltokból számolódnak.");
      } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
    }}>Kijelölések mentése ({selected.size})</ButtonItem></PanelSectionRow>
    <PanelSectionRow><div role="status">{busy ? "Boltlista feldolgozása…" : message || `${selected.size} kiválasztva · ${names.length} ismert bolt`}</div></PanelSectionRow>
    {visible.map(name => <PanelSectionRow key={name.toLowerCase()}><ToggleField label={name}
      checked={selected.has(name.toLowerCase())} disabled={busy || !ready} onChange={checked => setSelected(previous => {
        const next = new Set(previous); if (checked) next.add(name.toLowerCase()); else next.delete(name.toLowerCase()); return next;
      })} /></PanelSectionRow>)}
    {!busy && !visible.length && <PanelSectionRow><div>Nincs megjeleníthető bolt. Próbáld frissíteni a listát vagy módosítsd a keresést.</div></PanelSectionRow>}
  </>;
}

// One lightweight timer per Store page; no network requests from the countdown.
export const priceCountdownScript = `
  function updatePriceCountdown() {
    const nodes = document.querySelectorAll('[data-dpb-retry-at]');
    for (const node of nodes) {
      const seconds = Math.max(0, Math.ceil((Number(node.dataset.dpbRetryAt) - Date.now()) / 1000));
      node.textContent = node.dataset.dpbLabel + (seconds ? ' · újra: ' + seconds + ' mp' : ' · újrapróbálkozás…');
      node.title = node.textContent;
    }
    if (!nodes.length && window.__dpbPriceCountdown) {
      clearInterval(window.__dpbPriceCountdown); delete window.__dpbPriceCountdown;
    }
    return nodes.length;
  }
  if (updatePriceCountdown() && !window.__dpbPriceCountdown) window.__dpbPriceCountdown = setInterval(updatePriceCountdown, 1000);
`;

// Keep this renderer independent of Steam selectors except for its insertion
// point. All third-party text is assigned through textContent, never HTML.
export function buildPricePanelScript(appId: string, result?: PriceResult): string {
  return `(() => {
    const appId = ${JSON.stringify(appId)};
    const data = ${JSON.stringify(result ?? null).replace(/</g, "\\u003c")};
    const id = 'deck-play-badges-price';
    const pageId = location.pathname.match(/^\\/app\\/(\\d+)/)?.[1];
    let panel = document.getElementById(id);
    if (!appId) { panel?.remove(); return; }
    if (pageId !== appId) return;
    if (data?.disabled || data?.skipped) { panel?.remove(); return; }
    // Gamepad Store is a React page, with no legacy purchase markup.
    const gamepadPrice = document.documentElement.classList.contains('GamepadMode')
      ? Array.from(document.querySelectorAll('.StoreSalePriceWidgetContainer')).find(node =>
          node.getBoundingClientRect().height > 0 && !node.closest('a[href], .CapsuleBottomBar')) : null;
    const gamepadRow = gamepadPrice?.parentElement;
    const gamepadAnchor = gamepadRow && getComputedStyle(gamepadRow.parentElement).flexDirection === 'column' ? gamepadRow : null;
    const purchase = Array.from(document.querySelectorAll('.game_area_purchase_game')).find(node =>
      !node.matches('.demo_above_purchase, .game_area_purchase_game_demo') &&
      !node.closest('[data-ds-bundleid]') && !node.querySelector('[name="bundleid"]') && node.getBoundingClientRect().height > 0 && node.querySelector('.game_purchase_price, .discount_final_price, .game_purchase_action'));
    const anchor = gamepadAnchor || purchase;
    if (!anchor) { panel?.remove(); return; }
    const key = appId + ':' + Boolean(gamepadAnchor) + ':' + JSON.stringify(data);
    if (panel?.dataset.state === key && panel.previousElementSibling === anchor) return;
    const wasOpen = panel?.open === true;
    panel?.remove(); panel = document.createElement('details'); panel.id = id; panel.dataset.state = key; panel.open = wasOpen;
    panel.style.cssText = 'display:flow-root;clear:none;position:relative;box-sizing:border-box;width:100%;margin:24px 0 16px;pointer-events:auto;color:#dce6ed;font:14px/1.5 Arial,sans-serif';
    if (gamepadAnchor) panel.style.cssText = 'display:block;flex:0 0 auto;box-sizing:border-box;max-width:100%;max-height:170px;overflow:auto;margin:6px 0 0;pointer-events:auto;color:#dce6ed;font:12px/1.4 Arial,sans-serif';
    panel.addEventListener('click', event => event.stopPropagation());
    const summary = document.createElement('summary');
    const best = data?.offers?.[0];
    summary.textContent = !data ? 'AKS …' : !data.success ? 'AKS: ' + ({backend:'Decky-kapcsolati hiba',connection:'kapcsolati hiba',rate_limit:'várakozás',http:'szerverhiba',steam:'Steam-adathiba',match:'nem azonosítható',format:'adatformátum-hiba'}[data.error_code] || 'hiba') : best ? 'AllKeyShop · Standard: ' + best.price.toFixed(2) + ' € · ' + best.merchant : 'AKS: nincs ajánlat';
    if (data?.retry_at && !data.success) { summary.dataset.dpbRetryAt = String(data.retry_at); summary.dataset.dpbLabel = summary.textContent; }
    summary.title = 'AllKeyShop ár és ajánlatok – megnyitás';
    summary.style.cssText = 'cursor:pointer;white-space:normal;overflow-wrap:anywhere;box-sizing:border-box;list-style:none;border:1px solid #67c1f5;border-radius:5px;background:#162634;padding:2px 8px;font-weight:700;min-height:24px';
    panel.appendChild(summary);
    const content = document.createElement('div');
    content.style.cssText = 'box-sizing:border-box;width:100%;overflow-wrap:anywhere;background:#162634;border:1px solid #4a6478;border-radius:6px;padding:14px;margin-top:4px';
    panel.appendChild(content);
    const line = (text, bold = false) => { const node = document.createElement('div'); node.textContent = text; if (bold) node.style.fontWeight = '700'; content.appendChild(node); };
    line('AllKeyShop · Steam-kulcs / Gift', true);
    if (!data) line('Árak betöltése…');
    else if (!data.success) { line(data.error || 'Az ár most nem érhető el.'); if (data.global_error) line('A többi árlekérés is szünetel. A következő próbáig hátralévő idő az ársorban látható. Az újrapróbálkozáshoz maradjon nyitva az áruház.'); }
    else {
      line(data.preferred_only ? 'Legalacsonyabb ár a kiválasztott boltokból' : 'Legalacsonyabb megfelelő ajánlat');
      if (!data.offers?.length) line('Nincs megfelelő Steam-kulcs vagy Gift az aktuális szűrőkkel.');
      for (const [index, offer] of (data.offers || []).entries()) {
        line(offer.price.toFixed(2) + ' € · ' + offer.merchant, index === 0);
        line(offer.kind + ' · ' + offer.edition + (offer.coupon ? ' · Kupon: ' + offer.coupon : ''));
      }
      line('AKS szerinti, kártyadíjat tartalmazó ár; kupon esetén annak feltételeivel.');
      line('Global/EU besorolás. A végösszeget és a magyarországi aktiválhatóságot az eladónál ellenőrizd.');
      if (data.checked_at) line('Utoljára ellenőrizve: ' + new Date(data.checked_at * 1000).toLocaleString('hu-HU'));
      if (/^https:\\/\\/www\\.allkeyshop\\.com\\/blog\\/(?:buy-|compare-and-buy-cd-key-for-digital-download-)[a-z0-9-]+\\/$/.test(data.url || '')) {
        const link = document.createElement('a'); link.href = data.url; link.textContent = 'AllKeyShop adatlap megnyitása (az ottani lista külön szűrhető)';
        link.style.cssText = 'display:block;color:#67c1f5;padding:8px 0'; content.appendChild(link);
      }
    }
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { panel.open = false; summary.focus(); } });
    anchor.insertAdjacentElement('afterend', panel);
    ${priceCountdownScript}
  })();`;
}

// Tile rows reserve their own space; remove our changes when disabled or recycled.
export const tilePriceCleanupScript = `
  for (const [host, original] of window.__dpbPriceTiles || []) {
    host.querySelector(':scope > .dpb-tile-price')?.remove();
    for (const [key, value, priority] of original) {
      if (value) host.style.setProperty(key, value, priority); else host.style.removeProperty(key);
    }
  }
  delete window.__dpbPriceTiles;
`;

export function buildTilePricesScript(url: string, values: Record<string, PriceResult | null>): string {
  return `(() => {
    if (location.href !== ${JSON.stringify(url).replace(/</g, "\\u003c")}) return;
    ${tilePriceCleanupScript}
    const values = ${JSON.stringify(values).replace(/</g, "\\u003c")};
    const saved = window.__dpbPriceTiles = new Map();
    ${storePriceTilesScript}
    for (const {host, id} of collectPriceTiles()) {
      if (!(id in values) || values[id]?.disabled || values[id]?.skipped) continue;
      saved.set(host, ['position', 'padding-bottom', 'box-sizing', 'overflow'].map(key => [key, host.style.getPropertyValue(key), host.style.getPropertyPriority(key)]));
      const oldPadding = parseFloat(getComputedStyle(host).paddingBottom) || 0;
      if (getComputedStyle(host).position === 'static') host.style.setProperty('position', 'relative');
      host.style.setProperty('padding-bottom', (oldPadding + 26) + 'px', 'important');
      host.style.setProperty('box-sizing', 'content-box', 'important');
      host.style.setProperty('overflow', 'visible', 'important');
      const value = values[id], offer = value?.offers?.[0];
      const row = document.createElement('span'); row.className = 'dpb-tile-price';
      row.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:26px;box-sizing:border-box;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#162634;color:#dce6ed;padding:3px 6px;font:12px/20px Arial,sans-serif;pointer-events:none;z-index:2';
      row.textContent = !value ? 'AKS: betöltés…' : !value.success ? 'AKS: ' + ({backend:'Decky-kapcsolati hiba',connection:'kapcsolati hiba',rate_limit:'várakozás',http:'szerverhiba',steam:'Steam-adathiba',match:'nem azonosítható',format:'adatformátum-hiba'}[value.error_code] || 'nem elérhető') : offer ? 'AKS ' + offer.price.toFixed(2) + ' € · ' + offer.merchant : 'AKS: nincs ajánlat';
      if (value?.retry_at && !value.success) { row.dataset.dpbRetryAt = String(value.retry_at); row.dataset.dpbLabel = row.textContent; }
      row.title = row.textContent;
      host.appendChild(row);
    }
    ${priceCountdownScript}
  })();`;
}

const prices = new Map<string, { value: PriceResult; expires: number }>();
let fetching = false;
let serviceFailure: { value: PriceResult; expires: number } | undefined;
let revision = 0;
let currentApp = "";
let tileUrl = "";
let tileIds: string[] = [];
let visibleApps = new Set<string>();
const refreshQueue = new Set<string>();
function visiblePrice(id: string): PriceResult | undefined {
  const cached = prices.get(id);
  if (cached) return cached.value;
  return serviceFailure && serviceFailure.expires > Date.now() ? serviceFailure.value : undefined;
}
export function resetPriceView(): void { prices.clear(); serviceFailure = undefined; revision++; currentApp = ""; tileIds = []; tileUrl = ""; visibleApps.clear(); refreshQueue.clear(); }
export function updatePriceView(url: string, send: (script: string) => Promise<unknown>, visibleTileIds: string[] = []): void {
  let id = "";
  try { const parsed = new URL(url); if (parsed.hostname === "store.steampowered.com") id = parsed.pathname.match(/^\/app\/(\d+)/)?.[1] ?? ""; } catch { /* no game */ }
  const previousApp = currentApp;
  currentApp = id;
  tileUrl = url;
  tileIds = allowsStoreTilePrices(url) ? Array.from(new Set(visibleTileIds.filter(value => /^\d+$/.test(value)))) : [];
  const nextVisible = new Set([...tileIds, ...(id ? [id] : [])]);
  for (const app of nextVisible) {
    const entry = prices.get(app);
    // A currentApp mindig bekerül; csempékre max. 4 elem sorban, hogy ne okozzunk rate-limitet
    if ((!visibleApps.has(app) || (app === id && id !== previousApp)) && (!entry || entry.expires <= Date.now()))
      if (app === id || refreshQueue.size < 4) refreshQueue.add(app);
  }
  for (const app of refreshQueue) if (!nextVisible.has(app)) refreshQueue.delete(app);
  visibleApps = nextVisible;
  const renderTiles = () => {
    const values: Record<string, PriceResult | null> = {};
    for (const tile of tileIds) values[tile] = visiblePrice(tile) ?? null;
    void send(buildTilePricesScript(tileUrl, values)).catch(() => {});
  };
  renderTiles();
  void send(buildPricePanelScript(id, visiblePrice(id))).catch(() => {});
  // Expiry alone never refreshes a successful visible price. Failed requests retain
  // the existing retry countdown; stale successful prices wait for a new appearance.
  const needsRequest = (app: string) => refreshQueue.has(app) ||
    (prices.has(app) && !prices.get(app)!.value.success && prices.get(app)!.expires <= Date.now());
  const pending = [...refreshQueue];
  const requestId = id && needsRequest(id) ? id : pending.find(app => !prices.has(app)) ??
    pending[0] ?? tileIds.find(needsRequest);
  if (!requestId || fetching || (serviceFailure && serviceFailure.expires > Date.now())) return;
  fetching = true;
  const requestRevision = revision;
  void timed(getPrice(requestId)).catch(error => ({ success: false, error: String(error), error_code: "backend", global_error: true, retry_after: 15 } as PriceResult)).then(value => {
    if (requestRevision !== revision) return;
    if (value.global_error) {
      const expires = Date.now() + Math.max(1, Math.min(300, value.retry_after ?? 15)) * 1000;
      serviceFailure = { value: { ...value, retry_at: expires }, expires };
      if (currentApp) void send(buildPricePanelScript(currentApp, visiblePrice(currentApp) ?? value)).catch(() => {});
      if (tileIds.length) renderTiles();
      return;
    }
    serviceFailure = undefined;
    refreshQueue.delete(requestId);
    if (prices.size >= 500) prices.delete(prices.keys().next().value!);
    const age = value.checked_at ? Math.max(0, Date.now() - value.checked_at * 1000) : 0;
    const expires = Date.now() + (value.success && !value.disabled ? Math.max(0, 1800000 - age) : Math.max(1, Math.min(300, value.retry_after ?? 30)) * 1000);
    if (!value.success) value = { ...value, retry_at: expires };
    prices.set(requestId, { value, expires });
    if (currentApp === requestId) void send(buildPricePanelScript(requestId, value)).catch(() => {});
    if (tileIds.length) renderTiles();
  }).finally(() => { fetching = false; });
}
