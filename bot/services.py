"""Общая логика: публикация заданий, приём сдач, уведомления админов."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from html import escape

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError
from aiogram.types import Message, ReplyParameters

from .config import Config
from .db import Database
from .keyboards import request_keyboard, review_keyboard, task_keyboard
from .stats import task_summary
from .utils import fmt_dt, full_name, mention, thread_of

log = logging.getLogger(__name__)


async def notify_admins(bot: Bot, cfg: Config, text: str, **kwargs) -> list[tuple[int, int]]:
    """Отправляет сообщение всем админам. Возвращает [(admin_id, message_id)]."""
    sent = []
    for admin_id in cfg.admin_ids:
        try:
            msg = await bot.send_message(admin_id, text, **kwargs)
            sent.append((admin_id, msg.message_id))
        except TelegramAPIError as e:
            log.warning("Не удалось написать админу %s: %s (он нажал /start?)", admin_id, e)
    return sent


async def send_to_chat(
    bot: Bot, chat_id: int, thread_id: int, text: str, reply_to: int | None = None, **kwargs
) -> Message | None:
    try:
        return await bot.send_message(
            chat_id,
            text,
            message_thread_id=thread_id or None,
            reply_parameters=(
                ReplyParameters(message_id=reply_to, allow_sending_without_reply=True)
                if reply_to
                else None
            ),
            **kwargs,
        )
    except TelegramAPIError as e:
        log.warning("Не удалось отправить сообщение в чат %s: %s", chat_id, e)
        return None


def task_text(task, cfg: Config) -> str:
    parts = [f"📝 <b>Задание #{task['id']}: {escape(task['title'])}</b>"]
    if task["description"]:
        parts += ["", escape(task["description"])]
    if task["deadline"]:
        parts += ["", f"⏰ Дедлайн: <b>{fmt_dt(task['deadline'], cfg.timezone)}</b>"]
    parts += [
        "",
        "Чтобы сдать — <b>ответьте (reply) на это сообщение</b> текстом, фото или файлом.",
    ]
    return "\n".join(parts)


async def publish_task(bot: Bot, db: Database, cfg: Config, task_id: int) -> Message | None:
    task = await db.get_task(task_id)
    msg = await send_to_chat(
        bot, task["chat_id"], task["thread_id"], task_text(task, cfg),
        reply_markup=task_keyboard(task_id),
    )
    if msg:
        await db.set_task_message(task_id, msg.message_id)
        try:
            await bot.pin_chat_message(task["chat_id"], msg.message_id, disable_notification=True)
        except TelegramAPIError:
            pass  # у бота нет права закреплять — не страшно
    return msg


async def accept_submission(message: Message, task, db: Database, cfg: Config, bot: Bot) -> None:
    user = message.from_user
    if task["closed"]:
        await message.reply("🔒 Это задание уже закрыто, сдачи не принимаются.")
        return

    prev = await db.find_submission(task["id"], user.id)
    if prev and prev["status"] == "approved":
        await message.reply(
            f"✅ Ваше задание #{task['id']} уже принято с оценкой {prev['score']}⭐."
        )
        return

    late = bool(task["deadline"]) and datetime.now(timezone.utc) > datetime.fromisoformat(
        task["deadline"]
    )
    sub_id, resubmit = await db.upsert_submission(
        task["id"], user.id, user.username, full_name(user), message.chat.id,
        message.message_id, late,
    )

    reply = "📥 Работа принята на проверку!" if not resubmit else "🔁 Работа обновлена и отправлена на повторную проверку."
    if late:
        reply += "\n⚠️ Сдано после дедлайна."
    await message.reply(reply)

    topic = await db.topic_name(message.chat.id, thread_of(message))
    header = (
        f"📨 <b>Новая сдача #{sub_id}</b>{' (повторная)' if resubmit else ''}\n"
        f"Задание #{task['id']}: {escape(task['title'])}\n"
        f"Тема: {escape(topic)}\n"
        f"От: {mention(user.id, full_name(user))}"
        + (f" (@{escape(user.username)})" if user.username else "")
        + ("\n⚠️ <b>С опозданием</b>" if late else "")
        + "\n\nОцените работу:"
    )
    for admin_id in cfg.admin_ids:
        try:
            await bot.copy_message(admin_id, message.chat.id, message.message_id)
            sent = await bot.send_message(admin_id, header, reply_markup=review_keyboard(sub_id))
            await db.add_review_message(sub_id, admin_id, sent.message_id)
        except TelegramAPIError as e:
            log.warning("Не удалось отправить сдачу админу %s: %s", admin_id, e)


async def register_request(message: Message, text: str, db: Database, cfg: Config, bot: Bot) -> None:
    user = message.from_user
    thread_id = thread_of(message)
    req_id = await db.create_request(
        message.chat.id, thread_id, user.id, full_name(user), text, message.message_id
    )
    await message.reply(f"📨 Запрос #{req_id} передан администратору. Ответ придёт сюда.")
    topic = await db.topic_name(message.chat.id, thread_id)
    await notify_admins(
        bot, cfg,
        f"❓ <b>Запрос #{req_id}</b> от {mention(user.id, full_name(user))}\n"
        f"Тема: {escape(topic)}\n\n{escape(text)}",
        reply_markup=request_keyboard(req_id),
    )


async def close_task(bot: Bot, db: Database, cfg: Config, task_id: int) -> str | None:
    task = await db.get_task(task_id)
    if not task:
        return None
    await db.close_task(task_id)
    summary = await task_summary(db, cfg, task)
    await send_to_chat(
        bot, task["chat_id"], task["thread_id"],
        f"🔒 Задание #{task_id} «{escape(task['title'])}» закрыто.",
        reply_to=task["message_id"],
    )
    if task["message_id"]:
        try:
            await bot.unpin_chat_message(task["chat_id"], message_id=task["message_id"])
        except TelegramAPIError:
            pass
    return summary
