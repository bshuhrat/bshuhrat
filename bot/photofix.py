"""Тема фото-исправлений: под каждым фото — кнопка «Отправить фото исправление»."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from html import escape

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError
from aiogram.types import CallbackQuery, InputMediaPhoto, Message, ReplyParameters

from .config import Config
from .db import Database
from .keyboards import photo_fix_keyboard
from .services import send_to_chat
from .utils import full_name, mention, thread_of

CAPTION_LIMIT = 1024


def _open_text(fix) -> str:
    return f"📷 Фото от {mention(fix['orig_user_id'], fix['orig_name'])}"


async def handle_photo(message: Message, db: Database, cfg: Config, bot: Bot) -> bool:
    """Обрабатывает фото в теме исправлений. True — сообщение обработано."""
    thread_id = thread_of(message)
    if not message.photo or not await db.is_photo_topic(message.chat.id, thread_id):
        return False
    user = message.from_user

    # Фото от участника, который взялся за исправление, — это и есть исправление
    reply_id = message.reply_to_message.message_id if message.reply_to_message else None
    fix = await db.claimed_fix_for(message.chat.id, thread_id, user.id, reply_id)
    if fix:
        await finish_fix(message, fix, db, bot)
        return True

    fix_id = await db.create_photo_fix(
        message.chat.id, thread_id, message.message_id, message.photo[-1].file_id,
        message.caption, user.id, full_name(user),
    )
    sent = await send_to_chat(
        bot, message.chat.id, thread_id, _open_text(await db.get_photo_fix(fix_id)),
        reply_to=message.message_id, reply_markup=photo_fix_keyboard(fix_id),
    )
    if sent:
        await db.set_fix_button(fix_id, sent.message_id)
    return True


async def on_fix_button(call: CallbackQuery, db: Database, cfg: Config, bot: Bot) -> None:
    fix_id = int(call.data.split(":")[1])
    fix = await db.get_photo_fix(fix_id)
    if not fix:
        await call.answer("Фото не найдено.", show_alert=True)
        return
    name = full_name(call.from_user)
    if not await db.claim_photo_fix(fix_id, call.from_user.id, name):
        fix = await db.get_photo_fix(fix_id)
        who = fix["fixer_name"] or "другой участник"
        await call.answer(f"Исправление уже отправляет {who}.", show_alert=True)
        return

    # Убираем кнопку, чтобы никто другой не взялся за это фото
    try:
        await call.message.edit_text(
            f"{_open_text(fix)}\n\n🛠 Исправление отправляет {mention(call.from_user.id, name)}.\n"
            "Пришлите исправленное фото в эту тему (можно ответом на это сообщение).",
            reply_markup=None,
        )
    except TelegramAPIError:
        pass
    await call.answer(
        f"Пришлите исправленное фото в эту тему в течение {cfg.photo_fix_timeout_min} мин.",
        show_alert=True,
    )


async def finish_fix(message: Message, fix, db: Database, bot: Bot) -> None:
    await db.complete_photo_fix(fix["id"], message.message_id)
    fixer = full_name(message.from_user)

    orig_caption = f"📷 Оригинал — {escape(fix['orig_name'])}"
    if fix["orig_caption"]:
        orig_caption += f"\n{escape(fix['orig_caption'])}"
    fix_caption = f"✅ Исправление — {escape(fixer)}"
    if message.caption:
        fix_caption += f"\n{escape(message.caption)}"

    # Оригинал и исправление — одним альбомом, рядом друг с другом
    try:
        await bot.send_media_group(
            message.chat.id,
            media=[
                InputMediaPhoto(media=fix["orig_file_id"], caption=orig_caption[:CAPTION_LIMIT]),
                InputMediaPhoto(media=message.photo[-1].file_id, caption=fix_caption[:CAPTION_LIMIT]),
            ],
            message_thread_id=fix["thread_id"] or None,
            reply_parameters=ReplyParameters(
                message_id=fix["orig_message_id"], allow_sending_without_reply=True
            ),
        )
    except TelegramAPIError:
        pass

    if fix["button_message_id"]:
        try:
            await bot.edit_message_text(
                f"{_open_text(fix)}\n\n✅ Исправлено: {mention(message.from_user.id, fixer)}",
                chat_id=message.chat.id, message_id=fix["button_message_id"],
            )
        except TelegramAPIError:
            pass
    await message.reply(f"🙏 Спасибо за исправление, {mention(message.from_user.id, fixer)}!")


async def release_expired(bot: Bot, db: Database, cfg: Config) -> None:
    """Если взявшийся не прислал фото вовремя — возвращаем кнопку всем."""
    before = datetime.now(timezone.utc) - timedelta(minutes=cfg.photo_fix_timeout_min)
    for fix in await db.expired_photo_fixes(before.isoformat(timespec="seconds")):
        await db.release_photo_fix(fix["id"])
        if not fix["button_message_id"]:
            continue
        try:
            await bot.edit_message_text(
                f"{_open_text(fix)}\n\n⌛ {escape(fix['fixer_name'])} не прислал(а) исправление — "
                "кнопка снова доступна.",
                chat_id=fix["chat_id"], message_id=fix["button_message_id"],
                reply_markup=photo_fix_keyboard(fix["id"]),
            )
        except TelegramAPIError:
            pass
