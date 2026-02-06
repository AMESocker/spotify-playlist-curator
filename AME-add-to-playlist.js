import fs from "fs";
import fetch from "node-fetch";
import 'dotenv/config';


console.log("📝 Adding tracks to Spotify playlist...");

const DATA_PATH = "data/editorsChoiceAlbums.json";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const PLAYLIST_ID = process.env.TARGET_PLAYLIST_ID;

const MAX_TRACKS_PER_REQUEST = 100; // Spotify API limit

/**
 * Get Spotify access token using refresh token
 */
async function getSpotifyAccessToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
    throw new Error(
      "Missing Spotify credentials. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN environment variables."
    );
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
      ).toString("base64")}`,
    },
    body: `grant_type=refresh_token&refresh_token=${SPOTIFY_REFRESH_TOKEN}`,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Add tracks to a Spotify playlist
 */
async function addTracksToPlaylist(accessToken, playlistId, trackUris) {
  if (trackUris.length === 0) {
    console.log("ℹ️  No tracks to add");
    return true;
  }

  // Split into batches of 100 (Spotify API limit)
  const batches = [];
  for (let i = 0; i < trackUris.length; i += MAX_TRACKS_PER_REQUEST) {
    batches.push(trackUris.slice(i, i + MAX_TRACKS_PER_REQUEST));
  }

  console.log(`📦 Adding ${trackUris.length} track(s) in ${batches.length} batch(es)...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`   Batch ${i + 1}/${batches.length}: ${batch.length} tracks`);

    const response = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uris: batch,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`   ❌ Failed to add batch: ${response.statusText} - ${errorText}`);
      return false;
    }

    console.log(`   ✅ Batch ${i + 1} added successfully`);
  }

  return true;
}

/**
 * Process pending weeks and add to playlist
 */
async function processWeeks(weeksToProcess = null) {
  // Load existing data
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`❌ Data file not found: ${DATA_PATH}`);
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (err) {
    console.error("❌ Error parsing JSON:", err.message);
    return;
  }

  if (!data.weeklyAlbums || data.weeklyAlbums.length === 0) {
    console.log("✅ No pending weeks to process!");
    return;
  }

  // Validate playlist ID
  if (!PLAYLIST_ID) {
    console.error("❌ SPOTIFY_PLAYLIST_ID environment variable not set");
    return;
  }

  console.log(`📊 Found ${data.weeklyAlbums.length} weekly album(s)`);

  // Get Spotify access token
  let accessToken;
  try {
    accessToken = await getSpotifyAccessToken();
    console.log("🔑 Spotify access token obtained\n");
  } catch (error) {
    console.error("❌ Failed to get Spotify access token:", error.message);
    console.log("\n💡 To get a refresh token:");
    console.log("   1. Go to https://developer.spotify.com/console/post-playlist-tracks/");
    console.log("   2. Click 'Get Token' and authorize");
    console.log("   3. Use that token to get a refresh token");
    return;
  }

  // Determine which weeks to process
  let weeksToAdd = data.weeklyAlbums;
  if (weeksToProcess !== null) {
    weeksToAdd = data.weeklyAlbums.slice(0, weeksToProcess);
    console.log(`📌 Processing only the ${weeksToProcess} most recent week(s)\n`);
  }

  const processedWeeks = [];
  let totalTracksAdded = 0;
  let totalTracksSkipped = 0;

  for (const week of weeksToAdd) {
    console.log(`\n📅 Processing week: ${week.date}`);

    // Collect track URIs from this week
    const trackUris = [];
    const trackDetails = [];

    for (const album of week.albums) {
      if (album.spotifyTrack && album.spotifyTrack.uri && !album.spotifyTrack.error) {
        trackUris.push(album.spotifyTrack.uri);
        trackDetails.push({
          artist: album.artist,
          album: album.title,
          track: album.spotifyTrack.name,
        });
      } else {
        console.log(`   ⏭️  Skipping "${album.title}" by ${album.artist} - no track data`);
        totalTracksSkipped++;
      }
    }

    if (trackUris.length === 0) {
      console.log(`   ⚠️  No tracks to add for this week`);
      continue;
    }

    console.log(`   🎵 Found ${trackUris.length} track(s) to add:`);
    trackDetails.forEach((t) => {
      console.log(`      • ${t.artist} - ${t.track}`);
    });

    // Add tracks to playlist
    const success = await addTracksToPlaylist(accessToken, PLAYLIST_ID, trackUris);

    if (success) {
      totalTracksAdded += trackUris.length;
      
      // Mark week with playlist metadata
      week.addedToPlaylist = new Date().toISOString();
      week.playlistId = PLAYLIST_ID;
      
      processedWeeks.push(week);
      console.log(`   ✅ Week ${week.date} processed successfully`);
    } else {
      console.log(`   ❌ Failed to add tracks for week ${week.date}`);
    }
  }

  // Move processed weeks to addedWeeks
  if (processedWeeks.length > 0) {
    // Remove processed weeks from weeklyAlbums
    data.weeklyAlbums = data.weeklyAlbums.filter(
      (week) => !processedWeeks.find((pw) => pw.date === week.date)
    );

    // Add to addedWeeks (keep sorted)
    data.addedWeeks = [...processedWeeks, ...data.addedWeeks].sort((a, b) =>
      b.date.localeCompare(a.date)
    );

    // Save updated data
    try {
      fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
      console.log(`\n✅ Database updated successfully!`);
      console.log(`\n📊 Summary:`);
      console.log(`   - Weeks processed: ${processedWeeks.length}`);
      console.log(`   - Tracks added to playlist: ${totalTracksAdded}`);
      console.log(`   - Tracks skipped: ${totalTracksSkipped}`);
      console.log(`   - Remaining pending weeks: ${data.weeklyAlbums.length}`);
      console.log(`   - Total added weeks: ${data.addedWeeks.length}`);
    } catch (err) {
      console.error("❌ Error saving JSON:", err.message);
    }
  } else {
    console.log(`\n⚠️  No weeks were successfully processed`);
  }
}

// Get number of weeks to process from command line args
const weeksArg = process.argv[2];
let weeksToProcess = 1; // Default: process only 1 week

if (weeksArg) {
  if (weeksArg === "all") {
    weeksToProcess = null; // Process all pending weeks
  } else {
    const parsed = parseInt(weeksArg, 10);
    if (isNaN(parsed)) {
      console.error("❌ Invalid argument. Usage: node add-to-playlist.js [number_of_weeks|all]");
      console.log("   Example: node add-to-playlist.js       (process 1 week - default)");
      console.log("   Example: node add-to-playlist.js 3     (process 3 most recent weeks)");
      console.log("   Example: node add-to-playlist.js all   (process all pending weeks)");
      process.exit(1);
    }
    weeksToProcess = parsed;
  }
}

processWeeks(weeksToProcess).catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
