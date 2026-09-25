import { useEffect, useRef } from "react";
import { clearNativePriceView, isPriceHydrating, nativePriceUrl, PriceResult, subscribePriceResults, updatePriceView, visiblePrice } from "./AllKeyShop";

// One shared queue/timer for native Store cards, never one network loop per card.
const cards = new Map<HTMLSpanElement, { id: string; intersects: boolean }>();
let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;

export function stopNativePriceTiles(): void {
  clearInterval(timer); timer = undefined;
  unsubscribe?.(); unsubscribe = undefined;
  for (const node of cards.keys()) { node.textContent = ""; node.style.visibility = "hidden"; }
  cards.clear(); clearNativePriceView();
}

export function tilePriceLabel(value?: PriceResult): string {
  if (value?.disabled || value?.skipped) return "";
  const source = value?.provider === "gg" ? "GG.deals" : "AKS";
  if (!value) return source + ": betöltés…";
  if (!value.success) {
    const seconds = value.retry_at ? Math.max(0, Math.ceil((value.retry_at - Date.now()) / 1000)) : 0;
    return source + (value.pending ? ": sorban" : ": várakozás / hiba") + (seconds ? " · " + seconds + " mp" : "");
  }
  if (value.provider === "gg") {
    const price = value.keyshop_price ?? value.retail_price;
    return price == null ? source + ": nincs ár" : source + ": tájékoztató ár: " + price.toFixed(2) + " €";
  }
  const best = value.offers?.[0];
  return best ? "AKS: " + best.price.toFixed(2) + " € ∙ " + best.merchant
    : value.not_found ? "AKS: nincs a katalógusban"
    : value.history_unavailable ? "AKS: áradat még nincs" : "AKS: nincs ajánlat";
}

function visibleCards() {
  return Array.from(cards).filter(([node, card]) => {
    const rect = node.getBoundingClientRect();
    return node.isConnected && card.intersects && rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.top < node.ownerDocument.defaultView!.innerHeight
      && rect.right > 0 && rect.left < node.ownerDocument.defaultView!.innerWidth;
  });
}

function renderNativePrices(): void {
  const visible = visibleCards();
  for (const [node, card] of visible) {
    const value = visiblePrice(card.id);
    const text = isPriceHydrating(card.id) ? "" : tilePriceLabel(value);
    node.textContent = text;
    node.style.visibility = text ? "visible" : "hidden";
    node.title = text + (value?.offers?.[0]?.source_updated_at ? " · AKS-adat: " + value.offers[0].source_updated_at : "");
  }
}

function tick(): void {
  const visible = visibleCards();
  updatePriceView(nativePriceUrl, async () => {}, visible.map(([, card]) => card.id));
  renderNativePrices();
}

export function NativeTilePrice({ appId, enabled }: { appId: string; enabled: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const Observer = node.ownerDocument.defaultView?.IntersectionObserver;
    const card = { id: appId, intersects: !Observer };
    cards.set(node, card);
    const observer = Observer ? new Observer(entries => { card.intersects = entries.some(entry => entry.isIntersecting); tick(); }) : undefined;
    observer?.observe(node);
    if (!timer) { unsubscribe = subscribePriceResults(renderNativePrices); tick(); timer = setInterval(tick, 1500); }
    return () => {
      observer?.disconnect(); cards.delete(node);
      if (!cards.size) stopNativePriceTiles();
    };
  }, [appId, enabled]);
  if (!enabled) return null;
  const label = isPriceHydrating(appId) ? "" : tilePriceLabel(visiblePrice(appId));
  return <span ref={ref} style={{ position: "absolute", bottom: 0, left: 0, right: 0,
    height: "25px", zIndex: 101, boxSizing: "border-box", padding: "3px 6px",
    background: "#162634", color: "#dce6ed", font: "11px/19px Arial,sans-serif",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", pointerEvents: "none",
    visibility: label ? "visible" : "hidden" }}>{label}</span>;
}
