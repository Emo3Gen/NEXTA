// === GLOBAL ERROR TRAP (so UI never fails silently) ===
(function () {
  function writeToDebug(msg) {
    const panel = document.getElementById('debugPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.textContent = String(msg);
  }

  window.addEventListener('error', (e) => {
    const msg = [
      'JS ERROR:',
      e.message || '(no message)',
      e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : '',
      e.error && e.error.stack ? `\n${e.error.stack}` : ''
    ].filter(Boolean).join('\n');
    writeToDebug(msg);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const msg = [
      'UNHANDLED PROMISE REJECTION:',
      (r && r.message) ? r.message : String(r),
      (r && r.stack) ? `\n${r.stack}` : ''
    ].filter(Boolean).join('\n');
    writeToDebug(msg);
  });

  // Also mirror console.error into the overlay
  const origErr = console.error.bind(console);
  console.error = (...args) => {
    origErr(...args);
    try {
      writeToDebug('console.error:\n' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    } catch {
      writeToDebug('console.error (non-serializable args)');
    }
  };
})();

// URL orchestrator: в Docker используется localhost:8001 (проброшенный порт), для локальной разработки тоже localhost:8001
const ORCHESTRATOR_URL =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8001/api/message'
    : '/api/message';

// === Mobile UX feedback helpers (v0.1.3) ===
function ensureUiFeedback() {
  if (document.getElementById('__nexa_toast')) return;

  const toastEl = document.createElement('div');
  toastEl.id = '__nexa_toast';
  toastEl.style.cssText = `
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    padding: 10px 12px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.2;
    background: rgba(20,20,20,0.92);
    color: #fff;
    z-index: 9999;
    display: none;
    pointer-events: none;
    white-space: pre-wrap;
  `;
  document.body.appendChild(toastEl);

  const overlay = document.createElement('div');
  overlay.id = '__nexa_error';
  overlay.style.cssText = `
    position: fixed;
    left: 12px;
    right: 12px;
    top: 12px;
    padding: 10px 12px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.25;
    background: rgba(180, 30, 30, 0.95);
    color: #fff;
    z-index: 9999;
    display: none;
    white-space: pre-wrap;
  `;
  document.body.appendChild(overlay);
}

function toast(msg, ms = 1200) {
  ensureUiFeedback();
  const el = document.getElementById('__nexa_toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => {
    el.style.display = 'none';
  }, ms);
}

function showError(msg) {
  ensureUiFeedback();
  const el = document.getElementById('__nexa_error');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => {
    el.style.display = 'none';
  }, 6000);
}

// Optional: mark buttons as loading
function setBtnLoading(btn, isLoading) {
  if (!btn) return;
  if (isLoading) {
    btn.dataset.__nexaPrevText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;
    btn.style.opacity = '0.7';
  } else {
    if (btn.dataset.__nexaPrevText) btn.textContent = btn.dataset.__nexaPrevText;
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

let currentScenario = '';
let lastIntent = '';
let lastAction = '';

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
    const scenarioSelect = document.getElementById('scenario');
    const actionButtons = document.querySelectorAll('.action-btn');
    const sendBtn = document.getElementById('sendBtn');
    const messageInput = document.getElementById('messageInput');

    // Обработчик выбора сценария
    scenarioSelect.addEventListener('change', (e) => {
        currentScenario = e.target.value;
        updateDebugPanel();
        
        if (currentScenario) {
            addSystemMessage(`Выбран сценарий: ${currentScenario}`);
        }
    });

    // Обработчики кнопок быстрых действий
    actionButtons.forEach((btn) => {
        btn.addEventListener('click', async (event) => {
            toast('Нажатие…', 600);
            const btnEl = event.target.closest('button');
            const textToSend = btnEl?.dataset?.prompt || btnEl?.textContent?.trim() || '';
            if (!textToSend) return;
            setBtnLoading(btnEl, true);
            try {
                await sendAction(textToSend);
            } finally {
                setBtnLoading(btnEl, false);
            }
        });
    });

    // Обработчик отправки текстового сообщения
    sendBtn.addEventListener('click', () => {
        const text = messageInput.value.trim();
        if (text) {
            sendMessage(text);
            messageInput.value = '';
        }
    });

    // Отправка по Enter
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendBtn.click();
        }
    });
});

async function sendAction(action) {
    if (!currentScenario) {
        addSystemMessage('Пожалуйста, сначала выберите сценарий');
        return;
    }

    lastAction = `Кнопка: ${action}`;
    updateDebugPanel();

    addUserMessage(action);

    const payload = {
        tenant_id: 'studio_nexa',
        channel: 'simulator',
        user_id: 'test_user',
        text: action,
        scenario: currentScenario,
        action_type: 'button'
    };

    // --- always send scenario + stable chat_id (v0.1.3) ---
    const scenarioEl = document.getElementById('scenario');
    const scenarioText =
      scenarioEl && scenarioEl.selectedIndex >= 0
        ? (scenarioEl.options[scenarioEl.selectedIndex].text || scenarioEl.value || '')
        : '';

    payload.meta = payload.meta || {};
    payload.meta.chat_id = payload.meta.chat_id || 'mobile_test_1';
    payload.meta.scenario = scenarioText.trim();

    toast('Отправляю…');

    let resp, data;
    try {
        resp = await fetch(ORCHESTRATOR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const text = await resp.text();
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }

        if (!resp.ok) {
            showError(`API ${resp.status}: ${data?.error || data?.raw || 'unknown error'}`);
            toast('Ошибка');
            return;
        }

        toast('Готово');
    } catch (e) {
        showError(`Network error: ${e?.message || String(e)}`);
        toast('Ошибка сети');
        return;
    }

    handleResponse(data);
}

async function sendMessage(text) {
    if (!currentScenario) {
        addSystemMessage('Пожалуйста, сначала выберите сценарий');
        return;
    }

    lastAction = `Текст: ${text}`;
    updateDebugPanel();

    addUserMessage(text);

    const payload = {
        tenant_id: 'studio_nexa',
        channel: 'simulator',
        user_id: 'test_user',
        text: text,
        scenario: currentScenario,
        action_type: 'text'
    };

    // --- always send scenario + stable chat_id (v0.1.3) ---
    const scenarioEl = document.getElementById('scenario');
    const scenarioText =
      scenarioEl && scenarioEl.selectedIndex >= 0
        ? (scenarioEl.options[scenarioEl.selectedIndex].text || scenarioEl.value || '')
        : '';

    payload.meta = payload.meta || {};
    payload.meta.chat_id = payload.meta.chat_id || 'mobile_test_1';
    payload.meta.scenario = scenarioText.trim();

    toast('Отправляю…');

    let resp, data;
    try {
        resp = await fetch(ORCHESTRATOR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const textResp = await resp.text();
        try {
            data = JSON.parse(textResp);
        } catch {
            data = { raw: textResp };
        }

        if (!resp.ok) {
            showError(`API ${resp.status}: ${data?.error || data?.raw || 'unknown error'}`);
            toast('Ошибка');
            return;
        }

        toast('Готово');
    } catch (e) {
        showError(`Network error: ${e?.message || String(e)}`);
        toast('Ошибка сети');
        return;
    }

    handleResponse(data);
}

function handleResponse(data) {
    if (data.intent) {
        lastIntent = data.intent;
        updateDebugPanel();
    }

    updateDebug(data);

    if (data.response) {
        addBotMessage(data.response);
    } else {
        addBotMessage('Получен ответ без текста');
    }
}

function addUserMessage(text) {
    const messagesContainer = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message user';
    messageDiv.innerHTML = `<p>${escapeHtml(text)}</p>`;
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function addBotMessage(text) {
    const messagesContainer = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot';
    messageDiv.innerHTML = `<p>${escapeHtml(text)}</p>`;
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function addSystemMessage(text) {
    const messagesContainer = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message system';
    messageDiv.innerHTML = `<p>${escapeHtml(text)}</p>`;
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function updateDebugPanel(data) {
  window.safeDebug?.(data ?? { scenario: currentScenario, intent: lastIntent, action: lastAction });
}

function scrollToBottom() {
    const messagesContainer = document.getElementById('chatMessages');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateDebug(data) {
  window.safeDebug?.(data);
}

// === DEBUG TOGGLE (simple) ===
(function initDebugToggle() {
  function getPanel() {
    return (
      document.getElementById('debugPanel') ||
      document.getElementById('debug-panel') ||
      document.querySelector('.debug-panel')
    );
  }

  function ensurePanel() {
    let panel = getPanel();
    if (panel) return panel;

    // Если в HTML панели нет — создаём минимально сами, чтобы ничего не ломалось
    panel = document.createElement('pre');
    panel.id = 'debugPanel';
    panel.className = 'debug-panel hidden';
    document.body.appendChild(panel);
    return panel;
  }

  function togglePanel() {
    const panel = ensurePanel();
    panel.classList.toggle('hidden');
  }

  function mountButton() {
    // Пытаемся аккуратно вставить кнопку рядом с существующими кнопками/в шапку
    const host =
      document.querySelector('.topbar') ||
      document.querySelector('.toolbar') ||
      document.querySelector('.controls') ||
      document.querySelector('header') ||
      document.body;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'debugToggleBtn';
    btn.textContent = '🐞 Debug';
    btn.style.cssText = 'margin-left:8px;';

    btn.addEventListener('click', togglePanel);

    // Если есть контейнер кнопок — вставим туда, иначе в начало body
    host.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton);
  } else {
    mountButton();
  }

  // Экспортируем безопасную функцию для записи в панель
  window.safeDebug = function safeDebug(data) {
    const panel = getPanel();
    if (!panel) return; // если пользователь не открывал debug — не тратим ресурсы
    try {
      const payload = (data && data._debug) ? data._debug : data;
      panel.textContent = JSON.stringify(payload, null, 2);
    } catch (e) {
      panel.textContent = 'DEBUG stringify error: ' + (e && e.message ? e.message : String(e));
    }
  };
})();
