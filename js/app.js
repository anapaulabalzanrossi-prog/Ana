import { store, initStore } from './store.js';
import { gcal } from './gcal.js';
import { bridgeScript } from './bridge-script.js';
import { createInk } from './ink.js';
import {
  uid, esc, ymd, parseYmd, addDays, addMonths, startOfWeek, todayStr, daysUntil, fmtLong, fmtDM, fmtMonth,
  fmtWeekdayShort, fmtWeekday, fmtTime, relDate, money, greeting, debounce, compressImage, icon, toast, pad,
} from './utils.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// =====================================================================
// Configurações e padrões
// =====================================================================
const DEFAULT_STATUSES = [
  { name: 'A fazer', color: '#8F7F70' },
  { name: 'Falta documento', color: '#B8592A' },
  { name: 'Falta ler', color: '#5F7299' },
  { name: 'Fazer petição', color: '#6B1E2E' },
  { name: 'Em revisão', color: '#A9822F' },
  { name: 'Protocolar', color: '#4F7A4A' },
  { name: 'Aguardando cliente', color: '#86689C' },
  { name: 'Aguardando decisão', color: '#4F7C84' },
  { name: 'Delegado', color: '#2F6F6A' },
];
const DEFAULT_TYPES = ['Prazo', 'Audiência', 'Reunião', 'Petição', 'Diligência', 'Ligação', 'Outro'];
const REMINDER_OPTS = [
  { m: 0, label: 'No horário' }, { m: 60, label: '1 hora antes' }, { m: 1440, label: '1 dia antes' },
  { m: 2880, label: '2 dias antes' }, { m: 4320, label: '3 dias antes' }, { m: 10080, label: '1 semana antes' },
];
const QUOTES = [
  'Uma coisa de cada vez.', 'Feito é melhor que perfeito.', 'Mente leve, agenda em dia.',
  'Respira. Você dá conta.', 'Foco no que importa hoje.', 'Pequenos passos, grandes causas.',
];

function settings() {
  const s = store.get('meta', 'settings') || {};
  return {
    name: s.name || '',
    statuses: s.statuses?.length ? s.statuses : DEFAULT_STATUSES,
    types: s.types?.length ? s.types : DEFAULT_TYPES,
    defaultReminders: s.defaultReminders ?? [1440, 0],
    gcalShow: s.gcalShow || null,
    gcalTarget: s.gcalTarget || 'primary',
    gcalUrl: s.gcalUrl || '',
    gcalKey: s.gcalKey || '',
  };
}
const saveSettings = (patch) => store.put('meta', { ...(store.get('meta', 'settings') || {}), ...patch, id: 'settings' });
const statusOf = (name) => settings().statuses.find((s) => s.name === name);

// =====================================================================
// Estado da interface
// =====================================================================
const saved = (() => { try { return JSON.parse(localStorage.getItem('ui') || '{}'); } catch { return {}; } })();
const ui = {
  view: saved.view || 'home',
  area: saved.area || 'all',
  statusFilter: '',
  taskMode: saved.taskMode || 'list',
  groupBy: saved.groupBy || 'date',
  search: '',
  showDone: false,
  agendaMode: saved.agendaMode || 'week',
  cursor: new Date(),
  ideaTag: '',
  ideaSearch: '',
  wishCat: '',
  qa: { area: saved.qaArea || 'trabalho', date: null, fatal: false },
};
const persistUi = () => { try { localStorage.setItem('ui', JSON.stringify({ view: ui.view, area: ui.area, taskMode: ui.taskMode, groupBy: ui.groupBy, agendaMode: ui.agendaMode, qaArea: ui.qa.area })); } catch { /* ok */ } };

const $view = document.getElementById('view');
let partial = null;       // função que atualiza só a lista (durante digitação)
let pendingRender = false;

// =====================================================================
// Tarefas: regras
// =====================================================================
const tasks = () => store.all('tasks');
const pending = () => tasks().filter((t) => !t.done);
const isLate = (t) => !t.done && t.date && daysUntil(t.date) < 0;
const isToday = (t) => t.date === todayStr();

function statusIndex(t) {
  const i = settings().statuses.findIndex((s) => s.name === t.status);
  return i < 0 ? 999 : i;
}
function sortTasks(a, b) {
  return (a.date || '9999').localeCompare(b.date || '9999')
    || (b.fatal ? 1 : 0) - (a.fatal ? 1 : 0)
    || (a.time || '99').localeCompare(b.time || '99')
    || (b.priority || 0) - (a.priority || 0)
    || (a.area === b.area ? 0 : a.area === 'trabalho' ? -1 : 1)
    || statusIndex(a) - statusIndex(b)
    || (a.title || '').localeCompare(b.title || '', 'pt-BR');
}

function filteredTasks() {
  const q = ui.search.trim().toLowerCase();
  return tasks().filter((t) => {
    if (ui.area !== 'all' && t.area !== ui.area) return false;
    if (ui.statusFilter && t.status !== ui.statusFilter) return false;
    if (q && ![t.title, t.client, t.process, t.notes, t.status, t.type].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}

async function saveTask(t, { silent } = {}) {
  await store.put('tasks', t);
  await syncTaskToCalendar(t);
  if (!silent) toast('Tarefa salva');
}

/** Espelha a tarefa na Google Agenda para gerar notificações */
async function syncTaskToCalendar(t) {
  if (!gcal.configured()) return;
  const wants = t.date && (t.reminders || []).length > 0;
  try {
    if (wants) {
      if (!gcal.connected()) { if (!t.gcalPending) await store.put('tasks', { ...t, gcalPending: true }); return; }
      const r = await gcal.upsertTaskEvent(t, settings().gcalTarget);
      await store.put('tasks', { ...store.get('tasks', t.id), gcalEventId: r.eventId, gcalCalendarId: r.calendarId, gcalPending: false });
    } else if (t.gcalEventId) {
      if (!gcal.connected()) { await store.put('tasks', { ...t, gcalPending: true }); return; }
      await gcal.deleteEvent(t.gcalCalendarId || 'primary', t.gcalEventId);
      await store.put('tasks', { ...store.get('tasks', t.id), gcalEventId: null, gcalPending: false });
    }
  } catch (e) {
    console.error(e);
    const cur = store.get('tasks', t.id);
    if (cur) await store.put('tasks', { ...cur, gcalPending: true });
    if (e.code !== 'nogcal') toast('Sem conexão com a Google Agenda agora. Tento de novo depois.');
  }
}

let syncingPending = false;
async function syncPendingToCalendar() {
  if (!gcal.connected() || syncingPending || !navigator.onLine) return;
  syncingPending = true;
  // Pendentes e também tarefas com data e lembrete que ainda não têm evento
  // (por exemplo, criadas antes de ligar a agenda)
  const today = todayStr();
  const todo = tasks().filter((x) => x.gcalPending || (!x.done && x.date && x.date >= today && (x.reminders || []).length && !x.gcalEventId));
  try { for (const t of todo) await syncTaskToCalendar(store.get('tasks', t.id) || t); } finally { syncingPending = false; }
}

async function toggleTask(id) {
  const t = store.get('tasks', id);
  if (!t) return;
  const done = !t.done;
  const nt = { ...t, done, doneAt: done ? Date.now() : null };
  await store.put('tasks', nt);
  if (done) toast('Concluída', { label: 'Desfazer', fn: () => toggleTask(id) });
  if (t.gcalEventId) syncTaskToCalendar(nt);
}

async function deleteTask(id) {
  const t = store.get('tasks', id);
  if (!t) return;
  await store.remove('tasks', id);
  if (t.gcalEventId && gcal.connected()) gcal.deleteEvent(t.gcalCalendarId || 'primary', t.gcalEventId).catch(() => {});
  toast('Tarefa excluída', { label: 'Desfazer', fn: () => store.put('tasks', { ...t, gcalEventId: null }).then(() => syncTaskToCalendar(t)) });
}

function newTask(partialTask = {}) {
  const area = partialTask.area || (ui.area !== 'all' ? ui.area : ui.qa.area);
  const t = {
    id: uid(), title: '', notes: '', area, date: null, time: null, fatal: false, priority: 0,
    status: area === 'trabalho' ? settings().statuses[0].name : '', type: '', client: '', process: '',
    checklist: [], done: false, reminders: [], ...partialTask,
  };
  if (t.date && !partialTask.reminders) t.reminders = defaultReminders(t);
  return t;
}
function defaultReminders(t) {
  const r = new Set(settings().defaultReminders);
  if (t.fatal) { r.add(4320); r.add(1440); r.add(0); }
  return [...r].sort((a, b) => b - a);
}

// =====================================================================
// Google Agenda: eventos visíveis
// =====================================================================
const inflight = new Map();
function visibleCalendars() {
  let cals = [];
  try { cals = JSON.parse(localStorage.getItem('gcal-cals') || '[]'); } catch { /* */ }
  const show = settings().gcalShow;
  if (!cals.length) return [{ id: 'primary', color: '#6B1E2E' }];
  return cals.filter((c) => (show ? show.includes(c.id) : c.selected));
}
async function refreshCalendars() {
  try {
    const cals = await gcal.listCalendars();
    localStorage.setItem('gcal-cals', JSON.stringify(cals));
  } catch (e) { console.warn(e); }
}

/** Eventos no intervalo; usa cache e busca em segundo plano */
function eventsIn(start, end) {
  if (!gcal.configured()) return [];
  const cals = visibleCalendars();
  const cached = gcal.cachedEvents(start, end, cals) || [];
  const k = ymd(start) + ymd(end);
  if (gcal.connected() && !inflight.has(k)) {
    const p = gcal.listEvents(start, end, cals)
      .then(() => { setTimeout(() => inflight.delete(k), 60000); render(); })
      .catch((e) => { inflight.delete(k); console.warn(e); });
    inflight.set(k, p);
  }
  const taskIds = new Set(tasks().map((t) => t.id));
  return cached.filter((e) => !(e.taskId && taskIds.has(e.taskId)));
}
const eventsOn = (list, day) => list.filter((e) => e.date <= day && (e.endDate || e.date) >= day);

// =====================================================================
// Renderização
// =====================================================================
const NAV = [
  { id: 'home', label: 'Hoje', icon: 'home' },
  { id: 'tasks', label: 'Tarefas', icon: 'tasks' },
  { id: 'agenda', label: 'Agenda', icon: 'cal' },
  { id: 'ideas', label: 'Ideias', icon: 'idea' },
  { id: 'wish', label: 'Wishlist', icon: 'gift' },
];

function go(view) { ui.view = view; ui.search = ''; persistUi(); render(); document.querySelector('.main').scrollTop = 0; }

function render() {
  renderChrome();
  const a = document.activeElement;
  if (a && $view.contains(a) && a.matches('input:not([type=checkbox]):not([type=date]):not([type=time]):not([type=file]), textarea')) {
    pendingRender = true;
    if (partial) partial();
    return;
  }
  pendingRender = false;
  partial = null;
  const fn = { home: viewHome, tasks: viewTasks, agenda: viewAgenda, ideas: viewIdeas, wish: viewWish }[ui.view] || viewHome;
  fn();
}
$view.addEventListener('focusout', () => setTimeout(() => {
  const a = document.activeElement;
  if (pendingRender && !(a && $view.contains(a) && a.matches('input, textarea'))) render();
}, 120));

function renderChrome() {
  const todayCount = pending().filter((t) => t.date && daysUntil(t.date) <= 0).length;
  const counts = { tasks: todayCount || '' };
  const user = store.user();
  const q = QUOTES[new Date().getDate() % QUOTES.length];
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><div class="brand-mark">A</div><div><div class="brand-name">Minha Agenda</div><div class="brand-sub">Pessoal · Trabalho</div></div></div>
    <nav class="nav">${NAV.map((n) => `<button class="nav-item ${ui.view === n.id ? 'active' : ''}" data-go="${n.id}">${icon(n.icon)}<span>${n.label}</span>${counts[n.id] ? `<span class="count">${counts[n.id]}</span>` : ''}</button>`).join('')}</nav>
    <div class="side-bottom">
      <div class="side-quote">${esc(q)}</div>
      <div class="sync-pill"><span class="sync-dot ${store.isCloud() ? 'on' : ''}"></span>${store.isCloud() ? 'Sincronizado' + (user?.email ? '' : '') : 'Salvo neste aparelho'}</div>
      <button class="nav-item" data-act="settings">${icon('gear')}<span>Ajustes</span></button>
    </div>`;
  document.getElementById('tabbar').innerHTML = NAV.map((n) => `<button class="tab ${ui.view === n.id ? 'active' : ''}" data-go="${n.id}">${icon(n.icon)}<span>${n.label}</span></button>`).join('');
  renderBanner();
}

function renderBanner() {
  const el = document.getElementById('banner');
  if (store.cloudAvailable() && store.authKnown() && !store.user()) {
    el.innerHTML = `<div class="banner">${icon('cloud')}<span class="grow"><b>Este aparelho não está sincronizado.</b> O que você fizer aqui não aparece nos outros aparelhos.</span><button data-act="login">Entrar com Google</button></div>`;
    return;
  }
  const dismissed = localStorage.getItem('banner-dismissed') === todayStr();
  const urgent = pending().filter((t) => t.fatal && t.date && daysUntil(t.date) <= 1).sort(sortTasks);
  if (!urgent.length || dismissed) { el.innerHTML = ''; return; }
  const t = urgent[0];
  const n = daysUntil(t.date);
  const when = n < 0 ? 'venceu' : n === 0 ? 'vence hoje' : 'vence amanhã';
  el.innerHTML = `<div class="banner">${icon('scale')}<span class="grow"><b>Prazo fatal ${when}:</b> ${esc(t.title)}${urgent.length > 1 ? ` <span style="opacity:.75">(+${urgent.length - 1})</span>` : ''}</span><button data-open-task="${t.id}">Abrir</button><button data-act="dismiss-banner" aria-label="Dispensar">${icon('x')}</button></div>`;
}

// ---------------------------------------------------------------------
// Componentes
// ---------------------------------------------------------------------
const checkBtn = (on, act, id) => `<button class="check ${on ? 'on' : ''}" data-act="${act}" data-id="${id}" aria-label="Concluir">${icon('check')}</button>`;

function statusSelect(t) {
  const st = statusOf(t.status);
  const c = st?.color || '#8F7F70';
  return `<select class="pill-select" data-status-for="${t.id}" style="background-color:${c}1f;color:${c}">
    ${t.status && !st ? `<option selected>${esc(t.status)}</option>` : ''}
    ${t.area !== 'trabalho' ? `<option value="" ${!t.status ? 'selected' : ''}>Sem status</option>` : ''}
    ${settings().statuses.map((s) => `<option ${s.name === t.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
  </select>`;
}

function datePill(t) {
  if (!t.date) return '';
  const n = daysUntil(t.date);
  const tm = t.time ? ` · ${t.time}` : '';
  if (t.fatal && !t.done) {
    const txt = n < 0 ? `venceu há ${-n} dia${n < -1 ? 's' : ''}` : n === 0 ? 'vence hoje' : n === 1 ? 'vence amanhã' : `faltam ${n} dias`;
    return `<span class="pill fatal">${icon('scale')} Prazo fatal · ${txt}</span>`;
  }
  if (!t.done && n < 0) return `<span class="pill late">Atrasada · ${fmtDM(parseYmd(t.date))}${tm}</span>`;
  if (n === 0) return `<span class="pill today">Hoje${tm}</span>`;
  return `<span class="mi">${icon('clock')} ${relDate(t.date)}${tm}</span>`;
}

function taskRow(t) {
  const cl = t.checklist || [];
  const clDone = cl.filter((c) => c.done).length;
  return `<div class="task ${t.area === 'trabalho' ? 'work' : 'personal'} ${t.done ? 'done' : ''}" data-open-task="${t.id}" data-swipe="${t.id}"><div class="task-inner">
    ${checkBtn(t.done, 'toggle-task', t.id)}
    <div class="task-body">
      <div class="task-title">${esc(t.title)}${t.priority ? ` <span class="prio">${'!'.repeat(t.priority)}</span>` : ''}</div>
      <div class="task-meta">
        ${t.status || t.area === 'trabalho' ? statusSelect(t) : ''}
        ${datePill(t)}
        ${t.type ? `<span class="mi">${esc(t.type)}</span>` : ''}
        ${t.client ? `<span class="mi">${icon('user')} ${esc(t.client)}</span>` : ''}
        ${t.process ? `<span class="mi">${icon('folder')} ${esc(t.process)}</span>` : ''}
        ${cl.length ? `<span class="mi sub-progress">${icon('checklist')} ${clDone}/${cl.length}</span>` : ''}
        ${t.gcalEventId && t.reminders?.length && !t.done ? `<span class="mi" title="Lembrete na Google Agenda">${icon('bell')}</span>` : ''}
      </div>
    </div>
  </div></div>`;
}

const areaChips = (cur, attr = 'data-area') => `<div class="chips">
  <button class="chip ${cur === 'all' ? 'on' : ''}" ${attr}="all">Tudo</button>
  <button class="chip ${cur === 'trabalho' ? 'on' : ''}" ${attr}="trabalho"><span class="dot" style="background:var(--wine)"></span>Trabalho</button>
  <button class="chip ${cur === 'pessoal' ? 'on' : ''}" ${attr}="pessoal"><span class="dot" style="background:var(--gold-bright)"></span>Pessoal</button>
</div>`;

// ---------------------------------------------------------------------
// HOJE
// ---------------------------------------------------------------------
function viewHome() {
  const s = settings();
  const name = s.name || store.user()?.name?.split(' ')[0] || '';
  const today = todayStr();
  const p = pending();
  const late = p.filter(isLate).sort(sortTasks);
  const todays = p.filter(isToday).sort(sortTasks);
  const doneToday = tasks().filter((t) => t.done && t.doneAt && ymd(new Date(t.doneAt)) === today).length;
  const fatals = p.filter((t) => t.fatal && t.date && daysUntil(t.date) <= 30).sort(sortTasks);
  const evs = eventsIn(new Date(), addDays(new Date(), 1)).filter((e) => e.date === today || (e.allDay && eventsOn([e], today).length));
  const work = p.filter((t) => t.area === 'trabalho');
  const byStatus = s.statuses.map((st) => ({ ...st, n: work.filter((t) => t.status === st.name).length })).filter((x) => x.n);
  const max = Math.max(1, ...byStatus.map((x) => x.n));
  const wk = store.get('weeks', ymd(startOfWeek(new Date()))) || {};
  const prios = (wk.priorities || []).filter((x) => x.t);

  $view.innerHTML = `
  <div class="dash">
    <section class="card hero span-12">
      <h2>${greeting()}${name ? `, ${esc(name)}` : ''}</h2>
      <div class="date">${cap(fmtLong(new Date()))}</div>
      <div class="stats">
        <button class="stat" data-go="tasks"><b>${todays.length}</b><span>para hoje</span></button>
        <button class="stat ${late.length ? 'alert' : ''}" data-go="tasks"><b>${late.length}</b><span>atrasadas</span></button>
        <button class="stat" data-go="tasks"><b>${fatals.filter((t) => daysUntil(t.date) <= 7).length}</b><span>prazos em 7 dias</span></button>
        <button class="stat" data-go="agenda"><b>${evs.length}</b><span>na agenda</span></button>
        <div class="stat hide-sm"><b>${doneToday}</b><span>feitas hoje</span></div>
      </div>
      <form class="capture" data-form="capture">
        <input class="input" id="capture-input" placeholder="O que precisa fazer hoje?" autocomplete="off" enterkeyhint="done">
        <button class="btn gold" type="submit">${icon('plus')}<span>Tarefa</span></button>
        <button class="btn ghost" type="button" data-act="capture-idea" style="color:#F6E7D2">${icon('idea')}<span>Ideia</span></button>
      </form>
    </section>

    <section class="card span-7">
      <div class="card-title">Hoje <button class="link" data-act="new-task-today">+ tarefa</button></div>
      ${evs.length ? `<div class="list-plain" style="margin-bottom:12px">${evs.map((e) => `<div class="mini-evt" data-evt="${esc(e.key || e.id)}"><span class="tm g">${e.allDay ? 'dia' : fmtTime(new Date(e.start))}</span><span>${esc(e.title)}</span></div>`).join('')}</div>` : ''}
      ${late.length + todays.length ? `<div class="task-list">${[...late, ...todays].map(taskRow).join('')}</div>`
        : `<div class="empty"><span class="big">Dia livre de pendências</span>Nada vencendo hoje. Aproveite para adiantar a semana.</div>`}
    </section>

    <section class="card span-5">
      <div class="card-title">Prazos fatais <button class="link" data-act="filter-fatal">ver todos</button></div>
      ${fatals.length ? fatals.slice(0, 6).map((t) => {
        const n = daysUntil(t.date);
        return `<div class="deadline" data-open-task="${t.id}">
          <div class="countdown ${n < 0 ? 'late' : n <= 3 ? 'urgent' : ''}"><b>${Math.abs(n)}</b><span>${n < 0 ? 'atraso' : n === 1 ? 'dia' : 'dias'}</span></div>
          <div><div class="t">${esc(t.title)}</div><div class="m">${fmtWeekdayShort(parseYmd(t.date))}, ${fmtDM(parseYmd(t.date))}${t.client ? ` · ${esc(t.client)}` : ''}${t.status ? ` · ${esc(t.status)}` : ''}</div></div>
        </div>`;
      }).join('') : `<div class="empty">Nenhum prazo fatal nos próximos 30 dias.<br>Marque "Prazo fatal" ao criar uma tarefa.</div>`}
    </section>

    <section class="card span-6">
      <div class="card-title">Trabalho por status</div>
      ${byStatus.length ? `<div class="status-bars">${byStatus.map((x) => `
        <div class="sbar" data-status-filter="${esc(x.name)}"><span class="n">${esc(x.name)}</span><span class="c">${x.n}</span>
        <div class="track"><div class="fill" style="width:${(x.n / max) * 100}%;background:${x.color}"></div></div></div>`).join('')}</div>`
        : `<div class="empty">Sem tarefas de trabalho pendentes.</div>`}
    </section>

    <section class="card span-6">
      <div class="card-title">Prioridades da semana <button class="link" data-act="go-week">abrir semana</button></div>
      ${prios.length ? `<div class="list-plain">${prios.map((x) => `<div class="ptask ${x.done ? 'done' : ''}" style="padding:6px 0"><span class="check ${x.done ? 'on' : ''}" style="width:20px;height:20px">${icon('check')}</span><span>${esc(x.t)}</span></div>`).join('')}</div>`
        : `<div class="empty">Defina até 5 prioridades na visão semanal da Agenda.</div>`}
    </section>
  </div>`;
}

// ---------------------------------------------------------------------
// TAREFAS
// ---------------------------------------------------------------------
function viewTasks() {
  const s = settings();
  const qa = ui.qa;
  const qaDateLabel = qa.date ? (qa.date === todayStr() ? 'Hoje' : relDate(qa.date)) : 'Data';
  $view.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Tarefas</h1><div class="page-sub">${pending().length} pendentes</div></div>
    <div class="head-actions">
      <div class="seg"><button class="${ui.taskMode === 'list' ? 'on' : ''}" data-taskmode="list">${icon('list')}</button><button class="${ui.taskMode === 'board' ? 'on' : ''}" data-taskmode="board">Por status</button></div>
      <button class="icon-btn" data-act="settings" title="Ajustes">${icon('gear')}</button>
    </div>
  </div>

  <form class="card quickadd" data-form="quickadd">
    <div class="row1">
      <input class="input" id="qa-input" placeholder="Nova tarefa… (ex.: Contestação — Silva x Banco)" autocomplete="off" enterkeyhint="done">
      <button class="btn primary" type="submit">${icon('plus')}<span>Adicionar</span></button>
      <button class="btn" type="button" data-act="paste-list" title="Colar várias tarefas">${icon('list')}<span class="hide-xs">Várias</span></button>
    </div>
    <div class="opts">
      <button type="button" class="chip ${qa.area === 'trabalho' ? 'on' : ''}" data-qa-area="trabalho"><span class="dot" style="background:${qa.area === 'trabalho' ? '#E3CB8F' : 'var(--wine)'}"></span>Trabalho</button>
      <button type="button" class="chip ${qa.area === 'pessoal' ? 'on' : ''}" data-qa-area="pessoal"><span class="dot" style="background:var(--gold-bright)"></span>Pessoal</button>
      <span class="sep"></span>
      <button type="button" class="chip ${qa.date === todayStr() ? 'on' : ''}" data-qa-date="${todayStr()}">Hoje</button>
      <button type="button" class="chip ${qa.date === ymd(addDays(new Date(), 1)) ? 'on' : ''}" data-qa-date="${ymd(addDays(new Date(), 1))}">Amanhã</button>
      <label class="chip date-chip-input ${qa.date && qa.date !== todayStr() && qa.date !== ymd(addDays(new Date(), 1)) ? 'on' : ''}">${icon('cal')} ${qa.date && qa.date !== todayStr() && qa.date !== ymd(addDays(new Date(), 1)) ? qaDateLabel : 'Data'}<input type="date" id="qa-date" value="${qa.date || ''}"></label>
      <button type="button" class="chip ${qa.fatal ? 'on' : ''}" data-act="qa-fatal">${icon('scale')} Prazo fatal</button>
      ${qa.area === 'trabalho' ? `<span class="sep"></span><select class="pill-select" id="qa-status" style="height:32px;border-radius:16px;background-color:#EFE5D3;color:var(--ink)">${s.statuses.map((x) => `<option ${x.name === qa.status ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
    </div>
  </form>

  <div class="toolbar">
    <div class="chips">
      ${areaChips(ui.area)}
      <select class="pill-select" id="status-filter" style="height:32px;border-radius:16px;background-color:${ui.statusFilter ? 'var(--wine)' : 'var(--paper)'};color:${ui.statusFilter ? '#FFF4E4' : 'var(--muted)'};border:1px solid var(--line-strong)">
        <option value="">Todos os status</option>
        ${s.statuses.map((x) => `<option ${x.name === ui.statusFilter ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select>
    </div>
    ${ui.taskMode === 'list' ? `<div class="seg" title="Agrupar por"><button class="${ui.groupBy === 'date' ? 'on' : ''}" data-groupby="date">Data</button><button class="${ui.groupBy === 'status' ? 'on' : ''}" data-groupby="status">Status</button><button class="${ui.groupBy === 'client' ? 'on' : ''}" data-groupby="client">Cliente</button></div>` : ''}
    <label class="search">${icon('search')}<input class="input" id="task-search" type="search" placeholder="Buscar cliente, processo…" value="${esc(ui.search)}"></label>
  </div>
  <div id="task-results"></div>`;

  const results = document.getElementById('task-results');
  partial = () => { results.innerHTML = ui.taskMode === 'board' ? boardHTML() : taskListHTML(); };
  partial();
}

function taskListHTML() {
  const list = filteredTasks();
  const open = list.filter((t) => !t.done).sort(sortTasks);
  const done = list.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const in7 = ymd(addDays(new Date(), 7));
  const tomorrow = ymd(addDays(new Date(), 1));
  let groups;
  if (ui.groupBy === 'status') {
    const sts = settings().statuses;
    groups = [
      ...sts.map((st) => ({ k: st.name, color: st.color, items: open.filter((t) => t.status === st.name) })),
      { k: 'Sem status', items: open.filter((t) => !sts.some((st) => st.name === t.status)) },
    ].filter((g) => g.items.length);
  } else if (ui.groupBy === 'client') {
    const by = new Map();
    for (const t of open) {
      const k = t.area === 'pessoal' ? '~Pessoal' : (t.client || '').trim() || '~Sem cliente';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(t);
    }
    groups = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([k, items]) => ({ k: k.replace(/^~/, ''), items }));
  } else groups = [
    { k: 'Atrasadas', cls: 'late', items: open.filter(isLate) },
    { k: 'Hoje', items: open.filter(isToday) },
    { k: 'Amanhã', items: open.filter((t) => t.date === tomorrow) },
    { k: 'Próximos 7 dias', items: open.filter((t) => t.date > tomorrow && t.date <= in7) },
    { k: 'Mais adiante', items: open.filter((t) => t.date > in7) },
    { k: 'Sem data · trabalho', items: open.filter((t) => !t.date && t.area === 'trabalho') },
    { k: 'Sem data · pessoal', items: open.filter((t) => !t.date && t.area !== 'trabalho') },
  ].filter((g) => g.items.length);
  if (!open.length && !done.length) {
    return `<div class="card empty"><span class="big">${ui.search || ui.statusFilter ? 'Nada encontrado' : 'Tudo em ordem'}</span>${ui.search || ui.statusFilter ? 'Tente outro filtro.' : 'Use o campo acima para anotar a primeira tarefa.'}</div>`;
  }
  return groups.map((g) => `<div class="group"><div class="group-head ${g.cls || ''}">${g.color ? `<span style="width:9px;height:9px;border-radius:50%;background:${g.color}"></span>` : ''}${esc(g.k)}<span class="n">${g.items.length}</span></div><div class="task-list">${g.items.map(taskRow).join('')}</div></div>`).join('')
    + (done.length ? `<div class="group"><div class="group-head">Concluídas<span class="n">${done.length}</span><button data-act="toggle-done">${ui.showDone ? 'Ocultar' : 'Mostrar'}</button></div>${ui.showDone ? `<div class="task-list">${done.slice(0, 50).map(taskRow).join('')}</div>` : ''}</div>` : '');
}

function boardHTML() {
  const list = filteredTasks().filter((t) => !t.done);
  const sts = settings().statuses;
  const cols = [...sts.map((s) => ({ ...s, items: list.filter((t) => t.status === s.name) }))];
  const orphan = list.filter((t) => !sts.some((s) => s.name === t.status));
  if (orphan.length) cols.unshift({ name: '', color: '#B5A795', items: orphan });
  return `<div class="board">${cols.map((c) => `
    <div class="col" data-col="${esc(c.name)}">
      <div class="col-head"><span class="dot" style="background:${c.color}"></span>${esc(c.name || 'Sem status')}<span class="n">${c.items.length}</span></div>
      <div class="col-body">${c.items.sort(sortTasks).map((t) => `
        <div class="bcard ${t.area === 'trabalho' ? 'work' : 'personal'}" draggable="true" data-drag="${t.id}" data-open-task="${t.id}">
          <div class="t">${esc(t.title)}</div>
          <div class="m">${datePill(t)}${t.client ? `<span>${icon('user')} ${esc(t.client)}</span>` : ''}${t.process ? `<span>${esc(t.process)}</span>` : ''}</div>
        </div>`).join('')}</div>
      <button class="col-add" data-new-in-status="${esc(c.name)}">+ Adicionar</button>
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------
// AGENDA
// ---------------------------------------------------------------------
function viewAgenda() {
  const m = ui.agendaMode;
  const c = ui.cursor;
  let label;
  if (m === 'day') label = cap(fmtLong(c));
  else if (m === 'week') { const s = startOfWeek(c), e = addDays(s, 6); label = `${fmtDM(s)} – ${fmtDM(e)}`; }
  else label = cap(fmtMonth(c));

  let cta = '';
  if (!gcal.configured() && store.isCloud()) {
    cta = `<div class="gcal-cta">${icon('cal')}<span class="grow">Ligue a Google Agenda <b>uma única vez</b> para ver seus compromissos aqui e receber lembretes no celular. Depois disso, ela fica conectada para sempre.</span><button class="btn small primary" data-act="gcal-connect">Ligar</button></div>`;
  }

  $view.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Agenda</h1></div>
    <div class="head-actions">
      <div class="seg">
        <button class="${m === 'day' ? 'on' : ''}" data-amode="day">Dia</button>
        <button class="${m === 'week' ? 'on' : ''}" data-amode="week">Semana</button>
        <button class="${m === 'month' ? 'on' : ''}" data-amode="month">Mês</button>
      </div>
      ${gcal.connected() ? `<button class="btn" data-act="new-event">${icon('plus')}<span>Compromisso</span></button>` : ''}
      <button class="btn primary" data-act="new-task-cursor">${icon('plus')}<span>Tarefa</span></button>
    </div>
  </div>
  ${cta}
  <div class="toolbar">
    <div class="cal-nav">
      <button class="icon-btn" data-nav="-1" aria-label="Anterior">${icon('left')}</button>
      <button class="icon-btn" data-nav="1" aria-label="Próximo">${icon('right')}</button>
      <span class="label-range">${label}</span>
    </div>
    <div class="chips"><button class="chip" data-nav="0">Hoje</button></div>
  </div>
  <div id="agenda-body"></div>`;
  const body = document.getElementById('agenda-body');
  body.innerHTML = m === 'day' ? dayHTML() : m === 'week' ? weekHTML() : monthHTML();
  if (m === 'day') {
    const nl = body.querySelector('.now-line');
    if (nl && !viewAgenda._scrolled) { viewAgenda._scrolled = true; setTimeout(() => nl.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50); }
  }
}

const tasksOn = (day) => tasks().filter((t) => t.date === day).sort(sortTasks);

function weekHTML() {
  const s = startOfWeek(ui.cursor);
  const evs = eventsIn(s, addDays(s, 7));
  const today = todayStr();
  const wid = ymd(s);
  const wk = store.get('weeks', wid) || { id: wid, priorities: [], notes: '' };
  const pr = [...(wk.priorities || [])];
  while (pr.length < 5) pr.push({ t: '', done: false });
  const days = [...Array(7)].map((_, i) => addDays(s, i));
  return `<div class="planner">
    ${days.map((d) => {
      const k = ymd(d);
      const de = eventsOn(evs, k);
      const dt = tasksOn(k);
      return `<div class="pday ${k === today ? 'today' : ''}">
        <div class="pday-head" data-goto-day="${k}"><span class="num">${d.getDate()}</span><span class="dn">${fmtWeekday(d).replace('-feira', '')}</span><button class="add" data-new-on="${k}" aria-label="Nova tarefa">${icon('plus')}</button></div>
        <div class="pday-items">
          ${de.map((e) => `<div class="evt g" data-evt="${esc(e.key || e.id)}"><span class="tm">${e.allDay ? '' : fmtTime(new Date(e.start))}</span><span>${esc(e.title)}</span></div>`).join('')}
          ${dt.map((t) => `<div class="ptask ${t.done ? 'done' : ''}" data-open-task="${t.id}">${checkBtn(t.done, 'toggle-task', t.id)}<span>${t.fatal ? '<span class="fatal-mark">⚖ </span>' : ''}${t.time ? `<b>${t.time}</b> ` : ''}${esc(t.title)}</span></div>`).join('')}
          <div class="pday-lines" data-new-on="${k}"></div>
        </div>
      </div>`;
    }).join('')}
    <div class="pday pweek">
      <h3>Prioridades da semana</h3>
      ${pr.slice(0, 5).map((p, i) => `<div class="prio-line"><button class="check ${p.done ? 'on' : ''}" data-act="week-prio-check" data-i="${i}" data-week="${wid}">${icon('check')}</button><input type="text" value="${esc(p.t)}" placeholder="Prioridade ${i + 1}" data-week-prio="${i}" data-week="${wid}"></div>`).join('')}
      <textarea placeholder="Notas da semana…" data-week-notes="${wid}">${esc(wk.notes || '')}</textarea>
    </div>
  </div>`;
}

function monthHTML() {
  const first = new Date(ui.cursor.getFullYear(), ui.cursor.getMonth(), 1, 12);
  const start = startOfWeek(first);
  const evs = eventsIn(start, addDays(start, 42));
  const today = todayStr();
  const month = first.getMonth();
  const cells = [...Array(42)].map((_, i) => addDays(start, i));
  const trimmed = cells[35].getMonth() !== month ? cells.slice(0, 35) : cells;
  return `<div class="month">
    <div class="month-head">${['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map((d) => `<div>${d}</div>`).join('')}</div>
    <div class="month-grid">${trimmed.map((d) => {
      const k = ymd(d);
      const items = [
        ...eventsOn(evs, k).map((e) => `<div class="mitem g">${e.allDay ? '' : fmtTime(new Date(e.start)) + ' '}${esc(e.title)}</div>`),
        ...tasksOn(k).map((t) => `<div class="mitem task ${t.fatal && !t.done ? 'fatal' : ''} ${t.done ? 'done' : ''}">${esc(t.title)}</div>`),
      ];
      return `<div class="mcell ${d.getMonth() !== month ? 'out' : ''} ${k === today ? 'today' : ''}" data-goto-day="${k}">
        <span class="mnum">${d.getDate()}</span>${items.slice(0, 3).join('')}${items.length > 3 ? `<span class="mmore">+${items.length - 3}</span>` : ''}
      </div>`;
    }).join('')}</div>
  </div>`;
}

function dayHTML() {
  const d = ui.cursor;
  const k = ymd(d);
  const evs = eventsOn(eventsIn(d, addDays(d, 1)), k);
  const dt = tasksOn(k);
  const H0 = 6, H1 = 23, HH = 56;
  const timed = [
    ...evs.filter((e) => !e.allDay).map((e) => ({ kind: 'e', id: e.id, key: e.key, title: e.title, s: new Date(e.start), e: new Date(e.end) })),
    ...dt.filter((t) => t.time).map((t) => { const s = new Date(`${k}T${t.time}:00`); return { kind: 't', id: t.id, title: t.title, s, e: new Date(s.getTime() + 45 * 60000), area: t.area, done: t.done }; }),
  ].sort((a, b) => a.s - b.s);
  // distribui eventos sobrepostos em colunas
  const colsEnd = [];
  for (const it of timed) {
    let c = colsEnd.findIndex((end) => end <= it.s);
    if (c < 0) { c = colsEnd.length; colsEnd.push(0); }
    colsEnd[c] = it.e; it.col = c;
  }
  const ncol = Math.max(1, colsEnd.length);
  const pos = (date) => Math.max(0, ((date.getHours() + date.getMinutes() / 60) - H0) * HH);
  const now = new Date();
  const showNow = k === todayStr() && now.getHours() >= H0 && now.getHours() <= H1;
  return `<div class="day-wrap">
    <div class="timeline">
      ${evs.some((e) => e.allDay) ? `<div class="allday">${evs.filter((e) => e.allDay).map((e) => `<div class="evt g" data-evt="${esc(e.key || e.id)}">${esc(e.title)}</div>`).join('')}</div>` : ''}
      <div class="hours">
        ${[...Array(H1 - H0 + 1)].map((_, i) => `<div class="hour" data-new-at="${k}|${pad(H0 + i)}:00"><span class="hl">${pad(H0 + i)}:00</span></div>`).join('')}
        ${timed.map((it) => {
          const top = pos(it.s), h = Math.max(26, pos(it.e) - top - 2);
          const w = `calc((100% - 74px) / ${ncol})`;
          const attr = it.kind === 'e' ? `data-evt="${esc(it.key || it.id)}"` : `data-open-task="${it.id}"`;
          return `<div class="tblock ${it.kind === 'e' ? 'g' : it.area === 'pessoal' ? 'personal' : ''}" ${attr} style="top:${top}px;height:${h}px;left:calc(66px + ${w} * ${it.col});right:auto;width:calc(${w} - 4px);${it.done ? 'opacity:.55;text-decoration:line-through' : ''}"><div class="tm">${fmtTime(it.s)}</div>${esc(it.title)}</div>`;
        }).join('')}
        ${showNow ? `<div class="now-line" style="top:${pos(now)}px"></div>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Tarefas do dia <button class="link" data-new-on="${k}">+ tarefa</button></div>
      ${dt.length ? `<div class="task-list">${dt.map(taskRow).join('')}</div>` : '<div class="empty">Nenhuma tarefa para este dia.</div>'}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------
// IDEIAS
// ---------------------------------------------------------------------
const tagsOf = (text) => [...new Set((text.match(/#[\p{L}\p{N}_-]+/gu) || []).map((t) => t.slice(1).toLowerCase()))];

function viewIdeas() {
  const all = store.all('ideas');
  const tags = [...new Set(all.flatMap((i) => i.tags || []))].sort();
  $view.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Ideias</h1><div class="page-sub">Solte aqui o que passar pela cabeça</div></div>
    <div class="head-actions"><button class="btn" data-act="new-ink">${icon('pen')}<span>Escrever à mão</span></button></div>
  </div>
  <form class="card idea-capture" data-form="idea">
    <textarea id="idea-input" placeholder="Uma ideia, um pensamento, um insight para um caso… use #etiquetas para organizar" rows="2"></textarea>
    <div class="bar"><span class="note grow">Dica: no iPad, toque em "Escrever à mão" para usar o Apple Pencil.</span><button class="btn primary" type="submit">Guardar</button></div>
  </form>
  <div class="toolbar">
    <div class="chips"><button class="chip ${!ui.ideaTag ? 'on' : ''}" data-idea-tag="">Todas</button>${tags.map((t) => `<button class="chip ${ui.ideaTag === t ? 'on' : ''}" data-idea-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>
    <label class="search">${icon('search')}<input class="input" id="idea-search" type="search" placeholder="Buscar ideias" value="${esc(ui.ideaSearch)}"></label>
  </div>
  <div id="idea-results"></div>`;
  const res = document.getElementById('idea-results');
  partial = () => { res.innerHTML = ideasHTML(); };
  partial();
}

function ideasHTML() {
  const q = ui.ideaSearch.trim().toLowerCase();
  const list = store.all('ideas')
    .filter((i) => (!ui.ideaTag || (i.tags || []).includes(ui.ideaTag)) && (!q || (i.text || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) return `<div class="card empty"><span class="big">Um espaço só seu</span>Ideias soltas, pensamentos, coisas para lembrar depois.</div>`;
  return `<div class="masonry">${list.map((i) => {
    const short = (i.text || '').length < 90 && !i.thumb;
    return `<div class="idea ${i.color ? 'c-' + i.color : ''}" data-idea="${i.id}">
      ${i.pinned ? `<span class="pin">${icon('pin')}</span>` : ''}
      ${i.thumb ? `<img src="${i.thumb}" alt="Anotação à mão">` : ''}
      ${i.text ? `<div class="txt ${short ? 'big' : ''}" ${i.thumb ? 'style="margin-top:8px"' : ''}>${esc(i.text)}</div>` : ''}
      <div class="foot">${(i.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}<span class="spacer"></span><span>${fmtDM(new Date(i.createdAt))}</span></div>
    </div>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------------
// WISHLIST
// ---------------------------------------------------------------------
function viewWish() {
  const all = store.all('wishes');
  const cats = [...new Set(all.map((w) => w.category).filter(Boolean))].sort();
  const list = all.filter((w) => !ui.wishCat || w.category === ui.wishCat)
    .sort((a, b) => (a.bought ? 1 : 0) - (b.bought ? 1 : 0) || (b.priority || 0) - (a.priority || 0) || (b.createdAt || 0) - (a.createdAt || 0));
  const open = all.filter((w) => !w.bought);
  $view.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Wishlist</h1><div class="page-sub">Desejos, presentes e planos de compra</div></div>
    <div class="head-actions"><button class="btn primary" data-act="new-wish">${icon('plus')}<span>Novo desejo</span></button></div>
  </div>
  <div class="wish-summary">
    <div class="card"><b>${open.length}</b><span>desejos</span></div>
    <div class="card"><b>${money(open.reduce((s, w) => s + (Number(w.price) || 0), 0))}</b><span>total desejado</span></div>
    <div class="card"><b>${all.length - open.length}</b><span>realizados</span></div>
  </div>
  ${cats.length ? `<div class="toolbar"><div class="chips"><button class="chip ${!ui.wishCat ? 'on' : ''}" data-wish-cat="">Todos</button>${cats.map((c) => `<button class="chip ${ui.wishCat === c ? 'on' : ''}" data-wish-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>` : ''}
  ${list.length ? `<div class="wish-grid">${list.map((w) => `
    <div class="wish ${w.bought ? 'bought' : ''}" data-wish="${w.id}">
      <div class="ph">${w.photo ? `<img src="${w.photo}" alt="">` : `<span class="ph-ico">${esc((w.name || '?')[0].toUpperCase())}</span>`}</div>
      <div class="b">
        <div class="n">${esc(w.name)}</div>
        ${w.price ? `<div class="p">${money(w.price)}</div>` : ''}
        <div class="m">${w.bought ? '<span class="bought-badge">Realizado</span>' : ''}${w.category ? `<span>${esc(w.category)}</span>` : ''}<span class="spacer"></span>${w.priority ? `<span class="prio">${'★'.repeat(w.priority)}</span>` : ''}${w.link ? `<a href="${esc(w.link)}" target="_blank" rel="noopener" data-stop>${icon('ext')}</a>` : ''}</div>
      </div>
    </div>`).join('')}</div>` : `<div class="card empty"><span class="big">Sua lista de desejos</span>Guarde aquele livro, a viagem, o presente que alguém vai amar.</div>`}`;
}

// =====================================================================
// Folhas (modais)
// =====================================================================
function openSheet({ title, body, foot = '', wide = false, onClose }) {
  const root = document.getElementById('sheet-root');
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `<div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="sheet-head"><h3>${title}</h3><button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></div>
    <div class="sheet-body">${body}</div>
    ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}
  </div>`;
  root.appendChild(wrap);
  const close = () => { wrap.remove(); onClose?.(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  return { el: wrap, close, $: (s) => wrap.querySelector(s), $$: (s) => [...wrap.querySelectorAll(s)] };
}

// ---------------- Editor de tarefa ----------------
function openTask(id, preset) {
  const orig = id ? store.get('tasks', id) : null;
  if (id && !orig) return;
  const t = orig ? JSON.parse(JSON.stringify(orig)) : newTask(preset);
  const s = settings();
  const clients = [...new Set(tasks().map((x) => x.client).filter(Boolean))].sort();

  const remHTML = () => {
    if (!t.date) return '<div class="note">Defina uma data para programar lembretes.</div>';
    const chips = REMINDER_OPTS.map((o) => `<button type="button" class="chip ${(t.reminders || []).includes(o.m) ? 'on' : ''}" data-rem="${o.m}">${o.label}</button>`).join('');
    let note = '';
    if (!gcal.configured()) note = '<div class="note warn">Para receber notificações no celular, ligue a Google Agenda em Ajustes (uma única vez). Os lembretes ficam salvos e serão ativados depois.</div>';
    else note = `<div class="note">O lembrete vira um evento na sua Google Agenda e chega como notificação no celular${t.time ? '' : ' (sem horário, o evento é criado às 9h)'}.</div>`;
    return `<div class="rem-opts">${chips}</div>${note}`;
  };
  const clHTML = () => (t.checklist || []).map((c, i) => `<div class="cl-item ${c.done ? 'done' : ''}"><button type="button" class="check ${c.done ? 'on' : ''}" data-cl-check="${i}">${icon('check')}</button><input value="${esc(c.t)}" data-cl-text="${i}" placeholder="Etapa"><button type="button" class="x" data-cl-del="${i}">${icon('x')}</button></div>`).join('');

  const sh = openSheet({
    title: orig ? 'Editar tarefa' : 'Nova tarefa',
    body: `
      <input class="title-input" id="t-title" placeholder="O que precisa ser feito?" value="${esc(t.title)}">
      <div class="seg area-pick" style="align-self:flex-start">
        <button type="button" class="${t.area === 'trabalho' ? 'on' : ''}" data-v="trabalho">Trabalho</button>
        <button type="button" class="${t.area === 'pessoal' ? 'on' : ''}" data-v="pessoal">Pessoal</button>
      </div>
      <div class="section" id="work-section">
        <div class="grid2">
          <div class="field"><label>Status</label><select class="select" id="t-status">${t.area === 'pessoal' ? `<option value="">Sem status</option>` : ''}${s.statuses.map((x) => `<option ${x.name === t.status ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}${t.status && !statusOf(t.status) ? `<option selected>${esc(t.status)}</option>` : ''}</select></div>
          <div class="field work-only"><label>Tipo</label><select class="select" id="t-type"><option value="">—</option>${s.types.map((x) => `<option ${x === t.type ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
          <div class="field work-only"><label>Cliente</label><input class="input" id="t-client" list="dl-clients" value="${esc(t.client)}" placeholder="Nome do cliente"><datalist id="dl-clients">${clients.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
          <div class="field work-only"><label>Nº do processo</label><input class="input" id="t-process" value="${esc(t.process)}" placeholder="0000000-00.0000.0.00.0000" inputmode="numeric"></div>
        </div>
      </div>
      <div class="section">
        <div class="grid2">
          <div class="field"><label>Data</label><input class="input" type="date" id="t-date" value="${t.date || ''}"></div>
          <div class="field"><label>Horário</label><input class="input" type="time" id="t-time" value="${t.time || ''}"></div>
        </div>
        <div class="toggle-row"><div><div class="t">Prazo fatal</div><div class="d">Destaque em vinho, contagem regressiva e alerta no topo</div></div><label class="switch"><input type="checkbox" id="t-fatal" ${t.fatal ? 'checked' : ''}><span></span></label></div>
        <div class="field"><label>Prioridade</label><div class="prio-pick">${['Normal', 'Alta', 'Urgente'].map((l, i) => `<button type="button" class="${(t.priority || 0) === i ? 'on' : ''}" data-prio="${i}">${l}</button>`).join('')}</div></div>
      </div>
      <div class="section"><div class="section-title">${icon('bell')} Lembretes</div><div id="rem-box">${remHTML()}</div></div>
      <div class="section"><div class="section-title">Etapas</div><div class="checklist" id="cl-box">${clHTML()}</div><button type="button" class="btn small ghost" style="align-self:flex-start;color:var(--gold)" id="cl-add">${icon('plus')} Adicionar etapa</button></div>
      <div class="field"><label>Anotações</label><textarea class="textarea" id="t-notes" placeholder="Detalhes, documentos necessários, links…">${esc(t.notes)}</textarea></div>`,
    foot: `${orig ? `<button class="btn danger" id="t-del">${icon('trash')}</button>` : ''}${orig ? `<button class="btn" id="t-done">${t.done ? 'Reabrir' : 'Concluir'}</button>` : ''}<span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="t-save">Salvar</button>`,
  });

  const syncWork = () => sh.$$('.work-only').forEach((el) => el.classList.toggle('hidden', t.area !== 'trabalho'));
  syncWork();
  setTimeout(() => { if (!orig) sh.$('#t-title').focus(); }, 60);

  sh.$$('.area-pick button').forEach((b) => b.onclick = () => {
    t.area = b.dataset.v;
    sh.$$('.area-pick button').forEach((x) => x.classList.toggle('on', x === b));
    const sel = sh.$('#t-status');
    const hasEmpty = sel.querySelector('option[value=""]');
    if (t.area === 'pessoal' && !hasEmpty) sel.insertAdjacentHTML('afterbegin', '<option value="">Sem status</option>');
    if (t.area === 'trabalho' && hasEmpty) { hasEmpty.remove(); }
    syncWork();
  });
  sh.$$('[data-prio]').forEach((b) => b.onclick = () => { t.priority = +b.dataset.prio; sh.$$('[data-prio]').forEach((x) => x.classList.toggle('on', x === b)); });
  const remBox = sh.$('#rem-box');
  const refreshRem = () => { remBox.innerHTML = remHTML(); };
  remBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rem]'); if (!b) return;
    const m = +b.dataset.rem; const r = new Set(t.reminders || []);
    r.has(m) ? r.delete(m) : r.add(m);
    t.reminders = [...r].sort((a, b2) => b2 - a); refreshRem();
  });
  sh.$('#t-date').onchange = (e) => {
    const had = !!t.date; t.date = e.target.value || null;
    if (t.date && !had && !(t.reminders || []).length) t.reminders = defaultReminders(t);
    refreshRem();
  };
  sh.$('#t-time').onchange = (e) => { t.time = e.target.value || null; refreshRem(); };
  sh.$('#t-fatal').onchange = (e) => { t.fatal = e.target.checked; if (t.fatal && t.date) t.reminders = defaultReminders(t); refreshRem(); };

  const clBox = sh.$('#cl-box');
  const readCl = () => { sh.$$('[data-cl-text]').forEach((inp) => { t.checklist[+inp.dataset.clText].t = inp.value; }); };
  sh.$('#cl-add').onclick = () => { readCl(); t.checklist = [...(t.checklist || []), { t: '', done: false }]; clBox.innerHTML = clHTML(); clBox.querySelector('.cl-item:last-child input')?.focus(); };
  clBox.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cl-check]'); const d = e.target.closest('[data-cl-del]');
    if (!c && !d) return;
    readCl();
    if (c) t.checklist[+c.dataset.clCheck].done = !t.checklist[+c.dataset.clCheck].done;
    if (d) t.checklist.splice(+d.dataset.clDel, 1);
    clBox.innerHTML = clHTML();
  });
  clBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-cl-text]')) { e.preventDefault(); sh.$('#cl-add').click(); } });

  const collect = () => {
    readCl();
    t.title = sh.$('#t-title').value.trim();
    t.status = sh.$('#t-status').value;
    t.type = t.area === 'trabalho' ? sh.$('#t-type').value : '';
    t.client = t.area === 'trabalho' ? sh.$('#t-client').value.trim() : '';
    t.process = t.area === 'trabalho' ? sh.$('#t-process').value.trim() : '';
    t.notes = sh.$('#t-notes').value;
    t.checklist = (t.checklist || []).filter((c) => c.t.trim());
    if (!t.date) t.time = null;
  };
  sh.$('#t-save').onclick = async () => {
    collect();
    if (!t.title) { sh.$('#t-title').focus(); toast('Dê um nome à tarefa'); return; }
    sh.close();
    await saveTask(t);
  };
  sh.$('#t-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') sh.$('#t-save').click(); });
  if (orig) {
    sh.$('#t-del').onclick = () => { sh.close(); deleteTask(t.id); };
    sh.$('#t-done').onclick = async () => { collect(); t.done = !t.done; t.doneAt = t.done ? Date.now() : null; sh.close(); await saveTask(t, { silent: true }); toast(t.done ? 'Concluída' : 'Reaberta'); };
  }
}

// ---------------- Colar várias tarefas ----------------
function openPasteList() {
  const s = settings();
  let area = ui.qa.area;
  const sh = openSheet({
    title: 'Colar várias tarefas',
    body: `<div class="note">Uma tarefa por linha. Depois do nome, separe com barras, nesta ordem (todas opcionais):<br><b>Tarefa | Status | Cliente | Tipo | Data | Processo | Etapas | Anotações</b><br>Ex.: <b>Agravo | Fazer petição | Cristiano | Petição | 05/12! | 5009584-35.2026</b><br>Na data, "!" marca prazo fatal e dá para incluir horário (01/12 13:00). Etapas são separadas por ponto e vírgula.<br>Se a tarefa já existir com o mesmo nome, ela é <b>atualizada</b> em vez de repetida.</div>
      <div class="seg area-pick" style="align-self:flex-start">
        <button type="button" class="${area === 'trabalho' ? 'on' : ''}" data-v="trabalho">Trabalho</button>
        <button type="button" class="${area === 'pessoal' ? 'on' : ''}" data-v="pessoal">Pessoal</button>
      </div>
      <textarea class="textarea" id="pl-text" style="min-height:260px" placeholder="Cole ou digite aqui"></textarea>
      <div class="note" id="pl-count"></div>`,
    foot: `<span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="pl-save">Adicionar</button>`,
  });
  const parseTime = (v) => {
    const m = (v || '').match(/(?:^|\s)(\d{1,2})(?::(\d{2})|h(\d{2})?)(?:\s|!|$)/);
    return m ? `${pad(Math.min(23, +m[1]))}:${pad(+(m[2] || m[3] || 0))}` : null;
  };
  const parseDate = (v) => {
    const m = (v || '').match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!m) return null;
    const now = new Date();
    let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : now.getFullYear();
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]), 12);
    if (!m[3] && daysUntil(ymd(d)) < -60) d.setFullYear(y + 1);
    return ymd(d);
  };
  const parse = () => sh.$('#pl-text').value.split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-•*▪◦]|\d+[.)]|\[\s?\])\s*/, '').trim()).filter(Boolean)
    .map((l) => {
      const [title, st, client, type, date, process, steps, notes] = l.split('|').map((x) => x.trim());
      const found = st && s.statuses.find((x) => x.name.toLowerCase() === st.toLowerCase());
      const ty = type && s.types.find((x) => x.toLowerCase() === type.toLowerCase());
      const d = parseDate(date);
      return {
        title, status: found ? found.name : (st || ''), client: client || '', type: ty || type || '',
        date: d, time: d ? parseTime(date.replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/, ' ')) : null, fatal: (date || '').includes('!'),
        process: process || '', notes: notes || '',
        checklist: (steps || '').split(';').map((x) => x.trim()).filter(Boolean).map((t) => ({ t, done: false })),
      };
    }).filter((x) => x.title);
  const existing = () => {
    const m = new Map();
    for (const t of tasks()) if (!t.done) m.set(normTitle(t.title), t);
    return m;
  };
  const count = () => {
    const items = parse(); const ex = existing();
    const upd = items.filter((it) => ex.has(normTitle(it.title))).length;
    sh.$('#pl-count').textContent = items.length ? `${items.length - upd} nova${items.length - upd === 1 ? '' : 's'} · ${upd} atualizada${upd === 1 ? '' : 's'}` : '';
  };
  sh.$('#pl-text').addEventListener('input', count);
  sh.$$('.area-pick button').forEach((b) => b.onclick = () => { area = b.dataset.v; sh.$$('.area-pick button').forEach((x) => x.classList.toggle('on', x === b)); });
  setTimeout(() => sh.$('#pl-text').focus(), 60);
  sh.$('#pl-save').onclick = async () => {
    const items = parse();
    if (!items.length) { toast('Nenhuma tarefa na lista'); return; }
    sh.close();
    const ex = existing();
    const base = Date.now();
    let added = 0, updated = 0;
    for (const [i, it] of items.entries()) {
      const cur = ex.get(normTitle(it.title));
      if (cur) {
        const t = { ...cur, title: it.title, area };
        if (it.status) t.status = it.status;
        if (it.client) t.client = it.client;
        if (it.type) t.type = it.type;
        if (it.process) t.process = it.process;
        if (it.notes) t.notes = it.notes;
        if (it.checklist.length) t.checklist = it.checklist;
        if (it.fatal) t.fatal = true;
        if (it.time) t.time = it.time;
        if (it.date) { t.date = it.date; if (!(t.reminders || []).length || it.fatal) t.reminders = defaultReminders(t); }
        await store.put('tasks', t);
        if (t.date) syncTaskToCalendar(t);
        updated++;
      } else {
        const t = newTask({ title: it.title, area, status: it.status || (area === 'trabalho' ? s.statuses[0].name : ''), client: it.client, type: it.type, date: it.date, time: it.date ? it.time : null, fatal: it.fatal, process: it.process, notes: it.notes, checklist: it.checklist });
        t.createdAt = base + i;
        await store.put('tasks', t);
        if (t.date) syncTaskToCalendar(t);
        ex.set(normTitle(t.title), t);
        added++;
      }
    }
    toast([added && `${added} adicionada${added > 1 ? 's' : ''}`, updated && `${updated} atualizada${updated > 1 ? 's' : ''}`].filter(Boolean).join(' · '));
  };
}

// ---------------- Evento da Google Agenda ----------------
function findEvent(id) {
  const all = [];
  const c = ui.cursor;
  for (const [a, b] of [[new Date(), addDays(new Date(), 1)], [startOfWeek(c), addDays(startOfWeek(c), 7)], [c, addDays(c, 1)]]) all.push(...(gcal.cachedEvents(a, b, visibleCalendars()) || []));
  const first = new Date(c.getFullYear(), c.getMonth(), 1, 12); const ms = startOfWeek(first);
  all.push(...(gcal.cachedEvents(ms, addDays(ms, 42), visibleCalendars()) || []));
  return all.find((e) => (e.key || e.id) === id);
}

function openEvent(id) {
  const e = findEvent(id);
  if (!e) return;
  const s = new Date(e.start), en = new Date(e.end);
  const when = e.allDay ? `${fmtLong(s)} · dia inteiro` : `${fmtLong(s)} · ${fmtTime(s)}–${fmtTime(en)}`;
  const sh = openSheet({
    title: esc(e.title),
    body: `<div class="section"><div>${icon('clock')} <span>${cap(when)}</span></div>${e.location ? `<div>📍 ${esc(e.location)}</div>` : ''}${e.description ? `<div class="note" style="white-space:pre-wrap">${esc(e.description.replace(/<[^>]+>/g, ''))}</div>` : ''}</div>`,
    foot: `<span class="note grow">Para editar ou excluir, use a Google Agenda.</span><button class="btn primary" id="e-task">Criar tarefa</button>`,
  });
  sh.$('#e-task').onclick = () => { sh.close(); openTask(null, { title: e.title, date: e.date, time: e.allDay ? null : fmtTime(s) }); };
}

function openNewEvent(date = ymd(ui.cursor), time = '') {
  let cals = []; try { cals = JSON.parse(localStorage.getItem('gcal-cals') || '[]').filter((c) => c.writable); } catch { /* */ }
  const target = settings().gcalTarget;
  const sh = openSheet({
    title: 'Novo compromisso',
    body: `<input class="title-input" id="e-title" placeholder="Audiência, reunião, consulta…">
      <div class="section"><div class="grid2">
        <div class="field"><label>Data</label><input class="input" type="date" id="e-date" value="${date}"></div>
        <div class="field"><label>Horário</label><input class="input" type="time" id="e-time" value="${time}"></div>
        <div class="field"><label>Duração</label><select class="select" id="e-dur"><option value="30">30 min</option><option value="60" selected>1 hora</option><option value="90">1h30</option><option value="120">2 horas</option><option value="180">3 horas</option></select></div>
        <div class="field"><label>Agenda</label><select class="select" id="e-cal">${cals.length ? cals.map((c) => `<option value="${esc(c.id)}" ${(c.id === target || (target === 'primary' && c.primary)) ? 'selected' : ''}>${esc(c.name)}</option>`).join('') : '<option value="primary">Principal</option>'}</select></div>
      </div>
      <div class="field"><label>Local</label><input class="input" id="e-loc" placeholder="Fórum, endereço, link da videochamada"></div>
      <div class="field"><label>Lembrete</label><div class="rem-opts">${REMINDER_OPTS.slice(0, 5).map((o) => `<button type="button" class="chip ${[60, 1440].includes(o.m) ? 'on' : ''}" data-rem="${o.m}">${o.label}</button>`).join('')}</div></div>
      </div>
      <div class="field"><label>Anotações</label><textarea class="textarea" id="e-notes"></textarea></div>`,
    foot: `<span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="e-save">Salvar na Google Agenda</button>`,
  });
  sh.$$('[data-rem]').forEach((b) => b.onclick = () => b.classList.toggle('on'));
  setTimeout(() => sh.$('#e-title').focus(), 60);
  sh.$('#e-save').onclick = async () => {
    const title = sh.$('#e-title').value.trim();
    if (!title) { toast('Dê um nome ao compromisso'); return; }
    try {
      await gcal.createEvent({
        title, date: sh.$('#e-date').value, time: sh.$('#e-time').value, minutes: +sh.$('#e-dur').value,
        location: sh.$('#e-loc').value, notes: sh.$('#e-notes').value, calendarId: sh.$('#e-cal').value,
        reminders: sh.$$('[data-rem].on').map((b) => +b.dataset.rem),
      });
      inflight.clear(); sh.close(); toast('Compromisso criado na Google Agenda'); render();
    } catch (e) { toast(e.message); }
  };
}

// ---------------- Ideias ----------------
function openIdea(id) {
  const i = store.get('ideas', id);
  if (!i) return;
  if (i.kind === 'ink') return openInk(id);
  let color = i.color || '';
  let pinned = !!i.pinned;
  const sh = openSheet({
    title: 'Ideia',
    body: `<textarea class="textarea" id="i-text" style="min-height:200px;font-size:17px">${esc(i.text)}</textarea>
      <div class="row" style="align-items:center"><div class="color-dots">${['', 'wine', 'gold', 'sage', 'ink'].map((c) => `<button class="color-dot ${c === color ? 'on' : ''}" data-color="${c}" style="background:${{ '': '#FFFCF6', wine: '#F3E3E4', gold: '#F5ECD6', sage: '#EEF0E4', ink: '#4A1420' }[c]}"></button>`).join('')}</div>
      <label class="toggle-row" style="flex:0 0 auto;gap:10px"><span class="t">Fixar</span><span class="switch"><input type="checkbox" id="i-pin" ${pinned ? 'checked' : ''}><span></span></span></label></div>`,
    foot: `<button class="btn danger" id="i-del">${icon('trash')}</button><button class="btn" id="i-task">Virar tarefa</button><span class="grow"></span><button class="btn primary" id="i-save">Salvar</button>`,
  });
  sh.$$('[data-color]').forEach((b) => b.onclick = () => { color = b.dataset.color; sh.$$('[data-color]').forEach((x) => x.classList.toggle('on', x === b)); });
  sh.$('#i-pin').onchange = (e) => { pinned = e.target.checked; };
  const save = () => { const text = sh.$('#i-text').value.trim(); return store.put('ideas', { ...i, text, tags: tagsOf(text), color, pinned }); };
  sh.$('#i-save').onclick = async () => { await save(); sh.close(); };
  sh.$('#i-del').onclick = async () => { sh.close(); await store.remove('ideas', i.id); toast('Ideia excluída', { label: 'Desfazer', fn: () => store.put('ideas', i) }); };
  sh.$('#i-task').onclick = () => { const text = sh.$('#i-text').value.trim(); sh.close(); openTask(null, { title: text.split('\n')[0].replace(/#[\p{L}\p{N}_-]+/gu, '').trim().slice(0, 140), notes: text }); };
}

function openInk(id) {
  const orig = id ? store.get('ideas', id) : null;
  const COLORS = ['#2C1B1F', '#6B1E2E', '#A9822F', '#2F4A7A', '#4F7A4A'];
  const SIZES = [2, 3.5, 6];
  const sh = openSheet({
    wide: true,
    title: orig ? 'Anotação à mão' : 'Escrever à mão',
    body: `<div class="ink-wrap">
      <input class="input" id="ink-text" placeholder="Título ou #etiquetas (opcional)" value="${esc(orig?.text || '')}">
      <div class="ink-tools">
        ${COLORS.map((c, i) => `<button class="sw ${i === 0 ? 'on' : ''}" data-ink-color="${c}" style="background:${c}"></button>`).join('')}
        <span style="width:8px"></span>
        ${SIZES.map((s, i) => `<button class="size ${i === 1 ? 'on' : ''}" data-ink-size="${s}"><i style="width:${s + 3}px;height:${s + 3}px"></i></button>`).join('')}
        <span style="width:8px"></span>
        <button class="icon-btn tool" data-ink-tool="eraser" title="Borracha">${icon('eraser')}</button>
        <button class="icon-btn" data-ink-act="undo" title="Desfazer">${icon('undo')}</button>
        <button class="btn small ghost" data-ink-act="clear">Limpar</button>
      </div>
      <div class="ink-canvas-box" id="ink-box"></div>
    </div>`,
    foot: `${orig ? `<button class="btn danger" id="ink-del">${icon('trash')}</button>` : ''}<span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="ink-save">Salvar</button>`,
    onClose: () => ink?.destroy(),
  });
  const ink = createInk(sh.$('#ink-box'), orig?.strokes || []);
  let color = COLORS[0];
  sh.$$('[data-ink-color]').forEach((b) => b.onclick = () => { color = b.dataset.inkColor; ink.set({ color, eraser: false }); sh.$('[data-ink-tool]').classList.remove('on'); sh.$$('[data-ink-color]').forEach((x) => x.classList.toggle('on', x === b)); });
  sh.$$('[data-ink-size]').forEach((b) => b.onclick = () => { ink.set({ size: +b.dataset.inkSize }); sh.$$('[data-ink-size]').forEach((x) => x.classList.toggle('on', x === b)); });
  sh.$('[data-ink-tool]').onclick = (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); ink.set({ eraser: on }); };
  sh.$('[data-ink-act=undo]').onclick = () => ink.undo();
  sh.$('[data-ink-act=clear]').onclick = () => { if (confirm('Apagar tudo?')) ink.clear(); };
  sh.$('#ink-save').onclick = async () => {
    if (ink.isEmpty()) { toast('Escreva algo antes de salvar'); return; }
    const text = sh.$('#ink-text').value.trim();
    const doc = { ...(orig || { id: uid() }), kind: 'ink', text, tags: tagsOf(text), strokes: ink.strokes(), thumb: ink.thumbnail() };
    sh.close();
    await store.put('ideas', doc);
    toast('Anotação salva');
  };
  if (orig) sh.$('#ink-del').onclick = async () => { sh.close(); await store.remove('ideas', orig.id); toast('Anotação excluída', { label: 'Desfazer', fn: () => store.put('ideas', orig) }); };
}

// ---------------- Wishlist ----------------
function openWish(id) {
  const orig = id ? store.get('wishes', id) : null;
  const w = orig ? { ...orig } : { id: uid(), name: '', link: '', price: '', category: '', priority: 0, photo: '', notes: '', bought: false };
  const cats = [...new Set(store.all('wishes').map((x) => x.category).filter(Boolean))];
  const sh = openSheet({
    title: orig ? 'Desejo' : 'Novo desejo',
    body: `<input class="title-input" id="w-name" placeholder="O que você deseja?" value="${esc(w.name)}">
      <div class="section"><div class="grid2">
        <div class="field"><label>Preço (R$)</label><input class="input" id="w-price" inputmode="decimal" value="${w.price ? String(w.price).replace('.', ',') : ''}" placeholder="0,00"></div>
        <div class="field"><label>Categoria</label><input class="input" id="w-cat" list="dl-cats" value="${esc(w.category)}" placeholder="Livros, casa, viagem…"><datalist id="dl-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      </div>
      <div class="field"><label>Link</label><input class="input" id="w-link" type="url" value="${esc(w.link)}" placeholder="https://"></div>
      <div class="field"><label>Prioridade</label><div class="prio-pick">${['—', '★', '★★', '★★★'].map((l, i) => `<button type="button" class="${(w.priority || 0) === i ? 'on' : ''}" data-prio="${i}">${l}</button>`).join('')}</div></div>
      <div class="field"><label>Foto</label><div class="row" style="align-items:center"><div id="w-ph" style="flex:0 0 72px;height:72px;border-radius:12px;background:var(--gold-soft) center/cover;${w.photo ? `background-image:url(${w.photo})` : ''}"></div><label class="btn" style="flex:0 0 auto">${icon('photo')} Escolher foto<input type="file" accept="image/*" id="w-file" hidden></label>${w.photo ? '<button class="btn ghost" id="w-rmph" style="flex:0 0 auto">Remover</button>' : ''}</div></div>
      <div class="toggle-row"><div class="t">Já realizei</div><label class="switch"><input type="checkbox" id="w-bought" ${w.bought ? 'checked' : ''}><span></span></label></div>
      </div>
      <div class="field"><label>Anotações</label><textarea class="textarea" id="w-notes">${esc(w.notes)}</textarea></div>`,
    foot: `${orig ? `<button class="btn danger" id="w-del">${icon('trash')}</button>` : ''}<span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="w-save">Salvar</button>`,
  });
  sh.$$('[data-prio]').forEach((b) => b.onclick = () => { w.priority = +b.dataset.prio; sh.$$('[data-prio]').forEach((x) => x.classList.toggle('on', x === b)); });
  sh.$('#w-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    w.photo = await compressImage(f, 700, 0.78);
    sh.$('#w-ph').style.backgroundImage = `url(${w.photo})`;
  };
  sh.$('#w-rmph')?.addEventListener('click', () => { w.photo = ''; sh.$('#w-ph').style.backgroundImage = ''; });
  sh.$('#w-save').onclick = async () => {
    w.name = sh.$('#w-name').value.trim();
    if (!w.name) { toast('Dê um nome ao desejo'); return; }
    const p = sh.$('#w-price').value.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
    w.price = p ? Number(p) || 0 : '';
    w.category = sh.$('#w-cat').value.trim();
    w.link = sh.$('#w-link').value.trim();
    w.notes = sh.$('#w-notes').value;
    w.bought = sh.$('#w-bought').checked;
    sh.close();
    await store.put('wishes', w);
  };
  if (orig) sh.$('#w-del').onclick = async () => { sh.close(); await store.remove('wishes', w.id); toast('Removido', { label: 'Desfazer', fn: () => store.put('wishes', orig) }); };
}

// ---------------- Ajustes ----------------
function openSettings(fresh = false) {
  const s = settings();
  const user = store.user();
  let cals = []; try { cals = JSON.parse(localStorage.getItem('gcal-cals') || '[]'); } catch { /* */ }
  const calsBefore = JSON.stringify(cals);
  const show = s.gcalShow || cals.filter((c) => c.selected).map((c) => c.id);
  const statuses = s.statuses.map((x) => ({ ...x }));

  const stHTML = () => statuses.map((x, i) => `<div class="se"><input type="color" value="${x.color}" data-st-color="${i}"><input type="text" class="input" value="${esc(x.name)}" data-st-name="${i}"><button class="icon-btn" data-st-del="${i}" aria-label="Remover">${icon('x')}</button></div>`).join('');

  let account;
  if (!store.cloudAvailable()) account = `<div class="note warn">A sincronização entre iPhone, iPad e Mac ainda não foi configurada. Por enquanto, os dados ficam salvos só neste aparelho. Siga o GUIA.md (passo 2) para ativar.</div>`;
  else if (user) account = `<div class="toggle-row"><div><div class="t">${esc(user.name || 'Conectada')}</div><div class="d">${esc(user.email || '')} · sincronizando</div></div><button class="btn small" id="s-logout">Sair</button></div>`;
  else account = `<div class="toggle-row"><div><div class="t">Entrar para sincronizar</div><div class="d">Use a mesma conta Google no iPhone, iPad e Mac</div></div><button class="btn small primary" id="s-login">Entrar com Google</button></div>`;

  let cal;
  if (!gcal.configured()) cal = `<div class="toggle-row"><div><div class="t">Google Agenda</div><div class="d">Configure uma única vez e ela fica conectada para sempre, em todos os aparelhos</div></div><button class="btn small primary" id="s-gcal">Ligar</button></div>`;
  else cal = `<div class="toggle-row"><div><div class="t">Google Agenda conectada</div><div class="d">Fica conectada sempre. Escolha quais agendas aparecem no app</div></div><button class="btn small" id="s-gcal-off">Desligar</button></div>
      ${cals.map((c) => `<label class="toggle-row" style="padding:4px 0"><span style="display:flex;gap:8px;align-items:center"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${c.color}"></span>${esc(c.name)}</span><span class="switch"><input type="checkbox" data-cal-show="${esc(c.id)}" ${show.includes(c.id) ? 'checked' : ''}><span></span></span></label>`).join('')}
      <div class="field"><label>Agenda para lembretes das tarefas</label><div class="note">Escolha uma agenda só sua. A agenda principal pode estar compartilhada com colegas. Para criar uma nova, use a Google Agenda (no computador: "Outras agendas" → "+" → "Criar nova agenda") e depois volte aqui.</div><select class="select" id="s-target">${cals.filter((c) => c.writable).map((c) => `<option value="${esc(c.id)}" ${(c.id === s.gcalTarget || (s.gcalTarget === 'primary' && c.primary)) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`;

  const sh = openSheet({
    title: 'Ajustes',
    body: `
      <div class="section"><div class="section-title">Conta e sincronização</div>${account}</div>
      <div class="section"><div class="section-title">Google Agenda e notificações</div>${cal}
        <div class="field"><label>Lembretes padrão para tarefas com data</label><div class="rem-opts">${REMINDER_OPTS.map((o) => `<button type="button" class="chip ${s.defaultReminders.includes(o.m) ? 'on' : ''}" data-defrem="${o.m}">${o.label}</button>`).join('')}</div><div class="note">Prazos fatais recebem automaticamente lembretes 3 dias antes, 1 dia antes e no dia.</div></div>
      </div>
      <div class="section"><div class="section-title">Você</div><div class="field"><label>Como quer ser chamada</label><input class="input" id="s-name" value="${esc(s.name)}" placeholder="Ana"></div></div>
      <div class="section"><div class="section-title">Status das tarefas</div><div class="status-edit" id="st-box">${stHTML()}</div><button class="btn small ghost" style="align-self:flex-start;color:var(--gold)" id="st-add">${icon('plus')} Novo status</button></div>
      <div class="section"><div class="section-title">Tipos de tarefa de trabalho</div><input class="input" id="s-types" value="${esc(s.types.join(', '))}"><div class="note">Separe por vírgula.</div></div>
      <div class="section"><div class="section-title">Organização</div><div class="row"><button class="btn" id="s-dedupe" style="flex:0 0 auto">Remover tarefas repetidas</button></div></div>
      <div class="section"><div class="section-title">Backup</div><div class="row"><button class="btn" id="s-export">${icon('download')} Exportar</button><label class="btn">${icon('upload')} Importar<input type="file" accept="application/json" id="s-import" hidden></label></div><div class="note">Guarde uma cópia de segurança de vez em quando (ex.: no Google Drive).</div></div>
      <div class="section"><div class="section-title">Instalar como app</div><div class="note">No iPad ou iPhone: abra no Safari, toque em Compartilhar e depois em "Adicionar à Tela de Início". No Mac (Safari): menu Arquivo → "Adicionar ao Dock".</div></div>`,
    foot: `<span class="grow"></span><button class="btn primary" id="s-save">Salvar</button>`,
  });

  const box = sh.$('#st-box');
  const readSt = () => { sh.$$('[data-st-name]').forEach((inp) => { statuses[+inp.dataset.stName].name = inp.value.trim(); }); sh.$$('[data-st-color]').forEach((inp) => { statuses[+inp.dataset.stColor].color = inp.value; }); };
  sh.$('#st-add').onclick = () => { readSt(); statuses.push({ name: '', color: '#8F7F70' }); box.innerHTML = stHTML(); box.querySelector('.se:last-child input[type=text]').focus(); };
  box.addEventListener('click', (e) => { const d = e.target.closest('[data-st-del]'); if (!d) return; readSt(); statuses.splice(+d.dataset.stDel, 1); box.innerHTML = stHTML(); });
  sh.$$('[data-defrem]').forEach((b) => b.onclick = () => b.classList.toggle('on'));

  sh.$('#s-login')?.addEventListener('click', async () => { try { await store.signIn(); sh.close(); } catch (e) { toast('Não foi possível entrar: ' + e.message); } });
  sh.$('#s-logout')?.addEventListener('click', async () => { if (confirm('Sair da conta? Os dados continuam salvos na nuvem.')) { await store.signOut(); sh.close(); } });
  sh.$('#s-gcal')?.addEventListener('click', () => { sh.close(); openGcalSetup(); });
  sh.$('#s-gcal-off')?.addEventListener('click', async () => {
    if (!confirm('Desligar a Google Agenda do app? Os eventos já criados continuam na sua agenda.')) return;
    await saveSettings({ gcalUrl: '', gcalKey: '' }); sh.close();
  });
  sh.$('#s-dedupe').onclick = () => { sh.close(); removeDuplicates(); };
  sh.$('#s-export').onclick = () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `minha-agenda-backup-${todayStr()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  sh.$('#s-import').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!confirm('Importar este backup? Itens com o mesmo identificador serão substituídos.')) return;
    try { await store.importJSON(await f.text()); toast('Backup importado'); sh.close(); } catch (err) { toast(err.message); }
  };
  sh.$('#s-save').onclick = async () => {
    readSt();
    const patch = {
      name: sh.$('#s-name').value.trim(),
      statuses: statuses.filter((x) => x.name),
      types: sh.$('#s-types').value.split(',').map((x) => x.trim()).filter(Boolean),
      defaultReminders: sh.$$('[data-defrem].on').map((b) => +b.dataset.defrem),
    };
    const showEls = sh.$$('[data-cal-show]');
    if (showEls.length) patch.gcalShow = showEls.filter((x) => x.checked).map((x) => x.dataset.calShow);
    const oldTarget = s.gcalTarget;
    if (sh.$('#s-target')) patch.gcalTarget = sh.$('#s-target').value;
    await saveSettings(patch);
    inflight.clear();
    sh.close();
    toast('Ajustes salvos');
    if (patch.gcalTarget && patch.gcalTarget !== oldTarget) moveTaskEvents(patch.gcalTarget);
  };
  // Atualiza a lista de agendas (por exemplo, uma agenda recém-criada)
  if (!fresh && gcal.configured()) {
    refreshCalendars().then(() => {
      const now = localStorage.getItem('gcal-cals') || '[]';
      if (now !== calsBefore && document.contains(sh.el)) { sh.close(); openSettings(true); }
    });
  }
}

/** Move os eventos das tarefas para a agenda escolhida (apaga na antiga e recria na nova) */
async function moveTaskEvents(target) {
  const list = tasks().filter((t) => t.gcalEventId && t.gcalCalendarId !== target);
  if (!list.length) return;
  toast(`Movendo ${list.length} lembrete${list.length > 1 ? 's' : ''} para a nova agenda…`);
  let ok = 0;
  for (const t of list) {
    try {
      await gcal.deleteEvent(t.gcalCalendarId || 'primary', t.gcalEventId);
      const nt = { ...store.get('tasks', t.id), gcalEventId: null, gcalCalendarId: null };
      await store.put('tasks', nt);
      if (!nt.done) await syncTaskToCalendar(nt);
      ok++;
    } catch (e) {
      console.error(e);
      const cur = store.get('tasks', t.id);
      if (cur) await store.put('tasks', { ...cur, gcalPending: true });
    }
  }
  inflight.clear();
  render();
  toast(ok === list.length ? `${ok} lembrete${ok > 1 ? 's movidos' : ' movido'} para a nova agenda` : `${ok} de ${list.length} movidos. Os demais serão tentados de novo depois.`);
}

// Configuração única do conector da Google Agenda
function openGcalSetup() {
  let key = '';
  try { key = localStorage.getItem('gcal-draft-key') || ''; } catch { /* */ }
  if (!key) {
    const b = new Uint8Array(18); crypto.getRandomValues(b);
    key = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('gcal-draft-key', key); } catch { /* */ }
  }
  const code = bridgeScript(key);
  const step = (n, html) => `<div class="row" style="gap:12px;align-items:flex-start"><span style="flex:0 0 28px;height:28px;border-radius:50%;background:var(--wine);color:#FFF4E4;display:grid;place-items:center;font-weight:700;font-size:14px">${n}</span><div style="flex:1">${html}</div></div>`;
  const sh = openSheet({
    title: 'Ligar a Google Agenda',
    body: `${store.cloudAvailable() && !store.user() ? '<div class="note warn"><b>Entre com Google antes</b> (Ajustes → Entrar com Google). Sem isso, a agenda fica ligada só neste aparelho.</div>' : ''}<div class="note">Feito uma única vez, de preferência no Mac. Depois disso a agenda fica conectada para sempre, em todos os seus aparelhos.</div>
      <div class="section">
        ${step(1, `<b>Copie o código do conector.</b><div class="row mt8" style="flex-wrap:wrap"><button class="btn primary" id="g-copy" style="flex:0 0 auto">Copiar código</button></div><textarea class="textarea mt8" id="g-code" readonly style="min-height:80px;font-family:ui-monospace,monospace;font-size:12px">${esc(code)}</textarea>`)}
        ${step(2, `<b>Abra o Google Apps Script</b> e crie um projeto: <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a>. Apague o que estiver escrito, cole o código e clique no ícone de <b>salvar</b>.`)}
        ${step(3, `Clique em <b>Implantar → Nova implantação</b>. Na engrenagem, escolha <b>App da Web</b>. Em "Executar como", deixe <b>Eu</b>; em "Quem pode acessar", escolha <b>Qualquer pessoa</b>. Clique em <b>Implantar</b>.`)}
        ${step(4, `Clique em <b>Autorizar acesso</b> e escolha sua conta. No aviso "O Google não verificou este app", clique em <b>Avançado → Acessar (não seguro)</b> e depois em <b>Permitir</b>. O app é seu, por isso o aviso.`)}
        ${step(5, `<b>Copie o "URL do app da Web"</b> (começa com https://script.google.com/macros/s/...) e cole aqui:<input class="input mt8" id="g-url" placeholder="https://script.google.com/macros/s/.../exec" autocomplete="off">`)}
      </div>`,
    foot: `<span class="grow"></span><button class="btn" data-close>Fechar</button><button class="btn primary" id="g-save">Testar e salvar</button>`,
  });
  sh.$('#g-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(code); toast('Código copiado'); }
    catch { const ta = sh.$('#g-code'); ta.focus(); ta.select(); toast('Selecione e copie o código'); }
  };
  sh.$('#g-save').onclick = async () => {
    const url = sh.$('#g-url').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { toast('Cole o URL do app da Web (passo 5)'); return; }
    const btn = sh.$('#g-save'); btn.disabled = true; btn.textContent = 'Testando…';
    try {
      await gcal.ping(url, key);
      await saveSettings({ gcalUrl: url, gcalKey: key });
      try { localStorage.removeItem('gcal-draft-key'); } catch { /* */ }
      sh.close();
      toast('Google Agenda conectada para sempre');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Testar e salvar';
      toast(e.message || 'Não consegui falar com o conector');
    }
  };
}

// Mantém o conector configurado em todos os aparelhos (vem das configurações sincronizadas)
let lastBridge = '';
function applyBridgeConfig() {
  const s = settings();
  const sig = `${s.gcalUrl}|${s.gcalKey}`;
  if (sig === lastBridge) return;
  lastBridge = sig;
  gcal.configure({ url: s.gcalUrl, key: s.gcalKey });
  inflight.clear();
  if (gcal.configured()) refreshCalendars().then(() => { inflight.clear(); render(); syncPendingToCalendar(); });
}

// =====================================================================
// Eventos (delegação)
// =====================================================================
// Deslizar a tarefa para a esquerda exclui (com opção de desfazer)
let swipe = null;
let suppressClickUntil = 0;
document.addEventListener('touchstart', (e) => {
  const row = e.target.closest('[data-swipe]');
  if (!row || e.touches.length > 1 || e.target.closest('select')) { swipe = null; return; }
  const t = e.touches[0];
  swipe = { row, inner: row.querySelector('.task-inner'), x: t.clientX, y: t.clientY, dx: 0, locked: null };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  if (swipe.locked === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    swipe.locked = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
    if (swipe.locked === 'x') { swipe.row.classList.add('swiping'); swipe.inner.style.transition = 'none'; }
  }
  if (swipe.locked !== 'x') return;
  e.preventDefault();
  swipe.dx = Math.min(0, dx);
  swipe.inner.style.transform = `translateX(${swipe.dx}px)`;
  swipe.row.classList.toggle('swipe-armed', swipe.dx < -swipe.row.offsetWidth * 0.35);
}, { passive: false });
document.addEventListener('touchend', () => {
  if (!swipe) return;
  const { row, inner, dx, locked } = swipe;
  swipe = null;
  if (locked !== 'x') return;
  suppressClickUntil = Date.now() + 400;
  inner.style.transition = '';
  if (dx < -row.offsetWidth * 0.35) {
    inner.style.transform = 'translateX(-100%)';
    row.style.maxHeight = row.offsetHeight + 'px';
    requestAnimationFrame(() => row.classList.add('swipe-gone'));
    setTimeout(() => deleteTask(row.dataset.swipe), 220);
  } else {
    inner.style.transform = '';
    setTimeout(() => row.classList.remove('swiping', 'swipe-armed'), 200);
  }
});
document.addEventListener('touchcancel', () => {
  if (!swipe) return;
  swipe.inner.style.transition = ''; swipe.inner.style.transform = '';
  swipe.row.classList.remove('swiping', 'swipe-armed');
  swipe = null;
});

document.addEventListener('click', async (e) => {
  if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.target.closest('#sheet-root')) return;
  if (e.target.closest('select, [data-stop]')) return;
  const el = (sel) => e.target.closest(sel);
  let x;

  if ((x = el('[data-go]'))) return go(x.dataset.go);
  if ((x = el('[data-act]'))) {
    const act = x.dataset.act;
    const A = {
      'toggle-task': () => toggleTask(x.dataset.id),
      settings: openSettings,
      login: async () => { try { await store.signIn(); } catch (err) { toast('Não foi possível entrar: ' + err.message); } },
      'dismiss-banner': () => { localStorage.setItem('banner-dismissed', todayStr()); renderBanner(); },
      'new-task-today': () => openTask(null, { date: todayStr() }),
      'new-task-cursor': () => openTask(null, { date: ymd(ui.cursor) }),
      'new-event': () => openNewEvent(),
      'capture-idea': async () => {
        const inp = document.getElementById('capture-input');
        const text = inp.value.trim();
        if (!text) { go('ideas'); setTimeout(() => document.getElementById('idea-input')?.focus(), 50); return; }
        inp.value = '';
        await store.put('ideas', { id: uid(), text, tags: tagsOf(text) });
        toast('Ideia guardada');
      },
      'filter-fatal': () => { ui.area = 'all'; ui.statusFilter = ''; ui.search = ''; go('tasks'); },
      'go-week': () => { ui.agendaMode = 'week'; ui.cursor = new Date(); go('agenda'); },
      'qa-fatal': () => { ui.qa.fatal = !ui.qa.fatal; render(); },
      'toggle-done': () => { ui.showDone = !ui.showDone; partial ? partial() : render(); },
      'gcal-connect': openGcalSetup,
      'week-prio-check': async () => {
        const wid = x.dataset.week; const i = +x.dataset.i;
        const wk = store.get('weeks', wid) || { id: wid, priorities: [], notes: '' };
        const pr = [...(wk.priorities || [])]; while (pr.length < 5) pr.push({ t: '', done: false });
        pr[i] = { ...pr[i], done: !pr[i].done };
        await store.put('weeks', { ...wk, priorities: pr });
      },
      'paste-list': () => openPasteList(),
      'new-ink': () => openInk(null),
      'new-wish': () => openWish(null),
    };
    if (A[act]) { e.preventDefault(); return A[act](); }
  }
  if ((x = el('[data-open-task]'))) return openTask(x.dataset.openTask);
  if ((x = el('[data-evt]'))) return openEvent(x.dataset.evt);
  if ((x = el('[data-new-on]'))) return openTask(null, { date: x.dataset.newOn });
  if ((x = el('[data-new-at]'))) { const [d, t] = x.dataset.newAt.split('|'); return openTask(null, { date: d, time: t }); }
  if ((x = el('[data-new-in-status]'))) return openTask(null, { status: x.dataset.newInStatus, area: 'trabalho' });
  if ((x = el('[data-goto-day]'))) { ui.cursor = parseYmd(x.dataset.gotoDay); ui.agendaMode = 'day'; viewAgenda._scrolled = false; persistUi(); return render(); }
  if ((x = el('[data-area]'))) { ui.area = x.dataset.area; persistUi(); return render(); }
  if ((x = el('[data-groupby]'))) { ui.groupBy = x.dataset.groupby; persistUi(); return render(); }
  if ((x = el('[data-taskmode]'))) { ui.taskMode = x.dataset.taskmode; persistUi(); return render(); }
  if ((x = el('[data-status-filter]'))) { ui.statusFilter = x.dataset.statusFilter; ui.area = 'all'; return go('tasks'); }
  if ((x = el('[data-qa-area]'))) { ui.qa.area = x.dataset.qaArea; persistUi(); return render(); }
  if ((x = el('[data-qa-date]'))) { ui.qa.date = ui.qa.date === x.dataset.qaDate ? null : x.dataset.qaDate; return render(); }
  if ((x = el('[data-amode]'))) { ui.agendaMode = x.dataset.amode; viewAgenda._scrolled = false; persistUi(); return render(); }
  if ((x = el('[data-nav]'))) {
    const n = +x.dataset.nav;
    if (n === 0) ui.cursor = new Date();
    else if (ui.agendaMode === 'day') ui.cursor = addDays(ui.cursor, n);
    else if (ui.agendaMode === 'week') ui.cursor = addDays(ui.cursor, 7 * n);
    else ui.cursor = addMonths(ui.cursor, n);
    viewAgenda._scrolled = false;
    return render();
  }
  if ((x = el('[data-idea-tag]'))) { ui.ideaTag = x.dataset.ideaTag; return render(); }
  if ((x = el('[data-idea]'))) return openIdea(x.dataset.idea);
  if ((x = el('[data-wish-cat]'))) { ui.wishCat = x.dataset.wishCat; return render(); }
  if ((x = el('[data-wish]'))) return openWish(x.dataset.wish);
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.closest('#sheet-root')) return;
  if (t.matches('[data-status-for]')) {
    const task = store.get('tasks', t.dataset.statusFor);
    if (task) { await store.put('tasks', { ...task, status: t.value }); toast(`Status: ${t.value || 'sem status'}`); }
  } else if (t.id === 'status-filter') { ui.statusFilter = t.value; render(); }
  else if (t.id === 'qa-status') { ui.qa.status = t.value; }
  else if (t.id === 'qa-date') { ui.qa.date = t.value || null; render(); }
});

const saveWeek = debounce(async (wid, fn) => {
  const wk = store.get('weeks', wid) || { id: wid, priorities: [], notes: '' };
  await store.put('weeks', fn({ ...wk, priorities: [...(wk.priorities || [])] }));
}, 500);

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.closest('#sheet-root')) return;
  if (t.id === 'task-search') { ui.search = t.value; partial?.(); }
  else if (t.id === 'idea-search') { ui.ideaSearch = t.value; partial?.(); }
  else if (t.matches('[data-week-notes]')) { const v = t.value; saveWeek(t.dataset.weekNotes, (wk) => ({ ...wk, notes: v })); }
  else if (t.matches('[data-week-prio]')) {
    const i = +t.dataset.weekPrio; const v = t.value;
    saveWeek(t.dataset.week, (wk) => { while (wk.priorities.length < 5) wk.priorities.push({ t: '', done: false }); wk.priorities[i] = { ...wk.priorities[i], t: v }; return wk; });
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  if (f.dataset.form === 'quickadd') {
    const inp = document.getElementById('qa-input');
    const title = inp.value.trim();
    if (!title) return;
    inp.value = '';
    const qa = ui.qa;
    const t = newTask({ title, area: qa.area, date: qa.date, fatal: qa.fatal, status: qa.area === 'trabalho' ? (qa.status || settings().statuses[0].name) : '' });
    if (t.date) t.reminders = defaultReminders(t);
    await saveTask(t, { silent: true });
    toast('Tarefa adicionada', { label: 'Detalhes', fn: () => openTask(t.id) });
  } else if (f.dataset.form === 'capture') {
    const inp = document.getElementById('capture-input');
    const title = inp.value.trim();
    if (!title) return;
    inp.value = '';
    const t = newTask({ title, area: ui.qa.area, date: todayStr() });
    await saveTask(t, { silent: true });
    toast('Anotado para hoje', { label: 'Detalhes', fn: () => openTask(t.id) });
  } else if (f.dataset.form === 'idea') {
    const inp = document.getElementById('idea-input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    await store.put('ideas', { id: uid(), text, tags: tagsOf(text) });
  }
});

// Ctrl/Cmd+Enter guarda a ideia; Enter sozinho quebra linha
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'idea-input' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.target.form.requestSubmit(); }
  if (e.target.closest('input, textarea, select') || document.querySelector('.sheet-backdrop')) return;
  if (e.key === 'n') { e.preventDefault(); openTask(null); }
});

// Arrastar cartões entre colunas (quadro por status)
document.addEventListener('dragstart', (e) => { const c = e.target.closest?.('[data-drag]'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.drag); e.dataTransfer.effectAllowed = 'move'; } });
document.addEventListener('dragover', (e) => { const col = e.target.closest?.('[data-col]'); if (col) { e.preventDefault(); document.querySelectorAll('.col.drop').forEach((x) => x !== col && x.classList.remove('drop')); col.classList.add('drop'); } });
document.addEventListener('dragleave', (e) => { const col = e.target.closest?.('[data-col]'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop'); });
document.addEventListener('drop', async (e) => {
  const col = e.target.closest?.('[data-col]'); if (!col) return;
  e.preventDefault(); col.classList.remove('drop');
  const t = store.get('tasks', e.dataTransfer.getData('text/plain'));
  if (t && t.status !== col.dataset.col) { await store.put('tasks', { ...t, status: col.dataset.col }); toast(`Movida para ${col.dataset.col || 'sem status'}`); }
});

// Botão flutuante (iPhone)
const fab = document.createElement('button');
fab.className = 'fab'; fab.setAttribute('aria-label', 'Adicionar'); fab.innerHTML = icon('plus');
fab.onclick = () => {
  if (ui.view === 'ideas') document.getElementById('idea-input')?.focus();
  else if (ui.view === 'wish') openWish(null);
  else if (ui.view === 'agenda') openTask(null, { date: ymd(ui.cursor) });
  else openTask(null, ui.view === 'home' ? { date: todayStr() } : {});
};
document.body.appendChild(fab);

// =====================================================================
// Início
// =====================================================================
// Inclui status novos em quem já tinha salvado uma lista personalizada (uma vez só)
let migrated = false;
function migrateSettings() {
  if (migrated) return;
  const doc = store.get('meta', 'settings');
  if (!doc) return; // ainda não carregou ou nunca salvou: os padrões já valem
  migrated = true;
  const done = doc.migrations || [];
  if (doc.statuses?.length && !done.includes('delegado') && !doc.statuses.some((x) => x.name === 'Delegado')) {
    store.put('meta', { ...doc, statuses: [...doc.statuses, { name: 'Delegado', color: '#2F6F6A' }], migrations: [...done, 'delegado'] });
  }
}
// Remove tarefas repetidas (mesmo título e área), mantendo a mais completa
const normTitle = (t) => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[–—-]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function taskScore(t) {
  return (t.gcalEventId ? 8 : 0) + (t.date ? 4 : 0) + (t.fatal ? 2 : 0) + ((t.notes || '').trim() ? 1 : 0)
    + ((t.checklist || []).length ? 1 : 0) + (t.client ? 1 : 0) + (t.process ? 1 : 0);
}
async function removeDuplicates({ silent } = {}) {
  const groups = new Map();
  for (const t of tasks()) {
    if (t.done) continue;
    const k = `${t.area}|${normTitle(t.title)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const removed = [];
  const merged = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => taskScore(b) - taskScore(a) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const keep = { ...list[0] };
    const newest = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    for (const t of list.slice(1)) {
      removed.push(t);
      for (const f of ['notes', 'client', 'process', 'type', 'date', 'time']) if (!keep[f] && t[f]) keep[f] = t[f];
      if (!(keep.checklist || []).length && (t.checklist || []).length) keep.checklist = t.checklist;
      keep.priority = Math.max(keep.priority || 0, t.priority || 0);
      keep.fatal = keep.fatal || t.fatal;
    }
    if (newest.status) keep.status = newest.status;
    merged.push(keep);
  }
  const before = merged.map((m) => ({ ...store.get('tasks', m.id) }));
  for (const m of merged) await store.put('tasks', m);
  for (const t of removed) {
    await store.remove('tasks', t.id);
    if (t.gcalEventId && gcal.connected()) gcal.deleteEvent(t.gcalCalendarId || 'primary', t.gcalEventId).catch(() => {});
  }
  if (removed.length) {
    toast(`${removed.length} tarefa${removed.length > 1 ? 's repetidas removidas' : ' repetida removida'}`, {
      label: 'Desfazer', fn: () => { before.forEach((t) => store.put('tasks', t)); removed.forEach((t) => store.put('tasks', { ...t, gcalEventId: null })); },
    });
  } else if (!silent) toast('Nenhuma tarefa repetida');
  return removed.length;
}
let dedupeChecked = false;
async function autoDedupe() {
  if (dedupeChecked || !store.ready('tasks') || !store.ready('meta')) return;
  dedupeChecked = true;
  const doc = store.get('meta', 'settings') || { id: 'settings' };
  const done = doc.migrations || [];
  if (done.includes('dedupe-1')) return;
  await store.put('meta', { ...doc, id: 'settings', migrations: [...done, 'dedupe-1'] });
  await removeDuplicates({ silent: true });
}
store.subscribe(autoDedupe);
store.subscribe(migrateSettings);
store.subscribe(applyBridgeConfig);
store.subscribe(render);
gcal.onChange(render);
render();
initStore(() => render()).then(() => {
  render();
  applyBridgeConfig();
  syncPendingToCalendar();
});

// Atualiza a tela quando o dia vira ou o app volta ao primeiro plano
let lastDay = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (todayStr() !== lastDay) { lastDay = todayStr(); ui.cursor = new Date(); } inflight.clear(); render(); syncPendingToCalendar(); if (gcal.configured()) refreshCalendars(); }
});
setInterval(() => { if (todayStr() !== lastDay) { lastDay = todayStr(); render(); } }, 60000);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Busca atualizações ao abrir/voltar ao app e recarrega quando houver versão nova
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading || document.querySelector('.sheet-backdrop')) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('SW', e));
}
