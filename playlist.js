// File: playlist.js
import { withRetry } from './utils.js';
import { getSpotify } from './auth.js';
import { isInstrumental } from './curator.js';
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

  const instrumentalId = process.env.CAR_PLAYLIST_ALL_ID;
  if (instrumentalId) {
    const instrumentalUris = [];

    for (let i = 0; i < uris.length; i += chunkSize) {
      const chunk = uris.slice(i, i + chunkSize);
      const ids = chunk.map(uri => uri.split(':')[2]);
      const res = await withRetry(() => spotify.getTracks(ids));

      for (const track of res.body.tracks) {
        if (!track) continue;
        await new Promise(resolve => setTimeout(resolve, 1100)); // MusicBrainz rate limit
        const instrumental = await isInstrumental(track.artists[0].name, track.name);
        if (instrumental) instrumentalUris.push(track.uri);
      }
    }

    for (let i = 0; i < instrumentalUris.length; i += chunkSize) {
      const chunk = instrumentalUris.slice(i, i + chunkSize);
      await withRetry(() => spotify.addTracksToPlaylist(instrumentalId, chunk));
    }
  }

}

const instrumentalId = process.env.CAR_PLAYLIST_ALL_ID;
if (instrumentalId) {
  const instrumentalUris = [];

  for (let i = 0; i < uris.length; i += chunkSize) {
    const chunk = uris.slice(i, i + chunkSize);
    const ids = chunk.map(uri => uri.split(':')[2]);
    const res = await withRetry(() => spotify.getTracks(ids));

    for (const track of res.body.tracks) {
      if (!track) continue;
      await new Promise(resolve => setTimeout(resolve, 1100)); // MusicBrainz rate limit
      const instrumental = await isInstrumental(track.artists[0].name, track.name);
      if (instrumental) instrumentalUris.push(track.uri);
    }
  }

  for (let i = 0; i < instrumentalUris.length; i += chunkSize) {
    const chunk = instrumentalUris.slice(i, i + chunkSize);
    await withRetry(() => spotify.addTracksToPlaylist(instrumentalId, chunk));
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