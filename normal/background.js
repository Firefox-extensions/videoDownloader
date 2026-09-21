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

// Content-LengthまたはContent-Rangeから、配信元が示した総サイズを保存する。
function rememberMediaSize(url, headers, statusCode) {
  const size = getTotalSizeFromRange(headers) || (statusCode === 200 ? getSizeFromHeaders(headers) : 0);

  if (Number.isFinite(size) && size > 0) {
    storeMediaSize(url, size);
    try {
      storeMediaSize(new URL(url).hash ? url.split('#')[0] : url, size);
    } catch (error) {
      // なにもしない
    }
  }
}

function getCachedMediaSize(url) {
  const keys = [url];
  try {
    keys.push(url.split('#')[0]);
  } catch (error) {
    // なにもしない
  }

  for (const key of keys) {
    const cached = mediaSizes.get(key);
    if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) return cached;
  }
  return null;
}

function sizeStorageKey(url) {
  return `media-size:${url}`;
}

async function getStoredMediaSize(url) {
  const keys = [sizeStorageKey(url)];
  try {
    keys.push(sizeStorageKey(url.split('#')[0]));
  } catch (error) {
    // なにもしない
  }
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

async function probeDownloadSize(url, pageUrl = '') {
  if (/^(blob:|data:)/i.test(url)) return 0;

  const fileName = `video-downloader-size-probe-${Date.now()}.mp4`;
  let downloadId;
  try {
    if (pageUrl) pendingReferers.set(url, pageUrl);
    downloadId = await browser.downloads.download({
      url,
      filename: fileName,
      saveAs: false
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const items = await browser.downloads.search({ id: downloadId });
      const item = items[0];
      if (item?.totalBytes > 0) return item.totalBytes;
      if (item?.state === 'complete' && item?.downloadedBytes > 0) return item.downloadedBytes;
      if (item?.state === 'interrupted') return 0;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    // ここでは抜けず、下のfetchによるフォールバックへ進む
  } finally {
    if (downloadId !== undefined) {
      try {
        await browser.downloads.cancel(downloadId);
      } catch (error) {
        // なにもしない
      }
      try {
        await browser.downloads.removeFile(downloadId);
      } catch (error) {
        // なにもしない
      }
      try {
        await browser.downloads.erase({ id: downloadId });
      } catch (error) {
        // なにもしない
      }
    }
  }
  // 最終手段: fetchで実データを取得してバイト数を数える
  // (サーバーがContent-Lengthを送らない場合でも使える)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        referrer: pageUrl || undefined,
        referrerPolicy: 'unsafe-url',
        cache: 'no-store',
        signal: controller.signal
      });
      if (response.ok && response.body) {
        const bytes = await countResponseBytes(response);
        if (bytes > 0) {
          storeMediaSize(url, bytes);
          return bytes;
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    // なにもしない
  }
  return 0;
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

// サイズ取得は、実データ、過去のダウンロード、レスポンスヘッダーの順で試す。
async function getRemoteFileSize(url, pageUrl = '') {
  if (pageUrl) pendingReferers.set(url, pageUrl);

  try {
    const downloads = await browser.downloads.search({ url });
    const completedDownloads = downloads.filter((item) => item.state === 'complete');
    // totalBytesが不明(-1)の場合でもdownloadedBytesがあれば使う
    const withKnownSize = completedDownloads.find((item) => item.totalBytes > 0)
      || completedDownloads.find((item) => item.downloadedBytes > 0);
    if (withKnownSize) {
      const size = withKnownSize.totalBytes > 0 ? withKnownSize.totalBytes : withKnownSize.downloadedBytes;
      storeMediaSize(url, size);
      return formatBytes(size);
    }
  } catch (error) {
    // ダウンロード履歴が取得できなくても、サイズ確認は続行する
  }

  const captured = capturedMedia.get(url);
  if (captured && Date.now() - captured.timestamp < 10 * 60 * 1000) {
    return formatBytes(captured.size);
  }

  const cached = getCachedMediaSize(url);
  if (cached) {
    return formatBytes(cached.size);
  }

  const stored = await getStoredMediaSize(url);
  if (stored) return formatBytes(stored.size);

  const headResult = await tryHeadSize(url, pageUrl);
  if (headResult > 0) {
    storeMediaSize(url, headResult);
    return formatBytes(headResult);
  }

  const rangeResult = await tryRangeSize(url, pageUrl);
  if (rangeResult > 0) {
    storeMediaSize(url, rangeResult);
    return formatBytes(rangeResult);
  }

  const probedSize = await probeDownloadSize(url, pageUrl);
  if (probedSize > 0) {
    storeMediaSize(url, probedSize);
    return formatBytes(probedSize);
  }

  return '不明';
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

// Rangeリクエスト(先頭1バイト)でContent-Rangeから総サイズの取得を試す。
// 206応答でなく200応答が返った場合もContent-Lengthがあれば使う。
async function tryRangeSize(url, pageUrl) {
  let rangeResponse = null;
  try {
    rangeResponse = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
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
    return 0;
  } catch (error) {
    return 0;
  } finally {
    // Range応答のボディは最大1バイトだが、接続を残さないよう確実に消費する
    try {
      if (rangeResponse && rangeResponse.body) {
        await rangeResponse.arrayBuffer().catch(() => {});
      }
    } catch (error) {
      // なにもしない
    }
  }
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
        return {
          ok: true,
          size: await getRemoteFileSize(message.url, message.pageUrl || sender?.url || '')
        };
      } catch (error) {
        return { ok: true, size: '不明' };
      }
    })();
  }

  if (message && message.type === 'getObservedVideos') {
    return Promise.resolve({ videos: getMediaCandidates(sender?.tab?.id) });
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
