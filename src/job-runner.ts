/** One iteration at a time; durable jobs remain in MongoDB when this process sleeps. */
export function startJobRunner(options: {
  schedule: () => Promise<void>;
  work: () => Promise<number>;
  onError: (error: unknown) => void;
  idleMs?: number;
  retryMs?: number;
  scheduleMs?: number;
}) {
  let stopping = false;
  let wake: (() => void) | undefined;
  let nextSchedule = 0;
  const delay = (ms: number) => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); wake = undefined; resolve(); };
    const timer = setTimeout(finish, ms);
    wake = finish;
    if (stopping) finish();
  });
  const done = (async () => {
    while (!stopping) {
      try {
        if (Date.now() >= nextSchedule) {
          await options.schedule();
          nextSchedule = Date.now() + (options.scheduleMs ?? 30000);
        }
        if (stopping) break;
        const count = await options.work();
        if (!count && !stopping) await delay(options.idleMs ?? 2000);
      } catch (error) {
        options.onError(error);
        if (!stopping) await delay(options.retryMs ?? 5000);
      }
    }
  })();
  return { async stop() { stopping = true; wake?.(); await done; } };
}
