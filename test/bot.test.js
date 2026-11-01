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
const tgState = { webhook: "", queue: [], deleted: new Set() }; // deleted — удалённые админом сообщения
let nextId = 5000;
let geminiHandler = null; // имитация Google Gemini: (body) => ответ или ошибка
globalThis.fetch = async (url, init) => {
  if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3, url.length]));
  if (url.includes("generativelanguage.googleapis.com")) {
    const body = JSON.parse(init.body);
    calls.push({ method: "gemini", params: body, headers: init.headers, url });
    const out = await geminiHandler(body);
    if (out instanceof Error) return new Response(JSON.stringify({ error: { message: out.message } }), { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }] }));
  }
  const method = url.split("/").pop();
  const params = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body);
  calls.push({ method, params });
  if (method.startsWith("editMessage") && tgState.deleted.has(Number(params.message_id))) {
    return new Response(JSON.stringify({ ok: false, description: "Bad Request: message to edit not found" }));
  }
  let result = true;
  if (method === "setWebhook") tgState.webhook = params.url;
  else if (method === "getWebhookInfo") result = { url: tgState.webhook, pending_update_count: 0 };
  else if (method === "getUpdates") {
    result = tgState.queue.filter((u) => u.update_id >= (params.offset || 0));
  } else if (method === "getChatAdministrators") {
    result = [{ status: "creator", user: ADM }, { status: "administrator", user: GADM },
      { status: "administrator", user: { id: 1, is_bot: true, first_name: "test_bot" } }];
  } else if (method === "getChatMember") {
    result = { status: params.user_id === GADM.id ? "administrator" : "member", user: { id: params.user_id } };
  } else if (method === "getFile") result = { file_path: `photos/${params.file_id}.jpg` };
  else if (method === "getMe") result = { id: 1, is_bot: true, username: "test_bot" };
  else if (["sendMessage", "sendDocument", "sendPhoto"].includes(method)) {
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
const GADM = { id: 50, is_bot: false, first_name: "GroupAdmin" }; // админ группы, не в ADMIN_IDS

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
  const album = one(cs, "sendMediaGroup");
  assert.equal(album.params.media.length, 2);
  assert.equal(album.params.media[0].media, fix.orig_file_id);
  const caption = album.params.media[0].caption;
  assert.match(caption, /Нарушение<\/b> — <a href="tg:\/\/user\?id=1">Ali<\/a>\nТут ошибка в цене/);
  assert.match(caption, /<b>Исправил\(а\): <a href="tg:\/\/user\?id=2">Vali<\/a><\/b>\nисправил цену/);
  assert.match(caption, /Спасибо за исправление/);
  assert.equal(album.params.media[1].caption, undefined, "одна подпись на весь альбом");
  assert.equal(album.params.message_thread_id, 7);
  const deleted = cs.filter((c) => c.method === "deleteMessage").map((c) => c.params.message_id);
  const fixMsgId = (await DB.prepare("SELECT fix_message_id FROM photo_fixes WHERE id = 1").first()).fix_message_id;
  for (const id of [fix.orig_message_id, fixMsgId, fix.button_message_id, promptMsg.message_id]) {
    assert.ok(deleted.includes(id), `удалено сообщение ${id}`);
  }
  assert.equal(cs.filter((c) => c.method === "sendMessage").length, 0,
    "никаких лишних сообщений — ни в теме, ни в личку");

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

// --- имитация Cloudflare Images: записывает, что нарисовано поверх фото ---
const drawn = [];
const fakeImages = {
  async info() { return { format: "image/jpeg", width: 960, height: 1280 }; },
  input(stream) {
    const ops = { stream, transforms: [], draws: [] };
    const chain = {
      ops,
      transform(t) { ops.transforms.push(t); return chain; },
      draw(overlay, opts) { ops.draws.push({ overlay: overlay.ops, opts }); return chain; },
      async output(o) {
        drawn.push({ draws: ops.draws, output: o });
        return { response: () => new Response(new Uint8Array([9, 9])) };
      },
    };
    return chain;
  },
};

test("на фото рисуются полосы НАРУШЕНИЕ / ИСПРАВЛЕНО", async () => {
  tgState.webhook = "https://bot.example.workers.dev/webhook";
  env.IMAGES = fakeImages;
  await photo(ALI, "грязно на складе");
  const fix = await DB.prepare("SELECT * FROM photo_fixes ORDER BY id DESC LIMIT 1").first();
  await press(VALI, `fix:${fix.id}`, { message_id: fix.button_message_id, date: 0, chat: G, text: "x" });
  const cs = await during(() => photo(VALI, "убрал"));

  assert.equal(drawn.length, 2, "обе фотографии отмечены");
  for (const d of drawn) {
    assert.deepEqual(d.draws[0].opts, { top: 0, left: 0 });
    assert.deepEqual(d.draws[0].overlay.transforms, [{ width: 960 }], "полоса во всю ширину фото");
  }
  const album = one(cs, "sendMediaGroup");
  const media = JSON.parse(album.params.media);
  assert.deepEqual(media.map((m) => m.media), ["attach://violation", "attach://fixed"]);
  assert.match(media[0].caption, /Нарушение[\s\S]*Исправил\(а\)[\s\S]*Спасибо за исправление/);
  assert.ok(album.params.violation instanceof Blob && album.params.fixed instanceof Blob);
  assert.equal(album.params.message_thread_id, "7");
  assert.ok(cs.some((c) => c.method === "deleteMessage" && c.params.message_id === fix.orig_message_id));

  // Если Cloudflare Images недоступен — альбом уходит без отметок
  env.IMAGES = { info: async () => { throw new Error("Images недоступен"); } };
  await photo(ALI, "ещё нарушение");
  const fix2 = await DB.prepare("SELECT * FROM photo_fixes ORDER BY id DESC LIMIT 1").first();
  await press(VALI, `fix:${fix2.id}`, { message_id: fix2.button_message_id, date: 0, chat: G, text: "x" });
  const cs2 = await during(() => photo(VALI, "исправил"));
  const plain = one(cs2, "sendMediaGroup");
  assert.equal(plain.params.media[0].media, fix2.orig_file_id);
  delete env.IMAGES;
});

test("админ возвращает исправленное фото в работу ответом «вернуть»", async () => {
  await photo(ALI, "мусор у входа");
  const fix = await DB.prepare("SELECT * FROM photo_fixes ORDER BY id DESC LIMIT 1").first();
  await press(VALI, `fix:${fix.id}`, { message_id: fix.button_message_id, date: 0, chat: G, text: "x" });
  await photo(VALI, "убрал");
  const done = await DB.prepare("SELECT * FROM photo_fixes WHERE id = ?").bind(fix.id).first();
  assert.equal(done.status, "done");
  const albumIds = JSON.parse(done.result_message_ids);
  assert.equal(albumIds.length, 2);
  const album = { message_id: albumIds[1], date: 0, chat: G, photo: [{ file_id: "x" }] };

  // видимые действия бота в чате
  const visible = (cs) => cs.filter((c) => /^(send|delete|edit)/.test(c.method));
  // обычный участник написал «вернуть» — ничего не происходит
  let cs = await during(() => msg(SAMI, "вернуть", { thread: 7, reply: album }));
  assert.equal(visible(cs).length, 0);
  // «вернуть» не в ответ на альбом — тоже ничего
  cs = await during(() => msg(ADM, "вернуть", { thread: 7 }));
  assert.equal(visible(cs).length, 0);

  // админ группы (не из ADMIN_IDS) отвечает на альбом с причиной
  cs = await during(() => msg(GADM, "Вернуть: плохо видно", { thread: 7, reply: album }));
  const deleted = cs.filter((c) => c.method === "deleteMessage").map((c) => c.params.message_id);
  for (const id of albumIds) assert.ok(deleted.includes(id), `удалено ${id}`);
  assert.equal(deleted.length, 3, "альбом и сообщение админа «вернуть»");
  assert.equal(cs.filter((c) => c.method === "sendMessage").length, 0, "без сообщений в личку");
  const again = one(cs, "sendPhoto");
  assert.equal(again.params.photo, fix.orig_file_id, "исходное фото без отметок");
  assert.match(again.params.caption, /Возвращено в работу[\s\S]*GroupAdmin[\s\S]*Vali[\s\S]*Причина: плохо видно/);
  assert.equal(again.params.reply_markup.inline_keyboard[0][0].callback_data, `fix:${fix.id}`);
  assert.equal(again.params.message_thread_id, 7);
  const reopened = await DB.prepare("SELECT * FROM photo_fixes WHERE id = ?").bind(fix.id).first();
  assert.equal(reopened.status, "open");
  assert.equal(reopened.button_message_id, reopened.orig_message_id);

  // повторный «вернуть» на удалённый альбом ничего не делает
  cs = await during(() => msg(ADM, "вернуть", { thread: 7, reply: album }));
  assert.equal(cs.filter((c) => c.method === "sendPhoto").length, 0);

  // повторное исправление: кнопка на самом фото — меняется подпись, а не текст
  const photoMsg = { message_id: reopened.orig_message_id, date: 0, chat: G, photo: [{ file_id: "x" }] };
  cs = await during(() => press(SAMI, `fix:${fix.id}`, photoMsg));
  const cap = one(cs, "editMessageCaption");
  assert.match(cap.params.caption, /Исправление отправляет/);
  cs = await during(() => photo(SAMI, "теперь чисто"));
  assert.ok(one(cs, "sendMediaGroup"));
  assert.ok(cs.some((c) => c.method === "deleteMessage" && c.params.message_id === reopened.orig_message_id));
});

test("PHOTO_TOPIC: фото-исправления только в теме по ссылке", async () => {
  env.PHOTO_TOPIC = "https://t.me/c/1/87";
  // тема 7 включена командой, но в настройках задана другая — фото там не трогаем
  let cs = await during(() => photo(ALI, "в старой теме"));
  assert.equal(cs.length, 0);
  cs = await during(() => photo(ALI, "в нужной теме", { thread: 87, chat: G }));
  // G.id = -1001 соответствует ссылке t.me/c/1
  assert.ok(cs.some((c) => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("fix:")));
  delete env.PHOTO_TOPIC;
});

test("поломки: какие фразы ловятся, а какие нет", async () => {
  const { findRepairKeyword, DEFAULT_REPAIR_KEYWORDS: kws } = await import("../src/repairs.js");
  const yes = [
    "Печь не греет уже час", "сломалась касса", "Холодильник не охлаждает", "течёт кран на кухне",
    "Тестомес сломался", "перегорела лампа в зале", "засор в раковине", "Терминал не работает",
    "морозилка не морозит", "пахнет газом у печи", "Принтер не печатает чеки", "вытяжка не тянет",
  ];
  const no = [
    "Я сегодня не работаю", "Привет, много заказов", "пицца готова", "печь включили",
    "Кто закрывает смену?", "Спасибо за помощь", "Тесто на завтра готово",
  ];
  for (const t of yes) assert.ok(findRepairKeyword(t, kws), `должно сработать: ${t}`);
  for (const t of no) assert.equal(findRepairKeyword(t, kws), null, `не должно сработать: ${t}`);
});

test("поломки: просьба оформить заявку и уточнение статуса", async () => {
  tgState.webhook = "https://bot.example.workers.dev/webhook";
  env.REPAIR_TOPIC = "https://t.me/c/1/91";
  const T = { thread: 91 };
  const visible = (cs) => cs.filter((c) => /^(send|delete|edit)/.test(c.method));
  const noNumbers = (cs) => cs.every((c) => !/№/.test(c.params.text || ""));

  let cs = await during(() => msg(ALI, "Я сегодня не работаю", T));
  assert.equal(visible(cs).length, 0);
  cs = await during(() => msg(ALI, "Печь не греет уже час", T));
  const first = one(cs, "sendMessage");
  assert.match(first.params.text, /Нужна заявка[\s\S]*не греет[\s\S]*оформите заявку[\s\S]*через 4 ч/i);
  assert.ok(noNumbers(cs), "без номеров заявок");
  assert.equal(first.params.message_thread_id, 91);
  // в первом сообщении — только «Сделать заявку»
  const firstKb = first.params.reply_markup.inline_keyboard;
  assert.equal(firstKb.length, 1);
  assert.equal(firstKb[0].length, 1);
  assert.equal(firstKb[0][0].text, "📝 Сделать заявку");
  const r1 = await DB.prepare("SELECT * FROM repairs WHERE id = 1").first();
  assert.equal(first.params.reply_parameters.message_id, r1.message_id);
  const hoursUntil = (iso) => (Date.parse(iso) - Date.now()) / 3_600_000;
  assert.ok(Math.abs(hoursUntil(r1.next_check_at) - 4) < 0.1, "первое напоминание через 4 ч");
  const firstMsg = { message_id: r1.bot_message_id, date: 0, chat: G, text: "x" };
  cs = await during(() => press(SAMI, firstKb[0][0].callback_data, firstMsg));
  assert.match(one(cs, "answerCallbackQuery").params.text, /Ссылка на систему заявок скоро появится/);

  // со ссылкой на систему кнопка открывает её сразу
  env.REPAIR_SYSTEM_URL = "https://example.com/zayavka";
  cs = await during(() => msg(VALI, "касса не работает", T));
  assert.equal(one(cs, "sendMessage").params.reply_markup.inline_keyboard[0][0].url, "https://example.com/zayavka");
  delete env.REPAIR_SYSTEM_URL;

  // обсуждение в ответ на поломку — новой заявки нет
  cs = await during(() => msg(VALI, "до сих пор не работает", { ...T, reply: { message_id: r1.message_id, date: 0, chat: G, text: "x" } }));
  assert.equal(visible(cs).length, 0);

  // через 48 ч — вопрос о статусе с короткими кнопками (только днём)
  sqlite.prepare("UPDATE repairs SET next_check_at = '2020-01-01T00:00:00Z' WHERE id = 1").run();
  env.PHOTO_REMIND_FROM = "23:59";
  env.PHOTO_REMIND_TO = "23:59";
  cs = await during(runCron);
  assert.equal(texts(cs).filter((t) => /Какой статус/.test(t)).length, 0, "ночью не спрашиваем");
  env.PHOTO_REMIND_FROM = "00:00";
  cs = await during(runCron);
  const check = cs.find((c) => /Какой статус/.test(c.params.text || ""));
  assert.ok(check);
  assert.ok(noNumbers(cs));
  assert.equal(check.params.reply_parameters.message_id, r1.message_id);
  assert.deepEqual(check.params.reply_markup.inline_keyboard[0].map((b) => b.text), ["✅ Починили", "❌ Не поломка"]);
  let r = await DB.prepare("SELECT * FROM repairs WHERE id = 1").first();
  assert.equal(r.checks, 1);
  assert.ok(Math.abs(hoursUntil(r.next_check_at) - 24) < 0.1, "второе — через 24 ч");
  cs = await during(runCron);
  assert.equal(texts(cs).filter((t) => /Какой статус/.test(t)).length, 0);

  // без ответа — следующие напоминания по графику
  sqlite.prepare("UPDATE repairs SET next_check_at = '2020-01-01T00:00:00Z' WHERE id = 1").run();
  cs = await during(runCron);
  assert.ok(texts(cs).some((t) => /Какой статус/.test(t)));
  r = await DB.prepare("SELECT * FROM repairs WHERE id = 1").first();
  assert.ok(Math.abs(hoursUntil(r.next_check_at) - 72) < 0.1, "третье — через 72 ч");
  for (const expected of [168, 168]) {
    sqlite.prepare("UPDATE repairs SET next_check_at = '2020-01-01T00:00:00Z' WHERE id = 1").run();
    await runCron();
    r = await DB.prepare("SELECT * FROM repairs WHERE id = 1").first();
    assert.ok(Math.abs(hoursUntil(r.next_check_at) - expected) < 0.1, "дальше — каждые 7 дней");
  }
  const reminders = JSON.parse(r.check_message_ids);
  assert.equal(reminders.length, 4);
  const checkMsg = { message_id: reminders.at(-1), date: 0, chat: G, text: "x" };

  // подтверждение: нажал Сами — подтвердить может только он
  cs = await during(() => press(SAMI, "rp:1:fixed", checkMsg));
  const confirm = one(cs, "editMessageText");
  assert.match(confirm.params.text, /Sami.*подтвердите: «Печь не греет уже час» — <b>починили<\/b>/);
  assert.deepEqual(confirm.params.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
    ["rp:1:fixed!:3", "rp:1:back:3"]);
  cs = await during(() => press(ALI, "rp:1:fixed!:3", checkMsg));
  assert.match(one(cs, "answerCallbackQuery").params.text, /только тот, кто нажал/);
  cs = await during(() => press(SAMI, "rp:1:back:3", checkMsg));
  assert.deepEqual(one(cs, "editMessageText").params.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
    ["rp:1:fixed", "rp:1:notbug"]);

  // «Починили» — все напоминания удаляются, итог в первом сообщении бота
  await press(VALI, "rp:1:fixed", checkMsg);
  cs = await during(() => press(VALI, "rp:1:fixed!:2", checkMsg));
  const deleted = cs.filter((c) => c.method === "deleteMessage").map((c) => c.params.message_id);
  assert.deepEqual(deleted.sort((a, b) => a - b), reminders, "удалены все напоминания");
  const done = one(cs, "editMessageText");
  assert.equal(done.params.message_id, r1.bot_message_id);
  assert.match(done.params.text, /Починили[\s\S]*Vali[\s\S]*фото после ремонта/);
  assert.equal(done.params.reply_markup.inline_keyboard.length, 0);
  assert.ok(noNumbers(cs));
  r = await DB.prepare("SELECT * FROM repairs WHERE id = 1").first();
  assert.equal(r.status, "fixed");
  sqlite.prepare("UPDATE repairs SET next_check_at = '2020-01-01T00:00:00Z' WHERE id = 1").run();
  cs = await during(runCron);
  assert.equal(texts(cs).filter((t) => /Печь не греет/.test(t)).length, 0, "закрытые не проверяем");

  // фото после ремонта — по желанию, ответом на сообщение «Починили»
  cs = await during(() => photo(VALI, null, { thread: 91, reply: firstMsg }));
  assert.ok(texts(cs).some((t) => /Фото после ремонта добавлено/.test(t)));
  assert.ok((await DB.prepare("SELECT photo_file_id FROM repairs WHERE id = 1").first()).photo_file_id);

  // «Не поломка» при уточнении — все сообщения бота по ней удаляются
  await msg(ALI, "Течёт кран на кухне", T);
  let r2 = await DB.prepare("SELECT * FROM repairs ORDER BY id DESC LIMIT 1").first();
  sqlite.prepare("UPDATE repairs SET next_check_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(r2.id);
  await runCron();
  r2 = await DB.prepare("SELECT * FROM repairs WHERE id = ?").bind(r2.id).first();
  const m2 = { message_id: r2.check_message_id, date: 0, chat: G, text: "x" };
  await press(ALI, `rp:${r2.id}:notbug`, m2);
  cs = await during(() => press(ALI, `rp:${r2.id}:notbug!:1`, m2));
  const del2 = cs.filter((c) => c.method === "deleteMessage").map((c) => c.params.message_id);
  assert.ok(del2.includes(r2.bot_message_id) && del2.includes(r2.check_message_id));
  assert.equal((await DB.prepare("SELECT status FROM repairs WHERE id = ?").bind(r2.id).first()).status, "rejected");

  // слова: админ добавляет и убирает
  await msg(ADM, "/kw_add дым", T);
  cs = await during(() => msg(ALI, "Из печи идёт дым", T));
  assert.ok(texts(cs).some((t) => /Нужна заявка/.test(t)));
  await msg(ADM, "/kw_del слома", T);
  cs = await during(() => msg(ALI, "сломалась лопата", T));
  assert.equal(visible(cs).length, 0);
  cs = await during(() => msg(ALI, "/kw_add взлом", T));
  assert.equal(visible(cs).length, 0, "не-админ не меняет слова");

  // список незакрытых поломок — без номеров
  cs = await during(() => msg(SAMI, "/zayavki", T));
  assert.match(texts(cs)[0], /Незакрытые поломки \(2\)[\s\S]*касса не работает[\s\S]*дым/);
  assert.ok(noNumbers(cs));

  // в других темах бот на поломки не реагирует
  cs = await during(() => msg(ALI, "печь не греет", { thread: 5 }));
  assert.equal(texts(cs).filter((t) => /Нужна заявка/.test(t)).length, 0);

  delete env.REPAIR_TOPIC;
  delete env.PHOTO_REMIND_FROM;
  delete env.PHOTO_REMIND_TO;
});

test("админ удалил сообщение бота — бот больше не напоминает (во всех темах)", async () => {
  tgState.webhook = "https://bot.example.workers.dev/webhook";
  env.REPAIR_TOPIC = "https://t.me/c/1/91";
  env.PHOTO_REMIND_FROM = "00:00";
  env.PHOTO_REMIND_TO = "23:59";
  const past = "2020-01-01T00:00:00Z";
  const sends = (cs) => cs.filter((c) => /^send/.test(c.method));

  // поломка: удалено первое сообщение бота
  await msg(ALI, "Холодильник не охлаждает", { thread: 91 });
  let r = await DB.prepare("SELECT * FROM repairs ORDER BY id DESC LIMIT 1").first();
  tgState.deleted.add(r.bot_message_id);
  sqlite.prepare("UPDATE repairs SET next_check_at = ? WHERE id = ?").run(past, r.id);
  let cs = await during(runCron);
  assert.equal(sends(cs).filter((c) => /Холодильник/.test(c.params.text || "")).length, 0);
  assert.equal((await DB.prepare("SELECT status FROM repairs WHERE id = ?").bind(r.id).first()).status, "cancelled");

  // поломка: удалено напоминание
  await msg(ALI, "Касса не печатает чеки", { thread: 91 });
  r = await DB.prepare("SELECT * FROM repairs ORDER BY id DESC LIMIT 1").first();
  sqlite.prepare("UPDATE repairs SET next_check_at = ? WHERE id = ?").run(past, r.id);
  await runCron();
  r = await DB.prepare("SELECT * FROM repairs WHERE id = ?").bind(r.id).first();
  tgState.deleted.add(r.check_message_id);
  sqlite.prepare("UPDATE repairs SET next_check_at = ? WHERE id = ?").run(past, r.id);
  cs = await during(runCron);
  assert.equal(sends(cs).filter((c) => /Касса/.test(c.params.text || "")).length, 0);
  assert.equal((await DB.prepare("SELECT status FROM repairs WHERE id = ?").bind(r.id).first()).status, "cancelled");
  assert.ok(cs.some((c) => c.method === "deleteMessage" && c.params.message_id === r.bot_message_id),
    "остальные сообщения бота по ней убраны");

  // поломка без удалений — напоминание приходит как обычно
  await msg(ALI, "Печь не греет снова", { thread: 91 });
  r = await DB.prepare("SELECT * FROM repairs ORDER BY id DESC LIMIT 1").first();
  sqlite.prepare("UPDATE repairs SET next_check_at = ? WHERE id = ?").run(past, r.id);
  cs = await during(runCron);
  assert.ok(sends(cs).some((c) => /Печь не греет снова/.test(c.params.text || "")));

  // фото-исправление: удалено сообщение с кнопкой — напоминания «Нужно исправить» нет
  await photo(ALI, "грязный стол");
  const fix = await DB.prepare("SELECT * FROM photo_fixes ORDER BY id DESC LIMIT 1").first();
  tgState.deleted.add(fix.button_message_id);
  sqlite.prepare("UPDATE photo_fixes SET created_at = ? WHERE id = ?").run(past, fix.id);
  cs = await during(runCron);
  assert.equal(texts(cs).filter((t) => /Нужно исправить/.test(t)).length, 0);
  assert.equal((await DB.prepare("SELECT status FROM photo_fixes WHERE id = ?").bind(fix.id).first()).status, "cancelled");

  // задание: удалено сообщение с заданием — ни напоминания, ни дедлайна
  await msg(ADM, "/task Уборка | Протереть столы | 30.10.2099 18:00", { thread: 5 });
  const task = await DB.prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT 1").first();
  tgState.deleted.add(task.message_id);
  sqlite.prepare("UPDATE tasks SET deadline = ? WHERE id = ?").run(past, task.id);
  cs = await during(runCron);
  assert.equal(sends(cs).filter((c) => /Уборка/.test(c.params.text || "")).length, 0);
  const t = await DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first();
  assert.equal(t.closed, 1);

  tgState.deleted.clear();
  delete env.REPAIR_TOPIC;
  delete env.PHOTO_REMIND_FROM;
  delete env.PHOTO_REMIND_TO;
});


// ---------- разбор отчётов ИИ ----------
const LLAMA = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MISTRAL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const GEMMA = "@cf/google/gemma-3-12b-it";
const isJudge = (system) => /Ты проверяешь разборы/.test(system);

// Имитация Workers AI: answers[model] — текст, Error или функция (input) => ответ; нет ключа — ошибка
function fakeAI(answers) {
  const log = [];
  return {
    log,
    run: async (model, input) => {
      log.push({ model, input, judge: isJudge(input.messages[0].content) });
      if (!(model in answers)) throw new Error(`5035: ${model} недоступна`);
      const a = typeof answers[model] === "function" ? answers[model](input) : answers[model];
      if (a instanceof Error) throw a;
      return { response: a };
    },
  };
}
async function requestReport(text = "разбор", thread = 5) {
  const report = await photo(ALI, "отчёт за неделю", { thread });
  await msg(SAMI, text, { thread, reply: report });
  return report;
}
const lastEdit = (cs) => cs.filter((c) => c.method === "editMessageText").at(-1)?.params.text || "";
const techNotes = (cs) => cs.filter((c) => c.method === "sendMessage" && c.params.chat_id === 100 && /тех\. информация/.test(c.params.text));

const ANALYSIS = `📊 Москва - 8 — 30.10

🔎 Главное
Людей много, работают медленно.

✅ Хорошо
- рейтинг 4,80 (сеть 4,72)

❗ Проблема 1: Производительность кухни 6,51 (сеть 7,96)
Почему: лишние люди на смене
Что сделать:
• Убери 1 повара с 12:00–16:00 — до конца недели`;

test("разбор отчёта: очередь, промпт, читаемый ответ, тех. информация только админам", async () => {
  tgState.webhook = "https://bot.example.workers.dev/webhook";
  const ai = fakeAI({ [LLAMA]: "<think>считаю</think>" + ANALYSIS.replace("Людей много", "**Людей много**") });
  env.AI = ai;
  const T = { thread: 5 };

  let cs = await during(() => msg(ALI, "/normy_set всё отлично", T));
  assert.equal(texts(cs).length, 0, "нормы задаёт только админ");
  await msg(ADM, "/normy_set доставка до 30 мин; списания до 2%", T);
  cs = await during(() => msg(SAMI, "/normy", T));
  assert.match(texts(cs)[0], /доставка до 30 мин/);

  let report;
  cs = await during(async () => { report = await requestReport(); });
  assert.match(one(cs, "sendMessage").params.text, /Разбираю отчёт/);
  assert.ok(cs.some((c) => c.method === "deleteMessage" && c.params.message_id !== report.message_id),
    "слово «разбор» удалено");
  assert.ok(!cs.some((c) => c.method === "deleteMessage" && c.params.message_id === report.message_id),
    "вне темы отчётов фото пользователя не трогаем");
  assert.equal(ai.log.length, 0, "ИИ работает в фоне, не в вебхуке");
  cs = await during(() => msg(SAMI, "разбор", { ...T, reply: { message_id: 1, date: 0, chat: G, text: "текст" } }));
  assert.match(texts(cs)[0], /на фото или скриншот/);

  cs = await during(runCron);
  const call = ai.log.find((c) => c.model === LLAMA);
  const user = call.input.messages[1].content;
  assert.match(user[0].text, /Нормы: доставка до 30 мин; списания до 2%[\s\S]*отчёт за неделю/);
  assert.match(user[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(call.input.messages[0].content, /Шаблон ответа/);
  assert.doesNotMatch(call.input.messages[0].content, /Убери 1 повара/, "в инструкции нет готовых действий для копирования");
  assert.deepEqual([...new Set(ai.log.map((c) => c.model))], [LLAMA, MISTRAL, GEMMA], "бесплатные модели, без Kimi");

  const text = lastEdit(cs);
  assert.match(text, /^<b>📊 Москва - 8 — 30\.10<\/b>/);
  assert.match(text, /<b>🔎 Главное<\/b>\nЛюдей много/);
  assert.match(text, /• рейтинг 4,80/, "пункты списком");
  assert.match(text, /<b>Почему:<\/b> лишние люди[\s\S]*<b>Что сделать:<\/b>\n• Убери 1 повара/);
  assert.doesNotMatch(text, /считаю|\*\*|Llama|Mistral|5035|запросил/, "в чате — только разбор");
  const note = techNotes(cs);
  assert.equal(note.length, 1, "тех. информация — админу в личку");
  assert.equal(note[0].params.disable_notification, true);
  assert.match(note[0].params.text, /Ответила модель: Llama 4 Scout[\s\S]*Не ответили: Mistral Small 3\.1: 5035[\s\S]*Gemma 3/);
  cs = await during(runCron);
  assert.equal(ai.log.filter((c) => !c.judge).length, 3, "каждый отчёт разбирается один раз");
  delete env.AI;
});

test("разбор отчёта: несколько моделей, судья выбирает лучший", async () => {
  const ai = fakeAI({
    [LLAMA]: (input) => isJudge(input.messages[0].content)
      ? 'Сверил. {"best": "B", "why": "числа совпадают с отчётом"}'
      : "Ответ Ламы: проанализировать работу",
    [MISTRAL]: "Ответ Мистраля: убери 1 повара 12–16 — до конца недели",
  });
  env.AI = ai;
  await requestReport();
  const cs = await during(runCron);
  const text = lastEdit(cs);
  assert.match(text, /убери 1 повара/);
  assert.doesNotMatch(text, /Ответ Ламы|лучший из/);
  assert.match(techNotes(cs)[0].params.text, /Выбран ответ: Mistral Small 3\.1 \(лучший из 2\)[\s\S]*Почему выбран: числа совпадают/);
  const judgeCall = ai.log.find((c) => c.judge);
  assert.equal(judgeCall.model, LLAMA, "судья — первая из ответивших");
  assert.match(judgeCall.input.messages[1].content[0].text, /Разбор A[\s\S]*Ответ Ламы[\s\S]*Разбор B[\s\S]*Ответ Мистраля/);
  assert.ok(judgeCall.input.messages[1].content[1].image_url, "судья видит отчёт");

  // судья ответил ерундой — берём первый ответ
  env.AI = fakeAI({ [LLAMA]: (i) => (isJudge(i.messages[0].content) ? "не знаю" : "Ответ Ламы"), [MISTRAL]: "Ответ Мистраля" });
  await requestReport();
  assert.match(lastEdit(await during(runCron)), /Ответ Ламы/);
  delete env.AI;
});

test("разбор отчёта: Gemini участвует и судит, если есть ключ; ошибки — только админам", async () => {
  env.AI = fakeAI({ [LLAMA]: "Ответ Ламы" });
  env.GEMINI_API_KEY = " test-key ";
  geminiHandler = (body) => /Ты проверяешь разборы/.test(body.system_instruction.parts[0].text)
    ? '{"best": "A", "why": "конкретнее и цифры верные"}'
    : "Ответ Gemini: 2 заказа на курьера — на ближайшей смене";
  await requestReport();
  let cs = await during(runCron);
  const gem = cs.filter((c) => c.method === "gemini");
  assert.equal(gem.length, 2, "ответ + судейство");
  assert.equal(gem[0].headers["x-goog-api-key"], "test-key");
  assert.match(gem[0].url, /models\/gemini-flash-latest:generateContent/);
  assert.equal(gem[0].params.contents[0].parts[1].inline_data.mime_type, "image/jpeg");
  assert.match(lastEdit(cs), /2 заказа на курьера/);
  assert.match(techNotes(cs)[0].params.text, /Выбран ответ: Gemini/);

  // только Gemini, без Workers AI — тоже работает
  delete env.AI;
  await requestReport();
  assert.match(lastEdit(await during(runCron)), /Ответ Gemini/);

  // лимит у всех — понятное сообщение в чате, причина — админу
  geminiHandler = () => new Error("Resource has been exhausted (e.g. check quota).");
  await requestReport();
  await runCron();
  cs = await during(runCron);
  const fail = lastEdit(cs);
  assert.match(fail, /дневной лимит ИИ закончился/);
  assert.doesNotMatch(fail, /HTTP 429|Gemini/, "в чате без технических подробностей");
  assert.match(techNotes(cs)[0].params.text, /Не ответили: Gemini: HTTP 429/);
  delete env.GEMINI_API_KEY;
  geminiHandler = null;
});

test("разбор отчёта: точка, тема отчётов — бот публикует отчёт от себя", async () => {
  const ai = fakeAI({ [LLAMA]: "📊 разбор" });
  env.AI = ai;
  const T = { thread: 5 };
  const lastPrompt = () => ai.log.filter((c) => !c.judge).at(-1).input.messages[1].content[0].text;

  env.REPORT_LOCATION = "Москва 8";
  await requestReport();
  await runCron();
  assert.match(lastPrompt(), /Разбери точку: Москва 8\./);
  await requestReport("Разбор Москва 3");
  await runCron();
  assert.match(lastPrompt(), /Разбери точку: Москва 3\./);

  await msg(ALI, "/tochka_set Москва 1", T);
  let cs = await during(() => msg(SAMI, "/tochka", T));
  assert.match(texts(cs)[0], /Москва 8/, "не-админ не меняет точку");
  await msg(ADM, "/tochka_set Москва 5", T);
  await requestReport();
  await runCron();
  assert.match(lastPrompt(), /Разбери точку: Москва 5\./);
  await msg(ADM, "/tochka_set", T);
  delete env.REPORT_LOCATION;
  await requestReport();
  await runCron();
  assert.match(lastPrompt(), /Точка не указана/);

  // тема отчётов: фото пользователя удаляется, бот публикует его от себя, разбор — под ним
  env.REPORT_TOPIC = "https://t.me/c/1/95";
  let userPhoto;
  cs = await during(async () => { userPhoto = await photo(ALI, "за субботу", { thread: 95 }); });
  const repost = one(cs, "sendPhoto");
  assert.equal(repost.params.photo, userPhoto.photo.at(-1).file_id);
  assert.equal(repost.params.message_thread_id, 95);
  assert.match(repost.params.caption, /📊 Отчёт\nза субботу/);
  assert.ok(cs.some((c) => c.method === "deleteMessage" && c.params.message_id === userPhoto.message_id), "фото пользователя удалено");
  const placeholder = cs.find((c) => c.method === "sendMessage" && /Разбираю/.test(c.params.text));
  const job = await DB.prepare("SELECT * FROM report_jobs ORDER BY id DESC LIMIT 1").first();
  assert.equal(placeholder.params.reply_parameters.message_id, job.source_message_id, "разбор — ответом на отчёт бота");
  assert.notEqual(job.source_message_id, userPhoto.message_id);

  // файл-картинка публикуется файлом, без сжатия
  cs = await during(() => msg(ALI, null, { thread: 95, extra: { document: { file_id: "DOC1", mime_type: "image/png", file_name: "r.png" } } }));
  assert.equal(one(cs, "sendDocument").params.document, "DOC1");

  cs = await during(() => photo(ALI, null, { thread: 5 }));
  assert.equal(cs.filter((c) => /Разбираю/.test(c.params.text || "")).length, 0, "в других темах — только по слову «разбор»");
  await runCron();
  await runCron();
  delete env.REPORT_TOPIC;

  // без ИИ — честное сообщение
  delete env.AI;
  cs = await during(() => msg(SAMI, "разбор", { ...T, reply: { message_id: 2, date: 0, chat: G, photo: [{ file_id: "x" }] } }));
  assert.match(texts(cs)[0], /не подключён/);
});

test("админ исправляет любой текст бота ответом «исправить»", async () => {
  const BOT = { id: 1, is_bot: true, first_name: "bot", username: "test_bot" };
  const botMsg = { message_id: 7001, date: 0, chat: G, from: BOT, text: "старый текст",
    reply_markup: { inline_keyboard: [[{ text: "Кнопка", callback_data: "x:1" }]] } };
  const T = { thread: 5 };

  // обычный участник — ничего не происходит
  let cs = await during(() => msg(SAMI, "исправить новый", { ...T, reply: botMsg }));
  assert.equal(cs.filter((c) => c.method === "editMessageText").length, 0);

  // админ группы: текст заменён, кнопки и форматирование сохранены, его сообщение удалено
  const text = "Исправить:\nНовый текст жирным";
  const start = text.indexOf("жирным");
  let adminMsg;
  cs = await during(async () => {
    adminMsg = await msg(GADM, text, { ...T, reply: botMsg, extra: { entities: [{ type: "bold", offset: start, length: 6 }] } });
  });
  const edit = one(cs, "editMessageText");
  assert.equal(edit.params.text, "Новый текст жирным");
  assert.deepEqual(edit.params.entities, [{ type: "bold", offset: "Новый текст ".length, length: 6 }]);
  assert.deepEqual(edit.params.reply_markup, botMsg.reply_markup);
  assert.ok(cs.some((c) => c.method === "deleteMessage" && c.params.message_id === adminMsg.message_id));

  // подпись к фото бота
  const botPhoto = { message_id: 7002, date: 0, chat: G, from: BOT, photo: [{ file_id: "P" }], caption: "старая подпись" };
  cs = await during(() => msg(ADM, "исправить новая подпись", { ...T, reply: botPhoto }));
  assert.equal(one(cs, "editMessageCaption").params.caption, "новая подпись");

  // «исправить» в ответ не боту — не трогаем
  cs = await during(() => msg(ADM, "исправить что-то", { ...T, reply: { message_id: 5, date: 0, chat: G, from: ALI, text: "x" } }));
  assert.equal(cs.filter((c) => /^edit/.test(c.method)).length, 0);
});

test("тема «Заявки»: закреп с командами и меню команд", async () => {
  env.REPAIR_TOPIC = "https://t.me/c/1/91";
  sqlite.prepare("DELETE FROM settings WHERE key LIKE 'repair_help:%'").run(); // прошлые тесты уже закрепили
  let cs = await during(runCron);
  const help = cs.find((c) => c.method === "sendMessage" && /Тема «Заявки» — как работает бот/.test(c.params.text));
  assert.ok(help);
  assert.equal(help.params.message_thread_id, 91);
  assert.match(help.params.text, /\/zayavki[\s\S]*\/kw —[\s\S]*\/kw_add/);
  const pin = one(cs, "pinChatMessage");
  assert.equal(pin.params.disable_notification, true);
  cs = await during(runCron);
  assert.equal(cs.filter((c) => /как работает бот/.test(c.params.text || "")).length, 0, "закреп публикуется один раз");

  // меню команд обновляется само после деплоя: участникам — /kw, админам — ещё /kw_add
  sqlite.prepare("DELETE FROM settings WHERE key = 'commands_version'").run();
  cs = await during(runCron);
  const menus = cs.filter((c) => c.method === "setMyCommands");
  const scope = (t) => menus.find((m) => m.params.scope.type === t).params.commands.map((c) => c.command);
  assert.ok(scope("all_group_chats").includes("kw") && !scope("all_group_chats").includes("kw_add"));
  assert.ok(scope("all_chat_administrators").includes("kw_add"));
  cs = await during(runCron);
  assert.equal(cs.filter((c) => c.method === "setMyCommands").length, 0, "меню обновляется один раз");

  // админ группы (не из ADMIN_IDS) меняет слова
  cs = await during(() => msg(GADM, "/kw_add не тянет", { thread: 91 }));
  assert.match(texts(cs)[0], /реагирует на «не тянет»/);
  cs = await during(() => msg(SAMI, "/kw_add взлом", { thread: 91 }));
  assert.equal(texts(cs).length, 0, "обычный участник — нет");
  delete env.REPAIR_TOPIC;
});

test("обмены: какие фразы что означают", async () => {
  const { detectExchange } = await import("../src/exchanges.js");
  const kind = (t) => detectExchange(t)?.kind ?? null;
  assert.equal(kind("Взяли в долг 5 кг сыра у Москвы 3"), "borrowed");
  assert.equal(kind("заняли коробки у соседей"), "borrowed");
  assert.equal(kind("Взяли картошку и тесто Москва 2"), "borrowed");
  assert.equal(kind("Отдали Москва 5 коробок и для пиццы"), "lent");
  assert.equal(kind("Перемещение сделали из другой пиццерии"), "transfer");
  assert.equal(kind("привезли из Москвы 5 тесто"), "transfer");
  assert.equal(kind("Отдали картофель на другой пиццерии"), "lent");
  assert.equal(kind("дали в долг Москве 2 соус"), "lent");
  assert.equal(kind("Всё хорошо, смена закрыта"), null);
  assert.equal(kind("вернули долг Москве 3"), null);
});

test("обмены: напоминание, срок кнопкой, повтор, «Сделано», удаление админом", async () => {
  tgState.webhook = "https://bot.example.workers.dev/webhook";
  env.EXCHANGE_TOPIC = "https://t.me/c/1/169";
  env.PHOTO_REMIND_FROM = "00:00";
  env.PHOTO_REMIND_TO = "23:59";
  const T = { thread: 169 };
  const past = "2020-01-01T00:00:00Z";
  const hoursUntil = (iso) => (Date.parse(iso) - Date.now()) / 3_600_000;

  // закреп с подсказкой
  let cs = await during(runCron);
  assert.ok(cs.some((c) => /Тема обменов между пиццериями/.test(c.params.text || "")));

  // «взяли в долг» → бот просит вернуть и спрашивает срок
  cs = await during(() => msg(ALI, "Взяли в долг 5 кг сыра у Москвы 3", T));
  const first = one(cs, "sendMessage");
  assert.match(first.params.text, /Взяли в долг[\s\S]*не забудь вернуть[\s\S]*Когда вернёте/);
  assert.equal(first.params.message_thread_id, 169);
  const kb = first.params.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(kb, ["Завтра", "Послезавтра", "Через 3 дня", "Через неделю", "✅ Уже сделано"]);
  let e = await DB.prepare("SELECT * FROM exchanges ORDER BY id DESC LIMIT 1").first();
  const h = hoursUntil(e.due_at);
  assert.ok(h > 0 && h < 48, "срок не выбран — напомнит завтра");
  const firstMsg = { message_id: e.bot_message_id, date: 0, chat: G, text: "x" };

  // выбрали «через 3 дня»
  cs = await during(() => press(VALI, `ex:${e.id}:d3`, firstMsg));
  e = await DB.prepare("SELECT * FROM exchanges WHERE id = ?").bind(e.id).first();
  assert.ok(hoursUntil(e.due_at) > 48 && hoursUntil(e.due_at) < 96, "срок через 3 дня");
  assert.match(one(cs, "editMessageText").params.text, /Срок: [\s\S]*12:00[\s\S]*Vali/);

  // ответы в обсуждении новую запись не создают
  cs = await during(() => msg(VALI, "в долг брали только сыр", { ...T, reply: { message_id: e.message_id, date: 0, chat: G, text: "x" } }));
  assert.equal(cs.filter((c) => /^send/.test(c.method)).length, 0);

  // срок наступил — напоминание
  sqlite.prepare("UPDATE exchanges SET due_at = ? WHERE id = ?").run(past, e.id);
  cs = await during(runCron);
  const remind = cs.find((c) => /Срок: вернуть!/.test(c.params.text || ""));
  assert.ok(remind);
  assert.equal(remind.params.reply_parameters.message_id, e.message_id);
  e = await DB.prepare("SELECT * FROM exchanges WHERE id = ?").bind(e.id).first();
  assert.ok(hoursUntil(e.due_at) > 0 && hoursUntil(e.due_at) < 48, "без ответа — завтра снова");

  // ещё раз без ответа
  sqlite.prepare("UPDATE exchanges SET due_at = ? WHERE id = ?").run(past, e.id);
  await runCron();
  e = await DB.prepare("SELECT * FROM exchanges WHERE id = ?").bind(e.id).first();
  const reminders = JSON.parse(e.remind_message_ids);
  assert.equal(reminders.length, 2);
  const lastRemind = { message_id: reminders[1], date: 0, chat: G, text: "x" };

  // «Сделано» — с подтверждением тем же человеком
  await press(SAMI, `ex:${e.id}:done`, lastRemind);
  cs = await during(() => press(ALI, `ex:${e.id}:done!:3`, lastRemind));
  assert.match(one(cs, "answerCallbackQuery").params.text, /только тот, кто нажал/);
  cs = await during(() => press(SAMI, `ex:${e.id}:done!:3`, lastRemind));
  const deleted = cs.filter((c) => c.method === "deleteMessage").map((c) => c.params.message_id).sort((a, b) => a - b);
  assert.deepEqual(deleted, reminders, "напоминания удалены");
  const done = one(cs, "editMessageText");
  assert.equal(done.params.message_id, e.bot_message_id);
  assert.match(done.params.text, /вернуть — сделано[\s\S]*Sami/);
  sqlite.prepare("UPDATE exchanges SET due_at = ? WHERE id = ?").run(past, e.id);
  cs = await during(runCron);
  assert.equal(cs.filter((c) => /Срок: вернуть/.test(c.params.text || "")).length, 0, "закрытые не напоминаются");

  // «отдали» → забрать обратно; список /dolgi
  await msg(ALI, "Отдали картофель на другой пиццерии", T);
  cs = await during(() => msg(SAMI, "/dolgi", T));
  assert.match(texts(cs)[0], /Не закрыто \(1\)[\s\S]*картофель[\s\S]*забрать обратно/);

  // админ удалил сообщение бота — напоминаний больше нет
  let e2 = await DB.prepare("SELECT * FROM exchanges ORDER BY id DESC LIMIT 1").first();
  tgState.deleted.add(e2.bot_message_id);
  sqlite.prepare("UPDATE exchanges SET due_at = ? WHERE id = ?").run(past, e2.id);
  cs = await during(runCron);
  assert.equal(cs.filter((c) => /Срок: забрать обратно/.test(c.params.text || "")).length, 0);
  e2 = await DB.prepare("SELECT status FROM exchanges WHERE id = ?").bind(e2.id).first();
  assert.equal(e2.status, "cancelled");
  tgState.deleted.clear();

  // в других темах бот на такие слова не реагирует
  cs = await during(() => msg(ALI, "взяли в долг соус", { thread: 5 }));
  assert.equal(texts(cs).filter((t) => /не забудь/.test(t)).length, 0);

  delete env.EXCHANGE_TOPIC;
  delete env.PHOTO_REMIND_FROM;
  delete env.PHOTO_REMIND_TO;
});
