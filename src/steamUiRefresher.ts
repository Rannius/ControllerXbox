export type UiResumeSnapshot = {
  success: boolean;
  available: boolean;
  enabled: boolean;
  session_id: string;
  sequence: number;
  pending: boolean;
  last_resume_at: number;
  last_request_at: number;
  last_outcome: string;
};
export type UiRefreshPermission = {
  success: boolean; allowed: boolean; reason?: string; attempt_id?: string;
};
export type RefreshTrigger = "manual" | "automatic";
export type RefreshGuard = "ready" | "locked" | "lock_unknown";
export type UiRefreshStatus = {
  working: boolean; message: string; monitorMessage?: string; resume?: UiResumeSnapshot;
};

type Environment = {
  browser?: { RestartJSContext?: () => void };
  // These backend calls must have bounded timeouts supplied by the caller.
  getResumeStatus(): Promise<UiResumeSnapshot>;
  beginRefresh(trigger: RefreshTrigger, session: string, sequence: number, guard: RefreshGuard): Promise<UiRefreshPermission>;
  finishRefresh(attempt: string, outcome: string): Promise<unknown>;
  isLocked(): boolean;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
  report(status: UiRefreshStatus): void;
};
type Attempt = {
  trigger: RefreshTrigger; resume?: UiResumeSnapshot; timer?: number; cancelled: boolean; called?: boolean;
};

export function uiRefreshOutcomeMessage(outcome: string): string {
  const messages: Record<string, string> = {
    idle: "Még nem volt észlelt ébresztés vagy újratöltési kérés.",
    detected: "Ébresztés észlelve, várakozás az újratöltésre.",
    disabled: "Az ébresztéskor az automatikus frissítés ki volt kapcsolva.",
    requested: "Újratöltés kérve; a Steam nem küld visszaigazolást.",
    locked: "Az újratöltés kimaradt: a zárolási képernyő aktív.",
    lock_unknown: "Az újratöltés kimaradt: a zárolási állapot nem ellenőrizhető.",
    expired: "Az ébresztés után egy percen belül nem indult újratöltés.",
    cancelled: "A várakozó újratöltés leállítva.",
    native_error: "A Steam hibát jelzett az újratöltés hívásakor.",
    unconfirmed: "Az újratöltés nem igazolható: a régi felület még futott 15 másodperc múlva.",
    cooldown: "Két újratöltési kérés között legalább 15 másodpercnek kell eltelnie.",
    stale: "Ez az ébresztés már nem vár újratöltésre.",
    too_early: "Várakozás az ébresztés utáni három másodpercre.",
  };
  return messages[outcome] ?? "Ismeretlen frissítési állapot.";
}

// Detect real suspend in the Linux backend, independently of Steam callbacks.
// The backend consumes the wake before the native call, surviving JS reloads.
export class SteamUiRefresher {
  readonly available: boolean;
  automaticAvailable = false;
  automaticUnavailableReason = "Ébresztésfigyelés ellenőrzése…";
  status: UiRefreshStatus = { working: false, message: "A felületfrissítő kipróbálásra kész." };
  private enabled = false;
  private settingsRevision = 0;
  private disposed = false;
  private pollTimer?: number;
  private attempt?: Attempt;

  constructor(private env: Environment) {
    this.available = typeof env.browser?.RestartJSContext === "function";
    if (!this.available) this.status.message = "A Steam felület-újratöltése ezen a verzión nem érhető el.";
    void this.poll();
  }

  setEnabled(enabled: boolean): void {
    this.settingsRevision++;
    this.enabled = enabled;
    if (!enabled && this.attempt?.trigger === "automatic" && !this.attempt.called) this.cancelAttempt();
  }

  private async poll(): Promise<void> {
    const revision = this.settingsRevision;
    try {
      const resume = await this.env.getResumeStatus();
      if (this.disposed) return;
      if (!resume.success) throw new Error("Az ébresztésfigyelő nem válaszolt sikeresen.");
      this.automaticAvailable = this.available && resume.available;
      this.automaticUnavailableReason = !this.available ? this.status.message
        : "A Linux ébresztésfigyelése nem érhető el. A kézi újratöltés használható.";
      this.update({ resume, monitorMessage: this.automaticAvailable
        ? "Linux ébresztésfigyelés működik."
        : this.automaticUnavailableReason });
      // A response already in flight must not undo a newly saved toggle.
      if (revision === this.settingsRevision) {
        this.enabled = resume.enabled;
        if (!this.enabled && this.attempt?.trigger === "automatic" && !this.attempt.called) this.cancelAttempt();
        if (this.enabled && this.automaticAvailable && resume.pending) this.schedule("automatic", resume);
      }
    } catch (error) {
      if (this.disposed) return;
      this.automaticAvailable = false;
      this.automaticUnavailableReason = "Ébresztésfigyelési hiba: " + String(error);
      this.update({ monitorMessage: this.automaticUnavailableReason });
    } finally {
      if (!this.disposed) this.pollTimer = this.env.setTimeout(() => {
        this.pollTimer = undefined;
        void this.poll();
      }, 2_000);
    }
  }

  refresh(): void { this.schedule("manual"); }

  private schedule(trigger: RefreshTrigger, resume?: UiResumeSnapshot): void {
    if (this.disposed || !this.available || this.attempt) return;
    const attempt: Attempt = { trigger, resume, cancelled: false };
    this.attempt = attempt;
    this.update({ working: true, message: trigger === "automatic"
      ? "Ébresztés észlelve. A Steam felülete három másodperc múlva újratöltődik…"
      : "A Steam felületének újratöltése hamarosan elindul…" });
    attempt.timer = this.env.setTimeout(() => {
      attempt.timer = undefined;
      void this.run(attempt);
    }, trigger === "automatic" ? 3_000 : 250);
  }

  private guard(): RefreshGuard {
    try { return this.env.isLocked() ? "locked" : "ready"; }
    catch { return "lock_unknown"; }
  }

  private async finish(id: string, outcome: string): Promise<void> {
    try { await this.env.finishRefresh(id, outcome); }
    catch { /* The claim remains consumed even if diagnostic reporting fails. */ }
  }

  private async run(attempt: Attempt): Promise<void> {
    let id: string | undefined;
    try {
      const claim = await this.env.beginRefresh(attempt.trigger,
        attempt.resume?.session_id ?? "", attempt.resume?.sequence ?? 0, this.guard());
      id = claim.attempt_id;
      if (this.disposed || attempt.cancelled) {
        if (claim.allowed && id) await this.finish(id, "cancelled");
        return;
      }
      if (!claim.success) throw new Error("A backend nem engedélyezte az újratöltési kérést.");
      if (!claim.allowed) {
        this.complete(attempt, uiRefreshOutcomeMessage(claim.reason ?? "unknown"));
        return;
      }
      if (!id) throw new Error("Az újratöltési kérés azonosítója hiányzik.");
      // Recheck after the asynchronous claim: the lock screen may have opened.
      const guard = this.guard();
      if (guard !== "ready") {
        void this.finish(id, guard);
        this.complete(attempt, uiRefreshOutcomeMessage(guard));
        return;
      }
      this.update({ working: true, message: uiRefreshOutcomeMessage("requested") });
      attempt.timer = this.env.setTimeout(() => {
        attempt.timer = undefined;
        void this.finish(id!, "unconfirmed");
        this.complete(attempt, uiRefreshOutcomeMessage("unconfirmed"));
      }, 15_000);
      attempt.called = true;
      this.env.browser!.RestartJSContext!();
    } catch (error) {
      if (id) void this.finish(id, "native_error");
      this.complete(attempt, "Felületfrissítési hiba: " + String(error));
    }
  }

  private complete(attempt: Attempt, message: string): void {
    if (attempt.timer !== undefined) this.env.clearTimeout(attempt.timer);
    if (this.attempt !== attempt) return;
    this.attempt = undefined;
    this.update({ working: false, message });
  }

  private cancelAttempt(): void {
    if (!this.attempt) return;
    this.attempt.cancelled = true;
    this.complete(this.attempt, uiRefreshOutcomeMessage("cancelled"));
  }

  private update(change: Partial<UiRefreshStatus>): void {
    const next = { ...this.status, ...change };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    if (!this.disposed) this.env.report(next);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer !== undefined) this.env.clearTimeout(this.pollTimer);
    this.cancelAttempt();
  }
}
