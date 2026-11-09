/* ---------- icons: inlined Lucide subset (src/00-icons.js), rendered to inline svg ---------- */
import { ICONS } from 'virtual:icons';
import { esc } from './utils.js';

export const _icCache = {};
export function ic(name, size = 16, cls = '') {
  const k = name + '|' + size + '|' + cls;
  if (_icCache[k]) return _icCache[k];
  const inner = ICONS[name] || '<rect x="5" y="5" width="14" height="14" rx="3"/>';
  return (_icCache[k] =
    `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
}
/* Sultan Workspace brand: a compact S monogram shared with the favicon. */
export const LOGO_D = 'M45 18H27C16 18 16 32 27 32H37C48 32 48 46 37 46H19';
export const MARK = (px = 22) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="17" fill="#3548d4"/><path d="${LOGO_D}" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/></svg>`;
export const LOGO = (h = 22) =>
  `<span class="logo" style="display:inline-flex;align-items:center;gap:10px;font-weight:650;font-size:${Math.max(14, h * 0.7)}px" role="img" aria-label="Sultan Workspace">${MARK(h)}<span>Sultan Workspace</span></span>`;
export function wsLogo(w, px = 22) {
  return w && w.brand
    ? `<span class="ws-logo brand" style="width:${px}px;height:${px}px">${MARK(px)}</span>`
    : `<span class="ws-logo" style="--c:${w.c};width:${px}px;height:${px}px;font-size:${Math.max(9, Math.round(px * 0.46))}px">${esc(w.name[0])}</span>`;
}
