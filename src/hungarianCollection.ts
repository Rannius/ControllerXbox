export const HUNGARIAN_COLLECTION_NAME = "🇭🇺 Magyar nyelvű játékok";

type App = { appid: number; app_type?: number; display_name?: string; strDisplayName?: string; name?: string; BIsModOrShortcut?: () => boolean };
type Languages = Record<string, boolean | null>;
type Sources = Record<string, "steam" | "curator" | null>;
type LanguageResponse = {
  success: boolean;
  hungarian?: Languages;
  hungarian_sources?: Sources;
  curator_status?: "loading" | "cached" | "unavailable";
  unavailable?: string[];
  retry_after?: number;
};
type Collection = {
  displayName: string;
  apps: { has(id: number): boolean };
  AsDragDropCollection(): { AddApps(apps: App[]): void; RemoveApps(apps: App[]): void };
  Save(): Promise<void>;
};
type Store = {
  allAppsCollection?: { allApps?: App[]; apps?: Iterable<App> };
  collectionsFromStorage?: { values(): IterableIterator<Collection> };
  m_cloudStorageMap?: { StoreObject: unknown };
  NewUnsavedCollection(name: string, filter: undefined, apps: App[]): Collection;
};
// Steam's userCollections computed getter calls .values() before storage exists.
// Do not evaluate it, even inside try/catch: MobX shares that computed failure
// with Steam's own library views. Use the storage map after initialization.
export function readyCollectionStore(store: Store | undefined): store is Store {
  return !!store && typeof store.collectionsFromStorage?.values === "function"
    && typeof store.m_cloudStorageMap?.StoreObject === "function"
    && typeof store.NewUnsavedCollection === "function";
}

export type CollectionProgress = {
  phase: "waiting" | "cache" | "checking" | "saving" | "between" | "done" | "error" | "paused";
  total: number; processed: number; checked: number; found: number; collected: number; unknown: number;
  current: string; nextCheckAt: number;
};
type Dependencies = {
  getStore(): Store | undefined;
  getApps(): App[];
  cached(ids: string[]): Promise<LanguageResponse>;
  lookup(ids: string[]): Promise<LanguageResponse>;
  onLanguages(languages: Languages, sources: Sources): void;
};

export class HungarianCollection {
  status = "Magyar gyűjtemény: várakozás a beállításokra.";
  progress: CollectionProgress = { phase: "waiting", total: 0, processed: 0, checked: 0, found: 0, collected: 0, unknown: 0, current: "", nextCheckAt: 0 };
  private listeners = new Set<(status: string) => void>();
  private enabled = false;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private retryAfter = new Map<string, number>();
  private attempted = new Map<string, number>();
  private attemptSequence = 0;
  private scanStorage?: Store["collectionsFromStorage"];
  private unsaved?: { store: Store; storage: Store["collectionsFromStorage"]; collection: Collection };

  constructor(private deps: Dependencies) {}

  subscribe(listener: (status: string) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }

  private report(status: string, progress: Partial<CollectionProgress> = {}): void {
    this.progress = { ...this.progress, ...progress };
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  settingsUnavailable(): void {
    if (!this.enabled) this.report("A backend nem válaszol. A beállítások betöltését újrapróbáljuk.", { phase: "error" });
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      if (!enabled) this.report("Gyűjtés szüneteltetve. A meglévő gyűjtemény megmarad.", { phase: "paused", current: "", nextCheckAt: 0 });
      return;
    }
    this.enabled = enabled;
    this.revision++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (enabled) {
      this.report("Könyvtár betöltése…", { phase: "waiting", current: "", nextCheckAt: 0 });
      this.schedule(1000);
    } else {
      this.report("Gyűjtés szüneteltetve. A meglévő gyűjtemény megmarad.", { phase: "paused", current: "", nextCheckAt: 0 });
    }
  }

  stop(): void {
    this.setEnabled(false);
    this.listeners.clear();
  }

  private schedule(delay: number): void {
    if (!this.enabled || this.timer !== undefined || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  private apps(): App[] {
    return Array.from(new Map(this.deps.getApps()
      .filter(app => Number.isInteger(app.appid) && app.appid > 0 && app.appid < 2147483648
        && !app.BIsModOrShortcut?.() && (app.app_type === undefined || app.app_type === 1))
      .map(app => [String(app.appid), app])).values());
  }

  private async sync(store: Store, apps: App[], languages: Languages): Promise<number> {
    const positive = apps.filter(app => languages[String(app.appid)] === true);
    if (!readyCollectionStore(store)) throw new Error("Várakozás a Steam gyűjteménykezelőjére.");
    const existing = Array.from(store.collectionsFromStorage!.values()).find(c => c.displayName === HUNGARIAN_COLLECTION_NAME);
    const pending = this.unsaved?.store === store && this.unsaved.storage === store.collectionsFromStorage ? this.unsaved.collection : undefined;
    let collection = existing ?? pending;
    if (!collection && !positive.length) return 0;
    if (!collection) {
      collection = store.NewUnsavedCollection(HUNGARIAN_COLLECTION_NAME, undefined, []);
      this.unsaved = { store, storage: store.collectionsFromStorage, collection };
    }
    if (typeof collection?.apps?.has !== "function" || typeof collection.Save !== "function"
        || typeof collection.AsDragDropCollection !== "function") {
      throw new Error("A Steam gyűjteménykezelője nem kompatibilis.");
    }
    const add = positive.filter(app => !collection!.apps.has(app.appid));
    // Missing/offline language data never removes an already confirmed game.
    const remove = apps.filter(app => languages[String(app.appid)] === false && collection!.apps.has(app.appid));
    if (add.length || remove.length) {
      const editable = collection.AsDragDropCollection();
      if (typeof editable?.AddApps !== "function" || (remove.length && typeof editable.RemoveApps !== "function")) {
        throw new Error("A Steam gyűjtemény nem módosítható.");
      }
      this.unsaved = { store, storage: store.collectionsFromStorage, collection };
      if (add.length) editable.AddApps(add);
      if (remove.length) editable.RemoveApps(remove);
    }
    if (this.unsaved?.collection === collection) {
      await collection.Save();
      this.unsaved = undefined;
    }
    return apps.filter(app => collection!.apps.has(app.appid)).length;
  }

  private async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    const revision = this.revision;
    const current = () => this.enabled && revision === this.revision;
    let delay = 60_000;
    try {
      const store = this.deps.getStore();
      if (!readyCollectionStore(store)) {
        throw new Error("Várakozás a Steam gyűjteménykezelőjére.");
      }
      const storage = store.collectionsFromStorage;
      if (this.scanStorage !== storage) {
        this.scanStorage = storage;
        this.attempted.clear();
        this.retryAfter.clear();
      }
      const apps = this.apps();
      if (!apps.length) throw new Error("Várakozás a Steam könyvtárára.");
      const ids = apps.map(app => String(app.appid));
      this.report("Mentett nyelvi adatok és kurátortalálatok betöltése…", { phase: "cache", total: ids.length, current: "", nextCheckAt: 0 });
      const cached = await this.deps.cached(ids);
      if (!current()) return;
      if (!cached.success) throw new Error("A nyelvi gyorsítótár nem érhető el.");
      const languages = { ...cached.hungarian };
      const sources = { ...cached.hungarian_sources };
      const counts = (list: App[]) => ({ total: list.length,
        processed: list.filter(app => this.attempted.has(String(app.appid)) || Object.prototype.hasOwnProperty.call(languages, String(app.appid))).length,
        checked: list.filter(app => typeof languages[String(app.appid)] === "boolean").length,
        found: list.filter(app => languages[String(app.appid)] === true).length,
        unknown: list.filter(app => languages[String(app.appid)] === null || (this.attempted.has(String(app.appid)) && !Object.prototype.hasOwnProperty.call(languages, String(app.appid)))).length });
      const pending = ids.filter(id => !Object.prototype.hasOwnProperty.call(languages, id));
      const queue = pending.filter(id => (this.retryAfter.get(id) ?? 0) <= Date.now())
        .sort((a, b) => (this.attempted.get(a) ?? 0) - (this.attempted.get(b) ?? 0));
      const valid = () => current() && this.deps.getStore() === store && store.collectionsFromStorage === storage;
      if (!valid()) return;
      this.deps.onLanguages(languages, sources);
      // Cached and curator matches are collected before any network lookups.
      const collectedBefore = await this.sync(store, this.apps(), languages);
      if (!valid()) return;
      this.report("Folyamatos ellenőrzés, legfeljebb 4 párhuzamos lekéréssel…", { ...counts(apps), collected: collectedBefore, phase: "checking" });
      const active = new Set<string>();
      const names = new Map(apps.map(app => [String(app.appid), app.display_name || app.strDisplayName || app.name || `Steam AppID ${app.appid}`]));
      let cursor = 0;
      let pauseUntil = 0;
      let lookupError = "";
      const showProgress = () => this.report("Folyamatos ellenőrzés, legfeljebb 4 párhuzamos lekéréssel…", {
        ...counts(this.apps()), phase: "checking", current: Array.from(active, id => names.get(id) || id).join(" · "), nextCheckAt: 0,
      });
      const worker = async () => {
        while (valid() && !pauseUntil && cursor < queue.length) {
          const id = queue[cursor++];
          // Ownership may change while a long scan is running.
          if (!this.apps().some(app => String(app.appid) === id)) continue;
          active.add(id);
          showProgress();
          let result: LanguageResponse;
          try {
            result = await this.deps.lookup([id]);
            if (!result.success) throw new Error("A Steam nyelvi adatai nem érhetők el.");
          } catch (error) {
            lookupError = error instanceof Error ? error.message : String(error);
            result = { success: false, unavailable: [id], retry_after: 60 };
          }
          active.delete(id);
          if (!valid()) return;
          this.attempted.set(id, ++this.attemptSequence);
          if ((result.retry_after ?? 0) > 0) {
            pauseUntil = Math.max(pauseUntil, Date.now() + Math.min(3600, result.retry_after!) * 1000);
            lookupError = "A Steam átmenetileg nem fogad új lekérést";
          }
          if ((result.unavailable?.includes(id) && result.hungarian?.[id] !== true)
              || !Object.prototype.hasOwnProperty.call(result.hungarian ?? {}, id)) {
            this.retryAfter.set(id, Date.now() + ((result.retry_after ?? 0) > 0 ? Math.min(3600, result.retry_after!) * 1000 : 15 * 60_000));
          } else {
            languages[id] = result.hungarian![id];
            sources[id] = result.hungarian_sources?.[id] ?? null;
            this.retryAfter.delete(id);
            this.deps.onLanguages({ [id]: languages[id] }, { [id]: sources[id] });
          }
          showProgress();
        }
      };
      // No batch barrier: a free worker immediately takes the next game.
      const workers = await Promise.allSettled(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
      const failed = workers.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      if (pauseUntil) delay = Math.max(1000, pauseUntil - Date.now());
      else if (cached.curator_status === "loading") delay = 5000;
      if (!current() || this.deps.getStore() !== store || store.collectionsFromStorage !== storage) return;
      this.deps.onLanguages(languages, sources);
      // Re-read ownership after I/O, including account/library changes.
      const currentApps = this.apps();
      this.report("Magyar gyűjtemény egyeztetése és mentése…", { ...counts(currentApps), phase: "saving", current: "" });
      const collected = await this.sync(store, currentApps, languages);
      if (!current()) return;
      const checked = currentApps.filter(app => typeof languages[String(app.appid)] === "boolean").length;
      const found = currentApps.filter(app => languages[String(app.appid)] === true).length;
      this.report(`${found} magyar játék · ${checked}/${currentApps.length} játékhoz van nyelvi adat.`
        + (checked < currentApps.length ? " A keresés a háttérben folytatódik."
          : found ? " Könyvtár → Gyűjtemények." : " Nincs igazolt magyar találat.")
        + (cached.curator_status === "loading" ? " Magyar Felirat: lista betöltése…"
          : cached.curator_status === "unavailable" ? " A Magyar Felirat listája még nem érhető el; később újrapróbáljuk." : "")
        + (lookupError ? ` Az aktuális lekérés sikertelen: ${lookupError}. A többi játék következik.` : ""),
        { ...counts(currentApps), collected, current: "", phase: checked === currentApps.length && cached.curator_status !== "loading" && cached.curator_status !== "unavailable" ? "done" : "between", nextCheckAt: Date.now() + delay });
    } catch (error) {
      if (current()) this.report(error instanceof Error ? error.message : String(error), { phase: "error", current: "", nextCheckAt: Date.now() + 60_000 });
      delay = 60_000;
    } finally {
      this.running = false;
      this.schedule(delay);
    }
  }
}
