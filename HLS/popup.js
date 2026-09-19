const DEFAULT_MIN_SIZE = 100 * 1024;
const state = {
  showUnknown: true,
  sortOrder: 'desc'
};

function getFileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname || '');
    const segments = pathname.split('/').filter(Boolean);
    const fallback = 'video';
    const last = segments.length ? segments[segments.length - 1] : fallback;
    return last && last.trim() ? last : fallback;
  } catch (error) {
    return 'video';
  }
}

function getExtensionFromUrl(url) {
  const fileName = getFileNameFromUrl(url);
  const match = fileName.match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : 'unknown';
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return '不明';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function compareVideoSize(a, b) {
  const aSize = a.sizeBytes ?? Number.MAX_SAFE_INTEGER;
  const bSize = b.sizeBytes ?? Number.MAX_SAFE_INTEGER;

  if (aSize === bSize) {
    return a.fileName.localeCompare(b.fileName, 'ja');
  }

  if (state.sortOrder === 'asc') {
    return aSize - bSize;
  }

  return bSize - aSize;
}

function sortVideos(videos) {
  const known = videos.filter((video) => video.sizeBytes !== null && video.sizeBytes !== undefined);
  const unknown = videos.filter((video) => video.sizeBytes === null || video.sizeBytes === undefined);

  known.sort(compareVideoSize);
  unknown.sort((a, b) => a.fileName.localeCompare(b.fileName, 'ja'));

  return [...known, ...unknown];
}

async function getVideoSize(url) {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      mode: 'cors',
      credentials: 'omit'
    });

    const lengthHeader = response.headers.get('Content-Length');
    if (lengthHeader && !Number.isNaN(Number(lengthHeader))) {
      return Number(lengthHeader);
    }
  } catch (error) {
    // HEAD 取得が失敗した場合は GET の Range 取得を試す
  }

  try {
    const rangeResponse = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      mode: 'cors',
      credentials: 'omit'
    });

    const totalLength = rangeResponse.headers.get('Content-Range') || rangeResponse.headers.get('Content-Length');
    if (!totalLength) {
      return null;
    }

    const match = totalLength.match(/bytes\s+\d+-\d+\/(\d+)/i) || totalLength.match(/^(\d+)$/);
    if (match) {
      return Number(match[1]);
    }
  } catch (error) {
    return null;
  }

  return null;
}

async function buildVideoList() {
  const list = document.getElementById('video-list');
  const status = document.getElementById('status');
  const refreshButton = document.getElementById('refresh-btn');

  if (!list || !status || !refreshButton) {
    return;
  }

  status.textContent = '検出中...';
  refreshButton.disabled = true;
  list.innerHTML = '';

  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab || typeof activeTab.id !== 'number') {
      throw new Error('アクティブなタブが見つかりません。');
    }

    const response = await browser.tabs.sendMessage(activeTab.id, { type: 'getVideos' });
    const videos = response && Array.isArray(response.videos) ? response.videos : [];
    const prepared = [];

    for (const video of videos) {
      const sizeBytes = await getVideoSize(video.url);

      if (sizeBytes !== null && sizeBytes <= DEFAULT_MIN_SIZE) {
        continue;
      }

      if (!state.showUnknown && sizeBytes === null) {
        continue;
      }

      prepared.push({
        ...video,
        fileName: getFileNameFromUrl(video.url),
        extension: getExtensionFromUrl(video.url),
        sizeBytes
      });
    }

    const sortedVideos = sortVideos(prepared);

    if (!sortedVideos.length) {
      status.textContent = state.showUnknown
        ? '100kB 未満の動画やサイズ判定不能の候補は非表示にしています。'
        : '100kB 未満の動画は非表示にしています。';
      return;
    }

    status.textContent = `${sortedVideos.length} 件の動画候補を表示しています。`;

    sortedVideos.forEach((video, index) => {
      const item = document.createElement('li');
      item.className = 'video-item';

      const info = document.createElement('div');
      info.className = 'video-info';

      const name = document.createElement('div');
      name.className = 'video-name';
      name.textContent = `${index + 1}. ${video.fileName || 'video'}`;

      const meta = document.createElement('div');
      meta.className = 'video-meta';
      meta.innerHTML = `
        <span>形態: ${video.type === 'hls' ? 'HLS' : '直リンク'}</span>
        <span>サイズ: ${formatBytes(video.sizeBytes)}</span>
        <span>拡張子: ${video.extension || 'unknown'}</span>
      `;

      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'download-btn';
      action.textContent = video.type === 'hls' ? 'HLS 保存' : 'ダウンロード';
      action.addEventListener('click', async () => {
        try {
          if (video.type === 'hls') {
            await browser.runtime.sendMessage({ type: 'downloadHls', url: video.url });
          } else {
            await browser.runtime.sendMessage({ type: 'downloadVideo', url: video.url });
          }
          status.textContent = 'ダウンロードを開始しました。';
        } catch (error) {
          status.textContent = 'ダウンロードの開始に失敗しました。';
        }
      });

      info.appendChild(name);
      info.appendChild(meta);
      item.appendChild(info);
      item.appendChild(action);
      list.appendChild(item);
    });
  } catch (error) {
    status.textContent = '動画の検出に失敗しました。';
    console.error(error);
  } finally {
    refreshButton.disabled = false;
  }
}

function bindSettings() {
  const showUnknownToggle = document.getElementById('show-unknown-toggle');
  const sortOrderSelect = document.getElementById('sort-order');

  if (showUnknownToggle) {
    showUnknownToggle.checked = state.showUnknown;
    showUnknownToggle.addEventListener('change', () => {
      state.showUnknown = showUnknownToggle.checked;
      buildVideoList();
    });
  }

  if (sortOrderSelect) {
    sortOrderSelect.value = state.sortOrder;
    sortOrderSelect.addEventListener('change', () => {
      state.sortOrder = sortOrderSelect.value;
      buildVideoList();
    });
  }
}

document.getElementById('refresh-btn').addEventListener('click', buildVideoList);
bindSettings();
buildVideoList();
