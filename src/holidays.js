// 中国法定节假日 / 调休表（本地静态，不联网）。
//
// 用途：给唤醒 prompt 提供「今天是什么日子」——节日问候、假期第几天、调休上班，
// 避免模型对日期一无所知，也避免它上网查（还查不准）。
//
// 数据来源：国务院办公厅年度放假安排通知（2026 年：国办发明电〔2025〕7 号）。
// 每年新通知出来时往上加一段即可，过期年份保留不影响（按年查表）。
// 注意：这里只放「全国统一的法定节假日安排」，不放节气/农历（农历节日已折算成公历日期）。

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const SCHEDULES = {
  2026: [
    { from: '01-01', to: '01-03', name: '元旦' },
    { from: '02-15', to: '02-23', name: '春节', label: '正月初一 02-17' },
    { from: '04-04', to: '04-06', name: '清明节' },
    { from: '05-01', to: '05-05', name: '劳动节' },
    { from: '06-19', to: '06-21', name: '端午节' },
    { from: '09-25', to: '09-27', name: '中秋节' },
    { from: '10-01', to: '10-07', name: '国庆节' }
  ],
  2027: [
    { from: '01-01', to: '01-03', name: '元旦' },
    { from: '02-06', to: '02-12', name: '春节', label: '正月初一 02-06' },
    { from: '04-03', to: '04-05', name: '清明节' },
    { from: '05-01', to: '05-05', name: '劳动节' }
  ]
};

// 调休上班日（周末补班）。目前只登记已确认的年份。
const MAKEUP_WORKDAYS = {
  2026: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10'],
  2027: []
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function monthDay(date = new Date()) {
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${monthDay(date)}`;
}

function dayDiff(a, b) {
  const da = new Date(`${a}T00:00:00`);
  const db = new Date(`${b}T00:00:00`);
  return Math.round((da - db) / 86400000);
}

/** 当天落在哪个假期里（含第几天），没有则返回 null。 */
export function holidayFor(date = new Date()) {
  const y = date.getFullYear();
  const md = monthDay(date);
  const list = SCHEDULES[y] || [];
  for (const item of list) {
    if (md >= item.from && md <= item.to) {
      const dayIndex = dayDiff(md, item.from) + 1;
      const totalDays = dayDiff(item.to, item.from) + 1;
      return { name: item.name, dayIndex, totalDays, label: item.label || '', from: item.from, to: item.to };
    }
  }
  return null;
}

export function isMakeupWorkday(date = new Date()) {
  const y = date.getFullYear();
  const list = MAKEUP_WORKDAYS[y];
  if (!Array.isArray(list)) return false;
  return list.includes(monthDay(date));
}

/** 距离下一个假期的天数（今天就在假期里则返回 0 和当前假期）。 */
export function nextHoliday(date = new Date()) {
  const y = date.getFullYear();
  const current = holidayFor(date);
  if (current) return { ...current, inDays: 0 };
  const candidates = [];
  for (const yy of [y, y + 1, y + 2]) {
    for (const item of SCHEDULES[yy] || []) {
      const d = dayDiff(`${yy}-${item.from}`, dayKey(date));
      if (d > 0) candidates.push({ ...item, year: yy, inDays: d });
    }
  }
  candidates.sort((a, b) => a.inDays - b.inDays);
  return candidates[0] || null;
}

/**
 * 一行中文日期说明，直接塞进 prompt。
 * 例：「今天是 2026年10月19日 星期一；下次放假：元旦（2027-01-01，还有 74 天）」
 */
export function describeDay(date = new Date(), opts = {}) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const weekday = WEEKDAYS[date.getDay()];
  const parts = [`今天是 ${y}年${m}月${d}日 ${weekday}`];
  const hit = holidayFor(date);
  if (hit) {
    const label = hit.label ? `（${hit.label}）` : '';
    parts.push(hit.totalDays > 1 ? `${hit.name}假期第 ${hit.dayIndex} 天（共 ${hit.totalDays} 天）` : `${hit.name}${label}`);
  } else if (opts.withNext !== false) {
    const next = nextHoliday(date);
    if (next) {
      const tip = next.inDays <= (Number(opts.windowDays) || 30)
        ? `下次放假：${next.name}（${next.year}-${next.from}，还有 ${next.inDays} 天）`
        : '';
      if (tip) parts.push(tip);
    }
  }
  if (isMakeupWorkday(date)) parts.push('今天调休上班（周末补班）');
  return parts.join('；');
}
