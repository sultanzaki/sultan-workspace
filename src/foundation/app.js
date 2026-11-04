import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/components.css';
import './foundation.css';
import { readApiResponse } from './http.js';
import { setWorkspaceSession } from '../core/workspace-session.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = {
  user: null,
  csrfToken: '',
  workspaces: [],
  workspace: null,
  invitations: [],
  audit: [],
  mail: [],
  view: 'login',
  invite: null,
  token: '',
  busy: false,
  features: { email: false },
  setupAvailable: null,
};
const root = document.querySelector('#app');
const managementView = new URLSearchParams(location.search).get('manage') === '1';
document.body.classList.add('foundation-mode');
document.querySelectorAll('link[data-font]').forEach(link => {
  link.media = 'all';
});
const field = (label, key, type = 'text', value = '', extra = '') => {
  const id = `foundation-${key}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return `<div class="field"><label class="label" for="${id}">${label}</label><input class="input input-lg" id="${id}" name="${key}" type="${type}" value="${esc(value)}" required ${extra}></div>`;
};
const submit = label => `<button class="btn btn-primary" type="submit">${label}</button>`;
const roles = (selected, owner = true) =>
  (owner ? ['owner', 'admin', 'member'] : ['member']).map(role => `<option value="${role}" ${role === selected ? 'selected' : ''}>${role}</option>`).join('');
const canManage = () => ['owner', 'admin'].includes(state.workspace?.role);

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return readApiResponse(response);
}
function message(text, error = false) {
  const box = document.querySelector('#foundation-message');
  box.textContent = text;
  box.className = `foundation-message ${error ? 'bad' : 'ok'}`;
  box.setAttribute('role', error ? 'alert' : 'status');
  if (error) box.focus();
}
async function run(fn) {
  if (state.busy) return;
  state.busy = true;
  const buttons = [...root.querySelectorAll('button')];
  buttons.forEach(button => {
    button.disabled = true;
  });
  root.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (error) {
    if (error.status === 401 && state.user) {
      state.user = null;
      state.csrfToken = '';
      state.workspace = null;
      state.view = state.invite ? 'invite' : 'login';
      render();
    }
    message(error.message === 'Failed to fetch' ? 'Tidak dapat terhubung. Periksa koneksi lalu coba lagi.' : error.message, true);
  } finally {
    state.busy = false;
    buttons.forEach(button => {
      button.disabled = false;
    });
    root.removeAttribute('aria-busy');
  }
}
async function loadSession() {
  const session = await api('/auth/me');
  Object.assign(state, session);
}
async function loadWorkspace(id = state.workspace?.id || new URLSearchParams(location.search).get('workspace')) {
  const selected = state.workspaces.find(w => w.id === id || w.slug === id) || state.workspaces[0];
  state.workspace = null;
  state.invitations = [];
  state.audit = [];
  state.mail = [];
  if (!selected) return;
  state.workspace = await api(`/workspaces/${selected.id}`);
  if (!managementView) state.content = await api(`/workspaces/${selected.id}/content`);
  if (canManage() && managementView) {
    [state.invitations, state.audit, state.mail] = await Promise.all(
      ['invitations', 'audit', 'mail-status'].map(part => api(`/workspaces/${selected.id}/${part}`)),
    );
  }
}
async function refresh(id) {
  await loadSession();
  await loadWorkspace(id);
}
function authContent() {
  if (state.view === 'unsubscribe')
    return `<h1>Pengaturan email aktivitas</h1><p>${state.unsubscribeWorkspace ? `Nonaktifkan email aktivitas untuk ${esc(state.unsubscribeWorkspace)}?` : 'Memuat pengaturan email…'}</p><p>Email keamanan akun dan undangan tetap tersedia.</p>${state.unsubscribeWorkspace ? `<form data-form="unsubscribe">${submit('Nonaktifkan email aktivitas')}</form>` : ''}<button class="btn btn-ghost" data-action="login-view">Ke login</button>`;
  if (state.view === 'unsubscribed')
    return '<h1>Email aktivitas dinonaktifkan</h1><p>Anda dapat mengaktifkannya kembali melalui Settings → Email setelah login.</p><button class="btn" data-action="login-view">Ke login</button>';

  if (state.view === 'mfa')
    return `<h1>Verifikasi dua langkah</h1><p class="sub">Masukkan kode authenticator atau satu recovery code. Recovery code hanya dapat dipakai sekali.</p><form data-form="mfa-login">${field('Kode 2FA atau recovery code', 'code', 'text', '', 'autocomplete="one-time-code" maxlength="64"')}${submit('Verifikasi dan login')}</form><button class="btn btn-ghost" data-action="login-view">Kembali ke login</button>`;
  if (state.view === 'setup') {
    if (state.setupAvailable === null)
      return '<h1>Setup belum dapat dimuat</h1><p>Layanan akun belum dapat dihubungi. Coba muat ulang setelah layanan kembali tersedia.</p>';
    if (!state.setupAvailable)
      return '<h1>Setup owner tidak tersedia</h1><p>Setup belum diaktifkan atau akun pertama sudah dibuat. Jika akun sudah tersedia, lanjutkan ke login.</p><button class="btn" data-action="login-view">Ke login</button>';
    return `<h1>Buat akun owner</h1><p class="sub">Setup sekali pakai untuk pemilik workspace. Gunakan kunci setup yang Anda simpan di Vercel.</p><form data-form="owner-setup">${field('Kunci setup', 'setupToken', 'password', '', 'autocomplete="off" minlength="32" maxlength="256"')}${field('Nama lengkap', 'name', 'text', '', 'autocomplete="name" maxlength="100"')}${field('Email owner', 'email', 'email', '', 'autocomplete="username"')}${field('Nama workspace', 'workspace', 'text', '', 'maxlength="100"')}${field('Password baru', 'password', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"')}${field('Ulangi password', 'confirmation', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"')}${submit('Buat akun owner')}</form>`;
  }
  if (state.view === 'invite') {
    if (!state.invite)
      return '<h1>Undangan tidak tersedia</h1><p>Minta admin mengirim undangan baru.</p><button class="btn" data-action="login-view">Ke login</button>';
    const i = state.invite;
    if (state.user && state.user.email !== i.email)
      return `<h1>Ganti akun</h1><p>Undangan ditujukan untuk <b>${esc(i.email)}</b>.</p><button class="btn" data-action="logout">Logout untuk melanjutkan</button>`;
    return `<h1>Bergabung ke ${esc(i.workspace)}</h1><p class="sub">Undangan untuk ${esc(i.email)}. Tautan hanya dapat digunakan sekali.</p>
      ${i.existingAccount && !state.user ? `<p>Anda sudah memiliki akun. Login untuk menerima undangan.</p>${loginForm(i.email)}` : `<form data-form="accept-invite">${!state.user ? field('Nama lengkap', 'name', 'text', '', 'autocomplete="name" maxlength="100"') + field('Password baru', 'password', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"') : ''}${submit('Terima undangan')}</form>`}`;
  }
  if (state.view === 'forgot')
    return `<h1>Lupa password?</h1><p class="sub">Masukkan email akun Anda. Jika terdaftar, kami akan mengirim tautan reset.</p><form data-form="forgot">${field('Email', 'email', 'email', '', 'autocomplete="email"')}${submit('Kirim instruksi reset')}</form><button class="btn btn-ghost" data-action="login-view">Kembali ke login</button>`;
  if (state.view === 'reset')
    return `<h1>Password baru</h1><p class="sub">Gunakan minimal 12 karakter. Semua sesi lama akan dicabut setelah password diganti.</p><form data-form="reset">${field('Password baru', 'password', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"')}${field('Ulangi password', 'confirmation', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"')}${submit('Simpan password')}</form>`;
  return `<h1>Masuk ke workspace</h1><p class="sub">Gunakan akun tim Anda. Akun baru hanya dapat dibuat melalui undangan.</p>${loginForm()}<button class="btn btn-ghost" data-action="forgot-view">Lupa password?</button>`;
}
function loginForm(address = '') {
  return `<form data-form="login">${field('Email', 'email', 'email', address, `autocomplete="username" ${address ? 'readonly' : ''}`)}${field('Password', 'password', 'password', '', 'autocomplete="current-password" maxlength="128"')}<label class="row"><input type="checkbox" name="remember"> Ingat saya selama 30 hari</label>${submit('Login')}</form>`;
}
function workspaceContent() {
  const ws = state.workspace;
  if (!ws) return '<section class="foundation-panel"><h1>Belum ada akses workspace</h1><p>Minta owner mengundang Anda, atau buat workspace baru.</p></section>';
  const manager = canManage();
  return `<section class="foundation-panel"><div class="foundation-heading"><div><h1>${esc(ws.name)}</h1><p>Peran Anda: <b>${esc(ws.role)}</b></p></div><button class="btn" data-action="refresh">Muat ulang</button></div>
    <p class="foundation-note">Workspace, akun, anggota, dan tim di halaman ini tersimpan bersama. Integrasi proyek dan task akan dikerjakan pada tahap berikutnya.</p>
    ${manager ? `<form data-form="rename" class="foundation-inline">${field('Nama workspace', 'name', 'text', ws.name, 'maxlength="100"')}${submit('Ubah nama')}</form>` : ''}</section>
    <section class="foundation-panel"><h2>Anggota</h2><div class="foundation-table"><table><thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th>Status</th>${manager ? '<th>Kelola</th>' : ''}</tr></thead><tbody>${ws.members
      .map(member => {
        const editable = manager && (ws.role === 'owner' || member.role === 'member');
        return `<tr><td>${esc(member.name)}${member.id === state.user.id ? ' (Anda)' : ''}</td><td>${esc(member.email)}</td><td>${esc(member.role)}</td><td>${member.active ? 'Aktif' : 'Dinonaktifkan'}</td>${manager ? `<td>${editable ? `<form data-form="member" data-id="${member.id}" class="foundation-inline"><select class="input" name="role" aria-label="Peran ${esc(member.name)}">${roles(member.role, ws.role === 'owner')}</select><label class="row"><input type="checkbox" name="active" ${member.active ? 'checked' : ''}>Aktif</label>${submit('Simpan')}</form>` : 'Hanya owner'}</td>` : ''}</tr>`;
      })
      .join('')}</tbody></table></div></section>
    ${manager ? invitationContent() : ''}
    <section class="foundation-panel"><h2>Tim</h2>${manager ? `<form data-form="create-team" class="foundation-inline">${field('Nama tim', 'name', 'text', '', 'maxlength="100"')}${submit('Buat tim')}</form>` : ''}${
      ws.teams.length
        ? ws.teams
            .map(
              team =>
                `<div class="foundation-team"><h3>${esc(team.name)}</h3>${
                  manager
                    ? `<form data-form="team-members" data-id="${team.id}"><div class="foundation-checks">${ws.members
                        .filter(m => m.active)
                        .map(
                          m =>
                            `<label><input type="checkbox" name="member" value="${m.id}" ${team.members.includes(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`,
                        )
                        .join('')}</div>${submit('Simpan anggota tim')}</form>`
                    : `<p>${team.members.map(id => esc(ws.members.find(m => m.id === id)?.name)).join(', ') || 'Belum ada anggota.'}</p>`
                }</div>`,
            )
            .join('')
        : '<p>Belum ada tim.</p>'
    }</section>
    ${manager ? `<section class="foundation-panel"><h2>Riwayat administrasi</h2><p>100 kejadian terbaru.</p><ul class="foundation-audit">${state.audit.map(event => `<li><time>${esc(new Date(event.created_at).toLocaleString('id-ID'))}</time> · ${esc(event.actor)} · ${esc(event.action)}</li>`).join('')}</ul></section>` : ''}`;
}
function invitationContent() {
  return `<section class="foundation-panel"><h2>Undang anggota</h2>${state.features.email ? `<p>Undangan berlaku 48 jam. Mengundang ulang akan membatalkan tautan sebelumnya.</p><form data-form="invite" class="foundation-inline">${field('Email penerima', 'email', 'email')}<div class="field"><label class="label" for="invite-role">Peran</label><select class="input" id="invite-role" name="role">${roles('member', false)}${state.workspace.role === 'owner' ? '<option value="admin">admin</option>' : ''}</select></div>${submit('Kirim undangan')}</form>` : '<p>Pengiriman email belum diaktifkan. Login dan pengelolaan workspace tetap tersedia. Admin perlu mengatur SMTP untuk mengirim undangan dan email pemulihan akun.</p>'}
    <h3>Undangan aktif</h3>${state.invitations.length ? `<ul>${state.invitations.map(i => `<li>${esc(i.email)} · ${esc(i.role)} · kedaluwarsa ${esc(new Date(i.expires_at).toLocaleString('id-ID'))} ${state.workspace.role === 'owner' || i.role === 'member' ? `<button class="btn btn-ghost" data-action="revoke" data-id="${i.id}">Batalkan undangan</button>` : ''}</li>`).join('')}</ul>` : '<p>Tidak ada undangan aktif.</p>'}
    <details><summary>Status pengiriman email undangan</summary><ul>${state.mail.map(mail => `<li>${esc(mail.recipient)} · ${mail.sent_at ? 'Terkirim ke layanan email' : mail.attempts ? 'Pengiriman gagal, dijadwalkan ulang' : 'Menunggu pengiriman'}</li>`).join('') || '<li>Belum ada pengiriman.</li>'}</ul></details></section>`;
}
function render() {
  if (state.user && state.workspace && state.view === 'workspace' && !managementView) {
    root.innerHTML = '<main class="foundation-main" role="status">Membuka workspace…</main>';
    setWorkspaceSession({
      user: state.user,
      workspace: state.workspace,
      workspaces: state.workspaces,
      csrfToken: state.csrfToken,
      content: state.content,
      features: state.features,
    });
    document.body.classList.remove('foundation-mode');
    void import('../native-workspace.js').catch(() => {
      root.innerHTML =
        '<main class="foundation-main"><p role="alert">Workspace belum dapat dimuat. Silakan muat ulang halaman.</p><a href="/?manage=1">Kelola akun dan workspace</a></main>';
    });
    return;
  }
  document.documentElement.lang = 'id';
  document.title = state.user && state.view === 'workspace' ? `${state.workspace?.name || 'Workspace'} · Gr8r Studio` : 'Akun tim · Gr8r Studio';
  root.innerHTML = `<div class="foundation"><header class="foundation-header"><strong>Gr8r Studio</strong>${state.user ? `<div class="row">${state.workspace ? `<a class="btn" href="/?workspace=${state.workspace.id}">Buka workspace</a>` : ''}<span>${esc(state.user.name)}</span><button class="btn btn-ghost" data-action="logout">Logout</button></div>` : '<span>Akun tim</span>'}</header><main class="foundation-main ${state.view !== 'workspace' ? 'foundation-auth' : ''}"><div id="foundation-message" tabindex="-1" aria-live="polite"></div>${state.view === 'workspace' && state.user ? `<div class="foundation-switch"><label for="workspace-select">Workspace</label><select class="input" id="workspace-select">${state.workspaces.map(w => `<option value="${w.id}" ${w.id === state.workspace?.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>${workspaceContent()}<details class="foundation-panel"><summary>Buat workspace baru</summary><form data-form="create-workspace" class="foundation-inline">${field('Nama workspace baru', 'name', 'text', '', 'maxlength="100"')}${submit('Buat workspace')}</form></details>` : `<section class="foundation-panel">${authContent()}</section>`}</main></div>`;
}

root.addEventListener('submit', event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const values = new FormData(form),
    data = Object.fromEntries(values);
  void run(async () => {
    const base = `/workspaces/${state.workspace?.id}`;
    let notice = 'Perubahan disimpan.';
    switch (form.dataset.form) {
      case 'unsubscribe':
        await api('/email/unsubscribe', 'POST', { token: state.token });
        state.token = '';
        state.view = 'unsubscribed';
        render();
        return;
      case 'owner-setup':
        if (data.password !== data.confirmation) throw new Error('Konfirmasi password belum sesuai.');
        await api('/auth/setup', 'POST', {
          setupToken: data.setupToken,
          email: data.email,
          name: data.name,
          workspace: data.workspace,
          password: data.password,
        });
        form.reset();
        state.setupAvailable = false;
        state.view = 'login';
        history.replaceState(null, '', location.pathname + location.search);
        render();
        message('Akun owner berhasil dibuat. Silakan login. Setelah ini, hapus BOOTSTRAP_TOKEN dari Vercel.');
        return;
      case 'login': {
        const result = await api('/auth/login', 'POST', { email: data.email, password: data.password, remember: values.has('remember') });
        form.reset();
        if (result.requiresMfa) {
          state.challenge = result.challenge;
          state.view = 'mfa';
          render();
          return;
        }
        await refresh();
        state.view = state.invite ? 'invite' : 'workspace';
        render();
        return;
      }
      case 'mfa-login':
        await api('/auth/mfa/login', 'POST', { challenge: state.challenge, code: data.code });
        state.challenge = null;
        form.reset();
        await refresh();
        state.view = state.invite ? 'invite' : 'workspace';
        render();
        return;
      case 'accept-invite':
        await api('/auth/invitations/accept', 'POST', { token: state.token, ...(!state.user ? { name: data.name, password: data.password } : {}) });
        state.token = '';
        state.invite = null;
        await refresh();
        state.view = 'workspace';
        render();
        message('Undangan diterima. Selamat bergabung.');
        return;
      case 'forgot':
        await api('/auth/forgot-password', 'POST', { email: data.email });
        render();
        message('Jika akun terdaftar, instruksi reset password akan dikirim.');
        return;
      case 'reset':
        if (data.password !== data.confirmation) throw new Error('Konfirmasi password belum sesuai.');
        await api('/auth/reset-password', 'POST', { token: state.token, password: data.password });
        state.user = null;
        state.csrfToken = '';
        state.token = '';
        state.view = 'login';
        render();
        message('Password diperbarui. Silakan login kembali.');
        return;
      case 'create-workspace': {
        const ws = await api('/workspaces', 'POST', { name: data.name });
        await refresh(ws.id);
        render();
        message('Workspace dibuat.');
        return;
      }
      case 'rename':
        await api(base, 'PATCH', { name: data.name });
        break;
      case 'invite':
        await api(`${base}/invitations`, 'POST', { email: data.email, role: data.role });
        notice = 'Undangan masuk antrean pengiriman. Periksa status pengiriman bila email belum diterima.';
        break;
      case 'member':
        await api(`${base}/members/${form.dataset.id}`, 'PATCH', { role: data.role, active: values.has('active') });
        break;
      case 'create-team':
        await api(`${base}/teams`, 'POST', { name: data.name });
        break;
      case 'team-members':
        await api(`${base}/teams/${form.dataset.id}/members`, 'PUT', { members: values.getAll('member') });
        break;
      default:
        return;
    }
    await refresh();
    render();
    message(notice);
  });
});
root.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  void run(async () => {
    switch (button.dataset.action) {
      case 'forgot-view':
        state.view = 'forgot';
        render();
        break;
      case 'login-view':
        state.view = 'login';
        if (location.hash === '#setup') history.replaceState(null, '', location.pathname + location.search);
        render();
        break;
      case 'refresh':
        await refresh();
        render();
        message('Data dimuat ulang.');
        break;
      case 'logout':
        await api('/auth/logout', 'POST', {});
        state.user = null;
        state.csrfToken = '';
        state.workspace = null;
        state.view = state.invite ? 'invite' : 'login';
        render();
        break;
      case 'revoke':
        await api(`/workspaces/${state.workspace.id}/invitations/${button.dataset.id}`, 'DELETE', {});
        await refresh();
        render();
        message('Undangan dibatalkan.');
        break;
    }
  });
});
root.addEventListener('change', event => {
  if (event.target.id === 'workspace-select')
    void run(async () => {
      await loadWorkspace(event.target.value);
      render();
    });
});

async function boot() {
  root.innerHTML = '<main class="foundation-main" role="status">Memuat akun tim…</main>';
  state.user = null;
  state.csrfToken = '';
  state.workspace = null;
  state.workspaces = [];
  state.invite = null;
  state.token = '';
  state.view = 'login';
  state.setupAvailable = null;
  state.unsubscribeWorkspace = null;
  const setup = location.hash === '#setup';
  if (setup) state.view = 'setup';
  const hash = location.hash.slice(1).match(/^(invite|reset|unsubscribe)=([a-f0-9]{64})$/);
  if (hash) {
    state.token = hash[2];
    state.view = hash[1];
    history.replaceState(null, '', location.pathname + location.search);
  }
  try {
    try {
      if (hash?.[1] !== 'unsubscribe') await refresh();
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    if (setup) state.setupAvailable = (await api('/auth/setup')).available;
    else if (hash?.[1] === 'invite') state.invite = await api('/auth/invitations/inspect', 'POST', { token: state.token });
    else if (hash?.[1] === 'unsubscribe') state.unsubscribeWorkspace = (await api('/email/unsubscribe/inspect', 'POST', { token: state.token })).workspace;
    else if (!hash && state.user) state.view = 'workspace';
    render();
  } catch (error) {
    render();
    message(error.message, true);
  }
}
// Email links may be opened in an already-running tab without a document reload.
window.addEventListener('hashchange', () => {
  if (location.hash === '#setup' || /^#(invite|reset|unsubscribe)=[a-f0-9]{64}$/.test(location.hash)) void boot();
});
void boot();
