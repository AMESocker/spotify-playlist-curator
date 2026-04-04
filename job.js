// File: job.js
import fs from "fs";
import { getSpotify } from './auth.js';
import { fetchAllPlaylistItems, removeTracks, getRecentlyPlayedIds } from './playlist.js';
import { addTracksToArchive } from './archive.js';
import { monitoredPlaylists, archivePlaylists, staleArchivePlaylistId } from './config.js';
import { logInfo, logError } from './logger.js';

const MAX_AGE_DAYS = 30;
const HISTORY_FILE = './history.json';
const MAX_PLAYLIST_SIZE = 200;

//? Dynamically calculate stale window based on recent add rate to playlists
async function getStaleWindowDays() {
  const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  const sevenDaysAgo = Date.now() - 7 * 86400000;

  let recentTracks = 0;
  history
    .filter(e => new Date(e.timestamp).getTime() > sevenDaysAgo)
    .forEach(e => { recentTracks += e.tracksAdded ?? (e.action === 'add' ? 1 : 0); });

  const tracksPerDay = recentTracks / 7;

  // Target: tracks stay long enough to be heard but playlist keeps turning over
  // Aim for ~2x playlist size worth of content per stale window
  const days = Math.round((MAX_PLAYLIST_SIZE * 4) / tracksPerDay);
  const clamped = Math.max(7, Math.min(31, days)); // floor 7 days, ceiling 31 days

  console.log(`📊 Add rate: ${tracksPerDay.toFixed(1)} tracks/day → stale window: ${clamped} days`);
  return clamped;
}

//? Main job function to manage playlist cleanup and archiving
export async function runJob() {
  try {
    //? Get an authenticated Spotify API client
    const spotify = getSpotify();

    //? Refresh the access token to ensure API calls succeed
    const tokenData = await spotify.refreshAccessToken();
    spotify.setAccessToken(tokenData.body['access_token']);

    //? Fetch IDs of tracks played in the last 24 hours
    const recentlyPlayed = await getRecentlyPlayedIds();
    logInfo(`Found ${recentlyPlayed.size} tracks played in last 24h.`);

    //? Loop through each monitored playlist and its corresponding archive playlist
    for (let i = 0; i < monitoredPlaylists.length; i++) {
      const playlistId = monitoredPlaylists[i].trim();
      const archiveId = archivePlaylists[i].trim();

      logInfo(`Processing playlist: ${playlistId}`);

      //? Fetch all items from the current playlist
      const items = await fetchAllPlaylistItems(playlistId);

      //? Arrays to hold tracks that should be archived and removed
      const archiveTracks = [];
      const staleArchiveTracks = [];
      const removals = [];

      //? Cutoff timestamp for stale tracks
      const staleDays = await getStaleWindowDays();
      console.log(`🗓️ Stale window: ${staleDays} days`);
      const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;

      //? Check each track in the playlist
      items.forEach((item, idx) => {
        if (!item.track) return;

        const isRecentlyPlayed = recentlyPlayed.has(item.track.id);
        const isStale = new Date(item.added_at).getTime() < cutoff;

        if (isRecentlyPlayed) {
          archiveTracks.push({ ...item.track, added_at: item.added_at });
          removals.push({ uri: item.track.uri, positions: [idx] });
        } else if (isStale) {
          staleArchiveTracks.push({ ...item.track, added_at: item.added_at });
          removals.push({ uri: item.track.uri, positions: [idx] });
        }
      });

      if (archiveTracks.length > 0) {
        logInfo(`Archiving ${archiveTracks.length} tracks to playlist ${archiveId}...`);
        await addTracksToArchive(archiveId, archiveTracks);
      }

      if (staleArchiveTracks.length > 0) {
        logInfo(`Archiving ${staleArchiveTracks.length} stale tracks to stale archive...`);
        await addTracksToArchive(staleArchivePlaylistId, staleArchiveTracks);
      }

      if (removals.length > 0) {
        logInfo(`Removing ${removals.length} tracks from playlist ${playlistId}...`);
        await removeTracks(playlistId, removals);
      } else {
        logInfo(`No tracks to remove for playlist ${playlistId}.`);
      }
    }

  } catch (err) {
    logError('Error in job', err);
  }
}
