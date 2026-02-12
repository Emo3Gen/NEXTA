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

    window.safeDebug?.(data);

    const text = data.response || data.text || data.reply;
    if (text) {
        addBotMessage(text);
    } else {
        addBotMessage('Получен ответ без текста');
    }

    if (data.quick_actions && Array.isArray(data.quick_actions) && data.quick_actions.length) {
        addQuickActionsChips(data.quick_actions);
    }
}

function addQuickActionsChips(actions) {
    const container = document.getElementById('chatMessages');
    const wrap = document.createElement('div');
    wrap.className = 'quick-actions-chips';
    actions.forEach((label) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qa-chip';
        btn.textContent = label;
        btn.addEventListener('click', () => {
            wrap.remove();
            if (currentScenario) {
                sendMessage(label);
            }
        });
        wrap.appendChild(btn);
    });
    container.appendChild(wrap);
    scrollToBottom();
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

function updateDebugPanel() {
    document.getElementById('debugScenario').textContent = currentScenario || '—';
    document.getElementById('debugIntent').textContent = lastIntent || '—';
    document.getElementById('debugAction').textContent = lastAction || '—';
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

// === DEBUG DROPDOWN (top-right). Enabled only with ?debug=1 ===
(function initDebugDropdown() {
  const DEBUG_ENABLED = new URLSearchParams(window.location.search).has('debug');
  if (!DEBUG_ENABLED) {
    window.safeDebug = function () {};
    return;
  }

  function ensureUI() {
    // Button
    let btn = document.getElementById('debugToggleBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'debugToggleBtn';
      btn.type = 'button';
      btn.textContent = '🐞 Debug';
      document.body.appendChild(btn);
    }

    // Panel (dropdown)
    let panel = document.getElementById('debugDropdown');
    if (!panel) {
      panel = document.createElement('pre');
      panel.id = 'debugDropdown';
      panel.className = 'hidden';
      panel.textContent = 'Debug enabled. Waiting for data…';
      document.body.appendChild(panel);
    }

    // Styles (inline to avoid touching CSS and layout)
    btn.style.cssText = [
      'position:fixed',
      'top:12px',
      'right:12px',
      'z-index:10000',
      'padding:8px 10px',
      'border-radius:12px',
      'border:1px solid rgba(0,0,0,0.12)',
      'background:rgba(255,255,255,0.9)',
      'backdrop-filter:blur(10px)',
      '-webkit-backdrop-filter:blur(10px)',
      'font-size:13px',
      'cursor:pointer'
    ].join(';');

    panel.style.cssText = [
      'position:fixed',
      'top:52px',
      'right:12px',
      'z-index:10000',
      'width:min(520px, calc(100vw - 24px))',
      'max-height:60vh',
      'overflow:auto',
      'padding:10px 12px',
      'border-radius:14px',
      'border:1px solid rgba(0,0,0,0.12)',
      'background:rgba(255,255,255,0.92)',
      'backdrop-filter:blur(14px)',
      '-webkit-backdrop-filter:blur(14px)',
      'box-shadow:0 12px 40px rgba(0,0,0,0.18)',
      'font-size:12px',
      'line-height:1.3',
      'color:rgba(0,0,0,0.9)',
      'white-space:pre-wrap'
    ].join(';');

    // Ensure .hidden works even if CSS doesn't have it
    function hide() { panel.classList.add('hidden'); panel.style.display = 'none'; }
    function show() { panel.classList.remove('hidden'); panel.style.display = 'block'; }
    function toggle() { (panel.style.display === 'block') ? hide() : show(); }

    // Start hidden
    hide();

    btn.onclick = toggle;

    // Close on outside click / Esc
    document.addEventListener('click', (e) => {
      if (e.target === btn || panel.contains(e.target)) return;
      hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
    });

    return { btn, panel, show, hide };
  }

  const ui = ensureUI();

  // Safe debug writer (never breaks UI)
  window.safeDebug = function safeDebug(data) {
    if (!ui || !ui.panel) return;
    try {
      const payload = (data && data._debug) ? data._debug : data;
      ui.panel.textContent = JSON.stringify(payload, null, 2);
      // не раскрываем автоматически — открывается по кнопке
    } catch (e) {
      ui.panel.textContent = 'DEBUG stringify error: ' + (e && e.message ? e.message : String(e));
    }
  };
})();
