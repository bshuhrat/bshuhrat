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
    created_at TEXT, reminded INTEGER NOT NULL DEFAULT 0, prompt_message_id INTEGER,
    result_message_ids TEXT, control_message_id INTEGER, admin_messages TEXT)`,
  // Поломки: заявки во внешней системе, бот только напоминает и уточняет статус
  `CREATE TABLE IF NOT EXISTS repairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, text TEXT NOT NULL,
    keyword TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', -- open | fixed | rejected
    created_at TEXT NOT NULL, next_check_at TEXT NOT NULL, checks INTEGER NOT NULL DEFAULT 0,
    bot_message_id INTEGER, check_message_id INTEGER, closed_by_id INTEGER, closed_by_name TEXT,
    closed_at TEXT, close_message_id INTEGER, photo_file_id TEXT, check_message_ids TEXT,
    UNIQUE (chat_id, message_id))`,
  `CREATE TABLE IF NOT EXISTS repair_keywords (
    chat_id INTEGER NOT NULL, keyword TEXT NOT NULL, enabled INTEGER NOT NULL,
    PRIMARY KEY (chat_id, keyword))`,
  // Обмены между пиццериями: долг, перемещение, отдали — напоминания по сроку
  `CREATE TABLE IF NOT EXISTS exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, text TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', -- open | done | cancelled
    created_at TEXT NOT NULL, due_at TEXT NOT NULL, bot_message_id INTEGER, remind_message_ids TEXT,
    closed_by_id INTEGER, closed_by_name TEXT, closed_at TEXT, UNIQUE (chat_id, message_id))`,
  // Очередь разбора отчётов ИИ
  `CREATE TABLE IF NOT EXISTS report_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL,
    source_message_id INTEGER NOT NULL, file_id TEXT NOT NULL, caption TEXT,
    requested_by TEXT, requested_by_id INTEGER, placeholder_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
    attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, location TEXT)`,
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
  "ALTER TABLE photo_fixes ADD COLUMN result_message_ids TEXT",
  "ALTER TABLE photo_fixes ADD COLUMN control_message_id INTEGER",
  "ALTER TABLE photo_fixes ADD COLUMN admin_messages TEXT",
  "ALTER TABLE repairs ADD COLUMN check_message_ids TEXT",
  "ALTER TABLE report_jobs ADD COLUMN location TEXT",
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

  // Итоговый альбом и сообщения админам в личку с кнопкой «Вернуть в работу»
  // adminMessages: [[chat_id, message_id], ...]
  setFixResult(fixId, messageIds, adminMessages) {
    return this.run(
      "UPDATE photo_fixes SET result_message_ids = ?, admin_messages = ? WHERE id = ?",
      JSON.stringify(messageIds), JSON.stringify(adminMessages), fixId,
    );
  }

  // Исправленное фото, к альбому которого относится сообщение
  findFixByResultMessage(chatId, messageId) {
    return this.one(
      `SELECT * FROM photo_fixes WHERE chat_id = ? AND status = 'done' AND result_message_ids IS NOT NULL
       AND EXISTS (SELECT 1 FROM json_each(result_message_ids) WHERE value = ?)`,
      chatId, messageId,
    );
  }

  // Админ вернул исправленное фото в работу. false — уже возвращено
  async reopenPhotoFix(fixId) {
    const r = await this.run(
      `UPDATE photo_fixes SET status = 'open', fixer_id = NULL, fixer_name = NULL, claimed_at = NULL,
       fix_message_id = NULL, done_at = NULL, prompt_message_id = NULL, reminded = 0, created_at = ?,
       result_message_ids = NULL, control_message_id = NULL, admin_messages = NULL
       WHERE id = ? AND status = 'done'`,
      nowIso(), fixId,
    );
    return r.changes > 0;
  }

  // Фото заново опубликовано ботом — кнопка теперь прямо на нём
  setFixPhotoMessage(fixId, messageId) {
    return this.run(
      "UPDATE photo_fixes SET orig_message_id = ?, button_message_id = ? WHERE id = ?",
      messageId, messageId, fixId,
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

  // Админ удалил сообщение бота — фото снимается с контроля
  cancelPhotoFix(fixId) {
    return this.run(
      "UPDATE photo_fixes SET status = 'cancelled' WHERE id = ? AND status IN ('open', 'claimed')", fixId,
    );
  }

  donePhotoFixes() {
    return this.all("SELECT * FROM photo_fixes WHERE status = 'done'");
  }

  // ---------- поломки ----------
  // Новая заявка; null — это сообщение уже зарегистрировано
  async createRepair({ chatId, threadId, messageId, userId, userName, text, keyword, nextCheckAt }) {
    const r = await this.run(
      `INSERT OR IGNORE INTO repairs (chat_id, thread_id, message_id, user_id, user_name, text, keyword,
       created_at, next_check_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chatId, threadId, messageId, userId, userName, text, keyword, nowIso(), nextCheckAt,
    );
    return r.changes > 0 ? r.lastId : null;
  }

  getRepair(id) {
    return this.one("SELECT * FROM repairs WHERE id = ?", id);
  }

  setRepairBotMessage(id, messageId) {
    return this.run("UPDATE repairs SET bot_message_id = ? WHERE id = ?", messageId, id);
  }

  // Новое напоминание: запоминаем его, чтобы потом удалить все разом
  setRepairCheckMessage(id, messageId) {
    return this.run(
      `UPDATE repairs SET check_message_id = ?, checks = checks + 1,
       check_message_ids = json_insert(COALESCE(check_message_ids, '[]'), '$[#]', ?) WHERE id = ?`,
      messageId, messageId, id,
    );
  }

  setRepairNextCheck(id, iso) {
    return this.run("UPDATE repairs SET next_check_at = ? WHERE id = ?", iso, id);
  }

  // Атомарно закрывает открытую заявку. false — уже закрыта
  async closeRepair(id, status, byId, byName, closeMessageId) {
    const r = await this.run(
      `UPDATE repairs SET status = ?, closed_by_id = ?, closed_by_name = ?, closed_at = ?,
       close_message_id = ? WHERE id = ? AND status = 'open'`,
      status, byId, byName, nowIso(), closeMessageId, id,
    );
    return r.changes > 0;
  }

  setRepairPhoto(id, fileId) {
    return this.run("UPDATE repairs SET photo_file_id = ? WHERE id = ?", fileId, id);
  }

  // Заявка, к которой относится сообщение (исходное, ответ бота, проверка статуса, закрытие)
  repairByAnyMessage(chatId, messageId) {
    return this.one(
      `SELECT * FROM repairs WHERE chat_id = ? AND (message_id = ? OR bot_message_id = ?
       OR check_message_id = ? OR close_message_id = ?
       OR EXISTS (SELECT 1 FROM json_each(COALESCE(check_message_ids, '[]')) WHERE value = ?))
       ORDER BY id DESC LIMIT 1`,
      chatId, messageId, messageId, messageId, messageId, messageId,
    );
  }

  openRepairs(chatId) {
    return this.all("SELECT * FROM repairs WHERE chat_id = ? AND status = 'open' ORDER BY id", chatId);
  }

  dueRepairs(nowIso_, limit) {
    return this.all(
      "SELECT * FROM repairs WHERE status = 'open' AND next_check_at <= ? ORDER BY next_check_at LIMIT ?",
      nowIso_, limit,
    );
  }

  allRepairs() {
    return this.all("SELECT * FROM repairs ORDER BY id");
  }

  repairKeywordRows(chatId) {
    return this.all("SELECT * FROM repair_keywords WHERE chat_id = ?", chatId);
  }

  setRepairKeyword(chatId, keyword, enabled) {
    return this.run(
      `INSERT INTO repair_keywords (chat_id, keyword, enabled) VALUES (?, ?, ?)
       ON CONFLICT (chat_id, keyword) DO UPDATE SET enabled = excluded.enabled`,
      chatId, keyword, enabled ? 1 : 0,
    );
  }

  // ---------- обмены между пиццериями ----------
  async createExchange({ chatId, threadId, messageId, userId, userName, text, kind, dueAt }) {
    const r = await this.run(
      `INSERT OR IGNORE INTO exchanges (chat_id, thread_id, message_id, user_id, user_name, text, kind,
       created_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chatId, threadId, messageId, userId, userName, text, kind, nowIso(), dueAt,
    );
    return r.changes > 0 ? r.lastId : null;
  }

  getExchange(id) {
    return this.one("SELECT * FROM exchanges WHERE id = ?", id);
  }

  setExchangeBotMessage(id, messageId) {
    return this.run("UPDATE exchanges SET bot_message_id = ? WHERE id = ?", messageId, id);
  }

  setExchangeDue(id, iso) {
    return this.run("UPDATE exchanges SET due_at = ? WHERE id = ?", iso, id);
  }

  addExchangeRemind(id, messageId) {
    return this.run(
      `UPDATE exchanges SET remind_message_ids = json_insert(COALESCE(remind_message_ids, '[]'), '$[#]', ?)
       WHERE id = ?`,
      messageId, id,
    );
  }

  // Атомарно закрывает открытую запись. false — уже закрыта
  async closeExchange(id, status, byId, byName) {
    const r = await this.run(
      `UPDATE exchanges SET status = ?, closed_by_id = ?, closed_by_name = ?, closed_at = ?
       WHERE id = ? AND status = 'open'`,
      status, byId, byName, nowIso(), id,
    );
    return r.changes > 0;
  }

  exchangeByAnyMessage(chatId, messageId) {
    return this.one(
      `SELECT * FROM exchanges WHERE chat_id = ? AND (message_id = ? OR bot_message_id = ?
       OR EXISTS (SELECT 1 FROM json_each(COALESCE(remind_message_ids, '[]')) WHERE value = ?))
       ORDER BY id DESC LIMIT 1`,
      chatId, messageId, messageId, messageId,
    );
  }

  openExchanges(chatId) {
    return this.all("SELECT * FROM exchanges WHERE chat_id = ? AND status = 'open' ORDER BY due_at", chatId);
  }

  dueExchanges(nowIso_, limit) {
    return this.all(
      "SELECT * FROM exchanges WHERE status = 'open' AND due_at <= ? ORDER BY due_at LIMIT ?", nowIso_, limit,
    );
  }

  // ---------- разбор отчётов ----------
  createReportJob({ chatId, threadId, sourceMessageId, fileId, caption, requestedBy, requestedById, placeholderId, location }) {
    return this.run(
      `INSERT INTO report_jobs (chat_id, thread_id, source_message_id, file_id, caption, requested_by,
       requested_by_id, placeholder_id, created_at, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chatId, threadId, sourceMessageId, fileId, caption, requestedBy, requestedById, placeholderId, nowIso(),
      location || null,
    );
  }

  pendingReportJobs(limit) {
    return this.all("SELECT * FROM report_jobs WHERE status = 'pending' ORDER BY id LIMIT ?", limit);
  }

  bumpReportJob(id) {
    return this.run("UPDATE report_jobs SET attempts = attempts + 1 WHERE id = ?", id);
  }

  finishReportJob(id, status) {
    return this.run("UPDATE report_jobs SET status = ? WHERE id = ?", status, id);
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
