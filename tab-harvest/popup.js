/* ============================================================
   TabHarvest Popup — 主脚本
   保留原有所有 DOM ID 契约，新增视图切换 / 进度 / 自动滚动
   ============================================================ */

// ---------- 原有 DOM 引用（保持与 popup.html 中 ID 一致） ----------
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

// ---------- 新增 DOM 引用 ----------
const newEls = {
  // 视图容器
  mainView: document.getElementById('mainView'),
  progressView: document.getElementById('progressView'),
  resultView: document.getElementById('resultView'),
  pickerView: document.getElementById('pickerView'),

  // 区域选择确认视图
  pickerBackBtn: document.getElementById('pickerBackBtn'),
  pickerCloseBtn: document.getElementById('pickerCloseBtn'),
  pickerConfirmBtn: document.getElementById('pickerConfirmBtn'),
  pickerHint: document.getElementById('pickerHint'),
  pickerPreviewText: document.getElementById('pickerPreviewText'),
  pickerSelectorText: document.getElementById('pickerSelectorText'),

  // 关闭按钮
  closeBtn: document.getElementById('closeBtn'),

  // 自动滚动
  autoScrollToggle: document.getElementById('autoScrollToggle'),
  autoScrollExpand: document.getElementById('autoScrollExpand'),
  autoScrollConfig: document.getElementById('autoScrollConfig'),
  autoScrollDesc: document.getElementById('autoScrollDesc'),
  cfgInterval: document.getElementById('cfgInterval'),
  cfgWait: document.getElementById('cfgWait'),
  cfgMaxScroll: document.getElementById('cfgMaxScroll'),
  cfgTimeout: document.getElementById('cfgTimeout'),

  // 进度视图
  ringFill: document.getElementById('ringFill'),
  ringCurrent: document.getElementById('ringCurrent'),
  ringTotal: document.getElementById('ringTotal'),
  progressSub: document.getElementById('progressSub'),
  linearFill: document.getElementById('linearFill'),
  statSuccess: document.getElementById('statSuccess'),
  statFailure: document.getElementById('statFailure'),
  cancelBtn: document.getElementById('cancelBtn'),

  // 结果视图
  resultSummary: document.getElementById('resultSummary'),
  viewResultBtn: document.getElementById('viewResultBtn'),
  copyBtn2: document.getElementById('copyBtn2'),
  downloadBtn2: document.getElementById('downloadBtn2'),
  clearBtn2: document.getElementById('clearBtn2'),

  // 元素点选
  pickElementBtn: document.getElementById('pickElementBtn'),
  rememberSelectorBtn: document.getElementById('rememberSelectorBtn'),
  selectorPanel: document.getElementById('selectorPanel'),
  selectorText: document.getElementById('selectorText'),
  selectorApplyBtn: document.getElementById('selectorApplyBtn'),
  selectorCloseBtn: document.getElementById('selectorCloseBtn'),
};

// ---------- 状态常量 ----------
const STATUS_LABELS = {
  idle: '就绪',
  running: '进行中',
  done: '完成',
  error: '错误',
};

const VIEW = { MAIN: 'main', PROGRESS: 'progress', RESULT: 'result', PICKER: 'picker' };

// ---------- 全局状态 ----------
let results = [];
let running = false;
let cancelled = false;
let scope = 'all';
let windowsData = [];
let currentWindowId = null;
let currentSelector = null;
let pendingPick = null;

// 自动滚动配置（带默认值）
let autoScroll = {
  enabled: false,
  expandConfig: false,
  interval: 1000,
  wait: 2000,
  maxScroll: 3,
  timeout: 30000,
};

// ---------- 视图切换 ----------
function switchView(view) {
  const show = {
    [VIEW.MAIN]: newEls.mainView,
    [VIEW.PROGRESS]: newEls.progressView,
    [VIEW.RESULT]: newEls.resultView,
    [VIEW.PICKER]: newEls.pickerView,
  };
  Object.values(show).forEach((el) => el.classList.add('hidden'));
  if (show[view]) show[view].classList.remove('hidden');
}

// ---------- 存储：自动滚动配置 ----------
function saveAutoScroll() {
  chrome.storage?.local?.set({ autoScroll }).catch(() => {});
}

async function loadAutoScroll() {
  try {
    const stored = await chrome.storage?.local?.get('autoScroll');
    if (stored?.autoScroll) autoScroll = { ...autoScroll, ...stored.autoScroll };
  } catch { /* ignore */ }

  newEls.autoScrollToggle.checked = autoScroll.enabled;
  newEls.cfgInterval.value = String(autoScroll.interval);
  newEls.cfgWait.value = String(autoScroll.wait);
  newEls.cfgMaxScroll.value = String(autoScroll.maxScroll);
  newEls.cfgTimeout.value = String(autoScroll.timeout);

  // 配置展开状态仅在 toggle 开启时可显示
  refreshAutoScrollUI();
}

function refreshAutoScrollUI() {
  const enabled = autoScroll.enabled;
  newEls.autoScrollExpand.classList.toggle('hidden', !enabled);
  newEls.autoScrollConfig.classList.toggle('hidden', !(enabled && autoScroll.expandConfig));
  newEls.autoScrollExpand.classList.toggle('up', autoScroll.expandConfig);

  if (enabled) {
    newEls.autoScrollDesc.textContent =
      `自动滚动到底并等待内容稳定 (间隔 ${autoScroll.interval / 1000}s, 等待 ${autoScroll.wait / 1000}s)`;
  } else {
    newEls.autoScrollDesc.textContent = '自动滚动到底并等待内容稳定 (应用于全部标签页)';
  }

  syncCustomSelects();
}

// ---------- 原有功能：页面文本提取 ----------
function grabPageText() {
  const source = document.body || document.documentElement;
  const raw = source ? source.innerText || source.textContent || '' : '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 新增：带自动滚动的提取函数（注入到页面中执行）
function grabPageTextWithScroll(config) {
  // config = { interval, wait, maxScroll }
  return new Promise((resolve) => {
    const source = document.body || document.documentElement;
    if (!source) { resolve(''); return; }

    let scrolls = 0;
    const maxScroll = config.maxScroll || 3;
    const interval = config.interval || 1000;
    const wait = config.wait || 2000;

    function doScroll() {
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'instant' });
      scrolls++;
      if (scrolls < maxScroll) {
        setTimeout(doScroll, interval);
      } else {
        // 滚动到底
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        // 等待内容稳定
        setTimeout(() => {
          window.scrollTo({ top: 0, behavior: 'instant' });
          const raw = source.innerText || source.textContent || '';
          resolve(
            raw
              .replace(/\r\n?/g, '\n')
              .replace(/[ \t\u00a0]+/g, ' ')
              .replace(/\n{3,}/g, '\n\n')
              .trim()
          );
        }, wait);
      }
    }
    doScroll();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 状态管理 ----------
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

// ---------- 窗口 / 标签页 ----------
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
    option.textContent = `窗口 ${index + 1}${win.id === currentWindowId ? ' (当前)' : ''}`;
    els.windowSelect.appendChild(option);
  });

  const fallback = currentWindowId ?? (wins[0] ? wins[0].id : null);
  const desired =
    preferredId != null && wins.some((win) => win.id === preferredId) ? preferredId : fallback;

  if (desired != null) els.windowSelect.value = String(desired);
  updateCountLine();
}

// ---------- 分段切换 ----------
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

// ---------- 结果操作 ----------
function updateActions() {
  const hasResults = results.length > 0;
  const disabled = !hasResults || running;
  els.copyBtn.disabled = disabled;
  els.downloadBtn.disabled = disabled;
  els.clearBtn.disabled = disabled;
  // 结果视图里的按钮
  if (newEls.copyBtn2) newEls.copyBtn2.disabled = disabled;
  if (newEls.downloadBtn2) newEls.downloadBtn2.disabled = disabled;
  if (newEls.clearBtn2) newEls.clearBtn2.disabled = disabled;
}

function setResultsOpen(open) {
  els.resultsPanel.classList.toggle('hidden', !open);
  els.resultsToggle.classList.toggle('open', open);
  els.resultsToggle.setAttribute('aria-expanded', String(open));
}

function resetResults() {
  results = [];
  els.results.innerHTML = '';
  els.emptyHint.classList.add('hidden');
  setResultsOpen(false);
  updateActions();
}

function addResult(item) {
  results.push(item);

  els.emptyHint.classList.add('hidden');

  // 使用自定义卡片 HTML（替代原 details/summary 以匹配新设计）
  const card = document.createElement('div');
  card.className = 'result-card';

  const head = document.createElement('div');
  head.className = 'result-head';
  const title = document.createElement('span');
  title.className = 'result-title';
  title.textContent = item.title || item.url || '未命名页面';
  const meta = document.createElement('span');
  meta.className = 'result-meta';
  meta.textContent = item.error ? '失败' : `${item.text.length} 字`;
  head.append(title, meta);

  const url = document.createElement('div');
  url.className = 'result-url';
  url.textContent = item.url || '';

  const pre = document.createElement('pre');
  pre.className = 'result-body';
  pre.textContent = item.text || '（无文本）';

  let expanded = false;
  head.addEventListener('click', () => {
    expanded = !expanded;
    pre.style.display = expanded ? '' : 'none';
    url.style.display = expanded ? '' : 'none';
  });
  pre.style.display = 'none';
  url.style.display = 'none';

  card.append(head, url, pre);
  els.results.appendChild(card);

  setResultsOpen(true);
  updateActions();
}

// ---------- 提取核心 ----------
async function extractTab(tabId, url) {
  // 自动滚动仅在 http(s) 页面生效
  if (autoScroll.enabled && /^https?:\/\//i.test(url || '')) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: grabPageTextWithScroll,
      args: [autoScroll],
    });
    return (injection && injection.result) || '';
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: grabPageText,
  });
  return (injection && injection.result) || '';
}

function normalizeUrl(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

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
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === 'complete') finish();
      })
      .catch(finish);
  });
}

// ---------- 进度视图更新 ----------
function updateProgressUI(current, total, success, failure, subText) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  // 环形进度条（stroke-dashoffset）
  const CIRC = 2 * Math.PI * 15.915;
  newEls.ringFill.style.strokeDasharray = `${CIRC}, ${CIRC}`;
  newEls.ringFill.style.strokeDashoffset = `${CIRC * (1 - pct / 100)}`;

  newEls.ringCurrent.textContent = current;
  newEls.ringTotal.textContent = total;
  newEls.linearFill.style.width = `${pct}%`;
  newEls.statSuccess.textContent = success;
  newEls.statFailure.textContent = failure;
  if (subText) newEls.progressSub.textContent = subText;
}

// ---------- 运行生命周期 ----------
function beginRun(total) {
  resetResults();
  running = true;
  cancelled = false;
  els.startBtn.disabled = true;
  els.windowSelect.disabled = true;
  els.segButtons.forEach((btn) => (btn.disabled = true));
  els.urlInput.disabled = true;
  setStatus('running', '准备中…');

  // 切到进度视图
  updateProgressUI(0, total, 0, 0, '准备中…');
  switchView(VIEW.PROGRESS);
  updateActions();
}

async function endRun(doneStats) {
  running = false;
  els.startBtn.disabled = false;
  els.windowSelect.disabled = false;
  els.segButtons.forEach((btn) => (btn.disabled = false));
  els.urlInput.disabled = false;
  updateActions();

  const selectedId = Number(els.windowSelect.value);
  try {
    await loadWindows(selectedId);
  } catch { /* ignore */ }

  // 切到结果视图
  if (doneStats && !cancelled) {
    const { total, success, failure } = doneStats;
    if (failure === 0) {
      setStatus('done', `已成功提取 ${total} 个页面`);
    } else {
      setStatus('done', `完成 ${total} 个，成功 ${success}，失败 ${failure}`);
    }
    newEls.resultSummary.textContent = `共 ${total} 个标签页，成功 ${success} 个，失败 ${failure} 个`;
    switchView(VIEW.RESULT);
  } else if (cancelled) {
    setStatus('idle', '任务已取消');
    switchView(VIEW.MAIN);
  } else {
    switchView(VIEW.MAIN);
  }
}

// ---------- 提取流程：标签页 ----------
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

  beginRun(targets.length);

  let success = 0;
  let failure = 0;

  try {
    for (let i = 0; i < targets.length; i++) {
      if (cancelled) break;

      const tab = targets[i];
      updateProgressUI(
        i,
        targets.length,
        success,
        failure,
        `正在处理第 ${i + 1} 个标签页：${shorten(tab.title || tab.url)}`
      );
      setStatus('running', `(${i + 1}/${targets.length}) ${shorten(tab.title || tab.url)}`);

      try {
        const text = await extractTab(tab.id, tab.url);
        addResult({ title: tab.title, url: tab.url, text });
        success++;
      } catch (err) {
        addResult({
          title: tab.title,
          url: tab.url,
          text: `[提取失败] ${err.message}`,
          error: true,
        });
        failure++;
      }
    }

    updateProgressUI(targets.length, targets.length, success, failure, '全部处理完成');
    const skippedCount = skipped - targets.length;
    setStatus(
      'done',
      cancelled
        ? '任务已取消'
        : `已提取 ${targets.length} 个页面${skippedCount ? `，跳过 ${skippedCount} 个无法访问的页面` : ''}`
    );
  } catch (err) {
    setStatus('error', `提取出错：${err.message}`);
  } finally {
    await endRun({ total: targets.length, success, failure });
  }
}

// ---------- 提取流程：URL ----------
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

  beginRun(urls.length);

  let success = 0;
  let failure = 0;

  try {
    for (let i = 0; i < urls.length; i++) {
      if (cancelled) break;

      const url = urls[i];
      updateProgressUI(i, urls.length, success, failure, `正在打开：${shorten(url)}`);
      setStatus('running', `(${i + 1}/${urls.length}) 正在打开：${shorten(url)}`);

      let tabId;
      try {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
        await waitForTabComplete(tabId);
        await sleep(500);

        let text;
        if (autoScroll.enabled) {
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId },
            func: grabPageTextWithScroll,
            args: [autoScroll],
          });
          text = (injection && injection.result) || '';
        } else {
          text = await extractTab(tab.id, tab.url);
        }

        let title = url;
        try {
          const info = await chrome.tabs.get(tabId);
          title = info.title || url;
        } catch { /* ignore */ }

        addResult({ title, url, text });
        success++;
      } catch (err) {
        addResult({
          title: url,
          url,
          text: `[提取失败] ${err.message}`,
          error: true,
        });
        failure++;
      } finally {
        if (tabId != null) {
          try { await chrome.tabs.remove(tabId); } catch { /* ignore */ }
        }
      }
    }

    updateProgressUI(urls.length, urls.length, success, failure, '全部处理完成');
    setStatus(
      'done',
      cancelled
        ? '任务已取消'
        : `已处理 ${urls.length} 个链接${invalidCount ? `，忽略 ${invalidCount} 个无效链接` : ''}`
    );
  } catch (err) {
    setStatus('error', `提取出错：${err.message}`);
  } finally {
    await endRun({ total: urls.length, success, failure });
  }
}

// ---------- 结果导出 ----------
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

// ---------- 区域选择（当前页点选 / 记住选择器） ----------

// 注入到页面中执行：按 CSS 选择器提取元素文本
function extractBySelector(selector) {
  try {
    const el = document.querySelector(selector);
    if (!el) return '';
    const raw = el.innerText || el.textContent || '';
    return raw
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return '';
  }
}

// 启动页面选择器：注入 picker.js 后关闭弹窗，等待用户在页面中选择
async function startPicker(mode) {
  if (running) return;

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    // ignore
  }

  if (!tab || !isExtractable(tab.url)) {
    setStatus('error', '当前标签页不支持区域选择（仅支持 http/https 页面）');
    return;
  }

  try {
    await chrome.storage.local.set({ tabharvestPickerMode: mode });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] });
    window.close();
  } catch (err) {
    setStatus('error', `无法启动区域选择：${err.message}`);
  }
}

// 弹窗重新打开时，读取页面选择器写入的结果并显示确认视图
async function checkPickerResult() {
  let picked = null;
  try {
    const stored = await chrome.storage.local.get('tabharvestPicked');
    picked = stored && stored.tabharvestPicked;
    if (picked) await chrome.storage.local.remove('tabharvestPicked');
  } catch {
    // ignore
  }
  if (!picked) return;

  pendingPick = picked;

  const isRemember = picked.mode === 'remember';
  const previewText = picked.text || '';
  newEls.pickerHint.textContent = isRemember
    ? '已记住该元素的选择器'
    : '已从页面选中以下区域';
  newEls.pickerPreviewText.textContent = previewText.length > 400
    ? `${previewText.slice(0, 400)}…`
    : previewText;
  newEls.pickerSelectorText.textContent = picked.selector || '';
  newEls.pickerConfirmBtn.textContent = isRemember ? '应用到所选标签页' : '提取该区域';

  setStatus('idle', isRemember ? '已记住选择器，确认后批量应用' : '已选中区域，确认后提取');
  switchView(VIEW.PICKER);
}

// 确认区域选择：提取当前元素 / 将选择器应用到全部标签页
async function confirmPicker() {
  if (!pendingPick) {
    switchView(VIEW.MAIN);
    return;
  }

  const picked = pendingPick;
  pendingPick = null;

  if (picked.mode === 'remember' && picked.selector) {
    showSelectorPanel(picked.selector);
    await applySelectorToTabs();
    return;
  }

  // 当前页点选：直接使用已捕获的文本
  resetResults();
  addResult({ title: picked.title, url: picked.url, text: picked.text || '' });
  newEls.resultSummary.textContent = '已提取 1 个页面（所选区域）';
  setStatus('done', '已提取所选区域文本');
  switchView(VIEW.RESULT);
}

function cancelPicker() {
  pendingPick = null;
  switchView(VIEW.MAIN);
  setStatus('idle', '已取消区域选择');
}

function showSelectorPanel(selector) {
  currentSelector = selector;
  if (!newEls.selectorPanel) return;
  newEls.selectorText.textContent = selector;
  newEls.selectorPanel.classList.remove('hidden');
  switchView(VIEW.MAIN);
  newEls.selectorPanel.scrollIntoView({ block: 'nearest' });
}

function clearSelectorPanel() {
  currentSelector = null;
  newEls.selectorPanel?.classList.add('hidden');
}

// 将记住的选择器应用到当前窗口的全部标签页
async function applySelectorToTabs() {
  if (running || !currentSelector) return;

  const win = selectedWindow();
  if (!win) {
    setStatus('error', '没有可用的浏览器窗口');
    return;
  }

  let tabs = await chrome.tabs.query({ windowId: win.id });
  tabs = tabs.filter((tab) => tab.id != null && isExtractable(tab.url));

  if (!tabs.length) {
    setStatus('error', '该窗口没有可提取的标签页');
    return;
  }

  if (newEls.selectorApplyBtn) newEls.selectorApplyBtn.disabled = true;
  const selector = currentSelector;
  beginRun(tabs.length);

  let success = 0;
  let failure = 0;

  try {
    for (let i = 0; i < tabs.length; i++) {
      if (cancelled) break;

      const tab = tabs[i];
      updateProgressUI(
        i,
        tabs.length,
        success,
        failure,
        `正在处理第 ${i + 1} 个标签页：${shorten(tab.title || tab.url)}`
      );
      setStatus('running', `(${i + 1}/${tabs.length}) ${shorten(tab.title || tab.url)}`);

      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractBySelector,
          args: [selector],
        });
        const text = (injection && injection.result) || '';

        if (!text) {
          addResult({
            title: tab.title,
            url: tab.url,
            text: `[未找到匹配元素] ${selector}`,
            error: true,
          });
          failure++;
        } else {
          addResult({ title: tab.title, url: tab.url, text });
          success++;
        }
      } catch (err) {
        addResult({
          title: tab.title,
          url: tab.url,
          text: `[提取失败] ${err.message}`,
          error: true,
        });
        failure++;
      }
    }

    updateProgressUI(tabs.length, tabs.length, success, failure, '全部处理完成');
    setStatus(
      'done',
      cancelled
        ? '任务已取消'
        : `已应用选择器，成功 ${success} 个，失败 ${failure} 个`
    );
  } catch (err) {
    setStatus('error', `提取出错：${err.message}`);
  } finally {
    if (newEls.selectorApplyBtn) newEls.selectorApplyBtn.disabled = false;
    await endRun({ total: tabs.length, success, failure });
  }
}

// ---------- 自定义下拉（替代原生 select 外观，保留原有 value / change 契约） ----------
const customSelects = [];

function syncCustomSelects() {
  customSelects.forEach((item) => item.sync());
}

function closeCustomDropdowns(except) {
  customSelects.forEach((item) => {
    if (item.dd !== except) item.close();
  });
}

function enhanceSelect(select) {
  if (!select || select.dataset.ddReady === '1') return;
  select.dataset.ddReady = '1';
  select.classList.add('dd-native');

  const dd = document.createElement('div');
  dd.className = 'dd';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dd-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const valueText = document.createElement('span');
  valueText.className = 'dd-value';

  const arrow = document.createElement('span');
  arrow.className = 'dd-arrow';
  arrow.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

  trigger.append(valueText, arrow);

  const menu = document.createElement('div');
  menu.className = 'dd-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  dd.append(trigger, menu);
  select.parentNode.insertBefore(dd, select);

  const wrap = select.closest('.select-wrap');
  if (wrap) wrap.classList.add('is-enhanced');

  let activeIndex = -1;
  const items = () => Array.from(menu.children);
  const isOpen = () => !menu.hidden;

  function setActive(index) {
    activeIndex = index;
    const list = items();
    list.forEach((el, i) => el.classList.toggle('active', i === index));
    const el = list[index];
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }

  function sync() {
    const idx = select.selectedIndex;
    const opt = select.options[idx];
    valueText.textContent = opt ? opt.textContent : '请选择';
    trigger.disabled = select.disabled;
    items().forEach((el, i) => {
      const on = i === idx;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    activeIndex = idx;
  }

  function rebuild() {
    menu.replaceChildren();
    Array.from(select.options).forEach((opt, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dd-option';
      item.setAttribute('role', 'option');

      const text = document.createElement('span');
      text.className = 'dd-option-text';
      text.textContent = opt.textContent;

      const check = document.createElement('span');
      check.className = 'dd-check';
      check.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

      item.append(text, check);
      item.addEventListener('click', () => choose(index));
      menu.appendChild(item);
    });
    sync();
  }

  function open() {
    if (select.disabled || isOpen()) return;
    closeCustomDropdowns(dd);
    rebuild();
    menu.hidden = false;
    dd.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    setActive(select.selectedIndex);
  }

  function close() {
    if (!isOpen()) return;
    menu.hidden = true;
    dd.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  function choose(index) {
    const changed = select.selectedIndex !== index;
    close();
    trigger.focus();
    if (index < 0 || index >= select.options.length) return;
    select.selectedIndex = index;
    sync();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) {
        open();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        choose(activeIndex);
        return;
      }
      const max = items().length - 1;
      const next = e.key === 'ArrowDown'
        ? Math.min(max, activeIndex + 1)
        : Math.max(0, activeIndex - 1);
      setActive(next);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      close();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !dd.contains(e.target)) close();
  });

  // options 或 disabled 变化时自动重新同步
  new MutationObserver(() => (isOpen() ? sync() : rebuild()))
    .observe(select, { childList: true, attributes: true, attributeFilter: ['disabled'] });

  rebuild();
  customSelects.push({ dd, close, sync });
}

function enhanceAllSelects() {
  [els.windowSelect, newEls.cfgInterval, newEls.cfgWait, newEls.cfgMaxScroll, newEls.cfgTimeout]
    .forEach(enhanceSelect);
}

// ---------- 事件绑定 ----------

// 开始提取
els.startBtn.addEventListener('click', () => {
  if (scope === 'custom') extractFromUrls();
  else extractFromTabs();
});

// 分段切换
els.segButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (running) return;
    setScope(btn.dataset.scope);
  });
});

// 窗口选择
els.windowSelect.addEventListener('change', async () => {
  const win = selectedWindow();
  if (win) {
    try { win.tabs = await chrome.tabs.query({ windowId: win.id }); } catch { /* ignore */ }
  }
  updateCountLine();
});

// 结果展开/收起
els.resultsToggle.addEventListener('click', () => {
  setResultsOpen(els.resultsPanel.classList.contains('hidden'));
});

// 底部功能栏
els.copyBtn.addEventListener('click', copyAll);
els.downloadBtn.addEventListener('click', downloadAll);
els.clearBtn.addEventListener('click', clearAll);

// 结果视图里的按钮
newEls.copyBtn2?.addEventListener('click', copyAll);
newEls.downloadBtn2?.addEventListener('click', downloadAll);
newEls.clearBtn2?.addEventListener('click', clearAll);
newEls.viewResultBtn?.addEventListener('click', () => switchView(VIEW.MAIN));

// 设置（打开扩展设置页）
els.settingsBtn.addEventListener('click', () => {
  chrome.tabs
    .create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
    .catch(() => chrome.tabs.create({ url: 'chrome://extensions/' }));
});

// 关闭弹窗
newEls.closeBtn?.addEventListener('click', () => window.close());

// 自动滚动开关
newEls.autoScrollToggle?.addEventListener('change', (e) => {
  autoScroll.enabled = e.target.checked;
  refreshAutoScrollUI();
  saveAutoScroll();
});

// 展开/收起配置
newEls.autoScrollExpand?.addEventListener('click', () => {
  autoScroll.expandConfig = !autoScroll.expandConfig;
  refreshAutoScrollUI();
  saveAutoScroll();
});

// 配置项变更
[newEls.cfgInterval, newEls.cfgWait, newEls.cfgMaxScroll, newEls.cfgTimeout].forEach((el) => {
  el?.addEventListener('change', () => {
    autoScroll.interval = Number(newEls.cfgInterval.value);
    autoScroll.wait = Number(newEls.cfgWait.value);
    autoScroll.maxScroll = Number(newEls.cfgMaxScroll.value);
    autoScroll.timeout = Number(newEls.cfgTimeout.value);
    refreshAutoScrollUI();
    saveAutoScroll();
  });
});

// 进度视图 - 取消
newEls.cancelBtn?.addEventListener('click', () => {
  cancelled = true;
  setStatus('idle', '正在取消…');
});

// 当前页点选区域：隐藏弹窗，进入页面选择
newEls.pickElementBtn?.addEventListener('click', () => startPicker('pick'));

// 记住选择器：隐藏弹窗，选择后应用到全部标签页
newEls.rememberSelectorBtn?.addEventListener('click', () => startPicker('remember'));

// 区域选择确认视图
newEls.pickerConfirmBtn?.addEventListener('click', confirmPicker);
newEls.pickerBackBtn?.addEventListener('click', cancelPicker);
newEls.pickerCloseBtn?.addEventListener('click', cancelPicker);

// 已记住的选择器面板
newEls.selectorApplyBtn?.addEventListener('click', applySelectorToTabs);
newEls.selectorCloseBtn?.addEventListener('click', () => {
  clearSelectorPanel();
  setStatus('idle', '已移除选择器');
});

// ---------- 初始化 ----------
(async function init() {
  try {
    enhanceAllSelects();
    await loadAutoScroll();
    await loadWindows();
    await checkPickerResult();
  } catch (err) {
    setStatus('error', `初始化失败：${err.message}`);
    els.tabCountLine.textContent = '无法读取窗口信息';
  }
})();
