type Subscription = { unregister(): void };
type ResumeSystem = {
  RegisterForOnResumeFromSuspend(callback: () => void): Subscription;
  RegisterForOnSuspendRequest(callback: () => void): Subscription;
};
export type UiRefreshStatus = { working: boolean; message: string };
type Environment = {
  system?: Partial<ResumeSystem>;
  browser?: { RestartJSContext?: () => void };
  isLocked(): boolean;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
  report(status: UiRefreshStatus): void;
};

// Restart the same shared UI context as Decky's own reinjection helper.
// This cannot repair a native Steam Input/driver fault or verify the buttons.
export class SteamUiRefresher {
  readonly available: boolean;
  automaticAvailable = false;
  status: UiRefreshStatus = { working: false, message: "A felületfrissítő kipróbálásra kész." };
  private enabled = false;
  private disposed = false;
  private suspended = false;
  private timer?: number;
  private subscriptions: Subscription[] = [];

  constructor(private env: Environment) {
    this.available = typeof env.browser?.RestartJSContext === "function";
    if (!this.available) {
      this.status.message = "A Steam felület-újratöltése ezen a verzión nem érhető el.";
      return;
    }
    const system = env.system;
    if (!system?.RegisterForOnResumeFromSuspend || !system.RegisterForOnSuspendRequest) return;
    try {
      this.subscriptions.push(system.RegisterForOnResumeFromSuspend(() => {
        // Require a suspend observed by THIS instance. A resume callback on
        // re-registration after a JS restart must never cause a reload loop.
        const wasSuspended = this.suspended;
        this.suspended = false;
        if (wasSuspended && this.enabled) this.schedule(3_000);
      }));
      this.subscriptions.push(system.RegisterForOnSuspendRequest(() => {
        this.suspended = true;
        this.cancel();
      }));
      this.automaticAvailable = true;
    } catch {
      this.unsubscribe();
      this.update(false, "Az automatikus ébresztésfigyelés nem érhető el. Kézzel újratöltheted a felületet.");
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled && this.automaticAvailable;
    if (!this.enabled) this.cancel();
  }

  refresh(): void {
    this.schedule(250);
  }

  private schedule(delay: number): void {
    if (this.disposed || this.suspended || !this.available || this.status.working) return;
    this.update(true, "A Steam felületének újratöltése hamarosan elindul…");
    this.timer = this.env.setTimeout(() => {
      this.timer = undefined;
      try {
        if (this.env.isLocked()) {
          this.update(false, "Az újratöltés kimaradt: a zárolási képernyő aktív.");
          return;
        }
        this.update(true, "Újratöltés kérve. A felület visszatérése után próbáld ki a STEAM és a … gombot.");
        // If this context remains alive, the native call did not establish
        // that a reload happened. Do not retry or escalate to a Steam restart.
        this.timer = this.env.setTimeout(() => {
          this.timer = undefined;
          this.update(false, "Az újratöltést nem sikerült visszaigazolni. Ha a gombok továbbra sem működnek, a hiba mélyebben lehet a Steamben.");
        }, 15_000);
        this.env.browser!.RestartJSContext!();
      } catch (error) {
        this.cancel();
        this.update(false, "Felületfrissítési hiba: " + (error instanceof Error ? error.message : String(error)));
      }
    }, delay);
  }

  private update(working: boolean, message: string): void {
    this.status = { working, message };
    if (!this.disposed) this.env.report(this.status);
  }

  private cancel(): void {
    if (this.timer !== undefined) this.env.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.status.working) this.update(false, "A várakozó felületfrissítés leállítva.");
  }

  private unsubscribe(): void {
    for (const subscription of this.subscriptions.splice(0)) {
      try { subscription.unregister(); } catch { /* Continue cleaning up. */ }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.unsubscribe();
  }
}
