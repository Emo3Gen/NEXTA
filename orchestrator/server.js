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
const BUILD = 'v0.1.3';

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
  return re.test((t || '').toLowerCase());
}

function updateSessionFromText(session, text) {
  // answers to "for whom?"
  if (session.stage === 'ask_yoga_for_whom') {
    if (textHas(text, /себ|для\s+себя|я\b/)) session.slots.yoga_for_whom = 'self';
    if (textHas(text, /реб|доч|сын|ребен/)) session.slots.yoga_for_whom = 'child';
  }

  // answers to "time?"
  if (session.stage === 'ask_time') {
    if (textHas(text, /утр/)) session.slots.preferred_time = 'утро';
    if (textHas(text, /дн/)) session.slots.preferred_time = 'день';
    if (textHas(text, /веч/)) session.slots.preferred_time = 'вечер';
  }

  // kid interest (store as-is)
  if (session.stage === 'ask_kid_interest') {
    session.slots.kid_interest = (text || '').trim();
  }
}

function buildReply(classified, text, session) {
  // Always apply stage-based slot updates first
  updateSessionFromText(session, text);

  // intent is set only in handler: scenario lock (highest) or classified (if !session.intent)
  // buildReply does NOT override session.intent

  // === Kids groups flow ===
  if (session.intent === 'KIDS_GROUPS') {
    if (!session.slots.age) {
      session.stage = 'ask_kid_age';
      return 'Сколько лет ребёнку?';
    }

    if (!session.slots.kid_interest) {
      session.stage = 'ask_kid_interest';
      return 'Что ребёнку ближе: танцы (какие стили), гимнастика/растяжка, или что-то ещё?';
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
      session.stage = 'ask_phone';
      return 'Оставьте, пожалуйста, номер телефона — администратор подтвердит запись.';
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

    if (!session.slots.age) {
      session.stage = 'ask_age';
      return 'Подскажите возраст ребёнка, пожалуйста.';
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

  // If scenario changed — reset session completely
  if (scenario && session.scenario !== scenario) {
    session.intent = null;
    session.slots = {};
    session.stage = 'start';
    session.scenario = scenario;
  }

  // Lock intent from scenario
  if (scenario.includes('детск')) {
    session.intent = 'KIDS_GROUPS';
  }

  if (scenario.includes('аренд')) {
    session.intent = 'RENT';
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
  if (classified.age && !session.slots.age) {
    session.slots.age = classified.age;
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

  const reply = buildReply(classified, text, session);

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

  // Backward-compatible response for UI + new contract fields
  res.json({
    ok: true,
    version: BUILD,
    reply,            // new
    text: reply,      // compatibility
    response: reply,  // backwards-compat for existing UI
    intent: classified.intent,
    slots: {
      phone: classified.phone || null,
      age: classified.age || null,
    },
    next_question: reply, // keep simple for now
    lead_status: 'needs_details',
    _debug: {
      state: session.stage || null,
      step: session.stage || null,
      session_id: chatId,
      scenario: session.scenario || (req.body?.scenario ?? req.body?.meta?.scenario ?? '').toString(),
      phone: session.slots?.phone || classified.phone || null,
      intent: session.intent || classified.intent || null,
      slots: session.slots || {},
    },
  });
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

