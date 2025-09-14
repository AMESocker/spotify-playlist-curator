// File: albumInfo.js
import { getSpotify } from "./auth.js";
import { logInfo, logError } from "./logger.js";

export async function getAlbumTrackCount(artist, albumName) {
  const spotify = getSpotify();

  try {
    // Ensure access token is fresh
    const tokenData = await spotify.refreshAccessToken();
    spotify.setAccessToken(tokenData.body['access_token']);

    // Search album by name + artist
    const searchRes = await spotify.searchAlbums(`${albumName} artist:${artist}`, { limit: 1 });

    if (!searchRes.body.albums.items.length) {
      logError(`No album found for "${albumName}" by ${artist}`);
      return null;
    }

    const album = searchRes.body.albums.items[0];
    const albumId = album.id;

    // Fetch album details
    const albumRes = await spotify.getAlbum(albumId);

    return {
      id: albumRes.body.id,
      name: albumRes.body.name,
      release: albumRes.body.release_date,
      totalTracks: albumRes.body.total_tracks,
      url: albumRes.body.external_urls.spotify
    };
  } catch (err) {
    logError("Error fetching album track count", err);
    return null;
  }
}
