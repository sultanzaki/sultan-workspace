import { S } from './store.js';
const pairs = [
  ['Home', 'Beranda'],
  ['Overview', 'Ringkasan'],
  ['Projects', 'Proyek'],
  ['Tasks', 'Task'],
  ['My Tasks', 'Task Saya'],
  ['Inbox', 'Kotak masuk'],
  ['Calendar', 'Kalender'],
  ['Timeline', 'Linimasa'],
  ['Members', 'Anggota'],
  ['Activity', 'Aktivitas'],
  ['Settings', 'Pengaturan'],
  ['Notifications', 'Notifikasi'],
  ['Files', 'File'],
  ['Archive', 'Arsip'],
  ['Favorites', 'Favorit'],
  ['Search', 'Cari'],
  ['New task', 'Task baru'],
  ['New project', 'Proyek baru'],
  ['Add task', 'Tambah task'],
  ['Create task', 'Buat task'],
  ['Create project', 'Buat proyek'],
  ['Cancel', 'Batal'],
  ['Close', 'Tutup'],
  ['Done', 'Selesai'],
  ['Save', 'Simpan'],
  ['Save changes', 'Simpan perubahan'],
  ['Edit', 'Edit'],
  ['Delete', 'Hapus'],
  ['More', 'Lainnya'],
  ['Share', 'Bagikan'],
  ['List', 'Daftar'],
  ['Board', 'Papan'],
  ['Table', 'Tabel'],
  ['Filter', 'Filter'],
  ['Sort', 'Urutkan'],
  ['Group', 'Kelompokkan'],
  ['Status', 'Status'],
  ['Priority', 'Prioritas'],
  ['Assignee', 'Penanggung jawab'],
  ['Due date', 'Deadline'],
  ['Labels', 'Label'],
  ['Description', 'Deskripsi'],
  ['Attachments', 'Lampiran'],
  ['Comments', 'Komentar'],
  ['Comment', 'Komentar'],
  ['Subtasks', 'Subtask'],
  ['Unassigned', 'Belum ditugaskan'],
  ['Backlog', 'Backlog'],
  ['To do', 'Perlu dikerjakan'],
  ['In progress', 'Dikerjakan'],
  ['In review', 'Ditinjau'],
  ['Today', 'Hari ini'],
  ['Tomorrow', 'Besok'],
  ['Yesterday', 'Kemarin'],
  ['Week', 'Minggu'],
  ['Month', 'Bulan'],
  ['Previous', 'Sebelumnya'],
  ['Next', 'Berikutnya'],
  ['All tasks', 'Semua task'],
  ['No tasks', 'Belum ada task'],
  ['No milestones yet', 'Belum ada milestone'],
  ['Nothing scheduled', 'Belum ada jadwal'],
  ['No activity yet', 'Belum ada aktivitas'],
  ['About', 'Tentang'],
  ['Progress', 'Progres'],
  ['Coming up', 'Mendatang'],
  ['Details', 'Detail'],
  ['Milestones', 'Milestone'],
  ['Recent activity', 'Aktivitas terbaru'],
  ['View all', 'Lihat semua'],
  ['View list', 'Lihat daftar'],
  ['Lead', 'Lead'],
  ['Team', 'Tim'],
  ['Start', 'Mulai'],
  ['Due', 'Deadline'],
  ['Appearance', 'Tampilan'],
  ['Language', 'Bahasa'],
  ['Date & time', 'Tanggal & waktu'],
  ['Teams', 'Tim'],
  ['Permissions', 'Izin'],
  ['Personal', 'Pribadi'],
  ['Preferences', 'Preferensi'],
  ['Keyboard shortcuts', 'Pintasan keyboard'],
  ['Security', 'Keamanan'],
  ['Password', 'Password'],
  ['Sessions', 'Sesi login'],
  ['Two-factor authentication', 'Autentikasi dua langkah'],
  ['General', 'Umum'],
  ['Theme', 'Tema'],
  ['Light', 'Terang'],
  ['Dark', 'Gelap'],
  ['System', 'Sistem'],
  ['Accent color', 'Warna aksen'],
  ['Accent', 'Aksen'],
  ['Density', 'Kepadatan'],
  ['Sidebar density', 'Kepadatan sidebar'],
  ['Task display', 'Tampilan task'],
  ['Motion', 'Animasi'],
  ['Follow system', 'Ikuti sistem'],
  ['Reduce motion', 'Kurangi animasi'],
  ['Comfortable', 'Nyaman'],
  ['Compact', 'Ringkas'],
  ['Open on launch', 'Halaman awal'],
  ['Open tasks in', 'Buka task di'],
  ['Side panel', 'Panel samping'],
  ['Full page', 'Halaman penuh'],
  ['Default project view', 'Tampilan awal proyek'],
  ['Show completed tasks on boards', 'Tampilkan task selesai di papan'],
  ['Archived projects', 'Proyek diarsipkan'],
  ['Restore', 'Pulihkan'],
  ['Open archive', 'Buka arsip'],
  ['Spellcheck', 'Pemeriksaan ejaan'],
  ['Task assignments', 'Penugasan task'],
  ['Mentions', 'Mention'],
  ['Members can create projects', 'Anggota dapat membuat proyek'],
  ['Profile', 'Profil'],
];
const dictionary = new Map(pairs);
export function applyTranslations() {
  if (!['id-ID', 'Bahasa Indonesia'].includes(S.prefs.lang)) return;
  const protectedValues = new Set();
  const protect = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, value] of Object.entries(item)) {
      if (['title', 'name', 'desc', 'description', 'text', 'body', 'email'].includes(key) && typeof value === 'string') protectedValues.add(value);
      else if (typeof value === 'object') Array.isArray(value) ? value.forEach(protect) : protect(value);
    }
  };
  for (const key of ['projects', 'tasks', 'events', 'members', 'teams', 'comments', 'files', 'savedViews']) S.data[key]?.forEach(protect);
  const root = document.getElementById('app');
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest('input,textarea,pre,code,[contenteditable],.rte,.cmt-body')) continue;
    const value = node.textContent.trim();
    if (!protectedValues.has(value) && dictionary.has(value)) node.textContent = node.textContent.replace(value, dictionary.get(value));
  }
  root.querySelectorAll('[aria-label],[data-tip]').forEach(el => {
    for (const attribute of ['aria-label', 'data-tip']) {
      const value = el.getAttribute(attribute);
      if (!protectedValues.has(value) && dictionary.has(value)) el.setAttribute(attribute, dictionary.get(value));
    }
  });
}
