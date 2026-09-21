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

// 設定画面(options)で変更できる一覧フィルタ。値は storage.local に保存される。
const FILTER_SETTINGS_KEY = 'videoDownloaderSettings';

// 設定画面の初期値と同じ内容に保つこと(options/options.js の DEFAULTS)。
const FILTER_DEFAULTS = {
  minSizeValue: 1,
  minSizeUnit: 'MB',
  unknownSizePolicy: 'mediaOnly',
  mediaExtensions: 'mp4, webm, m4v, mov, m3u8, mpd, ts, m4s, mp3, m4a, aac, ogg, wav',
  excludeExtensions: 'js, mjs, css, html, htm, json, txt, xml, png, jpg, jpeg, gif, webp, svg, ico, woff, woff2, ttf, map, zip',
  excludeUrlKeywords: '',
  // サイズ取得の最終手段: off(ダウンロードしない) / download / full
  sizeProbeMode: 'off',
  // 一覧にサイズの取得方法を表示する
  showSizeSource: false
};

// サイズの取得方法の表示名。どの手段で取得したかを一覧で確認できる。
const SIZE_SOURCE_LABELS = {
  page: 'ページ記載',
  blob: 'メモリ内',
  performance: '受信済み',
  downloads: '保存履歴',
  captured: '通信ヘッダー',
  cache: '一時保存',
  stored: '保存済み',
  head: 'HEAD',
  range: 'Range',
  probe: '確認ダウンロード',
  unknown: ''
};

let currentFilterSettings = { ...FILTER_DEFAULTS };

// 保存済みの設定を読み込む。取得できない場合は初期値を使う。
async function loadFilterSettings() {
  try {
    const stored = await browser.storage.local.get(FILTER_SETTINGS_KEY);
    return { ...FILTER_DEFAULTS, ...(stored?.[FILTER_SETTINGS_KEY] || {}) };
  } catch (error) {
    return { ...FILTER_DEFAULTS };
  }
}

// 設定を読み直し、同期的な検出処理から参照する変数へ反映する。
function refreshFilterSettings() {
  return loadFilterSettings().then((settings) => {
    currentFilterSettings = settings;
    return settings;
  }).catch(() => currentFilterSettings);
}

// 「1MB」のような設定値をバイト数へ換算する。0のときはサイズで絞り込まない。
function minSizeBytesOf(settings) {
  const units = { B: 1, KB: 1024, MB: 1024 ** 2 };
  const unit = units[String(settings.minSizeUnit || 'MB').toUpperCase()] || 1;
  const value = Number(settings.minSizeValue);
  return Number.isFinite(value) && value > 0 ? value * unit : 0;
}

// カンマ区切りの拡張子一覧を、正規表現で使える形へ変換する。
function extensionsToPattern(extensions) {
  return String(extensions || '')
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

// 一覧へ載せる候補かどうかを判定する。.js や画像などは候補にしない。
function isCandidateMediaUrl(url, settings = currentFilterSettings) {
  const value = String(url || '');
  if (!value) return false;

  const excludePattern = extensionsToPattern(settings.excludeExtensions);
  if (excludePattern && new RegExp(`\\.(?:${excludePattern})(?:$|[?#])`, 'i').test(value)) return false;

  const keywords = String(settings.excludeUrlKeywords || '')
    .split(',')
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
  if (keywords.some((keyword) => value.toLowerCase().includes(keyword))) return false;

  const mediaPattern = extensionsToPattern(settings.mediaExtensions);
  if (mediaPattern && new RegExp(`\\.(?:${mediaPattern})(?:$|[?#])`, 'i').test(value)) return true;

  // 拡張子を持たないストリームURLは、動画らしい語を含む場合だけ候補にする。
  return /(video|movie|media|stream|playlist|m3u8|720p|1080p|480p|360p)/i.test(value) && /^https?:\/\//i.test(value);
}

refreshFilterSettings();

// video/source要素から動画URLを集め、同じURLは一度だけ候補にする。
// 画質切替ボタンやJS設定値も拾い、切り替え操作なしで全画質を出す。
function collectVideoSources() {
  const seen = new Set();
  const results = [];

  const addUrl = (sourceUrl, label = 'video', qualityOverride = null) => {
    const normalized = sanitizeUrl(sourceUrl);
    if (!normalized || normalized.startsWith('blob:') || seen.has(normalized)) return;
    // .js や画像など、動画以外のURLは候補にしない。
    if (!isCandidateMediaUrl(normalized)) return;

    seen.add(normalized);
    results.push({
      title: label || 'Video',
      url: normalized,
      type: 'direct',
      quality: qualityOverride || inferQualityLabel(normalized, label)
    });
  };

  // video要素のsrc/currentSrc/source子要素から収集する。
  document.querySelectorAll('video').forEach((video) => {
    const quality = inferQualityLabel(video.currentSrc || video.src || '', video.title || '', video);
    if (video.src) addUrl(video.src, video.title || 'Video', quality);
    if (video.currentSrc) addUrl(video.currentSrc, video.title || 'Video', quality);
    video.querySelectorAll('source').forEach((source) => {
      if (source.src) addUrl(source.src, source.title || 'Video', inferQualityLabel(source.src, source.title || '', video));
      if (source.srcset) collectSrcsetUrls(source.srcset, source.title || 'Video', addUrl);
    });
  });

  document.querySelectorAll('source').forEach((source) => {
    if (source.src) addUrl(source.src, source.title || 'Video', inferQualityLabel(source.src, source.title || ''));
    if (source.srcset) collectSrcsetUrls(source.srcset, source.title || 'Video', addUrl);
  });

  // data-srcなどの遅延読み込み属性や、画質切替ボタンが持つURLを収集する。
  collectLazyAndQualityAttributes(addUrl);

  // ページ内のJSON設定から画質別URLを収集する。
  collectEmbeddedPlayerUrls(addUrl);

  return results;
}

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

    // 画質切替ボタン自体がURLを持つ場合に備え、data-*属性を広く調べる。
    if (/^(BUTTON|A|LI|OPTION)$/.test(element.tagName || '')) {
      for (const attribute of element.attributes || []) {
        if (/^(src|href|data-)/i.test(attribute.name) && looksLikeMediaUrl(attribute.value)) {
          collectUrlsFromText(attribute.value, element.textContent || 'Video', addUrl);
        }
      }
    }
  });
}

// srcset形式(カンマ区切りのURL群)から動画URLを取り出す。
function collectSrcsetUrls(srcset, label, addUrl) {
  for (const part of String(srcset).split(',')) {
    const token = part.trim().split(/\s+/)[0];
    if (token) addUrl(token, label);
  }
}

// ページ内スクリプトのJSON設定から画質別URLを収集する。
function collectEmbeddedPlayerUrls(addUrl) {
  const texts = [];
  document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').forEach((script) => {
    if (script.textContent) texts.push(script.textContent);
  });
  document.querySelectorAll('script:not([src])').forEach((script) => {
    const text = script.textContent || '';
    if (text.length < 200000 && /(\.mp4|\.webm|720p|1080p|sources?\s*:|videoUrl)/i.test(text)) {
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
  const matches = String(text).match(/https?:\/\/[^\s"'<>]+\.(?:mp4|webm|m4v|mov)(?:[?#][^\s"'<>]*)?/gi) || [];
  for (const match of matches) {
    addUrl(match.replace(/\\\//g, '/'), label);
  }
}

// 拡張子付きでなくても動画URLらしいかを判定する。
function looksLikeMediaUrl(value) {
  if (!value || typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized || /^(blob:|data:|javascript:|#)/i.test(normalized)) return false;
  if (/\.(mp4|webm|m4v|mov)(?:[?#]|$)/i.test(normalized)) return true;
  return /(video|movie|media|stream|720p|1080p|480p|360p)/i.test(normalized) && /^https?:\/\//i.test(normalized);
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

// background.jsで観測したネットワーク由来の候補も取り込む。
// content.jsだけでは見えない画質別URL(自動再生で読み込まれた分など)を補う。
async function getObservedVideos() {
  try {
    const response = await browser.runtime.sendMessage({ type: 'getObservedVideos' });
    const videos = response?.videos;
    return Array.isArray(videos) ? videos : [];
  } catch (error) {
    return [];
  }
}

async function collectAllVideoSources() {
  const domVideos = collectVideoSources();
  const seen = new Set(domVideos.map((video) => video.url));
  const observedUrls = await getObservedVideos();

  for (const url of observedUrls) {
    const normalized = sanitizeUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    // 観測した候補にも一覧と同じ絞り込みを適用する。
    if (!isCandidateMediaUrl(normalized)) continue;
    seen.add(normalized);
    domVideos.push({
      title: 'Video',
      url: normalized,
      type: 'direct',
      quality: inferQualityLabel(normalized, '')
    });
  }

  return domVideos;
}

// 候補数をbackground.jsへ通知し、拡張機能アイコンの状態を更新する。
function updateActionState() {
  collectAllVideoSources().then((videos) => {
    browser.runtime.sendMessage({ type: 'videoCandidatesChanged', count: videos.length }).catch(() => {});
  }).catch(() => {});
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

// background.jsからの動画一覧要求に応答する。観測候補も含めて返す。
browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'getVideos') {
    return collectAllVideoSources().then((videos) => ({ videos }));
  }
  return undefined;
});


const PANEL_ID = 'personal-video-downloader-panel';

// ページが既に受信したリソースのサイズをPerformance APIから取得する。
// 追加の通信を行わずにサイズが分かるため、最優先で使う。
function pickPerformanceSize(url) {
  try {
    const target = sanitizeUrl(url) || url;
    const withoutHash = target.split('#')[0];
    let best = 0;
    for (const entry of performance.getEntriesByType('resource')) {
      const name = entry.name.split('#')[0];
      if (name !== withoutHash && name !== target) continue;
      const size = entry.encodedBodySize || entry.decodedBodySize || entry.transferSize || 0;
      if (Number.isFinite(size) && size > best) best = size;
    }
    return best;
  } catch (error) {
    return 0;
  }
}

// サイズ取得はbackground.jsへ依頼する。ページ側fetchはCORSの影響を受けやすいため使わない。
// 取得できたサイズと取得方法を返す。
async function getDisplaySize(url, knownSize = '') {
  if (knownSize) {
    const bytes = Number(knownSize);
    return {
      text: Number.isFinite(bytes) && bytes > 0 ? formatDisplayBytes(bytes) : knownSize,
      source: 'page'
    };
  }
  if (url.startsWith('blob:')) {
    try {
      const blobResponse = await fetch(url);
      const blob = await blobResponse.blob();
      return { text: formatDisplayBytes(blob.size), source: 'blob' };
    } catch (error) {
      return { text: '不明', source: 'unknown' };
    }
  }

  try {
    const response = await browser.runtime.sendMessage({
      type: 'getVideoSize',
      url,
      pageUrl: window.location.href,
      performanceSize: pickPerformanceSize(url)
    });
    return { text: response?.size || '不明', source: response?.sizeSource || 'unknown' };
  } catch (error) {
    return { text: '不明', source: 'unknown' };
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
  // 設定画面の変更を反映するため、一覧を開くたびに設定を読み直す。
  const settings = await refreshFilterSettings();
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
      #personal-video-downloader-panel .header-actions{display:flex;gap:8px}
      #personal-video-downloader-panel .settings{background:#1f2937;border-color:#4b5563;padding:4px 8px;font-size:12px;line-height:1.2}
      #personal-video-downloader-panel ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
      #personal-video-downloader-panel li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px}
      #personal-video-downloader-panel .info{min-width:0;flex:1}
      #personal-video-downloader-panel .name{font-weight:600;overflow-wrap:anywhere}
      #personal-video-downloader-panel .meta{margin-top:4px;color:#cbd5e1;font-size:12px}
    </style>
    <header>
      <span>Video Downloader</span>
      <div class="header-actions">
        <button class="settings" type="button">設定</button>
        <button class="close" type="button">閉じる</button>
      </div>
    </header>
    <div class="status">検出中...</div>
    <ul></ul>
  `;
  const candidates = (await collectAllVideoSources())
    .map(async (video) => {
      const display = await getDisplaySize(video.url, findPageSize(video.url));
      return { video, sizeText: display.text, sizeSource: display.source };
    });
  const sizedVideos = await Promise.all(candidates);
  const minSizeBytes = minSizeBytesOf(settings);
  const videos = sizedVideos
    .filter(({ sizeText, video }) => {
      const size = parseDisplaySize(sizeText);
      if (size === null) {
        // サイズ不明の候補は設定に従う。mediaOnly のときは動画らしいURLだけ残す。
        return settings.unknownSizePolicy !== 'hide' && isCandidateMediaUrl(video.url, settings);
      }
      // 設定したサイズ以下の動画は一覧に出さない。
      return minSizeBytes <= 0 || size > minSizeBytes;
    })
    .map(({ video, sizeText, sizeSource }) => ({ ...video, sizeText, sizeSource }))
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
  panel.querySelector('.settings').addEventListener('click', (event) => {
    event.stopPropagation();
    // 設定画面は background.js 経由で開く。content script からは直接開けないため。
    browser.runtime.sendMessage({ type: 'openSettings' }).catch(() => {});
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
    // 設定で有効なときだけ、サイズの取得方法を併記する。
    const sizeSourceLabel = settings.showSizeSource ? SIZE_SOURCE_LABELS[video.sizeSource] || '' : '';
    meta.textContent = `${video.type === 'hls' ? 'HLS' : '直接再生'} / 画質: ${qualityText} / サイズ: ${sizeText}${sizeSourceLabel ? `（${sizeSourceLabel}）` : ''}`;

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
