// Código do "conector" da Google Agenda. Ele roda no Google Apps Script,
// dentro da conta Google da própria usuária, e fica autorizado para sempre.
// A chave é gerada no aparelho e nunca fica neste repositório.

export function bridgeScript(key) {
  return `// Minha Agenda – conector da Google Agenda
// Cole este código em script.google.com e publique como "App da Web".
const KEY = '${key}';

function doGet(e) { return handle_(e.parameter || {}); }
function doPost(e) { return handle_(JSON.parse((e.postData && e.postData.contents) || '{}')); }

function handle_(p) {
  if (p.key !== KEY) return out_({ error: 'unauthorized' });
  try {
    const tz = p.tz || Session.getScriptTimeZone();
    switch (p.action) {
      case 'ping': return out_({ ok: true });
      case 'calendars': return out_({ items: calendars_() });
      case 'events': return out_({ items: events_(p, tz) });
      case 'upsertTask': return out_(upsertTask_(p));
      case 'createEvent': return out_(createEvent_(p));
      case 'deleteEvent': return out_(deleteEvent_(p));
      default: return out_({ error: 'acao desconhecida' });
    }
  } catch (err) {
    return out_({ error: String(err && err.message || err) });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function cal_(id) {
  const c = (!id || id === 'primary') ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
  if (!c) throw new Error('Agenda nao encontrada');
  return c;
}

function calendars_() {
  const def = CalendarApp.getDefaultCalendar().getId();
  return CalendarApp.getAllCalendars().map(function (c) {
    return { id: c.getId(), name: c.getName(), color: c.getColor(), primary: c.getId() === def,
      writable: c.isOwnedByMe(), selected: !c.isHidden() && c.isSelected() };
  });
}

function events_(p, tz) {
  const from = new Date(Number(p.from)), to = new Date(Number(p.to));
  const ids = String(p.cals || 'primary').split(',');
  const res = [];
  ids.forEach(function (id) {
    let c; try { c = cal_(id); } catch (e) { return; }
    const color = c.getColor();
    c.getEvents(from, to).forEach(function (ev) {
      const allDay = ev.isAllDayEvent();
      const s = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
      const en = allDay ? ev.getAllDayEndDate() : ev.getEndTime();
      const endIncl = allDay ? new Date(en.getTime() - 86400000) : en;
      res.push({
        id: ev.getId(), key: ev.getId() + '_' + s.getTime(), calId: c.getId(), title: ev.getTitle() || '(sem titulo)',
        allDay: allDay, start: s.getTime(), end: en.getTime(),
        date: Utilities.formatDate(s, tz, 'yyyy-MM-dd'), endDate: Utilities.formatDate(endIncl, tz, 'yyyy-MM-dd'),
        location: ev.getLocation() || '', description: ev.getDescription() || '', color: color,
        taskId: ev.getTag('agendaTaskId') || null
      });
    });
  });
  res.sort(function (a, b) { return a.start - b.start; });
  return res;
}

function setReminders_(ev, list) {
  ev.removeAllReminders();
  (list || []).slice(0, 5).forEach(function (m) { ev.addPopupReminder(Number(m)); });
}

function upsertTask_(p) {
  const c = cal_(p.calId);
  let ev = p.eventId ? c.getEventById(p.eventId) : null;
  const start = new Date(Number(p.start)), end = new Date(Number(p.end));
  if (ev) {
    ev.setTitle(p.title); ev.setTime(start, end); ev.setDescription(p.description || '');
  } else {
    ev = c.createEvent(p.title, start, end, { description: p.description || '' });
  }
  ev.setTag('agendaTaskId', p.taskId);
  setReminders_(ev, p.reminders);
  if (p.color) try { ev.setColor(String(p.color)); } catch (e) {}
  return { eventId: ev.getId(), calId: c.getId() };
}

function createEvent_(p) {
  const c = cal_(p.calId);
  let ev;
  if (p.allDay) {
    const parts = String(p.date).split('-');
    ev = c.createAllDayEvent(p.title, new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])), { description: p.description || '', location: p.location || '' });
  } else {
    ev = c.createEvent(p.title, new Date(Number(p.start)), new Date(Number(p.end)), { description: p.description || '', location: p.location || '' });
  }
  if (p.reminders && p.reminders.length) setReminders_(ev, p.reminders);
  return { eventId: ev.getId() };
}

function deleteEvent_(p) {
  const ev = cal_(p.calId).getEventById(p.eventId);
  if (ev) ev.deleteEvent();
  return { ok: true };
}
`;
}
