// Вспомогательные функции: HTML, имена, даты, разбор команд.

export function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function fullName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || user.username || String(user.id);
}

export function mention(userId, name) {
  return `<a href="tg://user?id=${userId}">${esc(name)}</a>`;
}

// ID темы (0 — общая тема или группа без тем)
export function threadOf(msg) {
  return msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : 0;
}

export function nowIso() {
  return new Date().toISOString().slice(0, 19) + "Z";
}

// Смещение часового пояса (мс) в момент utcMs
function tzOffset(utcMs, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

// Местное время в поясе tz -> Date (UTC)
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - tzOffset(guess, tz);
  ts = guess - tzOffset(ts, tz); // поправка на переход времени
  return new Date(ts);
}

// Местная дата/время в поясе tz
export function localParts(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, year: +p.year };
}

// «30.10.2026 18:00», «30.10.2026», «30.10 18:00», «30.10» -> ISO UTC или null
export function parseDeadline(text, tz) {
  const m = text.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m;
  const year = y ? +y : localParts(new Date(), tz).year;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  const date = zonedToUtc(year, +mo, +d, h ? +h : 23, h ? +mi : 59, tz);
  return date.toISOString().slice(0, 19) + "Z";
}

export function fmtDt(iso, tz) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso)).replace(",", "");
}

// Делит аргументы команды по символу «|»
export function splitArgs(text, parts) {
  const items = (text || "").split("|");
  const head = items.slice(0, parts - 1);
  const tail = items.slice(parts - 1).join("|");
  const res = [...head, tail].map((s) => s.trim());
  while (res.length < parts) res.push("");
  return res;
}

export function containsKeyword(text, keyword) {
  const k = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${k}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

// Ссылка на тему «https://t.me/c/3716710626/87» -> { chatId: -1003716710626, threadId: 87 }
export function parseTopicLink(link) {
  const m = String(link || "").match(/t\.me\/c\/(\d+)\/(\d+)/);
  return m ? { chatId: Number(`-100${m[1]}`), threadId: Number(m[2]) } : null;
}

// "/task@my_bot аргументы" -> { cmd: "task", args: "аргументы" }
export function parseCommand(msg, botUsername) {
  const text = msg.text || "";
  const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { cmd: m[1].toLowerCase(), args: (m[3] || "").trim() };
}
