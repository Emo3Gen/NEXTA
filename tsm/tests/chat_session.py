"""
Test helper for simulating chat sessions with the orchestrator.

Usage:
    session = ChatSession(scenario="Запись на занятие")
    reply, data = await session.send("Записаться на пробное занятие", action_type="button", action_name="Записаться на пробное занятие")
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Dict, Any, Tuple
from pathlib import Path

import httpx
from httpx import ASGITransport

import sys

# Make orchestrator app importable
ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "services" / "orchestrator"))

from app.main import app  # type: ignore


@dataclass
class ChatSession:
    """
    Simulates a chat session against the orchestrator FastAPI app.

    - Persists tenant/channel/user across turns
    - Uses the same /chat endpoint as the real app
    - Exposes last response debug payload for assertions
    """

    scenario: str
    tenant_id: str = "studio_nexa"
    channel: str = "simulator"
    user_id: str = "test_user_behavior"

    def __post_init__(self) -> None:
        self._transport = ASGITransport(app=app)
        self._client = httpx.AsyncClient(transport=self._transport, base_url="http://testserver")
        self.last_response: Optional[Dict[str, Any]] = None

    async def send(
        self,
        text: str,
        *,
        action_type: str = "text",
        action_name: Optional[str] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Send a message to the orchestrator and return (reply_text, full_json_payload).
        """
        payload = {
            "tenant_id": self.tenant_id,
            "channel": self.channel,
            "user_id": self.user_id,
            "text": text,
            "scenario": self.scenario,
            "action_type": action_type,
            "action_name": action_name,
        }
        resp = await self._client.post("/chat", json=payload)
        resp.raise_for_status()
        data = resp.json()
        self.last_response = data
        return data.get("reply", ""), data

    async def close(self) -> None:
        await self._client.aclose()

