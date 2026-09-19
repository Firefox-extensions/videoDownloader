function sanitizeUrl(value) {
  if (!value) return null;
  try {
    return new URL(value, document.baseURI).href;
  } catch (error) {
    return value;
  }
}

function collectVideoSources() {
  const seen = new Set();
  const results = [];

  const addUrl = (sourceUrl, label = 'video') => {
    const normalized = sanitizeUrl(sourceUrl);
    if (!normalized || seen.has(normalized)) return;

    seen.add(normalized);
    results.push({ title: label || 'Video', url: normalized, type: 'direct' });
  };

  document.querySelectorAll('video').forEach((video) => {
    if (video.src) addUrl(video.src, video.title || 'Video');
    if (video.currentSrc) addUrl(video.currentSrc, video.title || 'Video');
    video.querySelectorAll('source').forEach((source) => {
      if (source.src) addUrl(source.src, source.title || 'Video');
    });
  });

  document.querySelectorAll('source').forEach((source) => {
    if (source.src) addUrl(source.src, source.title || 'Video');
  });

  return results;
}

function updateActionState() {
  const count = collectVideoSources().length;
  browser.runtime.sendMessage({ type: 'videoCandidatesChanged', count }).catch(() => {});
}

let updateTimer;
function scheduleActionStateUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(updateActionState, 200);
}

updateActionState();
new MutationObserver(scheduleActionStateUpdate).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src']
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'getVideos') {
    sendResponse({ videos: collectVideoSources() });
    return true;
  }
  return false;
});


const PANEL_ID = 'personal-video-downloader-panel';

function getDisplayName(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'video');
    return name || 'video';
  } catch (error) {
    return 'video';
  }
}

function closeVideoList() {
  document.getElementById(PANEL_ID)?.remove();
}

function showVideoList() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    existing.remove();
    return;
  }

  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '動画候補');
  panel.innerHTML = '<style>#personal-video-downloader-panel{position:fixed;top:16px;right:16px;z-index:2147483647;width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:12px;background:#111827;color:#f3f4f6;border:1px solid #374151;border-radius:8px;font:14px sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.35)}#personal-video-downloader-panel header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;font-size:18px;font-weight:600}#personal-video-downloader-panel button{border:1px solid #60a5fa;border-radius:6px;background:#1d4ed8;color:#fff;padding:8px 10px;cursor:pointer}#personal-video-downloader-panel .close{background:#1f2937;border-color:#4b5563}#personal-video-downloader-panel ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}#personal-video-downloader-panel li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px}#personal-video-downloader-panel .info{min-width:0;flex:1}#personal-video-downloader-panel .name{font-weight:600;overflow-wrap:anywhere}#personal-video-downloader-panel .meta{margin-top:4px;color:#cbd5e1;font-size:12px}</style><header><span>Video Downloader</span><button class="close" type="button">閉じる</button></header><div class="status">検出中...</div><ul></ul>';
  document.documentElement.appendChild(panel);
  panel.querySelector('.close').addEventListener('click', closeVideoList);

  const videos = collectVideoSources();
  const status = panel.querySelector('.status');
  const list = panel.querySelector('ul');
  if (!videos.length) {
    status.textContent = '動画候補はありません。';
    return;
  }

  status.textContent = `${videos.length} 件の動画候補を表示しています。`;
  videos.forEach((video, index) => {
    const item = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${index + 1}. ${getDisplayName(video.url)}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = video.type === 'hls' ? '形態: HLS' : '形態: 直リンク';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = video.type === 'hls' ? 'HLS 保存' : 'ダウンロード';
    save.addEventListener('click', async () => {
      const type = video.type === 'hls' ? 'downloadHls' : 'downloadVideo';
      try {
        await browser.runtime.sendMessage({ type, url: video.url });
        status.textContent = 'ダウンロードを開始しました。';
      } catch (error) {
        status.textContent = 'ダウンロードの開始に失敗しました。';
      }
    });
    info.append(name, meta);
    item.append(info, save);
    list.appendChild(item);
  });
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'toggleVideoList') showVideoList();
});
