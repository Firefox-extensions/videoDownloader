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
function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const segments = [];

  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (!line) continue;

    const candidate = new URL(line, baseUrl).href;
    const lower = candidate.toLowerCase();

    if (lower.endsWith('.ts') || lower.endsWith('.m4s') || lower.endsWith('.mp4')) {
      segments.push(candidate);
    }
  }

  if (!segments.length) {
    const urls = text.match(/https?:\/\/[^\s"']+/gi) || [];
    for (const match of urls) {
      const candidate = new URL(match, baseUrl).href;
      const lower = candidate.toLowerCase();
      if (lower.endsWith('.ts') || lower.endsWith('.m4s') || lower.endsWith('.mp4')) {
        segments.push(candidate);
      }
    }
  }

  return [...new Set(segments)];
}

async function downloadHls(url) {
  const playlistResponse = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!playlistResponse.ok) {
    throw new Error('Playlist fetch failed.');
  }

  const playlistText = await playlistResponse.text();
  const segments = parsePlaylist(playlistText, url);

  if (!segments.length) {
    throw new Error('M3U8 にセグメントが見つかりません。');
  }

  const chunks = [];
  for (const segmentUrl of segments) {
    try {
      const response = await fetch(segmentUrl, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) continue;
      const buffer = await response.arrayBuffer();
      chunks.push(new Uint8Array(buffer));
    } catch (error) {
      console.warn('Skipping segment', segmentUrl, error);
    }
  }

  if (!chunks.length) {
    throw new Error('セグメントを取得できませんでした。');
  }

  const fileName = `${new URL(url).pathname.split('/').pop() || 'hls-video'}.ts`;
  const blob = new Blob(chunks, { type: 'video/mp2t' });
  const objectUrl = URL.createObjectURL(blob);

  try {
    await browser.downloads.download({
      url: objectUrl,
      filename: fileName,
      saveAs: true
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

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

  if (message && message.type === 'downloadHls') {
    downloadHls(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error(error);
        sendResponse({ ok: false, error: error.message || 'HLS download failed.' });
      });
    return true;
  }

  return false;
});


browser.action.onClicked.addListener((tab) => { if (tab.id !== undefined) { browser.tabs.sendMessage(tab.id, { type: 'toggleVideoList' }).catch(() => {}); } });
