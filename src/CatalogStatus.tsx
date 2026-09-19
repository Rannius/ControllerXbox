import { useEffect, useState } from "react";
import { callable } from "@decky/api";

type Provider = { checked_at: number; stale: boolean; error: string; entries: number; pending_removals: number };
type Status = { success: boolean; gfn: Provider; boosteroid: Provider };
const load = callable<[], Status>("get_catalog_status");

export function CatalogStatus() {
  const [status, setStatus] = useState<Status>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await Promise.race([load(), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("timeout")), 15000);
        })]);
        if (active) { setStatus(result); setFailed(!result.success); }
      } catch { if (active) setFailed(true); }
      finally { clearTimeout(timeout); }
      if (active) timer = setTimeout(() => void poll(), 10000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); clearTimeout(timeout); };
  }, []);
  return <div style={{ fontSize: "12px", lineHeight: 1.5, overflowWrap: "anywhere" }}>
    {failed && <div>A katalógusok állapota most nem kérdezhető le.</div>}
    {!status && !failed && <div>Katalógusok állapotának betöltése…</div>}
    {status && ([['gfn', 'GFN'], ['boosteroid', 'Boosteroid']] as const).map(([key, name]) => {
      const provider = status[key];
      return <div key={key} style={{ marginBottom: "6px" }}>
        <strong>{name}: {provider.stale ? "korábbi / még nem ellenőrzött adatok" : "naprakész"}</strong>
        <div>Utolsó sikeres frissítés: {provider.checked_at ? new Date(provider.checked_at * 1000).toLocaleString("hu-HU") : "még nem történt"}</div>
        <div>{provider.entries} játék{provider.pending_removals > 0 ? ` · ${provider.pending_removals} eltűnés megerősítésre vár` : ""}</div>
        {provider.error && <div>Frissítési hiba; az utolsó jó katalógus marad érvényben.</div>}
      </div>;
    })}
  </div>;
}
