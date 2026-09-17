type Subscription = { unregister(): void };
type ResumeSystem = {
  RegisterForOnResumeFromSuspend(callback: () => void): Subscription;
  RegisterForOnSuspendRequest(callback: () => void): Subscription;
};
type SuspendProgress = { state: number };
type ResumeUser = {
  RegisterForPrepareForSystemSuspendProgress(callback: (progress: SuspendProgress) => void): Subscription;
  RegisterForResumeSuspendedGamesProgress(callback: (progress: SuspendProgress) => void): Subscription;
};
export type SleepManager = {
  RegisterForNotifyResumeFromSuspend(callback: () => void): Subscription;
};
type RegisterEvent = (callback: () => void) => Subscription;
export type UiRefreshStatus = { working: boolean; message: string };
type Environment = {
  system?: Partial<ResumeSystem>;
  user?: Partial<ResumeUser>;
  sleepManager?: Partial<SleepManager>;
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
  automaticUnavailableReason = "A Steam ébresztésfigyelése nem érhető el. A kézi újratöltés használható.";
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
      this.automaticUnavailableReason = this.status.message;
      return;
    }
    const { system, user, sleepManager } = env;
    const resumeSources: RegisterEvent[] = [];
    const suspendSources: RegisterEvent[] = [];
    if (typeof system?.RegisterForOnResumeFromSuspend === "function") {
      resumeSources.push((callback) => system.RegisterForOnResumeFromSuspend!(callback));
    }
    if (typeof sleepManager?.RegisterForNotifyResumeFromSuspend === "function") {
      resumeSources.push((callback) => sleepManager.RegisterForNotifyResumeFromSuspend!(callback));
    }
    if (typeof user?.RegisterForResumeSuspendedGamesProgress === "function") {
      resumeSources.push((callback) => user.RegisterForResumeSuspendedGamesProgress!((progress) => {
        // User.* reports progress, not a single wake event. Wait until Steam
        // has finished resuming; ignore initial/invalid and intermediate states.
        if (progress?.state === 1) callback();
      }));
    }
    if (typeof system?.RegisterForOnSuspendRequest === "function") {
      suspendSources.push((callback) => system.RegisterForOnSuspendRequest!(callback));
    }
    if (typeof user?.RegisterForPrepareForSystemSuspendProgress === "function") {
      suspendSources.push((callback) => user.RegisterForPrepareForSystemSuspendProgress!((progress) => {
        // Only an actual preparation phase arms the next wake. A replayed
        // Complete state after reloading the UI must not arm another reload.
        if (progress?.state >= 2 && progress.state <= 5) callback();
      }));
    }
    try {
      this.subscribe(resumeSources, () => {
        if (!this.automaticAvailable) return;
        // Require a suspend observed by THIS instance. A resume callback on
        // re-registration after a JS restart must never cause a reload loop.
        const wasSuspended = this.suspended;
        this.suspended = false;
        if (wasSuspended && this.enabled) this.schedule(3_000);
      }, "A Steam ébresztési értesítései nem érhetők el.");
      this.subscribe(suspendSources, () => {
        if (!this.automaticAvailable) return;
        this.suspended = true;
        this.cancel();
      }, "A Steam altatási értesítései nem érhetők el.");
      this.automaticAvailable = true;
    } catch (error) {
      this.unsubscribe();
      this.automaticUnavailableReason = error instanceof Error ? error.message : String(error);
      this.update(false, this.automaticUnavailableReason + " Kézzel újratöltheted a felületet.");
    }
  }

  private subscribe(sources: RegisterEvent[], callback: () => void, unavailable: string): void {
    for (const register of sources) {
      let listening = false;
      try {
        const subscription = register(() => { if (listening && !this.disposed) callback(); });
        if (typeof subscription?.unregister !== "function") throw new Error("Invalid subscription");
        listening = true;
        this.subscriptions.push({ unregister: () => {
          listening = false;
          subscription.unregister();
        } });
        return;
      } catch {
        // A removed native method can still exist as a throwing stub. Try the
        // next compatible event source; failed registrations stay inert.
        listening = false;
      }
    }
    throw new Error(unavailable);
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
