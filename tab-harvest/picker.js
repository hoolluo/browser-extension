/* ============================================================
   TabHarvest — 页面区域选择器（由 popup 通过 chrome.scripting 注入）
   拖拽框选任意区域 -> 收集区域内文本节点 -> 写入 chrome.storage.local
   -> 请求 background 重新打开 popup（由 popup 显示预览并确认提取）
   ============================================================ */
(() => {
  'use strict';

  // 若已有实例，先静默取消
  if (typeof window.__TABHARVEST_PICKER_CANCEL__ === 'function') {
    try { window.__TABHARVEST_PICKER_CANCEL__(); } catch (e) { /* ignore */ }
  }

  let mode = 'pick';            // 'pick' 当前页提取 | 'remember' 记住选择器
  let destroyed = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let toastTimer = null;

  // ---------- 注入样式 ----------
  const oldStyle = document.getElementById('thp-style');
  if (oldStyle) oldStyle.remove();

  const styleEl = document.createElement('style');
  styleEl.id = 'thp-style';
  styleEl.textContent = [
    '.thp-overlay{position:fixed;inset:0;z-index:2147483646;cursor:crosshair;',
    'background:rgba(24,119,242,.04);user-select:none;-webkit-user-select:none;}',
    '.thp-marquee{position:absolute;border:2px solid #1877F2;background:rgba(24,119,242,.12);',
    'border-radius:3px;display:none;pointer-events:none;box-sizing:border-box;}',
    '.thp-hintbar{position:fixed;top:16px;left:50%;transform:translateX(-50%);',
    'background:rgba(17,24,39,.92);color:#fff;',
    'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;',
    'padding:8px 16px;border-radius:18px;z-index:2147483647;pointer-events:none;',
    'box-shadow:0 8px 24px rgba(0,0,0,.25);white-space:nowrap;}'
  ].join('');
  document.documentElement.appendChild(styleEl);

  // ---------- DOM ----------
  const overlay = document.createElement('div');
  overlay.className = 'thp-overlay';

  const marquee = document.createElement('div');
  marquee.className = 'thp-marquee';
  overlay.appendChild(marquee);

  const hint = document.createElement('div');
  hint.className = 'thp-hintbar';
  hint.textContent = '拖拽选择任意区域 · 按 ESC 取消';

  document.documentElement.append(overlay, hint);

  // ---------- 工具函数 ----------
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${cssEscape(el.id)}`;

    const parts = [];
    let node = el;
    let depth = 0;

    while (node && node.nodeType === 1 && depth < 6) {
      const name = node.localName;
      if (!name || name === 'html' || name === 'body') break;

      let part = name;
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.localName === name);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);

      if (node.id) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      node = parent;
      depth += 1;
    }

    return parts.join(' > ');
  }

  function isOurs(el) {
    return !!(el && el.closest && el.closest('.thp-overlay,.thp-hintbar,.thp-toast'));
  }

  function toast(message, duration = 2000) {
    let t = document.getElementById('thp-toast');
    if (t) t.remove();

    t = document.createElement('div');
    t.id = 'thp-toast';
    t.className = 'thp-toast';
    t.textContent = message;
    t.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
      'background:#111827', 'color:#fff',
      'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'font-size:12px', 'padding:9px 16px', 'border-radius:20px', 'z-index:2147483647',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)', 'opacity:1', 'transition:opacity .25s',
      'pointer-events:none'
    ].join(';');
    document.documentElement.appendChild(t);

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 260);
    }, duration);
  }

  // 当前位置对应的选框（支持任意方向拖拽）
  function currentRect(x, y) {
    return {
      left: Math.min(startX, x),
      top: Math.min(startY, y),
      width: Math.abs(x - startX),
      height: Math.abs(y - startY),
    };
  }

  function paintMarquee(rect) {
    marquee.style.left = `${rect.left}px`;
    marquee.style.top = `${rect.top}px`;
    marquee.style.width = `${rect.width}px`;
    marquee.style.height = `${rect.height}px`;
  }

  // 收集与选框相交的文本节点（按所在块级容器分行）
  function collectText(rect) {
    const root = document.body || document.documentElement;
    if (!root) return '';

    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || isOurs(parent)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script,style,noscript,template,svg')) return NodeFilter.FILTER_REJECT;

        const cs = window.getComputedStyle(parent);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const blocks = new Map();
    let node = walker.nextNode();

    while (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();

      let hit = false;
      for (let i = 0; i < rects.length; i += 1) {
        const r = rects[i];
        if (
          r.width > 0 && r.height > 0 &&
          r.left < right && r.right > rect.left &&
          r.top < bottom && r.bottom > rect.top
        ) {
          hit = true;
          break;
        }
      }

      if (hit) {
        const text = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (text) {
          const parent = node.parentElement;
          const container =
            parent.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,div,section,article,label,a,button') ||
            parent;
          if (!blocks.has(container)) blocks.set(container, []);
          blocks.get(container).push(text);
        }
      }

      node = walker.nextNode();
    }

    const lines = [];
    blocks.forEach((pieces) => {
      const line = pieces.join(' ').replace(/\s+/g, ' ').trim();
      if (line) lines.push(line);
    });
    return lines.join('\n').trim();
  }

  // 选框中心点对应的元素（用于生成选择器）
  function elementAt(x, y) {
    overlay.style.pointerEvents = 'none';
    hint.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    overlay.style.pointerEvents = '';
    hint.style.display = '';
    return el && !isOurs(el) ? el : null;
  }

  // ---------- 拖拽事件 ----------
  function onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    dragging = true;
    startX = e.clientX;
    startY = e.clientY;

    marquee.style.display = 'block';
    paintMarquee({ left: startX, top: startY, width: 0, height: 0 });
    hint.textContent = '松开鼠标完成选择 · 按 ESC 取消';
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    paintMarquee(currentRect(e.clientX, e.clientY));
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;

    const rect = currentRect(e.clientX, e.clientY);
    marquee.style.display = 'none';
    hint.textContent = '拖拽选择任意区域 · 按 ESC 取消';

    // 过小的拖拽视为误触
    if (rect.width < 6 || rect.height < 6) return;

    const text = collectText(rect);
    if (!text) {
      toast('此区域内没有可提取的文本，请重新框选');
      return;
    }

    const centerEl = elementAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const payload = {
      mode,
      selector: selectorOf(centerEl),
      text,
      title: document.title,
      url: location.href,
      timestamp: Date.now(),
    };

    const finish = () => {
      cleanup();
      try { chrome.storage.local.remove('tabharvestPickerMode'); } catch (e) { /* ignore */ }
      try {
        chrome.runtime.sendMessage({ type: 'tabharvest:open-popup' }, (res) => {
          // 读取最后错误以避免 "Unchecked runtime.lastError"
          void chrome.runtime.lastError;
          if (res && res.ok) {
            toast('已选中区域，正在打开插件…', 1500);
          } else {
            toast('已选中区域，请点击插件图标确认', 2600);
          }
        });
      } catch (e) {
        toast('已选中区域，请点击插件图标确认', 2600);
      }
    };

    try {
      chrome.storage.local.set({ tabharvestPicked: payload }, finish);
    } catch (e) {
      finish();
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      try { chrome.storage.local.remove('tabharvestPickerMode'); } catch (e) { /* ignore */ }
      toast('已取消选择', 1500);
    }
  }

  // ---------- 清理 ----------
  function cleanup() {
    if (destroyed) return;
    destroyed = true;

    overlay.removeEventListener('mousedown', onDown, true);
    overlay.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('keydown', onKey, true);

    overlay.remove();
    hint.remove();
    styleEl.remove();
    window.__TABHARVEST_PICKER_CANCEL__ = null;
  }

  // ---------- 启动 ----------
  function start() {
    overlay.addEventListener('mousedown', onDown, true);
    overlay.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);

    window.__TABHARVEST_PICKER_CANCEL__ = () => cleanup();
    toast('拖拽框选要提取的区域，按 ESC 取消', 2800);
  }

  try {
    chrome.storage.local.get('tabharvestPickerMode', (data) => {
      if (destroyed) return;
      mode = (data && data.tabharvestPickerMode) || 'pick';
      start();
    });
  } catch (e) {
    mode = 'pick';
    start();
  }
})();
