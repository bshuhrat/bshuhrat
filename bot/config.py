import os
from dataclasses import dataclass
from datetime import time
from zoneinfo import ZoneInfo

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    bot_token: str
    admin_ids: frozenset[int]
    group_id: int | None
    daily_report_time: time
    timezone: ZoneInfo
    remind_before_hours: int
    db_path: str


def load_config() -> Config:
    load_dotenv()

    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError("BOT_TOKEN не задан (см. .env.example)")

    admin_ids = frozenset(
        int(x) for x in os.getenv("ADMIN_IDS", "").replace(" ", "").split(",") if x
    )
    if not admin_ids:
        raise RuntimeError("ADMIN_IDS не задан — укажите хотя бы одного администратора")

    group_id = os.getenv("GROUP_ID", "").strip()
    hh, mm = os.getenv("DAILY_REPORT_TIME", "20:00").split(":")

    return Config(
        bot_token=token,
        admin_ids=admin_ids,
        group_id=int(group_id) if group_id else None,
        daily_report_time=time(int(hh), int(mm)),
        timezone=ZoneInfo(os.getenv("TIMEZONE", "UTC")),
        remind_before_hours=int(os.getenv("REMIND_BEFORE_HOURS", "24")),
        db_path=os.getenv("DB_PATH", "data/bot.db"),
    )
