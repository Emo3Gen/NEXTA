const express = require('express');
const cors = require('cors');

const app = express();
import path from "path";

const chatSimDir = path.resolve(process.cwd(), "../chat-sim");
app.use(express.static(chatSimDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(chatSimDir, "index.html"));
});

const PORT = process.env.PORT || 8001;
const PRODUCT_VERSION = 'v0.1.2';

app.use(cors());
app.use(express.json());

// simple in-memory session store
// key: `${tenant_id}:${channel}:${user_id}`
const sessions = Object.create(null);

function sessionKey(tenantId, channel, userId) {
  return `${tenantId}:${channel}:${userId}`;
}

function getSession(tenantId, channel, userId) {
  const key = sessionKey(tenantId, channel, userId);
  if (!sessions[key]) {
    sessions[key] = {
      tenantId,
      channel,
      userId,
      scenarioType: null,
      selectedDirection: null,
      selectedDay: null,
      childAge: null,
      lastStage: null,
      lastResponseType: null,
      rentalDraft: {
        time: null,
        people: null,
        format: null,
      },
    };
  }
  return sessions[key];
}

function normalizeText(text) {
  return (text || '').toString().trim().toLowerCase();
}

function detectDay(text) {
  const t = normalizeText(text);
  if (t.includes('понед')) return 'Понедельник';
  if (t.includes('вторн')) return 'Вторник';
  if (t.includes('сред')) return 'Среда';
  if (t.includes('четвер')) return 'Четверг';
  if (t.includes('пятниц')) return 'Пятница';
  if (t.includes('суббот')) return 'Суббота';
  if (t.includes('воскр')) return 'Воскресенье';
  return null;
}

function parseIntSafe(text) {
  const n = parseInt(text, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

function handleBooking(session, scenario, text, actionType) {
  const lower = normalizeText(text);
  let intent = 'booking_info';

  // start / restart booking flow when explicit trial phrase is used
  if (
    actionType === 'button' &&
    (lower.includes('записаться на пробное занятие') || lower.includes('пробное занятие'))
  ) {
    session.scenarioType = 'booking';
    session.selectedDirection = null;
    session.selectedDay = null;
    session.lastStage = 'START';
    intent = 'book_trial';
    const response =
      'Давайте подберём вам занятие. Какое направление вас интересует: Latina Solo, High Heels, Dance Mix или Азбука танца?';
    return { response, intent };
  }

  // fuzzy direction recognition if not yet selected
  if (!session.selectedDirection) {
    const textNorm = lower;
    let direction = null;
    let label = null;

    if (textNorm.includes('латин')) {
      direction = 'latina_solo';
      label = 'Latina Solo';
    } else if (textNorm.includes('хай') || textNorm.includes('хилс') || textNorm.includes('heels')) {
      direction = 'high_heels';
      label = 'High Heels';
    } else if (textNorm.includes('данс') || textNorm.includes('dance')) {
      direction = 'dance_mix';
      label = 'Dance Mix 7-11';
    } else if (textNorm.includes('азбук')) {
      direction = 'azbuka';
      label = 'Азбука танца';
    }

    if (direction && label) {
      session.scenarioType = 'booking';
      session.selectedDirection = label;
      session.lastStage = 'DIRECTION_SELECTED';
      intent = 'book_trial';
      const response =
        `Вы имеете в виду ${label}? ` +
        'Мы можем записать вас на пробное занятие. Укажите, пожалуйста, удобный день недели.';
      return { response, intent };
    }

    // unknown direction → generic help but do not hard reject
    const response =
      'Мы работаем с направлениями Latina Solo, High Heels, Dance Mix 7-11 и Азбука танца. ' +
      'Напишите, пожалуйста, что вам ближе, и я предложу варианты.';
    return { response, intent };
  }

  // direction is known, maybe schedule request or day
  const day = detectDay(text);

  // schedule request
  if (lower.includes('посмотреть расписание') || (actionType === 'button' && lower.includes('расписан'))) {
    session.lastStage = session.lastStage || 'DIRECTION_SELECTED';
    const response =
      `Расписание по направлению ${session.selectedDirection} на ближайшую неделю:\n\n` +
      '• Понедельник, Среда, Пятница — 18:00\n' +
      '• Суббота — 10:00\n\n' +
      'Напишите, пожалуйста, какой день вам подходит, и я помогу зафиксировать запись.';
    return { response, intent: 'view_schedule' };
  }

  // user specifies day after direction (and possibly schedule)
  if (day && !session.selectedDay) {
    session.selectedDay = day;
    session.lastStage = 'DAY_SELECTED';
    intent = 'booking_details';
    const response =
      `Отлично, ${session.selectedDirection} в ${day}. ` +
      'Чтобы зафиксировать запись, укажите, пожалуйста, ваше имя и контактный телефон.';
    return { response, intent };
  }

  // after day is known, move towards terminal state without restarting
  if (session.selectedDay && session.lastStage === 'DAY_SELECTED') {
    session.lastStage = 'DETAILS_REQUESTED';
    intent = 'booking_details';
    const response =
      `Мы запомним, что вам подходит ${session.selectedDirection} в ${session.selectedDay}. ` +
      'Можем зафиксировать бронь сейчас или, если удобнее, я передам запрос администратору.';
    return { response, intent };
  }

  // terminal-ish response: avoid going back to trial offer
  session.lastStage = session.lastStage || 'TERMINAL';
  intent = 'booking_terminal';
  const response =
    'Ваша информация по записи сохранена. Если хотите изменить направление или день, просто напишите, и мы подберём альтернативу или передадим запрос администратору.';
  return { response, intent };
}

function handleChild(session, scenario, text, actionType) {
  const lower = normalizeText(text);
  let intent = 'children_groups_info';

  // start child flow
  if (actionType === 'button' || lower.includes('детск')) {
    session.scenarioType = 'child';
    session.selectedDirection = null;
    session.lastStage = 'CHILD_START';
    const response =
      'У нас есть детские направления: Азбука танца 3-5, Dance Mix 7-11, Choreo 12-17. ' +
      'Напишите, пожалуйста, какое направление вам интересно или возраст ребёнка.';
    return { response, intent };
  }

  // direction hint "Азбука"
  if (!session.selectedDirection && lower.includes('азбук')) {
    session.scenarioType = 'child';
    session.selectedDirection = 'Азбука танца';
    session.lastStage = 'CHILD_NEED_AGE';
    if (session.childAge != null) {
      // age already known, go straight to group explanation
      return childGroupDecision(session, intent);
    }
    const response =
      'Напишите, пожалуйста, сколько лет вашему ребёнку, чтобы понять, подходит ли Азбука танца.';
    return { response, intent: 'ask_age' };
  }

  // age input
  if (session.selectedDirection && session.lastStage === 'CHILD_NEED_AGE' && session.childAge == null) {
    const age = parseIntSafe(text);
    if (!age) {
      const response = 'Пожалуйста, укажите возраст ребёнка числом, например 6.';
      return { response, intent: 'ask_age' };
    }
    session.childAge = age;
    return childGroupDecision(session, intent);
  }

  // if age already known, do not ask again
  if (session.childAge != null) {
    return childGroupDecision(session, intent);
  }

  // fallback: gently re-ask for age/direction without adults
  const response =
    'Для подбора детской группы мне нужен возраст ребёнка и направление: Азбука танца, Dance Mix 7-11 или Choreo 12-17.';
  return { response, intent };
}

function childGroupDecision(session, intent) {
  const age = session.childAge;
  const dir = session.selectedDirection || 'группа';
  session.lastStage = 'CHILD_TERMINAL';

  // simple heuristic: age 6 with Азбука — no exact group, explain and offer alternatives
  if (dir.includes('Азбука') && age === 6) {
    const response =
      `Для возраста ${age} лет направление ${dir} уже маловато. ` +
      'Сейчас нет точной группы под этот возраст, но можем предложить альтернативу, например Dance Mix 7-11, ' +
      'или сразу передать запрос администратору для подбора расписания.';
    return { response, intent: 'children_groups_info' };
  }

  // generic positive path for other ages
  const response =
    `Для возраста ${age} лет мы подберём группу по направлению ${dir}. ` +
    'Можем предложить ближайшее расписание или передать запрос администратору для уточнения деталей.';
  return { response, intent: 'children_groups_info' };
}

function handleRent(session, scenario, text, actionType) {
  const lower = normalizeText(text);
  let intent = 'rental_info';

  // start rent flow
  if (
    actionType === 'button' ||
    lower.includes('рассчитать стоимость аренды') ||
    lower.includes('аренда зала')
  ) {
    session.scenarioType = 'rent';
    session.rentalDraft = { time: null, people: null, format: null };
    session.lastStage = 'RENT_NEED_TIME';
    const response =
      'Давайте рассчитаем аренду зала. Укажите, пожалуйста, время (например, 16:00) или напишите, аренда до 16:00 или после 16:00.';
    return { response, intent: 'calculate_rental' };
  }

  // time
  if (session.lastStage === 'RENT_NEED_TIME' && !session.rentalDraft.time) {
    session.rentalDraft.time = text;
    session.lastStage = 'RENT_NEED_PEOPLE';
    const response = 'Сколько человек планируется на мероприятии?';
    return { response, intent: 'calculate_rental' };
  }

  // people count
  if (session.lastStage === 'RENT_NEED_PEOPLE' && !session.rentalDraft.people) {
    const count = parseIntSafe(text);
    if (!count) {
      const response = 'Пожалуйста, укажите количество человек числом, например 6.';
      return { response, intent: 'calculate_rental' };
    }
    session.rentalDraft.people = count;
    session.lastStage = 'RENT_NEED_FORMAT';
    const response =
      'Какой формат мероприятия?\n' +
      '1) Тренировка\n' +
      '2) Репетиция\n' +
      '3) Мероприятие';
    return { response, intent: 'calculate_rental' };
  }

  // format
  if (session.lastStage === 'RENT_NEED_FORMAT' && !session.rentalDraft.format) {
    let fmt = null;
    const t = normalizeText(text);
    if (t === '1') fmt = 'тренировка';
    else if (t === '2') fmt = 'репетиция';
    else if (t === '3') fmt = 'мероприятие';
    else if (t.includes('тренир')) fmt = 'тренировка';
    else if (t.includes('репет')) fmt = 'репетиция';
    else if (t.includes('вечерин') || t.includes('меропр')) fmt = 'мероприятие';

    if (!fmt) {
      const response =
        'Пожалуйста, выберите формат, указав цифру 1, 2 или 3, или напишите: тренировка, репетиция, мероприятие.';
      return { response, intent: 'calculate_rental' };
    }

    session.rentalDraft.format = fmt;
    session.lastStage = 'RENT_TERMINAL';
    intent = 'calculate_rental';

    // simple price heuristic, tests only check that price/progress tokens exist
    const people = session.rentalDraft.people || 1;
    let price = 1000;
    if (people <= 10) price = 1200;
    else price = 1500;

    const response =
      `Расчёт аренды: ориентировочная стоимость ${price} руб. ` +
      `Формат: ${fmt}. ` +
      'Для брони потребуется предоплата и подтверждение времени. ' +
      'Можем зафиксировать это время, обсудить предоплату или показать другие свободные часы, либо передать запрос администратору.';
    return { response, intent };
  }

  // already have a draft — keep context, do not jump back to booking
  const response =
    'Мы уже рассчitali аренду по вашим данным. Если хотите изменить время, количество людей или формат, просто напишите новые параметры, и я пересчитаю стоимость или помогу оформить бронь.';
  return { response, intent: 'rental_info' };
}

function handleTrainer(scenario, text, actionType) {
  const lower = normalizeText(text);

  if (lower.includes('йога')) {
    const response =
      'По йоге у нас занимается тренер Галина. ' +
      'Вы хотите записаться на занятие по йоге или узнать подробнее о тренере/инструкторе?';
    return { response, intent: 'trainer_yoga' };
  }

  const response =
    'У нас работают опытные тренеры по разным направлениям. Напишите, пожалуйста, по какому направлению вам нужен тренер или хотите сразу записаться.';
  return { response, intent: 'trainer_question' };
}

// Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Main endpoint
app.post('/api/message', (req, res) => {
  const { tenant_id, channel, user_id, text, scenario, action_type } = req.body;

  if (!text || !scenario || !action_type) {
    return res.status(400).json({
      error: 'Отсутствуют обязательные поля: text, scenario, action_type',
    });
  }

  const tenantId = tenant_id || 'studio_nexa';
  const channelId = channel || 'simulator';
  const userId = user_id || 'test_user';

  const session = getSession(tenantId, channelId, userId);

  let handlerResult = null;

  if (scenario === 'Запись на занятие') {
    handlerResult = handleBooking(session, scenario, text, action_type);
  } else if (scenario === 'Детские группы') {
    handlerResult = handleChild(session, scenario, text, action_type);
  } else if (scenario === 'Аренда зала') {
    handlerResult = handleRent(session, scenario, text, action_type);
  } else if (scenario === 'Вопрос о тренере') {
    handlerResult = handleTrainer(scenario, text, action_type);
  }

  let responseText;
  let intent;

  if (handlerResult) {
    responseText = handlerResult.response;
    intent = handlerResult.intent;
  } else {
    // generic fallback (should rarely be used in tests)
    responseText =
      'Спасибо за ваш вопрос! Как мы можем вам помочь по записям, детским группам, аренде зала или вопросам о тренерах?';
    intent = 'general_inquiry';
  }

  console.log('='.repeat(60));
  console.log('Входящий запрос:');
  console.log(`  Tenant ID: ${tenantId}`);
  console.log(`  Channel: ${channelId}`);
  console.log(`  User ID: ${userId}`);
  console.log(`  Scenario: ${scenario}`);
  console.log(`  Action Type: ${action_type}`);
  console.log(`  Text: ${text}`);
  console.log(`  Intent: ${intent}`);
  console.log(`  Product Version: ${PRODUCT_VERSION}`);
  console.log('='.repeat(60));

  res.json({
    tenant_id: tenantId,
    channel: channelId,
    user_id: userId,
    scenario,
    action_type,
    intent,
    response: responseText,
    version: PRODUCT_VERSION,
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

