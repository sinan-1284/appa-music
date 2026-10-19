// YouTube IFrame player plus our own queue (shuffle, repeat, next/previous).
const STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2 };
const NOT_EMBEDDABLE = new Set([101, 150]);

let yt = null;
let ready = null;
let elementId = '';
let listeners = { change: () => {}, error: () => {}, notice: () => {} };
let hooks = {};
let volume = 50;
let errorStreak = 0;
let fallback = null; // { origId, original, index, candidates } while trying other versions of a blocked song

const q = { tracks: [], order: [], pos: -1, shuffle: false, repeat: 'off', playing: false };

// hooks.substitute(track): a known-working version of a blocked song, or null
// hooks.alternatives(track): other versions to try when a song is blocked
// hooks.blocked(track) / hooks.worked(origId, track): remember what happened
export function init({ element, volume: v, onChange, onError, onNotice, ...rest }) {
  elementId = element;
  volume = v;
  listeners = { change: onChange, error: onError, notice: onNotice };
  hooks = rest;
}

function emit() {
  listeners.change(snapshot());
}

export function snapshot() {
  return { track: current(), playing: q.playing, shuffle: q.shuffle, repeat: q.repeat };
}

export const current = () => q.tracks[q.order[q.pos]] ?? null;

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadApi() {
  ready ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = resolve;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      ready = null;
      reject(new Error("Couldn't load the YouTube player. Check your connection or ad blocker."));
    };
    document.head.append(script);
  }).then(() => new Promise(resolve => {
    yt = new window.YT.Player(elementId, {
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          yt.setVolume(volume);
          resolve();
        },
        onStateChange,
        onError: onPlayerError,
      },
    });
  }));
  return ready;
}

function onStateChange(e) {
  if (e.data === STATE.PLAYING) {
    q.playing = true;
    errorStreak = 0;
    const t = current();
    if (fallback && t?.replaces === fallback.origId) {
      hooks.worked?.(fallback.origId, t);
      fallback = null;
    }
  } else if (e.data === STATE.PAUSED) {
    q.playing = false;
  } else if (e.data === STATE.ENDED) {
    q.playing = false;
    return next(true);
  }
  emit();
}

async function onPlayerError(e) {
  const index = q.order[q.pos];
  const t = q.tracks[index];
  if (!t) return;
  if (NOT_EMBEDDABLE.has(e.data) && hooks.alternatives) {
    hooks.blocked?.(t);
    const origId = t.replaces ?? t.id;
    if (fallback?.origId !== origId || fallback.index !== index) {
      fallback = { origId, original: t, index, candidates: null };
    }
    const fb = fallback;
    if (!fb.candidates) {
      try {
        fb.candidates = await hooks.alternatives(fb.original);
      } catch (err) {
        fb.candidates = [];
        listeners.error(err);
      }
      if (fallback !== fb || q.order[q.pos] !== index) return; // user moved on meanwhile
    }
    const alt = fb.candidates.shift();
    if (alt) {
      q.tracks[index] = { ...alt, replaces: origId };
      listeners.notice(`“${fb.original.title}” is blocked outside YouTube, playing another version.`);
      return loadCurrent();
    }
    fallback = null;
    listeners.error(new Error(`“${fb.original.title}” can only be played on YouTube, skipping.`));
  } else {
    listeners.error(new Error(`“${t.title}” is unavailable, skipping.`));
  }
  if (++errorStreak >= 5) {
    q.playing = false;
    errorStreak = 0;
    return emit();
  }
  setTimeout(() => next(true, true), 800);
}

async function loadCurrent() {
  const index = q.order[q.pos];
  if (q.tracks[index] && !q.tracks[index].replaces) {
    const known = hooks.substitute?.(q.tracks[index]);
    if (known) q.tracks[index] = { ...known, replaces: q.tracks[index].id };
  }
  const t = current();
  if (!t) return;
  emit();
  try {
    await loadApi();
  } catch (e) {
    return listeners.error(e);
  }
  // A newer request may have moved on while the API was loading.
  if (current() === t) yt.loadVideoById(t.id);
}

export function playList(tracks, index = 0) {
  q.tracks = [...tracks];
  const all = q.tracks.map((_, i) => i);
  if (q.shuffle) {
    q.order = [index, ...shuffled(all.filter(i => i !== index))];
    q.pos = 0;
  } else {
    q.order = all;
    q.pos = index;
  }
  errorStreak = 0;
  return loadCurrent();
}

export function next(auto = false, skipping = false) {
  if (!current()) return;
  if (auto && !skipping && q.repeat === 'one') {
    yt?.seekTo(0, true);
    yt?.playVideo();
    return;
  }
  if (q.pos + 1 < q.order.length) {
    q.pos++;
  } else if (q.repeat === 'all') {
    if (q.shuffle) q.order = shuffled(q.order);
    q.pos = 0;
  } else {
    // End of the queue: stay on the last song.
    if (auto) emit();
    return;
  }
  return loadCurrent();
}

export function prev() {
  if (!current()) return;
  if ((yt?.getCurrentTime?.() ?? 0) > 3 || q.pos === 0) {
    yt?.seekTo(0, true);
    return;
  }
  q.pos--;
  return loadCurrent();
}

export function jumpTo(offset) {
  q.pos += offset;
  return loadCurrent();
}

export function toggle() {
  if (!yt || !current()) return false;
  if (q.playing) yt.pauseVideo();
  else yt.playVideo();
  return true;
}

export function play() { if (yt && current()) yt.playVideo(); }
export function pause() { if (yt && current()) yt.pauseVideo(); }

export function toggleShuffle() {
  q.shuffle = !q.shuffle;
  const cur = q.order[q.pos];
  if (cur != null) {
    const all = q.tracks.map((_, i) => i);
    if (q.shuffle) {
      q.order = [cur, ...shuffled(all.filter(i => i !== cur))];
      q.pos = 0;
    } else {
      q.order = all;
      q.pos = cur;
    }
  }
  emit();
}

export function cycleRepeat() {
  q.repeat = { off: 'all', all: 'one', one: 'off' }[q.repeat];
  emit();
}

export function addToQueue(track) {
  q.tracks.push(track);
  if (q.pos < 0) {
    q.order = [q.tracks.length - 1];
    q.pos = 0;
    return loadCurrent();
  }
  q.order.splice(q.pos + 1, 0, q.tracks.length - 1);
  emit();
}

export const upcoming = (n = 20) => q.order.slice(q.pos + 1, q.pos + 1 + n).map(i => q.tracks[i]);

export function time() {
  if (!yt?.getCurrentTime) return { position: 0, duration: current()?.duration ?? 0 };
  return { position: yt.getCurrentTime() || 0, duration: yt.getDuration() || current()?.duration || 0 };
}

export function seek(sec) {
  yt?.seekTo(sec, true);
}

export function setVolume(v) {
  volume = v;
  yt?.setVolume?.(v);
}
