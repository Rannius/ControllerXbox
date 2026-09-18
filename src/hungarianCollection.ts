export const HUNGARIAN_COLLECTION_NAME = "🇭🇺 Magyar nyelvű játékok";

type App = { appid: number; app_type?: number; BIsModOrShortcut?: () => boolean };
type Languages = Record<string, boolean | null>;
type Collection = {
  displayName: string;
  apps: { has(id: number): boolean };
  AsDragDropCollection(): { AddApps(apps: App[]): void; RemoveApps(apps: App[]): void };
  Save(): Promise<void>;
};
type Store = {
  userCollections: Collection[];
  NewUnsavedCollection(name: string, filter: undefined, apps: App[]): Collection;
};
type Dependencies = {
  getStore(): Store | undefined;
  getApps(): App[];
  cached(ids: string[]): Promise<{ success: boolean; hungarian?: Languages }>;
  lookup(ids: string[]): Promise<{ success: boolean; hungarian?: Languages; unavailable?: string[] }>;
  onLanguages(languages: Languages): void;
};

export class HungarianCollection {
  status = "Magyar gyűjtemény: várakozás a beállításokra.";
  private listeners = new Set<(status: string) => void>();
  private enabled = false;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private retryAfter = new Map<string, number>();
  private unsaved?: { store: Store; collection: Collection };

  constructor(private deps: Dependencies) {}

  subscribe(listener: (status: string) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }

  private report(status: string): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      if (!enabled) this.report("Magyar gyűjtemény: gyűjtés szüneteltetve. A meglévő gyűjtemény megmarad.");
      return;
    }
    this.enabled = enabled;
    this.revision++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (enabled) {
      this.report("Magyar gyűjtemény: könyvtár ellenőrzése…");
      this.schedule(1000);
    } else {
      this.report("Magyar gyűjtemény: gyűjtés szüneteltetve. A meglévő gyűjtemény megmarad.");
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

  private async sync(store: Store, apps: App[], languages: Languages): Promise<void> {
    const positive = apps.filter(app => languages[String(app.appid)] === true);
    const existing = store.userCollections.find(c => c.displayName === HUNGARIAN_COLLECTION_NAME);
    const pending = this.unsaved?.store === store ? this.unsaved.collection : undefined;
    let collection = existing ?? pending;
    if (!collection && !positive.length) return;
    if (!collection) {
      collection = store.NewUnsavedCollection(HUNGARIAN_COLLECTION_NAME, undefined, []);
      this.unsaved = { store, collection };
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
      this.unsaved = { store, collection };
      if (add.length) editable.AddApps(add);
      if (remove.length) editable.RemoveApps(remove);
    }
    if (this.unsaved?.collection === collection) {
      await collection.Save();
      this.unsaved = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    const revision = this.revision;
    const current = () => this.enabled && revision === this.revision;
    let delay = 5000;
    try {
      const store = this.deps.getStore();
      if (!store || !Array.isArray(store.userCollections) || typeof store.NewUnsavedCollection !== "function") {
        throw new Error("Várakozás a Steam gyűjteménykezelőjére.");
      }
      const apps = this.apps();
      if (!apps.length) throw new Error("Várakozás a Steam könyvtárára.");
      const ids = apps.map(app => String(app.appid));
      const cached = await this.deps.cached(ids);
      if (!current()) return;
      if (!cached.success) throw new Error("A nyelvi gyorsítótár nem érhető el.");
      const languages = { ...cached.hungarian };
      const pending = ids.filter(id => !Object.prototype.hasOwnProperty.call(languages, id));
      // Two games per round, at least five seconds apart; no full-library burst.
      const batch = pending.filter(id => (this.retryAfter.get(id) ?? 0) <= Date.now()).slice(0, 2);
      if (batch.length) {
        const result = await this.deps.lookup(batch);
        if (!current()) return;
        if (!result.success) throw new Error("A Steam nyelvi adatai nem érhetők el.");
        for (const id of batch) {
          if (result.unavailable?.includes(id) || !Object.prototype.hasOwnProperty.call(result.hungarian ?? {}, id)) {
            this.retryAfter.set(id, Date.now() + 15 * 60_000);
          } else {
            languages[id] = result.hungarian![id];
            this.retryAfter.delete(id);
          }
        }
        if (batch.every(id => this.retryAfter.has(id))) delay = 60_000;
      }
      if (!current() || this.deps.getStore() !== store) return;
      this.deps.onLanguages(languages);
      // Re-read ownership after I/O, including account/library changes.
      const currentApps = this.apps();
      await this.sync(store, currentApps, languages);
      if (!current()) return;
      const checked = currentApps.filter(app => Object.prototype.hasOwnProperty.call(languages, String(app.appid))).length;
      const found = currentApps.filter(app => languages[String(app.appid)] === true).length;
      this.report(`Magyar gyűjtemény: ${found} magyar játék · ${checked}/${currentApps.length} ellenőrizve.`
        + (checked < currentApps.length ? " A keresés a háttérben folytatódik."
          : found ? " Könyvtár → Gyűjtemények." : " Nincs igazolt magyar találat."));
      if (!pending.length || !batch.length) delay = 60_000;
    } catch (error) {
      if (current()) this.report("Magyar gyűjtemény: " + (error instanceof Error ? error.message : String(error)));
      delay = 60_000;
    } finally {
      this.running = false;
      this.schedule(delay);
    }
  }
}
