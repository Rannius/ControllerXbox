// SteamUIStore is the live running-app source in Game Mode. Its list can be
// empty temporarily while the UI rehydrates after RestartJSContext.
export type RunningGameStore = {
  MainRunningAppID?: unknown;
  MainRunningApp?: { appid?: unknown };
  RunningApps?: { appid?: unknown }[];
  SetRunningApp?(appId: number): void;
  NavigateToRunningApp?(): void;
};

function appId(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 0xffffffff ? id : undefined;
}

export function currentRunningGame(store: RunningGameStore | undefined): number | undefined {
  try {
    const main = appId(store?.MainRunningAppID) ?? appId(store?.MainRunningApp?.appid);
    if (main) return main;
    const running = store?.RunningApps;
    // Without Steam's primary selection, multiple games are ambiguous.
    return running?.length === 1 ? appId(running[0].appid) : undefined;
  } catch { return undefined; }
}

export function isGameRunning(store: RunningGameStore | undefined, id: number): boolean {
  try { return Array.isArray(store?.RunningApps) && store.RunningApps.some((app) => appId(app?.appid) === id); }
  catch { return false; }
}

export function returnToRunningGame(store: RunningGameStore | undefined, id: number, navigate: (path: string) => void): boolean {
  if (!isGameRunning(store, id)) return false;
  if (typeof store?.SetRunningApp !== "function") throw new Error("A Steam játékválasztása nem érhető el.");
  // This is Game Mode's Resume path. RaiseWindowForGame can be a no-op in
  // gamescope, and RunGame could accidentally launch a game that has exited.
  store.SetRunningApp(id);
  if (typeof store.NavigateToRunningApp === "function") store.NavigateToRunningApp();
  else navigate("/apprunning");
  return true;
}
