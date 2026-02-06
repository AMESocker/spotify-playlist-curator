import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

console.log("📝 Running AllMusic Editors' Choice scraper...");

const BASE_URL = "https://www.allmusic.com/newreleases";
const OUTPUT_PATH = "data/editorsChoiceAlbums.json";
const MAX_WEEKS_BACK = 52; // Safety limit: don't go back more than 1 year
const DELAY_MS = 1000; // 1 second delay between requests

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse "January 23, 2026" → "20260123"
 */
function parseHeadlineDate(headlineText) {
  // Example: "Featured New Releases for January 23, 2026"
  const match = headlineText.match(/(\w+)\s+(\d+),\s+(\d{4})/);
  if (!match) return null;
  
  const [, monthName, day, year] = match;
  const months = {
    'January': '01', 'February': '02', 'March': '03', 'April': '04',
    'May': '05', 'June': '06', 'July': '07', 'August': '08',
    'September': '09', 'October': '10', 'November': '11', 'December': '12'
  };
  
  const month = months[monthName];
  if (!month) return null;
  
  const paddedDay = day.padStart(2, '0');
  return `${year}${month}${paddedDay}`;
}

/**
 * Format YYYYMMDD → YYYY-MM-DD
 */
function formatDateString(dateStr) {
  if (!dateStr || dateStr.length !== 8) return null;
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6)}`;
}

/**
 * Get the previous Friday (7 days back)
 */
function getPreviousFriday(dateStr) {
  const year = parseInt(dateStr.slice(0, 4));
  const month = parseInt(dateStr.slice(4, 6)) - 1;
  const day = parseInt(dateStr.slice(6));
  const current = new Date(year, month, day);
  
  // Go back exactly 7 days (to previous Friday)
  current.setDate(current.getDate() - 7);
  
  const yyyy = current.getFullYear();
  const mm = String(current.getMonth() + 1).padStart(2, "0");
  const dd = String(current.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Scrape data for a specific URL
 */
async function scrapeWeek(url) {
  console.log(`🔍 Fetching: ${url}`);
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      console.error(`❌ HTTP Error: ${response.status} for ${url}`);
      return { weekDate: null, formattedDate: null, albums: [] };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract the actual week date from the headline text
    const headline = $("#headline");
    const headlineText = headline.text().trim();
    
    const weekDate = parseHeadlineDate(headlineText);
    
    if (!weekDate) {
      console.warn(`⚠️ Could not parse date from headline: "${headlineText}"`);
      return { weekDate: null, formattedDate: null, albums: [] };
    }

    const formattedDate = formatDateString(weekDate);
    if (!formattedDate) {
      console.warn(`⚠️ Invalid date format: ${weekDate}`);
      return { weekDate: null, formattedDate: null, albums: [] };
    }

    const albums = [];
    const seenAlbums = new Set();

    // Process all newReleaseItem articles
    $("article.newReleaseItem").each((_, el) => {
      const title = $(el).find(".title a").text().trim();
      const artist = $(el).find(".artist a").text().trim();
      const isEditorsChoice = $(el).find(".edChoiceBanner").length > 0;
      const isFeatured = $(el).is(":first-child");

      if ((isFeatured || isEditorsChoice) && title && artist) {
        const albumKey = `${artist}|||${title}`;
        
        if (!seenAlbums.has(albumKey)) {
          seenAlbums.add(albumKey);
          albums.push({ title, artist });
        }
      }
    });

    console.log(`   Week: ${formattedDate} | Found ${albums.length} albums`);
    return { weekDate, formattedDate, albums };

  } catch (error) {
    console.error(`❌ Error scraping ${url}:`, error.message);
    return { weekDate: null, formattedDate: null, albums: [] };
  }
}

/**
 * Main logic — fetch current week, then go back Friday by Friday
 */
async function fetchEditorsChoice() {
  // Initialize data structure
  let data = {
    weeklyAlbums: [],  // Weeks that need to be added to Spotify
    addedWeeks: []     // Weeks that have been added to Spotify
  };

  // Load existing data
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      const fileContent = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
      
      // Handle migration from old format (flat object) to new format
      if (!fileContent.pendingWeeks && !fileContent.addedWeeks) {
        console.log("📦 Migrating from old format to new structure...");
        data.weeklyAlbums = Object.entries(fileContent).map(([date, albums]) => ({
          date,
          albums
        }));
        console.log(`   Migrated ${data.weeklyAlbums.length} weeks to pendingWeeks`);
      } else {
        data = fileContent;
      }
      
      console.log(`📂 Loaded existing data:`);
      console.log(`   - Pending weeks: ${data.weeklyAlbums.length}`);
      console.log(`   - Added weeks: ${data.addedWeeks.length}`);
    } catch (err) {
      console.error("❌ Error parsing existing JSON:", err.message);
      console.log("📝 Starting with empty dataset");
    }
  }

  // Create a Set of existing dates for quick lookup
  const existingDates = new Set([
    ...data.weeklyAlbums.map(w => w.date),
    ...data.addedWeeks.map(w => w.date)
  ]);

  // Start from the current new releases page
  let result = await scrapeWeek(BASE_URL);

  if (!result.weekDate || !result.formattedDate) {
    console.error("❌ Failed to get initial date. Exiting.");
    return;
  }

  // Track the current Friday we're checking (from headline text)
  let currentFriday = result.weekDate;
  let weeksBack = 0;
  const newWeeks = []; // Track new weeks to add

  // Process the current week first
  if (!existingDates.has(result.formattedDate)) {
    newWeeks.push({
      date: result.formattedDate,
      albums: result.albums
    });
    console.log(`✅ Queued ${result.formattedDate} for saving`);
  } else {
    console.log(`ℹ️  Data for ${result.formattedDate} already exists`);
  }

  // Now go back Friday by Friday
  while (weeksBack < MAX_WEEKS_BACK) {
    // Calculate previous Friday
    const previousFriday = getPreviousFriday(currentFriday);
    const previousFridayFormatted = formatDateString(previousFriday);
    
    // Check if we already have this week
    if (existingDates.has(previousFridayFormatted)) {
      console.log(`ℹ️  Data for ${previousFridayFormatted} already exists. Stopping.`);
      break;
    }

    console.log(`\n⏪ Going back to previous Friday: ${previousFridayFormatted}`);
    await sleep(DELAY_MS);

    weeksBack++;
    const prevUrl = `${BASE_URL}/${previousFriday}`;
    result = await scrapeWeek(prevUrl);

    if (!result.weekDate || !result.formattedDate) {
      console.log(`⚠️  No valid data found for ${previousFridayFormatted}. Stopping.`);
      break;
    }

    // Check if the site returned a different week than we requested
    if (result.weekDate !== previousFriday) {
      console.log(`   ⚠️  Site returned ${result.formattedDate} instead of ${previousFridayFormatted}`);
      console.log(`   This means we've reached the earliest available data.`);
      break;
    }

    // Add to our queue
    if (!existingDates.has(result.formattedDate)) {
      newWeeks.push({
        date: result.formattedDate,
        albums: result.albums
      });
      console.log(`✅ Queued ${result.formattedDate} for saving`);
    }

    // Update current Friday for next iteration
    currentFriday = previousFriday;
  }

  if (weeksBack >= MAX_WEEKS_BACK) {
    console.log(`\n⚠️  Reached maximum lookback limit (${MAX_WEEKS_BACK} weeks).`);
  }

  // Add all newly scraped weeks to pendingWeeks (sorted by date, newest first)
  if (newWeeks.length > 0) {
    data.weeklyAlbums = [...newWeeks, ...data.weeklyAlbums].sort((a, b) => 
      b.date.localeCompare(a.date)
    );

    // Ensure output directory exists
    const outputDir = OUTPUT_PATH.substring(0, OUTPUT_PATH.lastIndexOf('/'));
    if (outputDir && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    try {
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
      console.log(`\n✅ Successfully saved ${newWeeks.length} new week(s)`);
      console.log(`📊 Database summary:`);
      console.log(`   - Total pending weeks: ${data.weeklyAlbums.length}`);
      console.log(`   - Total added weeks: ${data.addedWeeks.length}`);
    } catch (err) {
      console.error("❌ Error saving JSON:", err.message);
    }
  } else {
    console.log(`\n✅ No new data to save. Database is up to date!`);
  }
}

fetchEditorsChoice().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});