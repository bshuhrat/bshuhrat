// База данных Cloudflare D1 (SQLite). Таблицы создаются автоматически.
import { nowIso } from "./utils.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS topics (
    chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, name TEXT NOT NULL,
    welcome TEXT, photo_mode INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, thread_id))`,
  `CREATE TABLE IF NOT EXISTS faq (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL,
    keyword TEXT NOT NULL, answer TEXT NOT NULL, UNIQUE (chat_id, thread_id, keyword))`,
  `CREATE TABLE IF NOT EXISTS members (
    chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT, full_name TEXT NOT NULL,
    last_seen TEXT NOT NULL, PRIMARY KEY (chat_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', deadline TEXT, message_id INTEGER,
    created_at TEXT NOT NULL,
    reminded INTEGER NOT NULL DEFAULT 0, -- 0 нет, 1 напомнили, 2 дедлайн обработан
    closed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    username TEXT, full_name TEXT NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    score INTEGER, comment TEXT, submitted_at TEXT NOT NULL, reviewed_at TEXT, reviewer_id INTEGER,
    late INTEGER NOT NULL DEFAULT 0, UNIQUE (task_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS review_messages (
    submission_id INTEGER NOT NULL, admin_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
    PRIMARY KEY (submission_id, admin_id))`,
  `CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL, full_name TEXT NOT NULL, text TEXT NOT NULL, message_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', answer TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS photo_fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL,
    orig_message_id INTEGER NOT NULL, orig_file_id TEXT NOT NULL, orig_caption TEXT,
    orig_user_id INTEGER NOT NULL, orig_name TEXT NOT NULL, button_message_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open', -- open | claimed | done
    fixer_id INTEGER, fixer_name TEXT, claimed_at TEXT, fix_message_id INTEGER, done_at TEXT,
    created_at TEXT, reminded INTEGER NOT NULL DEFAULT 0, prompt_message_id INTEGER)`,
  // Состояние диалога с админом (ждём комментарий / ответ)
  `CREATE TABLE IF NOT EXISTS states (
    user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, data TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
];

// Новые столбцы для баз, созданных старой версией бота (ошибка = столбец уже есть)
const MIGRATIONS = [
  "ALTER TABLE photo_fixes ADD COLUMN created_at TEXT",
  "ALTER TABLE photo_fixes ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE photo_fixes ADD COLUMN prompt_message_id INTEGER",
];

let schemaReady = false;

export class Database {
  constructor(d1) {
    this.d1 = d1;
  }

  async init() {
    if (schemaReady) return;
    await this.d1.batch(SCHEMA.map((sql) => this.d1.prepare(sql)));
    for (const sql of MIGRATIONS) {
      try {
        await this.d1.prepare(sql).run();
      } catch {
        // столбец уже существует
      }
    }
    await this.run("UPDATE photo_fixes SET created_at = ? WHERE created_at IS NULL", nowIso());
    schemaReady = true;
  }

  async run(sql, ...params) {
    const res = await this.d1.prepare(sql).bind(...params).run();
    return { changes: res.meta.changes, lastId: res.meta.last_row_id };
  }

  one(sql, ...params) {
    return this.d1.prepare(sql).bind(...params).first();
  }

  async all(sql, ...params) {
    return (await this.d1.prepare(sql).bind(...params).all()).results;
  }

  // ---------- темы ----------
  setTopic(chatId, threadId, name) {
    return this.run(
      `INSERT INTO topics (chat_id, thread_id, name) VALUES (?, ?, ?)
       ON CONFLICT (chat_id, thread_id) DO UPDATE SET name = excluded.name`,
      chatId, threadId, name,
    );
  }

  setWelcome(chatId, threadId, text) {
    return this.run(
      `INSERT INTO topics (chat_id, thread_id, name, welcome) VALUES (?, ?, ?, ?)
       ON CONFLICT (chat_id, thread_id) DO UPDATE SET welcome = excluded.welcome`,
      chatId, threadId, `Тема ${threadId}`, text || null,
    );
  }

  setPhotoMode(chatId, threadId, enabled) {
    return this.run(
      `INSERT INTO topics (chat_id, thread_id, name, photo_mode) VALUES (?, ?, ?, ?)
       ON CONFLICT (chat_id, thread_id) DO UPDATE SET photo_mode = excluded.photo_mode`,
      chatId, threadId, `Тема ${threadId}`, enabled ? 1 : 0,
    );
  }

  getTopic(chatId, threadId) {
    return this.one("SELECT * FROM topics WHERE chat_id = ? AND thread_id = ?", chatId, threadId);
  }

  async topicName(chatId, threadId) {
    const row = await this.getTopic(chatId, threadId);
    if (row) return row.name;
    return threadId === 0 ? "Общая" : `Тема #${threadId}`;
  }

  // ---------- автоответы ----------
  addFaq(chatId, threadId, keyword, answer) {
    return this.run(
      `INSERT INTO faq (chat_id, thread_id, keyword, answer) VALUES (?, ?, ?, ?)
       ON CONFLICT (chat_id, thread_id, keyword) DO UPDATE SET answer = excluded.answer`,
      chatId, threadId, keyword.toLowerCase(), answer,
    );
  }

  async delFaq(chatId, threadId, keyword) {
    const r = await this.run(
      "DELETE FROM faq WHERE chat_id = ? AND thread_id = ? AND keyword = ?",
      chatId, threadId, keyword.toLowerCase(),
    );
    return r.changes > 0;
  }

  listFaq(chatId, threadId) {
    return this.all(
      "SELECT * FROM faq WHERE chat_id = ? AND thread_id = ? ORDER BY keyword", chatId, threadId,
    );
  }

  // ---------- участники ----------
  touchMember(chatId, userId, username, name) {
    return this.run(
      `INSERT INTO members (chat_id, user_id, username, full_name, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET username = excluded.username,
       full_name = excluded.full_name, last_seen = excluded.last_seen`,
      chatId, userId, username || null, name, nowIso(),
    );
  }

  removeMember(chatId, userId) {
    return this.run("DELETE FROM members WHERE chat_id = ? AND user_id = ?", chatId, userId);
  }

  listMembers(chatId) {
    return this.all("SELECT * FROM members WHERE chat_id = ? ORDER BY full_name", chatId);
  }

  // ---------- задания ----------
  async createTask(chatId, threadId, title, description, deadline) {
    const r = await this.run(
      `INSERT INTO tasks (chat_id, thread_id, title, description, deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      chatId, threadId, title, description, deadline, nowIso(),
    );
    return r.lastId;
  }

  setTaskMessage(taskId, messageId) {
    return this.run("UPDATE tasks SET message_id = ? WHERE id = ?", messageId, taskId);
  }

  getTask(id) {
    return this.one("SELECT * FROM tasks WHERE id = ?", id);
  }

  taskByMessage(chatId, messageId) {
    return this.one("SELECT * FROM tasks WHERE chat_id = ? AND message_id = ?", chatId, messageId);
  }

  openTasks(chatId, threadId) {
    return this.all(
      "SELECT * FROM tasks WHERE chat_id = ? AND thread_id = ? AND closed = 0 ORDER BY id",
      chatId, threadId,
    );
  }

  allTasks(chatId = null) {
    if (chatId === null) return this.all("SELECT * FROM tasks ORDER BY id");
    return this.all("SELECT * FROM tasks WHERE chat_id = ? ORDER BY id", chatId);
  }

  tasksWithDeadline() {
    return this.all(
      "SELECT * FROM tasks WHERE closed = 0 AND deadline IS NOT NULL AND reminded < 2",
    );
  }

  setReminded(taskId, value) {
    return this.run("UPDATE tasks SET reminded = ? WHERE id = ?", value, taskId);
  }

  closeTask(taskId) {
    return this.run("UPDATE tasks SET closed = 1 WHERE id = ?", taskId);
  }

  // ---------- сдачи ----------
  // Возвращает { id, resubmit }
  async upsertSubmission(taskId, user, name, chatId, messageId, late) {
    const existing = await this.findSubmission(taskId, user.id);
    if (!existing) {
      const r = await this.run(
        `INSERT INTO submissions (task_id, user_id, username, full_name, chat_id, message_id,
         submitted_at, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId, user.id, user.username || null, name, chatId, messageId, nowIso(), late ? 1 : 0,
      );
      return { id: r.lastId, resubmit: false };
    }
    await this.run(
      `UPDATE submissions SET message_id = ?, status = 'pending', score = NULL, comment = NULL,
       submitted_at = ?, reviewed_at = NULL, reviewer_id = NULL, late = ?, username = ?,
       full_name = ? WHERE id = ?`,
      messageId, nowIso(), late ? 1 : 0, user.username || null, name, existing.id,
    );
    await this.run("DELETE FROM review_messages WHERE submission_id = ?", existing.id);
    return { id: existing.id, resubmit: true };
  }

  getSubmission(id) {
    return this.one("SELECT * FROM submissions WHERE id = ?", id);
  }

  findSubmission(taskId, userId) {
    return this.one("SELECT * FROM submissions WHERE task_id = ? AND user_id = ?", taskId, userId);
  }

  // Атомарно: проверяет только работы в статусе pending
  async reviewSubmission(id, status, score, reviewerId) {
    const r = await this.run(
      `UPDATE submissions SET status = ?, score = ?, reviewer_id = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending'`,
      status, score, reviewerId, nowIso(), id,
    );
    return r.changes > 0;
  }

  setSubmissionComment(id, comment) {
    return this.run("UPDATE submissions SET comment = ? WHERE id = ?", comment, id);
  }

  submissionsForTask(taskId) {
    return this.all("SELECT * FROM submissions WHERE task_id = ? ORDER BY submitted_at", taskId);
  }

  pendingSubmissions() {
    return this.all(
      `SELECT s.*, t.title FROM submissions s JOIN tasks t ON t.id = s.task_id
       WHERE s.status = 'pending' ORDER BY s.submitted_at`,
    );
  }

  allSubmissions(chatId = null) {
    const sql = `SELECT s.*, t.title, t.thread_id FROM submissions s JOIN tasks t ON t.id = s.task_id`;
    if (chatId === null) return this.all(sql + " ORDER BY s.id");
    return this.all(sql + " WHERE t.chat_id = ? ORDER BY s.id", chatId);
  }

  addReviewMessage(subId, adminId, messageId) {
    return this.run(
      "INSERT OR REPLACE INTO review_messages (submission_id, admin_id, message_id) VALUES (?, ?, ?)",
      subId, adminId, messageId,
    );
  }

  reviewMessages(subId) {
    return this.all("SELECT * FROM review_messages WHERE submission_id = ?", subId);
  }

  // ---------- запросы участников ----------
  async createRequest(chatId, threadId, userId, name, text, messageId) {
    const r = await this.run(
      `INSERT INTO requests (chat_id, thread_id, user_id, full_name, text, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      chatId, threadId, userId, name, text, messageId, nowIso(),
    );
    return r.lastId;
  }

  getRequest(id) {
    return this.one("SELECT * FROM requests WHERE id = ?", id);
  }

  answerRequest(id, answer) {
    return this.run("UPDATE requests SET status = 'answered', answer = ? WHERE id = ?", answer, id);
  }

  openRequests() {
    return this.all("SELECT * FROM requests WHERE status = 'open' ORDER BY id");
  }

  // ---------- фото-исправления ----------
  async isPhotoTopic(chatId, threadId) {
    const row = await this.getTopic(chatId, threadId);
    return Boolean(row && row.photo_mode);
  }

  async createPhotoFix(chatId, threadId, messageId, fileId, caption, userId, name) {
    const r = await this.run(
      `INSERT INTO photo_fixes (chat_id, thread_id, orig_message_id, orig_file_id, orig_caption,
       orig_user_id, orig_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      chatId, threadId, messageId, fileId, caption || null, userId, name, nowIso(),
    );
    return r.lastId;
  }

  setFixButton(fixId, messageId) {
    return this.run("UPDATE photo_fixes SET button_message_id = ? WHERE id = ?", messageId, fixId);
  }

  setFixPrompt(fixId, messageId) {
    return this.run("UPDATE photo_fixes SET prompt_message_id = ? WHERE id = ?", messageId, fixId);
  }

  getPhotoFix(id) {
    return this.one("SELECT * FROM photo_fixes WHERE id = ?", id);
  }

  // Атомарно закрепляет исправление за участником. false — кто-то успел раньше
  async claimPhotoFix(fixId, userId, name) {
    const r = await this.run(
      `UPDATE photo_fixes SET status = 'claimed', fixer_id = ?, fixer_name = ?, claimed_at = ?
       WHERE id = ? AND status = 'open'`,
      userId, name, nowIso(), fixId,
    );
    return r.changes > 0;
  }

  // Ожидающее исправление участника (по сообщению с кнопкой или последнее в теме)
  async claimedFixFor(chatId, threadId, userId, buttonMessageId = null) {
    if (buttonMessageId) {
      const row = await this.one(
        `SELECT * FROM photo_fixes WHERE chat_id = ?
         AND (button_message_id = ? OR prompt_message_id = ?)
         AND status = 'claimed' AND fixer_id = ?`,
        chatId, buttonMessageId, buttonMessageId, userId,
      );
      if (row) return row;
    }
    return this.one(
      `SELECT * FROM photo_fixes WHERE chat_id = ? AND thread_id = ? AND fixer_id = ?
       AND status = 'claimed' ORDER BY claimed_at DESC LIMIT 1`,
      chatId, threadId, userId,
    );
  }

  completePhotoFix(fixId, messageId) {
    return this.run(
      "UPDATE photo_fixes SET status = 'done', fix_message_id = ?, done_at = ? WHERE id = ?",
      messageId, nowIso(), fixId,
    );
  }

  expiredPhotoFixes(beforeIso) {
    return this.all(
      "SELECT * FROM photo_fixes WHERE status = 'claimed' AND claimed_at < ?", beforeIso,
    );
  }

  releasePhotoFix(fixId) {
    return this.run(
      `UPDATE photo_fixes SET status = 'open', fixer_id = NULL, fixer_name = NULL, claimed_at = NULL,
       prompt_message_id = NULL WHERE id = ? AND status = 'claimed'`,
      fixId,
    );
  }

  // Фото без исправления дольше заданного времени, о которых ещё не напоминали
  unfixedPhotos(beforeIso, limit) {
    return this.all(
      `SELECT * FROM photo_fixes WHERE status = 'open' AND reminded = 0 AND created_at < ?
       ORDER BY id LIMIT ?`,
      beforeIso, limit,
    );
  }

  markFixReminded(fixId) {
    return this.run("UPDATE photo_fixes SET reminded = 1 WHERE id = ?", fixId);
  }

  donePhotoFixes() {
    return this.all("SELECT * FROM photo_fixes WHERE status = 'done'");
  }

  // ---------- состояние диалога ----------
  async getState(userId) {
    const row = await this.one("SELECT * FROM states WHERE user_id = ?", userId);
    return row ? { state: row.state, data: JSON.parse(row.data || "{}") } : null;
  }

  setState(userId, state, data = {}) {
    return this.run(
      "INSERT OR REPLACE INTO states (user_id, state, data) VALUES (?, ?, ?)",
      userId, state, JSON.stringify(data),
    );
  }

  clearState(userId) {
    return this.run("DELETE FROM states WHERE user_id = ?", userId);
  }

  // ---------- настройки ----------
  async getSetting(key) {
    const row = await this.one("SELECT value FROM settings WHERE key = ?", key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    return this.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key, value,
    );
  }
}
