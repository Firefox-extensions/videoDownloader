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
    // no-op
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
  action.setTitle({ tabId, title: hasCandidates ? 'Video Downloader -HLS-' : '動画候補はありません' });
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
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const pendingReferers = new Map();

// 直接保存の対象にする動画ファイルURLを判定する。
function isDirectMediaUrl(url) {
  return /\.(mp4|webm|m4v|mov)(?:$|[?#])/i.test(url);
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

// Content-LengthまたはContent-Rangeから、配信元が示した総サイズを保存する。
function rememberMediaSize(url, headers) {
  const contentLength = headers.find((header) => header.name.toLowerCase() === 'content-length')?.value;
  const contentRange = headers.find((header) => header.name.toLowerCase() === 'content-range')?.value;
  const match = contentRange?.match(/bytes\s+\d+-\d+\/(\d+)/i);
  const size = match ? Number(match[1]) : Number(contentLength);

  if (Number.isFinite(size) && size > 0) {
    mediaSizes.set(url, { size, timestamp: Date.now() });
  }
}

// 実際の動画レスポンスを通過させながら、一定サイズ以下ならメモリにも保持する。
// これにより、サイズヘッダーがない配信でも受信済みサイズを利用できる。
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type === 'media' || isDirectMediaUrl(details.url)) {
      rememberMediaSize(details.url, details.responseHeaders || []);
    }

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
        mediaSizes.set(details.url, { size: totalBytes, timestamp: Date.now() });
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

  const captured = capturedMedia.get(url);
  if (captured && Date.now() - captured.timestamp < 10 * 60 * 1000) {
    return formatBytes(captured.size);
  }

  const downloads = await browser.downloads.search({ url });
  const previousDownload = downloads.find((item) => item.totalBytes > 0);
  if (previousDownload) {
    return formatBytes(previousDownload.totalBytes);
  }

  const cached = mediaSizes.get(url);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
    return formatBytes(cached.size);
  }

  try {
    const headResponse = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      referrer: pageUrl || undefined,
      referrerPolicy: 'unsafe-url'
    });
    const headLength = headResponse.headers.get('Content-Length');
    if (headLength && Number.isFinite(Number(headLength))) {
      return formatBytes(Number(headLength));
    }
  } catch (error) {
    // HEAD 非対応の配信元では Range 取得へ進む
  }

  const rangeResponse = await fetch(url, {
    headers: { Range: 'bytes=0-0' },
    credentials: 'include',
    referrer: pageUrl || undefined,
    referrerPolicy: 'unsafe-url'
  });
  const lengthHeader = rangeResponse.headers.get('Content-Range') || rangeResponse.headers.get('Content-Length');
  const match = lengthHeader?.match(/bytes\s+\d+-\d+\/(\d+)/i) || lengthHeader?.match(/^(\d+)$/);
  return match ? formatBytes(Number(match[1])) : '不明';
}

// ページ読み込み開始時は、前ページの動画候補を示さない。
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    setActionAvailability(tabId, false).catch(() => {});
  }
});

// content.jsからの候補数通知を受け、拡張機能ボタンの状態を更新する。
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'videoCandidatesChanged' || !sender.tab?.id) return;
  setActionAvailability(sender.tab.id, message.count > 0).catch(() => {});
});

// HLSプレイリスト内の相対URLを絶対URLへ変換し、取得対象のセグメントだけを集める。
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

// m3u8を取得し、プレイリスト内のTS/M4S/MP4セグメントを結合して保存する。
async function downloadHls(url, titleOverride = '', pageUrl = '') {
  if (pageUrl) pendingReferers.set(url, pageUrl);

  const requestOptions = {
    mode: 'cors',
    credentials: 'include',
    referrer: pageUrl || undefined,
    referrerPolicy: 'unsafe-url'
  };
  const playlistResponse = await fetch(url, requestOptions);
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
    if (pageUrl) pendingReferers.set(segmentUrl, pageUrl);

    try {
      const response = await fetch(segmentUrl, requestOptions);
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

  const fileName = await getDefaultFileName(url, 'ts', titleOverride);
  const blob = new Blob(chunks, { type: 'video/mp2t' });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const downloadId = await browser.downloads.download({
      url: objectUrl,
      filename: fileName,
      saveAs: true
    });
    await waitForDownload(downloadId);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

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
async function startDownload(url, fileName) {
  const downloadId = await browser.downloads.download({ url, filename: fileName, saveAs: true });
  await waitForDownload(downloadId);
}

// まず直接URLを保存し、失敗した場合だけFetchしてBlob保存へ切り替える。
async function downloadDirectVideo(url, fileName, pageUrl) {
  if (pageUrl) pendingReferers.set(url, pageUrl);

  const captured = capturedMedia.get(url);
  if (captured && Date.now() - captured.timestamp < 10 * 60 * 1000) {
    const objectUrl = URL.createObjectURL(new Blob(captured.chunks, { type: 'video/mp4' }));
    try {
      await startDownload(objectUrl, fileName);
      return;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  try {
    await startDownload(url, fileName);
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
        await startDownload(objectUrl, fileName);
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
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message && message.type === 'getVideoSize') {
    try {
      sendResponse({ ok: true, size: await getRemoteFileSize(message.url, message.pageUrl) });
    } catch (error) {
      sendResponse({ ok: true, size: '不明' });
    }
    return true;
  }

  if (message && message.type === 'downloadVideo') {
    const url = message.url;
    if (!url) {
      sendResponse({ ok: false, error: 'URL is missing.' });
      return false;
    }

    const fileName = await getDefaultFileName(url, 'mp4', sender.tab?.title || '');

    try {
      await downloadDirectVideo(url, fileName, message.pageUrl || sender.tab?.url);
      sendResponse({ ok: true });
    } catch (error) {
      console.error(error);
      sendResponse({ ok: false, error: buildDownloadFailureError(url, message.pageUrl || sender.tab?.url, error) });
    }

    return true;
  }

  if (message && message.type === 'downloadHls') {
    try {
      await downloadHls(message.url, sender.tab?.title || '', message.pageUrl || sender.tab?.url);
      sendResponse({ ok: true });
    } catch (error) {
      console.error(error);
      sendResponse({ ok: false, error: buildDownloadFailureError(message.url, message.pageUrl || sender.tab?.url, error) || 'HLS download failed.' });
    }
    return true;
  }

  return false;
});

// 拡張機能アイコンから、ページ内の動画一覧を開閉する。
browser.action.onClicked.addListener((tab) => { if (tab.id !== undefined) { browser.tabs.sendMessage(tab.id, { type: 'toggleVideoList' }).catch(() => {}); } });
