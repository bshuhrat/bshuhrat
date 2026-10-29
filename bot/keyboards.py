from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup


def task_keyboard(task_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="📤 Как сдать", callback_data=f"how:{task_id}"),
                InlineKeyboardButton(text="📊 Кто сдал", callback_data=f"who:{task_id}"),
            ]
        ]
    )


def review_keyboard(sub_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text=f"{i} ⭐", callback_data=f"rv:{sub_id}:{i}")
                for i in range(1, 6)
            ],
            [
                InlineKeyboardButton(text="❌ Отклонить", callback_data=f"rv:{sub_id}:0"),
                InlineKeyboardButton(text="💬 Комментарий", callback_data=f"cm:{sub_id}"),
            ],
        ]
    )


def comment_keyboard(sub_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="💬 Добавить комментарий", callback_data=f"cm:{sub_id}")]
        ]
    )


def request_keyboard(req_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="✍️ Ответить", callback_data=f"ans:{req_id}")]
        ]
    )


def photo_fix_keyboard(fix_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📷 Отправить фото исправление", callback_data=f"fix:{fix_id}")]
        ]
    )
