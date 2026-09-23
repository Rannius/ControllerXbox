// Shared by the icon and price renderers; neither owns the other's children.
export const storeBadgeDockScript = `
  let dock = document.getElementById('deck-play-badges-dock');
  if (!dock) {
    dock = document.createElement('div'); dock.id = 'deck-play-badges-dock';
    document.body.appendChild(dock);
  }
  dock.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:999999;display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:calc(100vw - 40px);pointer-events:none';
  const protonMarkers = document.querySelectorAll('.protondb-decky-indicator-container,[data-pp-game-badge],a[href*="protondb.com/app/"]');
  for (const marker of protonMarkers) {
    let anchor = marker;
    while (anchor && anchor !== document.body && getComputedStyle(anchor).position !== 'fixed') anchor = anchor.parentElement;
    if (!anchor || anchor === document.body) continue;
    let rect = anchor.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.width < 250 && rect.top > innerHeight / 2) {
      if (rect.left >= innerWidth / 2) {
        const saved = window.__dpbProtonPositions = window.__dpbProtonPositions || new Map();
        if (!saved.has(anchor)) saved.set(anchor, ['left', 'right'].map(key => [key, anchor.style.getPropertyValue(key), anchor.style.getPropertyPriority(key)]));
        anchor.style.setProperty('left', '20px', 'important');
        anchor.style.setProperty('right', 'auto', 'important');
        rect = anchor.getBoundingClientRect();
      }
      dock.style.left = (rect.right + 8) + 'px';
      dock.style.bottom = Math.max(8, innerHeight - rect.bottom) + 'px';
      dock.style.maxWidth = Math.max(120, innerWidth - rect.right - 28) + 'px';
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
  document.getElementById('deck-play-badges-dock')?.remove();
`;
