// Shared detection for the request queue and rendering, including compact and featured cards.
export const storePriceTilesScript = `
  function collectPriceTiles() {
    const found = new Map();
    const cardSelector = '.store_capsule,.tab_item,.search_result_row,.sale_capsule,.dailydeal,.small_cap,.large_cap,.capsule,[data-ds-appid]';
    for (const node of document.querySelectorAll('a[href*="/app/"],[data-ds-appid]')) {
      if (node.closest('#global_header,#store_header,.game_area_purchase,.game_area_purchase_game,#deck-play-badges-price,.dpb-tile-price,[data-ds-bundleid],[data-ds-packageid]')) continue;
      const link = node.matches('a[href*="/app/"]') ? node : node.querySelector('a[href*="/app/"]');
      const href = link?.getAttribute('href') || '';
      let linkedId = '';
      if (href) {
        try { const url = new URL(href, location.href); if (url.hostname !== 'store.steampowered.com') continue; linkedId = url.pathname.match(/^\\/app\\/(\\d+)/)?.[1] || ''; } catch { continue; }
      }
      const raw = node.getAttribute('data-ds-appid') || '';
      const id = linkedId || (/^\\d+$/.test(raw) ? raw : '');
      if (!id || Number(id) <= 0) continue;
      let host = link || node;
      let rect = host.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 30) {
        host = host.parentElement?.closest(cardSelector) || host.parentElement;
        if (!host || host === document.body) continue;
        rect = host.getBoundingClientRect();
      }
      if (found.has(host) || rect.width < 80 || rect.height < 30 || rect.width > Math.max(2000, innerWidth) || rect.height > 1000) continue;
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth || getComputedStyle(host).visibility === 'hidden') continue;
      const visual = host.querySelector('img,picture,video,[style*="background-image"]') || getComputedStyle(host).backgroundImage !== 'none';
      if (!visual && !host.matches(cardSelector) && !host.querySelector('[class*="Capsule"],[class*="capsule"],.tab_item_name,.title')) continue;
      found.set(host, { host, id });
    }
    return Array.from(found.values()).filter(item => !Array.from(found.keys()).some(other => other !== item.host && item.host.contains(other)));
  }
`;
