/* Minimal scenario runner for NEXA orchestrator
 *
 * Usage:
 *   BASE_URL=http://localhost:8001 CHAT_ID=test_chat_1 node tests/run_scenarios.js
 *
 * If your chat endpoint differs, set CHAT_ENDPOINT:
 *   CHAT_ENDPOINT=/ingest  (or /chat, /message, etc)
 *
 * Payload is guessed; if your server expects different keys,
 * adjust buildPayload() in one place.
 */

const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "http://localhost:8001";
const CHAT_ENDPOINT = process.env.CHAT_ENDPOINT || "/api/message";
const CHAT_ID = process.env.CHAT_ID || "scenario_chat";
const USER_ID = process.env.USER_ID || "tester";
const SOURCE = process.env.SOURCE || "tests";

const scenariosPath = path.join(__dirname, "scenarios.json");
const scenarios = JSON.parse(fs.readFileSync(scenariosPath, "utf-8"));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildPayload(text, scenario, chatId = CHAT_ID) {
  // Common shape used in many NEXA/Shiftledger-like servers
  // Adjust here if your server expects a different contract.
  const payload = {
    source: SOURCE,
    chat_id: chatId,
    user_id: USER_ID,
    text,
    meta: { role: "user" },
  };
  if (scenario) payload.scenario = scenario;
  return payload;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();

  let json = null;
  if (contentType.includes("application/json")) {
    try {
      json = JSON.parse(raw);
    } catch (_) {
      // fall through
    }
  } else {
    // sometimes servers respond text; keep raw
  }

  return { status: res.status, raw, json };
}

function normalizeText(s) {
  return (s || "").toString().toLowerCase();
}

function extractBotMessage(resp) {
  // Heuristics: adapt to your server's response format
  // Accepts:
  //  - { text, quick_actions }
  //  - { reply: { text, quick_actions } }
  //  - { message: { text, quick_actions } }
  //  - array of messages: [{ role, text }]
  const j = resp.json;

  if (!j) return { text: resp.raw || "", quick_actions: [] };

  if (typeof j.text === "string") return { text: j.text, quick_actions: j.quick_actions || [] };
  if (j.reply && typeof j.reply.text === "string") return { text: j.reply.text, quick_actions: j.reply.quick_actions || [] };
  if (j.message && typeof j.message.text === "string") return { text: j.message.text, quick_actions: j.message.quick_actions || [] };

  if (Array.isArray(j.messages)) {
    const last = [...j.messages].reverse().find((m) => m && (m.role === "assistant" || m.role === "bot") && typeof m.text === "string");
    if (last) return { text: last.text, quick_actions: last.quick_actions || [] };
  }

  // fallback: best-effort stringify
  return { text: JSON.stringify(j), quick_actions: j.quick_actions || [] };
}

function assertIncludesAny(haystack, needles, ctx) {
  const h = normalizeText(haystack);
  const ok = needles.some((n) => h.includes(normalizeText(n)));
  if (!ok) {
    throw new Error(`ASSERT FAIL: expected any of ${JSON.stringify(needles)} in bot text.\nContext: ${ctx}\nBot: ${haystack}`);
  }
}

function assertNotIncludesAny(haystack, needles, ctx) {
  const h = normalizeText(haystack);
  const found = needles.find((n) => h.includes(normalizeText(n)));
  if (found) {
    throw new Error(`ASSERT FAIL: expected NONE of ${JSON.stringify(needles)} in bot text.\nContext: ${ctx}\nBot: ${haystack}\nFound: ${found}`);
  }
}

async function runScenario(scn) {
  console.log(`\n=== Scenario: ${scn.name} ===`);
  let lastBot = { text: "", quick_actions: [] };

  for (let i = 0; i < scn.steps.length; i++) {
    const step = scn.steps[i];

    if (step.in != null) {
      const url = `${BASE_URL}${CHAT_ENDPOINT}`;
      const payload = buildPayload(step.in, scn.scenario, `${CHAT_ID}_${scn.name}`);

      const resp = await postJson(url, payload);
      if (resp.status >= 400) {
        throw new Error(`HTTP ${resp.status} on ${url}\nResponse: ${resp.raw}`);
      }

      lastBot = extractBotMessage(resp);
      console.log(`USER: ${step.in}`);
      console.log(`BOT:  ${String(lastBot.text).slice(0, 180)}${String(lastBot.text).length > 180 ? "…" : ""}`);

      // small delay to avoid race conditions in some local setups
      await sleep(50);
    }

    if (step.expect_any) {
      assertIncludesAny(lastBot.text, step.expect_any, `${scn.name} step ${i + 1}`);
    }

    if (step.expect_quick_actions) {
      const qa = lastBot.quick_actions || [];
      if (!Array.isArray(qa) || qa.length === 0) {
        throw new Error(
          `ASSERT FAIL: expected quick_actions array with items.\nScenario: ${scn.name}\nBot text: ${lastBot.text}\nquick_actions: ${JSON.stringify(qa)}`
        );
      }
      console.log(`quick_actions OK: ${qa.length} item(s)`);
    }

    if (step.expect_not_any) {
      assertNotIncludesAny(lastBot.text, step.expect_not_any, `${scn.name} step ${i + 1}`);
      console.log(`expect_not_any OK: none of ${JSON.stringify(step.expect_not_any)}`);
    }
  }

  console.log(`✅ PASS: ${scn.name}`);
}

async function main() {
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`CHAT_ENDPOINT=${CHAT_ENDPOINT}`);
  console.log(`CHAT_ID=${CHAT_ID}\n`);

  // Quick sanity ping (optional): if you have /health
  try {
    const health = await fetch(`${BASE_URL}/health`);
    console.log(`Health: HTTP ${health.status}`);
  } catch (e) {
    console.log(`Health check skipped/failed: ${e.message}`);
  }

  let passed = 0;
  for (const scn of scenarios) {
    await runScenario(scn);
    passed++;
  }

  console.log(`\n✅ All scenarios passed: ${passed}/${scenarios.length}`);
}

main().catch((e) => {
  console.error(`\n❌ TEST RUN FAILED\n${e.stack || e.message || e}`);
  process.exit(1);
});
