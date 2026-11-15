(() => {
  // Run before the browser can paint either page's default content.
  if (location.hash.startsWith('#anime')) {
    document.documentElement.dataset.initialView = 'anime';
  }
  if (location.hash.startsWith('#manga')) {
    document.documentElement.dataset.initialView = 'manga';
  }
  const query = new URLSearchParams(location.search);
  if (query.has('oidc') || query.has('oidc_error')) return;
  try {
    if (localStorage.getItem('haven_token')) {
      document.documentElement.classList.add('has-saved-session');
    }
  } catch { /* Storage can be unavailable in embedded browsers. */ }
})();
