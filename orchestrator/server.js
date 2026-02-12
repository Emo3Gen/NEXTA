const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// === Simple in-memory dialog state (MVP) ===
const sessions = new Map();

async function notifyOwner(payload) {
  const url = process.env.OWNER_WEBHOOK_URL;
  if (!url) return { skipped: true };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function appendJsonl(pathname, obj) {
  try {
    fs.appendFileSync(pathname, JSON.stringify(obj) + '\n', 'utf-8');
  } catch {}
}

function normalizeText(t) {
  return String(t || '')
    .trim()
    .toLowerCase()
    .replace(/[\\\/]+$/g, '')        // убрать завершающие \ or /
    .replace(/[.,!?]+$/g, '')        // убрать завершающую пунктуацию
    .replace(/\s+/g, ' ');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function replaceRelativeDates(input) {
  const s = (input || '').toLowerCase();
  const hasTime = s.match(/\b(\d{1,2}):(\d{2})\b/);
  const now = new Date();

  let offset = null;
  if (/(^|\s)сегодня(\s|$)/.test(s)) offset = 0;
  if (/(^|\s)завтра(\s|$)/.test(s)) offset = 1;
  if (/(^|\s)послезавтра(\s|$)/.test(s)) offset = 2;

  if (offset === null) return input;

  const d = new Date(now);
  d.setDate(d.getDate() + offset);

  const ddmm = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;

  // заменяем слово на dd.mm (время остаётся как есть). \b не работает с кириллицей.
  return input.replace(/(^|\s)(сегодня|завтра|послезавтра)(\s|$)/gi, `$1${ddmm}$3`);
}

function detectIntent(text) {
  const t = normalizeText(text);

  if (t.includes('распис')) return { intent: 'SHOW_SCHEDULE' };
  if (t.includes('аренд')) return { intent: 'HALL_RENT' };
  if (t.includes('админ') || t.includes('администратор') || t.includes('передать запрос администратору')) return { intent: 'ASK_ADMIN' };
  if (t.includes('тренер') || t.includes('кто вед') || t.includes('какие тренеры')) return { intent: 'ASK_TRAINERS' };

  return null;
}

function matchGlobalAction(text) {
  const t = normalizeText(text);

  // смена сценария / быстрые команды
  if (t.includes('аренд')) return { type: 'switch_scenario', scenario: 'Аренда зала' };
  if (t.includes('стоимость') && t.includes('аренд')) return { type: 'switch_scenario', scenario: 'Аренда зала' };
  if (t.includes('рассчит') && t.includes('аренд')) return { type: 'switch_scenario', scenario: 'Аренда зала' };
  if (t.includes('зал')) return { type: 'switch_scenario', scenario: 'Аренда зала' };

  if (t.includes('распис')) return { type: 'switch_scenario', scenario: 'Расписание' };
  if (t.includes('посмотреть') && t.includes('распис')) return { type: 'switch_scenario', scenario: 'Расписание' };

  if (t.includes('админ') || t.includes('администратор')) return { type: 'switch_scenario', scenario: 'Администратор' };
  if (t.includes('возраст')) return { type: 'switch_scenario', scenario: 'Возраст' };
  if (t.includes('пробн') || t.includes('пробное')) return { type: 'switch_scenario', scenario: 'Детские группы' };

  // навигация
  if (t === 'назад' || t === 'вернуться') return { type: 'back' };
  if (t === 'отмена' || t === 'стоп' || t === 'сброс') return { type: 'reset' };

  return null;
}

const SCHEDULE_FULL_TEXT =
  'Расписание (сводно):\n' +
  'Танцы:\n' +
  '  Пн/Ср  18:00–19:00\n' +
  '  Вт/Чт  17:00–18:00\n' +
  '  Сб     11:00–12:00\n\n' +
  'Йога:\n' +
  '  Вт/Чт  19:00–20:00\n' +
  '  Сб     10:00–11:00\n\n' +
  'Гимнастика:\n' +
  '  Пн/Ср  17:00–18:00\n' +
  '  Сб     12:00–13:00';

function entryMessageForScenario(scenario) {
  switch (scenario) {
    case 'Детские группы':
      return 'Записаться на пробное занятие\n\nСколько лет ребёнку?';
    case 'Аренда зала':
      return 'По аренде зала уточните:\n1) дата и время\n2) сколько человек\n3) формат (тренировка/мероприятие/съёмка)';
    case 'Расписание':
      return 'Какое направление интересует: танцы / йога / гимнастика?';
    case 'Возраст':
      return 'Сколько лет ребёнку?';
    case 'Администратор':
      return 'Опишите вопрос для администратора (что нужно и на когда).';
    default:
      return 'Пожалуйста, выберите сценарий.';
  }
}

function getSession(chatId = 'default') {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      intent: null,
      slots: {},
      stage: 'start',
    });
  }
  return sessions.get(chatId);
}

const SCHEDULE_BY_INTEREST = {
  'танцы': [
    'Пн/Ср 18:00–19:00',
    'Вт/Чт 17:00–18:00',
    'Сб 11:00–12:00'
  ],
  'йога': [
    'Вт/Чт 19:00–20:00',
    'Сб 10:00–11:00'
  ],
  'гимнастика': [
    'Пн/Ср 17:00–18:00',
    'Сб 12:00–13:00'
  ],
  'растяжка': [
    'Пн/Ср 17:00–18:00',
    'Сб 12:00–13:00'
  ]
};

const TIME_QUICK_ACTIONS = [
  'Будни — утро',
  'Будни — день',
  'Будни — вечер',
  'Выходные — утро',
  'Выходные — день',
  'Выходные — вечер'
];

const AGE_TOO_EARLY_QUICK_ACTIONS = [
  'Консультация',
  'Индивидуальные занятия',
  'Указать другой возраст'
];

const TEENAGER_OR_ADULT_QUICK_ACTIONS = [
  'Для подростка',
  'Для взрослого'
];

const app = express();

// v0.1.3 debug routes (DEPLOY PROBE)
app.use(express.json({ limit: '1mb' }));

let __lastApiMessageBody = null;

app.get('/api/_ping', (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

app.get('/api/_last_message', (req, res) => {
  res.json(__lastApiMessageBody || { empty: true });
});

app.get('/api/_leads_tail', (req, res) => {
  try {
    const p = '/tmp/nexa_leads.jsonl';
    const txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
    const lines = txt.trim().split('\n').filter(Boolean).slice(-20);
    res.type('application/json').send('[' + lines.join(',') + ']');
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- deploy marker
const BUILD = 'v0.1.4';

function reply(res, session, text, extra = {}) {
  const debug = {
    scenario: session?.scenario ?? null,
    step: session?.step ?? null,
    state: session?.stage ?? session?.state ?? null,
    active_intent: session?.active_intent ?? null,
    slots: session?.slots || {},
    last_intent: session?.intent ?? session?.last_intent ?? null,
    ...extra._debug,
  };
  return res.json({
    ...extra,
    ok: extra.ok !== false ? true : false,
    version: extra.version ?? BUILD,
    text,
    reply: extra.reply ?? text,
    response: extra.response ?? text,
    _debug: debug,
  });
}

// --- UI discovery: find chat-sim/index.html in typical locations (Render + local)
const candidates = [
  path.resolve(__dirname, 'chat-sim'),
];

function pickChatSimDir() {
  for (const dir of candidates) {
    const indexPath = path.join(dir, 'index.html');
    if (fs.existsSync(indexPath)) return dir;
  }
  return null;
}

const chatSimDir = pickChatSimDir();

// Debug endpoint to confirm which path is used in Render
app.get('/api/_paths', (req, res) => {
  res.json({
    __dirname,
    cwd: process.cwd(),
    candidates,
    chatSimDir,
    chatSimIndex: chatSimDir ? path.join(chatSimDir, 'index.html') : null,
    exists_chatSimDir: chatSimDir ? fs.existsSync(chatSimDir) : false,
    exists_index: chatSimDir ? fs.existsSync(path.join(chatSimDir, 'index.html')) : false,
    ls_chatSimDir: chatSimDir ? fs.readdirSync(chatSimDir).slice(0, 50) : null,
  });
});

app.get('/api/_ls', (req, res) => {
  try {
    const base = '/app';
    const list = fs.readdirSync(base).map((name) => {
      const full = path.join(base, name);
      let type = 'unknown';
      try {
        const st = fs.statSync(full);
        type = st.isDirectory() ? 'dir' : 'file';
      } catch {}
      return { name, type };
    });
    res.json({ base, list });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

if (chatSimDir) {
  app.use(express.static(chatSimDir));
}

app.get('/', (req, res) => {
  if (!chatSimDir) {
    return res
      .status(500)
      .send('UI not found: chat-sim/index.html is missing in the deployed filesystem');
  }
  return res.sendFile(path.join(chatSimDir, 'index.html'));
});

const PORT = process.env.PORT || 8001;

app.use(cors());

// === v0.1.3: deterministic “smart” router (no LLM yet) ===
function nowIso() {
  return new Date().toISOString();
}

function extractPhone(text) {
  if (!text) return null;

  const digits = text.replace(/\D/g, '');

  // 11 digits starting with 7 or 8
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return '+7' + digits.slice(1);
  }

  // 10 digits (assume Russian local without country code)
  if (digits.length === 10) {
    return '+7' + digits;
  }

  return null;
}

function extractAge(text) {
  const t = (text || '').trim().toLowerCase();

  // “4”, “12” as a message
  if (/^\d{1,2}$/.test(t)) {
    const n = parseInt(t, 10);
    if (n >= 1 && n <= 99) return n;
  }

  // “4 года”, “4 лет”, “ребенку 4”
  const m = t.match(/(?:реб[её]нк\w*\s*)?(\d{1,2})\s*(?:год|года|лет)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 99) return n;
  }

  return null;
}

function classify(text) {
  const t = (text || '').toLowerCase();

  const phone = extractPhone(text);
  const age = extractAge(text);

  // IMPORTANT: avoid \b with Cyrillic; use simple matches / unicode-friendly regexes
  const hasYoga =
    /йог|хатха|hatha|силов\w*\s*йог/i.test(t); // includes “силовая йога”

  const hasRent =
    /аренд|зал|помещен|площадк|почас|час/i.test(t);

  const hasDance =
    /танц|хореог|брейк|k-?pop|kpop|хай\s*хилс|high\s*heels|латин|бальн|контемп|lady\s*style|джаз/i.test(t);

  const wantsBook =
    /запис|запись|пробн|хочу\s+на/i.test(t);

  const asksWhatYouHave =
    /что\s+есть|какие\s+направлен|что\s+у\s+вас\s+есть|из\s+танцев/i.test(t);

  // intent priority (simple & predictable)
  if (hasRent) return { intent: 'RENT', phone, age };
  if (hasYoga) return { intent: wantsBook ? 'BOOK_YOGA' : 'ASK_YOGA', phone, age };
  if (wantsBook) return { intent: 'BOOK_TRIAL', phone, age };
  if (asksWhatYouHave && hasDance) return { intent: 'ASK_DANCE_OPTIONS', phone, age };
  if (asksWhatYouHave) return { intent: 'ASK_OPTIONS', phone, age };
  if (hasDance) return { intent: 'ASK_DANCE_OPTIONS', phone, age };

  return { intent: 'GENERAL', phone, age };
}

function textHas(t, re) {
  return re.test(normalizeText(t));
}

function normalizeInterest(text) {
  const t = normalizeText(text);
  if (t.includes('тенц')) return 'танцы';
  if (t.includes('танц')) return 'танцы';
  if (t.includes('йог')) return 'йога';
  if (t.includes('гимнаст') || t.includes('растяж')) return 'гимнастика';
  return t;
}

function updateSessionFromText(session, text) {
  // answers to "for whom?" (trial / kids)
  if (session.stage === 'ask_for_whom') {
    if (textHas(text, /реб|доч|сын|ребен|дет/)) session.slots.for_whom = 'child';
    if (textHas(text, /взросл|для\s+себя|для\s+меня|для\s+себ/)) session.slots.for_whom = 'adult';
  }

  // answers to "for whom?" (yoga)
  if (session.stage === 'ask_yoga_for_whom') {
    if (textHas(text, /себ|для\s+себя|я\b/)) session.slots.yoga_for_whom = 'self';
    if (textHas(text, /реб|доч|сын|ребен/)) session.slots.yoga_for_whom = 'child';
  }

  // answers to "time?" (quick_actions или текст)
  if (session.stage === 'ask_time') {
    const t = normalizeText(text);
    const match = TIME_QUICK_ACTIONS.find(opt => normalizeText(opt) === t);
    if (match) {
      session.slots.preferred_time = match;
    } else if (textHas(text, /утр/)) {
      session.slots.preferred_time = textHas(text, /будн/) ? 'Будни — утро' : textHas(text, /выходн/) ? 'Выходные — утро' : 'утро';
    } else if (textHas(text, /день|днём/)) {
      session.slots.preferred_time = textHas(text, /будн/) ? 'Будни — день' : textHas(text, /выходн/) ? 'Выходные — день' : 'день';
    } else if (textHas(text, /веч/)) {
      session.slots.preferred_time = textHas(text, /будн/) ? 'Будни — вечер' : textHas(text, /выходн/) ? 'Выходные — вечер' : 'вечер';
    }
  }

  // kid interest (normalize опечатки)
  if (session.stage === 'ask_kid_interest') {
    session.slots.kid_interest = normalizeInterest(text);
  }
}

function buildReply(classified, text, session) {
  // Always apply stage-based slot updates first
  updateSessionFromText(session, text);

  // intent is set only in handler: scenario lock (highest) or classified (if !session.intent)
  // buildReply does NOT override session.intent

  // === Kids groups flow ===
  if (session.intent === 'KIDS_GROUPS') {
    if (session.scenario === 'Детские группы' || (session.scenario && session.scenario.includes('детск'))) {
      session.slots.for_whom = 'child';
    }
    if (!session.slots.for_whom) {
      session.stage = 'ask_for_whom';
      return 'Для кого занятие: для ребёнка или для взрослого?';
    }

    const forWhom = session.slots.for_whom;
    const age = session.slots.age ?? classified.age;
    const t = normalizeText(text);

    // CTA after "рано": Консультация / Индивидуальные / Указать другой возраст
    if (session.stage === 'ask_kid_age_too_early') {
      if (t.includes('консультац')) {
        session.stage = 'ask_phone';
        session.slots.kid_interest = 'консультация';
        return 'Ок, передаю запрос на консультацию администратору. Оставьте, пожалуйста, номер телефона — администратор свяжется с вами.';
      }
      if (t.includes('индивидуальн')) {
        session.stage = 'ask_phone';
        session.slots.kid_interest = 'индивидуальные занятия';
        return 'Ок, записал интерес к индивидуальным занятиям. Оставьте, пожалуйста, номер телефона — администратор свяжется с вами.';
      }
      if (t.includes('другой возраст') || t.includes('указать возраст')) {
        session.slots.age = null;
        session.slots.age_early_shown = false;
        session.stage = 'ask_kid_age';
        return 'Сколько лет ребёнку?';
      }
    }

    if (forWhom === 'child') {
      if (!age) {
        session.stage = 'ask_kid_age';
        return 'Сколько лет ребёнку?';
      }
      // Age validation for child
      if (age < 3) {
        if (session.slots.age_early_shown) {
          // уже говорили "рано" — не повторять, уточнить с CTA
          session.stage = 'ask_kid_age_too_early';
          return 'Мы берём в группы с 3 лет. Хотите консультацию или индивидуальные занятия?';
        }
        session.slots.age_early_shown = true;
        session.stage = 'ask_kid_age_too_early';
        return 'Сейчас ещё рано — предлагаем консультацию или индивидуальные занятия. Можем обсудить варианты.';
      }
      if (age >= 14) {
        session.stage = 'ask_teenager_or_adult';
        return 'От 14 лет — это уже подростковые/взрослые группы. Уточните, пожалуйста: вам нужен формат для подростка или для взрослого?';
      }
      // age OK — сбросить флаг, если был
      session.slots.age_early_shown = false;
    }

    if (forWhom === 'adult') {
      if (age && age < 14) {
        session.slots.age = null;
        session.stage = 'ask_for_whom';
        return 'Возраст до 14 лет — это детская группа. Для кого занятие: для ребёнка или для взрослого?';
      }
    }

    if (!session.slots.kid_interest) {
      session.stage = 'ask_kid_interest';
      const whom = forWhom === 'child' ? 'ребёнку' : 'вам';
      return `Что ${whom} ближе: танцы (какие стили), гимнастика/растяжка, или что-то ещё?`;
    }

    if (!session.slots.preferred_time) {
      session.stage = 'ask_time';
      const interest = (session.slots?.kid_interest || '').toLowerCase().trim();
      const key = SCHEDULE_BY_INTEREST[interest]
        ? interest
        : Object.keys(SCHEDULE_BY_INTEREST).find(k => interest.includes(k));
      const lines = key ? SCHEDULE_BY_INTEREST[key] : null;

      let scheduleBlock = '';
      if (lines && lines.length) {
        scheduleBlock =
          `Расписание по направлению «${key}»:\n` +
          lines.map(x => `• ${x}`).join('\n') +
          `\n\nКакое время удобнее: будни/выходные, утро/день/вечер?`;
      } else {
        scheduleBlock = 'Какое время удобнее: будни/выходные, утро/день/вечер?';
      }
      return scheduleBlock;
    }

    if (!session.slots.phone) {
      session.slots = session.slots || {};
      session.slots.phone_tries = session.slots.phone_tries || 0;
      const t = normalizeText(text);

      const looksLikeRefusal =
        t.includes('не остав') || t.includes('не дам') || t.includes('не хочу') || t.includes('зачем') || t.includes('почему');

      if (!extractPhone(text)) {
        session.slots.phone_tries += 1;

        if (looksLikeRefusal) {
          return 'Понимаю. Телефон нужен, чтобы администратор подтвердил запись и предложил точное время.\n' +
            'Можно так:\n' +
            '1) Написать телефон\n' +
            '2) Написать «администратор» — и я передам запрос без телефона\n' +
            '3) Написать «отмена» — сброшу сценарий';
        }

        if (session.slots.phone_tries >= 2) {
          return 'Похоже, это не номер. Введите телефон (10–11 цифр) или напишите «администратор», чтобы передать запрос без телефона.';
        }

        session.stage = 'ask_phone';
        return 'Оставьте, пожалуйста, номер телефона — администратор подтвердит запись.';
      }
    }

    session.stage = 'ready';
    return 'Отлично 👍 Передаю заявку администратору для записи в детскую группу.';
  }

  // === YOGA flow (no more "start" question loops) ===
  const intent = session.intent || classified.intent;

  const isYoga =
    intent === 'ASK_YOGA' || intent === 'BOOK_YOGA' ||
    /йог|хатха|hatha|силов\w*\s*йог/i.test((text || '').toLowerCase());

  if (isYoga) {
    // ensure intent is locked to yoga
    if (!session.intent || session.intent === 'GENERAL') session.intent = 'ASK_YOGA';

    if (!session.slots.yoga_for_whom) {
      session.stage = 'ask_yoga_for_whom';
      return 'Для кого подбираете йогу — для себя или для ребёнка?';
    }

    if (!session.slots.preferred_time) {
      session.stage = 'ask_time';
      return 'И в какое время удобнее: утро / день / вечер?';
    }

    if (!session.slots.phone) {
      session.stage = 'ask_phone';
      return 'Оставьте, пожалуйста, номер телефона — администратор подтвердит запись.';
    }

    session.stage = 'ready';
    return `Отлично 👍 Передаю заявку администратору. Время: ${session.slots.preferred_time}.`;
  }

  // === Other intents (minimal MVP) ===
  if (intent === 'RENT') {
    session.intent = 'RENT';
    session.stage = 'ask_rent_details';
    return 'По аренде зала уточните: дата/время, сколько человек и формат мероприятия?';
  }

  if (intent === 'BOOK_TRIAL') {
    session.intent = 'BOOK_TRIAL';

    if (!session.slots.for_whom) {
      session.stage = 'ask_for_whom';
      return 'Для кого занятие: для ребёнка или для взрослого?';
    }

    const forWhom = session.slots.for_whom;
    const age = session.slots.age ?? classified.age;

    if (forWhom === 'child') {
      if (!age) {
        session.stage = 'ask_age';
        return 'Подскажите возраст ребёнка, пожалуйста.';
      }
      if (age < 3) {
        return 'Сейчас ещё рано — предлагаем консультацию или индивидуальные занятия. Можем обсудить варианты.';
      }
      if (age >= 14) {
        return 'От 14 лет — это уже подростковые/взрослые группы. Уточните, пожалуйста: вам нужен формат для подростка или для взрослого?';
      }
    }

    if (forWhom === 'adult' && age && age < 14) {
      session.slots.age = null;
      session.stage = 'ask_for_whom';
      return 'Возраст до 14 лет — это детская группа. Для кого занятие: для ребёнка или для взрослого?';
    }

    if (!session.slots.phone) {
      session.stage = 'ask_phone';
      return 'Оставьте номер телефона — администратор подтвердит запись.';
    }
    session.stage = 'ready';
    return 'Отлично 👍 Передаю заявку администратору для записи на пробное.';
  }

  // Default first contact
  session.stage = 'start';
  return 'Подскажите, что именно вас интересует: танцы для ребёнка/взрослых, йога или аренда зала?';
}


function appendLeadEvent(event) {
  // Simple durable-ish log (for debugging). Render FS may be ephemeral, but useful now.
  try {
    fs.appendFileSync('/tmp/nexa_events.jsonl', JSON.stringify(event) + '\n', 'utf-8');
  } catch {}
}

app.post('/api/message', async (req, res) => {
  __lastApiMessageBody = req.body;

  const text = (req.body?.text ?? req.body?.message ?? '').toString();
  const meta = req.body?.meta || {};
  const scenarioRaw = (req.body?.scenario ?? req.body?.meta?.scenario ?? '').toString();
  const scenario = scenarioRaw.toLowerCase();
  const chatId =
    (req.body?.chat_id || req.body?.meta?.chat_id || req.body?.user_id || 'default').toString();
  const session = getSession(chatId);
  session.slots = session.slots || {};
  session.active_intent = session.active_intent || null;

  const TEST_MODE = process.env.TEST_MODE === '1';
  if (TEST_MODE) {
    // В тестовом режиме не обращаемся к LLM
    // Используем только локальную логику сценариев (intent/state flow)
  }

  // === 1) Глобальные команды — приоритет выше sticky и сценариев ===
  const g = matchGlobalAction(text);
  if (g && g.type === 'switch_scenario') {
    session.active_intent = null;
    session.scenario = g.scenario;
    session.stage = 'start';
    session.step = null;
    session.slots = {};
    if (g.scenario === 'Детские группы') session.slots.for_whom = 'child';
    if (g.scenario.includes('аренд')) {
      session.intent = 'RENT';
      session.active_intent = 'HALL_RENT';
      session.slots.hall_rent = session.slots.hall_rent || {};
    }
    if (g.scenario.includes('детск')) session.intent = 'KIDS_GROUPS';

    const msg =
      g.scenario === 'Расписание' ? SCHEDULE_FULL_TEXT : entryMessageForScenario(session.scenario);
    return reply(res, session, msg, { intent: session.intent || null, slots: session.slots || {} });
  }
  if (g && g.type === 'reset') {
    session.active_intent = null;
    session.scenario = null;
    session.stage = 'start';
    session.step = null;
    session.slots = {};
    session.intent = null;

    const msg = entryMessageForScenario(null);
    return reply(res, session, msg, { intent: null, slots: session.slots || {} });
  }

  // === 1.5) Scenario from payload: установить active_intent до sticky (важно для аренды) ===
  if (scenario && session.scenario !== scenario) {
    session.intent = null;
    session.slots = {};
    session.stage = 'start';
    session.step = null;
    session.scenario = scenario;
    if (scenario.includes('детск')) session.slots.for_whom = 'child';
    if (scenario.includes('аренд')) {
      session.intent = 'RENT';
      session.active_intent = 'HALL_RENT';
      session.slots.hall_rent = session.slots.hall_rent || {};
    }
  }

  // === 2) Sticky-обработчики аренды (до detectIntent) ===
  if (session.active_intent === 'HALL_RENT') {
    const t = normalizeText(text);

    if (t === 'отмена' || t === 'стоп' || t === 'сброс') {
      session.active_intent = null;
      session.slots.hall_rent = null;
      return reply(res, session, 'Ок, аренду отменил. Что дальше: запись / расписание / администратор?');
    }

    const textForRent = replaceRelativeDates(text);
    const hasDate = /\b(\d{1,2}[./]\d{1,2})\b/.test(textForRent);
    const hasTime = /\b(\d{1,2}[:.]\d{2})\b/.test(textForRent);

    if (hasDate && hasTime) {
      session.slots.hall_rent = session.slots.hall_rent || {};
      session.slots.hall_rent.request = textForRent;
      session.active_intent = 'HALL_RENT_FOLLOWUP';

      const msg =
        'Принято 👍 Передаю администратору заявку на аренду:\n' +
        textForRent +
        '\n\nЕсли хотите — могу уточнить формат (тренировка/съёмка/мероприятие) и контактный телефон.';
      return reply(res, session, msg);
    }

    const msg =
      'Понял. Мне нужно 2 опоры:\n' +
      '• дата (например 20.02)\n' +
      '• время (например 19:00)\n' +
      'И желательно: длительность и сколько человек.\n\n' +
      'Напишите одной строкой, например: "20.02 19:00 на 3 часа, 6 человек, тренировка".';
    return reply(res, session, msg);
  }

  if (session.active_intent === 'HALL_RENT_FOLLOWUP') {
    const t = normalizeText(text);

    if (t.includes('стоим') || t.includes('цена') || t.includes('сколько')) {
      const msg =
        'Стоимость зависит от дня недели, времени и формата.\n' +
        'Я уже передал(а) заявку администратору — он рассчитает точную цену и ответит.\n\n' +
        'Если хотите, уточните формат: тренировка / съёмка / мероприятие / другое.';
      return reply(res, session, msg);
    }

    if (t.includes('тренир') || t.includes('съём') || t.includes('меропр') || t.includes('другое')) {
      session.slots.hall_rent = session.slots.hall_rent || {};
      session.slots.hall_rent.format = text;
      session.active_intent = null;
      const msg = 'Отлично, добавил(а) формат и передал(а) администратору. Хотите вернуться к записи на занятие или посмотреть расписание?';
      return reply(res, session, msg);
    }

    const msg =
      'Понял. По аренде я передал заявку администратору.\n' +
      'Если нужно — напишите "стоимость" или уточните формат (тренировка/съёмка/мероприятие).';
    return reply(res, session, msg);
  }

  // === 3) Intent Router: новые запросы (расписание, аренда, админ, тренеры) ===
  const intentHit = detectIntent(text);
  if (intentHit?.intent === 'SHOW_SCHEDULE') {
    session.active_intent = 'SHOW_SCHEDULE';
    return reply(res, session, SCHEDULE_FULL_TEXT, { _debug: { intent: 'SHOW_SCHEDULE' } });
  }
  if (intentHit?.intent === 'HALL_RENT') {
    session.active_intent = 'HALL_RENT';
    session.slots.hall_rent = session.slots.hall_rent || {};
    const msg =
      'Аренда зала — уточним 3 вещи:\n' +
      '1) Дата (например: 21.02)\n' +
      '2) Время и длительность (например: 18:00 на 2 часа)\n' +
      '3) Сколько человек и формат (тренировка/съёмка/мероприятие/другое)\n\n' +
      'Напишите одной строкой, например: "21.02 18:00 на 2 часа, 8 человек, тренировка".';
    return reply(res, session, msg, { _debug: { intent: 'HALL_RENT' } });
  }
  if (intentHit?.intent === 'ASK_ADMIN') {
    session.active_intent = 'ASK_ADMIN';
    const msg = 'Ок. Напишите, что нужно и на когда — я передам администратору.';
    return reply(res, session, msg, { _debug: { intent: 'ASK_ADMIN' } });
  }
  if (intentHit?.intent === 'ASK_TRAINERS') {
    session.active_intent = 'ASK_TRAINERS';
    const msg =
      'По тренерам:\n' +
      '• "Мягкая" йога — спокойный темп, внимание к технике\n' +
      '• "Силовая/динамика" — нагрузка выше, больше работы на выносливость\n\n' +
      'Скажите: вам ближе мягко/динамично? И для кого: для себя или для ребёнка?';
    return reply(res, session, msg, { _debug: { intent: 'ASK_TRAINERS' } });
  }

  // === 4) Scenario change (если не сработало в 1.5), classify, buildReply ===
  if (scenario && session.scenario !== scenario) {
    session.intent = null;
    session.slots = {};
    session.stage = 'start';
    session.scenario = scenario;
    if (scenario.includes('детск')) session.slots.for_whom = 'child';
  }

  // Lock intent from scenario
  if (scenario.includes('детск')) {
    session.intent = 'KIDS_GROUPS';
  }

  if (scenario.includes('аренд')) {
    session.intent = 'RENT';
    session.active_intent = 'HALL_RENT';
    session.slots.hall_rent = session.slots.hall_rent || {};
  }

  const classified = classify(text);

  // Scenario has absolute priority over free-text classification
  if (session.intent === 'KIDS_GROUPS') {
    classified.intent = 'KIDS_GROUPS';
  }

  if (session.intent === 'RENT') {
    classified.intent = 'RENT';
  }

  // update slots if we found something
  if (classified.age) {
    // allow age correction after "рано" (user may type 15/22)
    if (!session.slots.age || session.stage === 'ask_kid_age_too_early') {
      session.slots.age = classified.age;
    }
  }

  if (classified.phone && !session.slots.phone) {
    session.slots.phone = classified.phone;
  }

  // If intent already locked by scenario — DO NOT override it
  if (!session.intent) {
    if (classified.intent && classified.intent !== 'GENERAL') {
      session.intent = classified.intent;
    }
  }

  // === LLM integration point: при добавлении callLLM / openai.chat.completions.create / provider.generate ===
  // вставьте guard прямо перед вызовом:
  //   const TEST_MODE = process.env.TEST_MODE === '1';
  //   if (TEST_MODE) {
  //     return res.json({ text: "TEST_MODE: unexpected LLM call (bug).", debug: { where: "llm_call_guard" } });
  //   }
  const useLLM = false; // true когда LLM интегрирован
  let replyText;
  if (useLLM) {
    const TEST_MODE = process.env.TEST_MODE === '1';
    if (TEST_MODE) {
      return res.json({
        text: "TEST_MODE: unexpected LLM call (bug).",
        debug: { where: "llm_call_guard" }
      });
    }
    // replyText = await callLLM(...);
  }
  if (!replyText) replyText = buildReply(classified, text, session);

  const leadEvent = {
    ts: new Date().toISOString(),
    tenant_id: req.body?.tenant_id || 'studio_nexa',
    chat_id: chatId,
    scenario: (req.body?.scenario ?? req.body?.meta?.scenario ?? '').toString(),
    intent: session.intent || classified.intent || null,
    stage: session.stage || null,
    slots: session.slots || {},
    text,
  };

  appendJsonl('/tmp/nexa_leads.jsonl', leadEvent);

  // Notify owner only when we are ready (phone collected)
  if (session.stage === 'ready' && (session.slots?.phone || classified.phone)) {
    await notifyOwner({
      type: 'NEW_LEAD',
      ...leadEvent,
      phone: session.slots?.phone || classified.phone || null,
      summary: `Сценарий: ${leadEvent.scenario}. Интерес: ${session.slots?.kid_interest || ''}. Время: ${session.slots?.preferred_time || ''}.`,
    });
  }

  const lead = {
    ts: nowIso(),
    channel: meta.channel || 'web',
    chat_id: meta.chat_id || null,
    name: meta.name || null,
    phone: classified.phone || meta.phone || null,
    age: classified.age || null,
    intent: classified.intent,
    raw: text,
  };

  appendLeadEvent({ type: 'INCOMING', ...lead });

  const extra = {
    intent: classified.intent,
    slots: {
      phone: classified.phone || null,
      age: classified.age || null,
    },
    next_question: replyText,
    lead_status: 'needs_details',
    _debug: {
      session_id: chatId,
      phone: session.slots?.phone || classified.phone || null,
    },
  };
  if (session.stage === 'ask_time') {
    extra.quick_actions = TIME_QUICK_ACTIONS.slice();
  }
  if (session.stage === 'ask_kid_age_too_early') {
    extra.quick_actions = AGE_TOO_EARLY_QUICK_ACTIONS.slice();
  }
  if (session.stage === 'ask_teenager_or_adult') {
    extra.quick_actions = TEENAGER_OR_ADULT_QUICK_ACTIONS.slice();
  }
  return reply(res, session, replyText, extra);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: BUILD, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Orchestrator запущен на порту ${PORT}`);
  console.log(`📦 Версия продукта: ${BUILD}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`📨 API endpoint: http://localhost:${PORT}/api/message`);
});

