// URL orchestrator: в Docker используется localhost:8001 (проброшенный порт), для локальной разработки тоже localhost:8001
const ORCHESTRATOR_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:8001/api/message'
  : ;

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
    actionButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            sendAction(action);
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

    try {
        const response = await fetch(ORCHESTRATOR_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                tenant_id: 'studio_nexa',
                channel: 'simulator',
                user_id: 'test_user',
                text: action,
                scenario: currentScenario,
                action_type: 'button'
            })
        });

        const data = await response.json();
        handleResponse(data);
    } catch (error) {
        console.error('Ошибка при отправке действия:', error);
        addBotMessage('Ошибка соединения с сервером. Проверьте, запущен ли orchestrator.');
    }
}

async function sendMessage(text) {
    if (!currentScenario) {
        addSystemMessage('Пожалуйста, сначала выберите сценарий');
        return;
    }

    lastAction = `Текст: ${text}`;
    updateDebugPanel();

    addUserMessage(text);

    try {
        const response = await fetch(ORCHESTRATOR_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                tenant_id: 'studio_nexa',
                channel: 'simulator',
                user_id: 'test_user',
                text: text,
                scenario: currentScenario,
                action_type: 'text'
            })
        });

        const data = await response.json();
        handleResponse(data);
    } catch (error) {
        console.error('Ошибка при отправке сообщения:', error);
        addBotMessage('Ошибка соединения с сервером. Проверьте, запущен ли orchestrator.');
    }
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
