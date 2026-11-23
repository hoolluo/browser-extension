// 后台逻辑：接收页面选择器的完成消息，尝试重新打开 popup
// （chrome.action.openPopup 需要 Chrome 127+，失败时回告诉页面脚本，由用户手动点击图标）

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'tabharvest:open-popup') {
        try {
            if (chrome.action && typeof chrome.action.openPopup === 'function') {
                chrome.action
                    .openPopup()
                    .then(() => sendResponse({ ok: true }))
                    .catch(() => sendResponse({ ok: false }));
            } else {
                sendResponse({ ok: false });
            }
        } catch (e) {
            sendResponse({ ok: false });
        }
        return true; // 异步响应
    }
    return false;
});
