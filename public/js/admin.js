// User management: list, add, change role, remove. The site is open to all;
// what a role grants is admin access to this page.
import { esc } from './util.js?v=af4e5eeeb8';

const $ = (s) => document.querySelector(s);
const ROLE = { admin: 'אדמין', viewer: 'רגיל' };
const when = (t) => (t ? new Date(t).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const say = (m, bad) => { $('#msg').textContent = m; $('#msg').className = `small ${bad ? 'neg' : ''}`; };

async function load() {
  const users = await api('GET', '/api/users');
  const order = { admin: 0, viewer: 1 };
  users.sort((a, b) => order[a.role] - order[b.role] || a.email.localeCompare(b.email));
  $('#users').innerHTML = users.map((u) => `<tr data-email="${esc(u.email)}">
    <td>${esc(u.email)}</td>
    <td>${u.env_admin ? `${ROLE.admin} <span class="muted">(ENV)</span>` : `<select data-role>
      ${['admin', 'viewer'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE[r]}</option>`).join('')}
    </select>`}</td>
    <td>${esc(u.added_by || '')}</td><td>${when(u.created_at)}</td>
    <td>${u.env_admin ? '' : '<button type="button" data-del>הסר</button>'}</td>
  </tr>`).join('');
}

$('#users').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-role]');
  if (!sel) return;
  const email = sel.closest('tr').dataset.email;
  try { await api('POST', '/api/users', { email, role: sel.value }); say(`${email}: ${ROLE[sel.value]}`); } catch (err) { say(err.message, true); }
  load();
});
$('#users').addEventListener('click', async (e) => {
  const email = e.target.closest('tr')?.dataset.email;
  try {
    if (e.target.matches('[data-del]')) {
      if (!confirm(`להסיר את ${email}?`)) return;
      await api('DELETE', `/api/users/${encodeURIComponent(email)}`);
      say(`${email} הוסר`);
    } else return;
  } catch (err) { say(err.message, true); }
  load();
});
$('#add').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/users', { email: $('#email').value.trim(), role: $('#role').value });
    say(`${$('#email').value.trim()}: ${ROLE[$('#role').value]}`);
    $('#email').value = '';
  } catch (err) { say(err.message, true); }
  load();
};

api('GET', '/api/me').then((me) => {
  $('#me').innerHTML = `${esc(me.email)} · ${ROLE[me.role]}<br><a href="${esc(me.logout)}">התנתקות</a>`;
});
load().catch((err) => say(err.message, true));
