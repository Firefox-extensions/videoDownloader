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

function parseHlsBandwidth(url, text = '') {
  const match = text.match(/BANDWIDTH=(\d+)/i) || text.match(/(?:\b|_)(\d{4,7})(?=\s*(?:,|$))/i);
  if (!match) return null;
  const bandwidth = Number(match[1]);
  if (!Number.isFinite(bandwidth) || bandwidth <= 0) return null;
  const height = /RESOLUTION=(\d+)x(\d+)/i.exec(text)?.[2];
  if (height) return { bandwidth, height: Number(height) };
  return { bandwidth, height: null };
}

// URLやMIME情報から、候補がHLSプレイリストかどうかを判定する。
function isHlsUrl(url) {
  const lower = (url || '').toLowerCase();
  return lower.includes('.m3u8') || lower.includes('m3u8') || lower.includes('application/vnd.apple.mpegurl');
}

// video/source要素とページ内リンクから、直リンクとHLS候補を収集する。
// 画質切替ボタンやJS設定値も拾い、切り替え操作なしで全画質を出す。
function collectVideoSources() {
  const seen = new Set();
  const results = [];

  const addUrl = (sourceUrl, label = 'video', type = 'direct', qualityOverride = null) => {
    const normalized = sanitizeUrl(sourceUrl);
    if (!normalized || normalized.startsWith('blob:') || seen.has(normalized)) return;

    seen.add(normalized);
    results.push({
      title: label || 'Video',
      url: normalized,
      type,
      quality: qualityOverride || inferQualityLabel(normalized, label)
    });
  };

  document.querySelectorAll('video').forEach((video) => {
    const quality = inferQualityLabel(video.currentSrc || video.src || '', video.title || '', video);
    if (video.src) addUrl(video.src, video.title || 'Video', isHlsUrl(video.src) ? 'hls' : 'direct', quality);
    if (video.currentSrc) addUrl(video.currentSrc, video.title || 'Video', isHlsUrl(video.currentSrc) ? 'hls' : 'direct', quality);
    video.querySelectorAll('source').forEach((source) => {
      if (source.src) addUrl(source.src, source.title || 'Video', isHlsUrl(source.src) ? 'hls' : 'direct', inferQualityLabel(source.src, source.title || '', video));
      if (source.srcset) collectSrcsetUrls(source.srcset, source.title || 'Video', addUrl);
    });
  });

  document.querySelectorAll('source').forEach((source) => {
    if (source.src) addUrl(source.src, source.title || 'Video', isHlsUrl(source.src) ? 'hls' : 'direct', inferQualityLabel(source.src, source.title || ''));
    if (source.srcset) collectSrcsetUrls(source.srcset, source.title || 'Video', addUrl);
  });
  // data-srcなどの遅延読み込み属性や画質切替ボタンの属性からURLを収集する。
  collectLazyAndQualityAttributes(addUrl);

  // ページ内のJSON設定から画質別URLを収集する。
  collectEmbeddedPlayerUrls(addUrl);


  Array.from(document.querySelectorAll('a, script')).forEach((element) => {
    const value = element.src || element.href || '';
    if (!isHlsUrl(value)) return;

    const quality = (() => {
      const text = element.textContent || element.innerHTML || '';
      const meta = parseHlsBandwidth(value, text);
      if (meta?.height) return `画質: ${meta.height}p`;
      if (meta?.bandwidth) return `画質: ${Math.round(meta.bandwidth / 1000)}kbps`;
      return inferQualityLabel(value, 'HLS Playlist');
    })();

    addUrl(value, 'HLS Playlist', 'hls', quality);
  });

  return results;

// data-srcなどの遅延読み込み属性や画質切替ボタンの属性からURLを収集する。
function collectLazyAndQualityAttributes(addUrl) {
  const urlAttributes = [
    'data-src', 'data-source', 'data-video', 'data-video-url', 'data-video-src',
    'data-url', 'data-file', 'data-media', 'data-stream', 'data-playlist'
  ];

  const targets = document.querySelectorAll('video, source, a, button, [data-src], [data-video-url], [data-video-src]');
  targets.forEach((element) => {
    for (const name of urlAttributes) {
      const value = element.getAttribute && element.getAttribute(name);
      if (value) collectUrlsFromText(value, element.textContent || 'Video', addUrl);
    }

    if (/^(BUTTON|A|LI|OPTION)$/.test(element.tagName || '')) {
      for (const attribute of element.attributes || []) {
        if (/^(src|href|data-)/i.test(attribute.name) && looksLikeMediaUrl(attribute.value)) {
          collectUrlsFromText(attribute.value, element.textContent || 'Video', addUrl);
        }
      }
    }
  });
}

// ページ内スクリプトのJSON設定から画質別URLを収集する。
function collectEmbeddedPlayerUrls(addUrl) {
  const texts = [];
  document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').forEach((script) => {
    if (script.textContent) texts.push(script.textContent);
  });
  document.querySelectorAll('script:not([src])').forEach((script) => {
    const text = script.textContent || '';
    if (text.length < 200000 && /(\.mp4|\.webm|\.m3u8|720p|1080p|sources)/i.test(text)) {
      texts.push(text);
    }
  });

  for (const text of texts) {
    try {
      collectUrlsFromJson(JSON.parse(text), addUrl);
    } catch (error) {
      // なにもしない
    }
    collectUrlsFromText(text, 'Video', addUrl);
  }
}

// JSON中のfile/src/urlなどから動画URLを取り出す。
function collectUrlsFromJson(node, addUrl, depth = 0) {
  if (!node || depth > 6) return;
  if (typeof node === 'string') {
    if (looksLikeMediaUrl(node)) collectUrlsFromText(node, 'Video', addUrl);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectUrlsFromJson(item, addUrl, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && /^(file|src|source|url|contentUrl|videoUrl)$/i.test(key)) {
        if (looksLikeMediaUrl(value)) collectUrlsFromText(value, 'Video', addUrl);
      } else {
        collectUrlsFromJson(value, addUrl, depth + 1);
      }
      if (value && typeof value === 'object' && typeof value.file === 'string' && looksLikeMediaUrl(value.file)) {
        const quality = value.label || value.quality || '';
        collectUrlsFromText(value.file, String(quality || 'Video'), addUrl);
      }
    }
  }
}

// テキスト断片からhttp(s)動画URLを抜き出す。
function collectUrlsFromText(text, label, addUrl) {
  if (!text) return;
  const matches = String(text).match(/https?:\/\/[^\s"'<>]+\.(?:mp4|webm|m4v|mov|m3u8)(?:[?#][^\s"'<>]*)?/gi) || [];
  for (const match of matches) {
    const cleaned = match.replace(/\\\//g, '/');
    addUrl(cleaned, label, isHlsUrl(cleaned) ? 'hls' : 'direct');
  }
}

// background.jsで観測したネットワーク由来の候補も取り込む。
// content.jsだけでは見えない画質別URL(自動再生で読み込まれた分など)を補う。
async function getObservedVideos() {
  try {
    const response = await browser.runtime.sendMessage({ type: 'getObservedVideos' });
    const videos = response?.videos;
    const hlsVideos = response?.hlsVideos;
    const merged = [];
    if (Array.isArray(videos)) merged.push(...videos.map((url) => ({ url, type: 'direct' })));
    if (Array.isArray(hlsVideos)) merged.push(...hlsVideos.map((url) => ({ url, type: 'hls' })));
    return merged;
  } catch (error) {
    return [];
  }
}

async function collectAllVideoSources() {
  const domVideos = collectVideoSources();
  const seen = new Set(domVideos.map((video) => video.url));
  const observed = await getObservedVideos();

  for (const item of observed) {
    const normalized = sanitizeUrl(item.url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    domVideos.push({
      title: 'Video',
      url: normalized,
      type: item.type || (isHlsUrl(normalized) ? 'hls' : 'direct'),
      quality: inferQualityLabel(normalized, '')
    });
  }

  return domVideos;
}


// srcset形式から動画URLを取り出す。
function collectSrcsetUrls(srcset, label, addUrl) {
  for (const part of String(srcset).split(',')) {
    const token = part.trim().split(/\s+/)[0];
    if (token) addUrl(token, label, isHlsUrl(token) ? 'hls' : 'direct');
  }
}

// 拡張子付きでなくても動画URLらしいかを判定する。
function looksLikeMediaUrl(value) {
  if (!value || typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized || /^(blob:|data:|javascript:|#)/i.test(normalized)) return false;
  if (/\.(mp4|webm|m4v|mov|m3u8)(?:[?#]|$)/i.test(normalized)) return true;
  return /(video|movie|media|stream|m3u8|720p|1080p|480p|360p)/i.test(normalized) && /^https?:\/\//i.test(normalized);
}

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
// DOM候補と観測候補の合算で判定する。
function updateActionState() {
  collectAllVideoSources().then((videos) => {
    browser.runtime.sendMessage({ type: 'videoCandidatesChanged', count: videos.length }).catch(() => {});
  }).catch(() => {});
}

}

// 候補数をbackground.jsへ通知し、拡張機能アイコンの状態を更新する。
function updateActionStateOldUnused2b() {
// 候補数をbackground.jsへ通知し、拡張機能アイコンの状態を更新する。
// DOM候補と観測候補の合算で判定する。
function updateActionStateNewUnused2b() {
  collectAllVideoSources().then((videos) => {
    browser.runtime.sendMessage({ type: 'videoCandidatesChanged', count: videos.length }).catch(() => {});
  }).catch(() => {});
}

  const count = collectVideoSources().length;
  browser.runtime.sendMessage({ type: 'videoCandidatesChanged', count }).catch(() => {});
}

let updateTimer;
function scheduleActionStateUpdateUnused() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(updateActionState, 200);
}

updateActionState();
new MutationObserver(scheduleActionStateUpdate).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'href']
});

// background.jsからの動画一覧要求に応答する。観測候補も含めて返す。
browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'getVideos') {
    return collectAllVideoSources().then((videos) => ({ videos }));
  }
  return undefined;
});


const PANEL_ID = 'personal-video-downloader-panel';

// サイズ取得はbackground.jsへ依頼し、ページ側のCORS制限を避ける。
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
      <span>Video Downloader -HLS-</span>
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
