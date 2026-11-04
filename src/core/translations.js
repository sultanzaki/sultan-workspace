import { S } from './store.js';
import { isIndonesian, translate } from './locale.js';
export function applyTranslations() {
  for (const element of document.querySelectorAll('#toasts .grow, #toasts .ta')) element.textContent = translate(element.textContent, S.prefs.lang);
  if (!isIndonesian(S.prefs.lang)) return;
  const protectedValues = new Set();
  const protect = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, value] of Object.entries(item)) {
      if (['title', 'name', 'desc', 'description', 'text', 'body', 'email'].includes(key) && typeof value === 'string') protectedValues.add(value);
      else if (typeof value === 'object') Array.isArray(value) ? value.forEach(protect) : protect(value);
    }
  };
  for (const key of ['projects', 'tasks', 'events', 'members', 'teams', 'comments', 'files', 'savedViews']) S.data[key]?.forEach(protect);
  protect(S.data.ws);
  protect(S.data.workspaces);
  for (const root of ['app', 'layer'].map(id => document.getElementById(id)).filter(Boolean)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement.closest('input,textarea,pre,code,[contenteditable],.rte,.cmt-body,.cmt .txt,[data-user-content]')) continue;
      const value = node.textContent.trim();
      if (!protectedValues.has(value) && translate(value, S.prefs.lang) !== value)
        node.textContent = node.textContent.replace(value, translate(value, S.prefs.lang));
    }
    root.querySelectorAll('[aria-label],[data-tip]').forEach(el => {
      for (const attribute of ['aria-label', 'data-tip']) {
        const value = el.getAttribute(attribute);
        if (!protectedValues.has(value) && translate(value, S.prefs.lang) !== value) el.setAttribute(attribute, translate(value, S.prefs.lang));
      }
    });
  }
}
