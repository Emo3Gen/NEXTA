import json
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.fsm import (
    FSM, extract_age, extract_direction, extract_rent_time_bucket,
    extract_people_count, extract_rent_format, check_rent_limits
)

app = FastAPI(title="Танцуй со мной - Orchestrator", version="v0.1.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PRODUCT_VERSION = os.getenv("PRODUCT_VERSION", "v0.1.1")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
DIKIDI_STUB_PATH = Path("/app/data/dikidi_stub.json")

# Инициализация FSM (будет переопределена в process_state_machine для тестов)
_fsm_instance = None

def get_fsm():
    """Получает экземпляр FSM (singleton)"""
    global _fsm_instance
    if _fsm_instance is None:
        _fsm_instance = FSM(REDIS_URL)
    return _fsm_instance

def set_fsm(fsm_instance):
    """Устанавливает экземпляр FSM (для тестов)"""
    global _fsm_instance
    _fsm_instance = fsm_instance


class ChatRequest(BaseModel):
    tenant_id: Optional[str] = "studio_nexa"
    channel: Optional[str] = "simulator"
    user_id: Optional[str] = "test_user"
    text: str
    scenario: str
    action_type: str
    action_name: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    intent: str
    version: str
    debug: dict


def load_dikidi_stub():
    """Загружает данные из DIKIDI stub"""
    try:
        with open(DIKIDI_STUB_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"directions": [], "schedule": [], "rental": {}}


def calculate_rental_price(
    time_bucket: str,
    people_count: int,
    format_type: str,
    rental_data: dict,
    hours: Optional[int] = None
) -> tuple[int, str, str]:
    """
    Рассчитывает стоимость аренды по правилам из требований.
    Возвращает (цена, правило, сообщение)
    """
    rules = rental_data.get("rules", {})
    
    # Проверяем оптовые цены (>=8 часов)
    is_bulk = hours is not None and hours >= 8
    
    if is_bulk:
        # Оптовые цены: 700 для <=10 чел, 1100 для >10 чел
        if people_count <= 10:
            price = 700
            rule = "bulk_up_to_10"
        else:
            price = 1100
            rule = "bulk_more_than_10"
        message = f"Стоимость аренды: {price} руб/час (оптовая цена при аренде от 8 часов)."
    else:
        # Обычные цены по требованиям:
        # до 16:00 до 10 чел = 900
        # после 16:00 до 10 чел = 1300
        # до 16:00 >10 чел = 1100
        # после 16:00 >10 чел = 1500
        if time_bucket == "daytime":
            if people_count <= 10:
                price = 900
                rule = "daytime_up_to_10"
            else:
                price = 1100
                rule = "daytime_more_than_10"
        else:  # evening
            if people_count <= 10:
                price = 1300
                rule = "evening_up_to_10"
            else:
                price = 1500
                rule = "evening_more_than_10"
        message = f"Стоимость аренды: {price} руб/час."
    
    # Добавляем информацию о предоплате и бронировании
    prepayment = rules.get("prepayment_percent", 50)
    min_booking = rules.get("min_booking_hours", 12)
    message += f"\n\nПредоплата: {prepayment}%\nБронь минимум за {min_booking} часов."
    
    return price, rule, message


def process_state_machine(
    scenario: str,
    text: str,
    action_type: str,
    action_name: Optional[str],
    tenant_id: str,
    channel: str,
    user_id: str,
    dikidi_data: dict
) -> tuple[str, str, dict]:
    """
    Обрабатывает запрос через FSM.
    Возвращает (reply, intent, debug_info)
    """
    fsm = get_fsm()
    state_data = fsm.get_state(tenant_id, channel, user_id)
    state_before = state_data.get("state") if state_data else "idle"
    scenario_current = state_data.get("scenario") if state_data else scenario
    data = state_data.get("data", {}) if state_data else {}
    
    debug_info = {
        "state_before": state_before,
        "scenario": scenario_current,
        "action_type": action_type,
        "action_name": action_name,
        "data_collected": data.copy()
    }
    
    # Обработка кнопок (инициируют сценарии)
    if action_type == "button":
        if action_name == "Уточнить возраст ребёнка":
            fsm.set_state(tenant_id, channel, user_id, "Детские группы", "kids_need_age", {})
            return (
                "Для записи в детскую группу нам нужно знать возраст ребенка. Сколько лет вашему ребенку?",
                "ask_age",
                {**debug_info, "state_after": "kids_need_age", "rule_used": "kids: начать с возраста"}
            )
        elif action_name == "Рассчитать стоимость аренды":
            fsm.set_state(tenant_id, channel, user_id, "Аренда зала", "rent_need_time", {})
            return (
                "Для расчета стоимости аренды зала мне нужно знать время. Аренда планируется до 16:00 или после?",
                "calculate_rental",
                {**debug_info, "state_after": "rent_need_time", "rule_used": "rent: начать с времени"}
            )
        elif action_name == "Записаться на пробное занятие":
            fsm.set_state(tenant_id, channel, user_id, "Запись на занятие", "booking_need_direction", {})
            directions = [d["name"] for d in dikidi_data.get("directions", [])]
            directions_text = "\n".join([f"• {d}" for d in directions])
            return (
                f"Отлично! Мы предлагаем пробное занятие для новых учеников. Какое направление вас интересует?\n\n{directions_text}",
                "book_trial",
                {**debug_info, "state_after": "booking_need_direction", "rule_used": "booking: начать с направления"}
            )
        elif action_name == "Передать администратору":
            fsm.clear_state(tenant_id, channel, user_id)
            return (
                "Ваш запрос передан администратору. В ближайшее время с вами свяжутся для уточнения деталей.",
                "escalation",
                {**debug_info, "state_after": "idle", "rule_used": "escalation"}
            )
        elif action_name == "Посмотреть расписание":
            schedule_items = []
            for item in dikidi_data.get("schedule", [])[:6]:
                dir_name = next((d["name"] for d in dikidi_data.get("directions", []) if d["id"] == item["direction_id"]), item["direction_id"])
                schedule_items.append(f"• {item['day']}, {item['time']} — {dir_name}")
            schedule_text = "\n".join(schedule_items) if schedule_items else "Расписание временно недоступно"
            return (
                f"Расписание занятий:\n\n{schedule_text}\n\nХотите записаться на пробное занятие?",
                "view_schedule",
                {**debug_info, "state_after": "idle", "rule_used": "schedule: показ расписания"}
            )
    
    # Обработка текстовых ответов (продолжение диалога)
    if action_type == "text":
        # Детские группы: обработка возраста
        if state_before == "kids_need_age":
            age = extract_age(text)
            if age:
                data["age"] = age
                # Находим подходящие группы из stub
                suitable_groups = [
                    d for d in dikidi_data.get("directions", [])
                    if d.get("age_min") is not None and d.get("age_max") is not None 
                    and d["age_min"] <= age <= d["age_max"]
                ]
                
                # Fallback маппинг по возрасту, если не найдено в stub
                if not suitable_groups:
                    if 7 <= age <= 11:
                        # Создаем fallback группу для Dance Mix 7-11
                        suitable_groups = [{
                            "id": "dance_mix_7_11",
                            "name": "Dance Mix 7-11",
                            "age_min": 7,
                            "age_max": 11,
                            "price_per_month": 2800,
                            "trial_price": 350,
                            "group_limit": 12
                        }]
                    elif 3 <= age <= 5:
                        suitable_groups = [{
                            "id": "azbuka_3_5",
                            "name": "Азбука танца 3-5",
                            "age_min": 3,
                            "age_max": 5,
                            "price_per_month": 2500,
                            "trial_price": 300,
                            "group_limit": 10
                        }]
                    elif 12 <= age <= 17:
                        suitable_groups = [{
                            "id": "choreo_12_17",
                            "name": "Choreo 12-17",
                            "age_min": 12,
                            "age_max": 17,
                            "price_per_month": 3000,
                            "trial_price": 400,
                            "group_limit": 14
                        }]
                
                if suitable_groups:
                    group = suitable_groups[0]
                    fsm.clear_state(tenant_id, channel, user_id)
                    # Формируем короткий продуктовый ответ
                    reply = f"Для возраста {age} лет подходит группа «{group['name']}».\n\n"
                    reply += f"Лимит: {group.get('group_limit', 12)} человек.\n"
                    reply += "Форма на занятии: удобная спортивная одежда. Можно записаться разово или по абонементу.\n\n"
                    reply += "Записать на пробное или подобрать расписание?"
                    return (
                        reply,
                        "children_groups_info",
                        {**debug_info, "state_after": "idle", "rule_used": "kids: возраст -> группа", "data_collected": data}
                    )
                else:
                    fsm.clear_state(tenant_id, channel, user_id)
                    return (
                        f"Для возраста {age} лет у нас пока нет подходящей группы. Обратитесь к администратору для уточнения.",
                        "children_groups_info",
                        {**debug_info, "state_after": "idle", "rule_used": "kids: нет подходящей группы"}
                    )
            else:
                return (
                    "Пожалуйста, укажите возраст ребенка числом (например, 8 лет).",
                    "ask_age",
                    {**debug_info, "state_after": "kids_need_age", "rule_used": "kids: неверный формат возраста"}
                )
        
        # Аренда: обработка времени
        elif state_before == "rent_need_time":
            time_bucket = extract_rent_time_bucket(text)
            if time_bucket:
                data["rent_time_bucket"] = time_bucket
                fsm.set_state(tenant_id, channel, user_id, "Аренда зала", "rent_need_people", data)
                return (
                    "Сколько человек планируется?",
                    "calculate_rental",
                    {**debug_info, "state_after": "rent_need_people", "rule_used": "rent: время -> количество людей", "data_collected": data}
                )
            else:
                return (
                    "Пожалуйста, укажите время: до 16:00 или после 16:00?",
                    "calculate_rental",
                    {**debug_info, "state_after": "rent_need_time", "rule_used": "rent: неверный формат времени"}
                )
        
        # Аренда: обработка количества людей
        elif state_before == "rent_need_people":
            people_count = extract_people_count(text)
            if people_count:
                data["people_count"] = people_count
                fsm.set_state(tenant_id, channel, user_id, "Аренда зала", "rent_need_format", data)
                return (
                    "Какой формат мероприятия? (тренировка, репетиция, фотосессия)",
                    "calculate_rental",
                    {**debug_info, "state_after": "rent_need_format", "rule_used": "rent: количество -> формат", "data_collected": data}
                )
            else:
                return (
                    "Пожалуйста, укажите количество человек числом (например, 12).",
                    "calculate_rental",
                    {**debug_info, "state_after": "rent_need_people", "rule_used": "rent: неверный формат количества"}
                )
        
        # Аренда: обработка формата и расчет
        elif state_before == "rent_need_format":
            format_type = extract_rent_format(text)
            if format_type:
                data["format"] = format_type
                people_count = data.get("people_count", 0)
                
                # Проверка лимитов
                is_valid, error_msg = check_rent_limits(format_type, people_count)
                if not is_valid:
                    fsm.clear_state(tenant_id, channel, user_id)
                    return (
                        f"{error_msg}\n\nПожалуйста, измените формат или количество участников, либо обратитесь к администратору.",
                        "calculate_rental",
                        {**debug_info, "state_after": "idle", "rule_used": "rent: превышение лимита", "data_collected": data}
                    )
                
                # Расчет цены
                time_bucket = data.get("rent_time_bucket", "evening")
                rental_data = dikidi_data.get("rental", {})
                price, rule, message = calculate_rental_price(
                    time_bucket, people_count, format_type, rental_data
                )
                
                fsm.clear_state(tenant_id, channel, user_id)
                return (
                    message,
                    "calculate_rental",
                    {**debug_info, "state_after": "idle", "rule_used": rule, "data_collected": data}
                )
            else:
                return (
                    "Пожалуйста, укажите формат: тренировка, репетиция или фотосессия.",
                    "calculate_rental",
                    {**debug_info, "state_after": "rent_need_format", "rule_used": "rent: неверный формат"}
                )
        
        # Запись: обработка направления
        elif state_before == "booking_need_direction":
            direction_id = extract_direction(text, dikidi_data.get("directions", []))
            if direction_id:
                data["direction"] = direction_id
                direction = next((d for d in dikidi_data.get("directions", []) if d["id"] == direction_id), None)
                if direction:
                    # Показываем слоты для этого направления
                    slots = [s for s in dikidi_data.get("schedule", []) if s["direction_id"] == direction_id]
                    if slots:
                        slots_text = "\n".join([f"• {s['day']}, {s['time']} — {direction['name']}" for s in slots[:3]])
                        fsm.clear_state(tenant_id, channel, user_id)
                        return (
                            f"Отлично! Вы выбрали «{direction['name']}».\n\n"
                            f"Доступные слоты:\n{slots_text}\n\n"
                            f"Стоимость пробного занятия: {direction.get('trial_price', 0)} руб.",
                            "book_trial",
                            {**debug_info, "state_after": "idle", "rule_used": "booking: направление -> слоты", "data_collected": data}
                        )
                    else:
                        fsm.clear_state(tenant_id, channel, user_id)
                        return (
                            f"Выбрано направление «{direction['name']}», но слоты временно недоступны. Обратитесь к администратору.",
                            "book_trial",
                            {**debug_info, "state_after": "idle", "rule_used": "booking: нет слотов"}
                        )
                else:
                    return (
                        "Не удалось найти это направление. Пожалуйста, выберите из списка.",
                        "book_trial",
                        {**debug_info, "state_after": "booking_need_direction", "rule_used": "booking: неверное направление"}
                    )
            else:
                return (
                    "Пожалуйста, выберите направление из предложенного списка.",
                    "book_trial",
                    {**debug_info, "state_after": "booking_need_direction", "rule_used": "booking: неверный формат"}
                )
    
    # Если состояние idle или неизвестное - начинаем заново
    if state_before == "idle" or not state_data:
        if scenario == "Детские группы":
            fsm.set_state(tenant_id, channel, user_id, scenario, "kids_need_age", {})
            return (
                "Для записи в детскую группу нам нужно знать возраст ребенка. Сколько лет вашему ребенку?",
                "ask_age",
                {**debug_info, "state_after": "kids_need_age", "rule_used": "kids: начало диалога"}
            )
        elif scenario == "Аренда зала":
            fsm.set_state(tenant_id, channel, user_id, scenario, "rent_need_time", {})
            return (
                "Для расчета стоимости аренды зала мне нужно знать время. Аренда планируется до 16:00 или после?",
                "calculate_rental",
                {**debug_info, "state_after": "rent_need_time", "rule_used": "rent: начало диалога"}
            )
        elif scenario == "Запись на занятие":
            fsm.set_state(tenant_id, channel, user_id, scenario, "booking_need_direction", {})
            directions = [d["name"] for d in dikidi_data.get("directions", [])]
            directions_text = "\n".join([f"• {d}" for d in directions])
            return (
                f"Отлично! Мы предлагаем пробное занятие для новых учеников. Какое направление вас интересует?\n\n{directions_text}",
                "book_trial",
                {**debug_info, "state_after": "booking_need_direction", "rule_used": "booking: начало диалога"}
            )
        else:
            return (
                "Спасибо за ваш вопрос! Как мы можем вам помочь?",
                "general_inquiry",
                {**debug_info, "state_after": "idle", "rule_used": "general"}
            )
    
    # Неизвестное состояние
    fsm.clear_state(tenant_id, channel, user_id)
    return (
        "Произошла ошибка. Начнем заново. Как мы можем вам помочь?",
        "error",
        {**debug_info, "state_after": "idle", "rule_used": "error: неизвестное состояние"}
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": PRODUCT_VERSION,
        "service": "orchestrator"
    }


@app.get("/dikidi")
async def get_dikidi():
    """Возвращает весь DIKIDI stub"""
    return load_dikidi_stub()


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Обрабатывает запросы чата через FSM"""
    dikidi_data = load_dikidi_stub()
    
    reply, intent, debug_info = process_state_machine(
        request.scenario,
        request.text,
        request.action_type,
        request.action_name,
        request.tenant_id,
        request.channel,
        request.user_id,
        dikidi_data
    )
    
    # Добавляем state_after в debug
    if "state_after" not in debug_info:
        state_data = fsm.get_state(request.tenant_id, request.channel, request.user_id)
        debug_info["state_after"] = state_data.get("state") if state_data else "idle"
    
    return ChatResponse(
        reply=reply,
        intent=intent,
        version=PRODUCT_VERSION,
        debug=debug_info
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
