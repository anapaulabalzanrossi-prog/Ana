// Integração com a Google Agenda por meio de um conector (Google Apps Script)
// que roda na conta Google da usuária. Autorizado uma única vez, ele não
// expira: o app nunca mais pede para conectar.
import { ymd, addDays } from './utils.js';

const LS_CACHE = 'gcal-cache-v2';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let cfg = { url: '', key: '' };
const listeners = new Set();
const mem = new Map();
let cache = {};
try { cache = JSON.parse(localStorage.getItem(LS_CACHE) || '{}'); } catch { cache = {}; }

export const gcal = {
  configure(c) {
    const changed = c.url !== cfg.url || c.key !== cfg.key;
    cfg = { url: c.url || '', key: c.key || '' };
    if (changed) { mem.clear(); emit(); }
  },
  configured: () => !!(cfg.url && cfg.key),
  connected: () => !!(cfg.url && cfg.key),
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  ping, listCalendars, listEvents, cachedEvents, upsertTaskEvent, deleteEvent, createEvent,
};

function emit() { listeners.forEach((f) => f()); }

async function call(action, params = {}, { post = false, url = cfg.url, key = cfg.key } = {}) {
  if (!url || !key) throw Object.assign(new Error('Google Agenda não configurada'), { code: 'nogcal' });
  let r;
  if (post) {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...params, action, key, tz: TZ }) });
  } else {
    const q = new URLSearchParams({ ...params, action, key, tz: TZ });
    r = await fetch(`${url}?${q}`);
  }
  if (!r.ok) throw new Error(`Conector da agenda respondeu ${r.status}`);
  const data = await r.json().catch(() => { throw new Error('Resposta inválida do conector. Confira se ele foi publicado com acesso "Qualquer pessoa".'); });
  if (data.error === 'unauthorized') throw new Error('Chave do conector não confere. Copie o código de novo em Ajustes.');
  if (data.error) throw new Error(`Google Agenda: ${data.error}`);
  return data;
}

/** Testa um endereço antes de salvar */
function ping(url, key) { return call('ping', {}, { url, key }); }

async function listCalendars() {
  return (await call('calendars')).items || [];
}

const rangeKey = (a, b, ids) => `${ymd(a)}_${ymd(b)}_${ids.join(',')}`;

function cachedEvents(start, end, cals) {
  const k = rangeKey(start, end, cals.map((c) => c.id));
  return mem.get(k) || cache[k] || null;
}

async function listEvents(start, end, cals) {
  const k = rangeKey(start, end, cals.map((c) => c.id));
  const a = new Date(start); a.setHours(0, 0, 0, 0);
  const b = new Date(end); b.setHours(0, 0, 0, 0);
  const items = (await call('events', { from: +a, to: +b, cals: cals.map((c) => c.id).join(',') })).items || [];
  mem.set(k, items);
  cache[k] = items;
  const keys = Object.keys(cache);
  if (keys.length > 12) keys.slice(0, keys.length - 12).forEach((x) => delete cache[x]);
  try { localStorage.setItem(LS_CACHE, JSON.stringify(cache)); } catch { /* cheio */ }
  return items;
}

function times(date, time, minutes) {
  const s = new Date(`${date}T${time}:00`);
  return { start: +s, end: s.getTime() + minutes * 60000 };
}

/** Evento espelho da tarefa, com lembretes (sem horário, fica às 9h) */
async function upsertTaskEvent(task, calendarId = 'primary') {
  const prefix = task.fatal ? '⚖️ PRAZO FATAL: ' : task.area === 'trabalho' ? '⚖️ ' : '';
  const lines = [];
  if (task.client) lines.push(`Cliente: ${task.client}`);
  if (task.process) lines.push(`Processo: ${task.process}`);
  if (task.status) lines.push(`Status: ${task.status}`);
  if (task.notes) lines.push('', task.notes);
  lines.push('', 'Criado pela Minha Agenda');
  const r = await call('upsertTask', {
    taskId: task.id, eventId: task.gcalEventId || '', calId: task.gcalCalendarId || calendarId,
    title: (task.done ? '✓ ' : '') + prefix + task.title, description: lines.join('\n'),
    ...times(task.date, task.time || '09:00', 30),
    reminders: task.done ? [] : (task.reminders || []),
    color: task.fatal ? '11' : task.area === 'trabalho' ? '10' : '5',
  }, { post: true });
  mem.clear();
  return { eventId: r.eventId, calendarId: r.calId };
}

async function deleteEvent(calendarId, eventId) {
  await call('deleteEvent', { calId: calendarId, eventId }, { post: true });
  mem.clear();
}

async function createEvent({ title, date, time, minutes, location, notes, reminders, calendarId = 'primary' }) {
  const p = { title, location, description: notes, reminders, calId: calendarId };
  if (time) Object.assign(p, times(date, time, minutes));
  else Object.assign(p, { allDay: true, date, start: +new Date(`${date}T12:00:00`), end: +addDays(new Date(`${date}T12:00:00`), 1) });
  const r = await call('createEvent', p, { post: true });
  mem.clear();
  return r;
}
