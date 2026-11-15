const paths = {
  book: '<path d="M12 5v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2Z"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
  shelf: '<path d="M3 4h4v16H3zM10 4h4v16h-4zM16 5l4-1 4 15-4 1z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  update: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14-1l1 6M4 12l1 6a8 8 0 0 0 14-1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  heart: '<path d="M20 5c-3-3-7 0-8 2-1-2-5-5-8-2-5 5 8 15 8 15s13-10 8-15Z"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  back: '<path d="m14 5-7 7 7 7"/>', next: '<path d="m10 5 7 7-7 7"/>',
  gear: '<path d="m10 3 4 0 1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3l-2-2 2-4 3 1 3-1z" transform="translate(1 -1) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1"/>',
  full: '<path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  leaf: '<path d="M20 3C7 1 1 8 5 16c8 5 15-2 15-13ZM4 21 17 7"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H3l2-5A9 9 0 1 1 21 11Z"/>',
};
export const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
