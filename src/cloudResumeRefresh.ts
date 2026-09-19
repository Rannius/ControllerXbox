// Refresh catalog data only. This never reloads Steam or changes game focus.
export class CloudResumeRefresh {
  private active = false;
  private unregister?: () => void;
  private interval?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private lastTick = 0;
  private lastWake = 0;
  constructor(private deps: {
    register(callback: () => void): (() => void) | undefined;
    refresh(): Promise<void>;
    onError(error: unknown): void;
  }) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lastTick = Date.now();
    try { this.unregister = this.deps.register(() => this.wake()); }
    catch (error) { this.deps.onError(error); }
    // Timer gaps also detect suspend when the Steam notification API is absent.
    this.interval = setInterval(() => {
      const now = Date.now();
      if (now - this.lastTick > 45_000) this.wake();
      this.lastTick = now;
    }, 15_000);
  }

  private wake(): void {
    if (!this.active || this.running || this.timer !== undefined || Date.now() - this.lastWake < 60_000) return;
    this.lastWake = Date.now();
    this.schedule(8000, 0);
  }

  private schedule(delay: number, attempt: number): void {
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(attempt); }, delay);
  }

  private async run(attempt: number): Promise<void> {
    if (!this.active) return;
    this.running = true;
    try { await this.deps.refresh(); }
    catch (error) {
      this.deps.onError(error);
      // Wi-Fi may still be reconnecting after wake. Retry without overlapping.
      if (this.active && attempt < 2) this.schedule(attempt === 0 ? 30_000 : 120_000, attempt + 1);
    } finally { this.running = false; }
  }

  stop(): void {
    this.active = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.interval !== undefined) clearInterval(this.interval);
    try { this.unregister?.(); } catch { /* Steam may already be stopping. */ }
    this.timer = undefined;
    this.interval = undefined;
  }
}
