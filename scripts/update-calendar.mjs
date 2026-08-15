import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const jsonPath = resolve(projectRoot, "data/calendar.json");
const scriptPath = resolve(projectRoot, "data/calendar-data.js");
const calendarificKey = process.env.CALENDARIFIC_API_KEY?.trim() ?? "";

const previousCalendar = await readPreviousCalendar();
const currentYear = Number(
  new Intl.DateTimeFormat("en", { timeZone: "Europe/Moscow", year: "numeric" }).format(new Date()),
);
const requestedYears = [currentYear, currentYear + 1];
const calendar = {
  generatedAt: new Date().toISOString(),
  years: [],
  sources: {
    federal: "https://www.isdayoff.ru/",
    regional: "https://calendarific.com/",
  },
  days: {},
};

for (const year of requestedYears) {
  try {
    const dayTypes = await fetchFederalDayTypes(year);
    addFederalYear(calendar.days, year, dayTypes);
  } catch (error) {
    if (year === currentYear) throw error;
    console.warn(`Календарь на ${year} год пока недоступен: ${error.message}`);
    continue;
  }

  let holidays = getFixedRegionalHolidays(year);

  if (calendarificKey) {
    try {
      const fetchedHolidays = await fetchTatarstanHolidays(year);
      holidays = mergeRegionalHolidays(holidays, fetchedHolidays);
    } catch (error) {
      console.warn(`Региональные праздники на ${year} год не обновлены: ${error.message}`);
    }
  }

  addRegionalHolidays(calendar.days, holidays);
  preserveRegionalHolidays(calendar.days, previousCalendar.days ?? {}, year, holidays);
  calendar.years.push(year);
}

if (!calendar.years.length) {
  throw new Error("Не удалось получить календарь ни на один год.");
}

const json = `${JSON.stringify(calendar, null, 2)}\n`;
const browserScript = `window.SNT_CALENDAR = ${JSON.stringify(calendar, null, 2)};\n`;
await writeFile(jsonPath, json, "utf8");
await writeFile(scriptPath, browserScript, "utf8");
console.log(`Обновлены ${calendar.years.join(", ")}: ${Object.keys(calendar.days).length} календарных дней.`);

if (!calendarificKey) {
  console.log("CALENDARIFIC_API_KEY не задан: использованы федеральный календарь, фиксированные праздники Татарстана и сохранённые региональные даты.");
}

async function readPreviousCalendar() {
  try {
    return JSON.parse(await readFile(jsonPath, "utf8"));
  } catch {
    return { days: {} };
  }
}

async function fetchFederalDayTypes(year) {
  const url = new URL("https://isdayoff.ru/api/getdata");
  url.searchParams.set("year", String(year));
  url.searchParams.set("cc", "ru");
  const response = await fetch(url, { headers: { accept: "text/plain" } });

  if (!response.ok) {
    throw new Error(`isDayOff ответил ${response.status} для ${year} года`);
  }

  const value = (await response.text()).trim();
  const expectedLength = isLeapYear(year) ? 366 : 365;
  if (value.length !== expectedLength || !/^[012]+$/.test(value)) {
    throw new Error(`isDayOff вернул неожиданные данные для ${year} года`);
  }

  return value;
}

async function fetchTatarstanHolidays(year) {
  const url = new URL("https://calendarific.com/api/v2/holidays");
  url.searchParams.set("api_key", calendarificKey);
  url.searchParams.set("country", "RU");
  url.searchParams.set("year", String(year));
  url.searchParams.set("location", "ru-ta");
  url.searchParams.set("type", "national,local,religious");
  const response = await fetch(url, { headers: { accept: "application/json" } });

  if (!response.ok) {
    throw new Error(`Calendarific ответил ${response.status} для ${year} года`);
  }

  const payload = await response.json();
  if (payload?.meta?.code !== 200 || !Array.isArray(payload?.response?.holidays)) {
    throw new Error(`Calendarific вернул неожиданные данные для ${year} года`);
  }

  return payload.response.holidays
    .filter(isNonWorkingHoliday)
    .map((holiday) => normalizeHoliday(holiday))
    .filter(Boolean);
}

function addFederalYear(target, year, dayTypes) {
  const firstDay = Date.UTC(year, 0, 1);
  for (let index = 0; index < dayTypes.length; index += 1) {
    const date = new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10);
    target[date] = {
      isWorking: dayTypes[index] !== "1",
      isShortened: dayTypes[index] === "2",
      holiday: null,
    };
  }
}

function addRegionalHolidays(target, holidays) {
  for (const holiday of holidays) {
    target[holiday.date] = {
      ...(target[holiday.date] ?? {}),
      isWorking: false,
      holiday: {
        nameRu: holiday.nameRu,
        nameTt: holiday.nameTt,
      },
    };
  }
}

function getFixedRegionalHolidays(year) {
  return [
    {
      date: `${year}-08-30`,
      nameRu: "День Республики Татарстан",
      nameTt: "Татарстан Республикасы көне",
    },
    {
      date: `${year}-11-06`,
      nameRu: "День Конституции Республики Татарстан",
      nameTt: "Татарстан Республикасы Конституциясе көне",
    },
  ];
}

function mergeRegionalHolidays(...holidayGroups) {
  const byDate = new Map();

  for (const holiday of holidayGroups.flat()) {
    byDate.set(holiday.date, holiday);
  }

  return [...byDate.values()];
}

function preserveRegionalHolidays(target, previousDays, year, fetchedHolidays) {
  const fetchedDates = new Set(fetchedHolidays.map(({ date }) => date));
  for (const [date, value] of Object.entries(previousDays)) {
    if (!date.startsWith(`${year}-`) || !value?.holiday || fetchedDates.has(date)) continue;
    target[date] = { ...(target[date] ?? {}), isWorking: false, holiday: value.holiday };
  }
}

function isNonWorkingHoliday(holiday) {
  const types = (holiday.type ?? []).join(" ").toLowerCase();
  const name = `${holiday.name ?? ""} ${holiday.description ?? ""}`.toLowerCase();
  return /national|local|state/.test(types) || /eid al-fitr|eid al-adha|uraza|kurban|ураз|курбан/.test(name);
}

function normalizeHoliday(holiday) {
  const date = holiday?.date?.iso?.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return null;
  const englishName = holiday.name?.trim() || "Holiday";
  const names = getLocalizedNames(date, englishName);
  return { date, ...names };
}

function getLocalizedNames(date, englishName) {
  if (date.endsWith("-08-30")) {
    return { nameRu: "День Республики Татарстан", nameTt: "Татарстан Республикасы көне" };
  }
  if (date.endsWith("-11-06")) {
    return { nameRu: "День Конституции Республики Татарстан", nameTt: "Татарстан Республикасы Конституциясе көне" };
  }
  if (/fitr|uraza|ураз/i.test(englishName)) {
    return { nameRu: "Ураза-байрам", nameTt: "Ураза бәйрәме" };
  }
  if (/adha|kurban|курбан/i.test(englishName)) {
    return { nameRu: "Курбан-байрам", nameTt: "Корбан бәйрәме" };
  }
  return { nameRu: englishName, nameTt: englishName };
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
