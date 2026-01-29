// File: scheduler.js
import cron from 'node-cron';
import { logInfo } from './logger.js';

export function scheduleDaily(jobFn) {
  cron.schedule('0 2,15 * * *', () => {
    logInfo('Daily cleanup at ' + new Date().toISOString());
    jobFn();
  });
}
