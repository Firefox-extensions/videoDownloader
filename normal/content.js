function sanitizeUrl(value) {
  if (!value) return null;
  try {
    return new URL(value, document.baseURI).href;
  } catch (error) {
    return value;
  }
}

function inferQualityLabel(url, title = '', element = null) {
  if (element && element.videoHeight && element.videoWidth) {
    const height = Number(element.videoHeight);
    if (Number.isFinite(height) && height > 0) return `画質: ${height}p`;
  }

  const candidate = [url, title].join(' ');
  const patterns = [
    /(\d{3,4})p/i,
    /(\d{3,4})x(\d{3,4})/i,
    /(?:quality|q|resolution|res|height|h)=([0-9]{3,4})/i,
    /([0-9]{3,4})\s*fps/i
  ];

  for (const pattern of patterns) {
    const match = candidate.match(pattern);
    if (!match) continue;
    const value = match[1] || match[2] || match[0];
    if (Number(value) >= 240 && Number(value) <= 4320) {
      return `画質: ${Number(value)}p`;
    }
  }

  return '画質: 不明';
}

// video/source要素から動画URLを集め、同じURLは一度だけ候補にする。
function collectVideoSources() {
  const seen = new Set();
  const results = [];

  const addUrl = (sourceUrl, label = 'video', qualityOverride = null) => {
    const normalized = sanitizeUrl(sourceUrl);
    if (!normalized || seen.has(normalized)) return;

    seen.add(normalized);
    results.push({
      title: label || 'Video',
      url: normalized,
      type: 'direct',
      quality: qualityOverride || inferQualityLabel(normalized, label)
    });
  };

  document.querySelectorAll('video').forEach((video) => {
    const quality = inferQualityLabel(video.currentSrc || video.src || '', video.title || '', video);
    if (video.src) addUrl(video.src, video.title || 'Video', quality);
    if (video.currentSrc) addUrl(video.currentSrc, video.title || 'Video', quality);
    video.querySelectorAll('source').forEach((source) => {
      if (source.src) addUrl(source.src, source.title || 'Video', inferQualityLabel(source.src, source.title || '', video));
    });
  });

  document.querySelectorAll('source').forEach((source) => {
    if (source.src) addUrl(source.src, source.title || 'Video', inferQualityLabel(source.src, source.title || ''));
  });

  return results;
}

function findPageSize(url) {
  const elements = [...document.querySelectorAll('video, source, a')];
  const sizeAttributes = ['data-size', 'data-filesize', 'data-file-size', 'filesize', 'size'];
  for (const element of elements) {
    const elementUrl = element.currentSrc || element.src || element.href || '';
    if (elementUrl !== url) continue;
    for (const attribute of sizeAttributes) {
      const value = element.getAttribute(attribute);
      if (value) return value;
    }
  }

  const metadata = [...document.querySelectorAll('meta')];
  for (const element of metadata) {
    const name = `${element.getAttribute('name') || ''} ${element.getAttribute('property') || ''}`;
    if (/size|filesize|content-length/i.test(name) && element.content) return element.content;
  }
  return '';
}

// 候補数をbackground.jsへ通知し、拡張機能アイコンの状態を更新する。
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

// background.jsからの動画一覧要求に応答する。同期で返せるためPromiseで包んで返す。
browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'getVideos') {
    return Promise.resolve({ videos: collectVideoSources() });
  }
  return undefined;
});


const PANEL_ID = 'personal-video-downloader-panel';

// サイズ取得はbackground.jsへ依頼する。ページ側fetchはCORSの影響を受けやすいため使わない。
async function getDisplaySize(url, knownSize = '') {
  if (knownSize) {
    const bytes = Number(knownSize);
    return Number.isFinite(bytes) && bytes > 0 ? formatDisplayBytes(bytes) : knownSize;
  }
  if (url.startsWith('blob:')) {
    try {
      const blobResponse = await fetch(url);
      const blob = await blobResponse.blob();
      return formatDisplayBytes(blob.size);
    } catch (error) {
      return '不明';
    }
  }

  try {
    const response = await browser.runtime.sendMessage({
      type: 'getVideoSize',
      url,
      pageUrl: window.location.href
    });
    return response?.size || '不明';
  } catch (error) {
    return '不明';
  }
}

function formatDisplayBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 0 : 1)} ${units[index]}`;
}

// URLの末尾を一覧上の表示名として使う。
function getDisplayName(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'video');
    return name || 'video';
  } catch (error) {
    return 'video';
  }
}

function parseDisplaySize(value) {
  const match = String(value || '').match(/^([\d.]+)\s*(B|KB|MB|GB)$/i);
  if (!match) return null;

  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  return Number(match[1]) * units[match[2].toUpperCase()];
}

// CORSなどの技術的なエラーを、一覧上で読めるメッセージへ整える。
function formatDownloadErrorMessage(message, url) {
  const safeMessage = message || '不明なエラー';

  try {
    const parsedUrl = new URL(url);
    const isCrossOrigin = parsedUrl.origin !== window.location.origin;
    const isCorsProblem = /CORS|Access-Control-Allow-Origin|Failed to fetch|NetworkError|cross-origin/i.test(safeMessage);

    if (isCrossOrigin && isCorsProblem) {
      return '保存できませんでした。動画の配信元が別ドメインで、CORS を許可していないため Firefox が読み込みを拒否しています。';
    }

  } catch (error) {
    // なにもしない
  }

  return `ダウンロードに失敗しました: ${safeMessage}`;
}

// 動画一覧パネルを削除し、外側クリックの監視も解除する。
function closeVideoList() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  panel.remove();
  document.removeEventListener('click', handleOutsideClick, true);
}

// パネルの外側をクリックしたときに一覧を閉じる。
function handleOutsideClick(event) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  if (!panel.contains(event.target)) {
    closeVideoList();
  }
}

// 動画候補をパネルへ描画し、保存・デバッグ・閉じる操作を登録する。
async function showVideoList() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    existing.remove();
    document.removeEventListener('click', handleOutsideClick, true);
    return;
  }

  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '動画候補リスト');
  panel.innerHTML = `
    <style>
      #personal-video-downloader-panel{position:fixed;top:16px;right:16px;z-index:2147483647;width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:12px;background:#111827;color:#f3f4f6;border:1px solid #374151;border-radius:8px;font:14px sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.35)}
      #personal-video-downloader-panel header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;font-size:18px;font-weight:600}
      #personal-video-downloader-panel button{border:1px solid #60a5fa;border-radius:6px;background:#1d4ed8;color:#fff;padding:8px 10px;cursor:pointer}
      #personal-video-downloader-panel .close{background:#1f2937;border-color:#4b5563;padding:4px 8px;font-size:12px;line-height:1.2}
      #personal-video-downloader-panel ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
      #personal-video-downloader-panel li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px}
      #personal-video-downloader-panel .info{min-width:0;flex:1}
      #personal-video-downloader-panel .name{font-weight:600;overflow-wrap:anywhere}
      #personal-video-downloader-panel .meta{margin-top:4px;color:#cbd5e1;font-size:12px}
    </style>
    <header>
      <span>Video Downloader</span>
      <button class="close" type="button">閉じる</button>
    </header>
    <div class="status">検出中...</div>
    <ul></ul>
  `;
  const candidates = collectVideoSources()
    .map(async (video) => ({ video, sizeText: await getDisplaySize(video.url, findPageSize(video.url)) }));
  const sizedVideos = await Promise.all(candidates);
  const videos = sizedVideos
    .filter(({ sizeText }) => {
      const size = parseDisplaySize(sizeText);
      return size === null || size > 100 * 1024;
    })
    .map(({ video, sizeText }) => ({ ...video, sizeText }))
    .sort((a, b) => {
      const qualityA = parseInt((a.quality || '画質: 不明').match(/(\d{3,4})p/i)?.[1] || '0', 10);
      const qualityB = parseInt((b.quality || '画質: 不明').match(/(\d{3,4})p/i)?.[1] || '0', 10);
      if (qualityA !== qualityB) return qualityB - qualityA;
      return (b.url || '').length - (a.url || '').length;
    });
  document.documentElement.appendChild(panel);
  document.addEventListener('click', handleOutsideClick, true);
  panel.querySelector('.close').addEventListener('click', (event) => {
    event.stopPropagation();
    closeVideoList();
  });
  const status = panel.querySelector('.status');
  const list = panel.querySelector('ul');

  if (!videos.length) {
    status.textContent = '動画候補はありません。';
    return;
  }

  status.textContent = `${videos.length} 件の動画候補を表示しています。`;

  for (const [index, video] of videos.entries()) {
    const item = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${index + 1}. ${getDisplayName(video.url)}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const qualityText = video.quality && video.quality !== '画質: 不明' ? video.quality.replace(/^画質:\s*/, '') : '不明';
    const sizeText = video.sizeText;
    meta.textContent = `${video.type === 'hls' ? 'HLS' : '直接再生'} / 画質: ${qualityText} / サイズ: ${sizeText}`;

    // 保存ボタンを押した時点で一覧を閉じ、保存処理をバックグラウンドへ渡す。
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = video.type === 'hls' ? 'HLS 保存' : 'ダウンロード';
    save.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeVideoList();
      const type = video.type === 'hls' ? 'downloadHls' : 'downloadVideo';
      try {
        const response = await browser.runtime.sendMessage({ type, url: video.url });
        if (!response || response.ok === false) {
          throw new Error(response?.error || 'Download failed.');
        }
        status.textContent = 'ダウンロードを開始しました。';
        closeVideoList();
      } catch (error) {
        const message = error && error.message ? error.message : '不明なエラー';
        status.textContent = formatDownloadErrorMessage(message, video.url);
      }
    });

    info.append(name, meta);
    item.append(info, save);
    list.appendChild(item);
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'toggleVideoList') {
    showVideoList().catch((error) => console.error(error));
  }
});
