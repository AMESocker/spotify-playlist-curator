// File: topTracksUtil.js
// Shared utilities for fetching and adding artist top tracks.
// Used by: rockHall, festival, and artistGenre strategies.

import { getSpotify } from "./auth.js";
import { addTracks } from "./playlist.js";

/**
 * Search for an artist on Spotify and return their ID.
 * Returns null if not found.
 */
async function resolveArtistId(artistName, spotifyId = null) {
  const spotify = getSpotify();

  if (spotifyId) return spotifyId;

  console.log(`  🔍 Searching Spotify for "${artistName}"...`);
  const results = await spotify.searchArtists(artistName, { limit: 5 });
  const found = results.body.artists.items[0];
  if (!found) {
    console.log(`  ⚠️  Artist not found on Spotify: "${artistName}"`);
    return null;
  }
  console.log(`  ✅ Found: "${found.name}" (ID: ${found.id})`);
  return found.id;
}

/**
 * Fetch an artist's top tracks from Spotify and return `count` random URIs.
 *
 * @param {string} artistName   - Display name (used for search fallback + logging)
 * @param {object} [opts]
 * @param {string} [opts.spotifyId]  - Skip search if already known
 * @param {number} [opts.count=5]    - How many tracks to pick (random subset of top 10)
 * @returns {{ success: boolean, trackUris: string[], trackCount: number, reason?: string }}
 */
export async function fetchRandomTopTracks(artistName, { spotifyId = null, count = 5 } = {}) {
  const spotify = getSpotify();

  try {
    const artistId = await resolveArtistId(artistName, spotifyId);
    if (!artistId) {
      return { success: false, reason: "ARTIST NOT FOUND", trackUris: [], trackCount: 0 };
    }

    const { body: { tracks: topTracks } } = await spotify.getArtistTopTracks(artistId, "US");
    if (!topTracks.length) {
      console.log(`  ⚠️  No top tracks found for "${artistName}"`);
      return { success: false, reason: "NO TRACKS", trackUris: [], trackCount: 0 };
    }

    // Shuffle and take `count` tracks
    const shuffled = [...topTracks].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, count);
    const trackUris = picked.map(t => t.uri);

    console.log(`  🎵 Randomly selected ${trackUris.length} of ${topTracks.length} top tracks for "${artistName}":`);
    picked.forEach((t, i) =>
      console.log(`     ${i + 1}. "${t.name}" (popularity: ${t.popularity})`)
    );

    return { success: true, trackUris, trackCount: trackUris.length };

  } catch (error) {
    console.error(`  ❌ Error fetching tracks for "${artistName}":`, error.message);
    return { success: false, reason: "ERROR", trackUris: [], trackCount: 0, error: error.message };
  }
}

/**
 * Run a batch of up to `batchSize` artists through fetchRandomTopTracks and
 * add their tracks to the target playlist.
 *
 * Callers supply two callbacks that handle all data-structure-specific work:
 *   - pickArtist()  → { name, spotifyId? } | null   (destructively removes from source)
 *   - onResult(artistName, result, trackUris)        (persist success/failure to data)
 *
 * Returns:
 *   null  → no artists left (source exhausted)
 *   false → nothing added this round
 *   true  → at least one artist added successfully
 *
 * @param {object} opts
 * @param {number}   [opts.batchSize=2]     - Artists to process per run
 * @param {number}   [opts.tracksPerArtist=5]
 * @param {string}   opts.targetPlaylistId
 * @param {Function} opts.wouldExceedLimit  - async (n) => boolean
 * @param {Function} opts.pickArtist        - () => { name, spotifyId? } | null
 * @param {Function} opts.onResult          - async (name, success, trackUris) => void
 */
export async function runArtistBatch({
  batchSize = 2,
  tracksPerArtist = 5,
  targetPlaylistId,
  wouldExceedLimit,
  pickArtist,
  onResult,
}) {
  // Pre-flight: ensure room for at least one full artist before we start
  if (await wouldExceedLimit(10)) return false;

  let anyAdded = false;
  let firstPick = true;

  for (let i = 0; i < batchSize; i++) {
    const artist = pickArtist();
    if (!artist) {
      // Exhausted mid-batch
      return anyAdded ? true : null;
    }

    if (firstPick) {
      firstPick = false;
    }

    console.log(`🎵 Processing: ${artist.name}`);

    const result = await fetchRandomTopTracks(artist.name, {
      spotifyId: artist.spotifyId ?? null,
      count: tracksPerArtist,
    });

    if (!result.success) {
      await onResult(artist.name, false, [], result.reason);
      continue;
    }

    if (await wouldExceedLimit(result.trackCount)) {
      // Put artist back by calling onResult with a special signal
      await onResult(artist.name, "REQUEUE", result.trackUris, null);
      return false;
    }

    await addTracks(targetPlaylistId, result.trackUris);
    console.log(`🎶 Added ${result.trackCount} tracks to playlist`);

    await onResult(artist.name, true, result.trackUris, null);
    console.log(`✅ Completed: ${artist.name}`);
    anyAdded = true;
  }

  return anyAdded ? true : false;
}
