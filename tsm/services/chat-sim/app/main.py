import os
from typing import Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

app = FastAPI(title="Танцуй со мной - Chat Simulator", version="v0.1.1")

templates = Jinja2Templates(directory="app/templates")

ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://localhost:8001")
PRODUCT_VERSION = os.getenv("PRODUCT_VERSION", "v0.1.1")


class ChatMessage(BaseModel):
    text: str
    scenario: str
    action_type: str
    action_name: Optional[str] = None


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Главная страница с UI"""
    return templates.TemplateResponse("index.html", {
        "request": request,
        "version": PRODUCT_VERSION
    })


@app.post("/api/send")
async def send_message(message: ChatMessage):
    """Отправляет сообщение в orchestrator"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{ORCHESTRATOR_URL}/chat",
                json={
                    "tenant_id": "studio_nexa",
                    "channel": "simulator",
                    "user_id": "test_user",
                    "text": message.text,
                    "scenario": message.scenario,
                    "action_type": message.action_type,
                    "action_name": message.action_name
                },
                timeout=10.0
            )
            response.raise_for_status()
            return response.json()
    except httpx.RequestError as e:
        return {
            "error": f"Ошибка соединения с orchestrator: {str(e)}",
            "reply": "Не удалось связаться с сервером. Проверьте, запущен ли orchestrator.",
            "intent": "error",
            "version": PRODUCT_VERSION,
            "debug": {}
        }
    except Exception as e:
        return {
            "error": str(e),
            "reply": "Произошла ошибка при обработке запроса.",
            "intent": "error",
            "version": PRODUCT_VERSION,
            "debug": {}
        }
