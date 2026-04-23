// ==UserScript==
// @name         GPV parser исправление под новую весртку сайта
// @namespace    GPV parser
// @version      1.2
// @description  Парсинг графіка ГПВ
// @match        https://www.zoe.com.ua/outage/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(async () => {

  /* =========================================================
   * КЛЮЧИ ДЛЯ НАСТРОЕК (localStorage)
   * ======================================================= */

  const STORAGE_FILTER_12     = "gpv_show_only_1_2";
  const STORAGE_FONT_HEADER   = "gpv_font_header";
  const STORAGE_FONT_ROW      = "gpv_font_row";
  const STORAGE_SHOW_ALL      = "gpv_show_all";
  const STORAGE_FONT_SUMMARY  = "gpv_font_summary";

  /* =========================================================
   * РЕЖИМ #gpv — чтобы не ломать обычный сайт
   * ======================================================= */
  if (!location.hash.includes("gpv")) {
    location.replace(location.pathname + location.search + "#gpv");
    return;
  }

  /* =========================================================
   * ВРЕМЕННЫЙ ЭКРАН ЗАГРУЗКИ
   * ======================================================= */

  document.open();
  document.write(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><title>ГПВ</title><style>
        body { background:#fff; margin:0; font-family:Arial,sans-serif; }
        .loading { display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; gap:12px; }
        .spinner { width:48px; height:48px; border:6px solid #e0e0e0; border-top:6px solid #d00000; border-radius:50%; animation:spin 1s linear infinite; }
        @keyframes spin {
          from { transform:rotate(0deg); }
          to   { transform:rotate(360deg); }
        } </style></head><body>
      <div class="loading"> <div class="spinner"></div><div>Завантаження</div></div></body></html>`); document.close();

  /* =========================================================
   * ГЛОБАЛЬНЫЕ КОНСТАНТЫ, РЕГУЛЯРКИ, ДАТЫ
   * ======================================================= */

  // Нормализация строки: NBSP → пробел, длинные тире → '-', схлопываем пробелы
  const norm = s =>
    (s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[–—]/g, "-")
      .replace(/\Черга|Черги/gi, "") // для новой верситки сайта
      .replace(/\s+/g, " ")
      .trim();

  // Строка с очередями вида "1.1: ..." или "2.1, 2.2 - ..."
  const rowRe = /^([1-6]\.[12])(\s*,\s*[1-6]\.[12])*\s*[:\-]?\s*/;

  const MONTHS_RE = /(СІЧНЯ|ЛЮТОГО|БЕРЕЗНЯ|КВІТНЯ|ТРАВНЯ|ЧЕРВНЯ|ЛИПНЯ|СЕРПНЯ|ВЕРЕСНЯ|ЖОВТНЯ|ЛИСТОПАДА|ГРУДНЯ)/i;

    // Карта месяцев для даты (по заголовкам в ВЕРХНЕМ регистре)
  const MONTH_INDEX = {"СІЧНЯ": 0,"ЛЮТОГО": 1,"БЕРЕЗНЯ": 2,"КВІТНЯ": 3,"ТРАВНЯ": 4,"ЧЕРВНЯ": 5,"ЛИПНЯ": 6,"СЕРПНЯ": 7,"ВЕРЕСНЯ": 8,"ЖОВТНЯ": 9,"ЛИСТОПАДА": 10,"ГРУДНЯ": 11};

  // Месяцы маленькими буквами
  const MONTH_NAMES_GENITIVE = [
    "січня", "лютого", "березня", "квітня",
    "травня", "червня", "липня", "серпня",
    "вересня", "жовтня", "листопада", "грудня"
  ];

  // Слова, по которым отбрасываем заголовки
  const stopWords = [
    "за вказівкою","відповідно","нек","укренерго",
    "з метою","будуть","застосован",
    "відсутності","електропостачання","години","зв’язку"
  ];

  // Регулярка для "оновлено о 13:45"
  const UPDATED_RE = /\(оновлено\s*(?:о|об)?\s*(\d\d[:\-]\d\d)\)/i;

  // Регулярка для разбора интервала на числа
  const STRICT_INTERVAL_RE = /(\d{1,2})[:;-](\d{1,2})\s*[–—-]\s*(\d{1,2})[:;-](\d{1,2})/;
  //const TIME_INTERVAL_STRICT_RE = /(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)/;

  // Специальные фразы "не вимикається / не вимикаються"
  const NO_POWER_SINGLE = "не вимикається";
  const NO_POWER_PLURAL = "не вимикаються";

  // Текущие даты для всего скрипта (кешируем)
  const TODAY = new Date();
  TODAY.setHours(0, 0, 0, 0);

  const TOMORROW = new Date(TODAY);
  TOMORROW.setDate(TODAY.getDate() + 1);

  // "Сейчас" для подсветки прошедших интервалов
  const NOW = new Date();

  // Год, по которому строим даты графиков
  const CURRENT_YEAR = TODAY.getFullYear();

  // Хранилище очереди пользователя
  const STORAGE_MY_QUEUE = "gpv_myqueue_selected";

  // Полный список очередей 1.1 → 6.2
  const USER_QUEUES = ["1.1","1.2","2.1","2.2","3.1","3.2","4.1","4.2","5.1","5.2","6.1","6.2"];

  /* =========================================================
   * ФУНКЦИИ
   * ======================================================= */

  /**
   * renderIntervalBlocks(intervals, blockDate)
   *  - рисует "карточки" интервалов для одной очереди
   *  - подсвечивает прошедшие интервалы на сегодня
   *  - старые даты (blockDate < TODAY) полностью серые
   *  - isBroken = true parseRow() не распарсила интервалы, значит в интервале ошибка
   */
  function renderIntervalBlocks(intervals, blockDate, isBroken) {
    // График полностью прошлый?
    const isPastGraph = blockDate && blockDate < TODAY;
    const joined = intervals.join(" ").toLowerCase();

    // Спец-случаи без интервалов
    if (joined.includes(NO_POWER_SINGLE)) {
      return `
        <div class="gpv-interval-row">
          <div class="gpv-interval-block ${isPastGraph ? "gpv-interval-past" : ""}">${NO_POWER_SINGLE}</div>
        </div>
      `;
    }
    if (joined.includes(NO_POWER_PLURAL)) {
      return `
        <div class="gpv-interval-row">
          <div class="gpv-interval-block ${isPastGraph ? "gpv-interval-past" : ""}">${NO_POWER_PLURAL}</div>
        </div>
      `;
    }

    if (intervals.length === 0) {
      return `
        <div class="gpv-interval-row">
          <div class="gpv-interval-block ${isPastGraph ? "gpv-interval-past" : ""}">не знайдено</div>
        </div>
      `;
    }

    let html = '<div class="gpv-interval-row">';

    for (let iv of intervals) {

      // Старый график → все интервалы серые
      if (isPastGraph) {
        html += `<div class="gpv-interval-block gpv-interval-past">${iv}</div>`;
        continue;
      }

      // График на завтра → все интервалы "будущие", без серого
      if (blockDate && blockDate > TODAY) {
        html += `<div class="gpv-interval-block">${iv}</div>`;
        continue;
      }

      // Обычная логика на сегодня
      const m = iv.match(STRICT_INTERVAL_RE); // регулярка интервалов времени
      if (!m || isBroken) {
        // Неполные/кривые интервалы: просто показываем как есть, без подсветки прошедшего
        html += `<div class="gpv-interval-block">${iv}</div>`;
        continue;
      }

      const sh = +m[1], sm = +m[2];
      const eh = +m[3], em = +m[4];

      const start = new Date(TODAY);
      start.setHours(sh, sm, 0, 0);

      const end = new Date(TODAY);
      end.setHours(eh, em, 0, 0);

      let status = "";
      if (NOW > end) status = "gpv-interval-past";

      html += `<div class="gpv-interval-block ${status}">${iv}</div>`;
    }

    html += "</div>";
    return html;
  }


/*
   * Парсинг заголовка (даты и времени обновления) из строки h2
   */
  function parseHeader(line) {
    let headerRaw = line;
    let headerClean = line;
    let date = null;

    // Ищем дату в строке h2
    const upper = line.toUpperCase();
    const dm = upper.match(/([0-3]?\d)\s+(СІЧНЯ|ЛЮТОГО|БЕРЕЗНЯ|КВІТНЯ|ТРАВНЯ|ЧЕРВНЯ|ЛИПНЯ|СЕРПНЯ|ВЕРЕСНЯ|ЖОВТНЯ|ЛИСТОПАДА|ГРУДНЯ)/);

    let day = null;
    let monthIndex = null;

    if (dm) {
      day = parseInt(dm[1], 10);
      const monthName = dm[2];

      if (!isNaN(day) && day >= 1 && day <= 31 && monthName in MONTH_INDEX) {
        monthIndex = MONTH_INDEX[monthName];

        let year = CURRENT_YEAR;
        if (TODAY.getMonth() === 11 && monthIndex === 0) year = CURRENT_YEAR + 1;

        const d = new Date(year, monthIndex, day);
        d.setHours(0, 0, 0, 0);
        date = d;
      }
    }

    // Вытаскиваем "(оновлено ...)"
    let updatedPart = "";
    const updMatch = line.match(/\((?:оновлено\s*(?:о|об)?\s*)?([0-2]?\d[:\-][0-5]\d)\)/i);
    if (updMatch) {
      updatedPart = `(${updMatch[1].replace("-", ":")})`;
    }

    // Собираем красивый заголовок
    if (date) {
      const prettyDay = day;
      const prettyMonth = MONTH_NAMES_GENITIVE[monthIndex];
      headerClean = updatedPart ? `${prettyDay} ${prettyMonth} ${updatedPart}` : `${prettyDay} ${prettyMonth}`;
    } else if (updatedPart) {
      headerClean = updatedPart;
    } else {
      headerClean = headerRaw;
    }

    return { headerRaw, headerClean, date };
  }

  // парсинг строк
  function parseRow(text) {
    let line = text;    // рабочая копия
    let isBroken = false;
    let totalMinutes = null;

    // === Вытягиваем очереди ===
    const queues = line.match(/[1-6]\.[12]/g) || [];

    // === Удаляем очереди для проверки текста на полноту парсинга ===
    // Убираем "1.1:", "2.2:" и подобные
    line = line.replace(/^([1-6]\.[12])(\s*,\s*[1-6]\.[12])*\s*[:\-]?\s*/, "");

    // для новой верситки сайта
    line = line.replace(/\з/gi, "").replace(/\до/gi, "-");

    const raw = line; // убраны очередя, строка с интервалами как есть

    // === Проверка на "не вимикається" ===
    const lowered = line.toLowerCase();
    if (lowered.includes("не вимикається") || lowered.includes("не вимикаються")) {
      return {
        raw,
        queues,
        intervals: [ lowered.includes("не вимикається") ? "не вимикається" : "не вимикаються" ],
        totalTime: "0 год. без світла",
        totalMinutes,
        isBroken: true
      };
    }

    if (lowered.length === 0) {
      return {
        raw,
        queues,
        intervals: [], // в renderIntervalBlocks обработаеттся
        totalTime: "0 год. без світла",
        totalMinutes,
        isBroken: true
      };
    }

    // === ШИРОКАЯ регулярка для поиска всех интервалов времени ===
    const FIND_INTERVAL_RE = /\d{1,2}[:;-]\d{1,2}\s*[–—-]\s*\d{1,2}[:;-]\d{1,2}/g;
    const found = line.match(FIND_INTERVAL_RE) || [];

    // === 5. Проверка: нашли ли ВСЕ интервалы (missingIntervals) ===
    let checkString = line;

    // удаляем найденные интервалы из строки
    for (const iv of found) {
      checkString = checkString.replace(iv, "");
    }

    // убираем разделители, которые допустимы между интервалами
    checkString = checkString
      .replace(/[ ,.;:–—\-]/g, "")  // пробелы, запятые, точки, двоеточия, тире
      .trim();

    if (checkString.length !== 0) {
      isBroken = true; // остались буквы/символы, выводим строку как есть + !
    }

    // === Если строка подозрительная — возвращаем специальный объект ===
    if (isBroken) {
      return {
        raw,
        queues,
        intervals: [ raw + "<span style=color:red;> !</span>" ],
        intervalKey: "!BROKEN", // если интервалы кривые
        totalTime: "0 год. без світла",
        totalMinutes,
        isBroken: true // если строка кривая
      };
    }


    // === считаем время по строгой регулярке ===
    for (const iv of found) {
      const m = iv.match(STRICT_INTERVAL_RE); // регулярка интервалов времени
      if (!m) continue;

      let sh = +m[1], sm = +m[2];
      let eh = +m[3], em = +m[4];

      // диапазоны времени: проверяем корректность
      if (sh < 0 || sh > 24) continue;
      if (eh < 0 || eh > 24) continue;
      if (sm < 0 || sm > 59) continue;
      if (em < 0 || em > 59) continue;

      const start = sh * 60 + sm;
      const end   = eh * 60 + em;

      if (end >= start) {
        totalMinutes += (end - start);
      }
    }

    // === Формируем строку totalTime ===
    let totalTime = "0 год. без світла";
    if (totalMinutes > 0) {
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      if (m === 0) {
        totalTime = `${h} год. без світла`;
      } else {
        const mm = m < 10 ? "0" + m : m;
        totalTime = `${h}:${mm} год. без світла`;
      }
    }

    // intervalKey — НОРМАЛИЗОВАННАЯ СТРУКТУРА ИНТЕРВАЛОВ
    // Используется ТОЛЬКО для сравнения версий графика.
    // UI его НЕ использует.
    // Важно: intervalKey может измениться даже если totalMinutes остался тем же.
    const intervalKey = found
      .map(iv =>
        iv
          .replace(/[–—]/g, "-")
          .replace(/\s+/g, "")
      )
      .join("|");


    // === Возвращаем объект ===
    return {
      raw,
      queues,
      intervals: found,
      intervalKey,
      totalTime,
      totalMinutes,
      isBroken: false
    };
}

  /* =========================================================
   * 6. ЗАГРУЗКА И ПРЕОБРАЗОВАНИЕ HTML С САЙТА
   * ======================================================= */
  const res = await fetch(location.href.replace("#gpv", ""), { credentials: "include" });
  const htmlText = await res.text();
  const tmp = document.createElement("div");
  tmp.innerHTML = htmlText;

  /* =========================================================
   * 7. ПАРСИНГ БЛОКОВ (ГРАФИКИ ПО ДНЯМ) - НОВАЯ ВЕРСТКА
   * ======================================================= */
  const blocks = [];
  const articles = tmp.querySelectorAll("article"); // Берем все блоки графиков

  for (const article of articles) {
    const h2 = article.querySelector("h2");
    const contentDiv = article.querySelector(".content");

    if (!h2 || !contentDiv) continue; // Если структура другая, пропускаем

    // 1. Обрабатываем заголовок
    let headerRaw, headerClean, date;

    const h2RawText = h2.innerText.trim();

    if (!contentDiv || (!contentDiv.textContent.trim() && contentDiv.children.length === 0)) { // если div content пустой, заголовок оставляем как есть не только дату
      headerRaw = h2RawText;
      headerClean = h2RawText;

      // но дату всё равно пытаемся вытащить
      const parsed = parseHeader(h2RawText);
      date = parsed.date;

    } else {
      // обычная логика, оставляем в заголовке только дату
      const h2Text = norm(h2.innerText);
      ({ headerRaw, headerClean, date } = parseHeader(h2Text));
    }

    // === ДОБАВЛЕНО: Если в h2 нет даты, ищем её внутри <div class="content"> ===
    if (!date) {
      const contentTextUpper = norm(contentDiv.innerText).toUpperCase();
      const dm = contentTextUpper.match(/([0-3]?\d)\s+(СІЧНЯ|ЛЮТОГО|БЕРЕЗНЯ|КВІТНЯ|ТРАВНЯ|ЧЕРВНЯ|ЛИПНЯ|СЕРПНЯ|ВЕРЕСНЯ|ЖОВТНЯ|ЛИСТОПАДА|ГРУДНЯ)/);

      if (dm) {
        const day = parseInt(dm[1], 10);
        const monthName = dm[2];

        if (!isNaN(day) && day >= 1 && day <= 31 && monthName in MONTH_INDEX) {
          const monthIndex = MONTH_INDEX[monthName];
          let year = CURRENT_YEAR;

          // Учитываем переход на новый год (если сейчас декабрь, а график на январь)
          if (TODAY.getMonth() === 11 && monthIndex === 0) year = CURRENT_YEAR + 1;

          const d = new Date(year, monthIndex, day);
          d.setHours(0, 0, 0, 0);
          date = d; // Перезаписываем null на найденную дату

          // Дописываем найденную дату в начало заголовка, чтобы это красиво выглядело в UI
          const prettyMonth = MONTH_NAMES_GENITIVE[monthIndex];
          headerClean = `${day} ${prettyMonth} ${headerClean}`;
        }
      }
    }

    // 2. Обрабатываем контент внутри
    const contentLines = contentDiv.innerText.split("\n").map(norm).filter(Boolean);
    const rows = [];
    let hasQueues = false;
    const textMessages = [];

    // 3. Перебираем строки в поисках расписания
    for (const line of contentLines) {
      if (rowRe.test(line)) {
        // Нашли строку с очередью (например "1.1: 18:30 - 22:30")
        rows.push(parseRow(line)); // Ваша функция парсинга остается без изменений!
        hasQueues = true;
      } else if (line.length > 10) {
        // Собираем длинные текстовые строки на случай, если расписания нет
        textMessages.push(line);
      }
    }

    // 4. Логика для блоков без очередей ("ГПВ скасовано")
    if (!hasQueues && textMessages.length > 0) {
      const msg = textMessages.join(" ");
      rows.push({
        raw: msg,
        queues: USER_QUEUES, // Привязываем ко всем очередям сразу
        intervals: [msg],
        intervalKey: "MESSAGE",
        totalTime: "0 год.",
        totalMinutes: 0,
        isBroken: true // isBroken: true выведет текст в красивом желтом блоке
      });
    } else if (hasQueues) {
      // 5. Если очереди есть, проверяем, каких не хватает (ваша старая логика)
      USER_QUEUES.forEach(q => {
        if (!rows.some(r => r.queues.includes(q))) {
          rows.push({
            raw: `${q}: не знайдено графік для черги`,
            queues: [q],
            intervals: ["не знайдено графік для черги"],
            intervalKey: "NOT_FOUND",
            totalTime: "0 год.",
            totalMinutes: 0,
            isBroken: true
          });
        }
      });
    }

    // Сортировка очередей по порядку
    rows.sort((a, b) => parseFloat(a.queues[0] || 0) - parseFloat(b.queues[0] || 0));

    // Добавляем готовый блок
    blocks.push({
      headerRaw,
      headerClean,
      date,
      rows
    });
  }


  /* =========================================================
 * ГРУППИРУЕМ ВСЕ БЛОКИ В НОВУЮ АРХИТЕКТУРУ block.moreVersions
 * Собирает все блоки с одинаковой датой в один объект.
 * Теперь всё строится поверх groupedByDate.
 * ======================================================= */

  function buildGroupedByDate(blocks) {
    const grouped = {};

    for (const b of blocks) {
      if (!b.date) continue;

      const key = b.date.toISOString().slice(0, 10);

      if (!grouped[key]) {
        grouped[key] = {
          date: b.date,
          versions: [],
          expanded: false,
          perQueueVersions: {}   // NEW!!!
        };
      }

      // === собираем totalsByQueue ===
      // totalsByQueue      — минуты отключений (для diff)
      // intervalKeyByQueue — структура интервалов по очередям (для значимости версии)
      // brokenByQueue      — кривая ли строка по очередям
      const totalsByQueue = {};
      const intervalKeyByQueue = {};
      const brokenByQueue = {};

      for (const r of b.rows) {
        for (const q of r.queues) {
          if (!totalsByQueue[q]) totalsByQueue[q] = 0;
          totalsByQueue[q] += r.totalMinutes;

          intervalKeyByQueue[q] = r.intervalKey;
          brokenByQueue[q] = r.isBroken;
        }
      }

      grouped[key].versions.push({
        headerClean: b.headerClean,
        rows: b.rows,
        totalsByQueue,
        intervalKeyByQueue,
        brokenByQueue
      });
    }

    // ======================================================
    // AFTER versions assembled → compute perQueueVersions
    // ======================================================
    for (const key in grouped) {
      const group = grouped[key];
      const versions = group.versions;

      // ОПРЕДЕЛЕНИЕ ЗНАЧИМОСТИ ВЕРСИИ
      //
      // Версия считается ЗНАЧИМОЙ, если:
      // 1) изменилась структура интервалов (intervalKey)
      // 2) строка кривая (isBroken === true)
      // 3) произошёл переход кривая ↔ нормальная
      //
      // totalMinutes ЗДЕСЬ НЕ ИСПОЛЬЗУЕТСЯ!
      // Он нужен ТОЛЬКО для diff в UI.

      // Для всех 1.1 → 6.2
      for (const queue of USER_QUEUES) {
        let arr = [];

        let last = undefined;

        // бежим с конца → к началу
        for (let i = versions.length - 1; i >= 0; i--) {
          const v = versions[i];

          // если очереди нет в версии (так бывает редко)
          if (v.totalsByQueue[queue] === undefined) continue;

          const curKey = v.intervalKeyByQueue[queue];
          const curBroken = v.brokenByQueue[queue];

          if (
            last === undefined ||
            curBroken === true ||
            curKey !== last.intervalKey ||
            curBroken !== last.broken
          ) {
            arr.push(v);
            last = {
              intervalKey: curKey,
              broken: curBroken
            };
          }

        }

        arr.reverse();

        // если изменений не было → оставляем только самую старую
        if (arr.length === 0 && versions.length > 0) {
          arr = [ versions[versions.length - 1] ];
        }

        group.perQueueVersions[queue] = arr;
      }
    }

    return grouped;
  }


    /**
   * если среди всех blocks есть block.date === null,
   * и такой блок идёт в графиках НЕ раньше чем TODAY - 2 дня.
   *
   * Если такие null-даты существуют, показываем все
   */
  function hasCriticalNullDates(blocks) {
    const cutoff = new Date(TODAY);
    cutoff.setDate(TODAY.getDate() - 2);
    cutoff.setHours(0, 0, 0, 0);
    //console.log("cutoff =", cutoff)
    for (const b of blocks) {
      if (b.date === null) {
        // если не нашли дату И этот блок НЕ старее позавчера
        return true;
      }
      if (b.date < cutoff) {
        // ниже cutoff дальше можно не проверять
        return false;
      }
    }
    return false;
  }

  //console.log(hasCriticalNullDates(blocks))

  const groupedByDate = buildGroupedByDate(blocks);
  //console.log("groupedByDate =", groupedByDate);

    /* =========================================================
   * ВЫБИРАЕМ ГРУППЫ НА СЕГОДНЯ И НА ЗАВТРА
   *
   * Старая логика blocksToday/blocksTomorrow удалена.
   * Теперь просто ищем ключи в groupedByDate.
   *
   * Если нужно показать все — покажем все версии.
   * Если нет — показываем только последнюю версию
   * (versions[0]) для каждой даты.
   * ======================================================= */

  const TODAY_KEY = TODAY.toISOString().slice(0, 10);
  const TOMORROW_KEY = TOMORROW.toISOString().slice(0, 10);

  const todayGroup = groupedByDate[TODAY_KEY] || null;
  const tomorrowGroup = groupedByDate[TOMORROW_KEY] || null;

  //console.log("todayGroup =", todayGroup);
  //console.log("tomorrowGroup =", tomorrowGroup);

  function formatVersionDiff(versionsShown, allVersions, index, queue) {
    const curV = versionsShown[index];
    const cur = curV.totalsByQueue[queue];
    if (cur == null) return "";

    let prevV = null;

    if (versionsShown.length === 1) {
      if (allVersions.length > 1) prevV = allVersions[1];
    } else {
      if (index + 1 < versionsShown.length) prevV = versionsShown[index + 1];
    }

    if (!prevV) return "";

    const prev = prevV.totalsByQueue[queue];
    if (prev == null) return "";

    const diff = cur - prev;
    const curKey = curV.intervalKeyByQueue?.[queue];
    const prevKey = prevV.intervalKeyByQueue?.[queue];

    // Якщо час не змінився (наприклад, було 0 годин і стало 0 годин)
    if (diff === 0) {
      const curBroken  = curV.brokenByQueue?.[queue];
      const prevBroken = prevV.brokenByQueue?.[queue];

      // Якщо змінилася структура рядка (був графік, став текст і т.д.)
      if (curKey !== prevKey || curBroken !== prevBroken) {
        // Ховаємо сіре (0:00) тільки для текстових блоків та відсутніх черг
        if (curKey === "MESSAGE" || curKey === "NOT_FOUND" || prevKey === "NOT_FOUND") {
          return "";
        }
        return ` <span style="color:#777; font-weight:600;">(0:00)</span>`;
      }
      return "";
    }

    // Якщо різниця Є (було 3 години, графік скасували = стало 0) — показуємо!
    const sign = diff > 0 ? "+" : "−";
    const color = diff > 0 ? "#d00000" : "#007431";

    const d = Math.abs(diff);
    const h = Math.floor(d / 60);
    const m = d % 60;
    const fm = `${h}:${m < 10 ? "0" + m : m}`;

    return ` <span style="color:${color}; font-weight:700;">(${sign}${fm})</span>`;
  }





  /* =========================================================
   * 9. CSS + ВЕРХНЯЯ ПАНЕЛЬ
   * ======================================================= */

  const style = `
    <style>
.body {
  margin:0;
  background:#f3f3f3;
  font-family:Arial, sans-serif;
}

/* ======= TOPBAR ======= */
.gpv-topbar {
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:5px 14px;
  background:#ffffff;
  border-bottom:1px solid #ddd;
  box-shadow:0 1px 3px rgba(0,0,0,0.08);
  position: relative;
  z-index: ;
}

.gpv-menu {
  position: absolute;
  background: #ffffff;
  border: 1px solid #ccc;
  padding: 12px;
  display: none;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.gpv-font-row{
  padding: 5px;
}

.gpv-menu-btn {
  font-size:22px;
  cursor:pointer;
  border-right: 1px solid #ccc;
  padding-right: 10px;
}

.gpv-right {
  display:flex;
  align-items:center;
  gap:10px;
}

.gpv-toggle {
  display:flex;
  align-items:center;
  gap:6px;
  font-size:14px;
  margin-left: -3px;

}

.gpv-toggle-versions {
  cursor: pointer;
  font-size: 20px;
  margin-left: 10px;
  user-select: none;
}

/* ===== Custom select ===== */
#gpv-myqueue-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gpv-cselect {
  position: relative;
  width: 60px;
  font-size: 14px;
  user-select: none;
}

.gpv-cselect-current {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 6px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}

.gpv-cselect-arrow {
  font-size: 12px;
  opacity: 0.7;
}

.gpv-cselect-list {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  width: 100%;
  background: #fff;
  border: 1px solid #ccc;
  border-radius: 4px;
  margin-top: 2px;
  max-height: 240px;
  overflow-y: auto;
  z-index: 9999;
}

.gpv-cselect.open .gpv-cselect-list {
  display: block;
}

.gpv-cselect-item {
  padding: 4px 6px;
  cursor: pointer;
}

.gpv-cselect-item:hover {
  background: #f0f0f0;
}

.gpv-cselect-item.active {
  background: #e6e6e6;
  font-weight: 600;
}


/* ======= CARD (block) ======= */
.content {
  padding:5px;
}

.gpb-block {
  background: #fff;
  padding: 15px 10px;
  margin-bottom: 5px;
  border-radius: 10px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.06);
  border: 1px solid #e6e6e6;
}

.gpv-old-version {
  position: relative;
  opacity: 0.5;              /* сделать менее яркой */
}

.gpv-old-version::after {
  content: "Стара версія";
  position: absolute;
  inset: 0;
  pointer-events: none;
  font-size: 12px;
  color: #b00000;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 4px 8px;
}

.gpv-old-hidden {
  display: none !important;
}

.gpb-header {
  display: inline-flex;
  align-items: center;
  background: #b00000;
  padding: 6px 14px;
  border-radius: 5px;
  color: #fff;
  font-weight: 700;
  gap: 6px;
}

.gpv-arrow{
  margin-left:7px;
  cursor:pointer;
  line-height:1;
}

/* Завтрашний график — зелёный */
.gpv-tomorrow {
  background: #007431 !important;
  color: #fff !important;
}

/* Заголовок прошлых дат */
.gpv-past-header {
  background: #777 !important;
  color: #fff !important;
}

/* ======= Queue summary ======= */
.gpb-row {
  padding:10px 0;
  border-bottom: 1px solid #bfbfbf;
}

.gpb-row-summary {
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:10px;
}

.gpv-queue-tag {
  display: inline-block;
  background: #ffc200;
  border: 1px solid #d3a000;
  padding: 4px 10px;
  border-radius: 4px;
  font-weight: 700;
  color: #333;
}

.gpv-total {
  font-weight:600;
  color:#333;
  margin-left: -5px;
}

/* ======= Interval blocks ======= */
.gpv-interval-row {
  display:flex;
  flex-wrap:wrap;
  gap:10px;
}

.gpv-interval-block {
  padding:8px 14px;
  background:#ffeaa7;
  border:1px solid #e1c16e;
  border-radius:8px;
  font-size:15px;
  white-space:nowrap;
  box-shadow: 0 0 5px #ddd;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== interval status ===== */
.gpv-interval-past {
  color: #999 !important;
  background: #f0f0f0 !important;
  border-color: #ccc !important;
  box-shadow: none !important;
}

/* ======= Hidden for filters ======= */
.gpv-hidden {
  display:none!important;
}
    </style>
  `;

  const topbar = `
  <div class="gpv-topbar">
    <div class="gpv-menu-btn" id="gpv-menu-btn">☰</div>
      <div class="gpv-right">
        <label class="gpv-toggle">
          <input type="checkbox" id="gpv-myqueue">
          Моя черга
        </label>
      </div>
    </div>

  <div class="gpv-menu" id="gpv-menu">
    <div class="gpv-font-row">
      Дата:
      <button data-t="h" data-d="-1">−</button>
      <span id="fh">22px</span>
      <button data-t="h" data-d="1">+</button>
    </div>
    <div class="gpv-font-row">
      Графік:
      <button data-t="r" data-d="-1">−</button>
      <span id="fr">15px</span>
      <button data-t="r" data-d="1">+</button>
    </div>
    <div class="gpv-font-row">
      Черга:
      <button data-t="s" data-d="-1">−</button>
      <span id="fs">15px</span>
      <button data-t="s" data-d="1">+</button>
    </div>
    <div id="gpv-myqueue-container" class="gpv-font-row">
       <b>Моя черга:</b>
       <div class="gpv-cselect" id="gpv-cselect">
          <div class="gpv-cselect-current" id="gpv-cselect-current">
            1.2
            <span class="gpv-cselect-arrow">▾</span>
          </div>
          <div class="gpv-cselect-list" id="gpv-cselect-list"></div>
        </div>
    </div>
    <div class="gpv-font-row">
      <label class="gpv-toggle">
        <input type="checkbox" id="gpv-show-all">
        Показати всі дати
      </label>
    </div>
  </div>
  `;

  /* =========================================================
   * 10. ГЕНЕРАЦИЯ ОСНОВНОГО КОНТЕНТА
   * ======================================================= */

    const content = `
      <div class="content" id="gpv-content"></div>
    `;

  // Вставляем всё в body
  document.body.innerHTML = style + topbar + content;

  /* =========================================================
 * RAW РЕНДЕРИНГ (режимы 1 и 2)
 * Показывает blocks[] в точном порядке, как на сайте.
 * Без стрелок. Без выбора today/tomorrow.
 * ======================================================= */

  /* =========================================================
 * RAW РЕНДЕРИНГ (режимы 1 и 2)
 * Показывает blocks[] как есть.
 * Но цвета и подсветка такие же, как в grouped:
 *   - завтра = зелёный
 *   - сегодня = обычный + подсветка прошедших интервалов
 *   - прошедшие даты = серые
 * ======================================================= */

  function renderContentRaw() {
    let html = "";

    for (const b of blocks) {

      // определяем класс звлоловка. сегодня, завтра
      let headerClass = "";

      if (b.date) {
        if (b.date.getTime() === TOMORROW.getTime()) {
          headerClass = "gpv-tomorrow";
        } else if (b.date < TODAY) {
          headerClass = "gpv-past-header";
        }
      }

      html += `
        <div class="gpb-block">
          <div class="gpb-header ${headerClass}">
            ${b.headerClean || "Без дати"}
          </div>
      `;

      // ===== строки очередей =====
      for (const r of b.rows) {
        let queueClasses = "";
        for (const q of r.queues) queueClasses += " queue-" + q.replace(".", "-");

        html += `
          <div class="gpb-row ${queueClasses}">
            <div class="gpb-row-summary">
              <span class="gpv-queue-tag">${r.queues.length === 12 ? "Всі черги" : r.queues.join(", ")}</span>
              <span class="gpv-total"> - ${r.totalTime}</span>
            </div>
            ${renderIntervalBlocks(r.intervals, b.date, r.isBroken)}
          </div>
        `;
      }

      html += `</div>`;
    }

    document.getElementById("gpv-content").innerHTML = html;

    applyVisibility();
    applyFonts();
  }

    /* =========================================================
   * GROUPED РЕНДЕРИНГ (режим 3)
   * Использует groupedByDate.
   * Показывает сегодня/завтра.
   * Показывает версии и стрелки ▼/▲.
   * ======================================================= */

  function renderContentGrouped() {
    const showAllNow = false;
    const dangerNulls = false;

    let datesToRender = [];

    if (tomorrowGroup) datesToRender.push(TOMORROW_KEY);
    if (todayGroup) datesToRender.push(TODAY_KEY);

    let html = "";

    for (const dateKey of datesToRender) {
      const group = groupedByDate[dateKey];
      if (!group) continue;

      // --- NEW: выбираем versions + учёт Моя Черга ---
      let versions = group.versions;

      const cb = document.getElementById("gpv-myqueue");
      if (cb && cb.checked) {
        const queue = localStorage.getItem(STORAGE_MY_QUEUE) || "1.2";
        versions = group.perQueueVersions[queue];
      }

      if (!versions || versions.length === 0) continue;

      // показываем либо одну, либо все версии
      const versionsToShow = group.expanded ? versions : [versions[0]];

      // ПЕРЕБОР ВЕРСИЙ
      for (let vIndex = 0; vIndex < versionsToShow.length; vIndex++) {
        const version = versionsToShow[vIndex];

        // Цвет заголовка: завтра/прошлое/сегодня
        let headerClass = "";
        if (group.date.getTime() === TOMORROW.getTime()) headerClass = "gpv-tomorrow";
        else if (group.date < TODAY) headerClass = "gpv-past-header";

        // ---- СТРЕЛКА ▼/▲ (только у vIndex=0 и только если versions.length > 1) ----
        let arrowHTML = "";
        if (versions.length > 1 && vIndex === 0) {
          arrowHTML = `
            <span class="gpv-arrow" data-date="${dateKey}">
              ${group.expanded ? "▲" : "▼"}
            </span>
          `;
        }

        // ==== БЛОК ВЕРСИИ ====
        // старые версии помечаются gpv-old-version
        const oldClass = (vIndex > 0 ? " gpv-old-version" : "");

        html += `
          <div class="gpb-block${oldClass}">
            <div class="gpb-header ${headerClass}">
              ${version.headerClean}
              ${arrowHTML}
            </div>
        `;

        // ==== СТРОКИ ОЧЕРЕДЕЙ ====
        for (const r of version.rows) {
        let queueClasses = "";
        for (const q of r.queues) queueClasses += " queue-" + q.replace(".", "-");

        // Шукаємо, для якої черги рахувати різницю
        let targetQueue = r.queues[0];
        const cbMy = document.getElementById("gpv-myqueue");

        // Якщо включена "Моя черга", беремо саме її для точного підрахунку
        if (cbMy && cbMy.checked) {
          const selectedQueue = localStorage.getItem("gpv_myqueue_selected") || "1.2";
          if (r.queues.includes(selectedQueue)) {
            targetQueue = selectedQueue;
          }
        }

        const diffHTML = formatVersionDiff(
          versionsToShow,
          versions,
          vIndex,
          targetQueue
        );

        html += `
          <div class="gpb-row ${queueClasses}">
            <div class="gpb-row-summary">
              <span class="gpv-queue-tag">${r.queues.length === 12 ? "Всі черги" : r.queues.join(", ")}</span>
              <span class="gpv-total"> - ${r.totalTime}${diffHTML}</span>
            </div>
            ${renderIntervalBlocks(r.intervals, group.date, r.isBroken)}
          </div>
        `;
      }
        html += `</div>`;
      }
    }

    document.getElementById("gpv-content").innerHTML = html;

    applyVisibility();
    applyFonts();

    // === обработчики на стрелки ===
    document.querySelectorAll(".gpv-arrow").forEach(el => {
      el.onclick = () => {
        const dk = el.dataset.date;
        groupedByDate[dk].expanded = !groupedByDate[dk].expanded;
        renderContent(); // перерисовка
      };
    });
  }

   /* =========================================================
 * РЕНДЕР ОСНОВНОГО КОНТЕНТА (3 РЕЖИМА) *
 * Режим 1: showAllNow = true
 *    → выводим blocks[] как есть (raw) *
 * Режим 2: showAllNow = false && dangerNulls = true
 *    → выводим blocks[] как есть (raw) *
 * Режим 3: showAllNow = false && dangerNulls = false
 *    → работаем по groupedByDate:
 *         - todayGroup, tomorrowGroup
 *         - версии по датам
 *         - стрелки ▼/▲
 * ======================================================= */

  function renderContent() {
    const showAllNow = localStorage.getItem(STORAGE_SHOW_ALL) === "1";
    const dangerNulls = hasCriticalNullDates(blocks);

    // ==== РЕЖИМ RAW (1 и 2) ====
    if (showAllNow || dangerNulls) {
      renderContentRaw();
      return;
    }

    // ==== РЕЖИМ GROUPED (3) ====
    renderContentGrouped();
  }

  /* =========================================================
   * 11. ЛОГИКА ФИЛЬТРОВ, МЕНЮ, ШРИФТОВ
   * ======================================================= */

  const cbAll = document.getElementById("gpv-show-all");
  cbAll.checked = localStorage.getItem(STORAGE_SHOW_ALL) === "1";

  const cbMy = document.getElementById("gpv-myqueue");

  // Восстанавливаем состояние
  cbMy.checked = localStorage.getItem("gpv_myqueue_enabled") === "1";

  // Сохраняет состояние галки Моя черга
  cbMy.onchange = () => {
    localStorage.setItem("gpv_myqueue_enabled", cbMy.checked ? "1" : "0");
    renderContent();
  };

    /**
   * Создаёт выпадающий список выбора очереди (1.1–6.2).
   * Выбирается только одна очередь.
   */
  function initCustomQueueSelect() {
    const root = document.getElementById("gpv-cselect");
    const current = document.getElementById("gpv-cselect-current");
    const list = document.getElementById("gpv-cselect-list");

    if (!root || !current || !list) return;

    let selected = localStorage.getItem(STORAGE_MY_QUEUE) || "1.2";

    function renderList() {
      current.firstChild.nodeValue = selected + " ";
      list.innerHTML = USER_QUEUES.map(q => `
        <div class="gpv-cselect-item ${q === selected ? "active" : ""}" data-q="${q}">
          ${q}
        </div>
      `).join("");
    }

    renderList();

    current.onclick = (e) => {
      e.stopPropagation();
      root.classList.toggle("open");
    };

    list.onclick = (e) => {
      const item = e.target.closest(".gpv-cselect-item");
      if (!item) return;

      selected = item.dataset.q;
      localStorage.setItem(STORAGE_MY_QUEUE, selected);
      root.classList.remove("open");

      renderList();
      renderContent(); // 🔥 перерисовываем график
    };

    document.addEventListener("click", () => {
      root.classList.remove("open");
    });
  }


  /**
   * Фильтруем строки графиков.
   * Если "Моя черга" включена → показываем только выбранную очередь.
   * Если выключена → показываем всё.
   */
  function applyVisibility() {
    const cb = document.getElementById("gpv-myqueue");
    const selectedQueue = localStorage.getItem(STORAGE_MY_QUEUE) || "1.2";

    document.querySelectorAll(".gpb-row").forEach(r => {

      // Если чекбокс отключён — показываем всё
      if (!cb.checked) {
        r.classList.remove("gpv-hidden");
        return;
      }

      // Если включён — проверяем, совпадает ли очередь
      const match = r.className.includes("queue-" + selectedQueue.replace(".", "-"));
      r.classList.toggle("gpv-hidden", !match);
    });
  }


  cbAll.onchange = () => {
    localStorage.setItem(STORAGE_SHOW_ALL, cbAll.checked ? "1" : "0");
    renderContent();   // без reload()
  };

  applyVisibility();

  // ---------- меню (иконка ☰) ----------
  const menuBtn = document.getElementById("gpv-menu-btn");
  const menu    = document.getElementById("gpv-menu");
  menuBtn.onclick = () => {
    menu.style.display = (menu.style.display === "block" ? "none" : "block");
  };

  // закрывать меню по клику вне него
  document.addEventListener("click", (e) => {
      const menu = document.getElementById("gpv-menu");
      const btn = document.getElementById("gpv-menu-btn");

      // если меню скрыто — ничего не делаем
      if (menu.style.display !== "block") return;

      // если клик по кнопке — не закрываем
      if (btn.contains(e.target)) return;

      // если клик по самому меню или его детям — не закрываем
      if (menu.contains(e.target)) return;

      // иначе закрываем
      menu.style.display = "none";
  });


  // ---------- настройка шрифтов ----------
  const fh = document.getElementById("fh");
  const fr = document.getElementById("fr");
  const fs = document.getElementById("fs");

  /**
   * applyFonts()
   *  - читает значения из localStorage
   *  - применяет размеры к:
   *    * .gpb-header       (дата)
   *    * .gpv-interval-block (интервалы)
   *    * .gpb-row-summary  (очередь + суммарное время)
   */
  function applyFonts() {
    const h = +localStorage.getItem(STORAGE_FONT_HEADER)  || 22;
    const r = +localStorage.getItem(STORAGE_FONT_ROW)     || 15;
    const s = +localStorage.getItem(STORAGE_FONT_SUMMARY) || 15;

    document.querySelectorAll(".gpb-header")
      .forEach(e => e.style.fontSize = h + "px");

    document.querySelectorAll(".gpv-interval-block")
      .forEach(e => e.style.fontSize = r + "px");

    document.querySelectorAll(".gpb-row-summary")
      .forEach(e => e.style.fontSize = s + "px");

    fh.textContent = h + "px";
    fr.textContent = r + "px";
    fs.textContent = s + "px";
  }

  // Обработка кликов по кнопкам +/- в меню
  menu.onclick = e => {
    if (e.target.tagName !== "BUTTON") return;

    const d = +e.target.dataset.d;
    const t = e.target.dataset.t;
    let key;

    if (t === "h") key = STORAGE_FONT_HEADER;
    else if (t === "r") key = STORAGE_FONT_ROW;
    else if (t === "s") key = STORAGE_FONT_SUMMARY;
    else return;

    let v = +(localStorage.getItem(key) || (t === "h" ? 22 : 15));
    v = Math.max(12, Math.min(36, v + d));

    localStorage.setItem(key, v);
    applyFonts();
  };

  //applyFonts();
  renderContent();
  initCustomQueueSelect();
  applyVisibility();

  /* =========================================================
   * 12. (ОПЦИОНАЛЬНО) АВТО-ОБНОВЛЕНИЕ ПРИ ВОЗВРАТЕ В ПРИЛОЖЕНИЕ
   *      - код пока закомментирован, логика сохранена
   * ======================================================= */

  function showInstantLoader() {
    document.body.innerHTML = `
      <div class="loading" style="
          display:flex; flex-direction:column; justify-content:center;
          align-items:center; height:100vh; gap:12px; font-family:Arial;
      ">
          <div class="spinner" style="
              width:48px; height:48px;
              border:6px solid #e0e0e0;
              border-top:6px solid #d00000;
              border-radius:50%;
              animation:spin 1s linear infinite;
          "></div>
          <div>Завантаження…</div>
      </div>
      <style>
          @keyframes spin {
            from { transform:rotate(0deg); }
            to   { transform:rotate(360deg); }
          }
      </style>
    `;
  }

  // Когда вкладка получает фокус
  window.addEventListener("focus", () => {
     showInstantLoader();
     setTimeout(() => location.reload(), 120);
  });

  // Когда возвращаемся из фона на Android/iOS
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
       showInstantLoader();
       setTimeout(() => location.reload(), 120);
    }
  });

})();
