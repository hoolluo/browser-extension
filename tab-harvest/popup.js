const els = {
  windowSelect: document.getElementById('windowSelect'),
  tabCountLine: document.getElementById('tabCountLine'),
  segButtons: Array.from(document.querySelectorAll('.seg-btn')),
  customPanel: document.getElementById('customPanel'),
  urlInput: document.getElementById('urlInput'),
  startBtn: document.getElementById('startBtn'),
  resultsPanel: document.getElementById('resultsPanel'),
  results: document.getElementById('results'),
  emptyHint: document.getElementById('emptyHint'),
  copyBtn: document.getElementById('copyBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  clearBtn: document.getElementById('clearBtn'),
  statusBadge: document.getElementById('statusBadge'),
  statusBadgeText: document.getElementById('statusBadgeText'),
  statusText: document.getElementById('statusText'),
  resultsToggle: document.getElementById('resultsToggle'),
  settingsBtn: document.getElementById('settingsBtn'),
};

const STATUS_LABELS = {
  idle: '就绪',
  running: '进行中',
  done: '完成',
  error: '错误',
};

let results = [];
let running = false;
let scope = 'all';
let windowsData = [];
let currentWindowId = null;

// 注入到目标页面中执行，不能引用本文件的其它变量
function grabPageText() {
  const source = document.body || document.documentElement;
  const raw = source ? source.innerText || source.textContent || '' : '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(state, text) {
  els.statusBadge.dataset.state = state;
  els.statusBadgeText.textContent = STATUS_LABELS[state];
  if (text != null) els.statusText.textContent = text;
}

function shorten(text, max = 42) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isExtractable(url) {
  return /^https?:\/\//i.test(url || '');
}

async function getCurrentWindowId() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return win.id;
  } catch {
    try {
      return (await chrome.windows.getCurrent()).id;
    } catch {
      return null;
    }
  }
}

function selectedWindow() {
  const id = Number(els.windowSelect.value);
  return windowsData.find((win) => win.id === id) || null;
}

function updateCountLine() {
  const win = selectedWindow();
  if (!win) {
    els.tabCountLine.textContent = '未找到可用的浏览器窗口';
    return;
  }

  const option = els.windowSelect.options[els.windowSelect.selectedIndex];
  const prefix = win.id === currentWindowId ? '当前窗口' : option ? option.textContent : '所选窗口';

  if (scope === 'custom') {
    els.tabCountLine.textContent = `${prefix} · 自定义链接范围`;
    return;
  }
  if (scope === 'selected') {
    const count = (win.tabs || []).filter((tab) => tab.highlighted).length;
    els.tabCountLine.textContent = `${prefix} · 已选中 ${count} 个标签页`;
    return;
  }
  els.tabCountLine.textContent = `${prefix} · ${(win.tabs || []).length} 个标签页`;
}

async function loadWindows(preferredId) {
  currentWindowId = await getCurrentWindowId();

  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  wins.sort((a, b) => a.id - b.id);
  windowsData = wins;

  els.windowSelect.innerHTML = '';
  wins.forEach((win, index) => {
    const option = document.createElement('option');
    option.value = String(win.id);
    option.textContent = `窗口 ${index + 1}${win.id === currentWindowId ? '（当前）' : ''}`;
    els.windowSelect.appendChild(option);
  });

  const fallback = currentWindowId ?? (wins[0] ? wins[0].id : null);
  const desired =
    preferredId != null && wins.some((win) => win.id === preferredId) ? preferredId : fallback;

  if (desired != null) els.windowSelect.value = String(desired);
  updateCountLine();
}

function setScope(next) {
  scope = next;
  els.segButtons.forEach((btn) => {
    const active = btn.dataset.scope === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  els.customPanel.classList.toggle('hidden', next !== 'custom');
  updateCountLine();
  if (next === 'custom') els.urlInput.focus();
}

function updateActions() {
  const hasResults = results.length > 0;
  const disabled = !hasResults || running;
  els.copyBtn.disabled = disabled;
  els.downloadBtn.disabled = disabled;
  els.clearBtn.disabled = disabled;
}

function setResultsOpen(open) {
  els.resultsPanel.classList.toggle('hidden', !open);
  els.resultsToggle.classList.toggle('open', open);
  els.resultsToggle.setAttribute('aria-expanded', String(open));
}

function resetResults() {
  results = [];
  els.results.innerHTML = '';
  els.emptyHint.classList.remove('hidden');
  setResultsOpen(false);
  updateActions();
}

function addResult(item) {
  results.push(item);

  els.emptyHint.classList.add('hidden');

  const card = document.createElement('details');
  card.className = 'card';

  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = item.title || item.url || '未命名页面';
  const meta = document.createElement('span');
  meta.className = 'card-meta';
  meta.textContent = item.error ? '失败' : `${item.text.length} 字`;
  summary.append(title, meta);

  const url = document.createElement('div');
  url.className = 'card-url';
  url.textContent = item.url || '';

  const pre = document.createElement('pre');
  pre.textContent = item.text || '（无文本）';

  card.append(summary, url, pre);
  els.results.appendChild(card);

  setResultsOpen(true);
  updateActions();
}

async function extractTab(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: grabPageText,
  });
  return (injection && injection.result) || '';
}

function normalizeUrl(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 没有写协议时默认补 https://
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error('页面加载超时')), timeout);

    function finish(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (err) reject(err);
      else resolve();
    }

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') finish();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    // 防止监听前页面已经加载完成
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === 'complete') finish();
      })
      .catch(finish);
  });
}

function beginRun() {
  resetResults();
  running = true;
  els.startBtn.disabled = true;
  els.windowSelect.disabled = true;
  els.segButtons.forEach((btn) => (btn.disabled = true));
  els.urlInput.disabled = true;
  setStatus('running', '准备中…');
  updateActions();
}

async function endRun() {
  running = false;
  els.startBtn.disabled = false;
  els.windowSelect.disabled = false;
  els.segButtons.forEach((btn) => (btn.disabled = false));
  els.urlInput.disabled = false;
  updateActions();

  const selectedId = Number(els.windowSelect.value);
  try {
    await loadWindows(selectedId);
  } catch {
    // 窗口刷新失败不影响已有结果
  }
}

async function extractFromTabs() {
  if (running) return;

  const win = selectedWindow();
  if (!win) {
    setStatus('error', '没有可用的浏览器窗口');
    return;
  }

  let tabs = await chrome.tabs.query({ windowId: win.id });
  if (scope === 'selected') tabs = tabs.filter((tab) => tab.highlighted);

  const skipped = tabs.length;
  const targets = tabs.filter((tab) => tab.id != null && isExtractable(tab.url));

  if (!targets.length) {
    setStatus(
      'idle',
      scope === 'selected' ? '没有选中可提取的标签页' : '该窗口没有可提取的标签页'
    );
    return;
  }

  beginRun();

  try {
    for (let i = 0; i < targets.length; i++) {
      const tab = targets[i];
      setStatus('running', `(${i + 1}/${targets.length}) 正在提取：${shorten(tab.title || tab.url)}`);

      try {
        const text = await extractTab(tab.id);
        addResult({ title: tab.title, url: tab.url, text });
      } catch (err) {
        addResult({
          title: tab.title,
          url: tab.url,
          text: `[提取失败] ${err.message}`,
          error: true,
        });
      }
    }

    const skippedCount = skipped - targets.length;
    setStatus(
      'done',
      `已提取 ${targets.length} 个页面${skippedCount ? `，跳过 ${skippedCount} 个无法访问的页面` : ''}`
    );
  } catch (err) {
    setStatus('error', `提取出错：${err.message}`);
  } finally {
    await endRun();
  }
}

async function extractFromUrls() {
  if (running) return;

  const urls = [];
  let invalidCount = 0;

  for (const line of els.urlInput.value.split('\n')) {
    if (!line.trim()) continue;
    const normalized = normalizeUrl(line);
    if (normalized) urls.push(normalized);
    else invalidCount++;
  }

  if (!urls.length) {
    setStatus('error', '请先输入至少一个有效的 http/https 链接（每行一个）');
    els.urlInput.focus();
    return;
  }

  beginRun();

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      setStatus('running', `(${i + 1}/${urls.length}) 正在打开：${shorten(url)}`);

      let tabId;
      try {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
        await waitForTabComplete(tabId);
        await sleep(500); // 等待动态内容渲染
        const text = await extractTab(tabId);

        let title = url;
        try {
          const info = await chrome.tabs.get(tabId);
          title = info.title || url;
        } catch {
          // 标签页可能已被关闭，忽略
        }

        addResult({ title, url, text });
      } catch (err) {
        addResult({
          title: url,
          url,
          text: `[提取失败] ${err.message}`,
          error: true,
        });
      } finally {
        if (tabId != null) {
          try {
            await chrome.tabs.remove(tabId);
          } catch {
            // 标签页已不存在
          }
        }
      }
    }

    setStatus(
      'done',
      `已处理 ${urls.length} 个链接${invalidCount ? `，忽略 ${invalidCount} 个无效链接` : ''}`
    );
  } catch (err) {
    setStatus('error', `提取出错：${err.message}`);
  } finally {
    await endRun();
  }
}

function buildPlainText() {
  return results
    .map((item) => `===== ${item.title || '未命名页面'}\n${item.url}\n\n${item.text}`)
    .join('\n\n');
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function copyAll() {
  if (!results.length) return;
  try {
    await navigator.clipboard.writeText(buildPlainText());
    setStatus('done', '已复制全部结果到剪贴板');
  } catch (err) {
    setStatus('error', `复制失败：${err.message}`);
  }
}

function downloadAll() {
  if (!results.length) return;
  const blob = new Blob([buildPlainText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `page-texts-${timestamp()}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('done', '已开始下载 .txt 文件');
}

function clearAll() {
  if (running) return;
  resetResults();
  setStatus('idle', '等待提取任务');
}

els.startBtn.addEventListener('click', () => {
  if (scope === 'custom') extractFromUrls();
  else extractFromTabs();
});

els.segButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (running) return;
    setScope(btn.dataset.scope);
  });
});

els.windowSelect.addEventListener('change', async () => {
  const win = selectedWindow();
  if (win) {
    try {
      win.tabs = await chrome.tabs.query({ windowId: win.id });
    } catch {
      // 窗口可能已关闭
    }
  }
  updateCountLine();
});

els.resultsToggle.addEventListener('click', () => {
  setResultsOpen(els.resultsPanel.classList.contains('hidden'));
});

els.copyBtn.addEventListener('click', copyAll);
els.downloadBtn.addEventListener('click', downloadAll);
els.clearBtn.addEventListener('click', clearAll);

els.settingsBtn.addEventListener('click', () => {
  chrome.tabs
    .create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
    .catch(() => chrome.tabs.create({ url: 'chrome://extensions/' }));
});

(async function init() {
  try {
    await loadWindows();
  } catch (err) {
    setStatus('error', `初始化失败：${err.message}`);
    els.tabCountLine.textContent = '无法读取窗口信息';
  }
})();
