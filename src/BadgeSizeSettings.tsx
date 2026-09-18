import { useEffect, useState } from "react";
import { ButtonItem, PanelSectionRow, SliderField } from "@decky/ui";

export type BadgeSizes = { library_badge_percent: number; store_badge_percent: number };
export function BadgeSizeSettings({ initial, save }: { initial: BadgeSizes; save(value: BadgeSizes): Promise<void> }) {
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dirty = draft.library_badge_percent !== saved.library_badge_percent || draft.store_badge_percent !== saved.store_badge_percent;
  useEffect(() => {
    if (!dirty && !working) { setDraft(initial); setSaved(initial); }
  }, [initial.library_badge_percent, initial.store_badge_percent]);
  return <>
    <PanelSectionRow><SliderField label="Könyvtár ikonmérete" value={draft.library_badge_percent}
      min={50} max={200} step={5} resetValue={100} showValue valueSuffix="%" disabled={working}
      onChange={value => setDraft({ ...draft, library_badge_percent: Math.round(value) })} /></PanelSectionRow>
    <PanelSectionRow><SliderField label="Áruház ikonmérete" value={draft.store_badge_percent}
      min={50} max={200} step={5} resetValue={100} showValue valueSuffix="%" disabled={working}
      onChange={value => setDraft({ ...draft, store_badge_percent: Math.round(value) })} /></PanelSectionRow>
    <PanelSectionRow><ButtonItem layout="below" disabled={working || !dirty} onClick={async () => {
      setWorking(true); setError("");
      try { await save(draft); setSaved(draft); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setWorking(false); }
    }}>{working ? "Méret mentése…" : "Ikonméretek alkalmazása"}</ButtonItem></PanelSectionRow>
    <PanelSectionRow><div style={{ fontSize: "12px", opacity: .8 }}>{error || "100% = eredeti méret. A két felület külön állítható; a nagyobb jelvények szükség esetén több sorba kerülnek."}</div></PanelSectionRow>
  </>;
}
