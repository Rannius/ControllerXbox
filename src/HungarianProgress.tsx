import { useEffect, useState } from "react";
import { HungarianCollection } from "./hungarianCollection";

export type CuratorProgress = { success: boolean; status: "loading" | "cached" | "unavailable";
  checked: number; total: number; entries: number; stale: boolean };

export function HungarianProgress({ manager, loadCurator }: {
  manager: HungarianCollection; loadCurator(): Promise<CuratorProgress>;
}) {
  const [scan, setScan] = useState({ ...manager.progress, status: manager.status });
  const [curator, setCurator] = useState<CuratorProgress>();
  const [curatorError, setCuratorError] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => manager.subscribe(status => setScan({ ...manager.progress, status })), [manager]);
  useEffect(() => {
    if (scan.phase === "paused") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await loadCurator();
        if (active) { setCurator(result); setCuratorError(!result.success); }
      } catch { if (active) setCuratorError(true); }
      if (active) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [loadCurator, scan.phase === "paused"]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const percent = scan.total ? Math.floor(scan.processed / scan.total * 100) : 0;
  const seconds = Math.max(0, Math.ceil((scan.nextCheckAt - now) / 1000));
  const titles = { waiting: "Várakozás a könyvtárra", cache: "Mentett adatok betöltése", checking: "Játékok ellenőrzése",
    saving: "Gyűjtemény mentése", between: "Keresés folyamatban", done: "Ellenőrzési kör kész", error: "Újrapróbálkozásra vár", paused: "Gyűjtés szünetel" };
  return <div style={{ padding: "12px", borderRadius: "8px", background: "rgba(0,0,0,.22)", fontSize: "12px", lineHeight: 1.5, overflowWrap: "anywhere" }}>
    <div style={{ fontWeight: 700, fontSize: "14px" }}>🇭🇺 Magyar játékok</div>
    <div role="status">{titles[scan.phase]}</div>
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px" }}>
      <span>{scan.processed} / {scan.total} sorra véve</span><strong>{percent}%</strong>
    </div>
    <div role="progressbar" aria-label="Könyvtár ellenőrzése" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      style={{ height: "6px", background: "#394553", borderRadius: "4px", overflow: "hidden", margin: "5px 0 8px" }}>
      <div style={{ width: `${percent}%`, height: "100%", background: "#67c1f5", transition: "width .3s" }} />
    </div>
    <div>{scan.checked} játékhoz van nyelvi adat</div>
    <div>{scan.found} magyar találat · {scan.collected} a gyűjteményben</div>
    {scan.unknown > 0 && <div>{scan.unknown} játéknál hiányzó vagy bizonytalan nyelvi adat</div>}
    {scan.current && <div style={{ marginTop: "8px" }}>Most: {scan.current}</div>}
    <div style={{ opacity: .8, marginTop: "8px" }}>{scan.status}</div>
    {scan.phase !== "paused" && <div style={{ marginTop: "8px" }}>
      Magyar Felirat: {curatorError ? "állapot nem érhető el; újrapróbáljuk"
        : !curator ? "állapot betöltése…"
        : curator.status === "loading" ? (curator.total ? `${curator.checked} / ${curator.total} ajánlás betöltve` : "lista letöltése…")
        : curator.status === "cached" ? `${curator.entries} játék a listán${curator.stale ? " · korábbi lista, a frissítés később újraindul" : ""}`
        : "nem érhető el; később újrapróbáljuk"}
    </div>}
    {scan.nextCheckAt > 0 && scan.phase !== "paused" && <div style={{ opacity: .65, marginTop: "6px" }}>
      {seconds ? `Következő ellenőrzés: ${seconds} mp` : "Folytatásra vár…"} · a háttérben is halad
    </div>}
  </div>;
}
