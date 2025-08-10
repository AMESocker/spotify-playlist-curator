import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import SpotifyWebApi from 'spotify-web-api-node';
import cron from 'node-cron';
import open from 'open';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === CONFIG ===
const ENV_PATH = path.resolve(__dirname, '.env');
const PLAYLIST_ID = process.env.PLAYLIST_ID;
const REDIRECT_URI = 'http://localhost:8888/callback';
const SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private'
];

const spotify = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: REDIRECT_URI
});

function saveEnvVar(key, value) {
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

// === STEP 1: Get refresh token if missing ===
async function initAuthIfNeeded() {
  if (!process.env.SPOTIFY_REFRESH_TOKEN) {
    const app = express();

    app.get('/login', (req, res) => {
      const authURL = spotify.createAuthorizeURL(SCOPES, 'state123');
      res.redirect(authURL);
    });

    app.get('/callback', async (req, res) => {
      const { code } = req.query;
      try {
        const data = await spotify.authorizationCodeGrant(code);
        const refreshToken = data.body.refresh_token;
        saveEnvVar('SPOTIFY_REFRESH_TOKEN', refreshToken);
        spotify.setRefreshToken(refreshToken);
        res.send(`<h2>Refresh token saved!</h2><p>You can close this window.</p>`);
        console.log('Refresh token saved to .env');
        setTimeout(() => process.exit(0), 2000);
      } catch (err) {
        console.error('Error getting tokens:', err);
        res.send('Error getting tokens.');
      }
    });

    app.listen(8888, () => {
      console.log('Auth server started: http://localhost:8888/login');
      open('http://localhost:8888/login');
    });

    return false; // stop here until token is retrieved
  } else {
    spotify.setRefreshToken(process.env.SPOTIFY_REFRESH_TOKEN);
    return true;
  }
}

// === CLEANUP LOGIC ===

async function fetchAllPlaylistItems(playlistId) {
  const limit = 100;
  let offset = 0;
  let all = [];
  while (true) {
    const res = await spotify.getPlaylistTracks(playlistId, {
      limit, offset, fields: 'items(added_at,track(id,name,uri)),next'
    });
    all = all.concat(res.body.items);
    if (!res.body.next) break;
    offset += limit;
  }
  return all;
}

async function removeTracks(playlistId, tracks) {
  const chunkSize = 100;
  for (let i = 0; i < tracks.length; i += chunkSize) {
    const chunk = tracks.slice(i, i + chunkSize);
    await spotify.removeTracksFromPlaylist(playlistId, chunk);
    console.log(`Removed ${chunk.length} track entries.`);
  }
}

async function getRecentlyPlayedIds() {
  const res = await spotify.getMyRecentlyPlayedTracks({ limit: 50 });
  const ids = new Set();
  res.body.items.forEach(item => {
    if (item.track && item.track.id) {
      ids.add(item.track.id);
    }
  });
  return ids;
}

async function job() {
  try {
    const tokenData = await spotify.refreshAccessToken();
    spotify.setAccessToken(tokenData.body['access_token']);

    const recentlyPlayed = await getRecentlyPlayedIds();
    console.log(`Found ${recentlyPlayed.size} tracks played in last 24h.`);

    const items = await fetchAllPlaylistItems(PLAYLIST_ID);
    const removals = [];
    items.forEach((item, idx) => {
      if (item.track && recentlyPlayed.has(item.track.id)) {
        removals.push({ uri: item.track.uri, positions: [idx] });
      }
    });

    if (removals.length > 0) {
      console.log(`Removing ${removals.length} tracks...`);
      await removeTracks(PLAYLIST_ID, removals);
    } else {
      console.log('No recently played tracks to remove.');
    }
  } catch (err) {
    console.error('Error in job:', err.message || err);
  }
}


// === MAIN ===
(async () => {
  const ready = await initAuthIfNeeded();
  if (!ready) return;

  if (process.env.RUN_MODE === 'once') {
    await job();
  } else {
    // Local development mode with daily schedule
    cron.schedule('0 3 * * *', () => {
      console.log('Daily cleanup at', new Date().toISOString());
      job();
    });
    console.log('Scheduled daily cleanup job.');
  }
})();
