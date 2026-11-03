import { projectAllows } from '../core/permissions.js';
import { S } from '../core/store.js';
import { getWorkspaceSession } from '../core/workspace-session.js';
import { esc, fmtInstant } from '../core/utils.js';
import { av } from '../ui/helpers.js';

export const NATIVE_SETTINGS = ['profile', 'password', 'sessions', '2fa', 'workspace', 'members', 'teams', 'permissions', 'language', 'datetime'];
const input = (label, id, value = '', type = 'text', extra = '') =>
  `<div class="field"><label class="label" for="${id}">${label}</label><input class="input" id="${id}" type="${type}" value="${esc(value)}" ${extra}></div>`;
const button = (action, label, extra = '') => `<button class="btn btn-secondary" data-a="${action}" ${extra}>${label}</button>`;
const fieldPassword = () => input('Password saat ini', 'native-current-password', '', 'password', 'autocomplete="current-password" maxlength="128"');
export function nativeSettingsBody(sec) {
  const session = getWorkspaceSession(),
    account = session.account,
    manager = ['owner', 'admin'].includes(session.workspace.role),
    role = session.workspace.role;
  if (['profile', 'password', 'sessions', '2fa'].includes(sec) && !account)
    return '<h1>Pengaturan akun</h1><p role="status">Memuat data akun…</p><button class="btn" data-a="nativeReloadAccount">Coba lagi</button>';
  const user = account?.user || session.user,
    disabled = session.accountSaving ? 'disabled' : '';
  if (sec === 'profile')
    return `<h1>Profil</h1><form data-submit="nativeSaveProfile" class="col" style="max-width:480px;gap:14px"><div class="row" style="gap:12px">${av(S.data.me, 'lg', false)}<label class="btn btn-secondary">Upload foto<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-in="nativeAvatar" aria-label="Upload foto profil"></label>${user.avatar ? button('nativeRemoveAvatar', 'Hapus foto') : ''}</div><p class="faint">PNG, JPEG, atau WebP; maksimal 256 KB.</p>${input('Nama lengkap', 'native-profile-name', user.name, 'text', 'maxlength="100" required')}${input('Jabatan', 'native-profile-title', user.title || '', 'text', 'maxlength="100"')}${input('Warna avatar', 'native-profile-color', user.color || '#4B5BD6', 'color')}${input('Email', 'native-profile-email', user.email, 'email', 'readonly')}<button class="btn btn-primary" data-a="nativeSaveProfile" ${disabled}>Simpan profil</button></form>`;
  if (sec === 'password')
    return `<h1>Ganti password</h1><p class="lead">Sesudah password diganti, semua sesi dicabut dan Anda perlu login kembali.</p><form data-submit="nativeSavePassword" class="col" style="max-width:480px;gap:14px">${fieldPassword()}${input('Password baru', 'native-new-password', '', 'password', 'autocomplete="new-password" minlength="12" maxlength="128"')}${input('Ulangi password baru', 'native-confirm-password', '', 'password', 'autocomplete="new-password" minlength="12" maxlength="128"')}${account.mfa.enabled ? input('Kode 2FA atau recovery code', 'native-factor', '', 'text', 'autocomplete="one-time-code" maxlength="64"') : ''}<button class="btn btn-primary" data-a="nativeSavePassword" ${disabled}>Ganti password</button></form>`;
  if (sec === 'sessions')
    return `<h1>Sesi login</h1><p class="lead">Perangkat yang masih memiliki sesi aktif untuk akun Anda.</p>${button('nativeReloadAccount', 'Muat ulang')}${button('nativeRevokeOthers', 'Keluar dari sesi lain')}<div class="stack" style="margin-top:16px">${(session.accountSessions || []).map(s => `<div class="panel" style="padding:14px"><div class="row"><b class="grow" style="overflow-wrap:anywhere">${esc(s.agent)}</b>${s.current ? '<span class="badge">Sesi ini</span>' : button('nativeRevokeSession', 'Cabut sesi', `data-id="${s.id}"`)}</div><p class="faint">Login ${esc(fmtInstant(s.createdAt, S.prefs))} · Berlaku sampai ${esc(fmtInstant(s.expiresAt, S.prefs))}</p></div>`).join('')}</div>`;
  if (sec === '2fa') {
    const setup = session.mfaSetup,
      codes = session.recoveryCodes;
    if (codes)
      return `<h1>Kode pemulihan 2FA</h1><p class="lead">Simpan kode ini di tempat aman. Setiap kode hanya dapat dipakai sekali dan hanya ditampilkan pada kesempatan ini.</p><pre style="padding:16px;background:var(--surface-2)">${codes.map(esc).join('\n')}</pre>${button('nativeDownloadRecovery', 'Unduh kode pemulihan')}${button('nativeDismissRecovery', 'Sudah saya simpan')}`;
    if (setup)
      return `<h1>Hubungkan authenticator</h1><p class="lead">Pindai QR memakai aplikasi authenticator, lalu masukkan kode enam digit.</p>${setup.qr ? `<img src="${esc(setup.qr)}" alt="QR setup authenticator" width="200" height="200">` : ''}<p><code style="overflow-wrap:anywhere">${esc(setup.secret)}</code></p><form data-submit="nativeConfirmMfa" class="col" style="max-width:400px;gap:12px">${input('Kode authenticator', 'native-factor', '', 'text', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"')}<button class="btn btn-primary" data-a="nativeConfirmMfa" ${disabled}>Aktifkan 2FA</button>${button('nativeCancelMfa', 'Batal')}</form>`;
    if (!account.mfa.enabled)
      return `<h1>Autentikasi dua langkah</h1><p class="lead">Tambahkan kode authenticator selain password. Tidak membutuhkan email.</p>${account.mfa.configured ? `<form data-submit="nativeSetupMfa" class="col" style="max-width:400px;gap:12px">${fieldPassword()}<button class="btn btn-primary" data-a="nativeSetupMfa" ${disabled}>Mulai setup 2FA</button></form>` : '<p>Admin perlu mengonfigurasi kunci keamanan server sebelum 2FA dapat diaktifkan. Lihat panduan akun untuk AUTH_ENCRYPTION_KEY.</p>'}`;
    return `<h1>Autentikasi dua langkah aktif</h1><p class="lead">Tersisa ${account.mfa.recoveryCodes} recovery code. Masukkan password dan kode baru untuk tindakan berikut.</p><div class="col" style="max-width:420px;gap:12px">${fieldPassword()}${input('Kode 2FA atau recovery code', 'native-factor', '', 'text', 'autocomplete="one-time-code" maxlength="64"')}${button('nativeRegenerateRecovery', 'Buat ulang recovery code', disabled)}${button('nativeDisableMfa', 'Nonaktifkan 2FA', disabled)}</div>`;
  }
  if (sec === 'workspace')
    return `<h1>Workspace</h1><div class="col" style="max-width:480px;gap:14px">${input('Nama workspace', 'native-workspace-name', S.data.ws.name, 'text', manager ? 'maxlength="100"' : 'readonly')}${input('Alamat singkat workspace', 'native-workspace-slug', session.workspace.slug || '', 'text', manager ? 'minlength="3" maxlength="60" placeholder="contoh: tim-sultan"' : 'readonly')}${input('Warna workspace', 'native-workspace-color', S.data.ws.c, 'color', manager ? '' : 'disabled')}<p style="overflow-wrap:anywhere">${esc(location.origin)}/?workspace=${esc(session.workspace.slug || session.workspace.id)}</p>${manager ? `<button class="btn btn-primary" data-a="nativeSaveWorkspace">Simpan workspace</button>` : ''}</div>${role === 'owner' ? `<div class="sblock"><h2>Hapus workspace</h2><p>Seluruh proyek, task, file, dan komentar dalam workspace akan dihapus permanen.</p><button class="btn btn-danger" data-a="nativeDeleteWorkspace">Hapus workspace</button></div>` : ''}`;
  if (sec === 'members')
    return `<h1>Anggota workspace</h1>${manager ? `${button('nativeInvite', 'Undang anggota')}${button('nativeLoadAdministration', 'Muat ulang')}` : ''}<div class="stack" style="margin-top:14px">${S.data.members.map(m => `<div class="panel row" style="padding:12px;gap:10px">${av(m.id, 'md', false)}<div class="grow"><b>${esc(m.name)}</b><div class="faint">${esc(m.email)} · ${m.status === 'active' ? 'Aktif' : 'Nonaktif'}</div></div>${manager ? `<select class="select" data-in="nativeMemberRole" data-id="${m.id}" ${role !== 'owner' && ['Owner', 'Admin'].includes(m.role) ? 'disabled' : ''} aria-label="Role ${esc(m.name)}">${(role === 'owner' ? ['owner', 'admin', 'member', 'guest'] : ['Owner', 'Admin'].includes(m.role) ? [m.role.toLowerCase()] : ['member', 'guest']).map(r => `<option value="${r}" ${r === m.role.toLowerCase() ? 'selected' : ''}>${r}</option>`).join('')}</select>${button('nativeMemberToggle', m.status === 'active' ? 'Nonaktifkan' : 'Aktifkan', `data-id="${m.id}" ${role !== 'owner' && ['Owner', 'Admin'].includes(m.role) ? 'disabled' : ''}`)}` : `<span class="badge">${esc(m.role)}</span>`}</div>`).join('')}</div>${manager ? `<h2 style="margin-top:20px">Undangan aktif</h2>${(session.invitations || []).map(i => `<div class="panel row" style="padding:12px"><span class="grow">${esc(i.email)} · ${esc(i.role)} · ${esc(i.delivery)}</span>${session.features.email ? button('nativeResendInvitation', 'Kirim ulang email', `data-id="${i.id}"`) : ''}${button('nativeRenewInvitation', 'Buat link baru', `data-id="${i.id}"`)}${button('nativeRevokeInvitation', 'Batalkan', `data-id="${i.id}"`)}</div>`).join('') || '<p>Belum ada undangan aktif.</p>'}` : ''}`;
  if (sec === 'teams')
    return `<h1>Tim</h1>${manager ? button('nativeNewTeam', 'Buat tim') : ''}<div class="stack" style="margin-top:14px">${S.data.teams.map(t => `<div class="panel" style="padding:14px"><div class="row"><h2 class="grow">${esc(t.name)}</h2>${manager ? button('nativeEditTeam', 'Edit tim', `data-id="${t.id}"`) + button('nativeDeleteTeam', 'Hapus tim', `data-id="${t.id}"`) : ''}</div><p>${t.members.map(id => esc(S.data.members.find(m => m.id === id)?.name || '')).join(', ') || 'Belum ada anggota.'}</p></div>`).join('') || '<p>Belum ada tim.</p>'}</div>`;
  if (sec === 'permissions')
    return `<h1>Izin dan permintaan akses</h1>${manager ? `<div class="sblock"><label class="row"><input type="checkbox" data-in="nativeWorkspacePolicy" data-key="membersCanCreateProjects" ${S.data.ws.settings.membersCanCreateProjects !== false ? 'checked' : ''}>Anggota internal boleh membuat proyek</label><label class="row"><input type="checkbox" data-in="nativeWorkspacePolicy" data-key="leadCanInviteGuests" ${S.data.ws.settings.leadCanInviteGuests ? 'checked' : ''}>Lead proyek boleh mengundang guest ke proyeknya</label></div>` : ''}<p>Viewer hanya membaca; commenter dapat berdiskusi; editor dapat mengubah task, event, dan file. Lead proyek serta owner/admin mengelola akses.</p>${button('nativeLoadAdministration', 'Muat permintaan akses')}<div class="stack" style="margin-top:14px">${(session.accessRequests || []).map(r => `<div class="panel" style="padding:12px"><div><b>${esc(r.projectName)}</b> · ${esc(r.name)} · ${esc(r.permission)} · ${esc(r.status)}</div><p>${esc(r.reason)}</p>${r.canDecide && r.status === 'pending' ? button('nativeApproveAccess', 'Setujui', `data-id="${r.id}"`) + button('nativeRejectAccess', 'Tolak', `data-id="${r.id}"`) : ''}</div>`).join('') || '<p>Belum ada permintaan.</p>'}</div>`;
  if (sec === 'language')
    return `<h1>Bahasa</h1><label class="label" for="native-language">Bahasa antarmuka</label><select class="select" id="native-language" data-in="prefSel" data-k="lang"><option value="en-US" ${!['id-ID', 'Bahasa Indonesia'].includes(S.prefs.lang) ? 'selected' : ''}>English</option><option value="id-ID" ${['id-ID', 'Bahasa Indonesia'].includes(S.prefs.lang) ? 'selected' : ''}>Bahasa Indonesia</option></select><p class="faint">Isi proyek, task, dan komentar tidak diterjemahkan.</p><label class="row"><input type="checkbox" data-in="prefToggle" data-k="spell" ${S.prefs.spell !== false ? 'checked' : ''}>Pemeriksaan ejaan</label>`;
  if (sec === 'datetime')
    return `<h1>Tanggal dan waktu</h1><div class="col" style="max-width:450px;gap:14px"><label class="label" for="native-timezone">Zona waktu</label><select class="select" id="native-timezone" data-in="prefSel" data-k="tz">${['UTC', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'Pacific/Auckland'].map(zone => `<option value="${zone}" ${S.prefs.tz === zone ? 'selected' : ''}>${zone}</option>`).join('')}</select><label class="label" for="native-dateformat">Format tanggal</label><select class="select" id="native-dateformat" data-in="prefSel" data-k="dateFmt">${[
      ['MMM d', 'Jan 31'],
      ['d/M', '31/1'],
      ['M/d', '1/31'],
      ['yyyy-MM-dd', '2037-01-31'],
    ]
      .map(([v, label]) => `<option value="${v}" ${S.prefs.dateFmt === v ? 'selected' : ''}>${label}</option>`)
      .join(
        '',
      )}</select><label class="label" for="native-weekstart">Awal minggu</label><select class="select" id="native-weekstart" data-in="prefSel" data-k="weekStart">${[
      [0, 'Minggu'],
      [1, 'Senin'],
      [6, 'Sabtu'],
    ]
      .map(([v, label]) => `<option value="${v}" ${S.prefs.weekStart === v ? 'selected' : ''}>${label}</option>`)
      .join(
        '',
      )}</select><label class="label" for="native-timeformat">Format jam</label><select class="select" id="native-timeformat" data-in="prefSel" data-k="timeFmt"><option value="12" ${S.prefs.timeFmt !== '24' ? 'selected' : ''}>12 jam</option><option value="24" ${S.prefs.timeFmt === '24' ? 'selected' : ''}>24 jam</option></select></div>`;
  return '';
}

export function nativeAdminModal(m, H) {
  const session = getWorkspaceSession();
  const footer = (action, label) =>
    `<div class="modal-f"><span class="sp"></span>${button('closeModal', 'Batal')}<button class="btn btn-primary" data-a="${action}" ${m.saving ? 'disabled' : ''}>${m.saving ? 'Menyimpan…' : label}</button></div>`;
  if (m.kind === 'invite')
    return `${H('Undang anggota')}<div class="modal-b col" style="gap:12px">${input('Email penerima', 'native-invite-email', m.email || '', 'email', 'autocomplete="off"')}<label class="label" for="native-invite-role">Role</label><select class="select" id="native-invite-role" data-in="nativeInviteRole">${(session.workspace.role === 'owner' ? ['member', 'admin', 'guest'] : session.workspace.role === 'admin' ? ['member', 'guest'] : ['guest']).map(role => `<option value="${role}" ${m.role === role ? 'selected' : ''}>${role}</option>`).join('')}</select><label class="label" for="native-invite-delivery">Pengiriman</label><select class="select" id="native-invite-delivery"><option value="link" ${m.delivery !== 'email' ? 'selected' : ''}>Link manual (tanpa email)</option>${session.features?.email ? `<option value="email" ${m.delivery === 'email' ? 'selected' : ''}>Kirim email</option>` : ''}</select>${
      m.role === 'guest'
        ? `<label class="label" for="native-invite-project">Proyek untuk guest</label><select class="select" id="native-invite-project">${S.data.projects
            .filter(p => !p.archived && projectAllows(p, session.user.id, session.workspace.role, 'manage'))
            .map(p => `<option value="${p.id}" ${p.id === m.project ? 'selected' : ''}>${esc(p.name)}</option>`)
            .join(
              '',
            )}</select><label class="label" for="native-invite-permission">Izin proyek</label><select class="select" id="native-invite-permission"><option value="viewer">Lihat</option><option value="commenter">Komentar</option><option value="editor">Edit</option></select>`
        : ''
    }</div>${footer('nativeSubmitInvite', 'Buat undangan')}`;
  if (m.kind === 'inviteLink')
    return `${H('Link undangan siap')}<div class="modal-b"><p>Link hanya ditampilkan sekali. Bagikan langsung kepada penerima undangan. Berlaku 48 jam dan hanya bisa digunakan sekali.</p><textarea class="textarea" id="native-invitation-link" rows="3" readonly>${esc(m.url)}</textarea></div>${footer('nativeCopyInvitation', 'Salin link')}`;
  if (m.kind === 'team')
    return `${H(m.id ? 'Edit tim' : 'Buat tim')}<div class="modal-b">${input('Nama tim', 'native-team-name', m.name || '', 'text', 'maxlength="100"')}<h3>Anggota tim</h3>${S.data.members
      .filter(u => u.status === 'active' && u.role !== 'Guest')
      .map(
        u =>
          `<label class="row" style="padding:6px 0"><input type="checkbox" data-team-member="${u.id}" ${(m.members || []).includes(u.id) ? 'checked' : ''}>${esc(u.name)}</label>`,
      )
      .join('')}</div>${footer('nativeSaveTeam', 'Simpan tim')}`;
  if (m.kind === 'workspace')
    return `${H('Buat workspace')}<div class="modal-b">${input('Nama workspace baru', 'native-workspace-new', '', 'text', 'maxlength="100"')}</div>${footer('nativeCreateWorkspace', 'Buat workspace')}`;
  if (m.kind === 'deleteWorkspace')
    return `${H('Hapus workspace permanen')}<div class="modal-b"><p>Ketik nama workspace dan password untuk menghapus seluruh datanya.</p>${input('Nama konfirmasi', 'native-delete-name')}${fieldPassword()}${session.account?.mfa.enabled ? input('Kode 2FA atau recovery code', 'native-factor', '', 'text', 'autocomplete="one-time-code"') : ''}</div>${footer('nativeConfirmDeleteWorkspace', 'Hapus permanen')}`;
  if (m.kind === 'access')
    return `${H('Minta akses proyek')}<div class="modal-b"><p>${esc(S.data.projects.find(p => p.id === m.project)?.name || m.project)}</p><label class="label">Izin yang diminta</label><select class="select" id="native-request-permission"><option value="viewer">Lihat</option><option value="commenter">Komentar</option><option value="editor" selected>Edit</option></select><label class="label" for="native-request-reason">Alasan</label><textarea class="textarea" id="native-request-reason" maxlength="1000" rows="3"></textarea></div>${footer('nativeSubmitAccessRequest', 'Kirim permintaan')}`;
  return '';
}
