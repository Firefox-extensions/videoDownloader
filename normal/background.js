const ACTIVE_ICON = 'icons/video-active.svg';
const DISABLED_ICON = 'icons/video-disabled.svg';

// ファイル名に使えない文字を除去し、Firefoxで保存できる名前に整える。
function sanitizeFileName(value) {
  return (value || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Firefoxが返す英語の失敗理由を、利用者が理解しやすい日本語に変換する。
function buildDownloadFailureError(url, tabUrl, error) {
  const fallback = error && error.message ? error.message : 'Download failed.';

  try {
    const target = new URL(url);
    const page = tabUrl ? new URL(tabUrl) : null;
    if (page && target.origin !== page.origin) {
      if (/CORS|Access-Control-Allow-Origin|Failed to fetch|NetworkError|cross-origin/i.test(fallback)) {
        return 'この動画は別ドメイン配信で、CORS または配信元のアクセス制限により取得できませんでした。';
      }
    }
  } catch (parseError) {
    // なにもしない
  }

  return fallback;
}

// ページタイトルを優先し、URLから拡張子を補って保存ファイル名を作る。
async function getDefaultFileName(url, fallbackExtension = 'mp4', titleOverride = '') {
  const pageTitle = sanitizeFileName(titleOverride || (await browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]?.title || '')));
  const urlExtMatch = (() => {
    try {
      const parsed = new URL(url);
      return parsed.pathname.match(/\.([A-Za-z0-9]+)$/)?.[1] || '';
    } catch (error) {
      return '';
    }
  })();

  const extension = urlExtMatch || fallbackExtension;

  if (pageTitle) {
    return `${pageTitle}.${extension}`;
  }

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const last = segments[segments.length - 1];
    return last && last.includes('.') ? last : `downloaded-video.${extension}`;
  } catch (error) {
    return `downloaded-video.${extension}`;
  }
}

// 動画候補の有無に応じて、ツールバーのアイコンとボタンを有効・無効にする。
function setActionAvailability(tabId, hasCandidates) {
  const action = browser.action;
  action.setIcon({ tabId, path: hasCandidates ? ACTIVE_ICON : DISABLED_ICON });
  action.setTitle({ tabId, title: hasCandidates ? 'Video Downloader' : '動画候補はありません' });
  return hasCandidates ? action.enable(tabId) : action.disable(tabId);
}

// バイト数をB、KB、MB、GBの表示へ変換する。
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return unitIndex === 0
    ? `${Math.round(value)} ${units[unitIndex]}`
    : `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

const mediaSizes = new Map();
const capturedMedia = new Map();
const mediaCandidates = new Map();
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const pendingReferers = new Map();

// 直接保存の対象にする動画ファイルURLを判定する。
function isDirectMediaUrl(url) {
  return /\.(mp4|webm|m4v|mov)(?:$|[?#])/i.test(url);
}

// 拡張子がなくても動画の可能性があるURLを拾う。
function isLikelyMediaUrl(url) {
  if (!url || /^(blob:|data:|javascript:|about:)/i.test(url)) return false;
  if (isDirectMediaUrl(url)) return true;
  try {
    const parsed = new URL(url);
    const target = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return /(video|movie|media|mp4|webm|m4v|mov|stream|download|play)/.test(target)
      || /\/(240|360|480|720|1080|2160)p?([/?_.-]|$)/.test(target);
  } catch (error) {
    return false;
  }
}

// ネットワークで観測した動画URLをタブごとの候補として残す。
// 画質切替ボタン型のページではDOMに1件しかURLが出ないため、
// 切り替え操作なしで全画質を一覧に出す目的で使う。
function rememberMediaCandidate(url, tabId, statusCode = 200) {
  if (tabId === undefined || tabId < 0) return;
  if (!isLikelyMediaUrl(url)) return;
  if (statusCode !== 200 && statusCode !== 206) return;

  let candidates = mediaCandidates.get(tabId);
  if (!candidates) {
    candidates = new Map();
    mediaCandidates.set(tabId, candidates);
  }
  const key = url.split('#')[0];
  const existing = candidates.get(key);
  if (existing) {
    existing.timestamp = Date.now();
    return;
  }
  candidates.set(key, { url: key, timestamp: Date.now() });

  // 古い候補が残り続けないよう、件数を制限する。
  if (candidates.size > 50) {
    const oldest = [...candidates.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) candidates.delete(oldest[0]);
  }
}

// 配信元がページのRefererを要求する場合に、元ページURLをリクエストへ戻す。
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const referrer = pendingReferers.get(details.url);
    if (!referrer) return {};

    const requestHeaders = details.requestHeaders || [];
    const existing = requestHeaders.find((header) => header.name.toLowerCase() === 'referer');
    if (existing) {
      existing.value = referrer;
    } else {
      requestHeaders.push({ name: 'Referer', value: referrer });
    }
    return { requestHeaders };
  },
  { urls: ['<all_urls>'] },
  ['blocking', 'requestHeaders']
);

function getHeaderValue(headers, name) {
  return (headers || []).find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

// Content-LengthまたはContent-Rangeから、配信元が示した総サイズを取得する。
function getSizeFromHeaders(headers) {
  const contentRange = getHeaderValue(headers, 'content-range');
  const rangeMatch = contentRange.match(/bytes\s+(?:\d+-\d+|\*)\/(\d+)/i);
  if (rangeMatch) return Number(rangeMatch[1]);

  const contentLength = Number(getHeaderValue(headers, 'content-length'));
  return Number.isFinite(contentLength) ? contentLength : 0;
}

function getTotalSizeFromRange(headers) {
  const contentRange = getHeaderValue(headers, 'content-range');
  const match = contentRange.match(/bytes\s+(?:\d+-\d+|\*)\/(\d+)/i);
  return match ? Number(match[1]) : 0;
}

async function countResponseBytes(response) {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength;
  }

  const reader = response.body.getReader();
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
  }
  return totalBytes;
}

// サイズの保存・参照に使うキー。URLの完全一致に加え、
// ハッシュやクエリが違うだけのURLでもヒットするよう候補を増やす。
function sizeKeyCandidates(url) {
  const keys = [url];
  try {
    const withoutHash = url.split('#')[0];
    keys.push(withoutHash);

    const parsed = new URL(withoutHash);
    if (parsed.search) {
      parsed.search = '';
      keys.push(parsed.href);
    }
  } catch (error) {
    // なにもしない
  }
  return [...new Set(keys)];
}

// Content-LengthまたはContent-Rangeから、配信元が示した総サイズを保存する。
function rememberMediaSize(url, headers, statusCode) {
  const size = getTotalSizeFromRange(headers) || (statusCode === 200 ? getSizeFromHeaders(headers) : 0);

  if (Number.isFinite(size) && size > 0) {
    for (const key of sizeKeyCandidates(url)) {
      storeMediaSize(key, size);
    }
  }
}

function getCachedMediaSize(url) {
  for (const key of sizeKeyCandidates(url)) {
    const cached = mediaSizes.get(key);
    if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) return cached;
  }
  return null;
}

function sizeStorageKey(url) {
  return `media-size:${url}`;
}

async function getStoredMediaSize(url) {
  const keys = sizeKeyCandidates(url).map(sizeStorageKey);
  try {
    const stored = await browser.storage.local.get(keys);
    for (const key of keys) {
      const value = stored[key];
      if (value && Date.now() - value.timestamp < 30 * 24 * 60 * 60 * 1000) return value;
    }
  } catch (error) {
    // なにもしない
  }
  return null;
}

function storeMediaSize(url, size) {
  const value = { size, timestamp: Date.now() };
  mediaSizes.set(url, value);
  browser.storage.local.set({ [sizeStorageKey(url)]: value }).catch(() => {});
}

// 観測済み候補のうち直近のものを返す。タブIDがなければ空配列。
function getMediaCandidates(tabId) {
  if (tabId === undefined || tabId < 0) return [];
  const candidates = mediaCandidates.get(tabId);
  if (!candidates) return [];
  const now = Date.now();
  return [...candidates.values()]
    .filter((candidate) => now - candidate.timestamp < 30 * 60 * 1000)
    .map((candidate) => candidate.url);
}

async function rememberCompletedDownloadSize(downloadId, sourceUrl) {
  try {
    const items = await browser.downloads.search({ id: downloadId });
    const item = items[0];
    const size = item?.totalBytes > 0
      ? item.totalBytes
      : (item?.downloadedBytes > 0 ? item.downloadedBytes : 0);
    if (size > 0) {
      storeMediaSize(sourceUrl, size);
    }
  } catch (error) {
    // サイズの記録に失敗してもダウンロード自体は成功扱いにする
  }
}



// 実際の動画レスポンスを通過させながら、一定サイズ以下ならメモリにも保持する。
// これにより、サイズヘッダーがない配信でも受信済みサイズを利用できる。
// 同時にタブごとの候補URLも記録し、画質切替ボタン型のページでも一覧に出せるようにする。
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    rememberMediaSize(details.url, details.responseHeaders || [], details.statusCode);
    rememberMediaCandidate(details.url, details.tabId, details.statusCode);

    if (details.statusCode !== 200 || !isDirectMediaUrl(details.url)) return;

    let filter;
    try {
      filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (error) {
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let canStore = true;

    filter.ondata = (event) => {
      const chunk = event.data;
      totalBytes += chunk.byteLength;
      if (canStore && totalBytes <= MAX_CAPTURE_BYTES) {
        chunks.push(chunk.slice(0));
      } else {
        canStore = false;
      }
      filter.write(chunk);
    };

    filter.onstop = () => {
      if (canStore && totalBytes > 0) {
        capturedMedia.set(details.url, {
          chunks,
          size: totalBytes,
          timestamp: Date.now()
        });
        storeMediaSize(details.url, totalBytes);
      }
      filter.disconnect();
    };

    filter.onerror = () => filter.disconnect();
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// サイズ取得の最終手段の設定。設定画面の「サイズを取得するためのダウンロード」で変更する。
// 初期値は 'off'(ダウンロードを行わない)。
const SIZE_SETTINGS_KEY = 'videoDownloaderSettings';
const SIZE_PROBE_MODES = ['off', 'download', 'full'];
let sizeProbeMode = 'off';

async function refreshSizeProbeMode() {
  try {
    const stored = await browser.storage.local.get(SIZE_SETTINGS_KEY);
    const mode = stored?.[SIZE_SETTINGS_KEY]?.sizeProbeMode;
    sizeProbeMode = SIZE_PROBE_MODES.includes(mode) ? mode : 'off';
  } catch (error) {
    sizeProbeMode = 'off';
  }
  return sizeProbeMode;
}

function getSizeProbeMode() {
  return sizeProbeMode;
}

refreshSizeProbeMode();
// 設定画面で変更されたら、次回の取得から反映する。
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[SIZE_SETTINGS_KEY]) {
    refreshSizeProbeMode();
  }
});

// サイズ取得は追加通信の少ない順に試す。既定では本文のダウンロードを行わない。
// 取得方法は source として返し、一覧側で確認できるようにする。
async function getRemoteFileSize(url, pageUrl = '', performanceSize = 0) {
  if (pageUrl) pendingReferers.set(url, pageUrl);

  // ページが実際に受信したサイズ(Performance API)は追加通信なしで分かるため最優先で使う。
  if (performanceSize > 0) {
    storeMediaSize(url, performanceSize);
    return { text: formatBytes(performanceSize), bytes: performanceSize, source: 'performance' };
  }

  try {
    const downloads = await browser.downloads.search({ url });
    const completedDownloads = downloads.filter((item) => item.state === 'complete');
    // totalBytesが不明(-1)の場合でもdownloadedBytesがあれば使う
    const withKnownSize = completedDownloads.find((item) => item.totalBytes > 0)
      || completedDownloads.find((item) => item.downloadedBytes > 0);
    if (withKnownSize) {
      const size = withKnownSize.totalBytes > 0 ? withKnownSize.totalBytes : withKnownSize.downloadedBytes;
      storeMediaSize(url, size);
      return { text: formatBytes(size), bytes: size, source: 'downloads' };
    }
  } catch (error) {
    // ダウンロード履歴が取得できなくても、サイズ確認は続行する
  }

  const captured = capturedMedia.get(url);
  if (captured && Date.now() - captured.timestamp < 10 * 60 * 1000) {
    return { text: formatBytes(captured.size), bytes: captured.size, source: 'captured' };
  }

  const cached = getCachedMediaSize(url);
  if (cached) {
    return { text: formatBytes(cached.size), bytes: cached.size, source: 'cache' };
  }

  const stored = await getStoredMediaSize(url);
  if (stored) return { text: formatBytes(stored.size), bytes: stored.size, source: 'stored' };

  const headResult = await tryHeadSize(url, pageUrl);
  if (headResult > 0) {
    storeMediaSize(url, headResult);
    return { text: formatBytes(headResult), bytes: headResult, source: 'head' };
  }

  const rangeResult = await tryRangeSize(url, pageUrl);
  if (rangeResult > 0) {
    storeMediaSize(url, rangeResult);
    return { text: formatBytes(rangeResult), bytes: rangeResult, source: 'range' };
  }

  
  // ダウンロードによるサイズ推定は行わない（一時保存表示を防止するため）。
  return { text: '不明', bytes: 0, source: 'unknown' };
}

// HEADリクエストでContent-Lengthの取得を試す。CORSで読めなくても例外にせず0を返す。
async function tryHeadSize(url, pageUrl) {
  try {
    const headResponse = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      referrer: pageUrl || undefined,
      referrerPolicy: 'unsafe-url',
      cache: 'no-store'
    });
    return getSizeFromHeaders([...headResponse.headers].map(([name, value]) => ({ name, value })));
  } catch (error) {
    // HEAD 非対応の配信元では Range 取得へ進む
    return 0;
  }
}

// RangeリクエストでContent-Rangeから総サイズの取得を試す。
// 206応答でなく200応答が返った場合もContent-Lengthがあれば使う。
// 応答本文は読まずに破棄する。読み切ると本文のダウンロードになってしまうため。
async function tryRangeSize(url, pageUrl) {
  // 一部の配信元は bytes=0-0 を拒否するため、開いた範囲も順に試す。
  for (const rangeValue of ['bytes=0-0', 'bytes=0-']) {
    let rangeResponse = null;
    try {
      rangeResponse = await fetch(url, {
        headers: { Range: rangeValue },
        credentials: 'include',
        referrer: pageUrl || undefined,
        referrerPolicy: 'unsafe-url',
        cache: 'no-store'
      });
      const rangeHeaders = [...rangeResponse.headers].map(([name, value]) => ({ name, value }));
      const totalRangeSize = getTotalSizeFromRange(rangeHeaders);
      if (totalRangeSize > 0) {
        return totalRangeSize;
      }

      if (rangeResponse.status === 200) {
        return getSizeFromHeaders(rangeHeaders);
      }
    } catch (error) {
      // 次のRange指定や後続の手段へ進む
    } finally {
      // 本文を読むと実データのダウンロードが発生するため、必ず破棄する。
      try {
        if (rangeResponse && rangeResponse.body) {
          await rangeResponse.body.cancel();
        }
      } catch (error) {
        // なにもしない
      }
    }
  }

  return 0;
}

// ページ読み込み開始時は、前ページの動画候補を示さない。
// タブごとの観測候補も破棄し、別ページのURLが混ざらないようにする。
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    mediaCandidates.delete(tabId);
    setActionAvailability(tabId, false).catch(() => {});
  }
});

// タブを閉じたときに観測候補を破棄する。
browser.tabs.onRemoved.addListener((tabId) => {
  mediaCandidates.delete(tabId);
});

// content.jsからの候補数通知を受け、拡張機能ボタンの状態を更新する。
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'videoCandidatesChanged' || !sender.tab?.id) return;
  setActionAvailability(sender.tab.id, message.count > 0).catch(() => {});
});

// downloads APIは開始要求と完了通知が別のため、完了または中断まで待機する。
function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      browser.downloads.onChanged.removeListener(handleChange);
      reject(new Error('ダウンロードの完了を確認できませんでした。'));
    }, 120000);

    function finish(callback, value) {
      clearTimeout(timeoutId);
      browser.downloads.onChanged.removeListener(handleChange);
      callback(value);
    }

    function handleChange(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        finish(resolve);
      } else if (delta.state?.current === 'interrupted') {
        finish(reject, new Error(delta.error?.current || 'ダウンロードが中断されました。'));
      }
    }

    browser.downloads.onChanged.addListener(handleChange);
    browser.downloads.search({ id: downloadId }).then((items) => {
      const item = items[0];
      if (item?.state === 'complete') finish(resolve);
      if (item?.state === 'interrupted') finish(reject, new Error(item.error || 'ダウンロードが中断されました。'));
    }).catch(() => {});
  });
}

// URLまたはBlob URLをFirefoxのダウンロード機能へ渡す。
async function startDownload(url, fileName, saveAs = true, waitForCompletion = false, sourceUrl = url) {
  const downloadId = await browser.downloads.download({ url, filename: fileName, saveAs });
  if (waitForCompletion) {
    await waitForDownload(downloadId);
    await rememberCompletedDownloadSize(downloadId, sourceUrl);
  }
}

// まず直接URLを保存し、失敗した場合だけFetchしてBlob保存へ切り替える。
async function downloadDirectVideo(url, fileName, pageUrl) {
  if (pageUrl) pendingReferers.set(url, pageUrl);

  const captured = capturedMedia.get(url);
  if (captured && Date.now() - captured.timestamp < 10 * 60 * 1000) {
    storeMediaSize(url, captured.size);
    const objectUrl = URL.createObjectURL(new Blob(captured.chunks, { type: 'video/mp4' }));
    try {
      await startDownload(objectUrl, fileName, true, false, url);
      return;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  try {
    await startDownload(url, fileName, true, true, url);
    return;
  } catch (directError) {
    try {
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'include',
        referrer: pageUrl || undefined,
        referrerPolicy: 'unsafe-url'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      try {
        await startDownload(objectUrl, fileName, false, true, url);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      return;
    } catch (fallbackError) {
      const message = fallbackError && fallbackError.message
        ? fallbackError.message
        : directError && directError.message
          ? directError.message
          : 'Download failed.';
      throw new Error(message);
    }
  }
}

// content.jsとダウンロード操作からのメッセージを処理する。
// 応答はPromiseの解決値で返す。async内でsendResponseとreturn trueを混在させると
// 解決値がbooleanのtrueになり、content.js側でsizeが読めず「不明」になるため。
browser.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === 'getVideoSize') {
    return (async () => {
      try {
        const result = await getRemoteFileSize(
          message.url,
          message.pageUrl || sender?.url || '',
          Number(message.performanceSize) || 0
        );
        return { ok: true, size: result.text, sizeSource: result.source };
      } catch (error) {
        return { ok: true, size: '不明', sizeSource: 'unknown' };
      }
    })();
  }

  if (message && message.type === 'getObservedVideos') {
    return Promise.resolve({ videos: getMediaCandidates(sender?.tab?.id) });
  }

  if (message && message.type === 'openSettings') {
    // 設定画面(options_ui)を開く。content scriptからは直接開けないため、ここで処理する。
    return browser.runtime.openOptionsPage().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: error && error.message ? error.message : String(error) })
    );
  }

  if (message && message.type === 'downloadVideo') {
    const url = message.url;
    if (!url) {
      return Promise.resolve({ ok: false, error: 'URL is missing.' });
    }

    return (async () => {
      const fileName = await getDefaultFileName(url, 'mp4', sender.tab?.title || '');

      try {
        await downloadDirectVideo(url, fileName, message.pageUrl || sender.tab?.url);
        return { ok: true };
      } catch (error) {
        console.error(error);
        return { ok: false, error: buildDownloadFailureError(url, message.pageUrl || sender.tab?.url, error) };
      }
    })();
  }

  return undefined;
});

// 拡張機能アイコンから、ページ内の動画一覧を開閉する。
browser.action.onClicked.addListener((tab) => { if (tab.id !== undefined) { browser.tabs.sendMessage(tab.id, { type: 'toggleVideoList' }).catch(() => {}); } });
