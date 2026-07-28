const SLOT_COMMAND = /^sound-slot-([1-4])$/;

const queryHavenCandidates = async () => {
  const tabs = await chrome.tabs.query({
    url: ['http://*/*', 'https://*/*']
  });

  const candidates = await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) return null;
    try {
      const status = await chrome.tabs.sendMessage(tab.id, { type: 'get-haven-status' });
      if (!status?.isHaven) return null;
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        active: Boolean(tab.active),
        inVoice: Boolean(status.inVoice),
        lastActiveAt: Number(status.lastActiveAt) || 0
      };
    } catch {
      return null;
    }
  }));

  return candidates.filter(Boolean).sort((left, right) => (
    Number(right.inVoice) - Number(left.inVoice)
    || right.lastActiveAt - left.lastActiveAt
    || Number(right.active) - Number(left.active)
  ));
};

const showFailureBadge = async () => {
  await chrome.action.setBadgeBackgroundColor({ color: '#ed4245' });
  await chrome.action.setBadgeText({ text: '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
};

const triggerSlot = async (slot) => {
  const [target] = await queryHavenCandidates();
  if (!target) {
    await showFailureBadge();
    return;
  }

  try {
    await chrome.tabs.sendMessage(target.tabId, {
      type: 'trigger-haven-sound',
      slot
    });
  } catch {
    await showFailureBadge();
  }
};

chrome.commands.onCommand.addListener((command) => {
  const match = SLOT_COMMAND.exec(command);
  if (!match) return;
  void triggerSlot(match[1]);
});