# Танцуй со мной - Эмулятор v0.1.0

Продуктовый эмулятор для тестирования пользовательских сценариев без реальных чатов и DIKIDI.

## Структура проекта

```
tsm/
├── infra/
│   └── docker-compose.yml      # Docker Compose конфигурация
├── services/
│   ├── orchestrator/            # Backend API сервис
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── app/
│   │       └── main.py
│   └── chat-sim/                # Frontend веб-интерфейс
│       ├── Dockerfile
│       ├── requirements.txt
│       └── app/
│           ├── main.py
│           └── templates/
│               └── index.html
├── data/
│   └── dikidi_stub.json        # Эмуляция данных DIKIDI
├── .env.example                # Пример переменных окружения
└── README.md
```

## Порты

**Важно:** Проект "Танцуй со мной" использует следующие порты:
- `http://localhost:8000` — эмулятор чатов (chat-sim)
- `http://localhost:8001` — orchestrator API
- `5432` — PostgreSQL (внутренний)
- `6379` — Redis (внутренний)

**Примечание:** Порт 3000 занят другим проектом (Shiftledger) и не используется в этом проекте.

## Запуск

### Быстрый старт

```bash
cd infra
docker compose up --build
```

После запуска:
- Эмулятор чатов: http://localhost:8000
- Orchestrator API: http://localhost:8001
- Health check: http://localhost:8001/health
- DIKIDI stub: http://localhost:8001/dikidi

### Переменные окружения

Скопируйте `.env.example` в `.env` и при необходимости настройте:

```bash
cp .env.example .env
```

## Функциональность

### Frontend (chat-sim)

- Селектор сценария (4 варианта)
- Кнопки быстрых действий (5 кнопок)
- Чат-интерфейс для текстовых сообщений
- Панель теста с информацией о текущем состоянии

### Backend (orchestrator)

- **GET /health** — проверка работоспособности
- **GET /dikidi** — возвращает весь stub JSON
- **POST /chat** — обработка сообщений чата

### Логика v0.1.0 (без LLM)

- Определение intent на основе scenario и действия
- Всегда задается один открытый вопрос
- Для аренды цена не называется без даты/времени, формата, количества людей
- Для детских групп: сначала возраст, потом выбор группы
- Для записи: сначала направление, потом предложение слотов
- Эскалация при нажатии "Передать администратору"

## Формат запроса

```json
{
  "tenant_id": "studio_nexa",
  "channel": "simulator",
  "user_id": "test_user",
  "text": "...",
  "scenario": "Запись на занятие|Детские группы|Аренда зала|Вопрос о тренере",
  "action_type": "text|button",
  "action_name": "имя кнопки если action_type=button"
}
```

## Формат ответа

```json
{
  "reply": "...",
  "intent": "...",
  "version": "v0.1.0",
  "debug": {
    "scenario": "...",
    "action_type": "...",
    "action_name": "...",
    "intent": "...",
    "rules_used": [...],
    "next_question": "..."
  }
}
```

## Сценарии тестирования

### 1. Запись на занятие

**Шаги:**
1. Выберите сценарий "Запись на занятие"
2. Нажмите "Записаться на пробное занятие"
3. Бот должен спросить о направлении (показать список)
4. Введите название направления
5. Бот должен предложить слоты из расписания

**Ожидаемый результат:**
- Intent: `book_trial` → `booking_info`
- Показываются доступные направления из stub
- Предлагаются слоты из расписания

### 2. Детские группы

**Шаги:**
1. Выберите сценарий "Детские группы"
2. Нажмите "Уточнить возраст ребёнка"
3. Бот должен спросить возраст
4. Введите возраст (например, "5 лет")
5. Бот должен предложить подходящие группы

**Ожидаемый результат:**
- Intent: `ask_age` → `children_groups_info`
- Сначала запрашивается возраст
- Потом предлагаются группы по возрасту

### 3. Аренда зала

**Шаги:**
1. Выберите сценарий "Аренда зала"
2. Нажмите "Рассчитать стоимость аренды"
3. Бот должен спросить: дату/время, формат, количество людей
4. **НЕ должен** называть цену сразу

**Ожидаемый результат:**
- Intent: `calculate_rental`
- Цена не называется без всех параметров
- Задаются вопросы по одному

### 4. Вопрос о тренере

**Шаги:**
1. Выберите сценарий "Вопрос о тренере"
2. Нажмите "Передать администратору"
3. Бот должен подтвердить передачу

**Ожидаемый результат:**
- Intent: `escalation`
- Подтверждение передачи администратору

## Устранение неполадок

### Ошибка "database does not exist"

Если видите ошибку `FATAL database "tsm_user" does not exist` в логах Postgres:

1. **Проверьте POSTGRES_DB и DATABASE_URL:**
   - В `docker-compose.yml` должно быть: `POSTGRES_DB: tsm`
   - В `DATABASE_URL` должна быть база `tsm`, а не `tsm_user`
   - Формат: `postgresql+psycopg://tsm:tsm@postgres:5432/tsm`

2. **Пересоздайте volume PostgreSQL:**
   ```bash
   docker compose down -v
   docker compose up --build
   ```

3. **Проверьте логи:**
   ```bash
   docker compose logs postgres
   ```

### Проблемы с портами (macOS)

Если при запуске Docker вы получаете ошибку о занятом порте:

1. **Проверьте, какие порты заняты:**
   ```bash
   lsof -i :8000
   lsof -i :8001
   ```

2. **Остановите процессы, использующие эти порты:**
   ```bash
   # Найти процесс
   lsof -ti :8000
   # Остановить процесс (замените PID на реальный)
   kill -9 <PID>
   ```

3. **Если порт 3000 занят Shiftledger:**
   - Это нормально, проект "Танцуй со мной" не использует порт 3000
   - Убедитесь, что Shiftledger работает на порту 3000
   - Проект "Танцуй со мной" использует порты 8000 и 8001

4. **Проверьте, что Docker контейнеры не конфликтуют:**
   ```bash
   docker ps
   docker stop <container_name>
   ```

## Разработка

### Локальный запуск (без Docker)

#### Orchestrator

```bash
cd services/orchestrator
pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg://tsm:tsm@localhost:5432/tsm
export REDIS_URL=redis://localhost:6379/0
export PRODUCT_VERSION=v0.1.0
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

#### Chat-sim

```bash
cd services/chat-sim
pip install -r requirements.txt
export ORCHESTRATOR_URL=http://localhost:8001
export PRODUCT_VERSION=v0.1.0
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

## DIKIDI Stub

Данные для эмуляции находятся в `data/dikidi_stub.json`:

- **Направления:** 6 направлений с ценами и лимитами
- **Расписание:** слоты на неделю
- **Аренда:** правила ценообразования (до/после 16:00, до/более 10 человек, форматы)

Этот файл является источником правды на этапе эмуляции.
