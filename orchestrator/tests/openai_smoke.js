/* Smoke test: проверка доступа к OpenAI API.
 * Если ключ или доступ недоступны — exit 1.
 *
 * Usage: npm run test:openai
 */

require("dotenv").config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

async function smoke() {
  if (!OPENAI_API_KEY || !String(OPENAI_API_KEY).trim()) {
    console.error("OPENAI_SMOKE_FAIL: OPENAI_API_KEY не задан (проверь .env)");
    process.exit(1);
  }

  const url = `${OPENAI_BASE_URL}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      }),
    });

    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      console.error("OPENAI_SMOKE_FAIL: невалидный JSON:", raw.slice(0, 200));
      process.exit(1);
    }

    if (data?.choices && Array.isArray(data.choices) && data.choices.length > 0) {
      console.log("OPENAI_SMOKE_OK");
      process.exit(0);
    }

    const errMsg = data?.error?.message || data?.error || raw;
    console.error("OPENAI_SMOKE_FAIL:", errMsg);
    process.exit(1);
  } catch (e) {
    console.error("OPENAI_SMOKE_FAIL:", e?.message || String(e));
    process.exit(1);
  }
}

smoke();
