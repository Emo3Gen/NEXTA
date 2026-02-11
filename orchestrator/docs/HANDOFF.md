# HANDOFF

## What changed
- Глобалка «Расписание» в switch_scenario: спец-кейс g.scenario === 'Расписание' → возвращает SCHEDULE_FULL_TEXT (многострочное расписание) вместо entryMessage
- Вынесен SCHEDULE_FULL_TEXT в константу, используется в SHOW_SCHEDULE и в глобальной команде
- scenarios.json: rent_global_schedule_overrides_sticky — expect_any теперь требует «расписание»/«танцы»/«йога»/«гимнастика» (реальное расписание)

## Diff summary
- files: server.js, tests/scenarios.json

## How to test (from docs/NEXA_TESTS.md)
- [x] `cd orchestrator && npm run test:scenarios` — оба сценария PASS
- [x] Ручной: «Хочу аренду» → «Расписание» → показывается многострочное расписание

## Risks
- Минимальный. Приоритет глобалки над sticky сохранён.

---

## REVIEW (Agent B) — Status
FIXED

## REVIEW — Notes (max 5)
1) Несостыковка docs vs код: глобалка "Расписание" ведёт в entryMessageForScenario('Расписание') и задаёт вопрос вместо показа расписания.
2) Ослабление автотеста: tests/scenarios.json допускает "интересует/направление", поэтому PASS возможен без реального расписания.
3) Handoff "Risks: Нет" — неверно: риск ложнозелёного теста есть.

## REVIEW — One command
В orchestrator/server.js, в обработчике глобальных команд if (g && g.type === 'switch_scenario'), сделать спец-кейс для g.scenario === 'Расписание':
вместо entryMessageForScenario('Расписание') вернуть тот же многострочный блок расписания, который формируется в detectIntent(... 'SHOW_SCHEDULE').
Сохранить приоритет глобалки над sticky.

## REVIEW — How to verify (2–4 steps)
1) Прогнать: `cd orchestrator && npm run test:scenarios` (каноническая команда, см. WORKFLOW.md)
2) Ручной тест: "Хочу аренду" → затем "Расписание"
3) Ожидаемо: показывается многострочное расписание (Танцы/Йога/Гимнастика), а не вопрос "Какое направление интересует…"

---

## Agent B: Review / Command
_(Agent B пишет сюда замечания или одну команду)_
