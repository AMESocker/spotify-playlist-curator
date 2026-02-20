// File: artistGenreStrategy.js
// Selects the next artist to add using genre fairness + lowest listener count priority,
// then adds their Spotify top 10 tracks to the playlist.

import 'dotenv/config';
import fs from "fs";
import { getSpotify } from "./auth.js";
import { addTracks } from "./playlist.js";

const DATA_FILE = "data/artistTop10.json";

/* ==================================================
   STATS
================================================== */

/**
 * Calculate how many artists have been added per genre (via the "added" array).
 */
function calculateGenreStats(data) {
  const stats = {};
  for (const [genre, content] of Object.entries(data)) {
    stats[genre] = {
      total: content.not_added.length + content.added.length,
      added: content.added.length,
    };
  }
  return stats;
}

/* ==================================================
   SELECTION
================================================== */

/**
 * Select the next artist to add:
 * 1. Pick the genre with the lowest added-to-total ratio (least % complete)
 * 2. Within that genre, pick the not_added artist with the lowest listener count
 *    (prioritising recommended artists last, since they were added for coverage not discovery)
 */
function selectNextArtist(data) {
  const genreStats = calculateGenreStats(data);

  // Filter to genres that still have artists to add
  const eligibleGenres = Object.entries(genreStats)
    .filter(([genre]) => data[genre].not_added.length > 0)
    .map(([genre, stats]) => ({
      genre,
      addedRatio: stats.total > 0 ? stats.added / stats.total : 0,
      stats,
    }))
    .sort((a, b) => a.addedRatio - b.addedRatio);

  if (eligibleGenres.length === 0) {
    return null;
  }

  const { genre } = eligibleGenres[0];
  const candidates = data[genre].not_added;

  // Sort by: non-recommended first, then lowest listeners
  const sorted = [...candidates].sort((a, b) => {
    const aRec = a.recommended ? 1 : 0;
    const bRec = b.recommended ? 1 : 0;
    if (aRec !== bRec) return aRec - bRec;

    const aListeners = a.listeners ?? Infinity;
    const bListeners = b.listeners ?? Infinity;
    return aListeners - bListeners;
  });

  return { genre, artist: sorted[0] };
}

/* ==================================================
   SPOTIFY: TOP 10 TRACKS
================================================== */

async function getTopTracks(artistName, spotifyId) {
  const spotify = getSpotify();

  let artistId = spotifyId;

  // Use stored ID if available, otherwise search
  if (!artistId) {
    console.log(`  🔍 Searching Spotify for "${artistName}"...`);
    const results = await spotify.searchArtists(artistName, { limit: 1 });
    const found = results.body.artists.items[0];
    if (!found) {
      console.log(`  ⚠️  Artist not found on Spotify: "${artistName}"`);
      return null;
    }
    artistId = found.id;
    console.log(`  ✅ Found: "${found.name}" (ID: ${artistId})`);
  }

  const { body: { tracks } } = await spotify.getArtistTopTracks(artistId, "US");

  if (!tracks.length) {
    console.log(`  ⚠️  No top tracks found for "${artistName}"`);
    return null;
  }

  const topTen = tracks.slice(0, 10);
  console.log(`  🎵 Top tracks for "${artistName}":`);
  topTen.forEach((t, i) =>
    console.log(`     ${i + 1}. "${t.name}" (popularity: ${t.popularity})`)
  );

  return topTen.map((t) => t.uri);
}

/* ==================================================
   MAIN HANDLER
================================================== */

/**
 * Drop-in handler for curator.js — same return contract as other handlers:
 *   null  → source exhausted, advance to next source
 *   false → failed this round, don't advance
 *   true  → success, advance source
 */
export async function handleArtistGenre(source, wouldExceedLimit, pushHistory, saveData) {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));

  const pick = selectNextArtist(data);

  if (!pick) {
    console.log(`🎉 All genres complete in ${source.name}`);
    return null;
  }

  const { genre, artist } = pick;

  console.log(`🎸 Genre:    ${genre}`);
  console.log(`👤 Artist:   ${artist.artist}`);
  console.log(`👂 Listeners: ${artist.listeners?.toLocaleString() ?? "unknown"}`);
  if (artist.recommended) console.log(`   (recommended artist)`);

  const trackUris = await getTopTracks(artist.artist, artist.spotify_id);

  // Remove from not_added regardless of outcome
  data[genre].not_added = data[genre].not_added.filter(
    (a) => a.artist !== artist.artist
  );

  if (!trackUris) {
    data[genre].added.push({
      artist: artist.artist,
      listeners: artist.listeners ?? null,
      spotify_id: artist.spotify_id ?? null,
      recommended: artist.recommended ?? false,
      result: "NOT FOUND",
    });
    saveData(DATA_FILE, data);
    return false;
  }

  if (await wouldExceedLimit(trackUris.length)) {
    // Put the artist back — we'll try again next time
    data[genre].not_added.unshift(artist);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return false;
  }

  await addTracks(process.env.TARGET_PLAYLIST_ID, trackUris);
  console.log(`🎶 Added ${trackUris.length} tracks to playlist`);

  data[genre].added.push({
    artist: artist.artist,
    listeners: artist.listeners ?? null,
    spotify_id: artist.spotify_id ?? null,
    recommended: artist.recommended ?? false,
    tracksAdded: trackUris.length,
  });

  pushHistory({
    action: "addArtistGenre",
    genre,
    artist: artist.artist,
    listeners: artist.listeners ?? null,
    tracksAdded: trackUris.length,
    sourceFile: DATA_FILE,
    strategy: source.strategy,
  });

  saveData(DATA_FILE, data);
  console.log(`✅ Completed: ${artist.artist}`);
  return true;
}

/* ==================================================
   DEBUG / PREVIEW (run directly: node artistGenreStrategy.js)
================================================== */

if (process.argv[1].endsWith("artistGenreStrategy.js")) {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  const pick = selectNextArtist(data);

  if (!pick) {
    console.log("All genres complete.");
  } else {
    const genreStats = calculateGenreStats(data);
    console.log("\n📊 Genre Progress:");
    Object.entries(genreStats)
      .sort((a, b) => a[1].added / a[1].total - b[1].added / b[1].total)
      .forEach(([genre, s]) => {
        const pct = ((s.added / s.total) * 100).toFixed(1);
        const bar = "█".repeat(Math.round(s.added / s.total * 20)).padEnd(20, "░");
        console.log(`  ${bar} ${pct}%  ${genre} (${s.added}/${s.total})`);
      });

    console.log(`\n🎯 Next pick:`);
    console.log(`   Genre:    ${pick.genre}`);
    console.log(`   Artist:   ${pick.artist.artist}`);
    console.log(`   Listeners: ${pick.artist.listeners?.toLocaleString() ?? "unknown"}`);
    console.log(`   Recommended: ${pick.artist.recommended ?? false}`);
  }
}
