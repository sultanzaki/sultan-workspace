const collections = { project: 'projects', task: 'tasks', savedView: 'savedViews' };
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value =>
  JSON.stringify(value, (key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
export function contentOperations(before, after) {
  const operations = [];
  for (const [entity, key] of Object.entries(collections)) {
    const old = new Map((before[key] || []).map(value => [value.id, value]));
    const current = new Map((after[key] || []).map(value => [value.id, value]));
    for (const [id, value] of current) if (stable(old.get(id)) !== stable(value)) operations.push({ entity, id, value });
    for (const id of old.keys()) if (!current.has(id)) operations.push({ entity, id, value: null });
  }
  return operations;
}
export function createContentSync({ initial, capture, apply, request, status, backup }) {
  let base = clone(initial),
    timer,
    pending = null,
    blocked = null,
    retryRequest = null,
    retrySnapshot = null;
  const dirty = () => contentOperations(base, capture()).length > 0 || stable(base.preferences || {}) !== stable(capture().preferences);
  function schedule() {
    clearTimeout(timer);
    if (blocked) {
      backup(capture());
      return;
    }
    status('saving');
    timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 300);
  }
  function flush() {
    clearTimeout(timer);
    if (pending) return pending;
    if (blocked) return Promise.reject(blocked);
    pending = (async () => {
      while (dirty() || retryRequest) {
        const submitted = retryRequest ? retrySnapshot : clone(capture());
        const body = retryRequest || {
          revision: base.revision,
          mutationId: crypto.randomUUID(),
          operations: contentOperations(base, submitted),
          preferences: submitted.preferences,
        };
        status('saving');
        let result;
        try {
          result = await request('POST', body);
        } catch (error) {
          blocked = error;
          retryRequest = !error.status || error.status >= 500 ? body : null;
          retrySnapshot = retryRequest ? submitted : null;
          backup(capture());
          status(error.status === 409 ? 'conflict' : 'error', error.message);
          throw error;
        }
        retryRequest = null;
        retrySnapshot = null;
        if (stable(capture()) !== stable(submitted) && result.revision !== body.revision + (body.operations.length ? 1 : 0)) {
          blocked = Object.assign(new Error('Data telah berubah saat Anda mengedit. Muat data terbaru; draft Anda tetap disimpan.'), { status: 409 });
          backup(capture());
          status('conflict', blocked.message);
          throw blocked;
        }
        if (stable(capture()) === stable(submitted)) {
          base = clone(result);
          apply(result);
        } else base = { ...result, ...submitted, revision: result.revision };
      }
      status('saved');
    })().finally(() => {
      pending = null;
    });
    return pending;
  }
  async function refresh(force = false) {
    if (pending || (!force && (blocked || dirty()))) return;
    const atStart = stable(capture());
    if (force && (blocked || dirty())) backup(capture());
    const result = await request('GET');
    if (pending || stable(capture()) !== atStart) {
      if (force) throw new Error('Ada perubahan baru selama memuat data. Simpan atau unduh draft dahulu, lalu coba lagi.');
      return;
    }
    if (!force && (pending || blocked || stable(capture()) !== atStart)) return;
    if (force || stable(result) !== stable(base)) {
      base = clone(result);
      blocked = null;
      retryRequest = null;
      retrySnapshot = null;
      apply(result);
      status('saved');
    }
  }
  return {
    schedule,
    flush,
    refresh,
    retry: () => {
      if (blocked?.status === 409) return Promise.reject(blocked);
      blocked = null;
      return flush();
    },
    isDirty: () => !!pending || !!blocked || dirty(),
    hasChanges: dirty,
    hasUnsavedContent: () => !!blocked || contentOperations(base, capture()).length > 0,
  };
}
