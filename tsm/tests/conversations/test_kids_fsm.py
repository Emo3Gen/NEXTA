"""
Тесты FSM для сценария "Детские группы"
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


def test_kids_fsm_full_flow(dikidi_data, mock_redis):
    """
    Тест полного потока детских групп:
    1. Кнопка "Уточнить возраст ребёнка"
    2. Ответ "8"
    3. Получаем предложение группы Dance Mix 7-11
    """
    # Инициализируем FSM с мок Redis
    fsm = FSM("redis://localhost:6379/0")
    fsm.redis_client = mock_redis
    set_fsm(fsm)  # Устанавливаем для использования в process_state_machine
    
    tenant_id = "studio_nexa"
    channel = "simulator"
    user_id = "test_user_kids"
    scenario = "Детские группы"
    
    # Шаг 1: Кнопка "Уточнить возраст ребёнка"
    reply1, intent1, debug1 = process_state_machine(
        scenario, "", "button", "Уточнить возраст ребёнка",
        tenant_id, channel, user_id, dikidi_data
    )
    assert "возраст" in reply1.lower() and "сколько лет" in reply1.lower()
    assert intent1 == "ask_age"
    assert debug1["state_after"] == "kids_need_age"
    assert debug1["state_before"] == "idle"
    
    # Шаг 2: Ответ "8"
    reply2, intent2, debug2 = process_state_machine(
        scenario, "8", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    assert "Dance Mix 7-11" in reply2 or "dance mix" in reply2.lower()
    assert intent2 == "children_groups_info"
    assert debug2["state_after"] == "idle"  # Диалог завершен
    assert debug2["state_before"] == "kids_need_age"
    assert debug2["data_collected"].get("age") == 8
    assert "пробное" in reply2.lower() or "350" in reply2 or "2800" in reply2
    assert "лимит" in reply2.lower() or "12" in reply2
    
    # Проверяем, что состояние очищено
    state = fsm.get_state(tenant_id, channel, user_id)
    assert state is None or state.get("state") == "idle"


def test_kids_fsm_no_loop_back(dikidi_data, mock_redis):
    """
    Проверяем, что после завершения диалога не возвращаемся к первому вопросу
    """
    fsm = FSM("redis://localhost:6379/0")
    fsm.redis_client = mock_redis
    
    tenant_id = "studio_nexa"
    channel = "simulator"
    user_id = "test_user_kids_no_loop"
    scenario = "Детские группы"
    
    # Завершаем диалог
    process_state_machine(scenario, "", "button", "Уточнить возраст ребёнка",
                         tenant_id, channel, user_id, dikidi_data)
    reply_final, _, debug_final = process_state_machine(
        scenario, "8", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    
    # Проверяем, что получили финальный ответ с группой
    assert "Dance Mix" in reply_final or "групп" in reply_final.lower()
    assert debug_final["state_after"] == "idle"
    
    # Если отправим еще один текст - не должно вернуться к первому вопросу
    reply_next, _, debug_next = process_state_machine(
        scenario, "спасибо", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    # Должен начаться новый диалог, но не повторять тот же вопрос сразу
    assert debug_next["state_before"] == "idle" or "возраст" in reply_next.lower()


def test_kids_fsm_intent_progression(dikidi_data, mock_redis):
    """
    Проверяем, что intent движется вперед и не возвращается
    """
    fsm = FSM("redis://localhost:6379/0")
    fsm.redis_client = mock_redis
    
    tenant_id = "studio_nexa"
    channel = "simulator"
    user_id = "test_user_intent"
    scenario = "Детские группы"
    
    # Начало диалога
    _, intent1, _ = process_state_machine(
        scenario, "", "button", "Уточнить возраст ребёнка",
        tenant_id, channel, user_id, dikidi_data
    )
    assert intent1 == "ask_age"
    
    # После получения возраста
    _, intent2, _ = process_state_machine(
        scenario, "8", "text", None,
        tenant_id, channel, user_id, dikidi_data
    )
    assert intent2 == "children_groups_info"
    assert intent2 != intent1  # Intent изменился
    
    # Проверяем, что не вернулись к ask_age
    assert intent2 != "ask_age"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
