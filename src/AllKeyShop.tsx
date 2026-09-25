import { allowsStoreTilePrices, storePriceTilesScript } from "./storePriceTiles";
import { useEffect, useState } from "react";
import { ButtonItem, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { callable } from "@decky/api";


type Preferences = { provider: "aks" | "gg"; gg_key_configured: boolean; success: boolean; enabled: boolean; allow_gifts: boolean; merchants: string[]; restrict_merchants: boolean; error?: string };
export type PriceResult = { pending?: boolean; fallback_from?: "aks"; provider?: "aks" | "gg"; retail_price?: number | null; keyshop_price?: number | null; success: boolean; not_found?: boolean; history_unavailable?: boolean; match_status?: "missing" | "ambiguous" | ""; missing?: boolean; stale?: boolean; skipped?: "unreleased" | "release_unknown" | "free"; error_code?: string; global_error?: boolean; retry_after?: number; retry_at?: number; disabled?: boolean; error?: string; title?: string; url?: string;
  filtering?: Record<string, number>; source?: "aks_history" | "aks_page"; source_updated_at?: string; checked_at?: number; currency?: string; preferred_only?: boolean; matched_offers?: number;
  offers?: { merchant: string; price: number; kind: string; edition: string; coupon: string; source_updated_at?: string; price_kind?: "regular" | "discount" }[] };
const getPreferences = callable<[], Preferences>("get_price_preferences");
const setPreferences = callable<[boolean, boolean, string[], boolean], Preferences>("set_price_preferences");
const setProvider = callable<[string, string | null], Preferences>("set_price_provider");
const getMerchants = callable<[boolean], { success: boolean; merchants: string[]; error?: string }>("get_price_merchants");
type PriceBatch = { success: boolean; prices: Record<string, PriceResult> };
const getCachedPrices = callable<[string[]], PriceBatch>("get_cached_allkeyshop_prices");
const getRemotePricePreviews = callable<[string[]], PriceBatch>("get_remote_price_previews");
const getPrice = callable<[string], PriceResult>("get_allkeyshop_price");

async function timed<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([request, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Az árlekérdezés nem válaszolt időben.")), 120000);
  })]); } finally { clearTimeout(timer!); }
}

type Connection = { success: boolean; mode: "direct" | "server"; url: string; token_configured: boolean; error?: string };
const getConnection = callable<[], Connection>("get_price_connection");
const setConnection = callable<[string, string, string | null], Connection>("set_price_connection");
const testServer = callable<[], { success: boolean; error?: string; gg_available?: boolean; queue?: number; aks_entries?: number; gg_entries?: number }>("test_price_server");
type PriceStats = {
  price_connection: "direct" | "server"; price_server_queue: number;
  price_provider: "aks" | "gg"; price_metadata_entries: number; price_match_entries: number;
  price_entries: number; price_fresh_entries: number; price_wishlist_total: number;
  price_wishlist_ready: number; price_wishlist_skipped: number; price_wishlist_current: string; price_wishlist_deferred: number;
  price_wishlist_active: boolean; price_retry_after: number; price_disk_error: string; price_wishlist_error: string; price_last_error: string;
};
const getPriceStats = callable<[], PriceStats>("get_price_cache_stats");
const clearPriceCache = callable<[], PriceStats>("clear_price_cache");
export function PriceCacheStatus() {
  const [stats, setStats] = useState<PriceStats>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await timed(getPriceStats()); if (active) { setStats(value); setError(""); } }
      catch (error) { if (active) setError(String(error)); }
      finally { if (active) timer = setTimeout(() => void poll(), 5000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  return <>
    <PanelSectionRow><div role="status" style={{ fontSize: "12px", lineHeight: 1.5 }}>
      {stats ? <>
        <div>{stats.price_provider === "gg" ? "GG.deals" : "AKS"} árgyorsítótár: {stats.price_fresh_entries}/{stats.price_entries} friss · 24 óra (üres AKS-adat: 1 óra) · lemezre mentve</div>
        {stats.price_connection === "server" && <div>Saját szerver · sorban: {stats.price_server_queue} · helyi ármentés aktív</div>}
        <div>Steam-adatok: {stats.price_metadata_entries} · AKS-hivatkozások: {stats.price_match_entries}</div>
        <div>Kívánságlista: {stats.price_wishlist_ready}/{stats.price_wishlist_total} ellenőrizve
          {stats.price_wishlist_skipped > 0 ? ` · ebből ${stats.price_wishlist_skipped} kihagyva (ingyenes / megjelenés)` : ""}</div>
        {stats.price_wishlist_deferred > 0 && <div>{stats.price_wishlist_deferred} tétel várakozik a következő háttérpróbára.</div>}
        <div>{stats.price_retry_after > 0 ? `Kapcsolati szünet: ${stats.price_retry_after} mp`
          : !stats.price_wishlist_active ? "Előtöltés szünetel. Az áruház megnyitásakor indul."
          : stats.price_wishlist_current ? `Ellenőrzés: Steam ${stats.price_wishlist_current}`
          : stats.price_wishlist_ready === stats.price_wishlist_total ? "Naprakész. Csak a 24 óránál régebbi adatok frissülnek."
          : "A következő játék ellenőrzésére vár."}</div>
        {stats.price_disk_error && <div>{stats.price_disk_error}</div>}
        {stats.price_wishlist_error && <div>Kívánságlista: {stats.price_wishlist_error}</div>}
        {stats.price_last_error && <div>Legutóbbi árlekérési hiba: {stats.price_last_error}</div>}
      </> : "Árgyorsítótár betöltése…"}
      {error && <div>{error}</div>}
    </div></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={busy} onClick={async () => {
      setBusy(true);
      try { const value = await timed(clearPriceCache()); resetPriceView(); setStats(value); }
      catch (error) { setError(String(error)); } finally { setBusy(false); }
    }}>Árgyorsítótárak törlése</ButtonItem></PanelSectionRow>
  </>;
}

export function AllKeyShopSettings({ openMerchants }: { openMerchants(): void }) {
  const [prefs, setPrefs] = useState<Preferences>();
  const [apiKey, setApiKey] = useState("");
  const [connection, setConnectionState] = useState<Connection>();
  const [serverToken, setServerToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([timed(getPreferences()), timed(getConnection())]).then(([value, transport]) => {
      if (active) {
        if (!value.success || !transport.success) throw new Error(value.error || transport.error || "Betöltési hiba");
        setPrefs(value); setConnectionState(transport);
      }
    }).catch(error => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, []);
  return <>
    <PanelSectionRow><div style={{ marginTop: "12px", fontWeight: 700 }}>Kapcsolat</div></PanelSectionRow>
    {prefs && connection && <>
      <PanelSectionRow><ToggleField label="Lekérés saját szerveren keresztül" checked={connection.mode === "server"} disabled={busy}
        onChange={server => setConnectionState({ ...connection, mode: server ? "server" : "direct" })} /></PanelSectionRow>
      {connection.mode === "server" && <>
        <PanelSectionRow><TextField label="Szerver HTTPS címe" value={connection.url} disabled={busy}
          onChange={event => setConnectionState({ ...connection, url: event.currentTarget.value })} /></PanelSectionRow>
        <PanelSectionRow><TextField label={connection.token_configured ? "Szervertoken (mentve; üresen megtartja)" : "Szervertoken"}
          bIsPassword value={serverToken} disabled={busy} onChange={event => setServerToken(event.currentTarget.value)} /></PanelSectionRow>
        <PanelSectionRow><div style={{ fontSize: "12px" }}>A szervertokent az Ubuntu telepítője adja. A GG.deals-kulcs szerveres módban az Ubuntun szükséges.</div></PanelSectionRow>
      </>}
      <PanelSectionRow><div style={{ marginTop: "12px", fontWeight: 700 }}>Árforrás</div></PanelSectionRow>
      <PanelSectionRow><ToggleField label="Árforrás: GG.deals" description="Kikapcsolva: AllKeyShop. Váltás az Alkalmazás gombbal."
        checked={prefs.provider === "gg"} disabled={busy} onChange={gg => setPrefs({ ...prefs, provider: gg ? "gg" : "aks" })} /></PanelSectionRow>
      <>
        {connection.mode === "direct" && <PanelSectionRow><TextField label={prefs.gg_key_configured ? "GG.deals API-kulcs (mentve; üresen megtartja)" : "GG.deals API-kulcs"}
          bIsPassword value={apiKey} disabled={busy} onChange={event => setApiKey(event.currentTarget.value)} /></PanelSectionRow>}
        <PanelSectionRow><div style={{ fontSize: "12px", lineHeight: 1.5 }}>
          GG.deals: EU/EUR irányár, boltra és terméktípusra nem szűrhető. AKS-hibánál tartalék forrás, ha van API-kulcs.
        </div></PanelSectionRow>
      </>
      <PanelSectionRow><div style={{ marginTop: "12px", fontWeight: 700 }}>Megjelenítés és szűrés</div></PanelSectionRow>
      <PanelSectionRow><ToggleField label="Játékárak megjelenítése" checked={prefs.enabled} disabled={busy}
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
      <PanelSectionRow><ToggleField label="Steam Gift is megengedett (AllKeyShop)" checked={prefs.allow_gifts} disabled={busy || prefs.provider === "gg"}
        onChange={allow_gifts => setPrefs({ ...prefs, allow_gifts })} /></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={prefs.provider === "gg"} onClick={openMerchants}>Megbízható boltok (AKS)</ButtonItem></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={busy} onClick={async () => {
        setBusy(true); setMessage("");
        try {
          const current = await timed(getPreferences());
          if (!current.success) throw new Error(current.error || "Betöltési hiba");
          if (connection.mode === "direct" && prefs.provider === "gg" && !prefs.gg_key_configured && !apiKey.trim())
            throw new Error("Közvetlen GG.deals módhoz add meg az API-kulcsot a Decken is.");
          const transport = await timed(setConnection(connection.mode, connection.url.trim(), serverToken.trim() || null));
          if (!transport.success) throw new Error(transport.error || "Kapcsolati beállítás mentési hiba");
          setConnectionState(transport); setServerToken(""); resetPriceView();
          const provider = await timed(setProvider(prefs.provider, apiKey.trim() || null));
          if (!provider.success) throw new Error(provider.error || "Árforrás mentési hiba");
          setApiKey("");
          const value = await timed(setPreferences(prefs.enabled, prefs.allow_gifts, current.merchants, current.restrict_merchants));
          if (!value.success) throw new Error(value.error || "Mentési hiba");
          setPrefs(value); resetPriceView(); setMessage("Árbeállítások mentve.");
        } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
      }}>{busy ? "Mentés…" : "Árbeállítások alkalmazása"}</ButtonItem></PanelSectionRow>
      {connection.mode === "server" && <PanelSectionRow><ButtonItem layout="below" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const result = await timed(testServer());
          setMessage(result.success ? `Mentett szerverkapcsolat működik. AKS: ${result.aks_entries}, GG.deals: ${result.gg_entries}, sorban: ${result.queue}. GG.deals-kulcs: ${result.gg_available ? "beállítva" : "hiányzik"}.` : result.error || "Kapcsolati hiba.");
        } catch { setMessage("A szerverkapcsolat nem ellenőrizhető."); } finally { setBusy(false); }
      }}>Mentett szerverkapcsolat tesztelése</ButtonItem></PanelSectionRow>}
    </>}
    <PanelSectionRow><div style={{ fontSize: "12px", opacity: .8 }}>{message || "EUR · Steam-kulcs és engedélyezett Gift; account kizárva. AKS: utoljára jelentett ár. Gyorsítótár: 24 óra."}</div></PanelSectionRow>
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
      Csak a bepipált boltok Steam-kulcs és Gift ajánlatai jelennek meg. A szűrés a Decken történik; üres lista esetén nincs ajánlat. Az új boltokat külön engedélyezheted.
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
export function readSteamEuroPrice(text: string): number | null {
  // Scoped price widget only. The final amount follows the struck-through one.
  const matches = Array.from(text.matchAll(/(\d[\d.,\s\u00a0]*\d|\d)\s*(?:€|EUR(?![A-Z]))/g));
  const amount = matches[matches.length - 1]?.[1].replace(/[\s\u00a0]/g, "");
  if (!amount) return null;
  const separator = Math.max(amount.lastIndexOf(","), amount.lastIndexOf("."));
  if (separator < 0 || amount.length - separator !== 3) return null;
  const value = Number(amount.slice(0, separator).replace(/[.,]/g, "") + "." + amount.slice(separator + 1));
  return Number.isFinite(value) && value > 0 ? value : null;
}

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
    const steamPriceNode = gamepadPrice || purchase?.querySelector('.discount_final_price, .game_purchase_price');
    const steamPrice = (${readSteamEuroPrice.toString()})(steamPriceNode?.textContent || '');
    const key = appId + ':' + Boolean(gamepadAnchor) + ':' + steamPrice + ':' + JSON.stringify(data);
    if (panel?.dataset.state === key && panel.previousElementSibling === anchor) return;
    const wasOpen = panel?.open === true;
    panel?.remove(); panel = document.createElement('details'); panel.id = id; panel.dataset.state = key; panel.open = wasOpen;
    panel.style.cssText = 'display:flow-root;clear:none;position:relative;box-sizing:border-box;width:100%;margin:24px 0 16px;pointer-events:auto;color:#dce6ed;font:14px/1.5 Arial,sans-serif';
    if (gamepadAnchor) panel.style.cssText = 'display:block;flex:0 0 auto;box-sizing:border-box;max-width:100%;max-height:170px;overflow:auto;margin:6px 0 0;pointer-events:auto;color:#dce6ed;font:12px/1.4 Arial,sans-serif';
    panel.addEventListener('click', event => event.stopPropagation());
    const summary = document.createElement('summary');
    const best = data?.offers?.[0];
    const gg = data?.provider === 'gg';
    const steamCheaper = !gg && data?.success && best && steamPrice !== null && steamPrice <= best.price;
    summary.textContent = !data ? 'Ár betöltése…' : !data.success ? 'AKS: ' + ({pending:'szerveres lekérés folyamatban',server:'szerverkapcsolati hiba',server_version:'árszerver-frissítés szükséges',backend:'Decky-kapcsolati hiba',connection:'kapcsolati hiba',rate_limit:'várakozás',http:'szerverhiba',steam:'Steam-adathiba',match:'nem azonosítható',format:'adatformátum-hiba'}[data.error_code] || 'hiba') : data.not_found ? (data.match_status === 'ambiguous' ? 'AKS: több azonos nevű találat' : 'AKS: ezen a néven nincs a katalógusban') : best ? 'AKS: ' + best.price.toFixed(2) + ' € ∙ ' + best.merchant : data.history_unavailable ? 'AKS: áradat még nincs' : 'AKS: nincs ajánlat';
    if (data?.retry_at && !data.success) { summary.dataset.dpbRetryAt = String(data.retry_at); summary.dataset.dpbLabel = summary.textContent; }
    const ggRetailCheaper = data?.retail_price != null && (data?.keyshop_price == null || data.retail_price <= data.keyshop_price);
    if (gg) summary.textContent = !data.success ? 'GG.deals: ' + (data.pending ? 'szerveres lekérés folyamatban' : data.error_code === 'rate_limit' ? 'várakozás' : 'hiba')
      : 'GG.deals: ' + (ggRetailCheaper ? 'Hivatalos boltok: ' + data.retail_price.toFixed(2) + ' €'
      : data.keyshop_price != null ? 'Kulcsboltok: ' + data.keyshop_price.toFixed(2) + ' €' : 'nincs ár');
    if (data?.retry_at && !data.success) summary.dataset.dpbLabel = summary.textContent;
    summary.title = (gg ? 'GG.deals' : 'AllKeyShop') + ' ár és ajánlatok – megnyitás';
    summary.style.cssText = 'cursor:pointer;white-space:normal;overflow-wrap:anywhere;box-sizing:border-box;list-style:none;border:1px solid #67c1f5;border-radius:5px;background:#162634;padding:2px 8px;font-weight:700;min-height:24px';
    panel.appendChild(summary);
    const content = document.createElement('div');
    content.style.cssText = 'box-sizing:border-box;width:100%;overflow-wrap:anywhere;background:#162634;border:1px solid #4a6478;border-radius:6px;padding:14px;margin-top:4px';
    panel.appendChild(content);
    const line = (text, bold = false) => { const node = document.createElement('div'); node.textContent = text; if (bold) node.style.fontWeight = '700'; content.appendChild(node); };
    line(gg ? 'GG.deals · EU/EUR' : 'AKS · Steam-kulcs / Gift', true);
    if (!data) line('Árak betöltése…');
    else if (!data.success) { line(data.error || 'Az ár most nem érhető el.'); if (data.global_error) line('A többi lekérés is szünetel; az újrapróbálás ideje az ársorban látható.'); }
    else if (gg) {
      if (data.fallback_from === 'aks') line('Tartalék forrás: AKS-hiba.');
      line('Kulcsboltok: ' + (data.keyshop_price != null ? data.keyshop_price.toFixed(2) + ' €' : 'nincs ár'));
      line('Hivatalos boltok: ' + (data.retail_price != null ? data.retail_price.toFixed(2) + ' €' : 'nincs ár'));
      line('Irányár; bolt és terméktípus szerint nem szűrhető.');
      if (data.stale) line('Mentett ár; frissítésre vár.');
      if (data.checked_at) line('Ellenőrizve: ' + new Date(data.checked_at * 1000).toLocaleString('hu-HU'));
      if (/^https:\\/\\/gg\\.deals\\/(?:game\\/[a-z0-9-]+\\/)?$/.test(data.url || '')) {
        const link = document.createElement('a'); link.href = data.url; link.textContent = 'GG.deals megnyitása';
        link.style.cssText = 'display:block;color:#67c1f5;padding:8px 0'; content.appendChild(link);
      }
    }
    else {
      if (steamPrice !== null) line('Steam: ' + steamPrice.toFixed(2) + ' €' + (steamCheaper ? ' · itt olcsóbb' : ''));
      if (data.not_found) line(data.match_status === 'ambiguous' ? 'Több azonos nevű játék; bizonytalan árat nem mutatunk.' : 'A játék nincs ezen a néven az AKS-katalógusban.');
      else if (data.history_unavailable) line('Az AKS API még nem ad árhistóriát ehhez a játékhoz; később újraellenőrizzük.');
      else if (!data.offers?.length) line('Nincs megfelelő ajánlat az aktuális szűrőkkel.');
      else for (const [index, offer] of data.offers.entries()) {
        line(offer.price.toFixed(2) + ' € · ' + offer.merchant + ' · ' + offer.kind
          + (offer.coupon ? ' · Kupon: ' + offer.coupon : ''), index === 0);
      }
      if (!data.not_found && !data.offers?.length && data.filtering) {
        const f = data.filtering;
        const labels = {edition:'más kiadás',region:'régió/platform',gift:'Gift tiltva',merchant:'bolt tiltva',price:'hibás ár',invalid:'hiányos',steam:'Steam kizárva'};
        const excluded = Object.entries(labels).filter(([key]) => f[key]).map(([key, label]) => label + ': ' + f[key]);
        if (excluded.length) line('Kihagyva: ' + excluded.join(' · '));
      }
      if (data.offers?.[0]?.source_updated_at) line('AKS-adat: ' + data.offers[0].source_updated_at);
      if (data.stale) line('Mentett ár; frissítésre vár.');
      if (data.checked_at) line('Ellenőrizve: ' + new Date(data.checked_at * 1000).toLocaleString('hu-HU'));
      if (/^https:\\/\\/www\\.allkeyshop\\.com\\/blog\\/(?:buy-|compare-and-buy-cd-key-for-digital-download-)[a-z0-9-]+\\/$/.test(data.url || '') || (data.source === 'aks_history' && data.url === 'https://www.allkeyshop.com/')) {
        const link = document.createElement('a'); link.href = data.url; link.textContent = 'AllKeyShop megnyitása';
        link.style.cssText = 'display:block;color:#67c1f5;padding:8px 0'; content.appendChild(link);
      }
    }
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { panel.open = false; summary.focus(); } });
    anchor.insertAdjacentElement('afterend', panel);
    ${priceCountdownScript}
  })();`;
}

// Store cards reserve a short strip below themselves for the price label.
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
    function findSingleAppCard(host, id) {
      const calendar = host.closest('.personal_calendar_ctn');
      let calendarCard = null;
      for (let card = host; card && card !== document.body && card !== calendar; card = card.parentElement) {
        const otherApp = Array.from(card.querySelectorAll('[data-ds-appid],[data-app-id],a[href*="/app/"]'))
          .some(node => {
            const raw = node.getAttribute('data-ds-appid') || node.getAttribute('data-app-id') || '';
            const match = (node.getAttribute('href') || '').match(/\\/app\\/(\\d+)/);
            return (raw && raw !== id) || (match && match[1] !== id);
          });
        if (otherApp) break;
        if (!card.querySelector('img,picture,video,[style*="background-image"]')) continue;
        const rect = card.getBoundingClientRect();
        if (rect.width < 80 || rect.width > Math.max(1200, innerWidth) || rect.height < 40) continue;
        if (card.querySelector('.discount_block[data-price-final],.discount_final_price,.game_purchase_price,.price,[class*="SalePrice"],[class*="sale_price"]')) return card;
        if (calendar) calendarCard = card;
      }
      return calendarCard && calendarCard !== host ? calendarCard : null;
    }
    for (const {host, id} of collectPriceTiles()) {
      if (!(id in values) || values[id]?.disabled || values[id]?.skipped) continue;
      // Prefer Steam's complete card. Dynamic calendar/featured cards may lack
      // these classes, so accept a one-game wrapper with cover and Steam price.
      const anchor = host.closest('.wishlist_row,.search_result_row,.sale_capsule,.store_capsule,.tab_item,.tab_row_item,.dailydeal,.small_cap,.large_cap,.home_area_spotlight')
        || findSingleAppCard(host, id);
      if (!anchor || anchor.getBoundingClientRect().width < 80) continue;
      if (saved.has(anchor)) continue;
      saved.set(anchor, ['position', 'overflow', 'margin-bottom']
        .map(key => [key, anchor.style.getPropertyValue(key), anchor.style.getPropertyPriority(key)]));
      if (getComputedStyle(anchor).position === 'static') anchor.style.setProperty('position', 'relative');
      if (getComputedStyle(anchor).overflow === 'hidden') anchor.style.setProperty('overflow', 'visible');
      if ((parseFloat(getComputedStyle(anchor).marginBottom) || 0) < 32) anchor.style.setProperty('margin-bottom', '32px');
      const value = values[id], offer = value?.offers?.[0];
      const row = document.createElement('span'); row.className = 'dpb-tile-price';
      row.style.cssText = 'position:absolute;top:calc(100% + 3px);left:0;width:100%;height:26px;box-sizing:border-box;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#162634;color:#dce6ed;padding:3px 6px;font:12px/20px Arial,sans-serif;pointer-events:none;z-index:2';
      row.textContent = !value ? 'AKS: betöltés…' : !value.success ? 'AKS: ' + ({pending:'szerveres lekérés folyamatban',server:'szerverkapcsolati hiba',server_version:'árszerver-frissítés szükséges',backend:'Decky-kapcsolati hiba',connection:'kapcsolati hiba',rate_limit:'várakozás',http:'szerverhiba',steam:'Steam-adathiba',match:'nem azonosítható',format:'adatformátum-hiba'}[value.error_code] || 'nem elérhető') : value.not_found ? (value.match_status === 'ambiguous' ? 'AKS: több azonos nevű találat' : 'AKS: nincs a katalógusban') : offer ? 'AKS: ' + offer.price.toFixed(2) + ' € ∙ ' + offer.merchant : value.history_unavailable ? 'AKS: áradat még nincs' : 'AKS: nincs ajánlat';
      if (value?.retry_at && !value.success) { row.dataset.dpbRetryAt = String(value.retry_at); row.dataset.dpbLabel = row.textContent; }
      if (value?.provider === 'gg') {
        const amount = value.keyshop_price ?? value.retail_price;
        row.textContent = !value.success ? 'GG.deals: várakozás / hiba' : amount != null ? 'GG.deals: tájékoztató ár: ' + amount.toFixed(2) + ' €' : 'GG.deals: nincs ár';
        if (row.dataset.dpbRetryAt) row.dataset.dpbLabel = row.textContent;
      }
      row.title = row.textContent;
      anchor.appendChild(row);
    }
    ${priceCountdownScript}
  })();`;
}

const prices = new Map<string, { value: PriceResult; expires: number }>();
let fetching = false;
let hydrating = false;
let serviceFailure: { value: PriceResult; expires: number } | undefined;
let revision = 0;
let currentApp = "";
let tileUrl = "";
let tileIds: string[] = [];
let visibleApps = new Set<string>();
const refreshQueue = new Set<string>();
const cacheChecked = new Set<string>();
const priceListeners = new Set<() => void>();
export function subscribePriceResults(listener: () => void): () => void {
  priceListeners.add(listener);
  return () => priceListeners.delete(listener);
}
const notifyPriceResults = () => { for (const listener of priceListeners) listener(); };
const priceTtlMs = (value: PriceResult) => value.history_unavailable ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
export function visiblePrice(id: string): PriceResult | undefined {
  const cached = prices.get(id);
  if (cached) return cached.value;
  return serviceFailure && serviceFailure.expires > Date.now() ? serviceFailure.value : undefined;
}
export function resetPriceView(): void { prices.clear(); serviceFailure = undefined; revision++; fetching = false; hydrating = false; currentApp = ""; tileIds = []; tileUrl = ""; visibleApps.clear(); refreshQueue.clear(); cacheChecked.clear(); }
export function updatePriceView(url: string, send: (script: string) => Promise<unknown>, visibleTileIds: string[] = []): void {
  let id = "";
  try { const parsed = new URL(url); if (parsed.hostname === "store.steampowered.com") id = parsed.pathname.match(/^\/app\/(\d+)/)?.[1] ?? ""; } catch { /* no game */ }
  const previousApp = currentApp;
  currentApp = id;
  tileUrl = url;
  tileIds = allowsStoreTilePrices(url) ? Array.from(new Set(visibleTileIds.filter(value => /^\d+$/.test(value) && Number(value) > 0))).slice(0, 80) : [];
  const nextVisible = new Set([...tileIds, ...(id ? [id] : [])]);
  for (const app of nextVisible) {
    const entry = prices.get(app);
    // Queue every visible card once. Requests remain single-flight; limiting the
    // queue to four starved the remaining cards until they left the viewport.
    if ((!visibleApps.has(app) || (app === id && id !== previousApp)) && (!entry || entry.expires <= Date.now()))
      refreshQueue.add(app);
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
  const batch = [...new Set([...(id ? [id] : []), ...tileIds])].filter(app => !cacheChecked.has(app)).slice(0, 24);
  if (batch.length && !hydrating) {
    for (const app of batch) cacheChecked.add(app);
    hydrating = true;
    const batchRevision = revision, batchUrl = tileUrl;
    const applyBatch = (values: Record<string, PriceResult>) => {
      if (batchRevision !== revision) return;
      for (const app of batch) {
        const value = values?.[app];
        if (!value?.success || !value.checked_at) continue;
        if (!prices.has(app) && prices.size >= 500) prices.delete(prices.keys().next().value!);
        prices.set(app, { value, expires: value.checked_at * 1000 + priceTtlMs(value) });
        if (!value.stale && prices.get(app)!.expires > Date.now()) refreshQueue.delete(app);
      }
      if (batchUrl === tileUrl) {
        renderTiles();
        if (currentApp) void send(buildPricePanelScript(currentApp, visiblePrice(currentApp))).catch(() => {});
        notifyPriceResults();
      }
    };
    void (async () => {
      const local = await timed(getCachedPrices(batch));
      applyBatch(local.prices);
      if (batchRevision !== revision) return;
      const absent = batch.filter(app => !prices.has(app) || prices.get(app)!.value.stale);
      if (absent.length) {
        const remote = await timed(getRemotePricePreviews(absent));
        applyBatch(remote.prices);
      }
    })().catch(() => {}).finally(() => {
      if (batchRevision !== revision) return;
      hydrating = false;
      if (batchUrl === tileUrl) updatePriceView(tileUrl, send, tileIds);
    });
    return;
  }
  if (hydrating) return;
  // Expiry alone never refreshes a successful visible price. Failed requests retain
  // the existing retry countdown; stale successful prices wait for a new appearance.
  const needsRequest = (app: string) => refreshQueue.has(app) ||
    (prices.has(app) && (!prices.get(app)!.value.success || prices.get(app)!.value.pending) && prices.get(app)!.expires <= Date.now());
  const pending = [...refreshQueue];
  const requestId = id && needsRequest(id) ? id : pending.find(app => !prices.has(app)) ??
    pending[0] ?? tileIds.find(needsRequest);
  if (!requestId || fetching) return;
  fetching = true;
  const requestRevision = revision;
  void (async () => {
    if (!visibleApps.has(requestId)) return { success: true, missing: true } as PriceResult;
    if (serviceFailure && serviceFailure.expires > Date.now())
      return { ...serviceFailure.value, retry_after: (serviceFailure.expires - Date.now()) / 1000 };
    return await timed(getPrice(requestId));
  })().catch(error => ({ success: false, error: String(error), error_code: "backend", global_error: true, retry_after: 15 } as PriceResult)).then(value => {
    if (requestRevision !== revision || value.missing) return;
    if (value.global_error) {
      const expires = Date.now() + Math.max(1, (value.retry_after ?? 15)) * 1000;
      serviceFailure = { value: { ...value, retry_at: expires }, expires };
      if (currentApp) void send(buildPricePanelScript(currentApp, visiblePrice(currentApp) ?? value)).catch(() => {});
      if (tileIds.length) renderTiles();
      notifyPriceResults();
      return;
    }
    serviceFailure = undefined;
    refreshQueue.delete(requestId);
    if (!value.success && prices.get(requestId)?.value.success) {
      value = { ...prices.get(requestId)!.value, stale: true, error: value.error, pending: value.pending, retry_after: value.retry_after };
    }
    if (prices.size >= 500) prices.delete(prices.keys().next().value!);
    const age = value.checked_at ? Math.max(0, Date.now() - value.checked_at * 1000) : 0;
    const expires = Date.now() + (value.pending ? Math.max(1, value.retry_after ?? 3) * 1000 : value.success && !value.disabled ? Math.max(0, priceTtlMs(value) - age) : Math.max(1, (value.retry_after ?? 30)) * 1000);
    if (!value.success) value = { ...value, retry_at: expires };
    prices.set(requestId, { value, expires });
    if (currentApp === requestId) void send(buildPricePanelScript(requestId, value)).catch(() => {});
    if (tileIds.length) renderTiles();
    notifyPriceResults();
  }).finally(() => { if (requestRevision === revision) fetching = false; });
}

export const nativePriceUrl = 'https://store.steampowered.com/?dpb_native=1';
export function clearNativePriceView(): void {
  if (tileUrl === nativePriceUrl) updatePriceView('', async () => {});
}
