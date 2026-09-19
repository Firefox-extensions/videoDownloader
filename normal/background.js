const ACTIVE_ICON = 'icons/video-active.svg';
const DISABLED_ICON = 'icons/video-disabled.svg';

function setActionAvailability(tabId, hasCandidates) {
  const action = browser.action;
  action.setIcon({ tabId, path: hasCandidates ? ACTIVE_ICON : DISABLED_ICON });
  action.setTitle({ tabId, title: hasCandidates ? 'Video Downloader' : '動画候補はありません' });
  return hasCandidates ? action.enable(tabId) : action.disable(tabId);
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    setActionAvailability(tabId, false).catch(() => {});
  }
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'videoCandidatesChanged' || !sender.tab?.id) return;
  setActionAvailability(sender.tab.id, message.count > 0).catch(() => {});
});
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'downloadVideo') {
    const url = message.url;
    if (!url) {
      sendResponse({ ok: false, error: 'URL is missing.' });
      return false;
    }

    const fileNameFromUrl = (() => {
      try {
        const parsed = new URL(url);
        const segments = parsed.pathname.split('/');
        const last = segments[segments.length - 1];
        return last && last.includes('.') ? last : 'downloaded-video';
      } catch (error) {
        return 'downloaded-video';
      }
    })();

    browser.downloads.download({
      url,
      filename: fileNameFromUrl,
      saveAs: true
    }).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: error.message || 'Download failed.' });
    });

    return true;
  }

  return false;
});


browser.action.onClicked.addListener((tab) => { if (tab.id !== undefined) { browser.tabs.sendMessage(tab.id, { type: 'toggleVideoList' }).catch(() => {}); } });
