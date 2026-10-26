// Follow records in chrome.storage.local under "follows". Read-modify-write cycles run one after
// another (same pattern as lib/packs/store.js), so a check result and a popup action at the same
// time cannot lose each other's write.

const KEY = 'follows';

export function createFollowStore(storage) {
  let queue = Promise.resolve();
  const mutate = fn => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  const read = async () => (await storage.get(KEY))[KEY] || [];
  const write = list => storage.set({ [KEY]: list });

  return {
    list: () => mutate(read),

    // One follow per series: the same key again gives back the record that exists.
    add: follow => mutate(async () => {
      const list = await read();
      const found = list.find(f => f.key === follow.key);
      if (found) return found;
      await write([...list, follow]);
      return follow;
    }),

    remove: id => mutate(async () => {
      await write((await read()).filter(f => f.id !== id));
    }),

    // A follow removed while a check ran stays removed: the late result is dropped.
    update: (id, fn) => mutate(async () => {
      const list = await read();
      const i = list.findIndex(f => f.id === id);
      if (i < 0) return null;
      const next = fn(list[i]);
      list[i] = next;
      await write(list);
      return next;
    }),

    findByKey: key => mutate(async () => (await read()).find(f => f.key === key) || null),
  };
}
