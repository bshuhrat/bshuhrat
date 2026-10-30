// Обработчики в групповом чате: темы, автоответы, задания, сдачи, запросы, фото.
import { handlePhoto, onFixButton, onReturnButton } from "./photofix.js";
import { acceptSubmission, closeTask, publishTask, registerRequest } from "./services.js";
import { taskSummary } from "./stats.js";
import {
  containsKeyword, esc, fmtDt, fullName, mention, parseCommand, parseDeadline, splitArgs, threadOf,
} from "./utils.js";

const SUBMIT_TAGS = ["#сдаю", "#сдал", "#сдала", "#done"];

const HELP_MEMBER = `🤖 <b>Команды бота</b>

<b>Для участников</b>
/tasks — открытые задания в этой теме
/info — правила и описание темы
/faq — частые вопросы темы
/ask <i>текст</i> — задать вопрос администратору
/my — моя статистика
Сдать задание — ответьте (reply) на сообщение с заданием или напишите <code>#сдаю</code> в теме с одним открытым заданием.
В теме фото-исправлений нажмите «📷 Отправить фото исправление» под фото и пришлите исправленное фото.`;

const HELP_ADMIN = `

<b>Для администраторов</b>
/topic <i>название</i> — назвать текущую тему
/welcome <i>текст</i> — описание/правила темы (показывается по /info)
/faq_add <i>ключевое слово | ответ</i> — автоответ в этой теме
/faq_del <i>ключевое слово</i> — удалить автоответ
/task <i>название | описание | дедлайн</i> — новое задание в этой теме
   дедлайн: <code>25.10.2026 18:00</code> или <code>25.10</code>
/photo_topic — сделать текущую тему темой фото-исправлений (<code>/photo_topic off</code> — выключить)
/close <i>id</i> — закрыть задание и получить итог
/stat <i>id</i> — итог по заданию (придёт в личку)`;

const isAdmin = (ctx, user) => Boolean(user) && ctx.cfg.adminIds.has(user.id);

export async function handleGroupMessage(ctx, msg) {
  const { db, tg, cfg } = ctx;
  if (cfg.groupId && msg.chat.id !== cfg.groupId) return;
  const user = msg.from;
  const chatId = msg.chat.id;

  // Служебные события
  if (msg.forum_topic_created) {
    await db.setTopic(chatId, msg.message_thread_id, msg.forum_topic_created.name);
    return;
  }
  if (msg.forum_topic_edited?.name) {
    await db.setTopic(chatId, msg.message_thread_id, msg.forum_topic_edited.name);
    return;
  }
  if (msg.new_chat_members) {
    for (const u of msg.new_chat_members) {
      if (u.is_bot) continue;
      await db.touchMember(chatId, u.id, u.username, fullName(u));
      await tg.send(chatId, `👋 Добро пожаловать, ${mention(u.id, fullName(u))}!\n` +
        "Задания публикуются в темах группы. Команды: /help");
    }
    return;
  }
  if (msg.left_chat_member) {
    await db.removeMember(chatId, msg.left_chat_member.id);
    return;
  }
  if (!user || user.is_bot) return;
  await db.touchMember(chatId, user.id, user.username, fullName(user));

  const command = parseCommand(msg, cfg.botUsername);
  if (command) {
    await handleCommand(ctx, msg, command);
    return;
  }

  // Сдача: ответ на сообщение с заданием
  if (msg.reply_to_message && !isAdmin(ctx, user)) {
    const task = await db.taskByMessage(chatId, msg.reply_to_message.message_id);
    if (task) {
      await acceptSubmission(ctx, msg, task);
      return;
    }
  }
  if (await handlePhoto(ctx, msg)) return;
  await autoAnswer(ctx, msg);
}

async function handleCommand(ctx, msg, { cmd, args }) {
  const { db, tg, cfg } = ctx;
  const chatId = msg.chat.id;
  const threadId = threadOf(msg);
  const admin = isAdmin(ctx, msg.from);

  switch (cmd) {
    case "help":
    case "start":
      await tg.reply(msg, HELP_MEMBER + (admin ? HELP_ADMIN : ""));
      return;

    case "info": {
      const topic = await db.getTopic(chatId, threadId);
      const name = await db.topicName(chatId, threadId);
      let text = `ℹ️ <b>${esc(name)}</b>\n\n`;
      text += topic?.welcome ? esc(topic.welcome) : "Описание темы пока не задано.";
      const tasks = await db.openTasks(chatId, threadId);
      if (tasks.length) {
        text += "\n\n📝 Открытые задания:\n" + tasks
          .map((t) => `• #${t.id} ${esc(t.title)} (до ${fmtDt(t.deadline, cfg.timezone)})`)
          .join("\n");
      }
      await tg.reply(msg, text);
      return;
    }

    case "faq": {
      const items = await db.listFaq(chatId, threadId);
      await tg.reply(msg, items.length
        ? "❓ <b>Частые вопросы</b>\n\n" +
          items.map((i) => `<b>${esc(i.keyword)}</b>\n${esc(i.answer)}`).join("\n\n")
        : "В этой теме пока нет автоответов.");
      return;
    }

    case "tasks": {
      const tasks = await db.openTasks(chatId, threadId);
      if (!tasks.length) {
        await tg.reply(msg, "В этой теме нет открытых заданий.");
        return;
      }
      const lines = ["📝 <b>Открытые задания</b>"];
      for (const t of tasks) {
        const sub = await db.findSubmission(t.id, msg.from.id);
        const mark = !sub ? "— не сдано" : {
          approved: `✅ ${sub.score}⭐`, pending: "⏳ на проверке", rejected: "❌ нужно переделать",
        }[sub.status];
        lines.push(`• #${t.id} ${esc(t.title)} — до ${fmtDt(t.deadline, cfg.timezone)} · ${mark}`);
      }
      await tg.reply(msg, lines.join("\n"));
      return;
    }

    case "my": {
      const tasks = await db.allTasks(chatId);
      const subs = (await db.allSubmissions(chatId)).filter((s) => s.user_id === msg.from.id);
      const approved = subs.filter((s) => s.status === "approved");
      const points = approved.reduce((a, s) => a + s.score, 0);
      const avg = approved.length ? (points / approved.length).toFixed(1) : "—";
      const n = (st) => subs.filter((s) => s.status === st).length;
      await tg.reply(msg,
        `📈 <b>Статистика: ${esc(fullName(msg.from))}</b>\n` +
        `Заданий всего: ${tasks.length}\n✅ Принято: ${approved.length}\n` +
        `⏳ На проверке: ${n("pending")}\n❌ Отклонено: ${n("rejected")}\n` +
        `🚫 Не сдано: ${tasks.length - subs.length}\nБаллы: ${points} · средняя оценка: ${avg}`);
      return;
    }

    case "ask":
    case "request":
    case "vopros":
      if (!args) {
        await tg.reply(msg, "Напишите вопрос после команды: <code>/ask Когда дедлайн?</code>");
        return;
      }
      await registerRequest(ctx, msg, args);
      return;
  }

  // Дальше — только команды администратора
  if (!admin) return;

  switch (cmd) {
    case "topic":
      if (!args) {
        await tg.reply(msg, "Использование: <code>/topic Название темы</code>");
        return;
      }
      await db.setTopic(chatId, threadId, args);
      await tg.reply(msg, `✅ Тема сохранена как «${esc(args)}».`);
      return;

    case "welcome":
      await db.setWelcome(chatId, threadId, args);
      await tg.reply(msg, args ? "✅ Описание темы обновлено." : "Описание темы очищено.");
      return;

    case "faq_add": {
      const [keyword, answer] = splitArgs(args, 2);
      if (!keyword || !answer) {
        await tg.reply(msg, "Использование: <code>/faq_add дедлайн | Сдать нужно до пятницы</code>");
        return;
      }
      await db.addFaq(chatId, threadId, keyword, answer);
      await tg.reply(msg, `✅ Автоответ на «${esc(keyword)}» добавлен в эту тему.`);
      return;
    }

    case "faq_del":
      await tg.reply(msg, (await db.delFaq(chatId, threadId, args)) ? "🗑 Удалено." : "Такого автоответа нет.");
      return;

    case "photo_topic": {
      if (cfg.photoTopic) {
        const { chatId: c, threadId: t } = cfg.photoTopic;
        await tg.reply(msg, "Тема фото-исправлений задана в настройках бота (PHOTO_TOPIC): " +
          `https://t.me/c/${String(c).replace(/^-100/, "")}/${t}`);
        return;
      }
      const enabled = !["off", "выкл", "0"].includes(args.toLowerCase());
      await db.setPhotoMode(chatId, threadId, enabled);
      await tg.reply(msg, enabled
        ? "✅ Теперь под каждым фото в этой теме будет кнопка «📷 Отправить фото исправление»."
        : "Режим фото-исправлений в этой теме выключен.");
      return;
    }

    case "task": {
      const [title, description, deadlineRaw] = splitArgs(args, 3);
      if (!title) {
        await tg.reply(msg, "Использование:\n<code>/task Название | Описание | 25.10.2026 18:00</code>\n" +
          "Описание и дедлайн необязательны.");
        return;
      }
      let deadline = null;
      if (deadlineRaw) {
        deadline = parseDeadline(deadlineRaw, cfg.timezone);
        if (!deadline) {
          await tg.reply(msg, "Не понял дедлайн. Формат: <code>25.10.2026 18:00</code> или <code>25.10</code>");
          return;
        }
      }
      const taskId = await db.createTask(chatId, threadId, title, description, deadline);
      if (await publishTask(ctx, taskId)) await tg.del(chatId, msg.message_id);
      else await tg.reply(msg, "Не удалось опубликовать задание — проверьте права бота.");
      return;
    }

    case "close": {
      if (!/^\d+$/.test(args)) {
        await tg.reply(msg, "Использование: <code>/close 3</code>");
        return;
      }
      const summary = await closeTask(ctx, Number(args));
      if (!summary) {
        await tg.reply(msg, "Задание не найдено.");
        return;
      }
      await tg.del(chatId, msg.message_id);
      if (!(await tg.send(msg.from.id, summary))) await tg.send(chatId, summary, { thread: threadId });
      return;
    }

    case "stat": {
      const task = /^\d+$/.test(args) ? await db.getTask(Number(args)) : null;
      if (!task) {
        await tg.reply(msg, "Использование: <code>/stat 3</code>");
        return;
      }
      await tg.del(chatId, msg.message_id);
      if (!(await tg.send(msg.from.id, await taskSummary(ctx, task)))) {
        await tg.send(chatId, "Напишите боту /start в личку, чтобы получать статистику.", { thread: threadId });
      }
      return;
    }
  }
}

async function autoAnswer(ctx, msg) {
  const text = msg.text || msg.caption || "";
  if (!text) return;
  const threadId = threadOf(msg);

  // Сдача по хэштегу, если в теме ровно одно открытое задание
  if (!isAdmin(ctx, msg.from) && SUBMIT_TAGS.some((t) => text.toLowerCase().includes(t))) {
    const tasks = await ctx.db.openTasks(msg.chat.id, threadId);
    if (tasks.length === 1) await acceptSubmission(ctx, msg, tasks[0]);
    else if (tasks.length) {
      await ctx.tg.reply(msg, "В теме несколько заданий — ответьте (reply) на сообщение нужного задания.");
    } else await ctx.tg.reply(msg, "В этой теме нет открытых заданий.");
    return;
  }

  // Автоответы по ключевым словам этой темы
  for (const item of await ctx.db.listFaq(msg.chat.id, threadId)) {
    if (containsKeyword(text, item.keyword)) {
      await ctx.tg.reply(msg, esc(item.answer));
      return;
    }
  }
}

export async function handleGroupCallback(ctx, call) {
  const [kind, id] = call.data.split(":");
  if (kind === "fix") {
    await onFixButton(ctx, call);
  } else if (kind === "ret") {
    await onReturnButton(ctx, call);
  } else if (kind === "how") {
    await ctx.tg.answer(call.id,
      "Нажмите «Ответить» (reply) на сообщение с заданием и пришлите текст, фото или файл. " +
      "Бот передаст работу на проверку.", true);
  } else if (kind === "who") {
    const subs = await ctx.db.submissionsForTask(Number(id));
    if (!subs.length) {
      await ctx.tg.answer(call.id, "Пока никто не сдал.", true);
      return;
    }
    const icon = { approved: "✅", pending: "⏳", rejected: "❌" };
    const text = subs.map((s) => `${icon[s.status]} ${s.full_name}`).join("\n");
    await ctx.tg.answer(call.id, text.slice(0, 200), true);
  }
}
