// File: allMusicIntegration.js
// Integration module for AllMusic Editors' Choice functionality

import fs from "fs";
import { getSpotify } from "./auth.js";
import { addTracks } from "./playlist.js";

const DATA_PATH = "data/editorsChoiceAlbums.json";

/**
 * Get status of AllMusic Editors' Choice pending weeks
 */
export function getEditorsChoiceStatus() {
  if (!fs.existsSync(DATA_PATH)) {
    return { available: false, pendingWeeks: 0, nextWeek: null };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (err) {
    console.error("❌ Error parsing Editors' Choice JSON:", err.message);
    return { available: false, pendingWeeks: 0, nextWeek: null };
  }

  if (!data.weeklyAlbums || data.weeklyAlbums.length === 0) {
    return { available: false, pendingWeeks: 0, nextWeek: null };
  }

  const nextWeek = data.weeklyAlbums[0];
  const enrichedAlbums = nextWeek.albums.filter(
    album => album.spotifyTrack && album.spotifyTrack.uri && !album.spotifyTrack.error
  ).length;

  return {
    available: true, pendingWeeks: data.weeklyAlbums.length,
    nextWeek: { date: nextWeek.date, totalAlbums: nextWeek.albums.length, enrichedAlbums: enrichedAlbums }
  };
}

/**
 * Process one week of AllMusic Editors' Choice albums
 * Returns result object with success status and details
 */
export async function processEditorsChoiceWeek() {
  // Load data
  if (!fs.existsSync(DATA_PATH)) {
    return {      success: false,      reason: "DATA FILE NOT FOUND"    };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (err) {
    return {      success: false,      reason: "JSON PARSE ERROR",      error: err.message    };
  }

  if (!data.weeklyAlbums || data.weeklyAlbums.length === 0) {
    return {      success: false,      reason: "NO PENDING WEEKS"    };
  }

  //^ Process the first week in the list
  const week = data.weeklyAlbums[0];
  console.log(`\n📅 Processing AllMusic Editors' Choice week: ${week.date}`);

  // Collect track URIs from this week
  const trackUris = [];
  const trackDetails = [];
  let skippedCount = 0;

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
      skippedCount++;
    }
  }

  if (trackUris.length === 0) {
    // Still mark as processed even if no tracks
    data.weeklyAlbums.shift();
    week.addedToPlaylist = new Date().toISOString();
    week.playlistId = process.env.TARGET_PLAYLIST_ID || "UNKNOWN";

    if (!data.addedWeeks) {
      data.addedWeeks = [];
    }
    data.addedWeeks.unshift(week);

    try {
      fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      return {
        success: false,
        reason: "SAVE ERROR",
        error: err.message
      };
    }

    return {
      success: false,
      reason: "NO TRACKS AVAILABLE",
      weekDate: week.date,
      tracksAdded: 0,
      tracksSkipped: skippedCount
    };
  }

  console.log(`   🎵 Found ${trackUris.length} track(s) to add:`);
  trackDetails.forEach((t) => {
    console.log(`      • ${t.artist} - ${t.track}`);
  });

  try {
    // Add tracks to playlist using curator's addTracks function
    const targetPlaylistId = process.env.TARGET_PLAYLIST_ID;
    await addTracks(targetPlaylistId, trackUris);
    await addTracks(process.env.ALLMUSIC_EDITORS_CHOICE_PLAYLIST_ID, trackUris);
    console.log(`   ✅ Added ${trackUris.length} tracks to playlist`);

    // Mark week as processed
    data.weeklyAlbums.shift();
    week.addedToPlaylist = new Date().toISOString();
    week.playlistId = targetPlaylistId;

    // Add to addedWeeks
    if (!data.addedWeeks) {
      data.addedWeeks = [];
    }
    data.addedWeeks.unshift(week);

    // Save updated data
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

    return {
      success: true,
      weekDate: week.date,
      tracksAdded: trackUris.length,
      tracksSkipped: skippedCount
    };

  } catch (error) {
    console.error(`   ❌ Error adding tracks:`, error.message);
    return {
      success: false,
      reason: "PLAYLIST ADD ERROR",
      error: error.message,
      weekDate: week.date
    };
  }
}

/**
 * Standalone function to process multiple weeks
 * (for use outside of curator.js workflow if needed)
 */
export async function processMultipleWeeks(weeksToProcess = 1) {
  let processedCount = 0;
  let totalTracksAdded = 0;
  let totalTracksSkipped = 0;

  for (let i = 0; i < weeksToProcess; i++) {
    const status = getEditorsChoiceStatus();
    if (!status.available || status.pendingWeeks === 0) {
      console.log(`✅ No more weeks to process (processed ${processedCount} weeks)`);
      break;
    }

    const result = await processEditorsChoiceWeek();
    if (result.success) {
      processedCount++;
      totalTracksAdded += result.tracksAdded;
      totalTracksSkipped += result.tracksSkipped;
      console.log(`✅ Week ${result.weekDate} processed successfully\n`);
    } else if (result.reason === "NO TRACKS AVAILABLE") {
      processedCount++;
      totalTracksSkipped += result.tracksSkipped;
      console.log(`⚠️  Week ${result.weekDate} had no tracks to add\n`);
    } else {
      console.log(`❌ Failed to process week: ${result.reason}\n`);
      break;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   - Weeks processed: ${processedCount}`);
  console.log(`   - Tracks added: ${totalTracksAdded}`);
  console.log(`   - Tracks skipped: ${totalTracksSkipped}`);

  return {
    processedCount,
    totalTracksAdded,
    totalTracksSkipped
  };
}
