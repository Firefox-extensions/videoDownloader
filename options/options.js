// 設定画面の処理。値は storage.local へ保存し、content.js 側で読み込んで使う。
// 初期値は content.js の FILTER_DEFAULTS と同じ内容に保つこと。
const STORAGE_KEY = 'videoDownloaderSettings';

const DEFAULTS = {
  minSizeValue: 1,
  minSizeUnit: 'MB',
  unknownSizePolicy: 'mediaOnly',
  mediaExtensions: 'mp4, webm, m4v, mov, m3u8, mpd, ts, m4s, mp3, m4a, aac, ogg, wav',
  excludeExtensions: 'js, mjs, css, html, htm, json, txt, xml, png, jpg, jpeg, gif, webp, svg, ico, woff, woff2, ttf, map, zip',
  excludeUrlKeywords: '',
  showSizeSource: false
};

const form = document.getElementById('settings-form');
const status = document.getElementById('status');
const minSizeValue = document.getElementById('min-size-value');
const minSizeUnit = document.getElementById('min-size-unit');
const mediaExtensions = document.getElementById('media-extensions');
const excludeExtensions = document.getElementById('exclude-extensions');
const excludeUrlKeywords = document.getElementById('exclude-url-keywords');
const showSizeSource = document.getElementById('show-size-source');

// 保存済みの設定をフォームへ反映する。
function applySettings(settings) {
  minSizeValue.value = String(settings.minSizeValue);
  minSizeUnit.value = settings.minSizeUnit;
  mediaExtensions.value = settings.mediaExtensions;
  excludeExtensions.value = settings.excludeExtensions;
    excludeUrlKeywords.value = settings.excludeUrlKeywords;

  const policy = settings.unknownSizePolicy;
  for (const radio of document.querySelectorAll('input[name="unknown-size-policy"]')) {
    radio.checked = radio.value === policy;
  }

  showSizeSource.checked = Boolean(settings.showSizeSource);
}

// フォームの内容を設定値として取り出す。
function readForm() {
  const checked = document.querySelector('input[name="unknown-size-policy"]:checked');
  const numericValue = Number(minSizeValue.value);

  return {
    minSizeValue: Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : DEFAULTS.minSizeValue,
    minSizeUnit: ['B', 'KB', 'MB'].includes(minSizeUnit.value) ? minSizeUnit.value : DEFAULTS.minSizeUnit,
    unknownSizePolicy: ['mediaOnly', 'hide', 'show'].includes(checked?.value) ? checked.value : DEFAULTS.unknownSizePolicy,
    mediaExtensions: mediaExtensions.value.trim(),
    excludeExtensions: excludeExtensions.value.trim(),
    excludeUrlKeywords: excludeUrlKeywords.value.trim(),
    showSizeSource: showSizeSource.checked
  };
}

async function loadSettings() {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    return { ...DEFAULTS, ...(stored?.[STORAGE_KEY] || {}) };
  } catch (error) {
    return { ...DEFAULTS };
  }
}

async function saveSettings(settings, message) {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: settings });
    status.textContent = message;
  } catch (error) {
    status.textContent = `保存できませんでした: ${error && error.message ? error.message : error}`;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  saveSettings(readForm(), '設定を保存しました。次に一覧を開いたときから反映されます。');
});

document.getElementById('reset').addEventListener('click', () => {
  applySettings({ ...DEFAULTS });
  saveSettings({ ...DEFAULTS }, '初期値に戻して保存しました。');
});

loadSettings().then(applySettings).catch(() => applySettings({ ...DEFAULTS }));
