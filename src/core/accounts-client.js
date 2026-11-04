import { A, IN } from '../actions/actions.js';
import { S } from './store.js';
import { toast } from '../ui/toast.js';
import { nativeApi, downloadText, fileBase64 } from './native-api.js';

export function initAccounts({ session, renderSynced }) {
  const api = (path, method, body) => nativeApi(session, path, method, body);
  let loading = false,
    lastAttempt = 0;
  async function loadAccount() {
    if (loading) return;
    loading = true;
    lastAttempt = Date.now();
    try {
      const [account, sessions] = await Promise.all([api('/account'), api('/account/sessions')]);
      session.account = account;
      session.accountSessions = sessions;
      session.user = { ...session.user, ...account.user };
      S.prefs.name = account.user.name;
      const member = S.data.members.find(member => member.id === session.user.id);
      if (member)
        Object.assign(member, {
          name: account.user.name,
          email: account.user.email,
          title: account.user.title || member.role,
          c: account.user.color,
          avatar: account.user.avatar,
        });
      renderSynced();
    } catch (error) {
      session.accountError = error.message;
      toast(error.message, { kind: 'err' });
    } finally {
      loading = false;
    }
  }
  session.loadAccount = loadAccount;
  const previous = session.onRender;
  session.onRender = () => {
    previous?.();
    if (S.ui.route === 'settings' && !session.account && !loading && Date.now() - lastAttempt > 30000) void loadAccount();
  };
  A.nativeReloadAccount = () => {
    void loadAccount();
  };
  function run(fn) {
    if (session.accountSaving) return;
    session.accountSaving = true;
    return session
      .perform(async () => {
        const result = await fn();
        if (result?.redirect) return result;
        await loadAccount();
      })
      .finally(() => {
        session.accountSaving = false;
        renderSynced();
      });
  }
  const value = id => document.getElementById(id)?.value || '';
  const sensitive = () => ({ currentPassword: value('native-current-password'), code: value('native-factor') });
  A.nativeSaveProfile = () => {
    const input = { name: value('native-profile-name'), title: value('native-profile-title'), color: value('native-profile-color') };
    if (!input.name.trim()) {
      toast('Nama tidak boleh kosong.', { kind: 'err' });
      return;
    }
    void run(async () => {
      const user = await api('/account/profile', 'PATCH', input);
      session.user = { ...session.user, ...user };
      toast('Profil disimpan.', { kind: 'info' });
    });
  };
  IN.nativeAvatar = el => {
    const file = el.files?.[0];
    if (!file) return;
    if (file.size > 262144 || !file.size) {
      toast('Foto maksimal 256 KB.', { kind: 'err' });
      return;
    }
    void run(async () => {
      await api('/account/avatar', 'PUT', { content: await fileBase64(file) });
    });
  };
  A.nativeRemoveAvatar = () => {
    void run(() => api('/account/avatar', 'DELETE'));
  };
  A.nativeSavePassword = () => {
    const input = { ...sensitive(), newPassword: value('native-new-password') };
    if (input.newPassword !== value('native-confirm-password')) {
      toast('Konfirmasi password tidak sesuai.', { kind: 'err' });
      return;
    }
    if (input.newPassword.length < 12) {
      toast('Password baru minimal 12 karakter.', { kind: 'err' });
      return;
    }
    void run(async () => {
      await api('/account/password', 'POST', input);
      return { redirect: '/' };
    });
  };
  A.nativeRevokeSession = el => {
    void run(async () => {
      const result = await api(`/account/sessions/${el.dataset.id}`, 'DELETE');
      if (result.current) return { redirect: '/' };
    });
  };
  A.nativeRevokeOthers = () => {
    void run(() => api('/account/sessions', 'DELETE'));
  };
  A.nativeSetupMfa = () => {
    const input = sensitive();
    void run(async () => {
      const setup = await api('/account/mfa/setup', 'POST', input);
      const QR = await import('qrcode');
      session.mfaSetup = { secret: setup.secret, qr: await (QR.default || QR).toDataURL(setup.otpauth, { width: 200, margin: 1 }) };
    });
  };
  A.nativeCancelMfa = () => {
    session.mfaSetup = null;
    renderSynced();
  };
  A.nativeConfirmMfa = () => {
    const code = value('native-factor');
    void run(async () => {
      const result = await api('/account/mfa/confirm', 'POST', { code });
      session.mfaSetup = null;
      session.recoveryCodes = result.recoveryCodes;
    });
  };
  A.nativeRegenerateRecovery = () => {
    const input = sensitive();
    void run(async () => {
      session.recoveryCodes = (await api('/account/mfa/recovery', 'POST', input)).recoveryCodes;
    });
  };
  A.nativeDisableMfa = () => {
    const input = sensitive();
    void run(() => api('/account/mfa/disable', 'POST', input));
  };
  A.nativeDownloadRecovery = () => {
    if (session.recoveryCodes) downloadText('gr8r-recovery-codes.txt', session.recoveryCodes.join('\n') + '\n');
  };
  A.nativeDismissRecovery = () => {
    session.recoveryCodes = null;
    renderSynced();
  };
  void loadAccount();
}
