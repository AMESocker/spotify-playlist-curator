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
/*
function selectSequential(dataset) {
  const artist = dataset.find(a => a.Albums.length > 0);
  if (!artist) return null;

  return {
    artist: artist.Artist,
    nextAlbum: artist.Albums[0]
  };
} */
function selectSequential(dataset) {
  if (dataset.length === 0) return null;
  return dataset[0];
}

/* ==================================================
   ADD NEXT ALBUM
================================================== */

export async function addNextAlbum() {
  let pick;

  if (currentSource.strategy === "fairness") {
    pick = selectWithFairness(data);
  } else {
    pick = selectSequential(data);
  }

  if (!pick) {
    console.log(`🎉 No albums left in ${currentSource.name}`);
    advanceSource();
    return;
  }

  const artistEntry = data.find(a => a.Artist === pick.artist);
  const albumName = pick.nextAlbum;

  console.log("🎵 Next album selected:");
  console.log(`Source: ${currentSource.name}`);
  console.log(`Artist: ${pick.artist}`);
  console.log(`Album: ${albumName}`);

  const ready = await initAuthIfNeeded();
  if (!ready) return;

  const albumInfo = await getAlbumTrackCount(pick.artist, albumName);
  if (!albumInfo) {
    console.log("⚠️ Album not found on Spotify.");
    return;
  }

  const sizes = await checkPlaylistSizes();
  const targetPlaylistId = process.env.TARGET_PLAYLIST_ID;
  const playlistSize = sizes.find(p => p.playlistId === targetPlaylistId);

      if (playlistSize && (playlistSize.trackCount + albumInfo.totalTracks) > 200) {
        console.log(`⚠️ Skipping album — adding ${albumInfo.totalTracks} tracks would exceed 100 limit.`);
        return; // stop here, don’t update dataset
      }

  const spotify = getSpotify();
  const tracks = await spotify.getAlbumTracks(albumInfo.id, { limit: 50 });
  const uris = tracks.body.items.map(t => t.uri);

  await addTracks(targetPlaylistId, uris);
  console.log(`🎶 Added ${uris.length} tracks.`);

  // Move album in dataset
  artistEntry.Albums.shift();
  artistEntry.AddedAlbums.push(albumName);

  history.push({
    action: "add",
    artist: pick.artist,
    album: albumName,
    sourceFile: dataFile,
    timestamp: new Date().toISOString()
  });

  saveData();
  advanceSource();
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

  const artistEntry = undoData.find(a => a.Artist === last.artist);
  if (!artistEntry) return;

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

const mode = process.argv[2];

if (mode === "undo") {
  undoLastAction();
} else {
  addNextAlbum();
}