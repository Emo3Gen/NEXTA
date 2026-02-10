import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealthy(baseUrl, timeoutMs = 8000) {
  const healthUrl = `${baseUrl}/health`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return true;
    } catch (_) {}
    await sleep(150);
  }
  return false;
}

function mustNotContain(haystack, needles, msg) {
  const lower = (haystack || '').toLowerCase();
  for (const n of needles) {
    expect(lower.includes(n.toLowerCase()), msg || `Must not contain: ${n}`).toBe(false);
  }
}
function mustContainOneOf(haystack, needles, msg) {
  const lower = (haystack || '').toLowerCase();
  const ok = needles.some((n) => lower.includes(n.toLowerCase()));
  expect(ok, msg || `Must contain one of: ${needles.join(', ')}`).toBe(true);
}

let proc;
let BASE_URL;
let API_URL;

function postMessage({ scenario, text, action_type = 'text', tenant_id = 'studio_nexa', channel = 'simulator', user_id = 'test_user' }) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id, channel, user_id, text, scenario, action_type }),
  });
}

async function send({ scenario, text, action_type = 'text' }) {
  const res = await postMessage({ scenario, text, action_type });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, json };
}

beforeAll(async () => {
  const port = await getFreePort();
  BASE_URL = `http://127.0.0.1:${port}`;
  API_URL = `${BASE_URL}/api/message`;

  proc = spawn('node', ['server.js'], {
    cwd: '/Users/evgenij/NEXTA/orchestrator',
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  });

  const healthy = await waitForHealthy(BASE_URL);
  expect(healthy, `Orchestrator did not become healthy on ${BASE_URL}.`).toBe(true);

  // Sanity: /api/message must exist (should return 400 if missing required fields, NOT 404)
  const sanity = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect([400, 200].includes(sanity.status), `Expected /api/message to exist; got ${sanity.status} (404 means wrong server/route).`).toBe(true);
});

afterAll(async () => {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
    await sleep(200);
  }
});

describe('NEXA v0.1.2 conversation behavior (product acceptance)', () => {
  it('health check returns ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.ok).toBe(true);
    const j = await res.json();
    expect(j.status).toBe('ok');
  });

  it('A) Booking flow does not reset after choosing direction+day (Latina -> Wednesday)', async () => {
    const scenario = 'Запись на занятие';

    const r1 = await send({ scenario, text: 'Записаться на пробное занятие', action_type: 'button' });
    expect(r1.status).toBe(200);

    const r2 = await send({ scenario, text: 'Латина', action_type: 'text' });
    expect(r2.status).toBe(200);

    const r3 = await send({ scenario, text: 'среда', action_type: 'text' });
    expect(r3.status).toBe(200);

    const reply = r3.json?.response || '';

    mustNotContain(reply, [
      'какое направление',
      'мы предлагаем пробное занятие',
      'предлагаем начать с пробного занятия',
    ], 'Loop/reset detected after selecting a day.');

    mustContainOneOf(reply, [
      'подтверд',
      'зафикс',
      'имя',
      'телефон',
      'контакт',
      'передан администратору',
      'альтернатив',
      'выберите время',
    ], 'No next step offered after day selection.');
  });

  it('B) Fuzzy recognition: "хай" should map to High Heels (no hard reject)', async () => {
    const scenario = 'Запись на занятие';

    const r1 = await send({ scenario, text: 'Записаться на пробное занятие', action_type: 'button' });
    expect(r1.status).toBe(200);

    const r2 = await send({ scenario, text: 'хай', action_type: 'text' });
    expect(r2.status).toBe(200);

    const reply = r2.json?.response || '';

    mustContainOneOf(reply, ['high heels', 'хай хил', 'хилс', 'вы имеете в виду'], 'Did not infer High Heels from "хай".');
    mustNotContain(reply, ['выберите направление из предложенного списка'], 'Hard reject instead of fuzzy match.');
  });

  it('C) Fuzzy recognition: "данс" should map to Dance Mix (no hard reject)', async () => {
    const scenario = 'Запись на занятие';

    const r1 = await send({ scenario, text: 'Записаться на пробное занятие', action_type: 'button' });
    expect(r1.status).toBe(200);

    const r2 = await send({ scenario, text: 'данс', action_type: 'text' });
    expect(r2.status).toBe(200);

    const reply = r2.json?.response || '';

    mustContainOneOf(reply, ['dance mix', 'данс микс', 'вы имеете в виду'], 'Did not infer Dance Mix from "данс".');
    mustNotContain(reply, ['выберите направление из предложенного списка'], 'Hard reject instead of fuzzy match.');
  });

  it('D) Child flow: no 18+ directions; ask age once; explain unavailability; offer next step', async () => {
    const scenario = 'Детские группы';

    const r1 = await send({ scenario, text: 'Детские группы', action_type: 'button' });
    expect(r1.status).toBe(200);
    const reply1 = r1.json?.response || '';

    mustNotContain(reply1, ['high heels', 'латина solo', '18+'], 'Adult directions leaked into child scenario.');

    const r2 = await send({ scenario, text: 'Азбука', action_type: 'text' });
    expect(r2.status).toBe(200);

    const r3 = await send({ scenario, text: '6', action_type: 'text' });
    expect(r3.status).toBe(200);
    const reply3 = r3.json?.response || '';

    if ((reply3 || '').toLowerCase().includes('нет подходящей группы') || (reply3 || '').toLowerCase().includes('пока нет')) {
      mustContainOneOf(reply3, ['азбук', 'dance mix', 'choreo', 'альтернатив', 'администратор'], 'Vague "no group" without specifics/next step.');
    }

    mustNotContain(reply3, ['сколько лет вашему ребенку', 'возраст ребенка'], 'Asked age again after it was provided.');
    mustContainOneOf(reply3, ['альтернатив', 'подберем', 'передан администратору', 'запис', 'распис'], 'No next step in child flow after age.');
  });

  it('E) Schedule: after selecting direction, schedule view does not forget it and does not demand direction without list', async () => {
    const scenario = 'Запись на занятие';

    await send({ scenario, text: 'Записаться на пробное занятие', action_type: 'button' });
    await send({ scenario, text: 'Азбука', action_type: 'text' });

    const r3 = await send({ scenario, text: 'посмотреть расписание', action_type: 'button' });
    expect(r3.status).toBe(200);

    const r4 = await send({ scenario, text: 'среда', action_type: 'text' });
    expect(r4.status).toBe(200);
    const reply4 = r4.json?.response || '';

    mustNotContain(reply4, ['выберите направление из предложенного списка'], 'Demanded direction without showing list.');
    mustNotContain(reply4, ['какое направление интересует'], 'Forgot selected direction after schedule.');
    mustContainOneOf(reply4, ['подтверд', 'зафикс', 'имя', 'телефон', 'выберите время', 'альтернатив'], 'No next step after schedule + day.');
  });

  it('F) Rent: supports numeric format selection (1/2/3) and offers next step after price', async () => {
    const scenario = 'Аренда зала';

    const r1 = await send({ scenario, text: 'Рассчитать стоимость аренды', action_type: 'button' });
    expect(r1.status).toBe(200);

    const r2 = await send({ scenario, text: '16:00', action_type: 'text' });
    expect(r2.status).toBe(200);

    const r3 = await send({ scenario, text: '6', action_type: 'text' });
    expect(r3.status).toBe(200);

    const r4 = await send({ scenario, text: '1', action_type: 'text' });
    expect(r4.status).toBe(200);

    const reply4 = r4.json?.response || '';

    mustNotContain(reply4, ['пробное занятие', 'какое направление'], 'Jumped to booking flow after rent interaction.');
    mustContainOneOf(reply4, ['₽', 'руб', 'стоим', 'расчет', 'итог'], 'No price/progress indication after providing inputs.');
    mustContainOneOf(reply4, ['зафикс', 'предоплат', 'передан администратору', 'свободные часы', 'бронь'], 'No next step after rent calculation.');
  });

  it('G) Trainer: "йога" must trigger clarification or trainer info, not generic filler', async () => {
    const scenario = 'Вопрос о тренере';

    const r1 = await send({ scenario, text: 'йога', action_type: 'text' });
    expect(r1.status).toBe(200);

    const reply = r1.json?.response || '';

    mustNotContain(reply, ['спасибо за ваш вопрос! как мы можем вам помочь'], 'Generic filler answer detected.');
    mustContainOneOf(reply, ['йога', 'тренер', 'инструктор', 'запис', 'галин'], 'No clarification or relevant trainer info for yoga.');
  });

  it('H) Regression: bot must not return to initial trial-offer template after mid-flow action', async () => {
    const scenario = 'Запись на занятие';

    await send({ scenario, text: 'Записаться на пробное занятие', action_type: 'button' });
    await send({ scenario, text: 'Азбука', action_type: 'text' });

    const r3 = await send({ scenario, text: 'суббота', action_type: 'text' });
    expect(r3.status).toBe(200);

    const reply = r3.json?.response || '';

    mustNotContain(reply, [
      'мы предлагаем пробное занятие для новых учеников',
      'предлагаем начать с пробного занятия',
    ], 'Returned to initial trial-offer template after mid-flow choice.');
  });
});
