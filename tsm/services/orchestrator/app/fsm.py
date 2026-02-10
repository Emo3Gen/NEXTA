"""
FSM (Finite State Machine) для управления диалогами
"""
import json
import re
from typing import Optional, Dict, Any
import redis


class FSM:
    """Машина состояний для диалогов"""
    
    def __init__(self, redis_url: str):
        self.redis_client = redis.from_url(redis_url, decode_responses=True)
        self.ttl_seconds = 24 * 60 * 60  # 24 часа
    
    def get_state_key(self, tenant_id: str, channel: str, user_id: str) -> str:
        """Генерирует ключ для хранения состояния"""
        return f"state:{tenant_id}:{channel}:{user_id}"
    
    def get_state(self, tenant_id: str, channel: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Получает текущее состояние пользователя"""
        key = self.get_state_key(tenant_id, channel, user_id)
        data = self.redis_client.get(key)
        if data:
            return json.loads(data)
        return None
    
    def set_state(self, tenant_id: str, channel: str, user_id: str, 
                  scenario: str, state: str, data: Dict[str, Any] = None):
        """Устанавливает состояние пользователя"""
        key = self.get_state_key(tenant_id, channel, user_id)
        state_data = {
            "scenario": scenario,
            "state": state,
            "data": data or {}
        }
        self.redis_client.setex(
            key,
            self.ttl_seconds,
            json.dumps(state_data, ensure_ascii=False)
        )
    
    def clear_state(self, tenant_id: str, channel: str, user_id: str):
        """Очищает состояние пользователя"""
        key = self.get_state_key(tenant_id, channel, user_id)
        self.redis_client.delete(key)


def extract_age(text: str) -> Optional[int]:
    """Извлекает возраст из текста"""
    # Ищем числа от 1 до 100
    numbers = re.findall(r'\b([1-9]|[1-9][0-9]|100)\b', text)
    if numbers:
        age = int(numbers[0])
        if 1 <= age <= 100:
            return age
    return None


def extract_direction(text: str, directions: list) -> Optional[str]:
    """Определяет направление по ключевым словам"""
    text_lower = text.lower()
    
    direction_keywords = {
        "latina_solo_18": ["латина", "латино", "solo"],
        "high_heels_18": ["хай хилс", "high heels", "каблуки", "хилс"],
        "choreo_12_17": ["choreo", "хорео", "хореография"],
        "dance_mix_7_11": ["dance mix", "микс", "танцы"],
        "azbuka_3_5": ["азбука", "малыши", "детки"],
        "hatha_yoga": ["йога", "yoga", "хатха"]
    }
    
    for direction in directions:
        dir_id = direction["id"]
        if dir_id in direction_keywords:
            for keyword in direction_keywords[dir_id]:
                if keyword in text_lower:
                    return dir_id
    
    # Попробуем найти по названию
    for direction in directions:
        if direction["name"].lower() in text_lower:
            return direction["id"]
    
    return None


def extract_rent_time_bucket(text: str) -> Optional[str]:
    """Определяет временной интервал для аренды"""
    text_lower = text.lower()
    
    if "до 16" in text_lower or "до 16:00" in text_lower or "до" in text_lower:
        return "daytime"
    if "после 16" in text_lower or "после 16:00" in text_lower or "после" in text_lower:
        return "evening"
    
    # Попробуем извлечь время
    time_match = re.search(r'(\d{1,2}):?(\d{2})?', text)
    if time_match:
        hour = int(time_match.group(1))
        if hour < 16:
            return "daytime"
        else:
            return "evening"
    
    return None


def extract_people_count(text: str) -> Optional[int]:
    """Извлекает количество людей из текста"""
    numbers = re.findall(r'\b([1-9]|[1-9][0-9]|100)\b', text)
    if numbers:
        count = int(numbers[0])
        if 1 <= count <= 100:
            return count
    return None


def extract_rent_format(text: str) -> Optional[str]:
    """Определяет формат аренды"""
    text_lower = text.lower()
    
    format_keywords = {
        "training": ["тренировка", "занятие", "training", "урок"],
        "rehearsal": ["репетиция", "rehearsal", "репет"],
        "photo_session": ["фотосессия", "фото", "photo", "съемка"]
    }
    
    for format_id, keywords in format_keywords.items():
        for keyword in keywords:
            if keyword in text_lower:
                return format_id
    
    return None


def check_rent_limits(format: str, people_count: int) -> tuple[bool, Optional[str]]:
    """Проверяет лимиты формата аренды"""
    limits = {
        "training": 15,  # занятие
        "rehearsal": 30,  # коврики/пол
        "photo_session": 10,  # лаундж
        "party": 45  # вечеринка
    }
    
    # Маппинг форматов
    if format == "training":
        limit = limits["training"]
    elif format == "rehearsal":
        limit = limits["rehearsal"]
    elif format == "photo_session":
        limit = limits["photo_session"]
    else:
        limit = limits.get(format, 30)
    
    if people_count > limit:
        return False, f"Для формата '{format}' максимальное количество участников: {limit}. У вас указано {people_count}."
    
    return True, None
