"""Фоновые задачи: напоминания о дедлайнах и ежедневный отчёт админам."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from html import escape

from aiogram import Bot

from .config import Config
from .db import Database
from .photofix import release_expired
from .services import notify_admins, send_to_chat
from .stats import full_report, participants, task_summary
from .utils import fmt_dt, mention

log = logging.getLogger(__name__)
CHECK_INTERVAL = 60  # секунд


async def missing_mentions(db: Database, cfg: Config, task) -> list[str]:
    submitted = {s["user_id"] for s in await db.submissions_for_task(task["id"])}
    members = await participants(db, cfg, task["chat_id"])
    return [mention(uid, name) for uid, name in members.items() if uid not in submitted]


async def check_deadlines(bot: Bot, db: Database, cfg: Config) -> None:
    now = datetime.now(timezone.utc)
    for task in await db.tasks_with_deadline():
        deadline = datetime.fromisoformat(task["deadline"])

        if now >= deadline:
            missing = await missing_mentions(db, cfg, task)
            text = f"⏰ Дедлайн задания #{task['id']} «{escape(task['title'])}» наступил."
            if missing:
                text += "\nНе сдали: " + ", ".join(missing) + "\nПоздние сдачи принимаются с пометкой."
            else:
                text += "\n🎉 Все участники сдали работу!"
            await send_to_chat(bot, task["chat_id"], task["thread_id"], text, reply_to=task["message_id"])
            await notify_admins(bot, cfg, "⏰ Дедлайн наступил\n\n" + await task_summary(db, cfg, task))
            await db.set_reminded(task["id"], 2)

        elif task["reminded"] == 0 and now >= deadline - timedelta(hours=cfg.remind_before_hours):
            missing = await missing_mentions(db, cfg, task)
            if missing:
                await send_to_chat(
                    bot, task["chat_id"], task["thread_id"],
                    f"🔔 Напоминание: задание #{task['id']} «{escape(task['title'])}» нужно сдать "
                    f"до {fmt_dt(task['deadline'], cfg.timezone)}.\n"
                    "Ещё не сдали: " + ", ".join(missing),
                    reply_to=task["message_id"],
                )
            await db.set_reminded(task["id"], 1)


async def check_daily_report(bot: Bot, db: Database, cfg: Config) -> None:
    local_now = datetime.now(cfg.timezone)
    today = local_now.date().isoformat()
    if local_now.time() < cfg.daily_report_time:
        return
    if await db.get_setting("last_daily_report") == today:
        return
    await db.set_setting("last_daily_report", today)
    if not await db.all_tasks() and not await db.done_photo_fixes():
        return
    report = await full_report(db, cfg)
    pending = len(await db.pending_submissions())
    if pending:
        report += f"\n\n⏳ Ждут вашей проверки: {pending} (/pending)"
    await notify_admins(bot, cfg, "🗓 <b>Ежедневный отчёт</b>\n\n" + report[:3900])


async def run_scheduler(bot: Bot, db: Database, cfg: Config) -> None:
    while True:
        try:
            await check_deadlines(bot, db, cfg)
            await check_daily_report(bot, db, cfg)
            await release_expired(bot, db, cfg)
        except Exception:  # планировщик не должен падать
            log.exception("Ошибка в планировщике")
        await asyncio.sleep(CHECK_INTERVAL)
