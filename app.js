(() => {
  'use strict';

  // ---------- данные ----------
  const ALL = window.PDD_QUESTIONS || [];
  const TICKET_COUNT = 40;
  const BY_TICKET = {};
  for (const q of ALL) (BY_TICKET[q.t] = BY_TICKET[q.t] || [])[q.n - 1] = q;
  const BY_ID = new Map(ALL.map(q => [q.id, q]));
  const TOPICS = (() => {
    const m = new Map();
    for (const q of ALL) for (const t of q.top) m.set(t, (m.get(t) || 0) + 1);
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  })();

  const EXAM_MINUTES = 20;
  const EXTRA_MINUTES = 5;
  const BLOCK_SIZE = 5;

  // ---------- хранилище ----------
  const KEY = 'pdd_state_v1';
  const store = Object.assign({
    stats: {},          // id -> { ok, bad, last }
    mistakes: [],       // id вопросов, на которые ответили неверно
    fav: [],            // избранное
    tickets: {},        // номер билета -> { ok, total, date }
    topics: {},         // название темы -> { ok, total, date }
    exams: [],          // история экзаменов
    marathon: null,     // { order: [id], answers: { id: idx } }
    series: null,       // незавершённая серия экзаменов
    settings: { autoNext: true, shuffle: false },
    theme: null,
  }, readStore());
  store.settings = Object.assign({ autoNext: true, shuffle: false }, store.settings);

  function readStore() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* приватный режим */ }
  }

  function record(q, correct) {
    const s = store.stats[q.id] || (store.stats[q.id] = { ok: 0, bad: 0, last: null });
    correct ? s.ok++ : s.bad++;
    s.last = correct;
    const i = store.mistakes.indexOf(q.id);
    if (correct && i >= 0) store.mistakes.splice(i, 1);
    if (!correct && i < 0) store.mistakes.push(q.id);
    save();
  }

  // ---------- утилиты ----------
  const $app = document.getElementById('app');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  };
  const fmtTime = ms => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  function toast(text, ms = 3500) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  const go = hash => { location.hash = hash; };

  // ---------- тема ----------
  function applyTheme() {
    if (store.theme) document.documentElement.dataset.theme = store.theme;
    else delete document.documentElement.dataset.theme;
  }
  document.getElementById('themeBtn').addEventListener('click', () => {
    const dark = store.theme ? store.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    store.theme = dark ? 'light' : 'dark';
    applyTheme();
    save();
  });
  applyTheme();

  // ---------- набор вопросов для экзаменов без повторов ----------
  // Для каждой позиции 1..20 перемешиваем 40 билетов. Экзамен k берёт вопрос позиции p
  // из билета perms[p][k], а дополнительные вопросы — из билетов после зарезервированных.
  // Так ни один вопрос не повторяется ни между экзаменами серии, ни в дополнительных блоках.
  function makeExamSet(count) {
    return {
      count,
      perms: range(0, 19).map(() => shuffle(range(1, TICKET_COUNT))),
      ptr: Array(20).fill(count),
    };
  }
  function examQuestions(set, k) {
    return range(0, 19).map(p => BY_TICKET[set.perms[p][k]][p]);
  }
  function extraQuestions(set, block) {
    return range(block * BLOCK_SIZE, block * BLOCK_SIZE + BLOCK_SIZE - 1).map(p => {
      const t = set.perms[p][set.ptr[p]++ % TICKET_COUNT];
      return BY_TICKET[t][p];
    });
  }

  // ---------- сессия (любой режим прохождения вопросов) ----------
  let session = null;
  let timerId = null;
  let autoNextId = null;

  function makeItem(q, opts = {}) {
    const order = opts.shuffle ? shuffle(range(0, q.a.length - 1)) : range(0, q.a.length - 1);
    return { q, order, picked: null, extra: !!opts.extra, block: Math.floor((q.n - 1) / BLOCK_SIZE) };
  }

  function startTraining({ title, subtitle, questions, tag, persist, picked }) {
    const shuffleAns = store.settings.shuffle;
    session = {
      kind: 'train', title, subtitle, tag, persist,
      items: questions.map(q => makeItem(q, { shuffle: shuffleAns })),
      cur: 0,
    };
    if (picked) {
      session.items.forEach(it => { if (picked[it.q.id] != null) it.picked = picked[it.q.id]; });
      const first = session.items.findIndex(it => it.picked == null);
      session.cur = first >= 0 ? first : 0;
    }
    openQuiz();
  }

  function startExam({ set, k, title, subtitle, series }) {
    session = {
      kind: 'exam', title, subtitle, set, series,
      items: examQuestions(set, k).map(q => makeItem(q)),
      cur: 0,
      view: 'grid',     // 'grid' — список карточек вопросов, 'question' — открытый вопрос
      sel: null,        // выбранный, но ещё не подтверждённый ответ
      phase: 'main',
      started: Date.now(),
      deadline: Date.now() + EXAM_MINUTES * 60000,
    };
    openQuiz();
  }

  function openQuiz() {
    if (location.hash === '#/quiz') render();
    else go('#/quiz');
  }

  function stopTimers() {
    clearInterval(timerId); timerId = null;
    clearTimeout(autoNextId); autoNextId = null;
  }

  const isRight = it => it.picked != null && it.picked === it.q.c;

  function pick(origIdx) {
    const s = session, it = s.items[s.cur];
    if (!s || it.picked != null) return;
    if (s.kind === 'exam') {
      // в экзамене ответ только выбирается, засчитывается после подтверждения
      s.sel = origIdx;
      render();
      return;
    }
    it.picked = origIdx;
    const ok = origIdx === it.q.c;
    record(it.q, ok);
    if (s.persist) s.persist(it);
    render();
    if (ok && store.settings.autoNext) {
      const cur = s.cur;
      autoNextId = setTimeout(() => { if (session === s && s.cur === cur) next(); }, 650);
    }
  }

  function confirmAnswer() {
    const s = session, it = s.items[s.cur];
    if (s.sel == null || it.picked != null) return;
    it.picked = s.sel;
    s.sel = null;
    record(it.q, isRight(it));
    s.view = 'grid';
    if (s.items.every(x => x.picked != null)) evaluateExam();
    else render();
  }

  function openExamQuestion(i) {
    session.cur = i;
    session.sel = null;
    session.view = 'question';
    render();
    window.scrollTo(0, 0);
  }

  function backToGrid() {
    session.sel = null;
    session.view = 'grid';
    render();
  }

  // Переходит к следующему неотвеченному вопросу; false — если таких нет.
  function nextUnanswered() {
    const s = session, n = s.items.length;
    for (let d = 1; d <= n; d++) {
      const i = (s.cur + d) % n;
      if (s.items[i].picked == null) { s.cur = i; return true; }
    }
    return false;
  }

  function next() {
    clearTimeout(autoNextId);
    const s = session;
    if (s.items[s.cur].picked == null) {
      // пропуск вопроса
      if (!nextUnanswered()) return;
    } else if (s.cur + 1 < s.items.length && s.items[s.cur + 1].picked == null) {
      s.cur++;
    } else if (!nextUnanswered()) {
      return s.kind === 'exam' ? evaluateExam() : finishTraining();
    }
    render();
  }

  function goTo(i) {
    clearTimeout(autoNextId);
    if (i < 0 || i >= session.items.length) return;
    session.cur = i;
    render();
  }

  // ---------- правила экзамена ГИБДД ----------
  // 20 вопросов в 4 тематических блоках по 5. Больше 2 ошибок или 2 ошибки в одном блоке — не сдан.
  // За каждую ошибку — 5 дополнительных вопросов из того же блока и +5 минут; в них ошибаться нельзя.
  function evaluateExam() {
    const s = session;
    const main = s.items.filter(it => !it.extra);
    const errBlocks = {};
    main.forEach(it => { if (!isRight(it)) errBlocks[it.block] = (errBlocks[it.block] || 0) + 1; });
    const errors = Object.values(errBlocks).reduce((a, b) => a + b, 0);

    if (s.phase === 'main') {
      if (errors === 0) return finishExam(true, 'Все ответы верные');
      if (errors > 2) return finishExam(false, `Допущено ${errors} ${plural(errors, 'ошибка', 'ошибки', 'ошибок')} в основных вопросах`);
      if (Object.values(errBlocks).some(v => v >= 2)) return finishExam(false, 'Две ошибки в одном тематическом блоке');
      const blocks = Object.keys(errBlocks).map(Number);
      const start = s.items.length;
      blocks.forEach(b => extraQuestions(s.set, b).forEach(q => s.items.push(makeItem(q, { extra: true }))));
      s.phase = 'extra';
      s.deadline += blocks.length * EXTRA_MINUTES * 60000;
      s.cur = start;
      s.gridScroll = 0;
      render();
      toast(`${errors === 1 ? 'Одна ошибка' : 'Две ошибки'} — ещё ${blocks.length * 5} дополнительных вопросов и +${blocks.length * 5} минут. Ошибаться в них нельзя.`, 6000);
      return;
    }
    const extraErr = s.items.filter(it => it.extra && !isRight(it)).length;
    if (extraErr) return finishExam(false, 'Ошибка в дополнительных вопросах');
    finishExam(true, 'Дополнительные вопросы решены без ошибок');
  }

  function tick() {
    const s = session;
    if (!s || s.kind !== 'exam' || s.finished) return stopTimers();
    const left = s.deadline - Date.now();
    const el = document.getElementById('timer');
    if (el) {
      el.textContent = fmtTime(left);
      el.classList.toggle('low', left < 60000);
    }
    if (left <= 0) finishExam(false, 'Время вышло');
  }

  function finishExam(pass, reason) {
    const s = session;
    s.finished = true;
    s.pass = pass;
    s.reason = reason;
    s.timeSpent = Date.now() - s.started;
    stopTimers();
    const errors = s.items.filter(it => it.picked != null && !isRight(it)).length;
    store.exams.unshift({ date: Date.now(), pass, errors, total: s.items.length, series: !!s.series, time: s.timeSpent });
    store.exams = store.exams.slice(0, 100);
    if (s.series) {
      const sr = s.series;
      sr.results.push({ pass, errors, total: s.items.length, reason, time: s.timeSpent });
      sr.k++;
      // серия заканчивается досрочно, как только провалов больше разрешённого
      sr.over = seriesFails(sr) > seriesAllow(sr) || sr.k >= sr.set.count;
      store.series = sr.over ? null : sr;
    }
    save();
    go('#/result');
  }

  function finishTraining() {
    const s = session;
    s.finished = true;
    stopTimers();
    const ok = s.items.filter(isRight).length;
    const total = s.items.length;
    if (s.tag && s.tag.type === 'ticket') store.tickets[s.tag.id] = { ok, total, date: Date.now() };
    if (s.tag && s.tag.type === 'topic') store.topics[s.tag.id] = { ok, total, date: Date.now() };
    if (s.tag && s.tag.type === 'marathon') store.marathon = null;
    save();
    go('#/result');
  }

  function leaveQuiz() {
    const s = session;
    if (s && !s.finished && s.items.some(it => it.picked != null) && !s.persist) {
      if (!confirm(s.kind === 'exam' ? 'Прервать экзамен? Результат не сохранится.' : 'Выйти? Прогресс этой попытки не сохранится.')) return;
    }
    stopTimers();
    session = null;
    go('#/');
  }

  // ---------- экраны ----------
  const views = {
    '': renderHome,
    tickets: renderTickets,
    topics: renderTopics,
    series: renderSeriesSetup,
    stats: renderStats,
    external: renderExternal,
    quiz: renderQuiz,
    result: renderResult,
  };

  function render() {
    const route = location.hash.replace(/^#\/?/, '').split('/')[0];
    document.querySelectorAll('.topnav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#/' + route));
    if (route !== 'quiz' && route !== 'result' && session && !session.finished) {
      // ушли со страницы вопроса — сессия прерывается (марафон сохраняется сам)
      stopTimers();
      session = null;
    }
    (views[route] || renderHome)();
  }

  const avgTime = list => {
    const t = list.filter(e => e.time > 0);
    return t.length ? t.reduce((a, e) => a + e.time, 0) / t.length : 0;
  };

  // Сводные показатели — общие для главной и страницы статистики.
  function kpisHtml() {
    const ids = Object.keys(store.stats);
    const lastOk = ids.filter(id => store.stats[id].last).length;
    const exams = store.exams;
    const passed = exams.filter(e => e.pass).length;
    const avg = avgTime(exams);
    return `
      <div class="kpis" style="justify-content:flex-start">
        <div class="kpi"><b>${ids.length}<small style="font-size:14px;color:var(--muted)">/${ALL.length}</small></b><span>вопросов решено</span></div>
        <div class="kpi"><b style="color:var(--ok)">${ids.length ? Math.round(lastOk / ids.length * 100) : 0}%</b><span>верных ответов</span></div>
        <div class="kpi"><b>${passed}/${exams.length}</b><span>экзаменов сдано</span></div>
        <div class="kpi"><b>${avg ? fmtTime(avg) : '—'}</b><span>среднее время экзамена</span></div>
        <div class="kpi"><b style="color:var(--bad)">${store.mistakes.length}</b><span>в работе над ошибками</span></div>
      </div>`;
  }

  function renderHome() {
    const m = store.marathon;
    const mDone = m ? Object.keys(m.answers).length : 0;
    const passed = store.exams.filter(e => e.pass).length;
    const sr = store.series;
    $app.innerHTML = `
      <h1>Билеты ПДД онлайн</h1>
      <p class="lead">${ALL.length} вопросов, ${TICKET_COUNT} билетов, ${TOPICS.length} тем. Категории A, B, M.</p>
      ${kpisHtml()}
      <div class="modes" style="margin-top:8px">
        <button class="mode hero" data-act="exam">
          <span class="ico">🚦</span>
          <b>Экзамен как в ГИБДД</b>
          <span>20 вопросов, 20 минут, дополнительные вопросы за ошибки — по актуальным правилам</span>
          ${store.exams.length ? `<span class="badge">Сдано ${passed} из ${store.exams.length}</span>` : ''}
        </button>
        <a class="mode" href="#/series">
          <span class="ico">🔁</span>
          <b>Серия экзаменов</b>
          <span>Несколько экзаменов подряд — ни один вопрос не повторяется</span>
          ${sr ? `<span class="badge ok">Продолжить: ${sr.k + 1} из ${sr.set.count}</span>` : ''}
        </a>
        <a class="mode" href="#/tickets">
          <span class="ico">🎫</span>
          <b>Билеты 1–40</b>
          <span>Решайте по билетам с подсказками</span>
          <span class="badge">${Object.keys(store.tickets).length} из ${TICKET_COUNT} решено</span>
        </a>
        <a class="mode" href="#/topics">
          <span class="ico">📚</span>
          <b>По темам</b>
          <span>Знаки, разметка, перекрёстки, обгон и ещё ${TOPICS.length - 4} тем</span>
        </a>
        <button class="mode" data-act="marathon">
          <span class="ico">🏃</span>
          <b>Марафон</b>
          <span>Все ${ALL.length} вопросов вперемешку, прогресс сохраняется</span>
          ${m ? `<span class="badge ok">Продолжить: ${mDone} из ${m.order.length}</span>` : ''}
        </button>
        <button class="mode" data-act="mistakes">
          <span class="ico">🎯</span>
          <b>Работа над ошибками</b>
          <span>Вопросы, где вы ошиблись. Верный ответ убирает вопрос из списка</span>
          <span class="badge ${store.mistakes.length ? 'bad' : ''}">${store.mistakes.length} ${plural(store.mistakes.length, 'вопрос', 'вопроса', 'вопросов')}</span>
        </button>
        <button class="mode" data-act="random">
          <span class="ico">🎲</span>
          <b>Случайные 20</b>
          <span>20 случайных вопросов для быстрой тренировки</span>
        </button>
        <button class="mode" data-act="fav">
          <span class="ico">⭐</span>
          <b>Избранное</b>
          <span>Вопросы, которые вы отметили звёздочкой</span>
          <span class="badge">${store.fav.length}</span>
        </button>
        <button class="mode" data-act="hard">
          <span class="ico">🔥</span>
          <b>Сложные вопросы</b>
          <span>Вопросы, в которых вы ошибались чаще, чем отвечали верно</span>
        </button>
        <a class="mode" href="#/external">
          <span class="ico">🌐</span>
          <b>Экзамен pdd-exam.ru</b>
          <span>Внешний виджет экзамена в ГИБДД</span>
        </a>
      </div>
      <div class="settings">
        <label><input type="checkbox" id="setAuto" ${store.settings.autoNext ? 'checked' : ''}> Автопереход после верного ответа</label>
        <label><input type="checkbox" id="setShuffle" ${store.settings.shuffle ? 'checked' : ''}> Перемешивать варианты ответа в тренировке</label>
      </div>`;

    $app.querySelector('#setAuto').onchange = e => { store.settings.autoNext = e.target.checked; save(); };
    $app.querySelector('#setShuffle').onchange = e => { store.settings.shuffle = e.target.checked; save(); };
    $app.querySelectorAll('[data-act]').forEach(b => b.onclick = () => homeAction(b.dataset.act));
  }

  function homeAction(act) {
    if (act === 'exam') {
      return startExam({ set: makeExamSet(1), k: 0, title: 'Экзамен', subtitle: 'Как в ГИБДД' });
    }
    if (act === 'marathon') {
      if (!store.marathon) {
        store.marathon = { order: shuffle(ALL.map(q => q.id)), answers: {} };
        save();
      }
      const m = store.marathon;
      return startTraining({
        title: 'Марафон', subtitle: `${ALL.length} вопросов`,
        questions: m.order.map(id => BY_ID.get(id)).filter(Boolean),
        picked: m.answers,
        tag: { type: 'marathon' },
        persist: it => { if (store.marathon) { store.marathon.answers[it.q.id] = it.picked; save(); } },
      });
    }
    if (act === 'mistakes') {
      const qs = store.mistakes.map(id => BY_ID.get(id)).filter(Boolean);
      if (!qs.length) return toast('Ошибок пока нет — отличная работа!');
      return startTraining({ title: 'Работа над ошибками', subtitle: `${qs.length} ${plural(qs.length, 'вопрос', 'вопроса', 'вопросов')}`, questions: shuffle(qs) });
    }
    if (act === 'random') {
      return startTraining({ title: 'Случайные 20', subtitle: 'Тренировка', questions: shuffle(ALL).slice(0, 20) });
    }
    if (act === 'fav') {
      const qs = store.fav.map(id => BY_ID.get(id)).filter(Boolean);
      if (!qs.length) return toast('Отмечайте вопросы звёздочкой ☆ во время решения — они появятся здесь');
      return startTraining({ title: 'Избранное', subtitle: `${qs.length} ${plural(qs.length, 'вопрос', 'вопроса', 'вопросов')}`, questions: qs });
    }
    if (act === 'hard') {
      const qs = ALL.filter(q => { const s = store.stats[q.id]; return s && s.bad > 0 && s.bad >= s.ok; });
      if (!qs.length) return toast('Сложных вопросов пока нет — решите побольше билетов');
      return startTraining({ title: 'Сложные вопросы', subtitle: `${qs.length} ${plural(qs.length, 'вопрос', 'вопроса', 'вопросов')}`, questions: shuffle(qs) });
    }
  }

  function renderTickets() {
    $app.innerHTML = `
      <a class="back" href="#/">← Все режимы</a>
      <h1>Билеты 1–40</h1>
      <p class="lead">Режим тренировки: сразу видно правильный ответ и пояснение. Зелёный — решён без ошибок или с одной-двумя.</p>
      <div class="tickets">
        ${range(1, TICKET_COUNT).map(t => {
          const r = store.tickets[t];
          const cls = r ? (r.total - r.ok <= 2 ? 'done-ok' : 'done-bad') : '';
          return `<button class="ticket ${cls}" data-t="${t}"><b>${t}</b><small>${r ? `${r.ok}/${r.total}` : 'билет'}</small></button>`;
        }).join('')}
      </div>
      <div class="row" style="margin-top:20px">
        <button class="btn" id="randTicket">🎲 Случайный билет</button>
        <button class="btn" id="nextTicket">Следующий нерешённый</button>
      </div>`;
    const open = t => startTraining({ title: `Билет ${t}`, subtitle: 'Тренировка', questions: BY_TICKET[t], tag: { type: 'ticket', id: t } });
    $app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => open(+b.dataset.t));
    $app.querySelector('#randTicket').onclick = () => open(1 + Math.floor(Math.random() * TICKET_COUNT));
    $app.querySelector('#nextTicket').onclick = () => {
      const t = range(1, TICKET_COUNT).find(t => !store.tickets[t]);
      t ? open(t) : toast('Все билеты решены!');
    };
  }

  function renderTopics() {
    $app.innerHTML = `
      <a class="back" href="#/">← Все режимы</a>
      <h1>Вопросы по темам</h1>
      <p class="lead">Выберите тему — вопросы из всех 40 билетов.</p>
      <div class="list">
        ${TOPICS.map((t, i) => {
          const r = store.topics[t.name];
          const pct = r ? Math.round(r.ok / r.total * 100) : 0;
          return `<button class="list-item" data-i="${i}">
            <div style="flex:1">${esc(t.name)}${r ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
            <span class="meta">${r ? `${r.ok}/${r.total} · ` : ''}${t.count} ${plural(t.count, 'вопрос', 'вопроса', 'вопросов')}</span>
          </button>`;
        }).join('')}
      </div>`;
    $app.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
      const t = TOPICS[+b.dataset.i];
      startTraining({
        title: t.name, subtitle: 'Тема',
        questions: ALL.filter(q => q.top.includes(t.name)),
        tag: { type: 'topic', id: t.name },
      });
    });
  }

  // Сколько экзаменов в серии можно не сдать (у старых сохранённых серий лимита нет).
  const seriesAllow = sr => sr.allowFails != null ? sr.allowFails : sr.set.count;
  const seriesFails = sr => sr.results.filter(r => !r.pass).length;
  const failsText = n => n === 0 ? 'все экзамены нужно сдать' : `можно не сдать ${n} ${plural(n, 'экзамен', 'экзамена', 'экзаменов')}`;

  function renderSeriesSetup() {
    const sr = store.series;
    let count = 5;
    let allow = 1;
    $app.innerHTML = `
      <a class="back" href="#/">← Все режимы</a>
      <h1>Серия экзаменов</h1>
      <p class="lead">Несколько экзаменов по правилам ГИБДД подряд, с дополнительными вопросами за ошибки. Вопросы не повторяются ни между экзаменами, ни в дополнительных блоках.</p>
      ${sr ? `
        <div class="panel" style="margin-bottom:16px">
          <b>Незавершённая серия:</b> пройдено ${sr.k} из ${sr.set.count},
          не сдано ${seriesFails(sr)} (${failsText(seriesAllow(sr))}).
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="cont">Продолжить — экзамен ${sr.k + 1}</button>
            <button class="btn" id="drop">Сбросить</button>
          </div>
        </div>` : ''}
      <div class="panel">
        <b>Сколько экзаменов?</b>
        <div class="counter">
          <button id="minus" aria-label="Меньше">−</button>
          <output id="cnt"></output>
          <button id="plus" aria-label="Больше">+</button>
          <span class="meta" id="cntQ" style="color:var(--muted)"></span>
        </div>
        <b>Сколько можно не сдать?</b>
        <div class="counter">
          <button id="aMinus" aria-label="Меньше">−</button>
          <output id="allow"></output>
          <button id="aPlus" aria-label="Больше">+</button>
          <span class="meta" id="allowQ" style="color:var(--muted)"></span>
        </div>
        <button class="btn primary" id="start">Начать новую серию</button>
      </div>`;
    const upd = () => {
      allow = Math.min(allow, count - 1);
      $app.querySelector('#cnt').textContent = count;
      $app.querySelector('#cntQ').textContent = `${count * 20} разных вопросов`;
      $app.querySelector('#allow').textContent = allow;
      $app.querySelector('#allowQ').textContent = allow === 0
        ? 'один проваленный экзамен — и серия не пройдена'
        : `${allow + 1}-й проваленный экзамен — и серия не пройдена`;
    };
    upd();
    $app.querySelector('#minus').onclick = () => { count = Math.max(2, count - 1); upd(); };
    $app.querySelector('#plus').onclick = () => { count = Math.min(10, count + 1); upd(); };
    $app.querySelector('#aMinus').onclick = () => { allow = Math.max(0, allow - 1); upd(); };
    $app.querySelector('#aPlus').onclick = () => { allow = Math.min(count - 1, allow + 1); upd(); };
    $app.querySelector('#start').onclick = () => {
      if (sr && !confirm('Начать новую серию? Текущая будет сброшена.')) return;
      store.series = { set: makeExamSet(count), k: 0, results: [], allowFails: allow };
      save();
      runSeries();
    };
    if (sr) {
      $app.querySelector('#cont').onclick = runSeries;
      $app.querySelector('#drop').onclick = () => { store.series = null; save(); render(); };
    }
  }

  function runSeries() {
    const sr = store.series;
    if (!sr) return go('#/series');
    startExam({ set: sr.set, k: sr.k, title: `Экзамен ${sr.k + 1} из ${sr.set.count}`, subtitle: 'Серия без повторов', series: sr });
  }

  function renderQuiz() {
    const s = session;
    if (!s) return go('#/');
    if (s.finished) return go('#/result');
    if (s.kind === 'exam' && s.view === 'grid') return renderExamGrid();
    const it = s.items[s.cur];
    const q = it.q;
    const exam = s.kind === 'exam';
    const reveal = !exam && it.picked != null;
    const okCount = s.items.filter(isRight).length;
    const badCount = s.items.filter(x => x.picked != null && !isRight(x)).length;
    const answered = okCount + badCount;
    const isFav = store.fav.includes(q.id);

    const navCls = (x, i) => {
      const c = [];
      if (i === s.cur) c.push('cur');
      if (x.extra) c.push('extra');
      if (x.picked != null) c.push(exam ? 'done' : (isRight(x) ? 'ok' : 'bad'));
      return c.join(' ');
    };
    const nav = exam ? '' : s.items.length <= 60
      ? `<div class="qnav">${s.items.map((x, i) => `<button class="${navCls(x, i)}" data-go="${i}">${i + 1}</button>`).join('')}</div>`
      : `<div style="margin-bottom:14px"><div class="bar" style="height:8px"><i style="width:${answered / s.items.length * 100}%"></i></div></div>`;

    const answersHtml = it.order.map((orig, i) => {
      let cls = '';
      if (reveal) {
        if (orig === q.c) cls = 'right';
        else if (orig === it.picked) cls = 'wrong';
      } else if (it.picked === orig || (exam && s.sel === orig)) cls = 'picked';
      const disabled = it.picked != null ? 'disabled' : '';
      return `<button class="answer ${cls}" data-a="${orig}" ${disabled}><span class="num">${i + 1}</span><span>${esc(q.a[orig])}</span></button>`;
    }).join('');

    const tip = reveal ? `
      <div class="tip ${isRight(it) ? 'ok' : 'bad'}">
        <b>${isRight(it) ? '✓ Правильно' : `✗ Неправильно. Верный ответ: ${it.order.indexOf(q.c) + 1}`}</b>
        ${esc(q.tip)}
      </div>` : '';

    const allDone = s.items.every(x => x.picked != null);

    $app.innerHTML = `
      <div class="quiz-head">
        <div class="quiz-title">${esc(s.title)}<small>${esc(s.subtitle || '')}${exam && s.phase === 'extra' ? ' · дополнительные вопросы' : ''}</small></div>
        <div class="quiz-stats">
          ${exam
            ? `<span class="badge">${answered} из ${s.items.length}</span><span class="timer" id="timer">${fmtTime(s.deadline - Date.now())}</span>`
            : `<span class="badge">${s.cur + 1} / ${s.items.length}</span><span class="badge ok">✓ ${okCount}</span><span class="badge bad">✗ ${badCount}</span>`}
          ${!exam ? `<button class="btn small" id="finish">${allDone ? 'Результаты' : 'Завершить'}</button>` : ''}
          <button class="btn small" id="leave">Выйти</button>
        </div>
      </div>
      ${nav}
      <div class="qcard">
        ${q.img ? `<div class="qimg"><img src="${q.img}" alt="Иллюстрация к вопросу"></div>` : '<div class="qimg empty">Вопрос без иллюстрации</div>'}
        <div class="qbody">
          <div class="qmeta">
            <span>Билет ${q.t}, вопрос ${q.n}${it.extra ? ' · доп. вопрос' : ''}</span>
            <button class="fav ${isFav ? 'on' : ''}" id="fav" title="В избранное (F)">${isFav ? '★' : '☆'}</button>
          </div>
          <p class="qtext">${esc(q.q)}</p>
          <div class="answers">${answersHtml}</div>
          ${tip}
          ${exam ? `
          <div class="quiz-foot">
            <button class="btn" id="toGrid">← К списку вопросов</button>
            ${it.picked == null ? `<button class="btn primary" id="confirm" ${s.sel == null ? 'disabled' : ''}>Подтвердить ответ</button>` : ''}
          </div>
          <div class="hint">Клавиши: 1–${q.a.length} — выбрать ответ, Enter — подтвердить, Esc — к списку вопросов</div>` : `
          <div class="quiz-foot">
            <button class="btn" id="prev" ${s.cur === 0 ? 'disabled' : ''}>← Назад</button>
            ${it.picked == null
              ? `<button class="btn" id="next">Пропустить →</button>`
              : `<button class="btn primary" id="next">${allDone ? 'Результаты' : 'Далее →'}</button>`}
          </div>
          <div class="hint">Клавиши: 1–${q.a.length} — ответ, Enter — далее, ← → — навигация, F — избранное</div>`}
        </div>
      </div>`;

    $app.querySelectorAll('[data-a]').forEach(b => b.onclick = () => pick(+b.dataset.a));
    $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => goTo(+b.dataset.go));
    const bind = (sel, fn) => { const el = $app.querySelector(sel); if (el) el.onclick = fn; };
    bind('#prev', () => goTo(s.cur - 1));
    bind('#next', next);
    bind('#toGrid', backToGrid);
    bind('#confirm', confirmAnswer);
    $app.querySelector('#leave').onclick = leaveQuiz;
    $app.querySelector('#fav').onclick = toggleFav;
    const fin = $app.querySelector('#finish');
    if (fin) fin.onclick = () => {
      if (!allDone && !confirm('Завершить? Неотвеченные вопросы будут засчитаны как пропущенные.')) return;
      finishTraining();
    };
    const curBtn = $app.querySelector('.qnav .cur');
    if (curBtn) curBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (s.lastCur !== s.cur) {
      if (s.lastCur != null) window.scrollTo(0, 0);
      s.lastCur = s.cur;
    }

    if (exam && !timerId) timerId = setInterval(tick, 1000);
  }

  // Экран экзамена со всеми вопросами: 4 колонки — 4 тематических блока по 5 вопросов.
  function renderExamGrid() {
    const s = session;
    const answered = s.items.filter(x => x.picked != null).length;
    const card = i => {
      const it = s.items[i], q = it.q;
      return `<button class="gcard ${it.picked != null ? 'answered' : ''}" data-open="${i}" title="${it.picked != null ? 'Ответ дан' : 'Ответить'}">
        <span class="gnum">${i + 1}</span>
        <div class="gimg">${q.img ? `<img src="${q.img}" alt="" loading="lazy">` : '<span>вопрос без изображения</span>'}</div>
        <div class="gtext">${esc(q.q)}</div>
        ${it.picked != null ? '<span class="gdone">✓ ответ дан</span>' : ''}
      </button>`;
    };
    const main = range(0, 3).map(b =>
      `<div class="ecol b${b}">${range(b * BLOCK_SIZE, b * BLOCK_SIZE + BLOCK_SIZE - 1).map(card).join('')}</div>`).join('');
    // дополнительные блоки идут после 20 основных, по 5 вопросов на блок с ошибкой
    const extras = [];
    for (let i = 20; i < s.items.length; i += BLOCK_SIZE) {
      extras.push(`<div class="ecol b${s.items[i].block}">${range(i, i + BLOCK_SIZE - 1).map(card).join('')}</div>`);
    }

    $app.innerHTML = `
      <div class="quiz-head">
        <div class="quiz-title">${esc(s.title)}<small>${esc(s.subtitle || '')} · нажмите на вопрос, чтобы ответить</small></div>
        <div class="quiz-stats">
          <span class="badge">Отвечено ${answered} из ${s.items.length}</span>
          <span class="timer" id="timer">${fmtTime(s.deadline - Date.now())}</span>
          <button class="btn small" id="leave">Выйти</button>
        </div>
      </div>
      ${extras.length ? `
        <h2 style="margin-top:4px">Дополнительные вопросы <span class="badge bad">ошибаться нельзя</span></h2>
        <div class="egrid">${extras.join('')}</div>
        <h2>Основные вопросы</h2>` : ''}
      <div class="egrid">${main}</div>`;

    $app.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
      s.gridScroll = window.scrollY;
      openExamQuestion(+b.dataset.open);
    });
    $app.querySelector('#leave').onclick = leaveQuiz;
    window.scrollTo(0, s.gridScroll || 0);
    s.gridScroll = 0;
    s.lastCur = null;
    if (!timerId) timerId = setInterval(tick, 1000);
  }

  function toggleFav() {
    const id = session.items[session.cur].q.id;
    const i = store.fav.indexOf(id);
    i >= 0 ? store.fav.splice(i, 1) : store.fav.push(id);
    save();
    render();
  }

  function reviewHtml(items, onlyWrong) {
    const list = items.map((it, i) => ({ it, i })).filter(({ it }) => !onlyWrong || !isRight(it));
    if (!list.length) return '<p class="empty-state">Ошибок нет 🎉</p>';
    return `<div class="review">${list.map(({ it, i }) => {
      const q = it.q;
      const cls = it.picked == null ? 'skip' : isRight(it) ? '' : 'bad';
      return `<div class="review-item ${cls}">
        <div class="qmeta"><span>${i + 1}. Билет ${q.t}, вопрос ${q.n}${it.extra ? ' · доп.' : ''}</span></div>
        ${q.img ? `<img src="${q.img}" alt="" loading="lazy">` : ''}
        <div class="q">${esc(q.q)}</div>
        <div class="ans">
          ${it.picked == null ? '<span class="w">Нет ответа</span>' : isRight(it) ? '' : `<div class="w">Ваш ответ: ${esc(q.a[it.picked])}</div>`}
          <div class="r">Правильно: ${esc(q.a[q.c])}</div>
        </div>
        <details><summary>Пояснение</summary>${esc(q.tip)}</details>
      </div>`;
    }).join('')}</div>`;
  }

  function renderResult() {
    const s = session;
    if (!s || !s.finished) return go('#/');
    const ok = s.items.filter(isRight).length;
    const total = s.items.length;
    const wrong = s.items.filter(it => it.picked != null && !isRight(it)).length;
    const skipped = total - ok - wrong;
    const exam = s.kind === 'exam';
    const pass = exam ? s.pass : wrong + skipped <= 2;
    const sr = s.series;

    let seriesHtml = '';
    if (sr) {
      const fails = seriesFails(sr), allow = seriesAllow(sr);
      const verdict = !sr.over
        ? `<span class="badge">не сдано ${fails}, ${failsText(allow)}</span>`
        : fails > allow
          ? `<span class="badge bad">Серия не пройдена: не сдано ${fails} из ${sr.k}, разрешено ${allow}</span>`
          : `<span class="badge ok">Серия пройдена: сдано ${sr.k - fails} из ${sr.set.count}</span>`;
      seriesHtml = `
        <div class="panel" style="margin-top:16px;text-align:left">
          <b>Серия: ${sr.k} из ${sr.set.count}</b> ${verdict}
          <table class="series-table">
            <tr><th>№</th><th>Результат</th><th>Ошибки</th><th>Время</th></tr>
            ${sr.results.map((r, i) => `<tr><td>${i + 1}</td><td>${r.pass ? '<span class="badge ok">Сдан</span>' : '<span class="badge bad">Не сдан</span>'}</td><td>${r.errors} из ${r.total}</td><td>${fmtTime(r.time)}</td></tr>`).join('')}
            <tr><td></td><td><b>Среднее</b></td><td>${(sr.results.reduce((a, r) => a + r.errors, 0) / sr.results.length).toFixed(1)}</td><td><b>${fmtTime(avgTime(sr.results))}</b></td></tr>
          </table>
        </div>`;
    }

    $app.innerHTML = `
      <div class="panel result ${pass ? 'pass' : 'fail'}">
        <div class="big">${pass ? '🎉' : '😕'}</div>
        <h1>${exam ? (pass ? 'Экзамен сдан' : 'Экзамен не сдан') : esc(s.title)}</h1>
        <p class="lead" style="margin:0">${exam ? esc(s.reason) : 'Тренировка завершена'}</p>
        <div class="kpis">
          <div class="kpi"><b style="color:var(--ok)">${ok}</b><span>верно</span></div>
          <div class="kpi"><b style="color:var(--bad)">${wrong}</b><span>ошибок</span></div>
          ${skipped ? `<div class="kpi"><b style="color:var(--warn)">${skipped}</b><span>без ответа</span></div>` : ''}
          ${exam ? `<div class="kpi"><b>${fmtTime(s.timeSpent)}</b><span>время</span></div>` : ''}
        </div>
        <div class="row" style="justify-content:center">
          ${sr && store.series ? `<button class="btn primary" id="nextExam">Следующий экзамен (${sr.k + 1} из ${sr.set.count}) →</button>` : ''}
          ${!sr ? `<button class="btn ${exam ? 'primary' : ''}" id="again">${exam ? 'Новый экзамен' : 'Ещё раз'}</button>` : ''}
          ${sr && !store.series ? `<a class="btn primary" href="#/series">Новая серия</a>` : ''}
          ${wrong + skipped ? `<button class="btn" id="retryWrong">Решить ошибки (${wrong + skipped})</button>` : ''}
          <a class="btn" href="#/">На главную</a>
        </div>
      </div>
      ${seriesHtml}
      <h2>Разбор <label style="font-size:14px;font-weight:400;color:var(--muted);margin-left:10px"><input type="checkbox" id="showAll"> показать все вопросы</label></h2>
      <div id="review">${reviewHtml(s.items, true)}</div>`;

    $app.querySelector('#showAll').onchange = e => { $app.querySelector('#review').innerHTML = reviewHtml(s.items, !e.target.checked); };
    const nextExam = $app.querySelector('#nextExam');
    if (nextExam) nextExam.onclick = runSeries;
    const again = $app.querySelector('#again');
    if (again) again.onclick = () => {
      if (exam) return homeAction('exam');
      const qs = s.items.map(it => it.q);
      startTraining({ title: s.title, subtitle: s.subtitle, questions: s.tag && s.tag.type === 'marathon' ? shuffle(qs) : qs, tag: s.tag && s.tag.type !== 'marathon' ? s.tag : null });
    };
    const rw = $app.querySelector('#retryWrong');
    if (rw) rw.onclick = () => startTraining({
      title: 'Ошибки: ' + s.title, subtitle: 'Повтор',
      questions: s.items.filter(it => !isRight(it)).map(it => it.q),
    });
  }

  function renderStats() {
    const exams = store.exams;
    const timed = exams.filter(e => e.time > 0);
    const passedEx = timed.filter(e => e.pass);
    $app.innerHTML = `
      <a class="back" href="#/">← Все режимы</a>
      <h1>Статистика</h1>
      ${kpisHtml()}
      ${timed.length ? `
      <h2>Время экзамена</h2>
      <div class="kpis" style="justify-content:flex-start">
        <div class="kpi"><b>${fmtTime(avgTime(timed))}</b><span>в среднем (${timed.length} ${plural(timed.length, 'экзамен', 'экзамена', 'экзаменов')})</span></div>
        <div class="kpi"><b>${passedEx.length ? fmtTime(avgTime(passedEx)) : '—'}</b><span>в среднем у сданных</span></div>
        <div class="kpi"><b>${fmtTime(Math.min(...timed.map(e => e.time)))}</b><span>самый быстрый</span></div>
        <div class="kpi"><b>${fmtTime(avgTime(timed.slice(0, 5)))}</b><span>последние 5</span></div>
      </div>` : ''}
      <h2>Билеты</h2>
      <div class="tickets">
        ${range(1, TICKET_COUNT).map(t => {
          const r = store.tickets[t];
          const cls = r ? (r.total - r.ok <= 2 ? 'done-ok' : 'done-bad') : '';
          return `<a class="ticket ${cls}" href="#/tickets"><b>${t}</b><small>${r ? `${r.ok}/${r.total}` : '—'}</small></a>`;
        }).join('')}
      </div>
      <h2>Темы</h2>
      <div class="list">
        ${TOPICS.map(t => {
          const qs = ALL.filter(q => q.top.includes(t.name));
          const ok = qs.filter(q => store.stats[q.id] && store.stats[q.id].last).length;
          return `<div class="list-item"><div style="flex:1">${esc(t.name)}<div class="bar"><i style="width:${ok / qs.length * 100}%"></i></div></div><span class="meta">${ok}/${qs.length}</span></div>`;
        }).join('')}
      </div>
      <h2>Последние экзамены</h2>
      ${exams.length ? `<div class="panel"><table class="series-table">
        <tr><th>Дата</th><th>Результат</th><th>Ошибки</th><th>Время</th></tr>
        ${exams.slice(0, 20).map(e => `<tr>
          <td>${new Date(e.date).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${e.series ? ' · серия' : ''}</td>
          <td>${e.pass ? '<span class="badge ok">Сдан</span>' : '<span class="badge bad">Не сдан</span>'}</td>
          <td>${e.errors} из ${e.total}</td><td>${fmtTime(e.time || 0)}</td></tr>`).join('')}
      </table></div>` : '<p class="empty-state">Экзаменов ещё не было</p>'}
      <div style="margin-top:28px"><button class="btn" id="reset">Сбросить весь прогресс</button></div>`;
    $app.querySelector('#reset').onclick = () => {
      if (!confirm('Удалить всю статистику, ошибки, избранное и прогресс марафона?')) return;
      Object.assign(store, { stats: {}, mistakes: [], fav: [], tickets: {}, topics: {}, exams: [], marathon: null, series: null });
      save();
      render();
    };
  }

  function renderExternal() {
    $app.innerHTML = `
      <a class="back" href="#/">← Все режимы</a>
      <h1>Экзамен на pdd-exam.ru</h1>
      <p class="lead">Внешний виджет. Статистика и режимы этого сайта на него не распространяются.
        <a href="https://pdd-exam.ru/gibdd-exam/" target="_blank" rel="noopener">Открыть в новой вкладке</a></p>
      <iframe class="ext-frame" src="https://pdd-exam.ru/gibdd-exam/" title="Экзамен как в ГИБДД онлайн" loading="lazy"></iframe>`;
  }

  // ---------- клавиатура ----------
  document.addEventListener('keydown', e => {
    if (!session || session.finished || location.hash !== '#/quiz') return;
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target.matches && e.target.matches('input, textarea'))) return;
    const it = session.items[session.cur];
    if (session.kind === 'exam') {
      if (session.view !== 'question') return;
      if (/^[1-5]$/.test(e.key)) {
        const orig = it.order[+e.key - 1];
        if (orig != null) pick(orig);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirmAnswer();
      } else if (e.key === 'Escape') {
        backToGrid();
      }
      return;
    }
    if (/^[1-5]$/.test(e.key)) {
      const orig = it.order[+e.key - 1];
      if (orig != null) pick(orig);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowRight') {
      goTo(session.cur + 1);
    } else if (e.key === 'ArrowLeft') {
      goTo(session.cur - 1);
    } else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
      toggleFav();
    }
  });

  window.addEventListener('hashchange', () => {
    if (location.hash !== '#/quiz') document.querySelectorAll('.toast').forEach(t => t.remove());
    render();
    window.scrollTo(0, 0);
  });
  render();
})();
