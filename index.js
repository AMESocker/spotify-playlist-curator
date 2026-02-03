// File: index.js
import 'dotenv/config';
import { initAuthIfNeeded } from './auth.js';
import { runJob } from './job.js';
import { scheduleDaily } from './scheduler.js';
import { logInfo } from './logger.js';
import { addNextAlbum } from './curator.js';

(async () => {
  const ready = await initAuthIfNeeded();
  if (!ready) return;

  if (process.env.RUN_MODE === 'once') {
    await runJob();
    await addNextAlbum();
  } else {
    scheduleDaily(runJob);
    logInfo('Scheduled daily cleanup job.');
  }
})();

