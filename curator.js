// File: curator.js
//TARGET_PLAYLIST_ID = AMPS
//    Also Home playlist with tracks greater then 6:59
//CLEAN_PLAYLIST_ID = Car-AMPS (Clean)

import 'dotenv/config';
import fs from "fs";
import { getAlbumTrackCount } from "./albumInfo.js";
import { initAuthIfNeeded, getSpotify } from "./auth.js";
import { checkPlaylistSizes } from "./playlistChecker.js";
import { addTracks } from "./playlist.js";
import { processEditorsChoiceWeek, getEditorsChoiceStatus } from "./allMusicIntegration.js";
import { handleArtistGenre } from "./artistGenreStrategy.js";
import { runArtistBatch } from "./topTracksUtil.js";

//* ─── TODOs ──────────────────────────────────────────────────────────────────────

// Todo - Get new albums from Wikipedia from dates more then 7 days ago. If Artist is from new albums or all music is on Artist disc add full album otherwise add top track.
// Todo - Add Disney/Pixar Movie Soundtracks source
// Todo - Add Random Index to ArtistDisc strategy to add some variability (currently just picks first album).
// Todo - Add non-explicit tracks to a second clean playlist (filter trackItems by explicit flag in addTracks).
// Todo - Add retry logic for Spotify API calls in case of transient errors (e.g. 429 rate limits or network issues).

//* ─── DATA SOURCES ───────────────────────────────────────────────────────────────

const dataSources = [
  {
    name: "artistDisc",
    file: "data/artistDisc.json",
    strategy: "fairness",
    originalPosition: 0,
  },
  {
    name: "billboardHot100",
    file: "data/billboardHot100.json",
    strategy: "singleTrack",
    originalPosition: 7,
  },
  {
    name: "1080albums",
    file: "data/1080albums.json",
    strategy: "sequential",
    originalPosition: 1,
  },
  {
    name: "rockNRollHallOfFame",
    file: "data/rockNRollHallofFame.json",
    strategy: "rockHall",
    originalPosition: 3,
  },
  /*{
    name: "spotifyTotmPlaylists",
    file: "data/spotifyPlaylists.json",
    strategy: "spotifyPlaylist",
    originalPosition: 5,
  },*/
  {
    name: "smoothJazz",
    file: "data/smoothJazz.json",
    strategy: "smoothJazz",
    originalPosition: 8,
  },
  {
    name: "artistGenre",
    file: "data/artistTop10.json",
    strategy: "artistGenre",
    originalPosition: 4,
  },
  {
    name: "allMusicEditorsChoice",
    file: "data/editorsChoiceAlbums.json",
    strategy: "editorsChoice",
    originalPosition: 2,
  },
  {
    name: "festivals",
    file: "data/festivals.json",
    strategy: "festival",
    originalPosition: 6,
  },
];

const SOURCE_INDEX_FILE = "data/sourceIndex.json";
const HISTORY_FILE = "history.json";
const MAX_PLAYLIST_SIZE = 200;

//* ─── STATE ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(SOURCE_INDEX_FILE)) {
  fs.writeFileSync(SOURCE_INDEX_FILE, JSON.stringify({ index: 0 }, null, 2));
}

let sourceIndex = JSON.parse(fs.readFileSync(SOURCE_INDEX_FILE, "utf-8")).index;
let history = fs.existsSync(HISTORY_FILE)
  ? JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"))
  : [];

//* ─── UTILITIES ──────────────────────────────────────────────────────────────────

function readSourceIndex() {
  sourceIndex = JSON.parse(fs.readFileSync(SOURCE_INDEX_FILE, "utf-8")).index;
}

function advanceSource() {
  sourceIndex = (sourceIndex + 1) % dataSources.length;
  fs.writeFileSync(SOURCE_INDEX_FILE, JSON.stringify({ index: sourceIndex }, null, 2));
}

function saveData(dataFilePath, data) {
  fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function pushHistory(entry) {
  history.push({ ...entry, timestamp: new Date().toISOString() });
}

async function getPlaylistTrackCount() {
  const sizes = await checkPlaylistSizes();
  const targetPlaylistId = process.env.TARGET_PLAYLIST_ID;
  return sizes.find(p => p.playlistId === targetPlaylistId)?.trackCount ?? 0;
}

async function getCarPlaylistTrackCount() {
  const sizes = await checkPlaylistSizes();
  const cleanId = process.env.CLEAN_PLAYLIST_ID;
  const explicitId = process.env.CAR_PLAYLIST_ALL_ID;
  const cleanCount = cleanId ? (sizes.find(p => p.playlistId === cleanId)?.trackCount ?? 0) : 0;
  const explicitCount = explicitId ? (sizes.find(p => p.playlistId === explicitId)?.trackCount ?? 0) : 0;
  return Math.min(cleanCount, explicitCount);
}

async function wouldExceedLimit(tracksToAdd) {
  const current = await getPlaylistTrackCount();
  if (current + tracksToAdd > MAX_PLAYLIST_SIZE) {
    console.log(`⚠️ Playlist would exceed ${MAX_PLAYLIST_SIZE} tracks (currently ${current}, adding ${tracksToAdd}).`);
    console.log(`⏸️  Waiting for space before adding more.`);
    return true;
  }
  return false;
}

//* ─── FAIRNESS STRATEGY ───────────────────────────────────

function calculateGroupStats(artists) {
  return artists.reduce((stats, artist) => {
    const group = artist.Group;
    if (!stats[group]) stats[group] = { albums: 0, added: 0 };
    stats[group].albums += artist.Albums.length + artist.AddedAlbums.length;
    stats[group].added += artist.AddedAlbums.length;
    return stats;
  }, {});
}

function selectWithFairness(data) {
  const artists = data.artists;
  const groupStats = calculateGroupStats(artists);

  const candidate = artists
    .filter(a => a.Albums.length > 0)
    .map(a => {
      const totalAlbums = a.Albums.length + a.AddedAlbums.length;
      const randomIndex = Math.floor(Math.random() * a.Albums.length);

      return {
        artist: a.Artist,
        group: a.Group,
        artistPercentage: a.AddedAlbums.length / totalAlbums,
        groupPercentage: groupStats[a.Group].added / groupStats[a.Group].albums,
        totalAlbums,
        nextAlbum: a.Albums[randomIndex]
      };
    })
    .sort((a, b) =>
      a.groupPercentage - b.groupPercentage ||
      a.artistPercentage - b.artistPercentage ||
      b.totalAlbums - a.totalAlbums
    )[0];

  return candidate ?? null;
}

//* ─── SEQUENTIAL STRATEGY ───────────────────────────────────

function selectSequential(dataset) {
  if (dataset.master?.length > 0) {
    const randomIndex = Math.floor(Math.random() * dataset.master.length);
    const albumString = dataset.master[randomIndex];
    console.log(`📀 Parsing: "${albumString} - ${randomIndex}"`);
    const dashIndex = albumString.indexOf(' - ');
    if (dashIndex === -1) {
      console.log(`⚠️ Invalid format (no ' - ' separator): ${albumString}`);
      return null;
    }
    const artist = albumString.substring(0, dashIndex).trim();
    const nextAlbum = albumString.substring(dashIndex + 3).trim();
    console.log(`🎤 Artist: "${artist}"\n💿 Album: "${nextAlbum}"`);
    return { artist, nextAlbum, index: randomIndex };
  }

  // Fallback for artistDisc format
  const entry = dataset.find(item => item.Albums?.length > 0);
  return entry ? { artist: entry.Artist, nextAlbum: entry.Albums[0] } : null;
}

//* ─── MUSICBRAINZ - ORIGINAL RELEASE TRACK COUNT ───────────────────────────────────

async function getOriginalTrackCount(artist, album) {
  const query = `release:"${album}" AND artist:"${artist}"`;
  const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query)}&fmt=json&limit=10`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PlaylistCurator/1.0 (your@email.com)' }
    });
    const json = await res.json();

    if (!json.releases?.length) {
      console.log(`⚠️ MusicBrainz: No releases found for "${artist} - ${album}"`);
      return null;
    }

    // Sort by date ascending, pick the earliest official release
    const official = json.releases
      .filter(r => r.status === 'Official' && r.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!official.length) {
      console.log(`⚠️ MusicBrainz: No official dated releases found`);
      return null;
    }

    const earliest = official[0];
    const trackCount = earliest['track-count'];
    console.log(`📅 MusicBrainz original release: "${earliest.title}" (${earliest.date}) — ${trackCount} tracks`);
    return trackCount;

  } catch (err) {
    console.error(`❌ MusicBrainz lookup failed:`, err.message);
    return null;
  }
}


//* ─── STRATEGY HANDLERS ───────────────────────────────────

async function handleEditorsChoice(source) {
  const status = getEditorsChoiceStatus();
  if (!status.available || status.pendingWeeks === 0) {
    console.log(`🎉 No more weeks in ${source.name}`);
    return null; // signal to advance
  }

  if (status.nextWeek) {
    console.log(`Week: ${status.nextWeek.date}`);
    console.log(`Albums: ${status.nextWeek.enrichedAlbums}/${status.nextWeek.totalAlbums} ready`);
  }

  const result = await processEditorsChoiceWeek();
  if (!result.success) {
    console.log(`⚠️ Failed to process week: ${result.reason}`);
    return false;
  }

  pushHistory({
    action: "addEditorsChoice",
    weekDate: result.weekDate,
    tracksAdded: result.tracksAdded,
    tracksSkipped: result.tracksSkipped,
    sourceFile: source.file,
    strategy: source.strategy
  });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`✅ Completed: Week ${result.weekDate}`);
  return true;
}

//* ─── ROCK HALL STRATEGY ───────────────────────────────────

async function handleRockHall(source, data) {
  if (!data.artists?.length) {
    console.log(`🎉 No more artists in ${source.name}`);
    return null;
  }

  if (await wouldExceedLimit(10)) return false;

  // Build a working copy so we can requeue on REQUEUE signal
  let pendingRequeue = null;

  function pickArtist() {
    if (!data.artists.length) return null;
    const randomIndex = Math.floor(Math.random() * data.artists.length);
    const name = data.artists[randomIndex];
    console.log(`Artist: ${name} - index ${randomIndex}`);
    data.artists.splice(randomIndex, 1);
    return { name };
  }

  async function onResult(name, success, trackUris, reason) {
    if (success === "REQUEUE") {
      data.artists.unshift(name);
      saveData(source.file, data);
      return;
    }
    if (!success) {
      data.added.push(`${name} [${reason}]`);
    } else {
      data.added.push(name);
      pushHistory({
        action: "addRockHall",
        artist: name,
        tracksAdded: trackUris.length,
        sourceFile: source.file,
        strategy: source.strategy,
      });
    }
    saveData(source.file, data);
  }

  return runArtistBatch({
    batchSize: 2,
    tracksPerArtist: 5,
    targetPlaylistId: process.env.TARGET_PLAYLIST_ID,
    wouldExceedLimit,
    pickArtist,
    onResult,
  });
}

//* ─── FESTIVAL STRATEGY ───────────────────────────────────

async function handleFestival(source, data) {
  // Find festivals that still have artists remaining
  const active = data.festivals.filter(f => f.artists.length > 0);

  if (!active.length) {
    console.log(`🎉 No more artists in any festival`);
    return null;
  }

  // Pick the festival with the lowest completion percentage
  const festival = active.sort((a, b) => {
    const pctA = a.added.length / (a.artists.length + a.added.length);
    const pctB = b.added.length / (b.artists.length + b.added.length);
    return pctA - pctB;
  })[0];

  console.log(`🎪 Festival: ${festival.name}`);

  // Build a set of all already-added artist names across all festivals for dedup
  const globalAdded = new Set(
    data.festivals.flatMap(f => f.added.map(a => a.replace(/\s*\[.*?\]$/, '')))
  );

  function pickArtist() {
    if (!festival.artists.length) return null;

    // Skip duplicates inline; try up to festival.artists.length times
    for (let attempt = 0; attempt < festival.artists.length; attempt++) {
      const randomIndex = Math.floor(Math.random() * festival.artists.length);
      const name = festival.artists[randomIndex];

      if (globalAdded.has(name)) {
        console.log(`⏭️ Skipping ${name} — already added from another festival`);
        festival.artists.splice(randomIndex, 1);
        festival.added.push(`${name} [DUPLICATE]`);
        saveData(source.file, data);
        globalAdded.add(name); // already there, no-op
        continue;
      }

      console.log(`Artist: ${name} - index ${randomIndex}`);
      festival.artists.splice(randomIndex, 1);
      globalAdded.add(name);
      return { name };
    }

    return null; // all remaining were duplicates
  }

  async function onResult(name, success, trackUris, reason) {
    if (success === "REQUEUE") {
      festival.artists.unshift(name);
      globalAdded.delete(name); // allow retry next time
      saveData(source.file, data);
      return;
    }
    if (!success) {
      festival.added.push(`${name} [${reason}]`);
    } else {
      festival.added.push(name);
      pushHistory({
        action: "addFestival",
        festival: festival.name,
        artist: name,
        tracksAdded: trackUris.length,
        sourceFile: source.file,
        strategy: source.strategy,
      });
    }
    saveData(source.file, data);
  }

  return runArtistBatch({
    batchSize: 2,
    tracksPerArtist: 5,
    targetPlaylistId: process.env.TARGET_PLAYLIST_ID,
    wouldExceedLimit,
    pickArtist,
    onResult,
  });
}

async function handleAlbum(source, data) {
  const pick = source.strategy === "fairness"
    ? selectWithFairness(data)
    : selectSequential(data);

  if (!pick) {
    console.log(`🎉 No albums left in ${source.name}`);
    return null;
  }

  console.log(`Artist: ${pick.artist}\nAlbum: ${pick.nextAlbum}`);

  const albumInfo = await getAlbumTrackCount(pick.artist, pick.nextAlbum);
  if (!albumInfo) {
    console.log("⚠️ Album not found on Spotify.");
    if (source.strategy === "sequential") {
      data.master.shift();
      data.added.push(`${pick.artist} - ${pick.nextAlbum} [NOT FOUND]`);
    } else {
      const entry = data.artists.find(a => a.Artist === pick.artist);
      if (entry) { entry.Albums.shift(); entry.AddedAlbums.push(`${pick.nextAlbum} [NOT FOUND]`); }
    }
    fs.writeFileSync(source.file, JSON.stringify(data, null, 2));
    return false;
  }


  const spotify = getSpotify();
  const tracks = await spotify.getAlbumTracks(albumInfo.id, { limit: 50 });
  let uris = tracks.body.items.map(t => t.uri);

  const originalCount = albumInfo.totalTracks > 30
    ? await getOriginalTrackCount(pick.artist, pick.nextAlbum)
    : null;

  if (originalCount && originalCount < uris.length) {
    console.log(`✂️  Trimming to ${originalCount} original tracks (Spotify has ${uris.length})`);
    uris = uris.slice(0, originalCount);
  }

  if (await wouldExceedLimit(albumInfo.totalTracks)) return false;

  await addTracks(process.env.TARGET_PLAYLIST_ID, uris);
  console.log(`🎶 Added ${uris.length} tracks.`);

  if (source.strategy === "sequential") {
    data.master.shift();
    data.added.push(`${pick.artist} - ${pick.nextAlbum}`);
  } else {
    const entry = data.artists.find(a => a.Artist === pick.artist);
    entry.Albums.shift();
    entry.AddedAlbums.push(pick.nextAlbum);
  }

  pushHistory({
    action: "add",
    artist: pick.artist,
    album: pick.nextAlbum,
    index: pick.index ?? null,
    tracksAdded: uris.length,
    sourceFile: source.file,
    strategy: source.strategy
  });
  saveData(source.file, data);
  console.log(`✅ Album added successfully`);
  return true;
}

async function handleSingleTrack(source, data) {
  if (!data.master?.length) {
    console.log(`🎉 No more tracks in ${source.name}`);
    return null;
  }

  if (await wouldExceedLimit(10)) return false;

  const spotify = getSpotify();
  let addedCount = 0;
  const uris = [];

  for (let i = 0; i < 10; i++) {
    if (!data.master.length) break;

    const randomIndex = Math.floor(Math.random() * data.master.length);
    const entry = data.master[randomIndex];

    // Support both object format { song, artist, year } and legacy string "Artist - Title"
    let artist, title, year, entryKey;
    if (typeof entry === 'object') {
      artist = entry.artist;
      title = entry.song;
      year = entry.year ?? '';
      entryKey = `${artist} - ${title}`;
    } else {
      const dashIndex = entry.indexOf(' - ');
      if (dashIndex === -1) {
        data.master.splice(randomIndex, 1);
        data.added.push(`${entry} [INVALID FORMAT]`);
        continue;
      }
      artist = entry.substring(0, dashIndex).trim();
      title = entry.substring(dashIndex + 3).trim();
      entryKey = entry;
    }
    // ------------------------------
    console.log(`🎵 Searching: "${title}" by ${artist}`);

    try {
      const res = await spotify.searchTracks(`track:"${title}" artist:"${artist}"`, { limit: 1 });
      const tracks = res.body.tracks.items;

      if (!tracks.length) {
        console.log(`⚠️ Not found: ${entry}`);
        data.master.splice(randomIndex, 1);
        data.added.push(`${entry} [NOT FOUND]`);
        continue;
      }

      uris.push(tracks[0].uri);
      data.master.splice(randomIndex, 1);
      data.added.push(entry);
      addedCount++;
      console.log(`✅ Found: "${tracks[0].name}" by ${tracks[0].artists[0].name}`);

    } catch (err) {
      console.error(`❌ Search error for ${entry}:`, err.message);
      continue;
    }
  }

  if (!uris.length) return false;

  if (await wouldExceedLimit(uris.length)) {
    // Put them back since we haven't added yet
    return false;
  }

  await addTracks(process.env.TARGET_PLAYLIST_ID, uris);
  console.log(`🎶 Added ${uris.length} tracks`);

  pushHistory({
    action: source.name,
    tracksAdded: uris.length,
    sourceFile: source.file,
    strategy: source.strategy
  });
  saveData(source.file, data);

  return true;
}

//* ─── SPOTIFY TotM PLAYLIST STRATEGY ───────────────────────────────────

function extractPlaylistId(url) {
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

async function handleSpotifyPlaylist(source, data) {
  const remaining = data.playlists.filter(p => !p.added);
  if (remaining.length === 0) {
    console.log(`🎉 All playlists in ${source.name} have been added`);
    return null;
  }

  const randomIndex = Math.floor(Math.random() * remaining.length);
  const playlist = remaining[randomIndex];
  const playlistId = extractPlaylistId(playlist.url);

  if (!playlistId) {
    console.log(`⚠️ Could not extract playlist ID from: ${playlist.url}`);
    playlist.added = true;
    saveData(source.file, data);
    return false;
  }

  console.log(`🎵 Processing playlist: "${playlist.name}" (${playlistId})`);

  try {
    const spotify = getSpotify();

    // Fetch all tracks (paginate if needed)
    let trackUris = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await spotify.getPlaylistTracks(playlistId, { limit, offset, fields: "items(track(uri,name)),next" });
      const items = response.body.items;
      const uris = items
        .filter(item => item.track?.uri)
        .map(item => item.track.uri);
      trackUris.push(...uris);
      console.log(`   Fetched ${uris.length} tracks (offset ${offset})`);
      if (!response.body.next) break;
      offset += limit;
    }

    if (trackUris.length === 0) {
      console.log(`⚠️ No tracks found in playlist: ${playlist.name}`);
      playlist.added = true;
      data.added.push({ name: playlist.name, url: playlist.url, reason: "EMPTY" });
      saveData(source.file, data);
      return false;
    }

    console.log(`📋 Total tracks: ${trackUris.length}`);
    if (await wouldExceedLimit(trackUris.length)) return false;

    await addTracks(process.env.TARGET_PLAYLIST_ID, trackUris);
    console.log(`🎶 Added ${trackUris.length} tracks from "${playlist.name}"`);

    data.added.push({ name: playlist.name, url: playlist.url, tracksAdded: trackUris.length });

    pushHistory({
      action: "addSpotifyPlaylist",
      playlistName: playlist.name,
      playlistUrl: playlist.url,
      playlistId,
      index: randomIndex,
      tracksAdded: trackUris.length,
      sourceFile: source.file,
      strategy: source.strategy
    });

    saveData(source.file, data);
    console.log(`✅ Completed: "${playlist.name}"`);
    return true;

  } catch (error) {
    console.error(`❌ Error fetching playlist:`, error.message);
    return false;
  }
}

//* ─── ADD NEXT ALBUM (main entry point) ───────────────────────────────────

export async function addNextAlbum() {
  readSourceIndex();
  const source = dataSources[sourceIndex];
  console.log(`🔀 Current data source: ${source.name} (strategy: ${source.strategy})`);

  const ready = await initAuthIfNeeded();
  if (!ready) {
    console.error("❌ Authentication failed!");
    return false;
  }

  const data = JSON.parse(fs.readFileSync(source.file, "utf-8"));

  let result;
  if (source.strategy === "editorsChoice") result = await handleEditorsChoice(source);
  else if (source.strategy === "rockHall") result = await handleRockHall(source, data);
  else if (source.strategy === "festival") result = await handleFestival(source, data);
  else if (source.strategy === "artistGenre") result = await handleArtistGenre(source, wouldExceedLimit, pushHistory, saveData);
  else if (source.strategy === "spotifyPlaylist") result = await handleSpotifyPlaylist(source, data);
  else if (source.strategy === "singleTrack") result = await handleSingleTrack(source, data);
  else if (source.strategy === "smoothJazz") result = await handleSingleTrack(source, data);
  else result = await handleAlbum(source, data);

  // null means "this source is exhausted, skip it"
  if (result === null) { advanceSource(); return false; }
  if (result) { advanceSource(); console.log(`🔀 Next data source: ${dataSources[sourceIndex].name}`); }

  return result ?? false;
}

//* ─── FILL PLAYLIST ───────────────────────────────────

export async function fillPlaylist() {
  console.log("🎯 Starting playlist fill process...\n");
  let addCount = 0;
  let consecutiveFailures = 0;

  while (consecutiveFailures < 3) {
    const result = await addNextAlbum();
    if (!result) {
      consecutiveFailures++;
    } else {
      consecutiveFailures = 0;
      addCount++;
      console.log(`\n✨ Progress: ${addCount} item(s) added so far\n`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  console.log(`\n🎉 Fill complete! Added ${addCount} item(s) total.`);
  console.log("🛑 Stopping: Playlist appears to be full (multiple items won't fit)");

  const trackCount = await getPlaylistTrackCount();
  console.log(`📊 Final playlist size: ${trackCount}/${MAX_PLAYLIST_SIZE} tracks`);
}
