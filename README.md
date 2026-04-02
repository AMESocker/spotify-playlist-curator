# Spotify Playlist Curator

Automatically refreshes a Spotify playlist by removing recently played tracks and adding new ones based on listening patterns and artist diversity.

---
## 🚀 Features
- Removes tracks played within the last 24 hours
- Adds new tracks from curated artist sources
- Prioritizes underrepresented artists and genres
- Runs automatically via GitHub Actions

## 🧩 Why I Built This
I wanted a playlist that didn’t become repetitive. Manually curating music took too long, so I built a system that keeps playlists fresh automatically.

## 🛠 Tech Stack
- Node.js
- Spotify Web API
- GitHub Actions (automation)
- JSON data processing

## 🤖 Use of AI
I used generative AI to accelerate development, particularly for:
- Setting up GitHub Actions workflows
- Structuring authentication flows
- Parsing and organizing JSON data

## 🔮 Future Improvements
- Web UI for user customization
- Multiple playlist sources
- Dashboard for tracking added tracks

---

## ✨ What It Does

- **Curates a target playlist** by pulling from 7+ music sources on a rotating schedule
- **Removes recently played tracks** to keep the playlist fresh
- **Archives played tracks** to dedicated archive playlists for future reference
- **Tracks progress** across all sources in `history.json`, committed back to the repo after each run
- **Dashboard** available at [amps-200.vercel.app](https://amps-200.vercel.app) showing recent additions and source breakdown

---

## 🎵 Music Sources

Each run selects the next source in rotation and adds content from it:

| Source | Strategy | Description |
|--------|----------|-------------|
| `artistDisc.json` | Fairness | Artist discographies grouped by genre, selected using a fairness algorithm to balance groups |
| `1080albums.json` | Sequential (random) | 1080 essential albums, randomly selected |
| `rockNRollHallofFame.json` | Rock Hall | 2 artists per run, 5 randomly selected top tracks each |
| `editorsChoiceAlbums.json` | Editors Choice | Weekly staff picks scraped from AllMusic |
| `artistTop10.json` | Artist Genre | Top artists by genre, adds their top 10 tracks |
| `spotifyPlaylists.json` | Spotify Playlist | Personal monthly playlists (iTunes history 2005–2019) |
| `glastonbury25.json` | Glastonbury | 2 artists per run, 5 randomly selected top tracks each |

---

## 🏗️ Project Structure

```
.
├── curator.js              # Core curation logic and source strategies
├── index.js                # Entry point
├── playlist.js             # Spotify playlist operations (add, remove, fetch)
├── playlistChecker.js      # Checks playlist sizes
├── auth.js                 # Spotify authentication and token refresh
├── allMusicIntegration.js  # AllMusic editors choice scraper
├── artistGenreStrategy.js  # Artist genre top tracks strategy
├── albumInfo.js            # Album track count lookup (Spotify + MusicBrainz)
├── archive.js              # Moves played tracks to archive playlists
├── config.js               # Playlist configuration
├── utils.js                # Retry logic and shared utilities
├── logger.js               # Logging utility
├── history.json            # Full run history (auto-updated by GitHub Actions)
├── index.html              # Dashboard
└── data/
    ├── artistDisc.json
    ├── 1080albums.json
    ├── rockNRollHallofFame.json
    ├── editorsChoiceAlbums.json
    ├── artistTop10.json
    ├── spotifyPlaylists.json
    ├── glastonbury25.json
    └── sourceIndex.json    # Tracks current position in source rotation
```

---

## ⚙️ How It Works

### Curation
1. Reads `sourceIndex.json` to determine which source is next
2. Authenticates with Spotify via refresh token
3. Checks if the playlist has room (200 track limit)
4. Runs the appropriate strategy for the selected source
5. Adds tracks to the target playlist
6. Updates the source's data file (marking items as added)
7. Appends to `history.json`
8. Advances to the next source

### Cleanup
1. Fetches recently played tracks from the last 24 hours
2. Identifies tracks in monitored playlists that have been played
3. Moves them to archive playlists
4. Removes them from the monitored playlists

### Fairness Algorithm (artistDisc)
Artists are grouped by genre. The algorithm selects the artist from the group with the lowest completion percentage, ensuring no genre dominates the playlist over time.

---

## 🔧 Setup

Note: This will install databases from current position. Future updates will include startup database files for each source to allow starting from the beginning if desired.

### 1. Clone the repository

```bash
git clone https://github.com/AMESocker/spotify-playlist-cleanup.git
cd spotify-playlist-cleanup
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up GitHub Secrets

Add the following secrets to your repository (Settings → Secrets → Actions):

| Secret | Description |
|--------|-------------|
| `SPOTIFY_CLIENT_ID` | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | Spotify app client secret |
| `SPOTIFY_REFRESH_TOKEN` | Long-lived refresh token |
| `TARGET_PLAYLIST_ID` | Playlist ID to add tracks to |
| `MONITORED_PLAYLISTS` | Comma-separated playlist IDs to monitor for cleanup |
| `ARCHIVE_PLAYLISTS` | Comma-separated archive playlist IDs |

### 4. Getting a Spotify Refresh Token

1. Create an app at [developer.spotify.com](https://developer.spotify.com/dashboard)
2. Set redirect URI to `http://localhost:8888/callback`
3. Run the auth flow once locally to get a refresh token
4. Add the token as a GitHub secret

---

## 🕐 Schedule

The workflow runs 5 times daily:

| Cron | PST |
|------|-----|
| `0 18 * * *` | 10:00 AM |
| `0 21 * * *` | 1:00 PM |
| `0 00 * * *` | 4:00 PM |
| `0 03 * * *` | 7:00 PM |
| `0 10 * * *` | 2:00 AM |

---

## 📊 Dashboard

The dashboard (`index.html`) reads `history.json` directly from the repo and displays:

- Recent additions with source and timestamp
- Source breakdown showing runs per source
- Per-source progress (added / remaining / not found) loaded from data files

---

## 📜 License

MIT License