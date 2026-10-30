const btn = (text, data) => ({ text, callback_data: data });

export const taskKeyboard = (taskId) => ({
  inline_keyboard: [[btn("📤 Как сдать", `how:${taskId}`), btn("📊 Кто сдал", `who:${taskId}`)]],
});

export const reviewKeyboard = (subId) => ({
  inline_keyboard: [
    [1, 2, 3, 4, 5].map((i) => btn(`${i} ⭐`, `rv:${subId}:${i}`)),
    [btn("❌ Отклонить", `rv:${subId}:0`), btn("💬 Комментарий", `cm:${subId}`)],
  ],
});

export const commentKeyboard = (subId) => ({
  inline_keyboard: [[btn("💬 Добавить комментарий", `cm:${subId}`)]],
});

export const requestKeyboard = (reqId) => ({
  inline_keyboard: [[btn("✍️ Ответить", `ans:${reqId}`)]],
});

export const photoFixKeyboard = (fixId) => ({
  // style: "danger" — яркая красная кнопка (Bot API 9.4+); старые клиенты покажут обычную
  inline_keyboard: [[{ ...btn("📸 Отправить фото исправление", `fix:${fixId}`), style: "danger" }]],
});

export const returnKeyboard = (fixId) => ({
  inline_keyboard: [[{ ...btn("↩️ Вернуть в работу", `ret:${fixId}`), style: "primary" }]],
});
