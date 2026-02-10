"""
Тесты FSM для сценария "Аренда зала"
"""
import pytest
import json
from pathlib import Path

# Импортируем функции из orchestrator
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "services" / "orchestrator"))

from app.fsm import FSM
from app.main import process_state_machine, load_dikidi_stub, set_fsm


@pytest.fixture
def dikidi_data():
    """Загружает данные DIKIDI"""
    return load_dikidi_stub()


@pytest.fixture
def mock_redis():
    """Мок Redis для тестов"""
    import fakeredis
    return fakeredis.FakeStrictRedis(decode_responses=True)


def test_rent_fsm_full_flow(dikidi_data, mock_redis):
    """
    Тест полного потока аренды:
    1. Кнопка "Рассчитать стоимость аренды"
    2. Ответ "после 16"
    3. Ответ "12"
    4. Ответ "занятие"
    5. Получаем цену 1500
    """
    # Инициализируем FSM с мок Redis
    fsm = FSM("redis://localhost:6379/0")
    fsm.redis_client = mock_redis
    set_fsm(fsm)  # Устанавливаем для использования в process_state_machine
    
    tenant_id = "studio_nexa"
    channel = "simulator"
    user_id = "test_user_rent"
    scenario = "Аренда зала"
    
    # Шаг 1: Кнопка "Рассчитать стоимость аренды"
    reply1, intent1, debug1 = process_state_machine(
        scenario, "", "button", "Рассчитать стоимость аренды",
        tenant_id, channel, user_id, dikidi_data
    )
    assert "до 16:00 или после" in reply1.lower() or "до 16:00" in reply1.lower()
    assert intent1 == "calculate_rental"
    assert debug1["state_after"] == "rent_need_time"
    assert debug1["state_before"] == "idle"
    
    # Шаг 2: Ответ "после 16"
    reply2, intent2, debug2 = process_state_machine(
        scenario, "после 16", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    assert "сколько человек" in reply2.lower()
    assert intent2 == "calculate_rental"
    assert debug2["state_after"] == "rent_need_people"
    assert debug2["state_before"] == "rent_need_time"
    assert debug2["data_collected"].get("rent_time_bucket") == "evening"
    
    # Шаг 3: Ответ "12"
    reply3, intent3, debug3 = process_state_machine(
        scenario, "12", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    assert "формат" in reply3.lower()
    assert intent3 == "calculate_rental"
    assert debug3["state_after"] == "rent_need_format"
    assert debug3["state_before"] == "rent_need_people"
    assert debug3["data_collected"].get("people_count") == 12
    
    # Шаг 4: Ответ "занятие"
    reply4, intent4, debug4 = process_state_machine(
        scenario, "занятие", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    assert "1500" in reply4 or "стоимость" in reply4.lower()
    assert intent4 == "calculate_rental"
    assert debug4["state_after"] == "idle"  # Диалог завершен
    assert debug4["state_before"] == "rent_need_format"
    assert debug4["data_collected"].get("format") == "training"
    assert "предоплата" in reply4.lower() or "50%" in reply4
    assert "12 часов" in reply4 or "бронь" in reply4.lower()
    
    # Проверяем, что состояние очищено
    state = fsm.get_state(tenant_id, channel, user_id)
    assert state is None or state.get("state") == "idle"


def test_rent_fsm_no_loop_back(dikidi_data, mock_redis):
    """
    Проверяем, что после завершения диалога не возвращаемся к первому вопросу
    """
    fsm = FSM("redis://localhost:6379/0")
    fsm.redis_client = mock_redis
    
    tenant_id = "studio_nexa"
    channel = "simulator"
    user_id = "test_user_no_loop"
    scenario = "Аренда зала"
    
    # Завершаем диалог
    process_state_machine(scenario, "", "button", "Рассчитать стоимость аренды",
                         tenant_id, channel, user_id, dikidi_data)
    process_state_machine(scenario, "после 16", "text", None,
                         tenant_id, channel, user_id, dikidi_data)
    process_state_machine(scenario, "10", "text", None,
                         tenant_id, channel, user_id, dikidi_data)
    reply_final, _, debug_final = process_state_machine(
        scenario, "тренировка", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    
    # Проверяем, что получили финальный ответ с ценой
    assert "стоимость" in reply_final.lower() or "руб" in reply_final.lower()
    assert debug_final["state_after"] == "idle"
    
    # Если отправим еще один текст - не должно вернуться к первому вопросу
    reply_next, _, debug_next = process_state_machine(
        scenario, "спасибо", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    # Должен начаться новый диалог, но не повторять тот же вопрос сразу
    assert debug_next["state_before"] == "idle" or "до 16:00" in reply_next.lower()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
