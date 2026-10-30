// Сквозной тест: обновления Telegram -> Worker -> имитация D1 (node:sqlite) и Bot API.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.js";

// Логи воркера мешают выводу тест-раннера
console.log = () => {};
console.warn = () => {};

// --- имитация D1 поверх node:sqlite ---
class FakeStmt {
  constructor(db, sql, params = []) { Object.assign(this, { db, sql, params }); }
  bind(...params) { return new FakeStmt(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
const sqlite = new DatabaseSync(":memory:");
const DB = {
  prepare: (sql) => new FakeStmt(sqlite, sql),
  batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
};

// --- имитация Telegram Bot API ---
const calls = [];
const tgState = { webhook: "", queue: [] };
let nextId = 5000;
globalThis.fetch = async (url, init) => {
  const method = url.split("/").pop();
  const params = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body);
  calls.push({ method, params });
  let result = true;
  if (method === "setWebhook") tgState.webhook = params.url;
  else if (method === "getWebhookInfo") result = { url: tgState.webhook, pending_update_count: 0 };
  else if (method === "getUpdates") {
    result = tgState.queue.filter((u) => u.update_id >= (params.offset || 0));
  } else if (method === "getMe") result = { id: 1, is_bot: true, username: "test_bot" };
  else if (["sendMessage", "sendDocument"].includes(method)) {
    result = { message_id: nextId++, chat: { id: params.chat_id }, date: 0 };
  } else if (method === "copyMessage") result = { message_id: nextId++ };
  else if (method === "sendMediaGroup") result = [{ message_id: nextId++ }, { message_id: nextId++ }];
  return new Response(JSON.stringify({ ok: true, result }));
};

const TOKEN = "123:secret";
const env = { DB, BOT_TOKEN: TOKEN, ADMIN_IDS: "100", TIMEZONE: "Asia/Tashkent" };
const ORIGIN = "https://bot.example.workers.dev";

let secret;
let updateId = 1;
const G = { id: -1001, type: "supergroup", is_forum: true };
const P = { id: 100, type: "private" };
const ADM = { id: 100, is_bot: false, first_name: "Admin" };
const ALI = { id: 1, is_bot: false, first_name: "Ali" };
const VALI = { id: 2, is_bot: false, first_name: "Vali" };
const SAMI = { id: 3, is_bot: false, first_name: "Sami" };

async function send(update) {
  const res = await worker.fetch(new Request(`${ORIGIN}/webhook`, {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  }), env);
  assert.equal(res.status, 200);
}

function msg(from, text, { chat = G, thread = 5, reply = null, extra = {} } = {}) {
  const m = { message_id: nextId++, date: 0, chat, from, ...extra };
  if (text !== null) m.text = text;
  if (chat.type !== "private") Object.assign(m, { message_thread_id: thread, is_topic_message: true });
  if (reply) m.reply_to_message = reply;
  return send({ message: m }).then(() => m);
}
const photo = (from, caption, opts = {}) =>
  msg(from, null, { thread: 7, ...opts, extra: { photo: [{ file_id: `F${nextId}`, width: 1, height: 1 }], caption } });
const press = (from, data, message) =>
  send({ callback_query: { id: "cb", from, chat_instance: "x", data, message } });

// Вызовы Bot API, сделанные во время fn
async function during(fn) {
  const start = calls.length;
  await fn();
  return calls.slice(start);
}
const texts = (cs) => cs.filter((c) => c.params.text).map((c) => c.params.text);
const one = (cs, method) => cs.find((c) => c.method === method);

test("настройка вебхука", async () => {
  const bad = await worker.fetch(new Request(`${ORIGIN}/setup?token=wrong`), env);
  assert.equal(bad.status, 403);
  const cs = await during(async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/setup?token=${encodeURIComponent(TOKEN)}`), env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /@test_bot подключён/);
  });
  const hook = one(cs, "setWebhook");
  assert.equal(hook.params.url, `${ORIGIN}/webhook`);
  secret = hook.params.secret_token;

  const forged = await worker.fetch(new Request(`${ORIGIN}/webhook`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "nope" }, body: "{}",
  }), env);
  assert.equal(forged.status, 403);
});

test("темы, автоответы, задания и оценка", async () => {
  await send({ message: { message_id: nextId++, date: 0, chat: G, message_thread_id: 5,
    forum_topic_created: { name: "Математика", icon_color: 1 } } });
  await msg(VALI, "привет всем");

  let cs = await during(() => msg(ADM, "/faq_add дедлайн | До пятницы 18:00"));
  assert.match(texts(cs)[0], /Автоответ на «дедлайн»/);
  cs = await during(() => msg(ALI, "а какой дедлайн?"));
  assert.deepEqual(texts(cs), ["До пятницы 18:00"]);
  cs = await during(() => msg(ALI, "/faq_add взлом | нет"));
  assert.equal(cs.length, 0, "не-админ не может добавлять автоответы");

  cs = await during(() => msg(ADM, "/task@test_bot Решить задачи | Стр. 15 | 30.10.2099 18:00"));
  const post = one(cs, "sendMessage");
  assert.match(post.params.text, /Задание #1: Решить задачи/);
  assert.match(post.params.text, /30\.10\.2099 18:00/);
  assert.equal(post.params.message_thread_id, 5);
  assert.ok(one(cs, "pinChatMessage") && one(cs, "deleteMessage"));
  const taskMsg = { message_id: (await DB.prepare("SELECT message_id FROM tasks").first()).message_id,
    date: 0, chat: G, text: "task" };

  cs = await during(() => msg(ALI, "мой ответ: 42", { reply: taskMsg }));
  assert.deepEqual(texts(cs).slice(0, 1), ["📥 Работа принята на проверку!"]);
  assert.ok(one(cs, "copyMessage"));
  const card = cs.find((c) => c.method === "sendMessage" && c.params.chat_id === 100);
  assert.match(card.params.text, /Новая сдача #1/);
  assert.equal(card.params.reply_markup.inline_keyboard[0].length, 5);

  cs = await during(() => press(ADM, "rv:1:5", { message_id: 1, chat: P, date: 0 }));
  assert.ok(texts(cs).some((t) => /принято! Оценка: ⭐⭐⭐⭐⭐/.test(t)));
  cs = await during(() => press(ADM, "rv:1:3", { message_id: 1, chat: P, date: 0 }));
  assert.equal(one(cs, "answerCallbackQuery").params.text, "Эта работа уже проверена.");
  cs = await during(() => press(ALI, "rv:1:1", { message_id: 1, chat: P, date: 0 }));
  assert.equal(one(cs, "answerCallbackQuery").params.text, "Только для администраторов.");

  await msg(VALI, "#сдаю вот решение");
  cs = await during(() => press(ADM, "rv:2:0", { message_id: 1, chat: P, date: 0 }));
  assert.ok(texts(cs).some((t) => /не принято/.test(t)));
  await press(ADM, "cm:2", { message_id: 1, chat: P, date: 0 });
  cs = await during(() => msg(ADM, "Нет решения №5", { chat: P }));
  assert.ok(texts(cs).some((t) => /Комментарий проверяющего/.test(t) && /Нет решения №5/.test(t)));
  cs = await during(() => msg(VALI, "исправил", { reply: taskMsg }));
  assert.match(texts(cs)[0], /повторную проверку/);

  cs = await during(() => msg(ALI, "/ask можно сдать позже?"));
  assert.match(texts(cs)[0], /Запрос #1 передан/);
  await press(ADM, "ans:1", { message_id: 1, chat: P, date: 0 });
  cs = await during(() => msg(ADM, "Да, до субботы", { chat: P }));
  assert.ok(texts(cs).some((t) => /ответ администратора:\nДа, до субботы/.test(t)));

  cs = await during(() => msg(ALI, "/my"));
  assert.match(texts(cs)[0], /Принято: 1/);
  cs = await during(() => msg(ADM, "/stats", { chat: P }));
  assert.match(texts(cs)[0], /1\. Ali — 1\/1 \(100%\), баллы: 5/);
  cs = await during(() => msg(ADM, "/export", { chat: P }));
  assert.ok(one(cs, "sendDocument"));
  cs = await during(() => msg(ALI, "/stats", { chat: { id: 1, type: "private" } }));
  assert.equal(cs.length, 0, "статистика только для админов");
});

test("фото-исправления", async () => {
  let cs = await during(() => photo(ALI, "до включения"));
  assert.equal(cs.length, 0, "пока тема не включена, фото не трогаем");
  await msg(ALI, "/photo_topic", { thread: 7 });
  assert.equal((await DB.prepare("SELECT photo_mode FROM topics WHERE thread_id = 7").first())?.photo_mode ?? 0, 0);
  cs = await during(() => msg(ADM, "/photo_topic", { thread: 7 }));
  assert.match(texts(cs)[0], /Отправить фото исправление/);

  cs = await during(() => photo(ALI, "Тут ошибка в цене"));
  const btn = one(cs, "sendMessage");
  const button = btn.params.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, "📸 Отправить фото исправление");
  assert.equal(button.style, "danger", "кнопка яркая");
  assert.equal(btn.params.message_thread_id, 7);
  const fix = await DB.prepare("SELECT * FROM photo_fixes WHERE id = 1").first();
  const btnMsg = { message_id: fix.button_message_id, date: 0, chat: G, text: "x" };

  cs = await during(() => press(VALI, "fix:1", btnMsg));
  const edit = one(cs, "editMessageText");
  assert.deepEqual(edit.params.reply_markup.inline_keyboard, [], "кнопка удалена");
  assert.match(edit.params.text, /Исправление отправляет/);
  const prompt = cs.find((c) => c.method === "sendMessage" && c.params.reply_markup?.force_reply);
  assert.ok(prompt, "после нажатия сразу открывается ответ");
  assert.equal(prompt.params.reply_markup.selective, true);
  assert.match(prompt.params.reply_markup.input_field_placeholder, /фото/);
  assert.equal(prompt.params.message_thread_id, 7);
  cs = await during(() => press(SAMI, "fix:1", btnMsg));
  assert.match(one(cs, "answerCallbackQuery").params.text, /уже отправляет Vali/);

  const promptMsg = { message_id: (await DB.prepare("SELECT prompt_message_id AS id FROM photo_fixes WHERE id = 1").first()).id,
    date: 0, chat: G, text: "prompt" };
  cs = await during(() => photo(VALI, "исправил цену", { reply: promptMsg }));
  assert.ok(cs.some((c) => c.method === "deleteMessage" && c.params.message_id === promptMsg.message_id),
    "подсказка удаляется после исправления");
  const album = one(cs, "sendMediaGroup");
  assert.equal(album.params.media.length, 2);
  assert.equal(album.params.media[0].media, fix.orig_file_id);
  assert.match(album.params.media[0].caption, /Оригинал — Ali\nТут ошибка в цене/);
  assert.match(album.params.media[1].caption, /Исправление — Vali\nисправил цену/);
  assert.equal(album.params.reply_parameters.message_id, fix.orig_message_id);
  assert.ok(texts(cs).some((t) => /Спасибо за исправление/.test(t)));
  assert.equal(cs.filter((c) => c.params.reply_markup?.inline_keyboard?.length).length, 0,
    "у исправления нет своей кнопки");

  // Взялся, но не прислал — кнопка возвращается по таймауту
  await photo(ALI, "ещё одно");
  const fix2 = await DB.prepare("SELECT * FROM photo_fixes WHERE id = 2").first();
  await press(SAMI, "fix:2", { message_id: fix2.button_message_id, date: 0, chat: G, text: "x" });
  sqlite.prepare("UPDATE photo_fixes SET claimed_at = '2020-01-01T00:00:00Z' WHERE id = 2").run();
  cs = await during(() => runCron());
  const restored = one(cs, "editMessageText");
  assert.match(restored.params.text, /кнопка снова доступна/);
  assert.equal(restored.params.reply_markup.inline_keyboard[0][0].callback_data, "fix:2");
});

async function runCron() {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

test("напоминание и дедлайн", async () => {
  sqlite.prepare("UPDATE tasks SET deadline = ?").run(new Date(Date.now() + 3_600_000).toISOString());
  let cs = await during(runCron);
  // все участники сдали — напоминать некого
  assert.equal(texts(cs).filter((t) => /Напоминание/.test(t)).length, 0);
  await msg(SAMI, "я новенький");
  sqlite.prepare("UPDATE tasks SET reminded = 0").run();
  cs = await during(runCron);
  assert.ok(texts(cs).some((t) => /Напоминание/.test(t) && /Sami/.test(t)));

  sqlite.prepare("UPDATE tasks SET deadline = '2020-01-01T00:00:00Z'").run();
  cs = await during(runCron);
  assert.ok(texts(cs).some((t) => /Дедлайн задания #1/.test(t) && /Не сдали: .*Sami/.test(t)));
  assert.ok(cs.some((c) => c.params.chat_id === 100 && /Дедлайн наступил/.test(c.params.text)));
  cs = await during(runCron);
  assert.equal(texts(cs).filter((t) => /Дедлайн/.test(t)).length, 0, "дедлайн обрабатывается один раз");
});

test("ежедневный отчёт — один раз в день", async () => {
  env.DAILY_REPORT_TIME = "00:00";
  // более ранние прогоны cron могли уже отправить отчёт (зависит от текущего времени)
  sqlite.prepare("DELETE FROM settings WHERE key = 'last_daily_report'").run();
  let cs = await during(runCron);
  const report = cs.find((c) => c.params.chat_id === 100 && /Ежедневный отчёт/.test(c.params.text || ""));
  assert.ok(report);
  assert.match(report.params.text, /Фото-исправления<\/b> \(всего 1\)/);
  cs = await during(runCron);
  assert.equal(texts(cs).filter((t) => /Ежедневный отчёт/.test(t)).length, 0);
});

test("бот сообщает пользователю его ID", async () => {
  const cs = await during(() => msg(SAMI, "/start", { chat: { id: 3, type: "private" } }));
  assert.match(texts(cs)[0], /Ваш Telegram ID: <code>3<\/code>/);
});

test("автоподключение по WORKER_URL без браузера", async () => {
  env.WORKER_URL = "telegram-tasks-bot.demo.workers.dev/";
  let cs = await during(runCron);
  const hook = one(cs, "setWebhook");
  assert.equal(hook.params.url, "https://telegram-tasks-bot.demo.workers.dev/webhook");
  assert.equal(hook.params.secret_token, secret);
  cs = await during(runCron);
  assert.equal(one(cs, "setWebhook"), undefined, "повторно не подключает");
  delete env.WORKER_URL;
});

test("резервный режим без вебхука: бот сам забирает сообщения", async () => {
  tgState.webhook = "";
  env.WORKER_URL = "not a url %%%";
  tgState.queue = [{ update_id: 900, message: {
    message_id: nextId++, date: 0, chat: { id: 3, type: "private" }, from: SAMI, text: "/start",
  } }];
  let cs = await during(runCron);
  const reply = cs.find((c) => c.method === "sendMessage" && c.params.chat_id === 3);
  assert.match(reply.params.text, /Ваш Telegram ID: <code>3<\/code>/);
  assert.match(reply.params.text, /резервном режиме[\s\S]*неверный адрес в WORKER_URL/);
  cs = await during(runCron);
  assert.equal(cs.filter((c) => c.method === "sendMessage" && c.params.chat_id === 3).length, 0,
    "одно и то же сообщение не обрабатывается дважды");
  delete env.WORKER_URL;
});

test("лишние пробелы в токене не мешают", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/webhook`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: updateId++ }),
  }), { ...env, BOT_TOKEN: ` ${TOKEN}\n` });
  assert.equal(res.status, 200);
});

test("напоминание о фото без исправления через 7 часов, только днём", async () => {
  tgState.webhook = "https://bot.example.workers.dev/webhook";
  await photo(ALI, "ждёт исправления");
  const fix = await DB.prepare("SELECT * FROM photo_fixes ORDER BY id DESC LIMIT 1").first();
  const sixHours = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const eightHours = new Date(Date.now() - 8 * 3_600_000).toISOString();
  sqlite.prepare("UPDATE photo_fixes SET created_at = ? WHERE id = ?").run(sixHours, fix.id);
  env.PHOTO_REMIND_FROM = "00:00";
  env.PHOTO_REMIND_TO = "23:59";
  const reminders = (cs) => texts(cs).filter((t) => /Нужно исправить/.test(t));

  let cs = await during(runCron);
  assert.equal(reminders(cs).length, 0, "ещё не прошло 7 часов");

  sqlite.prepare("UPDATE photo_fixes SET created_at = ? WHERE id = ?").run(eightHours, fix.id);
  env.PHOTO_REMIND_FROM = "23:59";
  env.PHOTO_REMIND_TO = "23:59";
  cs = await during(runCron);
  assert.equal(reminders(cs).length, 0, "ночью не напоминаем");

  env.PHOTO_REMIND_FROM = "00:00";
  cs = await during(runCron);
  const reminder = cs.find((c) => /Нужно исправить/.test(c.params.text || ""));
  assert.ok(reminder);
  assert.equal(reminder.params.reply_parameters.message_id, fix.orig_message_id);
  assert.equal(reminder.params.reply_markup.inline_keyboard[0][0].callback_data, `fix:${fix.id}`);
  assert.ok(cs.some((c) => c.method === "deleteMessage" && c.params.message_id === fix.button_message_id),
    "старая кнопка убрана");
  const after = await DB.prepare("SELECT button_message_id FROM photo_fixes WHERE id = ?").bind(fix.id).first();
  assert.notEqual(after.button_message_id, fix.button_message_id);

  cs = await during(runCron);
  assert.equal(reminders(cs).length, 0, "напоминаем один раз");
  delete env.PHOTO_REMIND_FROM;
  delete env.PHOTO_REMIND_TO;
});
