const isHavenApp = () => Boolean(
  document.getElementById('soundboard-grid')
  && document.getElementById('message-input')
  && document.querySelector('script[type="module"][src*="/js/app.js"]')
);

if (isHavenApp()) {
  let pageStatus = {
    inVoice: false,
    lastActiveAt: Date.now()
  };

  const notifyPageReady = () => {
    window.postMessage({
      source: 'haven-soundboard-extension',
      type: 'ready'
    }, window.location.origin);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== 'haven-soundboard') return;

    if (message.type === 'probe') {
      notifyPageReady();
      return;
    }

    if (message.type === 'status' || message.type === 'activity') {
      pageStatus = {
        inVoice: Boolean(message.inVoice),
        lastActiveAt: Number(message.lastActiveAt || message.at) || pageStatus.lastActiveAt
      };
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'get-haven-status') {
      sendResponse({
        isHaven: true,
        inVoice: pageStatus.inVoice,
        lastActiveAt: pageStatus.lastActiveAt
      });
      return;
    }

    if (message?.type === 'trigger-haven-sound') {
      window.postMessage({
        source: 'haven-soundboard-extension',
        type: 'trigger',
        slot: String(message.slot || '')
      }, window.location.origin);
      sendResponse({ ok: true });
    }
  });

  notifyPageReady();
}