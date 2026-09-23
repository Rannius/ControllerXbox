// Runs in the signed-in Steam Store webview; cookies never leave that webview.
export function wishlistScript(knownOwner: string, useKnownList: boolean): string {
  return `(async () => {
    if (location.hostname !== 'store.steampowered.com') return { owner: '', ids: [] };
    let info = {};
    try { info = JSON.parse(document.getElementById('application_config')?.getAttribute('data-userinfo') || '{}'); } catch {}
    const account = Number(window.g_AccountID || 0);
    const owner = account > 0 && Number.isInteger(account)
      ? String(BigInt('76561197960265728') + BigInt(account)) : String(info.steamid || '');
    if (info.logged_in === false || !/^\\d{17}$/.test(owner)) return { owner: '', ids: [] };
    if (owner === ${JSON.stringify(knownOwner)} && ${useKnownList}) return { owner };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch('/dynamicstore/userdata/?id=' + account, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('Steam HTTP ' + response.status);
      const data = await response.json();
      if (!Array.isArray(data.rgWishlist) || data.rgWishlist.length > 10000) throw new Error('A kívánságlista nem olvasható.');
      const ids = Array.from(new Set(data.rgWishlist.map(String)));
      if (ids.some(id => !/^\\d+$/.test(id) || Number(id) <= 0 || Number(id) >= 10000000000)) throw new Error('Érvénytelen kívánságlista.');
      return { owner, ids };
    } finally { clearTimeout(timer); }
  })()`;
}

type Snapshot = { owner: string; ids?: string[] };
type Send = (script: string, returnByValue: boolean) => Promise<unknown>;
export class PriceWishlistSync {
  private owner = '';
  private ids: string[] = [];
  private listExpires = 0;
  private nextSync = 0;
  private running = false;
  private revision = 0;
  constructor(private deps: {
    enabled(): Promise<boolean>;
    sync(owner: string, ids: string[], error?: string): Promise<unknown>;
    error(error: unknown): void;
  }) {}

  scan(send: Send): void {
    if (this.running || Date.now() < this.nextSync) return;
    this.nextSync = Date.now() + 30000;
    this.running = true;
    const revision = this.revision;
    void (async () => {
      if (!await this.deps.enabled()) {
        if (revision === this.revision) await this.deps.sync('', []);
        return;
      }
      if (revision !== this.revision) return;
      const value = await send(wishlistScript(this.owner, Date.now() < this.listExpires), true) as Snapshot;
      if (revision !== this.revision) return;
      if (!value || typeof value.owner !== 'string') throw new Error('A Steam kívánságlista nem érhető el.');
      if (Array.isArray(value.ids)) {
        this.owner = value.owner; this.ids = value.ids; this.listExpires = Date.now() + 300000;
      } else if (value.owner !== this.owner) throw new Error('Megváltozott Steam-fiók.');
      await this.deps.sync(this.owner, this.ids);
    })().catch(error => {
      if (revision === this.revision) {
        this.listExpires = 0;
        this.deps.error(error);
        void this.deps.sync('', [], String(error)).catch(() => {});
      }
    }).finally(() => { this.running = false; });
  }

  stop(): void {
    this.revision++; this.nextSync = 0; this.listExpires = 0; this.owner = ''; this.ids = [];
    void this.deps.sync('', []).catch(() => {});
  }
}
