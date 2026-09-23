// Two independent rows shared by the icon and price renderers.
export const storeBadgeDockScript = `
  const docks = {};
  for (const side of ['left', 'right']) {
    const id = 'deck-play-badges-dock' + (side === 'right' ? '-right' : '');
    let row = document.getElementById(id);
    if (!row) { row = document.createElement('div'); row.id = id; document.body.appendChild(row); }
    row.style.cssText = 'position:fixed;' + side + ':20px;bottom:20px;z-index:999999;display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:calc(50vw - 40px);pointer-events:none;justify-content:' + (side === 'right' ? 'flex-end' : 'flex-start');
    docks[side] = row;
  }
  const protonMarkers = document.querySelectorAll('.protondb-decky-indicator-container,[data-pp-game-badge],a[href*="protondb.com/app/"]');
  for (const marker of protonMarkers) {
    let anchor = marker;
    while (anchor && anchor !== document.body && getComputedStyle(anchor).position !== 'fixed') anchor = anchor.parentElement;
    if (!anchor || anchor === document.body) continue;
    let rect = anchor.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.width < 250 && rect.top > innerHeight / 2) {
      const side = window.__dpbSides?.proton || 'right';
      const saved = window.__dpbProtonPositions = window.__dpbProtonPositions || new Map();
      if (!saved.has(anchor)) saved.set(anchor, ['left', 'right'].map(key => [key, anchor.style.getPropertyValue(key), anchor.style.getPropertyPriority(key)]));
      anchor.style.setProperty(side, '20px', 'important');
      anchor.style.setProperty(side === 'left' ? 'right' : 'left', 'auto', 'important');
      rect = anchor.getBoundingClientRect();
      docks[side].style[side] = (rect.width + 28) + 'px';
      docks[side].style.bottom = Math.max(8, innerHeight - rect.bottom) + 'px';
      docks[side].style.maxWidth = Math.max(40, innerWidth / 2 - rect.width - 48) + 'px';
      break;
    }
  }
`;

export const storeBadgeDockCleanupScript = `
  for (const [element, values] of window.__dpbProtonPositions || []) {
    for (const [key, value, priority] of values) {
      if (value) element.style.setProperty(key, value, priority); else element.style.removeProperty(key);
    }
  }
  delete window.__dpbProtonPositions;
  delete window.__dpbSides;
  document.getElementById('deck-play-badges-dock')?.remove();
  document.getElementById('deck-play-badges-dock-right')?.remove();
`;
