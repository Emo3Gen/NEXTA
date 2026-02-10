import json
import os
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware


app = FastAPI(title="Танцуй со мной - DIKIDI Stub", version="v0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


PRODUCT_VERSION = os.getenv("PRODUCT_VERSION", "v0.2.0")
DATA_PATH = Path(os.getenv("DIKIDI_DATA_PATH", "/app/data/dikidi_stub.json"))


def load_dikidi_data() -> Dict[str, Any]:
    """Загружает данные DIKIDI из JSON."""
    try:
        with open(DATA_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"directions": [], "schedule": [], "rental": {}}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": PRODUCT_VERSION,
        "service": "dikidi-stub",
    }


@app.get("/data")
async def get_data():
    """Возвращает весь DIKIDI stub JSON."""
    return load_dikidi_data()


@app.get("/availability")
async def get_availability(
    date: str = Query(..., description="Дата в формате YYYY-MM-DD"),
    time_bucket: str = Query(..., description="daytime|evening"),
):
    """
    Возвращает доступные слоты.
    Сейчас логика упрощена и использует данные из расписания как фейковые слоты.
    """
    data = load_dikidi_data()
    schedule: List[Dict[str, Any]] = data.get("schedule", [])

    # Простая фильтрация по time_bucket
    def is_daytime(time_str: str) -> bool:
        try:
            hour = int(time_str.split(":")[0])
            return hour < 16
        except Exception:
            return False

    slots = []
    for item in schedule:
        is_day = is_daytime(item.get("time", "00:00"))
        if time_bucket == "daytime" and not is_day:
            continue
        if time_bucket == "evening" and is_day:
            continue
        slots.append(
            {
                "direction_id": item.get("direction_id"),
                "day": item.get("day"),
                "time": item.get("time"),
                "duration_minutes": item.get("duration_minutes"),
                "instructor": item.get("instructor"),
                "available": True,
            }
        )

    return {
        "date": date,
        "time_bucket": time_bucket,
        "slots": slots,
        "version": PRODUCT_VERSION,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8010)

