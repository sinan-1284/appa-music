// YouTube Data API v3. A search costs 100 of the free 10,000 daily quota units, while
// video/channel/playlist lookups cost 1, so results are cached in localStorage.
const BASE = 'https://www.googleapis.com/youtube/v3';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const CACHE_PREFIX = 'sw_cache:';
const CACHE_MAX = 80;

let apiKey = '';
export const setKey = key => (apiKey = key);

export class YtError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

function friendlyMessage(reason, fallback) {
  switch (reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      return "Today's YouTube search quota is used up. It resets at midnight Pacific time; your library and earlier searches still work.";
    case 'keyInvalid':
    case 'API_KEY_INVALID':
      return "That YouTube API key isn't valid.";
    case 'accessNotConfigured':
    case 'SERVICE_DISABLED':
      return 'YouTube Data API v3 is not enabled for this key\'s Google Cloud project.';
    case 'ipRefererBlocked':
    case 'API_KEY_HTTP_REFERRER_BLOCKED':
      return `This API key's restrictions block this site. Allow ${location.origin}/* as a website referrer.`;
    default:
      return fallback || 'YouTube request failed.';
  }
}

function cacheGet(key) {
  try {
    const hit = JSON.parse(localStorage.getItem(key));
    if (hit && hit.expires > Date.now()) return hit.data;
  } catch {}
  return null;
}

function cacheSet(key, data, ttl) {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
    if (keys.length >= CACHE_MAX) {
      keys.map(k => [k, JSON.parse(localStorage.getItem(k))?.expires ?? 0])
        .sort((a, b) => a[1] - b[1])
        .slice(0, keys.length - CACHE_MAX + 1)
        .forEach(([k]) => localStorage.removeItem(k));
    }
    localStorage.setItem(key, JSON.stringify({ expires: Date.now() + ttl, data }));
  } catch {}
}

async function call(path, params, ttl = 0) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const cacheKey = CACHE_PREFIX + path + url.search;
  if (ttl) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }
  url.searchParams.set('key', apiKey);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || {};
    const reason = err.errors?.[0]?.reason || err.details?.find(d => d.reason)?.reason;
    throw new YtError(friendlyMessage(reason, err.message), reason);
  }
  if (ttl) cacheSet(cacheKey, data, ttl);
  return data;
}

/* ---------- Turning videos into songs ---------- */

const decode = s => new DOMParser().parseFromString(s || '', 'text/html').documentElement.textContent;

// Bracketed noise like "(Official Music Video)" or "[Lyrics]".
const NOISE = /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|4k|mv|m\/v|remaster(ed)?|explicit|clean)\b[^)\]]*[)\]]/gi;

const cleanChannel = c => c.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();

export function parseTitle(rawTitle, rawChannel) {
  const channel = cleanChannel(decode(rawChannel));
  const title = decode(rawTitle).replace(NOISE, '').replace(/\s+\|\s+.*$/, '').trim();
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].replace(/^["“']+|["”']+$/g, '').trim() };
  return { artist: channel, title };
}

function seconds(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// "medium" is a 16:9 image; "high" is 4:3 with black bars baked in.
const bestThumb = t => (t?.medium || t?.high || t?.default)?.url || '';

function toTrack(v) {
  const { title, artist } = parseTitle(v.snippet.title, v.snippet.channelTitle);
  return {
    id: v.id,
    title,
    artist,
    channel: cleanChannel(decode(v.snippet.channelTitle)),
    channelId: v.snippet.channelId,
    topic: /-\s*Topic$/i.test(v.snippet.channelTitle),
    thumb: bestThumb(v.snippet.thumbnails),
    duration: seconds(v.contentDetails?.duration),
  };
}

const playable = v => v?.snippet && v.snippet.liveBroadcastContent !== 'live' && v.status?.embeddable !== false;

// Full details for up to 50 ids per request; keeps the given order.
export async function videos(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await call('/videos', { part: 'snippet,contentDetails,status', id: chunk.join(','), maxResults: 50 }, DAY);
    const byId = new Map(r.items.map(v => [v.id, v]));
    out.push(...chunk.map(id => byId.get(id)).filter(playable).map(toTrack));
  }
  return out;
}

/* ---------- Endpoints ---------- */

export async function searchSongs(q, pageToken) {
  const r = await call('/search', {
    part: 'snippet', q, type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', videoSyndicated: 'true',
    maxResults: 20, pageToken,
  }, DAY);
  const tracks = await videos(r.items.map(i => i.id?.videoId).filter(Boolean));
  return { tracks, next: r.nextPageToken || null };
}

const words = s => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);

// Other uploads of the same song that may allow embedding, best first: the label's
// auto-generated "Artist - Topic" audio, then anything with a matching title and similar length.
export async function findAlternatives(track) {
  const r = await call('/search', {
    part: 'snippet', q: `${track.artist} ${track.title}`, type: 'video',
    videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: 10,
  }, DAY);
  const ids = r.items.map(i => i.id?.videoId).filter(id => id && id !== track.id);
  const wanted = words(track.title);
  const matches = t => {
    const have = new Set(words(`${t.title} ${t.artist}`));
    return wanted.length && wanted.filter(w => have.has(w)).length / wanted.length >= 0.7;
  };
  const near = t => !track.duration || Math.abs(t.duration - track.duration) <= 30;
  const score = t => (t.topic ? 4 : 0) + (near(t) ? 2 : 0);
  return (await videos(ids))
    .filter(matches)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 3);
}

export async function trending(regionCode) {
  const params = { part: 'snippet,contentDetails,status', chart: 'mostPopular', videoCategoryId: '10', maxResults: 24 };
  let r;
  try {
    r = await call('/videos', { ...params, regionCode }, 3 * HOUR);
  } catch (e) {
    if (e.reason === 'quotaExceeded' || regionCode === 'US') throw e;
    r = await call('/videos', { ...params, regionCode: 'US' }, 3 * HOUR);
  }
  return r.items.filter(playable).map(toTrack);
}

export async function channel(id) {
  const r = await call('/channels', { part: 'snippet,statistics,contentDetails', id }, DAY);
  const c = r.items?.[0];
  if (!c) throw new YtError('Channel not found.');
  return {
    id: c.id,
    name: cleanChannel(decode(c.snippet.title)),
    thumb: bestThumb(c.snippet.thumbnails),
    subscribers: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount),
    uploads: c.contentDetails?.relatedPlaylists?.uploads,
  };
}

export async function playlistPage(playlistId, pageToken) {
  const r = await call('/playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, pageToken }, 6 * HOUR);
  const tracks = await videos(r.items.map(i => i.contentDetails?.videoId).filter(Boolean));
  return { tracks, next: r.nextPageToken || null, total: r.pageInfo?.totalResults };
}

export async function playlistInfo(playlistId) {
  const r = await call('/playlists', { part: 'snippet', id: playlistId }, 6 * HOUR);
  const p = r.items?.[0];
  if (!p) throw new YtError("That YouTube playlist wasn't found, or it's private.");
  return { id: p.id, name: decode(p.snippet.title) };
}

