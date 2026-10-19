// Your library (liked songs, playlists, history) lives in this browser's localStorage.
const KEY = 'sw_library';
const MAX_RECENT = 50;

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.liked) && Array.isArray(d.playlists)) return { recent: [], searches: [], blocked: {}, alts: {}, ...d };
  } catch {}
  return { liked: [], playlists: [], recent: [], searches: [], blocked: {}, alts: {} };
}

const data = load();
const listeners = new Set();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked: keep working in memory for this session.
  }
  listeners.forEach(fn => fn());
}

// Only the fields needed to show and play a song are stored.
const slim = ({ id, title, artist, channel, channelId, thumb, duration }) => ({ id, title, artist, channel, channelId, thumb, duration });
const newId = () => Math.random().toString(36).slice(2, 10);

export const onChange = fn => listeners.add(fn);

export const liked = () => data.liked;
export const isLiked = id => data.liked.some(t => t.id === id);

export function toggleLike(track) {
  const i = data.liked.findIndex(t => t.id === track.id);
  if (i >= 0) data.liked.splice(i, 1);
  else data.liked.unshift(slim(track));
  save();
  return i < 0;
}

export const playlists = () => data.playlists;
export const playlist = id => data.playlists.find(p => p.id === id);

export function createPlaylist(name, tracks = [], source = null) {
  const p = { id: newId(), name, tracks: tracks.map(slim), source, created: Date.now() };
  data.playlists.unshift(p);
  save();
  return p;
}

export function renamePlaylist(id, name) {
  const p = playlist(id);
  if (p) { p.name = name; save(); }
}

export function deletePlaylist(id) {
  data.playlists = data.playlists.filter(p => p.id !== id);
  save();
}

export function addToPlaylist(id, track) {
  const p = playlist(id);
  if (!p || p.tracks.some(t => t.id === track.id)) return false;
  p.tracks.push(slim(track));
  save();
  return true;
}

export function removeFromPlaylist(id, index) {
  const p = playlist(id);
  if (p) { p.tracks.splice(index, 1); save(); }
}

export const recent = () => data.recent;

export function addRecent(track) {
  data.recent = [slim(track), ...data.recent.filter(t => t.id !== track.id)].slice(0, MAX_RECENT);
  save();
}

export const searches = () => data.searches;

export function addSearch(q) {
  data.searches = [q, ...data.searches.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  save();
}

// Videos whose owners block playback outside YouTube, and the versions that played instead.
export const isBlocked = id => !!data.blocked[id];
export const alternativeFor = id => data.alts[id] ?? null;

export function markBlocked(id) {
  if (data.blocked[id]) return;
  data.blocked[id] = true;
  save();
}

export function saveAlternative(origId, track) {
  data.alts[origId] = slim(track);
  save();
}
