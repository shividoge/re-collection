/**
 * Runs fact extraction for captures whose status says facts: "queued", one at
 * a time, in the background. `kick()` is safe to call any time (after an
 * upload completes, on startup, after a re-extract request).
 */
export function createFactsWorker({ store, extract, log = console }) {
  let running = false;
  let again = false;

  async function drain() {
    for (;;) {
      const queued = [];
      for (const id of await store.listIds()) {
        const status = await store.status(id);
        if (status.upload === 'done' && status.facts === 'queued') queued.push(id);
      }
      if (queued.length === 0) return;
      for (const id of queued) {
        await store.setStatus(id, { facts: 'running', factsError: null });
        const started = Date.now();
        try {
          const moment = await extract(id);
          await store.setStatus(id, { facts: 'done', factsError: null });
          log.log(`facts: ${id} done in ${((Date.now() - started) / 1000).toFixed(0)} s (${moment.facts.length} facts, ${moment.dropped.length} dropped)`);
        } catch (error) {
          await store.setStatus(id, { facts: 'failed', factsError: error.message });
          log.error(`facts: ${id} failed: ${error.message}`);
        }
      }
    }
  }

  return {
    kick() {
      if (running) {
        again = true;
        return;
      }
      running = true;
      (async () => {
        do {
          again = false;
          await drain().catch((error) => log.error(`facts worker: ${error.message}`));
        } while (again);
        running = false;
      })();
    },
    get busy() {
      return running;
    },
  };
}
