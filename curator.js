//File: curator.js
// Usage
// Add Next Album   --- node curator.js add
// Undo Last Action --- node curator.js undo
import 'dotenv/config';
import fs from "fs";
import { getAlbumTrackCount } from "./albumInfo.js";
import { initAuthIfNeeded } from './auth.js';
import { checkPlaylistSizes } from './playlistChecker.js'; // ✅ import here
import { addTracks } from './playlist.js';
import { getSpotify } from './auth.js';

// Load JSON
const fileMENL = "data/artistDisc.json";
const historyFileMENL = "history.json";

// Load main dataset
const dataMENL = JSON.parse(fs.readFileSync(fileMENL, "utf-8"));

// Load history (for undo)
let history = [];
if (fs.existsSync(historyFileMENL)) {
  history = JSON.parse(fs.readFileSync(historyFileMENL, "utf-8"));
}


// Utility: save both files
function saveFiles() {
  fs.writeFileSync(fileMENL, JSON.stringify(dataMENL, null, 2));
  fs.writeFileSync(historyFileMENL, JSON.stringify(history, null, 2));
}

// Step 1: Calculate group stats
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

// Step 2: Compute candidate ranking
function getCandidates(dataset) {
  const groupStats = calculateGroupStats(dataset);

  return dataset
    .filter((artist) => artist.Albums.length > 0)
    .map((artist) => {
      const group = artist.Group;
      const totalAlbums = artist.Albums.length + artist.AddedAlbums.length;
      const artistPercentage = artist.AddedAlbums.length / totalAlbums;
      const groupPercentage = groupStats[group].added / groupStats[group].albums;

      return {
        artist: artist.Artist,
        group,
        totalAlbums,
        artistPercentage,
        groupPercentage,
        nextAlbum: artist.Albums[0],
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

// Step 3: Select next album + update JSON
export async function addNextAlbum() {
  const candidates = getCandidates(dataMENL);

  if (candidates.length > 0) {
    const pick = candidates[0];

    console.log("🎵 Next album selected:");
    console.log(`Artist: ${pick.artist}`);
    console.log(`Album: ${pick.nextAlbum}`);
    console.log(`Group: ${pick.group}`);
    console.log(`Group %: ${(pick.groupPercentage * 100).toFixed(2)}%`);
    console.log(`Artist %: ${(pick.artistPercentage * 100).toFixed(2)}%`);

    // Find artist entry
    const artistEntry = dataMENL.find((a) => a.Artist === pick.artist);

    const ready = await initAuthIfNeeded();
    if (!ready) return;

    const albumInfo = await getAlbumTrackCount(pick.artist, pick.nextAlbum);

    if (albumInfo) {
      console.log(`ℹ️ Album: "${albumInfo.name}"`);
      console.log(`Tracks: ${albumInfo.totalTracks}`);
      console.log(`Release: ${albumInfo.release}`);
      console.log(`Link: ${albumInfo.url}`);

      // ✅ Check playlist sizes
      const sizes = await checkPlaylistSizes();
      const targetPlaylistId = process.env.TARGET_PLAYLIST_ID; // define in .env
      const playlistSize = sizes.find(p => p.playlistId === targetPlaylistId);

      if (playlistSize && (playlistSize.trackCount + albumInfo.totalTracks) > 100) {
        console.log(`⚠️ Skipping album — adding ${albumInfo.totalTracks} tracks would exceed 100 limit.`);
        return; // stop here, don’t update dataset
      }

      // ✅ Fetch album tracks
      const spotify = getSpotify();
      const trackRes = await spotify.getAlbumTracks(albumInfo.id, { limit: 50 });
      const uris = trackRes.body.items.map(t => t.uri);

      // ✅ Add to Spotify playlist
      await addTracks(targetPlaylistId, uris);
      console.log(`🎶 Added ${uris.length} tracks to playlist ${targetPlaylistId}.`);

      // Move album
      const albumIndex = artistEntry.Albums.indexOf(pick.nextAlbum);
      artistEntry.Albums.splice(albumIndex, 1);
      artistEntry.AddedAlbums.push(pick.nextAlbum);

      // Save action to history
      history.push({
        action: "add",
        artist: pick.artist,
        album: pick.nextAlbum,
        timestamp: new Date().toISOString(),
      });

      saveFiles();
      console.log("✅ Dataset updated and saved.");

    } else {
      console.log("⚠️ Could not find album on Spotify.");
    }

  } else {
    console.log("🎉 No albums left to add!");
  }
}

// Step 4: Undo last action
function undoLastAction() {
  if (history.length === 0) {
    console.log("⚠️ No history to undo.");
    return;
  }

  const last = history.pop();
  if (last.action === "add") {
    const artistEntry = dataMENL.find((a) => a.Artist === last.artist);
    const albumIndex = artistEntry.AddedAlbums.indexOf(last.album);
    if (albumIndex > -1) {
      artistEntry.AddedAlbums.splice(albumIndex, 1);
      artistEntry.Albums.unshift(last.album); // put it back at the start
      console.log(`↩️ Undid: moved "${last.album}" back to ${last.artist}'s Albums`);
    }
  }

  saveFiles();
}

// --- Run mode ---
const mode = process.argv[2]; // "add" or "undo"

if (mode === "undo") {
  undoLastAction();
} else {
  addNextAlbum();
}
