"""
Behavior/E2E tests for v0.1.2 requirements of the
"Танцуй со мной" AI admin chat.

These tests are black-box with respect to the orchestrator API:
- use the real /chat endpoint
- rely on FSM + Redis-backed session memory
- assert on debug metadata, not internal implementation details
"""
from __future__ import annotations

import pytest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from chat_session import ChatSession  # type: ignore

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "services" / "orchestrator"))
from app.fsm import FSM  # type: ignore
from app.main import set_fsm  # type: ignore


@pytest.fixture(autouse=True)
def reset_fsm():
    """
    For each test, inject a fresh in-memory Redis-backed FSM.

    This ensures:
    - deterministic behavior
    - no cross-test contamination of session memory
    """
    import fakeredis

    fake_redis = fakeredis.FakeStrictRedis(decode_responses=True)
    fsm = FSM("redis://localhost:6379/0")
    fsm.redis_client = fake_redis
    set_fsm(fsm)
    yield


@pytest.mark.asyncio
async def test_adult_booking_latina_choose_day():
    """
    A) Adult booking: “Latina” + choose day

    Product checks:
    - no restart of flow / no repeated direction question once chosen
    - forward-only progression towards terminal booking state
    - memory contains selectedDirection and selectedDay (if exposed)
    """
    session = ChatSession(scenario="Запись на занятие", user_id="adult_latina_flow")

    # Step 1: user presses quick action "Записаться на пробное занятие"
    reply1, data1 = await session.send(
        "Записаться на пробное занятие",
        action_type="button",
        action_name="Записаться на пробное занятие",
    )
    assert "пробн" in reply1.lower() or "направлен" in reply1.lower(), (
        "After pressing 'Записаться на пробное занятие' bot must start booking, "
        "not respond with a generic greeting."
    )

    # Step 2: user: “Латина”
    reply2, data2 = await session.send("Латина")
    debug2 = data2.get("debug", {})
    collected2 = debug2.get("data_collected", {})

    # Fuzzy match: direction must be recognized as latina_solo_18
    assert collected2.get("direction") == "latina_solo_18", (
        "Booking flow: text 'Латина' must be mapped to latina_solo_18 "
        "(direction remembered in session memory)."
    )

    # Step 3: user chooses a day: “среда”
    reply3, data3 = await session.send("среда")
    debug3 = data3.get("debug", {})
    collected3 = debug3.get("data_collected", {})

    # The bot must not restart or ask for direction again
    assert "какое направление" not in reply3.lower(), (
        "Booking flow: after user specified direction once, bot must not "
        "ask for direction again."
    )

    # It should move forward (e.g. offering confirmation, slots, or next step)
    assert any(
        phrase in reply3.lower()
        for phrase in ("подтверд", "слот", "время", "записать", "бронь")
    ), (
        "Booking flow: after user picks a day, bot should move towards "
        "confirming booking or next concrete action."
    )

    # If implementation exposes selected day in memory, assert it
    # (optional, but helps catch context loss regressions)
    if "selected_day" in collected3:
        assert "сред" in str(collected3["selected_day"]).lower(), (
            "Session memory should store selectedDay ≈ 'среда'."
        )


@pytest.mark.asyncio
async def test_fuzzy_match_high_heels_via_hai():
    """
    B) Natural input fuzzy match: High Heels via “хай”

    Product checks:
    - input 'хай' should map to the High Heels direction id
    - bot should not dead-end or reject input
    - bot should not ask to choose from a list without actually showing it
    """
    session = ChatSession(scenario="Запись на занятие", user_id="fuzzy_high_heels")

    # Initiate booking
    await session.send(
        "Записаться на пробное занятие",
        action_type="button",
        action_name="Записаться на пробное занятие",
    )

    # Fuzzy input: “хай”
    reply, data = await session.send("хай")
    debug = data.get("debug", {})
    collected = debug.get("data_collected", {})

    # Direction should be recognized as high_heels_18
    assert collected.get("direction") == "high_heels_18", (
        "Input 'хай' must be fuzzily mapped to direction high_heels_18."
    )

    # Response must not be a dead-end
    assert any(
        phrase in reply.lower()
        for phrase in ("расписан", "слот", "время", "запис", "группа")
    ), (
        "After recognizing direction from 'хай', bot must continue the booking "
        "flow instead of stopping."
    )

    # Bot MUST NOT say "выберите из списка" unless it printed a list
    lower = reply.lower()
    if "выберите из" in lower:
        assert "•" in reply or "1)" in reply, (
            "Bot must not ask to 'choose from list' without actually showing options."
        )


@pytest.mark.asyncio
async def test_fuzzy_match_dance_mix_via_dans():
    """
    C) Natural input fuzzy match: Dance Mix via “данс” (Cyrillic).
    """
    session = ChatSession(scenario="Запись на занятие", user_id="fuzzy_dance_mix")

    await session.send(
        "Записаться на пробное занятие",
        action_type="button",
        action_name="Записаться на пробное занятие",
    )

    reply, data = await session.send("данс")
    debug = data.get("debug", {})
    collected = debug.get("data_collected", {})

    # Should map to dance_mix_7_11 or a compatible child direction
    assert collected.get("direction") in {"dance_mix_7_11", "azbuka_3_5", "choreo_12_17"}, (
        "Input 'данс' should map to a dance-related direction, not hard-fail."
    )
    assert "ошиб" not in reply.lower(), (
        "Bot must not hard-fail on Cyrillic fuzzy input 'данс'."
    )


@pytest.mark.asyncio
async def test_child_flow_separation_and_age_memory():
    """
    D) Child flow separation + age memory.

    - scenario = 'Детские группы'
    - no adult directions shown
    - age asked once and remembered
    - explanation when no exact group for age
    - always offers a next step
    """
    session = ChatSession(scenario="Детские группы", user_id="child_flow_age")

    # Step 1: starting text to initiate child flow
    reply1, data1 = await session.send("Детские группы")
    lower1 = reply1.lower()

    # Must not mention adult-only groups
    assert "латина соло" not in lower1 and "хай хилс" not in lower1, (
        "Child flow: initial response must not suggest adult-only directions."
    )

    # Step 2: user: “Азбука”
    reply2, data2 = await session.send("Азбука")
    lower2 = reply2.lower()
    assert "возраст" in lower2 or "сколько лет" in lower2, (
        "Child flow: after direction hint, bot should ask for child age."
    )

    # Step 3: user: “6”
    reply3, data3 = await session.send("6")
    debug3 = data3.get("debug", {})
    collected3 = debug3.get("data_collected", {})

    # Age is stored once
    assert collected3.get("age") == 6, "Child flow: age must be stored in session memory."

    # If no exact group, must explain and propose alternatives or admin
    lower3 = reply3.lower()
    assert "групп" in lower3 or "альтернатив" in lower3 or "администратор" in lower3, (
        "Child flow: when there is no exact group for given age, bot should "
        "explain and propose alternatives or escalation."
    )

    # Age should not be asked again on follow-up
    reply4, data4 = await session.send("суббота")
    lower4 = reply4.lower()
    assert "возраст" not in lower4, (
        "Child flow: once age is known, bot must not ask for age again."
    )


@pytest.mark.asyncio
async def test_schedule_view_preserves_context():
    """
    E) Schedule view should preserve context.

    - User chooses Азбука
    - Requests schedule view
    - Chooses a day
    Assertions:
    - direction context is not lost
    - bot does not re-ask to choose direction without showing a list
    - guides to a next action
    """
    session = ChatSession(scenario="Запись на занятие", user_id="schedule_context")

    await session.send(
        "Записаться на пробное занятие",
        action_type="button",
        action_name="Записаться на пробное занятие",
    )
    # user: “Азбука”
    await session.send("Азбука")

    # user: “посмотреть расписание”
    reply3, data3 = await session.send("посмотреть расписание")
    lower3 = reply3.lower()
    assert "расписан" in lower3, "Bot should show schedule when user asks 'посмотреть расписание'."

    # user: “среда”
    reply4, data4 = await session.send("среда")
    lower4 = reply4.lower()
    debug4 = data4.get("debug", {})
    collected4 = debug4.get("data_collected", {})

    # Direction must still be present in memory
    assert collected4.get("direction") is not None, (
        "Schedule: direction must be preserved in memory after showing schedule."
    )

    # Bot must not suddenly ask to choose direction again without showing list
    assert "какое направление" not in lower4, (
        "Schedule: bot must not re-ask for direction after it was chosen."
    )

    # Must propose a next step
    assert any(
        phrase in lower4
        for phrase in ("запис", "подтверд", "администратор", "другой день")
    ), (
        "Schedule: bot should guide user to a next action after day selection."
    )


@pytest.mark.asyncio
async def test_rent_price_calculation_and_next_step():
    """
    F) Rent price calculation + next step.

    Steps:
    1. “Аренда зала”
    2. “16:00”
    3. “6”
    4. “1”

    Assertions:
    - numeric selection for format works
    - price is returned and mentions prepayment/booking rules
    - bot proposes next step, not booking trial
    """
    session = ChatSession(scenario="Аренда зала", user_id="rent_flow")

    # Start rent flow with time
    reply1, data1 = await session.send("Аренда зала")
    lower1 = reply1.lower()
    assert "аренд" in lower1 or "формат" in lower1 or "до 16" in lower1, (
        "Rent: first response must orient user towards time/format, not generic greeting."
    )

    reply2, data2 = await session.send("16:00")
    lower2 = reply2.lower()
    assert "сколько человек" in lower2, (
        "Rent: after time, bot must ask for people count."
    )

    reply3, data3 = await session.send("6")
    lower3 = reply3.lower()
    assert "формат" in lower3, (
        "Rent: after people count, bot must ask for format."
    )

    # Numeric selection “1” should work (e.g. Training)
    reply4, data4 = await session.send("1")
    lower4 = reply4.lower()
    assert "руб" in lower4 or "стоимост" in lower4, (
        "Rent: after numeric format selection, bot must return a price."
    )
    assert "предоплат" in lower4 or "бронь" in lower4, (
        "Rent: response must mention prepayment/booking constraints."
    )

    # Bot must propose a next step, not jump back to trial booking
    assert "пробное занятие" not in lower4, (
        "Rent: after price calculation, bot must not jump to trial class booking."
    )
    assert any(
        phrase in lower4
        for phrase in ("забронировать", "зафиксировать", "администратор", "другой вариант")
    ), (
        "Rent: bot should propose a clear next step after giving a price."
    )


@pytest.mark.asyncio
async def test_trainer_info_yoga_intent_clarification():
    """
    G) Trainer info: yoga intent clarification.

    - Input 'Йога' should not produce a generic 'Как можем помочь?'
    - Bot should either clarify (booking vs trainer info) or directly provide trainer info.
    """
    session = ChatSession(scenario="Вопрос о тренере", user_id="trainer_yoga")

    reply, data = await session.send("Йога")
    lower = reply.lower()

    assert "как мы можем вам помочь" not in lower, (
        "Trainer flow: bot must not respond with generic 'Как можем помочь?' "
        "for specific 'Йога' intent."
    )
    assert any(
        phrase in lower
        for phrase in ("записаться на йогу", "узнать про тренера", "тренер", "занятие по йоге")
    ), (
        "Trainer flow: bot should clarify whether user wants booking or trainer info "
        "for yoga, or provide trainer details directly."
    )


@pytest.mark.asyncio
async def test_no_loop_back_to_start_after_mid_flow():
    """
    H) Loop regression test.

    After user selected direction and day, bot must not send the original
    trial-offer/greeting template again.
    """
    session = ChatSession(scenario="Запись на занятие", user_id="no_loop_back")

    # Start booking
    reply1, data1 = await session.send(
        "Записаться на пробное занятие",
        action_type="button",
        action_name="Записаться на пробное занятие",
    )
    lower1 = reply1.lower()
    assert "пробн" in lower1 or "направлен" in lower1, (
        "Booking: initial response must correspond to starting booking, not idle greeting."
    )

    # Direction
    await session.send("Латина")
    # Day
    reply3, data3 = await session.send("пятница")
    lower3 = reply3.lower()

    # The next message must not look like the very first trial-offer template
    assert not (
        "записаться на пробное занятие" in lower3
        and "выберите сценарий" in lower3
    ), (
        "Loop regression: after mid-flow actions, bot must not resend initial "
        "trial-offer/landing style message."
    )

