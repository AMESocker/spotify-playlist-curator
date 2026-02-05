// File: curator.js
// Usage:
// Add Next Album   --- node curator.js add
// Undo Last Action --- node curator.js undo

import 'dotenv/config';
import fs from "fs";
import { getAlbumTrackCount } from "./albumInfo.js";
import { initAuthIfNeeded, getSpotify } from "./auth.js";
import { checkPlaylistSizes } from "./playlistChecker.js";
import { addTracks } from "./playlist.js";

/* ==================================================
   DATA SOURCES
================================================== */
// TODO: Add AllMusic Editors Choice source
// TODO: Add Artist Top 10 source
// TODO: Label added artists with genres in Artist Top 10 source
// TODO: Add Disney/Pixar Movie Soundtracks source
// TODO: Add Classical Composers source
const dataSources = [
  {
    name: "artistDisc",
    file: "data/artistDisc.json",
    strategy: "fairness"
  },
  {
    name: "1080albums",
    file: "data/1080albums.json",
    strategy: "sequential"
  },
  {
    name: "rockNRollHallOfFame",
    file: "data/rockNRollHallofFame.json",
    strategy: "rockHall"
  }
];

const sourceIndexFile = "data/sourceIndex.json";
const historyFile = "history.json";

/* ==================================================
   SOURCE INDEX INITIALIZATION
================================================== */

if (!fs.existsSync(sourceIndexFile)) {
  fs.writeFileSync(
    sourceIndexFile,
    JSON.stringify({ index: 0 }, null, 2)
  );
}

let sourceIndex = JSON.parse(
  fs.readFileSync(sourceIndexFile, "utf-8")
).index;
console.log(`🔀 Current data source: ${dataSources[sourceIndex].name}`);
const currentSource = dataSources[sourceIndex];
const dataFile = currentSource.file;

/* ==================================================
   LOAD DATA + HISTORY
================================================== */

const data = JSON.parse(fs.readFileSync(dataFile, "utf-8"));

let history = [];
if (fs.existsSync(historyFile)) {
  history = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
}

/* ==================================================
   UTILITIES
================================================== */

function saveData() {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

/*
 // Done: When a source is added, make sure advanceSource handles it correctly */

function advanceSource() {
  sourceIndex = (sourceIndex + 1) % dataSources.length;
  fs.writeFileSync(
    sourceIndexFile,
    JSON.stringify({ index: sourceIndex }, null, 2)
  );
}

/* ==================================================
   FAIRNESS LOGIC (USED BY ONE SOURCE ONLY)
================================================== */

function calculateGroupStats(dataset) {
  const stats = {};
  for (const artist of dataset) {
    const group = artist.Group;
    if (!stats[group]) {
      stats[group] = { albums: 0, added: 0 };
    }
    stats[group].albums += artist.Albums.length + artist.AddedAlbums.length;
    stats[group].added += artist.AddedAlbums.length;
  }
  return stats;
}

function getCandidates(dataset) {
  const groupStats = calculateGroupStats(dataset);

  return dataset
    .filter(a => a.Albums.length > 0)
    .map(a => {
      const totalAlbums = a.Albums.length + a.AddedAlbums.length;
      return {
        artist: a.Artist,
        group: a.Group,
        artistPercentage: a.AddedAlbums.length / totalAlbums,
        groupPercentage:
          groupStats[a.Group].added / groupStats[a.Group].albums,
        totalAlbums,
        nextAlbum: a.Albums[0]
      };
    })
    .sort((a, b) => {
      if (a.groupPercentage !== b.groupPercentage) {
        return a.groupPercentage - b.groupPercentage;
      }
      if (a.artistPercentage !== b.artistPercentage) {
        return a.artistPercentage - b.artistPercentage;
      }
      return b.totalAlbums - a.totalAlbums;
    });
}

function selectWithFairness(dataset) {
  const candidates = getCandidates(dataset);
  return candidates.length > 0 ? candidates[0] : null;
}

/* ==================================================
   SEQUENTIAL STRATEGY (DEFAULT)
================================================== */

function selectSequential(dataset) {
  // For 1080albums format with master/added structure
  if (dataset.master && Array.isArray(dataset.master)) {
    if (dataset.master.length === 0) return null;

    // Get first album string from master array
    const albumString = dataset.master[0];
    console.log(`📀 Parsing: "${albumString}"`);

    // Find the first occurrence of " - " (with spaces)
    const separator = ' - ';
    const dashIndex = albumString.indexOf(separator);

    if (dashIndex === -1) {
      console.log(`⚠️ Invalid format (no ' - ' separator): ${albumString}`);
      return null;
    }

    const artist = albumString.substring(0, dashIndex).trim();
    const album = albumString.substring(dashIndex + separator.length).trim();

    console.log(`🎤 Artist: "${artist}"`);
    console.log(`💿 Album: "${album}"`);

    return {
      artist: artist,
      nextAlbum: album
    };
  }

  // Fallback for artistDisc format
  const entry = dataset.find(item => item.Albums && item.Albums.length > 0);
  if (!entry) return null;

  return {
    artist: entry.Artist,
    nextAlbum: entry.Albums[0]
  };
}

/* ==================================================
   ROCK HALL STRATEGY
   Adds 10 tracks from various albums by the artist
================================================== */

async function processRockHallArtist(artistName) {
  console.log(`🎵 Processing: ${artistName}`);

  const spotify = getSpotify();

  try {
    // Find the artist
    console.log(`🔍 Finding artist: ${artistName}`);
    const artistResults = await spotify.searchArtists(artistName, { limit: 5 });

    if (artistResults.body.artists.items.length === 0) {
      console.log(`⚠️ Artist not found: ${artistName}`);
      return {
        success: false,
        reason: "ARTIST NOT FOUND",
        trackUris: []
      };
    }

    const artist = artistResults.body.artists.items[0];
    console.log(`✅ Found artist: "${artist.name}" (ID: ${artist.id})`);

    // Get artist's top tracks
    console.log(`🎵 Getting top tracks...`);
    const topTracksResponse = await spotify.getArtistTopTracks(artist.id, 'US');
    const topTracks = topTracksResponse.body.tracks;

    if (topTracks.length === 0) {
      console.log(`⚠️ No tracks found for ${artistName}`);
      return {
        success: false,
        reason: "NO TRACKS",
        trackUris: []
      };
    }

    // Take up to 10 top tracks
    const trackUris = topTracks.slice(0, 10).map(t => t.uri);

    console.log(`   Found ${topTracks.length} top tracks, adding ${trackUris.length}:`);
    topTracks.slice(0, 10).forEach((track, i) => {
      console.log(`   ${i + 1}. "${track.name}" (popularity: ${track.popularity})`);
    });

    return {
      success: true,
      trackUris: trackUris,
      trackCount: trackUris.length
    };

  } catch (error) {
    console.error(`❌ Error:`, error.message);
    return {
      success: false,
      reason: "ERROR",
      trackUris: [],
      error: error.message
    };
  }
}

/* ==================================================
   ADD NEXT ALBUM (OR ARTIST FOR ROCK HALL)
================================================== */

export async function addNextAlbum() {


  let pick;

  // Handle Rock Hall strategy differently
  if (currentSource.strategy === "rockHall") {
    if (!data.artists || data.artists.length === 0) {
      console.log(`🎉 No more artists in ${currentSource.name}`);
      advanceSource();
      return;
    }

    const artistName = data.artists[0];
    console.log("🎵 Next artist selected:");
    console.log(`Source: ${currentSource.name}`);
    console.log(`Strategy: ${currentSource.strategy}`);
    console.log(`Artist: ${artistName}`);

    const ready = await initAuthIfNeeded();
    if (!ready) {
      console.error("❌ Authentication failed!");
      return;
    }

    const result = await processRockHallArtist(artistName);

    if (!result.success) {
      // Remove from queue even if failed
      data.artists.shift();
      data.added.push(`${artistName} [${result.reason}]`);
      saveData();
      advanceSource();
      return;
    }

    // Check playlist size
    const sizes = await checkPlaylistSizes();
    const targetPlaylistId = process.env.TARGET_PLAYLIST_ID;
    const playlistSize = sizes.find(p => p.playlistId === targetPlaylistId);

    if (playlistSize && (playlistSize.trackCount + result.trackCount) > 200) {
      console.log(`⚠️ Playlist would exceed 200 tracks (currently ${playlistSize.trackCount}, adding ${result.trackCount} tracks).`);
      console.log(`⏸️  Waiting for space in playlist before adding more tracks.`);
      return;
    }

    // Add tracks to playlist
    await addTracks(targetPlaylistId, result.trackUris);
    console.log(`🎶 Added ${result.trackCount} tracks to playlist`);

    // Update data
    data.artists.shift();
    data.added.push(artistName);

    history.push({
      action: "addRockHall",
      artist: artistName,
      tracksAdded: result.trackCount,
      sourceFile: dataFile,
      strategy: currentSource.strategy,
      timestamp: new Date().toISOString()
    });

    saveData();
    advanceSource();
    console.log(`✅ Completed: ${artistName}`);
    console.log(`🔀 Next data source: ${dataSources[sourceIndex].name}`);
    return;
  }

  // Original album-based strategies

  if (currentSource.strategy === "fairness") {
    pick = selectWithFairness(data);
  } else {
    pick = selectSequential(data);
  }

  if (!pick) {
    console.log(`🎉 No albums left in ${currentSource.name}`);
    return false; // Return false when no albums available
  }

  const albumName = pick.nextAlbum;

  console.log("🎵 Next album selected:");
  console.log(`Source: ${currentSource.name}`);
  console.log(`Strategy: ${currentSource.strategy}`);
  console.log(`Artist: ${pick.artist}`);
  console.log(`Album: ${albumName}`);

  const ready = await initAuthIfNeeded();
  if (!ready) {
    return false; // Return false on auth failure
  }

  const albumInfo = await getAlbumTrackCount(pick.artist, albumName);
  if (!albumInfo) {
    console.log("⚠️ Album not found on Spotify.");
    // Remove from queue
    if (currentSource.strategy === "sequential") {
      data.master.shift();
      data.added.push(`${pick.artist} - ${albumName} [NOT FOUND]`);
    } else {
      const artistEntry = data.find(a => a.Artist === pick.artist);
      if (artistEntry) {
        artistEntry.Albums.shift();
        artistEntry.AddedAlbums.push(`${albumName} [NOT FOUND]`);
      }
    }
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    return false; // Return false when album not found
  }

  const sizes = await checkPlaylistSizes();
  const targetPlaylistId = process.env.TARGET_PLAYLIST_ID;
  const playlistSize = sizes.find(p => p.playlistId === targetPlaylistId);

  if (playlistSize && (playlistSize.trackCount + albumInfo.totalTracks) > 200) {
    console.log(`⚠️ Playlist would exceed 200 tracks (currently ${playlistSize.trackCount}, album has ${albumInfo.totalTracks} tracks).`);
    console.log(`⏸️  Waiting for space in playlist before adding more albums.`);
    return false; // Return false when playlist would be too full
  }

  const spotify = getSpotify();
  const tracks = await spotify.getAlbumTracks(albumInfo.id, { limit: 50 });
  const uris = tracks.body.items.map(t => t.uri);

  await addTracks(targetPlaylistId, uris);
  console.log(`🎶 Added ${uris.length} tracks.`);

  // Move album in dataset
  if (currentSource.strategy === "sequential") {
    data.master.shift();
    data.added.push(`${pick.artist} - ${albumName}`);
  } else {
    const artistEntry = data.find(a => a.Artist === pick.artist);
    artistEntry.Albums.shift();
    artistEntry.AddedAlbums.push(albumName);
  }

  history.push({
    action: "add",
    artist: pick.artist,
    album: albumName,
    sourceFile: dataFile,
    strategy: currentSource.strategy,
    timestamp: new Date().toISOString()
  });

  saveData(); // This should handle both data and history saves
  advanceSource();

  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

  console.log(`✅ Album added successfully`);
  console.log(`🔀 Next data source: ${dataSources[sourceIndex].name}`);
  return true; // Return true on success
}



/* ==================================================
   UNDO LAST ACTION (SOURCE-AWARE)
================================================== */

function undoLastAction() {
  if (history.length === 0) {
    console.log("⚠️ No history to undo.");
    return;
  }

  const last = history.pop();
  const undoData = JSON.parse(fs.readFileSync(last.sourceFile, "utf-8"));

  // Handle Rock Hall format
  if (last.action === "addRockHall") {
    const index = undoData.added.indexOf(last.artist);
    if (index > -1) {
      undoData.added.splice(index, 1);
      undoData.artists.unshift(last.artist);
    }
    fs.writeFileSync(last.sourceFile, JSON.stringify(undoData, null, 2));
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    console.log(`↩️ Undid artist "${last.artist}" (${last.tracksAdded} tracks)`);
    return;
  }

  // Handle sequential format (1080albums)
  if (last.strategy === "sequential") {
    const albumString = `${last.artist} - ${last.album}`;
    const index = undoData.added.indexOf(albumString);
    if (index > -1) {
      undoData.added.splice(index, 1);
      undoData.master.unshift(albumString);
    }
    fs.writeFileSync(last.sourceFile, JSON.stringify(undoData, null, 2));
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    console.log(`↩️ Undid album "${last.album}" from ${last.artist}`);
    return;
  }

  // Handle fairness format (artistDisc)
  const artistEntry = undoData.find(a => a.Artist === last.artist);
  if (!artistEntry) {
    console.log("⚠️ Artist not found in data file.");
    return;
  }

  const index = artistEntry.AddedAlbums.indexOf(last.album);
  if (index > -1) {
    artistEntry.AddedAlbums.splice(index, 1);
    artistEntry.Albums.unshift(last.album);
  }

  fs.writeFileSync(last.sourceFile, JSON.stringify(undoData, null, 2));
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

  console.log(`↩️ Undid album "${last.album}" from ${last.artist}`);
}

/* ==================================================
   RUN MODE
================================================== */

// const mode = process.argv[2];

// if (mode === "undo") {
//   undoLastAction();
// } else {
//   addNextAlbum();
// }