from __future__ import annotations

import re
from datetime import datetime, timezone
from html import escape
from zoneinfo import ZoneInfo

from aiogram.types import Message, User

DEADLINE_FORMATS = ("%d.%m.%Y %H:%M", "%d.%m.%Y", "%d.%m %H:%M", "%d.%m", "%Y-%m-%d %H:%M")


def thread_of(message: Message) -> int:
    """ID темы (0 — общая тема / группа без тем)."""
    if message.is_topic_message and message.message_thread_id:
        return message.message_thread_id
    return 0


def full_name(user: User) -> str:
    return user.full_name or user.username or str(user.id)


def mention(user_id: int, name: str) -> str:
    return f'<a href="tg://user?id={user_id}">{escape(name)}</a>'


def parse_deadline(text: str, tz: ZoneInfo) -> datetime | None:
    """Разбирает дедлайн в часовом поясе tz и возвращает время в UTC."""
    text = text.strip()
    for fmt in DEADLINE_FORMATS:
        try:
            dt = datetime.strptime(text, fmt)
        except ValueError:
            continue
        if "%Y" not in fmt:
            dt = dt.replace(year=datetime.now(tz).year)
        if "%H" not in fmt:
            dt = dt.replace(hour=23, minute=59)
        return dt.replace(tzinfo=tz).astimezone(timezone.utc)
    return None


def fmt_dt(iso: str | None, tz: ZoneInfo) -> str:
    if not iso:
        return "—"
    return datetime.fromisoformat(iso).astimezone(tz).strftime("%d.%m.%Y %H:%M")


def split_args(text: str | None, parts: int) -> list[str]:
    """Делит аргументы команды по символу «|»."""
    items = [p.strip() for p in (text or "").split("|", parts - 1)]
    return items + [""] * (parts - len(items))


def contains_keyword(text: str, keyword: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(keyword)}(?!\w)", text, re.IGNORECASE) is not None


def stars(score: int | None) -> str:
    return "⭐" * score if score else ""
