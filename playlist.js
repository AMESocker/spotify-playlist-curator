// File: playlist.js
import { withRetry } from './utils.js';
import { getSpotify } from './auth.js';
import 'dotenv/config';

export async function fetchAllPlaylistItems(playlistId) {
  const spotify = getSpotify();
  const limit = 100;
  let offset = 0;
  let all = [];
  while (true) {
    const res = await withRetry(() => spotify.getPlaylistTracks(playlistId, {
      limit, offset, fields: 'items(added_at,track(id,name,uri)),next'
    }));
    all = all.concat(res.body.items);
    if (!res.body.next) break;
    offset += limit;
  }
  return all;
}

export async function addTracks(playlistId, uris) {
  const spotify = getSpotify();
  const chunkSize = 100;

   // Always add everything to main playlist
  for (let i = 0; i < uris.length; i += chunkSize) {
    const chunk = uris.slice(i, i + chunkSize);
    await withRetry(() => spotify.addTracksToPlaylist(playlistId, chunk));
  }

  // Fetch track details for car playlist filtering
  const cleanId    = process.env.CLEAN_PLAYLIST_ID;
  const carAllId = process.env.CAR_PLAYLIST_ALL_ID;
  if (!cleanId && !carAllId) return;

  const timeLimit = 7 ; //Minutes
  const CAR_MAX_DURATION_MS = timeLimit * 60 * 1000; 
  const carCleanUris    = [];
  const carExplicitUris = [];

  for (let i = 0; i < uris.length; i += chunkSize) {
    const chunk = uris.slice(i, i + chunkSize);
    const ids = chunk.map(uri => uri.split(':')[2]);
    const res = await withRetry(() => spotify.getTracks(ids));
    res.body.tracks.forEach(track => {
      if (!track) return;
      if (track.duration_ms > CAR_MAX_DURATION_MS) return;
      if (track.explicit) {
        carExplicitUris.push(track.uri);
      } else {
        carCleanUris.push(track.uri);
      }
    });
  }

  for (let i = 0; i < carCleanUris.length; i += chunkSize) {
    const chunk = carCleanUris.slice(i, i + chunkSize);
    if (cleanId) await withRetry(() => spotify.addTracksToPlaylist(cleanId, chunk));
  }

  for (let i = 0; i < carExplicitUris.length; i += chunkSize) {
    const chunk = carExplicitUris.slice(i, i + chunkSize);
    if (explicitId) await withRetry(() => spotify.addTracksToPlaylist(explicitId, chunk));
  }
}

export async function removeTracks(playlistId, tracks) {
  const spotify = getSpotify();
  const chunkSize = 100;
  for (let i = 0; i < tracks.length; i += chunkSize) {
    const chunk = tracks.slice(i, i + chunkSize);
    await withRetry(() => spotify.removeTracksFromPlaylist(playlistId, chunk));
  }
}

export async function getRecentlyPlayedIds() {
  const spotify = getSpotify();
 const limit = 50; // max Spotify allows per request
  let allItems = [];
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

  let after = twentyFourHoursAgo;
  while (true) {
    const res = await withRetry(() => 
      spotify.getMyRecentlyPlayedTracks({ limit, after })
    );

    if (!res.body.items || res.body.items.length === 0) break;

    allItems = allItems.concat(res.body.items);

    // Spotify returns items in reverse chronological order
    const lastItemTime = new Date(res.body.items[res.body.items.length - 1].played_at).getTime();
    
    // If last item is older than 24h, we can stop
    if (lastItemTime < twentyFourHoursAgo) break;

    // Prepare 'after' for next request (next oldest timestamp)
    after = lastItemTime + 1;
  }

  // Count occurrences
  const trackCounts = new Map();
  allItems.forEach(item => {
    if (item.track && item.track.id) {
      const id = item.track.id;
      trackCounts.set(id, (trackCounts.get(id) || 0) + 1);
    }
  });

  // Filter tracks that appear more than once
  const duplicateIds = [...trackCounts.entries()]
    .filter(([id, count]) => count > 1)
    .map(([id]) => id);

  return new Set(duplicateIds);
}
