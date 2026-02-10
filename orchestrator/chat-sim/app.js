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
