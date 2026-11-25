// Integração com a Google Agenda (leitura de compromissos e criação de
// eventos com lembretes, que viram notificações no iPhone/iPad/Mac).
import { GOOGLE_CLIENT_ID } from './config.js';
import { ymd, pad, addDays } from './utils.js';

const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';
const LS_TOKEN = 'gcal-token';
const LS_CACHE = 'gcal-cache';

let tokenClient = null;
let gisLoaded = null;
const listeners = new Set();
const mem = new Map(); // cache por intervalo
let cache = {};
try { cache = JSON.parse(localStorage.getItem(LS_CACHE) || '{}'); } catch { cache = {}; }

export const gcal = {
  configured: () => !!GOOGLE_CLIENT_ID,
  connected: () => !!token(),
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  connect, disconnect, listCalendars, listEvents, cachedEvents, upsertTaskEvent, deleteEvent, createEvent, updateEvent,
};

function emit() { listeners.forEach((f) => f()); }

function token() {
  try {
    const t = JSON.parse(localStorage.getItem(LS_TOKEN) || 'null');
    if (t && t.exp > Date.now() + 60000) return t.access;
  } catch { /* ignora */ }
  return null;
}
const hadConsent = () => localStorage.getItem('gcal-consented') === '1';

function loadGis() {
  if (!gisLoaded) gisLoaded = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.onload = res; s.onerror = () => rej(new Error('Não foi possível carregar o login do Google'));
    document.head.appendChild(s);
  });
  return gisLoaded;
}

async function connect(loginHint) {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google Agenda ainda não configurada (veja o GUIA.md)');
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        localStorage.setItem(LS_TOKEN, JSON.stringify({ access: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 }));
        localStorage.setItem('gcal-consented', '1');
        mem.clear(); emit(); resolve();
      },
      error_callback: (e) => reject(new Error(e?.message || 'Conexão cancelada')),
    });
    tokenClient.requestAccessToken({ prompt: hadConsent() ? '' : 'consent', login_hint: loginHint || undefined });
  });
}

function disconnect() {
  const t = token();
  if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem('gcal-consented');
  mem.clear(); emit();
}

async function api(path, opts = {}) {
  const t = token();
  if (!t) throw Object.assign(new Error('Google Agenda desconectada'), { code: 'nogcal' });
  const r = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { localStorage.removeItem(LS_TOKEN); emit(); throw Object.assign(new Error('Sessão da Google Agenda expirou'), { code: 'nogcal' }); }
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`Google Agenda: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function listCalendars() {
  const r = await api('/users/me/calendarList?minAccessRole=reader');
  return (r.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor, primary: !!c.primary, writable: ['owner', 'writer'].includes(c.accessRole), selected: c.selected !== false }));
}

function normalize(e, calId, color) {
  const allDay = !!e.start?.date;
  const start = allDay ? new Date(e.start.date + 'T12:00:00') : new Date(e.start?.dateTime);
  const end = allDay ? new Date(e.end.date + 'T12:00:00') : new Date(e.end?.dateTime);
  return {
    id: e.id, calId, title: e.summary || '(sem título)', allDay, start: +start, end: +end,
    date: allDay ? e.start.date : ymd(start), endDate: allDay ? ymd(addDays(end, -1)) : ymd(end),
    link: e.htmlLink, location: e.location || '', description: e.description || '', color,
    taskId: e.extendedProperties?.private?.agendaTaskId || null,
  };
}

const key = (a, b, ids) => `${ymd(a)}_${ymd(b)}_${ids.join(',')}`;

/** Eventos do cache (para exibir na hora, mesmo offline) */
function cachedEvents(start, end, cals) {
  const k = key(start, end, cals.map((c) => c.id));
  return mem.get(k) || cache[k] || null;
}

/** Busca eventos de várias agendas no intervalo [start, end) */
async function listEvents(start, end, cals) {
  const k = key(start, end, cals.map((c) => c.id));
  const tMin = new Date(start); tMin.setHours(0, 0, 0, 0);
  const tMax = new Date(end); tMax.setHours(0, 0, 0, 0);
  const all = [];
  await Promise.all(cals.map(async (c) => {
    let pageToken = '';
    do {
      const q = new URLSearchParams({ timeMin: tMin.toISOString(), timeMax: tMax.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await api(`/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      for (const e of r.items || []) if (e.status !== 'cancelled') all.push(normalize(e, c.id, c.color));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
  }));
  all.sort((a, b) => a.start - b.start);
  mem.set(k, all);
  cache[k] = all;
  const keys = Object.keys(cache);
  if (keys.length > 12) keys.slice(0, keys.length - 12).forEach((x) => delete cache[x]);
  try { localStorage.setItem(LS_CACHE, JSON.stringify(cache)); } catch { /* cheio */ }
  return all;
}

function eventTimes(date, time, minutes = 30) {
  if (!time) return { start: { date }, end: { date: ymd(addDays(new Date(date + 'T12:00:00'), 1)) } };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const s = new Date(`${date}T${time}:00`);
  const e = new Date(s.getTime() + minutes * 60000);
  const iso = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  return { start: { dateTime: iso(s), timeZone: tz }, end: { dateTime: iso(e), timeZone: tz } };
}

/**
 * Cria/atualiza na Google Agenda o evento espelho de uma tarefa com data,
 * com lembretes "pop-up" (notificação no celular). Sem horário definido,
 * o evento é criado às 9h para que os lembretes funcionem.
 */
async function upsertTaskEvent(task, calendarId = 'primary') {
  const prefix = task.fatal ? '⚖️ PRAZO FATAL: ' : task.area === 'trabalho' ? '⚖️ ' : '';
  const lines = [];
  if (task.client) lines.push(`Cliente: ${task.client}`);
  if (task.process) lines.push(`Processo: ${task.process}`);
  if (task.status) lines.push(`Status: ${task.status}`);
  if (task.notes) lines.push('', task.notes);
  lines.push('', 'Criado pela Minha Agenda');
  const body = {
    summary: (task.done ? '✓ ' : '') + prefix + task.title,
    description: lines.join('\n'),
    ...eventTimes(task.date, task.time || '09:00', 30),
    reminders: { useDefault: false, overrides: task.done ? [] : (task.reminders || []).slice(0, 5).map((m) => ({ method: 'popup', minutes: m })) },
    colorId: task.fatal ? '11' : task.area === 'trabalho' ? '10' : '5',
    extendedProperties: { private: { agendaTaskId: task.id } },
  };
  const cal = encodeURIComponent(task.gcalCalendarId || calendarId);
  let r;
  if (task.gcalEventId) {
    try { r = await api(`/calendars/${cal}/events/${encodeURIComponent(task.gcalEventId)}`, { method: 'PATCH', body: JSON.stringify(body) }); }
    catch (e) { if (e.code === 'nogcal') throw e; r = null; }
  }
  if (!r) r = await api(`/calendars/${cal}/events`, { method: 'POST', body: JSON.stringify(body) });
  mem.clear();
  return { eventId: r.id, calendarId: task.gcalCalendarId || calendarId };
}

async function deleteEvent(calendarId, eventId) {
  try { await api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }); }
  catch (e) { if (e.code === 'nogcal') throw e; }
  mem.clear();
}

/** Novo compromisso direto na Google Agenda */
async function createEvent({ title, date, time, minutes, location, notes, reminders, calendarId = 'primary' }) {
  const body = {
    summary: title, location, description: notes, ...eventTimes(date, time, minutes),
    reminders: reminders?.length ? { useDefault: false, overrides: reminders.map((m) => ({ method: 'popup', minutes: m })) } : { useDefault: true },
  };
  const r = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(body) });
  mem.clear();
  return r;
}

async function updateEvent(calendarId, eventId, { title, date, time, minutes, location, notes }) {
  const body = { summary: title, location, description: notes, ...eventTimes(date, time, minutes) };
  const r = await api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify(body) });
  mem.clear();
  return r;
}
