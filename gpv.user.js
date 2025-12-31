// ==UserScript==
// @name         GPV parser черги
// @namespace    GPV parser
// @version      2.9.4
// @description  Парсинг графіка ГПВ
// @match        https://www.zoe.com.ua/*
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

  // Нормализация строки + вырезание мусора слева от очереди
  const ROW_CLEAN_RE =
    /([1-6]\.[12](\s*,\s*[1-6]\.[12])*)\s*[:\-]?\s*\d{1,2}[:;]\d{1,2}\s*[–—-]\s*\d{1,2}[:;]\d{1,2}/;
  
  function norm(s) {
    if (!s) return "";
  
    // Приводим NBSP, тире, пробелы
    let line =
      s.replace(/\u00A0/g, " ")
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
  
    // Если строка содержит очередь + интервал — обрезаем всё слева
    const m = line.match(ROW_CLEAN_RE);
    if (m) {
      line = line.slice(m.index).trim();
    }  
    return line;
  }

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
  const STRICT_INTERVAL_RE = /(\d{1,2})[:;](\d{1,2})\s*[–—-]\s*(\d{1,2})[:;](\d{1,2})/;
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
     Ищет строку-заголовок графика выше первой строки с очередью.
        - поднимается максимум на 10 строк вверх
        - фильтрует слова которые в stopWords, не должны быть в заголовке
        - парсим дату как "число + месяц" рядом
        - вытаскиваем "(оновлено ...)", собираем заголовок: "число + месяц (оновлено время)"
           либо только дату, либо только "(оновлено ...)"
     Возвращаем объект:
        {
          headerRaw:   исходный текст заголовка,
          headerClean: красивый заголовок "число + месяц (если есть, оновлено время)"
          date:        Date с 00:00 или null (если дату не распознали)
        }
    */

  function findHeader(lines, idx) {
    // Значения по умолчанию (если ничего не найдём)
    let headerRaw   = "ГПВ дата не розпізнана";
    let headerClean = "ГПВ дата не розпізнана";
    let date        = null;

    // Ищем реальный заголовок над первой строкой графика
    for (let j = idx - 1; j >= 0 && j >= idx - 10; j--) {
      const line = lines[j];
      const lower = line.toLowerCase();

      // 1) Проверяем, песть ли в строке ГПВ
      const isHeader =
        lower.includes("гпв") &&
        MONTHS_RE.test(line) &&
        !stopWords.some(sw => lower.includes(sw));

      if (!isHeader) continue;

      // Считаем эту строку заголовком
      headerRaw = line;

      // ===== 2) Парсим дату: ИЩЕМ "ЧИСЛО + МЕСЯЦ" РЯДОМ =====
      const upper = line.toUpperCase();

      // Ищем "ЧИСЛО + МЕСЯЦ" рядом, без лишних
      const dm = upper.match(
        /([0-3]?\d)\s+(СІЧНЯ|ЛЮТОГО|БЕРЕЗНЯ|КВІТНЯ|ТРАВНЯ|ЧЕРВНЯ|ЛИПНЯ|СЕРПНЯ|ВЕРЕСНЯ|ЖОВТНЯ|ЛИСТОПАДА|ГРУДНЯ)/
      );

      let day = null;
      let monthIndex = null;

      if (dm) {
        day = parseInt(dm[1], 10);
        const monthName = dm[2];

        if (!isNaN(day) && day >= 1 && day <= 31 && monthName in MONTH_INDEX) {
          monthIndex = MONTH_INDEX[monthName];

          const d = new Date(CURRENT_YEAR, monthIndex, day);
          d.setHours(0, 0, 0, 0);
          date = d;
        } else {
          date = null;
        }
      } else {
        // Число и месяц не стоят рядом → дату не распознали
        date = null;
      }

      // ===== 3) Вытаскиваем "(оновлено ...)" если есть =====
      // Допускаем варианты: "(оновлено 13:45)", "(оновлено о 13:45)", "(оновлено 13-45)"
      let updatedPart = "";
      //const updMatch = line.match(/\(оновлено\s*(?:о|об)?\s*([0-2]?\d[:\-][0-5]\d)\)/i);
      const updMatch = line.match(/\((?:оновлено\s*(?:о|об)?\s*)?([0-2]?\d[:\-][0-5]\d)\)/i);
      if (updMatch) {
        // Нормализуем разделитель времени на двоеточие
        const timeStr = updMatch[1].replace("-", ":");
        updatedPart = `(оновл. ${timeStr})`;
      }

      // ===== 4) Собираем заголовок =====
      if (date) {
        // У нас есть валидная дата → "число + месяц" + опционально "(оновлено ...)"
        const prettyDay   = day; // уже посчитали выше
        const prettyMonth = MONTH_NAMES_GENITIVE[monthIndex];

        if (updatedPart) {
          headerClean = `${prettyDay} ${prettyMonth} ${updatedPart}`;
        } else {
          headerClean = `${prettyDay} ${prettyMonth}`;
        }
      } else if (updatedPart) {
        // Дату не смогли распознать, но есть "(оновлено ...)"
        // → показываем только это
        headerClean = updatedPart;
      } else {
        // Ни даты, ни "(оновлено ...)" — оставляем исходный текст
        headerClean = headerRaw;
      }

      // Мы нашли нужный заголовок — выходим из цикла
      break;
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
    line = line.replace(/^([1-6]\.[12])(\s*,\s*[1-6]\.[12])*\s*[:\-]?\s*/, "").trim();
    const raw = line; // убраны очередя, строка с интервалами как есть

    // === Проверка на "не вимикається" ===
    const lowered = line.toLowerCase();
    if (lowered.includes("не вимикається") || lowered.includes("не вимикаються")) {
      return {
        raw,
        queues,
        intervals: [ lowered.includes("не вимикається") ? "не вимикається" : "не вимикаються" ],
        totalTime: "0 годин без світла",
        totalMinutes,
        isBroken: false
      };
    }

    // === ШИРОКАЯ регулярка для поиска всех интервалов времени ===
    const FIND_INTERVAL_RE = /\d{1,2}[:;]\d{1,2}\s*[–—-]\s*\d{1,2}[:;]\d{1,2}/g;
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
        intervals: [ raw + " !" ],
        totalTime: "0 годин без світла",
        totalMinutes,
        isBroken: true
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
    let totalTime = "0 годин без світла";
    if (totalMinutes > 0) {
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      if (m === 0) {
        totalTime = `${h} годин без світла`;
      } else {
        const mm = m < 10 ? "0" + m : m;
        totalTime = `${h}:${mm} годин без світла`;
      }
    }

    // === Возвращаем объект ===
    return {
      raw,
      queues,
      intervals: found,    // интервал-строки как есть
      totalTime,
      totalMinutes,
      isBroken: false
    };
}

  /* =========================================================
   * 6. ЗАГРУЗКА И ПРЕОБРАЗОВАНИЕ HTML С САЙТА
   * ======================================================= */

  // Тянем оригинальную страницу (без #gpv)
  const res = await fetch(location.href.replace("#gpv", ""), { credentials: "include" });
  const htmlText = await res.text();
  const tmp = document.createElement("div");
  tmp.innerHTML = htmlText;
  const lines = tmp.innerText.split("\n").map(norm).filter(Boolean);

  /* =========================================================
   * 7. ПАРСИНГ БЛОКОВ (ГРАФИКИ ПО ДНЯМ)
   * ======================================================= */
  //let DateNullIndexBlocks = -1; // минимальный blocks[index] с date = null
  const blocks = [];
    for (let i = 0; i < lines.length; i++) {
    if (!rowRe.test(lines[i])) continue; // rowRe регулярка для строки с очередью
    // if (blocks.length >= 10) break;  // количесво найденых блоков

    // если строка прошла регулярку очереди, это первая строка графика findHeader() ищет и возвращает заголовок
    const { headerRaw, headerClean, date } = findHeader(lines, i);

    //if (date === null) { // если не нашли дату в заголовке, date=null сохраняем минимальный blocks[index] с date = null
      //if (DateNullIndexBlocks === -1)
        //  DateNullIndexBlocks = blocks.length;
    //}

    const rows = [];
    let k = i;

    // собираем строки которые подряд и проходят регулярку rowRe, собираем блок графика
    while (k < lines.length && rowRe.test(lines[k])) {
      rows.push(parseRow(lines[k])); // передаем строку в parseRow()
      k++;
    }

    blocks.push({
      headerRaw,
      headerClean,
      date,
      rows
    });

    i = k - 1; // перепрыгиваем через собраные строки, что бы for заново в них не искал
  }
  //console.log(blocks);

  /* =========================================================
 * ГРУППИРУЕМ ВСЕ БЛОКИ В НОВУЮ АРХИТЕКТУРУ block.moreVersions
 *
 * Что делает:
 * 1. Собирает все блоки с одинаковой датой в один объект.
 * 2. Каждый объект содержит:
 *      - date                (дата графика)
 *      - versions[]          (все версии графика за этот день)
 *      - expanded            (раскрыт или свернут этот день)
 * 3. version хранит:
 *      - headerClean
 *      - rows[]
 *      - totalsByQueue{}     (минуты отключений по каждой очереди)
 *
 * Мы избавляемся от blocksToday/blocksTomorrow/candidateBlocks.
 * Теперь всё строится поверх groupedByDate.
 * ======================================================= */

  function buildGroupedByDate(blocks) {
    const grouped = {};

    for (const b of blocks) {
      // Если дата не найдена — пропускаем (старые или ошибочные блоки)
      if (!b.date) continue;

      // Ключ в формате YYYY-MM-DD
      const key = b.date.toISOString().slice(0, 10);

      // Если даты ещё нет — создаём запись
      if (!grouped[key]) {
        grouped[key] = {
          date: b.date,
          versions: [],
          expanded: false     // по умолчанию отображаем только последнюю версию
        };
      }

      // === Считаем суммарное время по каждой очереди (в минутах) ===
      // (parseRow уже дал totalMinutes)
      const totalsByQueue = {};
      for (const r of b.rows) {
        for (const q of r.queues) {
          if (!totalsByQueue[q]) totalsByQueue[q] = 0;
          totalsByQueue[q] += r.totalMinutes;
        }
      }

      // Добавляем версию
      grouped[key].versions.push({
        headerClean: b.headerClean,
        rows: b.rows,
        totalsByQueue
      });
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
  top: 46px;
  left: 10px;
  background: #ffffff;
  border: 1px solid #ccc;
  border-radius: 10px;
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

.gpv-divider {
  width:1px;
  height:22px;
  background:#ccc;
}

.gpv-toggle {
  display:flex;
  align-items:center;
  gap:6px;
  font-size:14px;
}

.gpv-toggle-versions {
  cursor: pointer;
  font-size: 20px;
  margin-left: 10px;
  user-select: none;
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
  opacity: 0.6;              /* сделать менее яркой */
}

.gpv-old-version::after {
  content: "Стара версія";
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.3); /* белая дымка */
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
  display: inline-block;
  background: #b00000;
  padding: 6px 14px;
  border-radius: 5px;
  color: #fff;
  font-weight: 700;
  font-size: 20px;
}

.gpv-arrow{
  margin-left:7px;
  cursor:pointer;
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
  border-bottom:1px solid #eee;
}

.gpb-row:last-child {
  border-bottom:none;
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
        <input type="checkbox" id="gpv-show-all">
        Показати всі
      </label>
      <div class="gpv-divider"></div>
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
       <select id="gpv-myqueue-select" style="padding:4px"></select>
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
              <span class="gpv-queue-tag">${r.queues.join(", ")}</span>
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
    const showAllNow = false; // здесь showAllNow всегда false
    const dangerNulls = false; // здесь dangerNulls всегда false

    let datesToRender = [];

    // Показываем только tomorrow + today
    if (tomorrowGroup) datesToRender.push(TOMORROW_KEY);
    if (todayGroup) datesToRender.push(TODAY_KEY);

    let html = "";

    for (const dateKey of datesToRender) {
      const group = groupedByDate[dateKey];
      if (!group) continue;

      const versions = group.versions;

      // показываем одну или все версии
      const versionsToShow = (group.expanded ? versions : [versions[0]]);

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

          html += `
            <div class="gpb-row ${queueClasses}">
              <div class="gpb-row-summary">
                <span class="gpv-queue-tag">${r.queues.join(", ")}</span>
                <span class="gpv-total"> - ${r.totalTime}</span>
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
    applyVisibility();
  };

    /**
   * Создаёт выпадающий список выбора очереди (1.1–6.2).
   * Выбирается только одна очередь.
   */
  function renderMyQueueSelector() {
    const select = document.getElementById("gpv-myqueue-select");
    if (!select) return;

    const current = localStorage.getItem(STORAGE_MY_QUEUE) || "1.2";

    // Строим список <option>
    select.innerHTML = USER_QUEUES
      .map(q => `<option value="${q}" ${q === current ? "selected" : ""}>${q}</option>`)
      .join("");

    // обработчик выбора
    select.onchange = () => {
      localStorage.setItem(STORAGE_MY_QUEUE, select.value);
      applyVisibility();
    };
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
  renderMyQueueSelector();
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
