import { useEffect, useState } from "react";
import { ButtonItem, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { callable } from "@decky/api";

type Preferences = { success: boolean; enabled: boolean; allow_gifts: boolean; merchants: string[]; error?: string };
export type PriceResult = { success: boolean; disabled?: boolean; error?: string; title?: string; url?: string;
  checked_at?: number; currency?: string; preferred_only?: boolean; matched_offers?: number;
  offers?: { merchant: string; price: number; kind: string; edition: string; coupon: string }[] };
const getPreferences = callable<[], Preferences>("get_price_preferences");
const setPreferences = callable<[boolean, boolean, string[]], Preferences>("set_price_preferences");
const getPrice = callable<[string], PriceResult>("get_allkeyshop_price");

async function timed<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([request, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Az árlekérdezés nem válaszolt időben.")), 60000);
  })]); } finally { clearTimeout(timer!); }
}

export function AllKeyShopSettings() {
  const [prefs, setPrefs] = useState<Preferences>();
  const [shops, setShops] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void timed(getPreferences()).then(value => {
      if (active) { if (!value.success) throw new Error(value.error || "Betöltési hiba"); setPrefs(value); setShops(value.merchants.join(", ")); }
    }).catch(error => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, []);
  return <>
    <PanelSectionRow><div style={{ marginTop: "12px", fontWeight: 700 }}>AllKeyShop árak</div></PanelSectionRow>
    {prefs && <>
      <PanelSectionRow><ToggleField label="Árak az áruházi játékoldalon" checked={prefs.enabled} disabled={busy}
        onChange={enabled => setPrefs({ ...prefs, enabled })} /></PanelSectionRow>
      <PanelSectionRow><ToggleField label="Steam Gift is megengedett" checked={prefs.allow_gifts} disabled={busy}
        onChange={allow_gifts => setPrefs({ ...prefs, allow_gifts })} /></PanelSectionRow>
      <PanelSectionRow><TextField label="Előnyben részesített boltok" description="Pontos boltnevek vesszővel elválasztva, pl. Eneba, GAMIVO. Üresen minden megfelelő bolt."
        value={shops} disabled={busy} onChange={event => setShops(event.currentTarget.value)} /></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={busy} onClick={async () => {
        setBusy(true); setMessage("");
        try {
          const value = await timed(setPreferences(prefs.enabled, prefs.allow_gifts, shops.split(",").map(s => s.trim()).filter(Boolean)));
          if (!value.success) throw new Error(value.error || "Mentési hiba");
          setPrefs(value); resetPriceView(); setMessage("Árbeállítások mentve.");
        } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
      }}>{busy ? "Mentés…" : "Árbeállítások alkalmazása"}</ButtonItem></PanelSectionRow>
    </>}
    <PanelSectionRow><div style={{ fontSize: "12px", opacity: .8 }}>{message || "EUR · Standard kiadás · Global/EU Steam-kulcsok és opcionálisan Gift. Account és ismeretlen típus kizárva. Csak a megnyitott játékhoz kér le árat; 15 percig tárolja."}</div></PanelSectionRow>
  </>;
}

// Keep this renderer independent of Steam selectors except for its insertion
// point. All third-party text is assigned through textContent, never HTML.
export function buildPricePanelScript(appId: string, result?: PriceResult): string {
  return `(() => {
    const appId = ${JSON.stringify(appId)};
    const data = ${JSON.stringify(result ?? null).replace(/</g, "\\u003c")};
    const id = 'deck-play-badges-price';
    const pageId = location.pathname.match(/^\\/app\\/(\\d+)/)?.[1];
    let panel = document.getElementById(id);
    if (!appId || pageId !== appId || data?.disabled) { panel?.remove(); return; }
    const host = document.querySelector('.game_area_purchase');
    if (!host) { panel?.remove(); return; }
    const key = appId + ':' + JSON.stringify(data);
    if (panel?.dataset.state === key && panel.parentElement === host) return;
    panel?.remove(); panel = document.createElement('section'); panel.id = id; panel.dataset.state = key;
    panel.style.cssText = 'box-sizing:border-box;background:#162634;border:1px solid #4a6478;border-radius:6px;padding:14px;margin:12px 0;color:#dce6ed;font:14px/1.5 Arial,sans-serif;overflow-wrap:anywhere;max-width:100%';
    const line = (text, bold = false) => { const node = document.createElement('div'); node.textContent = text; if (bold) node.style.fontWeight = '700'; panel.appendChild(node); };
    line('AllKeyShop · Steam-kulcs / Gift', true);
    if (!data) line('Árak betöltése…');
    else if (!data.success) line(data.error || 'Az ár most nem érhető el.');
    else {
      line(data.preferred_only ? 'Legalacsonyabb ár a kiválasztott boltokból' : 'Legalacsonyabb megfelelő ajánlat');
      if (!data.offers?.length) line('Nincs megfelelő Steam-kulcs vagy Gift az aktuális szűrőkkel.');
      for (const [index, offer] of (data.offers || []).entries()) {
        line(offer.price.toFixed(2) + ' € · ' + offer.merchant, index === 0);
        line(offer.kind + ' · ' + offer.edition + (offer.coupon ? ' · Kupon: ' + offer.coupon : ''));
      }
      line('AKS szerinti, kártyadíjat tartalmazó ár; kupon esetén annak feltételeivel.');
      line('Global/EU besorolás. A végösszeget és a magyarországi aktiválhatóságot az eladónál ellenőrizd.');
      if (data.checked_at) line('Ellenőrizve: ' + new Date(data.checked_at * 1000).toLocaleString('hu-HU'));
      if (/^https:\\/\\/www\\.allkeyshop\\.com\\/blog\\/(?:buy-|compare-and-buy-cd-key-for-digital-download-)[a-z0-9-]+\\/$/.test(data.url || '')) {
        const link = document.createElement('a'); link.href = data.url; link.textContent = 'AllKeyShop adatlap megnyitása (az ottani lista külön szűrhető)';
        link.style.cssText = 'display:block;color:#67c1f5;padding:8px 0'; panel.appendChild(link);
      }
    }
    host.prepend(panel);
  })();`;
}

const prices = new Map<string, { value: PriceResult; expires: number }>();
let fetching = false;
let revision = 0;
let currentApp = "";
export function resetPriceView(): void { prices.clear(); revision++; currentApp = ""; }
export function updatePriceView(url: string, send: (script: string) => Promise<unknown>): void {
  let id = "";
  try { const parsed = new URL(url); if (parsed.hostname === "store.steampowered.com") id = parsed.pathname.match(/^\/app\/(\d+)/)?.[1] ?? ""; } catch { /* no game */ }
  currentApp = id;
  const cached = prices.get(id);
  void send(buildPricePanelScript(id, cached?.value)).catch(() => {});
  if (!id || fetching || (cached && cached.expires > Date.now())) return;
  fetching = true;
  const requestRevision = revision;
  void timed(getPrice(id)).catch(error => ({ success: false, error: String(error) } as PriceResult)).then(value => {
    if (requestRevision !== revision) return;
    if (prices.size >= 100) prices.delete(prices.keys().next().value!);
    prices.set(id, { value, expires: Date.now() + (value.success && !value.disabled ? 900000 : 60000) });
    if (currentApp === id) void send(buildPricePanelScript(id, value)).catch(() => {});
  }).finally(() => { fetching = false; });
}
