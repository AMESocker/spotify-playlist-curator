// File: curator.js


import 'dotenv/config';
import fs from "fs";
import { getAlbumTrackCount } from "./albumInfo.js";
import { initAuthIfNeeded, getSpotify } from "./auth.js";
import { checkPlaylistSizes } from "./playlistChecker.js";
import { addTracks } from "./playlist.js";
import { processEditorsChoiceWeek, getEditorsChoiceStatus } from "./allMusicIntegration.js";
import { handleArtistGenre } from "./artistGenreStrategy.js";

//* ─── TODOs ──────────────────────────────────────────────────────────────────────

// Todo - Get new albums from Wikipedia from dates more then 7 days ago. If Artist is from new albums or all music is on Artist disc add full album otherwise add top track.

// Todo - Add Disney/Pixar Movie Soundtracks source

// Todo - Add Random Index to ArtistDisc strategy to add some variability (currently just picks first album).

// Todo - Add non-explicit tracks to a second clean playlist (filter trackItems by explicit flag in addTracks).

// Todo - Create a dashboard to visualize source queues, history, and playlist growth over time (could be a simple web page reading from history.json).

// Todo - Clean 1080albums.json with entries that don't have " - " format.

// Todo - Remove songs older then one month from playlist and add to a separate playlist called old or stale.

// Todo - Add retry logic for Spotify API calls in case of transient errors (e.g. 429 rate limits or network issues).

//* ─── DATA SOURCES ──────────────────────────────────────────────────────────────────────

const dataSources = [
  { name: "artistDisc", file: "data/artistDisc.json", strategy: "fairness" },
  { name: "1080albums", file: "data/1080albums.json", strategy: "sequential" },
  { name: "rockNRollHallOfFame", file: "data/rockNRollHallofFame.json", strategy: "rockHall" },
  { name: "allMusicEditorsChoice", file: "data/editorsChoiceAlbums.json", strategy: "editorsChoice" },
  { name: "artistGenre", file: "data/artistTop10.json", strategy: "artistGenre" },
  { name: "spotifyTotmPlaylists", file: "data/spotifyPlaylists.json", strategy: "spotifyPlaylist" }
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
      return {
        artist: a.Artist,
        group: a.Group,
        artistPercentage: a.AddedAlbums.length / totalAlbums,
        groupPercentage: groupStats[a.Group].added / groupStats[a.Group].albums,
        totalAlbums,
        nextAlbum: a.Albums[0]
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

//* ─── ROCK HALL OF FAME STRATEGY ───────────────────────────────────

async function processRockHallArtist(artistName) {
  console.log(`🎵 Processing: ${artistName}`);
  const spotify = getSpotify();

  try {
    const artistResults = await spotify.searchArtists(artistName, { limit: 5 });
    const artists = artistResults.body.artists.items;
    if (artists.length === 0) {
      console.log(`⚠️ Artist not found: ${artistName}`);
      return { success: false, reason: "ARTIST NOT FOUND", trackUris: [] };
    }

    const artist = artists[0];
    console.log(`✅ Found artist: "${artist.name}" (ID: ${artist.id})`);

    const { body: { tracks: topTracks } } = await spotify.getArtistTopTracks(artist.id, 'US');
    if (topTracks.length === 0) {
      console.log(`⚠️ No tracks found for ${artistName}`);
      return { success: false, reason: "NO TRACKS", trackUris: [] };
    }

    const trackUris = topTracks.slice(0, 10).map(t => t.uri);
    console.log(`   Found ${topTracks.length} top tracks, adding ${trackUris.length}:`);
    topTracks.slice(0, 10).forEach((t, i) =>
      console.log(`   ${i + 1}. "${t.name}" (popularity: ${t.popularity})`)
    );

    return { success: true, trackUris, trackCount: trackUris.length };

  } catch (error) {
    console.error(`❌ Error:`, error.message);
    return { success: false, reason: "ERROR", trackUris: [], error: error.message };
  }
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

async function handleRockHall(source, data) {
  if (!data.artists?.length) {
    console.log(`🎉 No more artists in ${source.name}`);
    return null;
  }

  const randomIndex = Math.floor(Math.random() * data.artists.length);
  const artistName = data.artists[randomIndex];
  console.log(`Artist: ${artistName} - ${randomIndex}`);

  const result = await processRockHallArtist(artistName);

  // Always remove from queue
  data.artists.shift();
  if (!result.success) {
    data.added.push(`${artistName} [${result.reason}]`);
    saveData(source.file, data);
    return false;
  }

  if (await wouldExceedLimit(result.trackCount)) return false;

  await addTracks(process.env.TARGET_PLAYLIST_ID, result.trackUris);
  console.log(`🎶 Added ${result.trackCount} tracks to playlist`);

  data.added.push(artistName);
  pushHistory({
    action: "addRockHall",
    artist: artistName,
    index: randomIndex,
    tracksAdded: result.trackCount,
    sourceFile: source.file,
    strategy: source.strategy
  });
  saveData(source.file, data);
  console.log(`✅ Completed: ${artistName}`);
  return true;
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
      const entry = data.find(a => a.Artist === pick.artist);
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
    const entry = data.find(a => a.Artist === pick.artist);
    entry.Albums.shift();
    entry.AddedAlbums.push(pick.nextAlbum);
  }

  pushHistory({
    action: "add",
    artist: pick.artist,
    album: pick.nextAlbum,
    index: pick.index ?? null,
    sourceFile: source.file,
    strategy: source.strategy
  });
  saveData(source.file, data);
  console.log(`✅ Album added successfully`);
  return true;
}

//* ─── SPOTIFY PLAYLIST STRATEGY ───────────────────────────────────

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
  else if (source.strategy === "artistGenre") result = await handleArtistGenre(source, wouldExceedLimit, pushHistory, saveData);
  else if (source.strategy === "spotifyPlaylist") result = await handleSpotifyPlaylist(source, data);
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
    }
  }

  console.log(`\n🎉 Fill complete! Added ${addCount} item(s) total.`);
  console.log("🛑 Stopping: Playlist appears to be full (multiple items won't fit)");

  const trackCount = await getPlaylistTrackCount();
  console.log(`📊 Final playlist size: ${trackCount}/${MAX_PLAYLIST_SIZE} tracks`);
}