// File: utils.js
import fs from 'fs';
import { ENV_PATH } from './config.js';

export function saveEnvVar(key, value) {
  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(env)) {
    env = env.replace(regex, `${key}=${value}`);
  } else {
    if (!env.endsWith('\n')) env += '\n';
    env += `${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, env);
}

export async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
}

export function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

export async function isInstrumental(artist, title) {
  const query = `recording:"${title}" AND artist:"${artist}"`;
  const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=5&inc=tags`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PlaylistCurator/1.0 (your@email.com)' }
    });
    const json = await res.json();

    if (!json.recordings?.length) return false;

    // Check top results for instrumental tag
    for (const recording of json.recordings.slice(0, 3)) {
      const tags = recording.tags ?? [];
      if (tags.some(t => t.name === 'instrumental')) {
        console.log(`🎼 Instrumental confirmed: "${title}" by ${artist}`);
        return true;
      }
    }
    return false;

  } catch (err) {
    console.error(`❌ MusicBrainz instrumental check failed:`, err.message);
    return false;
  }
}
