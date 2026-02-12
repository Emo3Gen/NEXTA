/* LLM-based QA for NEXA orchestrator
 *
 * Вызывает orchestrator, затем задаёт LLM вопросы о качестве ответов.
 * Требует: OPENAI_API_KEY, работающий orchestrator на BASE_URL.
 *
 * Usage:
 *   BASE_URL=http://localhost:8001 OPENAI_API_KEY=sk-... node tests/run_llm_qa.js
 *   npm run test:llmqa
 *
 * LLM params:
 *   OPENAI_API_KEY  - ключ OpenAI (обязательно)
 *   OPENAI_BASE_URL - опционально, default: https://api.openai.com/v1
 *   LLM_MODEL      - опционально, default: gpt-4o-mini
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "http://localhost:8001";
const CHAT_ENDPOINT = process.env.CHAT_ENDPOINT || "/api/message";
const CHAT_ID = process.env.CHAT_ID || "llm_qa_chat";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

// Smart skip: if there is no key, do not fail. Write a report and exit 0.
if (!OPENAI_API_KEY || !String(OPENAI_API_KEY).trim()) {
  const reportPath = path.join(__dirname, "llmqa_report.json");
  const report = {
    ts: new Date().toISOString(),
    base_url: BASE_URL,
    skipped: true,
    reason: "OPENAI_API_KEY missing",
  };
  console.log("LLM-QA SKIPPED: OPENAI_API_KEY is not set");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Report: ${reportPath}`);
  process.exit(0);
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let json = null;
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    try {
      json = JSON.parse(raw);
    } catch (_) {}
  }
  return { status: res.status, raw, json };
}

function extractBotText(resp) {
  const j = resp.json;
  if (!j) return resp.raw || "";
  return j.text || j.reply?.text || j.message?.text || resp.raw || "";
}

function extractQuickActions(resp) {
  const j = resp.json;
  return j?.quick_actions || [];
}

async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY не задан. Укажите переменную окружения.");
  }
  const url = `${OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      max_tokens: 512,
      temperature: 0.2,
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${raw}`);
  }
  const data = JSON.parse(raw);
  const content = data?.choices?.[0]?.message?.content?.trim() || "";
  return content;
}

async function runConversation(steps) {
  const payload = { chat_id: CHAT_ID, text: "", scenario: "" };
  const botTexts = [];
  for (const step of steps) {
    payload.text = step.in;
    if (step.scenario) payload.scenario = step.scenario;
    const resp = await postJson(`${BASE_URL}${CHAT_ENDPOINT}`, payload);
    const text = extractBotText(resp);
    const quick_actions = extractQuickActions(resp);
    botTexts.push({ user: step.in, bot: text, quick_actions: quick_actions.length ? quick_actions : undefined });
  }
  return botTexts;
}

const JSON_SCHEMA = `{
  "verdict": "OK" | "PROBLEM",
  "issues": ["..."],
  "fix_task": {
    "summary": "...",
    "acceptance_criteria": ["..."]
  }
}`;

const PRODUCT_RULES = `
## Правила продукта (оценивать строго по ним)

1. Если пользователь на вопрос "Сколько лет ребёнку?" отвечает НЕ числом (например "завтра") → правильное поведение: повторить вопрос о возрасте и остаться в сценарии "Детские группы". Вердикт OK, если бот не переключает сценарий и спрашивает возраст снова.

2. Если возраст = 2 → правильное поведение: "рано" + обязательно CTA или следующий шаг (консультация / индивидуальные / оставить телефон / вернуться к возрасту). Без CTA — PROBLEM.

3. Если после "рано" пользователь вводит 15/22 → бот должен не зацикливаться и дать следующий шаг. CTA = уточняющий вопрос ("подросток или взрослый?") ИЛИ quick_actions (кнопки). Если в ответе есть quick_actions — это CTA. Повтор того же сообщения с quick_actions допустим (например, для 15 и 22 одинаковый ответ с [Для подростка, Для взрослого] — OK). Зацикливание на "рано" без CTA — PROBLEM.

## Запрещено в fix_task
- Предлагать "перейти к аренде" или менять сценарий без явной команды пользователя.
- Любые fix_task, которые предлагают сменить сценарий без причины.
`;

const FEW_SHOT_EXAMPLES = `
## Примеры

Пример OK (завтра вместо возраста):
Диалог: USER: Записаться на пробное занятие. BOT: Сколько лет ребёнку? USER: завтра. BOT: Сколько лет ребёнку?
Вердикт: OK. Бот повторил вопрос о возрасте, не переключился на аренду.

Пример OK (2 → рано → 22 → следующий шаг + quick_actions):
Диалог: USER: Записаться. BOT: Сколько лет? USER: 2. BOT: рано + quick_actions. USER: 22. BOT: От 14 лет — подростковые/взрослые группы. Уточните: подросток или взрослый? + quick_actions: [Для подростка, Для взрослого]
Вердикт: OK. Бот не зациклился на "рано", дал уточняющий вопрос И quick_actions — это CTA. Повтор того же сообщения с quick_actions допустим.

Пример PROBLEM (2 → рано → 22 → повтор "рано" без CTA):
Диалог: USER: Записаться. BOT: Сколько лет? USER: 2. BOT: Сейчас ещё рано. USER: 22. BOT: Сейчас ещё рано. (без CTA)
Вердикт: PROBLEM. fix_task: добавить CTA или уточняющий вопрос после ввода 15/22.
`;

async function askLLM(question, context, caseName) {
  const systemPrompt = `Ты — QA-ассистент. Оцениваешь ответы чат-бота студии танцев строго по правилам продукта.
${PRODUCT_RULES}
${FEW_SHOT_EXAMPLES}

Верни только JSON, без текста вокруг. Формат ответа строго:
${JSON_SCHEMA}`;
  let userContent = `Диалог для оценки: ${JSON.stringify(context, null, 2)}

Критерий для этого кейса: ${question}

Оцени по правилам продукта выше. Вердикт: OK или PROBLEM.`;
  if (caseName === "kids_age_2_15_22_no_early_loop") {
    const hasQA = context.conversation?.some((s) => s.quick_actions && s.quick_actions.length > 0);
    if (hasQA) {
      userContent += `\n\nПодсказка: в диалоге есть quick_actions в ответах бота. Это CTA — по правилу 3 вердикт OK.`;
    }
  }
  const content = await callOpenAI([
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ]);
  return content;
}

function parseVerdict(raw) {
  // извлечь JSON из ответа (на случай markdown-обёртки)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const str = jsonMatch ? jsonMatch[0] : raw;
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log("BASE_URL=" + BASE_URL);
  console.log("CHAT_ENDPOINT=" + CHAT_ENDPOINT);
  console.log("OPENAI_BASE_URL=" + OPENAI_BASE_URL);
  console.log("LLM_MODEL=" + LLM_MODEL);
  console.log("OPENAI_API_KEY=" + (OPENAI_API_KEY ? "***" : "(не задан)"));
  console.log("");

  // Health check
  const healthRes = await fetch(`${BASE_URL}/health`);
  if (!healthRes.ok) {
    console.error(`❌ Orchestrator не отвечает на ${BASE_URL}/health`);
    process.exit(1);
  }
  console.log("Health: HTTP " + healthRes.status);
  console.log("");

  const qaCases = [
    {
      name: "kids_age_invalid_reprompt",
      steps: [
        { in: "Записаться на пробное занятие", scenario: "Детские группы" },
        { in: "завтра", scenario: "Детские группы" },
      ],
      question: "Правило 1: пользователь ответил не числом ('завтра') вместо возраста. OK если бот повторил вопрос о возрасте и остался в Детские группы.",
    },
    {
      name: "rent_date_time_accepted",
      steps: [
        { in: "Хочу аренду", scenario: "Аренда зала" },
        { in: "завтра 18:00", scenario: "Аренда зала" },
      ],
      question: "Бот принял заявку (дата+время) и не просит повторно дату? OK — если да, PROBLEM — если просит дату снова.",
    },
    {
      name: "kids_age_2_15_22_no_early_loop",
      steps: [
        { in: "Записаться на пробное занятие", scenario: "Детские группы" },
        { in: "2", scenario: "Детские группы" },
        { in: "15", scenario: "Детские группы" },
        { in: "22", scenario: "Детские группы" },
      ],
      question: "Правила 2 и 3: возраст 2 → рано + CTA; после 15/22 → не зацикливаться, дать CTA. Важно: если в ответе есть quick_actions (например [Для подростка, Для взрослого]) — это CTA, вердикт OK. Повтор сообщения с quick_actions допустим.",
    },
  ];

  let passed = 0;
  let failed = 0;
  const report = {
    ts: new Date().toISOString(),
    base_url: BASE_URL,
    cases: [],
  };

  for (const tc of qaCases) {
    console.log("=== " + tc.name + " ===");
    const conv = await runConversation(tc.steps);
    for (const c of conv) {
      console.log("USER:", c.user);
      console.log("BOT: ", c.bot.slice(0, 150) + (c.bot.length > 150 ? "…" : ""));
    }
    const context = { conversation: conv };
    const llmRaw = await askLLM(tc.question, context, tc.name);
    const verdictObj = parseVerdict(llmRaw);

    const isOk =
      verdictObj &&
      (verdictObj.verdict === "OK" || verdictObj.verdict === "ok");
    const isProblem =
      verdictObj &&
      (verdictObj.verdict === "PROBLEM" || verdictObj.verdict === "problem");

    const caseResult = {
      name: tc.name,
      conversation: conv,
      llm_raw: llmRaw,
      verdict: verdictObj?.verdict ?? null,
      issues: verdictObj?.issues ?? [],
      fix_task: verdictObj?.fix_task ?? null,
      passed: isOk,
    };
    report.cases.push(caseResult);

    if (!verdictObj || (!isOk && !isProblem)) {
      console.log(`CASE: ${tc.name} verdict=PARSE_FAIL (невалидный JSON)`);
      console.log("LLM raw:", llmRaw.slice(0, 300));
      console.log("❌ FAIL");
      failed++;
    } else if (isOk) {
      console.log(`CASE: ${tc.name} verdict=OK`);
      console.log("✅ PASS");
      passed++;
    } else {
      console.log(`CASE: ${tc.name} verdict=PROBLEM`);
      const ft = verdictObj.fix_task;
      if (ft) {
        if (ft.summary) console.log("fix_task.summary:", ft.summary);
        if (ft.acceptance_criteria && ft.acceptance_criteria.length) {
          console.log("fix_task.acceptance_criteria:");
          ft.acceptance_criteria.forEach((c) => console.log("  -", c));
        }
      }
      if (verdictObj.issues && verdictObj.issues.length) {
        console.log("issues:", verdictObj.issues.join("; "));
      }
      console.log("❌ FAIL");
      failed++;
    }
    console.log("");
  }

  const reportPath = path.join(__dirname, "llmqa_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log("---");
  console.log(`LLM QA: ${passed} passed, ${failed} failed`);
  console.log(`Report: ${reportPath}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
