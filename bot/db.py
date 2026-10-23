from __future__ import annotations

import os
from datetime import datetime, timezone

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS topics (
    chat_id    INTEGER NOT NULL,
    thread_id  INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    welcome    TEXT,
    PRIMARY KEY (chat_id, thread_id)
);

CREATE TABLE IF NOT EXISTS faq (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    thread_id  INTEGER NOT NULL,
    keyword    TEXT    NOT NULL,
    answer     TEXT    NOT NULL,
    UNIQUE (chat_id, thread_id, keyword)
);

CREATE TABLE IF NOT EXISTS members (
    chat_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    username   TEXT,
    full_name  TEXT    NOT NULL,
    last_seen  TEXT    NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      INTEGER NOT NULL,
    thread_id    INTEGER NOT NULL,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    deadline     TEXT,               -- ISO, UTC
    message_id   INTEGER,
    created_at   TEXT    NOT NULL,
    reminded     INTEGER NOT NULL DEFAULT 0,  -- 0 нет, 1 напомнили, 2 дедлайн обработан
    closed       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER NOT NULL REFERENCES tasks(id),
    user_id       INTEGER NOT NULL,
    username      TEXT,
    full_name     TEXT    NOT NULL,
    chat_id       INTEGER NOT NULL,
    message_id    INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    score         INTEGER,
    comment       TEXT,
    submitted_at  TEXT    NOT NULL,
    reviewed_at   TEXT,
    reviewer_id   INTEGER,
    late          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS review_messages (
    submission_id INTEGER NOT NULL,
    admin_id      INTEGER NOT NULL,
    message_id    INTEGER NOT NULL,
    PRIMARY KEY (submission_id, admin_id)
);

CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    thread_id   INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    full_name   TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    message_id  INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open',  -- open | answered
    answer      TEXT,
    created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.executescript(SCHEMA)
        await self.conn.commit()

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()

    async def _exec(self, sql: str, params: tuple = ()) -> aiosqlite.Cursor:
        cur = await self.conn.execute(sql, params)
        await self.conn.commit()
        return cur

    async def _one(self, sql: str, params: tuple = ()) -> aiosqlite.Row | None:
        async with self.conn.execute(sql, params) as cur:
            return await cur.fetchone()

    async def _all(self, sql: str, params: tuple = ()) -> list[aiosqlite.Row]:
        async with self.conn.execute(sql, params) as cur:
            return list(await cur.fetchall())

    # ---------- темы ----------
    async def set_topic(self, chat_id: int, thread_id: int, name: str) -> None:
        await self._exec(
            "INSERT INTO topics (chat_id, thread_id, name) VALUES (?, ?, ?) "
            "ON CONFLICT (chat_id, thread_id) DO UPDATE SET name = excluded.name",
            (chat_id, thread_id, name),
        )

    async def set_welcome(self, chat_id: int, thread_id: int, text: str | None) -> None:
        await self._exec(
            "INSERT INTO topics (chat_id, thread_id, name, welcome) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (chat_id, thread_id) DO UPDATE SET welcome = excluded.welcome",
            (chat_id, thread_id, f"Тема {thread_id}", text),
        )

    async def get_topic(self, chat_id: int, thread_id: int) -> aiosqlite.Row | None:
        return await self._one(
            "SELECT * FROM topics WHERE chat_id = ? AND thread_id = ?", (chat_id, thread_id)
        )

    async def topic_name(self, chat_id: int, thread_id: int) -> str:
        row = await self.get_topic(chat_id, thread_id)
        if row:
            return row["name"]
        return "Общая" if thread_id == 0 else f"Тема #{thread_id}"

    # ---------- FAQ / автоответы ----------
    async def add_faq(self, chat_id: int, thread_id: int, keyword: str, answer: str) -> None:
        await self._exec(
            "INSERT INTO faq (chat_id, thread_id, keyword, answer) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (chat_id, thread_id, keyword) DO UPDATE SET answer = excluded.answer",
            (chat_id, thread_id, keyword.lower(), answer),
        )

    async def del_faq(self, chat_id: int, thread_id: int, keyword: str) -> bool:
        cur = await self._exec(
            "DELETE FROM faq WHERE chat_id = ? AND thread_id = ? AND keyword = ?",
            (chat_id, thread_id, keyword.lower()),
        )
        return cur.rowcount > 0

    async def list_faq(self, chat_id: int, thread_id: int) -> list[aiosqlite.Row]:
        return await self._all(
            "SELECT * FROM faq WHERE chat_id = ? AND thread_id = ? ORDER BY keyword",
            (chat_id, thread_id),
        )

    # ---------- участники ----------
    async def touch_member(
        self, chat_id: int, user_id: int, username: str | None, full_name: str
    ) -> None:
        await self._exec(
            "INSERT INTO members (chat_id, user_id, username, full_name, last_seen) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT (chat_id, user_id) DO UPDATE SET "
            "username = excluded.username, full_name = excluded.full_name, "
            "last_seen = excluded.last_seen",
            (chat_id, user_id, username, full_name, now_iso()),
        )

    async def remove_member(self, chat_id: int, user_id: int) -> None:
        await self._exec(
            "DELETE FROM members WHERE chat_id = ? AND user_id = ?", (chat_id, user_id)
        )

    async def list_members(self, chat_id: int) -> list[aiosqlite.Row]:
        return await self._all(
            "SELECT * FROM members WHERE chat_id = ? ORDER BY full_name", (chat_id,)
        )

    async def known_chats(self) -> list[int]:
        rows = await self._all(
            "SELECT DISTINCT chat_id FROM tasks UNION SELECT DISTINCT chat_id FROM members"
        )
        return [r[0] for r in rows]

    # ---------- задания ----------
    async def create_task(
        self, chat_id: int, thread_id: int, title: str, description: str, deadline: str | None
    ) -> int:
        cur = await self._exec(
            "INSERT INTO tasks (chat_id, thread_id, title, description, deadline, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (chat_id, thread_id, title, description, deadline, now_iso()),
        )
        return cur.lastrowid

    async def set_task_message(self, task_id: int, message_id: int) -> None:
        await self._exec("UPDATE tasks SET message_id = ? WHERE id = ?", (message_id, task_id))

    async def get_task(self, task_id: int) -> aiosqlite.Row | None:
        return await self._one("SELECT * FROM tasks WHERE id = ?", (task_id,))

    async def task_by_message(self, chat_id: int, message_id: int) -> aiosqlite.Row | None:
        return await self._one(
            "SELECT * FROM tasks WHERE chat_id = ? AND message_id = ?", (chat_id, message_id)
        )

    async def open_tasks(self, chat_id: int, thread_id: int | None = None) -> list[aiosqlite.Row]:
        if thread_id is None:
            return await self._all(
                "SELECT * FROM tasks WHERE chat_id = ? AND closed = 0 ORDER BY id", (chat_id,)
            )
        return await self._all(
            "SELECT * FROM tasks WHERE chat_id = ? AND thread_id = ? AND closed = 0 ORDER BY id",
            (chat_id, thread_id),
        )

    async def all_tasks(self, chat_id: int | None = None) -> list[aiosqlite.Row]:
        if chat_id is None:
            return await self._all("SELECT * FROM tasks ORDER BY id")
        return await self._all("SELECT * FROM tasks WHERE chat_id = ? ORDER BY id", (chat_id,))

    async def tasks_with_deadline(self) -> list[aiosqlite.Row]:
        return await self._all(
            "SELECT * FROM tasks WHERE closed = 0 AND deadline IS NOT NULL AND reminded < 2"
        )

    async def set_reminded(self, task_id: int, value: int) -> None:
        await self._exec("UPDATE tasks SET reminded = ? WHERE id = ?", (value, task_id))

    async def close_task(self, task_id: int) -> None:
        await self._exec("UPDATE tasks SET closed = 1 WHERE id = ?", (task_id,))

    # ---------- сдачи ----------
    async def upsert_submission(
        self,
        task_id: int,
        user_id: int,
        username: str | None,
        full_name: str,
        chat_id: int,
        message_id: int,
        late: bool,
    ) -> tuple[int, bool]:
        """Возвращает (id сдачи, была_ли_пересдача). Принятую сдачу не перезаписывает."""
        existing = await self._one(
            "SELECT * FROM submissions WHERE task_id = ? AND user_id = ?", (task_id, user_id)
        )
        if existing is None:
            cur = await self._exec(
                "INSERT INTO submissions (task_id, user_id, username, full_name, chat_id, "
                "message_id, submitted_at, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (task_id, user_id, username, full_name, chat_id, message_id, now_iso(), int(late)),
            )
            return cur.lastrowid, False
        await self._exec(
            "UPDATE submissions SET message_id = ?, status = 'pending', score = NULL, "
            "comment = NULL, submitted_at = ?, reviewed_at = NULL, reviewer_id = NULL, "
            "late = ?, username = ?, full_name = ? WHERE id = ?",
            (message_id, now_iso(), int(late), username, full_name, existing["id"]),
        )
        await self._exec("DELETE FROM review_messages WHERE submission_id = ?", (existing["id"],))
        return existing["id"], True

    async def get_submission(self, sub_id: int) -> aiosqlite.Row | None:
        return await self._one("SELECT * FROM submissions WHERE id = ?", (sub_id,))

    async def find_submission(self, task_id: int, user_id: int) -> aiosqlite.Row | None:
        return await self._one(
            "SELECT * FROM submissions WHERE task_id = ? AND user_id = ?", (task_id, user_id)
        )

    async def review_submission(
        self, sub_id: int, status: str, score: int | None, reviewer_id: int
    ) -> None:
        await self._exec(
            "UPDATE submissions SET status = ?, score = ?, reviewer_id = ?, reviewed_at = ? "
            "WHERE id = ?",
            (status, score, reviewer_id, now_iso(), sub_id),
        )

    async def set_submission_comment(self, sub_id: int, comment: str) -> None:
        await self._exec("UPDATE submissions SET comment = ? WHERE id = ?", (comment, sub_id))

    async def submissions_for_task(self, task_id: int) -> list[aiosqlite.Row]:
        return await self._all(
            "SELECT * FROM submissions WHERE task_id = ? ORDER BY submitted_at", (task_id,)
        )

    async def pending_submissions(self) -> list[aiosqlite.Row]:
        return await self._all(
            "SELECT s.*, t.title FROM submissions s JOIN tasks t ON t.id = s.task_id "
            "WHERE s.status = 'pending' ORDER BY s.submitted_at"
        )

    async def all_submissions(self, chat_id: int | None = None) -> list[aiosqlite.Row]:
        sql = (
            "SELECT s.*, t.title, t.thread_id FROM submissions s "
            "JOIN tasks t ON t.id = s.task_id"
        )
        if chat_id is None:
            return await self._all(sql + " ORDER BY s.id")
        return await self._all(sql + " WHERE t.chat_id = ? ORDER BY s.id", (chat_id,))

    async def add_review_message(self, sub_id: int, admin_id: int, message_id: int) -> None:
        await self._exec(
            "INSERT OR REPLACE INTO review_messages (submission_id, admin_id, message_id) "
            "VALUES (?, ?, ?)",
            (sub_id, admin_id, message_id),
        )

    async def review_messages(self, sub_id: int) -> list[aiosqlite.Row]:
        return await self._all(
            "SELECT * FROM review_messages WHERE submission_id = ?", (sub_id,)
        )

    # ---------- запросы участников ----------
    async def create_request(
        self, chat_id: int, thread_id: int, user_id: int, full_name: str, text: str, message_id: int
    ) -> int:
        cur = await self._exec(
            "INSERT INTO requests (chat_id, thread_id, user_id, full_name, text, message_id, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (chat_id, thread_id, user_id, full_name, text, message_id, now_iso()),
        )
        return cur.lastrowid

    async def get_request(self, req_id: int) -> aiosqlite.Row | None:
        return await self._one("SELECT * FROM requests WHERE id = ?", (req_id,))

    async def answer_request(self, req_id: int, answer: str) -> None:
        await self._exec(
            "UPDATE requests SET status = 'answered', answer = ? WHERE id = ?", (answer, req_id)
        )

    async def open_requests(self) -> list[aiosqlite.Row]:
        return await self._all("SELECT * FROM requests WHERE status = 'open' ORDER BY id")

    # ---------- настройки ----------
    async def get_setting(self, key: str) -> str | None:
        row = await self._one("SELECT value FROM settings WHERE key = ?", (key,))
        return row[0] if row else None

    async def set_setting(self, key: str, value: str) -> None:
        await self._exec(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
