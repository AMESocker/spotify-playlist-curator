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

  for (let i = 0; i < uris.length; i += chunkSize) {
    const chunk = uris.slice(i, i + chunkSize);
    await withRetry(() => spotify.addTracksToPlaylist(playlistId, chunk));
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
  const limit = 50;
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

    const lastItemTime = new Date(res.body.items[res.body.items.length - 1].played_at).getTime();
    if (lastItemTime < twentyFourHoursAgo) break;
    after = lastItemTime + 1;
  }

  const trackCounts = new Map();
  allItems.forEach(item => {
    if (item.track && item.track.id) {
      const id = item.track.id;
      trackCounts.set(id, (trackCounts.get(id) || 0) + 1);
    }
  });

  const duplicateIds = [...trackCounts.entries()]
    .filter(([id, count]) => count > 1)
    .map(([id]) => id);

  return new Set(duplicateIds);
}