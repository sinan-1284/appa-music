import { YOUTUBE_API_KEY as SHARED_KEY } from '../config.js';
import * as yt from './yt.js';
import * as player from './player.js';
import * as store from './store.js';
import { icon } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const main = $('#main');
// config.local.js is optional and git-ignored, so your own key never gets committed.
const { YOUTUBE_API_KEY: LOCAL_KEY = '' } = await import('../config.local.js').catch(() => ({}));
const CONFIG_KEY = LOCAL_KEY || SHARED_KEY;

const state = {
  lists: {},          // track lists rendered in the current view, by id
  listSeq: 0,
  nowId: null,        // video id of the current song
  nowReplaces: null,  // id of the blocked video it stands in for, if any
  nowKey: null,       // which list (e.g. "playlist:abc") the current song was started from
  seeking: false,
  lastVolume: 50,
  started: false,
};

/* ---------- Helpers ---------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const compact = n => new Intl.NumberFormat(undefined, { notation: 'compact' }).format(n);

function fmt(sec) {
  const s = Math.floor(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtLong(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
}

function hue(seed) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const artImg = (url, cls = '') => url
  ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy">`
  : `<div class="${cls} placeholder">${icon.note}</div>`;

const likedArt = cls => `<div class="${cls} liked-art">${icon.heartFill}</div>`;
const playlistArt = (p, cls = '') => artImg(p.tracks[0]?.thumb, cls);
const artistLink = t => t.channelId ? `<a href="#/channel/${esc(t.channelId)}">${esc(t.artist)}</a>` : esc(t.artist);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 4000);
}

const handleError = e => toast(e?.message || 'Something went wrong.');

/* ---------- Modal & menu ---------- */

function ask({ title, text = '', value = '', placeholder = '', ok = 'Save', input = true }) {
  const modal = $('#modal');
  const field = $('#modal-input');
  $('#modal-title').textContent = title;
  $('#modal-text').textContent = text;
  $('#modal-ok').textContent = ok;
  field.classList.toggle('hidden', !input);
  field.value = value;
  field.placeholder = placeholder;
  modal.classList.remove('hidden');
  (input ? field : $('#modal-ok')).focus();
  if (input) field.select();
  return new Promise(resolve => {
    const close = result => {
      modal.classList.add('hidden');
      $('#modal-form').onsubmit = $('#modal-cancel').onclick = modal.onclick = modal.onkeydown = null;
      resolve(result);
    };
    $('#modal-form').onsubmit = e => {
      e.preventDefault();
      if (!input) return close(true);
      if (field.value.trim()) close(field.value.trim());
    };
    $('#modal-cancel').onclick = () => close(input ? null : false);
    modal.onclick = e => { if (e.target === modal) close(input ? null : false); };
    modal.onkeydown = e => { if (e.key === 'Escape') close(input ? null : false); };
  });
}

let menuItems = [];

function showMenu(anchor, items) {
  const menu = $('#menu');
  menuItems = items;
  menu.innerHTML = items.map((it, i) => {
    if (it === 'sep') return '<hr>';
    if (it.heading) return `<div class="menu-label">${esc(it.heading)}</div>`;
    return `<button role="menuitem" data-menu-item="${i}">${it.icon ?? ''}<span>${esc(it.label)}</span></button>`;
  }).join('');
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  menu.querySelector('button')?.focus();
}

const hideMenu = () => $('#menu').classList.add('hidden');

function trackMenu(anchor, track, list, index) {
  const items = [
    { icon: icon.queue, label: 'Add to queue', action: () => { player.addToQueue(track); toast('Added to queue'); } },
    'sep',
    { heading: 'Add to playlist' },
    { icon: icon.plus, label: 'New playlist…', action: () => newPlaylist([track]) },
    ...store.playlists().map(p => ({
      icon: icon.library,
      label: p.name,
      action: () => toast(store.addToPlaylist(p.id, track) ? `Added to ${p.name}` : `Already in ${p.name}`),
    })),
  ];
  if (list?.playlistId) {
    items.push('sep', {
      icon: icon.trash, label: 'Remove from this playlist',
      action: () => { store.removeFromPlaylist(list.playlistId, index); route({ keepScroll: true }); },
    });
  }
  items.push('sep');
  if (track.channelId) {
    items.push({ icon: icon.note, label: `Go to ${track.channel}`, action: () => { location.hash = `#/channel/${track.channelId}`; } });
  }
  items.push({ icon: icon.forward, label: 'Open on YouTube', action: () => window.open(`https://www.youtube.com/watch?v=${track.id}`, '_blank', 'noopener') });
  showMenu(anchor, items);
}

async function newPlaylist(tracks = []) {
  const name = await ask({ title: 'Create playlist', value: `My Playlist #${store.playlists().length + 1}`, ok: 'Create' });
  if (!name) return;
  const p = store.createPlaylist(name, tracks);
  toast(tracks.length ? `Added to ${p.name}` : `Created ${p.name}`);
  if (!tracks.length) location.hash = `#/playlist/${p.id}`;
}

/* ---------- Building blocks ---------- */

function registerList(tracks, key, extra = {}) {
  const id = `l${++state.listSeq}`;
  state.lists[id] = { tracks, key, hasMore: false, loadMore: null, ...extra };
  return id;
}

const isNow = id => !!id && (id === state.nowId || id === state.nowReplaces);

function trackRow(t, i, listId) {
  const liked = store.isLiked(t.id);
  const blocked = store.isBlocked(t.id) && !store.alternativeFor(t.id);
  return `<div class="track-row${isNow(t.id) ? ' playing' : ''}${blocked ? ' blocked' : ''}" data-list="${listId}" data-index="${i}" data-id="${esc(t.id)}"${blocked ? ' title="This video only plays on YouTube. Another version will be tried."' : ''}>
    <span class="num"><span class="n">${i + 1}</span>${icon.play}</span>
    <div class="t-main">
      ${artImg(t.thumb, 'thumb')}
      <div class="t-text">
        <div class="t-name">${esc(t.title)}</div>
        <div class="t-artists">${artistLink(t)}</div>
      </div>
    </div>
    <div class="t-actions">
      <button class="icon-btn${liked ? ' liked' : ''}" data-like aria-label="${liked ? 'Remove from' : 'Save to'} Liked Songs">${liked ? icon.heartFill : icon.heart}</button>
      <button class="icon-btn" data-menu aria-label="More options for ${esc(t.title)}">${icon.more}</button>
    </div>
    <span class="t-dur">${t.duration ? fmt(t.duration) : ''}</span>
  </div>`;
}

function trackList(listId, empty = 'No songs here yet.') {
  const list = state.lists[listId];
  if (!list.tracks.length) return `<p class="notice">${empty}</p>`;
  return `<div class="tracks">
    <div class="track-head"><span>#</span><span>Title</span><span></span><span title="Duration">${icon.clock}</span></div>
    <div data-rows="${listId}">${list.tracks.map((t, i) => trackRow(t, i, listId)).join('')}</div>
  </div>${list.hasMore ? `<button class="more-btn" data-more="${listId}">Show more</button>` : ''}`;
}

function trackCards(listId) {
  return `<div class="cards">${state.lists[listId].tracks.map((t, i) => `
    <div class="card track-card" data-list="${listId}" data-index="${i}" role="button" tabindex="0">
      <div class="card-img">${artImg(t.thumb)}
        <button class="card-play" data-play-list="${listId}" data-index="${i}" aria-label="Play ${esc(t.title)}">${icon.play}</button>
      </div>
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-sub">${esc(t.artist)}</div>
    </div>`).join('')}</div>`;
}

function card({ href, art, title, sub = '', playKey }) {
  return `<div class="card" data-href="${href}" role="link" tabindex="0">
    <div class="card-img">${art}
      ${playKey ? `<button class="card-play" data-play-key="${esc(playKey)}" aria-label="Play ${esc(title)}">${icon.play}</button>` : ''}
    </div>
    <div class="card-title">${esc(title)}</div>
    <div class="card-sub">${esc(sub)}</div>
  </div>`;
}

const playlistCard = p => card({
  href: `#/playlist/${p.id}`, art: playlistArt(p), title: p.name,
  sub: `Playlist • ${plural(p.tracks.length, 'song')}`, playKey: p.tracks.length ? `playlist:${p.id}` : null,
});
const likedCard = () => card({
  href: '#/liked', art: likedArt(''), title: 'Liked Songs',
  sub: plural(store.liked().length, 'song'), playKey: store.liked().length ? 'liked' : null,
});

const section = (title, body, extra = '') =>
  `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${extra}</div>${body}</section>`;

function hero({ seed, type, title, art, meta = '', actions = '' }) {
  return `<div class="page-head" style="--c:hsl(${hue(seed)} 40% 32%)">
    <div class="hero">${art}
      <div class="hero-text">
        <span class="hero-type">${esc(type)}</span>
        <h1>${esc(title)}</h1>
        <div class="hero-meta">${meta}</div>
      </div>
    </div>
    <div class="actions">${actions}</div>
  </div>`;
}

const bigPlay = listId => `<button class="big-play" data-play-list="${listId}" data-index="0" data-big aria-label="Play">${icon.play}</button>`;

/* ---------- Views ---------- */

function region() {
  const r = (navigator.language || 'en-US').split('-')[1];
  return r && r.length === 2 ? r.toUpperCase() : 'US';
}

async function homeView() {
  const trending = await yt.trending(region()).catch(e => e);
  const h = new Date().getHours();
  const greeting = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const shortcut = ({ href, art, title, playKey }) => `<div class="shortcut" data-href="${href}" role="link" tabindex="0">
    ${art}<span class="ellipsis">${esc(title)}</span>
    ${playKey ? `<button class="card-play" data-play-key="${esc(playKey)}" aria-label="Play ${esc(title)}">${icon.play}</button>` : ''}
  </div>`;

  let html = `<h1 class="greeting">${greeting}</h1><div class="shortcuts">
    ${shortcut({ href: '#/liked', art: likedArt(''), title: 'Liked Songs', playKey: store.liked().length ? 'liked' : null })}
    ${store.playlists().slice(0, 7).map(p => shortcut({
      href: `#/playlist/${p.id}`, art: playlistArt(p), title: p.name, playKey: p.tracks.length ? `playlist:${p.id}` : null,
    })).join('')}
  </div>`;

  const recent = store.recent().slice(0, 10);
  if (recent.length) html += section('Recently played', trackList(registerList([...recent], 'recent')));
  if (Array.isArray(trending)) {
    if (trending.length) html += section('Trending music', trackCards(registerList(trending, 'trending')));
  } else {
    html += section('Trending music', `<p class="notice">${esc(trending.message)}</p>`);
  }
  return html;
}

async function searchView(q = '') {
  q = q.trim();
  if (!q) {
    const recent = store.searches();
    return `<div class="search-empty">${icon.search}
      <h2>Search for any song</h2>
      <p>Find songs, artists and music videos from YouTube.</p>
      ${recent.length ? `<div class="chips">${recent.map(r => `<a class="chip" href="#/search/${encodeURIComponent(r)}">${esc(r)}</a>`).join('')}</div>` : ''}
    </div>`;
  }
  const r = await yt.searchSongs(q);
  if (!r.tracks.length) {
    return `<div class="empty">No results found for “${esc(q)}”.<br><small>Check the spelling or try different words.</small></div>`;
  }
  store.addSearch(q);
  const listId = registerList(r.tracks, `search:${q}`);
  const list = state.lists[listId];
  let next = r.next;
  list.hasMore = !!next;
  list.loadMore = async () => {
    const more = await yt.searchSongs(q, next);
    next = more.next;
    list.hasMore = !!next;
    return more.tracks;
  };
  return section('Songs', trackList(listId))
    + '<p class="quota-note">Each new search uses YouTube API quota (about 100 searches a day on a free key). Repeat searches are cached.</p>';
}

async function channelView(id) {
  const c = await yt.channel(id);
  const page = c.uploads ? await yt.playlistPage(c.uploads) : { tracks: [], next: null };
  const listId = registerList(page.tracks, `channel:${id}`);
  const list = state.lists[listId];
  let next = page.next;
  list.hasMore = !!next;
  list.loadMore = async () => {
    const more = await yt.playlistPage(c.uploads, next);
    next = more.next;
    list.hasMore = !!next;
    return more.tracks;
  };
  return hero({
    seed: id, type: 'Artist', title: c.name, art: artImg(c.thumb, 'hero-art round'),
    meta: c.subscribers ? `${compact(c.subscribers)} subscribers` : '',
    actions: page.tracks.length ? bigPlay(listId) : '',
  }) + section('Latest uploads', trackList(listId, 'This channel has no playable videos.'));
}

function likedView() {
  const tracks = [...store.liked()];
  const listId = registerList(tracks, 'liked');
  const length = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  return hero({
    seed: 'liked', type: 'Playlist', title: 'Liked Songs', art: likedArt('hero-art'),
    meta: plural(tracks.length, 'song') + (length ? `, ${fmtLong(length)}` : ''),
    actions: tracks.length ? bigPlay(listId) : '',
  }) + trackList(listId, 'Songs you like will appear here. Tap the heart on any song to save it.');
}

function playlistView(id) {
  const p = store.playlist(id);
  if (!p) return '<div class="empty">This playlist no longer exists.</div>';
  const listId = registerList([...p.tracks], `playlist:${id}`, { playlistId: id });
  const length = p.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  return hero({
    seed: id, type: 'Playlist', title: p.name, art: playlistArt(p, 'hero-art'),
    meta: plural(p.tracks.length, 'song') + (length ? `, ${fmtLong(length)}` : ''),
    actions: (p.tracks.length ? bigPlay(listId) : '')
      + `<button class="icon-btn head-btn" data-rename="${id}" aria-label="Rename playlist" title="Rename">${icon.edit}</button>`
      + `<button class="icon-btn head-btn" data-delete="${id}" aria-label="Delete playlist" title="Delete">${icon.trash}</button>`,
  }) + trackList(listId, 'This playlist is empty. Search for a song, then use ••• → Add to playlist.');
}

function libraryView() {
  return section('Your Library',
    `<div class="cards">${likedCard()}${store.playlists().map(playlistCard).join('')}</div>`,
    `<button class="pill-btn" data-new-playlist>${'Create playlist'}</button>`)
    + section('Import a YouTube playlist', `
      <p class="notice">Paste a link to a public YouTube or YouTube Music playlist to copy it into your library.</p>
      <form class="import-form" id="import-form">
        <input id="import-url" placeholder="https://www.youtube.com/playlist?list=…" autocomplete="off" spellcheck="false">
        <button type="submit">Import</button>
      </form>`);
}

const routes = [
  [/^\/$/, homeView],
  [/^\/search(?:\/(.*))?$/, searchView],
  [/^\/channel\/([\w-]+)$/, channelView],
  [/^\/playlist\/(\w+)$/, playlistView],
  [/^\/liked$/, likedView],
  [/^\/library$/, libraryView],
];

let routeToken = 0;

async function route({ keepScroll = false } = {}) {
  const token = ++routeToken;
  const path = location.hash.slice(1) || '/';
  const isSearch = path.startsWith('/search');
  const scroll = main.scrollTop;
  hideMenu();
  updateNav(path);
  $('#search-box').classList.toggle('hidden', !isSearch);

  const match = routes.map(([re, fn]) => [path.match(re), fn]).find(([m]) => m);
  if (!match) {
    view.innerHTML = '<div class="empty">Page not found.</div>';
    return;
  }
  const [m, fn] = match;
  const args = m.slice(1).map(a => (a == null ? a : decodeURIComponent(a)));
  if (isSearch && document.activeElement !== $('#search-input')) $('#search-input').value = args[0] ?? '';
  if (!keepScroll && (!isSearch || !view.children.length)) view.innerHTML = '<div class="spinner"></div>';
  if (!keepScroll && !isSearch) main.scrollTop = 0;

  try {
    const html = await fn(...args);
    if (token !== routeToken) return;
    state.lists = Object.fromEntries(Object.entries(state.lists).filter(([id]) => html.includes(`"${id}"`)));
    view.innerHTML = html;
    if (keepScroll) main.scrollTop = scroll;
    highlightPlaying();
  } catch (e) {
    if (token !== routeToken) return;
    view.innerHTML = `<div class="empty">Couldn't load this page.<br><small>${esc(e.message)}</small></div>`;
  }
}

function updateNav(path) {
  const key = path === '/' ? 'home' : path.split('/')[1];
  $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.route === key));
  $$('.lib-item').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${path}`));
}

function renderSidebar() {
  const item = ({ href, art, name, sub }) => `<a class="lib-item" href="${href}" title="${esc(name)}">${art}
    <div class="lib-meta"><div class="lib-name">${esc(name)}</div><div class="lib-sub">${esc(sub)}</div></div></a>`;
  $('#lib-list').innerHTML = item({ href: '#/liked', art: likedArt('lib-art'), name: 'Liked Songs', sub: `Playlist • ${plural(store.liked().length, 'song')}` })
    + store.playlists().map(p => item({
      href: `#/playlist/${p.id}`, art: playlistArt(p, 'lib-art'), name: p.name, sub: `Playlist • ${plural(p.tracks.length, 'song')}`,
    })).join('');
  updateNav(location.hash.slice(1) || '/');
}

/* ---------- Playback ---------- */

function playFromList(listId, index, fromBigPlay = false) {
  const list = state.lists[listId];
  const track = list?.tracks[index];
  if (!track) return;
  const sameSong = isNow(track.id) && state.nowKey === list.key;
  if ((fromBigPlay && state.nowKey === list.key && state.nowId) || sameSong) return player.toggle();
  state.nowKey = list.key;
  player.playList(list.tracks, index);
}

function playKey(key) {
  if (state.nowKey === key && state.nowId) return player.toggle();
  const tracks = key === 'liked' ? store.liked() : store.playlist(key.slice('playlist:'.length))?.tracks;
  if (!tracks?.length) return;
  state.nowKey = key;
  player.playList(tracks, 0);
}

function onPlayerChange(s) {
  const t = s.track;
  if (t && t.id !== state.nowId) {
    state.nowId = t.id;
    state.nowReplaces = t.replaces ?? null;
    store.addRecent(t);
    renderNowPlaying(t);
  }
  $('#play-btn').innerHTML = s.playing ? icon.pause : icon.play;
  $('#play-btn').setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
  $('#shuffle-btn').classList.toggle('on', s.shuffle);
  $('#repeat-btn').classList.toggle('on', s.repeat !== 'off');
  $('#repeat-btn').innerHTML = s.repeat === 'one' ? icon.repeatOne : icon.repeat;
  $('#repeat-btn').setAttribute('aria-label', { off: 'Repeat', all: 'Repeat all', one: 'Repeat one' }[s.repeat]);
  document.title = t && s.playing ? `${t.title} • ${t.artist}` : 'Appa Music';
  renderUpNext();
  highlightPlaying(s.playing);
}

function renderNowPlaying(t) {
  $('#app').classList.add('has-np');
  $('#np-panel').classList.remove('hidden');
  $('#np-art').innerHTML = artImg(t.thumb);
  $('#np-title').textContent = t.title;
  $('#np-artist').innerHTML = artistLink(t);
  $('#np-big-title').textContent = t.title;
  $('#np-big-artist').innerHTML = artistLink(t);
  $('#like-btn').classList.remove('hidden');
  updateLikeButtons();
}

function renderUpNext() {
  const up = player.upcoming(20);
  $('#up-list').innerHTML = up.length
    ? up.map((t, i) => `<div class="up-item" data-up="${i + 1}" role="button" tabindex="0">
        ${artImg(t.thumb, 'thumb')}
        <div class="t-text"><div class="t-name">${esc(t.title)}</div><div class="t-artists">${esc(t.artist)}</div></div>
      </div>`).join('')
    : '<p class="up-empty">Nothing queued. Use ••• → Add to queue on any song.</p>';
}

function updateLikeButtons() {
  const on = !!state.nowId && store.isLiked(state.nowId);
  $$('[data-like-current]').forEach(btn => {
    btn.innerHTML = on ? icon.heartFill : icon.heart;
    btn.classList.toggle('liked', on);
    btn.setAttribute('aria-label', on ? 'Remove from Liked Songs' : 'Save to Liked Songs');
  });
}

function highlightPlaying(playing = player.snapshot().playing) {
  $$('.track-row').forEach(r => r.classList.toggle('playing', isNow(r.dataset.id)));
  $$('[data-big]').forEach(b => {
    const on = playing && state.lists[b.dataset.playList]?.key === state.nowKey;
    b.innerHTML = on ? icon.pause : icon.play;
  });
  $$('[data-play-key]').forEach(b => {
    b.innerHTML = playing && b.dataset.playKey === state.nowKey ? icon.pause : icon.play;
  });
}

function toggleLike(track) {
  const liked = store.toggleLike(track);
  toast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
  updateLikeButtons();
  if (location.hash === '#/liked') return route({ keepScroll: true });
  $$(`.track-row[data-id="${CSS.escape(track.id)}"] [data-like]`).forEach(btn => {
    btn.innerHTML = liked ? icon.heartFill : icon.heart;
    btn.classList.toggle('liked', liked);
  });
}

function setFill(range) {
  range.style.setProperty('--p', `${((range.value - range.min) / (range.max - range.min)) * 100}%`);
}

function tickProgress() {
  if (state.seeking) return;
  const seek = $('#seek');
  const { position, duration } = player.time();
  seek.value = duration ? (position / duration) * 1000 : 0;
  setFill(seek);
  $('#pos').textContent = fmt(position);
  $('#dur').textContent = fmt(duration);
}

function loadVolume() {
  try {
    const v = parseFloat(localStorage.getItem('sw_volume'));
    return Number.isFinite(v) ? Math.round(v <= 1 ? v * 100 : v) : 50;
  } catch { return 50; }
}

function applyVolume(v) {
  player.setVolume(v);
  $('#mute-btn').innerHTML = v === 0 ? icon.volumeOff : icon.volume;
  try { localStorage.setItem('sw_volume', v); } catch {}
}

function setupPlayerBar() {
  $('#shuffle-btn').innerHTML = icon.shuffle;
  $('#prev-btn').innerHTML = icon.prev;
  $('#play-btn').innerHTML = icon.play;
  $('#next-btn').innerHTML = icon.next;
  $('#repeat-btn').innerHTML = icon.repeat;
  updateLikeButtons();

  $('#play-btn').onclick = () => player.toggle() || toast('Pick a song to start listening.');
  $('#next-btn').onclick = () => player.next();
  $('#prev-btn').onclick = () => player.prev();
  $('#shuffle-btn').onclick = () => player.toggleShuffle();
  $('#repeat-btn').onclick = () => player.cycleRepeat();

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    state.seeking = true;
    setFill(seek);
    $('#pos').textContent = fmt((seek.value / 1000) * player.time().duration);
  });
  seek.addEventListener('change', () => {
    player.seek((seek.value / 1000) * player.time().duration);
    state.seeking = false;
  });

  const vol = $('#volume');
  vol.value = loadVolume();
  setFill(vol);
  $('#mute-btn').innerHTML = +vol.value === 0 ? icon.volumeOff : icon.volume;
  vol.addEventListener('input', () => {
    setFill(vol);
    applyVolume(+vol.value);
  });
  $('#mute-btn').onclick = () => {
    if (+vol.value > 0) {
      state.lastVolume = +vol.value;
      vol.value = 0;
    } else {
      vol.value = state.lastVolume || 50;
    }
    setFill(vol);
    applyVolume(+vol.value);
  };

  setInterval(tickProgress, 500);
}

/* ---------- Global UI ---------- */

async function importPlaylist(form) {
  const input = $('#import-url', form);
  const btn = $('button', form);
  const raw = input.value.trim();
  let id = raw;
  try { id = new URL(raw).searchParams.get('list') || raw; } catch {}
  if (!/^[\w-]{10,}$/.test(id)) return toast('Paste a YouTube playlist link (it contains "list=").');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const info = await yt.playlistInfo(id);
    const tracks = [];
    let next = null;
    do {
      const page = await yt.playlistPage(id, next);
      tracks.push(...page.tracks);
      next = page.next;
      btn.textContent = `Importing… ${tracks.length}`;
    } while (next && tracks.length < 500);
    const p = store.createPlaylist(info.name, tracks, id);
    toast(`Imported ${plural(tracks.length, 'song')}`);
    location.hash = `#/playlist/${p.id}`;
  } catch (e) {
    handleError(e);
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}

function rowContext(el) {
  const row = el.closest('[data-list][data-index]');
  const list = row && state.lists[row.dataset.list];
  return list ? { list, index: +row.dataset.index, track: list.tracks[+row.dataset.index] } : null;
}

function onClick(e) {
  const target = e.target;
  const menuItem = target.closest('[data-menu-item]');
  if (menuItem) {
    hideMenu();
    return menuItems[+menuItem.dataset.menuItem]?.action();
  }
  if (!target.closest('#menu')) hideMenu();

  const menuBtn = target.closest('[data-menu]');
  if (menuBtn) {
    const ctx = rowContext(menuBtn);
    return ctx && trackMenu(menuBtn, ctx.track, ctx.list, ctx.index);
  }
  if (target.closest('[data-like]')) {
    const ctx = rowContext(target);
    return ctx && toggleLike(ctx.track);
  }
  if (target.closest('[data-like-current]')) {
    const t = player.current();
    return t && toggleLike(t);
  }
  const listBtn = target.closest('[data-play-list]');
  if (listBtn) {
    e.stopPropagation();
    return playFromList(listBtn.dataset.playList, +listBtn.dataset.index || 0, listBtn.hasAttribute('data-big'));
  }
  const keyBtn = target.closest('[data-play-key]');
  if (keyBtn) return playKey(keyBtn.dataset.playKey);
  const up = target.closest('[data-up]');
  if (up) return player.jumpTo(+up.dataset.up);
  const more = target.closest('[data-more]');
  if (more) return loadMore(more);
  if (target.closest('[data-new-playlist]')) return newPlaylist();
  const rename = target.closest('[data-rename]');
  if (rename) {
    const p = store.playlist(rename.dataset.rename);
    return ask({ title: 'Rename playlist', value: p.name }).then(name => {
      if (name) { store.renamePlaylist(p.id, name); route({ keepScroll: true }); }
    });
  }
  const del = target.closest('[data-delete]');
  if (del) {
    const p = store.playlist(del.dataset.delete);
    return ask({ title: `Delete “${p.name}”?`, text: 'This removes it from your library.', ok: 'Delete', input: false }).then(yes => {
      if (!yes) return;
      store.deletePlaylist(p.id);
      toast(`Deleted ${p.name}`);
      location.hash = '#/library';
    });
  }
  if (target.closest('a')) return;
  const row = target.closest('.track-row, .track-card');
  if (row) return playFromList(row.dataset.list, +row.dataset.index);
  const link = target.closest('[data-href]');
  if (link) location.hash = link.dataset.href;
}

function setupShell() {
  const labelled = (svg, label) => `${svg}<span>${label}</span>`;
  $('.nav-link[data-route="home"]').innerHTML = labelled(icon.home, 'Home');
  $('.nav-link[data-route="search"]').innerHTML = labelled(icon.search, 'Search');
  $('.nav-link[data-route="library"]').innerHTML = labelled(icon.library, 'Your Library');
  $('#library-head').innerHTML = labelled(icon.library, 'Your Library');
  $('#new-playlist-btn').innerHTML = icon.plus;
  $('#new-playlist-btn').onclick = () => newPlaylist();
  $('#search-icon').innerHTML = icon.search;
  $('#back-btn').innerHTML = icon.back;
  $('#fwd-btn').innerHTML = icon.forward;
  $('#back-btn').onclick = () => history.back();
  $('#fwd-btn').onclick = () => history.forward();

  main.addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', main.scrollTop > 40), { passive: true });

  // Searches cost quota, so wait for a pause in typing (or Enter) before searching.
  const input = $('#search-input');
  let timer;
  const runSearch = () => {
    clearTimeout(timer);
    history.replaceState(null, '', `#/search/${encodeURIComponent(input.value.trim())}`);
    route();
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, input.value.trim() ? 900 : 0);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

  document.addEventListener('click', onClick);
  document.addEventListener('submit', e => {
    if (e.target.id === 'import-form') {
      e.preventDefault();
      importPlaylist(e.target);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideMenu();
    if (e.key === 'Enter' && e.target.matches?.('[data-href]')) location.hash = e.target.dataset.href;
    if (e.key === 'Enter' && e.target.matches?.('.track-card, .up-item')) e.target.click();
    if (e.code === 'Space' && !e.target.closest('input, textarea, button, [role=link], [role=button], .modal')) {
      e.preventDefault();
      player.toggle();
    }
  });
  window.addEventListener('resize', hideMenu);
  main.addEventListener('scroll', hideMenu, { passive: true });
}

async function loadMore(btn) {
  const id = btn.dataset.more;
  const list = state.lists[id];
  if (!list?.loadMore || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const more = await list.loadMore();
    const start = list.tracks.length;
    list.tracks.push(...more);
    $(`[data-rows="${id}"]`)?.insertAdjacentHTML('beforeend', more.map((t, i) => trackRow(t, start + i, id)).join(''));
  } catch (e) {
    handleError(e);
  }
  if (list.hasMore) {
    btn.disabled = false;
    btn.textContent = 'Show more';
  } else {
    btn.remove();
  }
}

/* ---------- Startup ---------- */

function startApp() {
  if (state.started) return;
  state.started = true;
  $('#app').classList.remove('hidden');
  setupShell();
  setupPlayerBar();
  player.init({
    element: 'yt-player',
    volume: loadVolume(),
    onChange: onPlayerChange,
    onError: handleError,
    onNotice: toast,
    substitute: t => store.alternativeFor(t.id),
    alternatives: t => yt.findAlternatives(t),
    blocked: t => store.markBlocked(t.id),
    worked: (origId, t) => store.saveAlternative(origId, t),
  });
  store.onChange(renderSidebar);
  renderSidebar();
  window.addEventListener('hashchange', () => route());
  route();
}

yt.setKey(CONFIG_KEY);
startApp();
