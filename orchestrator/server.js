const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

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
const PRODUCT_VERSION = 'v0.1.3';

app.use(cors());
app.use(express.json());

// === v0.1.3: deterministic “smart” router (no LLM yet) ===
function nowIso() {
  return new Date().toISOString();
}

function extractPhone(text) {
  const t = (text || '').replace(/\s+/g, '');
  const m = t.match(/(\+7|8)\d{10}/);
  if (!m) return null;
  // normalize to +7XXXXXXXXXX
  const raw = m[0];
  return raw.startsWith('8') ? '+7' + raw.slice(1) : raw;
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

  const hasYoga = /\bйог|хатха|hatha|силов\w*\s*йог\w*\b/.test(t); // includes “силовая йога”
  const hasRent = /\bаренд|зал|помещен|площадк|час\b/.test(t);
  const hasDance = /\bтанц|хореог|брейк|k-?pop|kpop|хай\s*хилс|high\s*heels|латин|бальн|контемп|lady\s*style|джаз\b/.test(t);

  const wantsBook = /\bзапис|запись|хочу\s+на\s+пробн|пробн\w*\b/.test(t);
  const asksWhatYouHave = /\bчто\s+есть|какие\s+направлен|что\s+у\s+вас\s+есть|из\s+танцев\b/.test(t);

  // intent priority (simple & predictable)
  if (hasRent) return { intent: 'RENT', phone, age };
  if (hasYoga) return { intent: wantsBook ? 'BOOK_YOGA' : 'ASK_YOGA', phone, age };
  if (wantsBook) return { intent: 'BOOK_TRIAL', phone, age };
  if (asksWhatYouHave && hasDance) return { intent: 'ASK_DANCE_OPTIONS', phone, age };
  if (asksWhatYouHave) return { intent: 'ASK_OPTIONS', phone, age };
  if (hasDance) return { intent: 'ASK_DANCE_OPTIONS', phone, age };

  return { intent: 'GENERAL', phone, age };
}

function buildReply({ intent, phone, age }, text) {
  // minimal “водим к записи” + 1 открытый вопрос
  if (intent === 'ASK_YOGA' || intent === 'BOOK_YOGA') {
    // yoga exists in your catalog
    const q = age ? `Подскажите, в какое время вам удобнее: утро/день/вечер?` :
      `Для кого подбираете йогу — для себя? И в какое время удобнее: утро/день/вечер?`;
    return `Да, у нас есть йога (хатха-йога). ${q}`;
  }

  if (intent === 'RENT') {
    // rental rules exist
    return `По аренде зала уточните, пожалуйста: на какое мероприятие, сколько человек и какие даты/время рассматриваете? Я предложу 2–3 ближайших варианта.`;
  }

  if (intent === 'ASK_DANCE_OPTIONS' || intent === 'ASK_OPTIONS') {
    const ageHint = age ? `Вижу возраст: ${age}. ` : '';
    return `${ageHint}Супер. Подскажите, для кого подбираете (ребёнок/взрослый) и какой возраст/уровень? Я предложу 2–3 подходящих направления и ближайшие слоты для пробного.`;
  }

  if (intent === 'BOOK_TRIAL') {
    const need = [];
    if (!age) need.push('возраст');
    if (!phone) need.push('телефон');
    if (need.length) {
      return `Запишем на пробное 👍 Подскажите, пожалуйста, ${need.join(' и ')}. И какое время удобнее: утро/день/вечер?`;
    }
    return `Отлично, записываю на пробное. В какое время удобнее: утро/день/вечер?`;
  }

  // GENERAL
  return `Подскажите, что именно вас интересует: танцы для ребёнка/взрослых, йога или аренда зала? Я помогу подобрать вариант и записать.`;
}

function appendLeadEvent(event) {
  // Simple durable-ish log (for debugging). Render FS may be ephemeral, but useful now.
  try {
    fs.appendFileSync('/tmp/nexa_events.jsonl', JSON.stringify(event) + '\n', 'utf-8');
  } catch {}
}

app.post('/api/message', (req, res) => {
  const text = (req.body?.text ?? req.body?.message ?? '').toString();
  const meta = req.body?.meta || {};
  const classified = classify(text);

  const reply = buildReply(classified, text);

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
    version: PRODUCT_VERSION,
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
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: PRODUCT_VERSION,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Orchestrator запущен на порту ${PORT}`);
  console.log(`📦 Версия продукта: ${PRODUCT_VERSION}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`📨 API endpoint: http://localhost:${PORT}/api/message`);
});

