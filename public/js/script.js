'use strict';

var state = {
    tracks: [],
    queue: [],
    currentIndex: -1,
    repeatMode: 'off', // off | all | one
    isPlaying: false,
    player: null,
    currentPlaylistId: null,
};

var ytApiReady = false;
var pendingTrackId = null;
var isSeeking = false;
var progressTimer = null;
var lastPlayerSignal = 0;
var watchdogTimer = null;
var thumbLoadToken = 0;

var setupScreen = document.getElementById('setup-screen');
var playerScreen = document.getElementById('player-screen');

var playlistInput = document.getElementById('playlist-input');
var loadPlaylistBtn = document.getElementById('load-playlist-btn');
var setupError = document.getElementById('setup-error');
var setupLoading = document.getElementById('setup-loading');
var setupLoadingText = document.getElementById('setup-loading-text');
var savedSection = document.getElementById('saved-section');
var savedList = document.getElementById('saved-list');

var powerDot = document.getElementById('power-dot');
var trackTitleEl = document.getElementById('track-title');
var trackChannelEl = document.getElementById('track-channel');

var curTimeEl = document.getElementById('cur-time');
var durTimeEl = document.getElementById('dur-time');
var seekInput = document.getElementById('seek-input');
var volumeInput = document.getElementById('volume-input');

var reshuffleBtn = document.getElementById('reshuffle-btn');
var prevBtn = document.getElementById('prev-btn');
var nextBtn = document.getElementById('next-btn');
var playPauseBtn = document.getElementById('play-pause-btn');
var iconPlay = document.getElementById('icon-play');
var iconPause = document.getElementById('icon-pause');
var repeatBtn = document.getElementById('repeat-btn');
var repeatBadge = document.getElementById('repeat-badge');

var queueBtn = document.getElementById('queue-btn');
var setupBtn = document.getElementById('setup-btn');
var settingsBtn = document.getElementById('settings-btn');
var queueDrawer = document.getElementById('queue-drawer');
var drawerBackdrop = document.getElementById('drawer-backdrop');
var drawerCloseBtn = document.getElementById('drawer-close-btn');
var queueListEl = document.getElementById('queue-list');
var settingsBackdrop = document.getElementById('settings-backdrop');
var settingsCloseBtn = document.getElementById('settings-close-btn');

var toastEl = document.getElementById('toast');
var silentAudio = document.getElementById('silent-audio');

function cryptoRandom() {
    var buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
}

function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(cryptoRandom() * (i + 1));
        var tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
    }
    return a;
}

function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function bestThumbnailUrl(videoId, callback) {
    const THUMBNAIL_SIZES = ['maxresdefault', 'sddefault', 'hqdefault'];

    tryLoad(0);

    function tryLoad(i) {
        var size = THUMBNAIL_SIZES[i];
        var url = 'https://i.ytimg.com/vi/' + videoId + '/' + size + '.jpg';
        var img = new Image();
        img.onload = function () {
            var isMissingPlaceholder = img.naturalWidth === 120 && img.naturalHeight === 90;
            if (isMissingPlaceholder && i < THUMBNAIL_SIZES.length - 1) {
                tryLoad(i + 1);
            } else {
                callback(url);
            }
        };
        img.onerror = function () {
            if (i < THUMBNAIL_SIZES.length - 1) tryLoad(i + 1);
            else callback('https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg');
        };
        img.src = url;
    }
}

function extractGlowColors(imgUrl, callback) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
        try {
            var size = 24;
            var canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, size, size);
            var data = ctx.getImageData(0, 0, size, size).data;

            function vibrantHalf(startY, endY) {
                var bins = [];
                var totalScore = 0;
                var coloredPixels = 0;
                for (var binIndex = 0; binIndex < 24; binIndex++) {
                    bins.push({score: 0, saturation: 0, lightness: 0, weight: 0});
                }

                for (var y = startY; y < endY; y++) {
                    for (var x = 0; x < size; x++) {
                        var i = (y * size + x) * 4;
                        if (data[i + 3] < 32) continue;

                        var red = data[i] / 255;
                        var green = data[i + 1] / 255;
                        var blue = data[i + 2] / 255;
                        var max = Math.max(red, green, blue);
                        var min = Math.min(red, green, blue);
                        var delta = max - min;
                        var lightness = (max + min) / 2;
                        if (delta === 0 || lightness < 0.08 || lightness > 0.94) continue;

                        var saturation = delta / (1 - Math.abs(2 * lightness - 1));
                        if (saturation < 0.24) continue;

                        var hue;
                        if (max === red) hue = 60 * (((green - blue) / delta) % 6);
                        else if (max === green) hue = 60 * ((blue - red) / delta + 2);
                        else hue = 60 * ((red - green) / delta + 4);
                        if (hue < 0) hue += 360;

                        var bin = bins[Math.floor(hue / 15) % 24];
                        var brightnessPreference = 0.45 + 0.55 * (1 - Math.abs(lightness - 0.55) / 0.55);
                        var pixelScore = saturation * saturation * brightnessPreference;
                        bin.score += pixelScore;
                        totalScore += pixelScore;
                        coloredPixels++;
                        bin.saturation += saturation * brightnessPreference;
                        bin.lightness += lightness * brightnessPreference;
                        bin.weight += brightnessPreference;
                    }
                }

                var halfPixelCount = size * (endY - startY);
                if (coloredPixels < halfPixelCount * 0.12) return 'hsl(225, 14%, 54%)';

                var bestIndex = 0;
                for (var candidateIndex = 1; candidateIndex < bins.length; candidateIndex++) {
                    if (bins[candidateIndex].score > bins[bestIndex].score) bestIndex = candidateIndex;
                }
                var best = bins[bestIndex];
                if (!best.weight || best.score / totalScore < 0.18) return 'hsl(225, 14%, 54%)';

                var saturationPct = Math.round(Math.min(100, Math.max(76, (best.saturation / best.weight) * 118 * 100)));
                var lightnessPct = Math.round(Math.min(64, Math.max(48, (best.lightness / best.weight) * 100)));
                return 'hsl(' + (bestIndex * 15 + 7.5) + ', ' + saturationPct + '%, ' + lightnessPct + '%)';
            }

            callback(vibrantHalf(0, size / 2), vibrantHalf(size / 2, size));
        } catch (e) {
            callback(null, null);
        }
    };
    img.onerror = function () {
        callback(null, null);
    };
    img.src = imgUrl;
}

function updateAmbientGlow(color1, color2) {
    if (!color1 || !color2) return;
    document.documentElement.style.setProperty('--glow-color', color1);
    document.documentElement.style.setProperty('--glow-color-2', color2);
}

function cleanChannelName(name) {
    return (name || '').replace(/\s*-\s*topic\s*$/i, '').trim();
}

function extractPlaylistId(raw) {
    var input = (raw || '').trim();
    if (!input) return null;
    if (!/^https?:\/\//i.test(input) && /^[A-Za-z0-9_-]{8,}$/.test(input)) {
        return input;
    }
    try {
        var url = new URL(input);
        var listParam = url.searchParams.get('list');
        if (listParam) return listParam;
    } catch (e) {
    }
    return null;
}

var toastTimer = null;

function showToast(msg, duration) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
        toastEl.classList.remove('show');
    }, duration || 2800);
}

function setSliderFill(input, pct) {
    pct = Math.max(0, Math.min(100, pct));
    input.style.background = 'linear-gradient(to right, var(--accent) ' + pct + '%, var(--border) ' + pct + '%)';
}

function getCachedPlaylist(playlistId) {
    try {
        var raw = localStorage.getItem('ytsp_cache:' + playlistId);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function setCachedPlaylist(playlistId, title, tracks) {
    try {
        localStorage.setItem('ytsp_cache:' + playlistId, JSON.stringify({
            title: title,
            tracks: tracks,
            cachedAt: Date.now(),
        }));
    } catch (e) {
    }
}

var playlistInfoRequests = {};

function getSavedPlaylists() {
    try {
        return JSON.parse(localStorage.getItem('ytsp_playlists') || '[]');
    } catch (e) {
        return [];
    }
}

function savePlaylistToHistory(playlist) {
    var current = getSavedPlaylists();
    var previous = current.find(function (p) {
        return p.id === playlist.id;
    });
    if (previous) {
        playlist.owner = playlist.owner || previous.owner;
        playlist.thumbnailUrl = playlist.thumbnailUrl || previous.thumbnailUrl;
    }
    var list = current.filter(function (p) {
        return p.id !== playlist.id;
    });
    list.unshift(playlist);
    if (list.length > 8) list = list.slice(0, 8);
    localStorage.setItem('ytsp_playlists', JSON.stringify(list));
    renderSavedPlaylists();
}

function removeSavedPlaylist(id) {
    var list = getSavedPlaylists().filter(function (p) {
        return p.id !== id;
    });
    localStorage.setItem('ytsp_playlists', JSON.stringify(list));
    renderSavedPlaylists();
}

function renderSavedPlaylists() {
    var list = getSavedPlaylists();
    savedList.innerHTML = '';
    if (list.length === 0) {
        savedSection.classList.add('hidden');
        return;
    }
    savedSection.classList.remove('hidden');
    list.forEach(function (p) {
        var li = document.createElement('li');
        li.className = 'saved-item';

        var mainBtn = document.createElement('button');
        mainBtn.className = 'saved-main';
        mainBtn.setAttribute('aria-label', 'Play ' + (p.title || p.id));
        if (p.thumbnailUrl) {
            var thumbnail = document.createElement('img');
            thumbnail.className = 'saved-thumbnail';
            thumbnail.src = p.thumbnailUrl;
            thumbnail.alt = '';
            thumbnail.loading = 'lazy';
            thumbnail.onerror = function () {
                thumbnail.classList.add('hidden');
            };
            mainBtn.appendChild(thumbnail);
        }
        var textWrap = document.createElement('div');
        textWrap.className = 'saved-text';
        var titleDiv = document.createElement('div');
        titleDiv.className = 'saved-title';
        titleDiv.textContent = p.title || p.id;
        var ownerDiv = document.createElement('div');
        ownerDiv.className = 'saved-owner';
        ownerDiv.textContent = p.owner || 'YouTube playlist';
        textWrap.appendChild(titleDiv);
        textWrap.appendChild(ownerDiv);
        mainBtn.appendChild(textWrap);
        mainBtn.addEventListener('click', function () {
            playlistInput.value = p.id;
            beginLoadPlaylist();
        });

        var refreshBtn = document.createElement('button');
        refreshBtn.className = 'refresh-btn';
        refreshBtn.title = 'Refresh from YouTube';
        refreshBtn.setAttribute('aria-label', 'Refresh this playlist from YouTube');
        refreshBtn.innerHTML = '<span class="material-symbols-outlined small">refresh</span>';
        refreshBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            playlistInput.value = p.id;
            beginLoadPlaylist(true);
        });

        var removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.setAttribute('aria-label', 'Remove saved playlist');
        removeBtn.innerHTML = '<span class="material-symbols-outlined small">delete</span>';
        removeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            removeSavedPlaylist(p.id);
        });

        li.appendChild(mainBtn);
        li.appendChild(refreshBtn);
        li.appendChild(removeBtn);
        savedList.appendChild(li);
    });

    list.forEach(function (p) {
        if (!p.owner || !p.thumbnailUrl) fetchSavedPlaylistInfo(p);
    });
}

function fetchSavedPlaylistInfo(playlist) {
    if (playlistInfoRequests[playlist.id]) return;
    playlistInfoRequests[playlist.id] = true;
    fetchPlaylistInfo(playlist.id).then(function (info) {
        if (!info) return;
        var saved = getSavedPlaylists();
        var item = saved.find(function (p) {
            return p.id === playlist.id;
        });
        if (!item) return;
        item.title = item.title || info.title;
        item.owner = item.owner || info.owner;
        item.thumbnailUrl = item.thumbnailUrl || info.thumbnailUrl;
        localStorage.setItem('ytsp_playlists', JSON.stringify(saved));
        renderSavedPlaylists();
    }).catch(function () {
    }).then(function () {
        delete playlistInfoRequests[playlist.id];
    });
}

const API_PROXY_BASE = 'https://truly-music-proxy.cowdevs.workers.dev/';

function apiRequest(path, params) {
    var url = new URL(API_PROXY_BASE + path);
    Object.keys(params).forEach(function (k) {
        url.searchParams.set(k, params[k]);
    });
    return fetch(url.toString()).then(function (res) {
        return res.json().then(function (data) {
            if (!res.ok) {
                var msg = (data && data.error && data.error.message) || ('Request failed (' + res.status + ')');
                throw new Error(msg);
            }
            return data;
        });
    });
}

function fetchPlaylistInfo(playlistId) {
    return apiRequest('playlists', {part: 'snippet', id: playlistId}).then(function (data) {
        var item = data.items && data.items[0];
        if (!item || !item.snippet) return null;
        var snippet = item.snippet;
        var thumbnails = snippet.thumbnails || {};
        var thumbnail = thumbnails.medium || thumbnails.default || thumbnails.high;
        return {
            title: snippet.title || null,
            owner: snippet.channelTitle || null,
            thumbnailUrl: thumbnail ? thumbnail.url : null,
        };
    }).catch(function () {
        return null;
    });
}

function fetchPlaylistTracks(playlistId) {
    var tracks = [];

    function page(pageToken) {
        var params = {part: 'snippet', maxResults: 50, playlistId: playlistId};
        if (pageToken) params.pageToken = pageToken;
        return apiRequest('playlistItems', params).then(function (data) {
            (data.items || []).forEach(function (item) {
                var s = item.snippet;
                if (!s || !s.resourceId || !s.resourceId.videoId) return;
                if (s.title === 'Private video' || s.title === 'Deleted video') return;
                tracks.push({
                    id: s.resourceId.videoId,
                    title: s.title,
                    channel: cleanChannelName(s.videoOwnerChannelTitle || s.channelTitle || 'Unknown channel'),
                    channelId: s.videoOwnerChannelId || null,
                });
            });
            if (data.nextPageToken) {
                setupLoadingText.textContent = 'Fetching tracks… (' + tracks.length + ' found)';
                return page(data.nextPageToken);
            }
            return tracks;
        });
    }

    return page(null);
}

function friendlyFetchError(err) {
    if (err instanceof TypeError) {
        return 'Couldn\u2019t reach YouTube\u2019s API.';
    }
    return err.message || 'Something went wrong fetching the playlist.';
}

function showSetupError(msg) {
    setupError.textContent = msg;
    setupError.classList.remove('hidden');
}

function clearSetupError() {
    setupError.classList.add('hidden');
    setupError.textContent = '';
}

function beginLoadPlaylist(forceRefresh) {
    clearSetupError();
    var playlistId = extractPlaylistId(playlistInput.value);

    if (!playlistId) {
        showSetupError('Paste a playlist URL (with a "list=" parameter) or a raw playlist ID.');
        return;
    }

    var cached = !forceRefresh && getCachedPlaylist(playlistId);
    if (cached) {
        finishLoadingPlaylist(playlistId, cached.title, cached.tracks, cached.owner, cached.thumbnailUrl);
        return;
    }

    loadPlaylistBtn.disabled = true;
    setupLoading.classList.remove('hidden');
    setupLoadingText.textContent = 'Fetching tracks…';

    Promise.all([
        fetchPlaylistInfo(playlistId),
        fetchPlaylistTracks(playlistId),
    ]).then(function (results) {
        var info = results[0] || {};
        var title = info.title;
        var tracks = results[1];

        loadPlaylistBtn.disabled = false;
        setupLoading.classList.add('hidden');

        if (tracks.length === 0) {
            showSetupError('No playable videos found. The playlist may be empty, private, or unavailable to the API (this includes "Watch Later" and other special YouTube playlists).');
            return;
        }

        setCachedPlaylist(playlistId, title || playlistId, tracks);
        var cachedData = getCachedPlaylist(playlistId);
        if (cachedData) {
            cachedData.owner = info.owner;
            cachedData.thumbnailUrl = info.thumbnailUrl;
            try {
                localStorage.setItem('ytsp_cache:' + playlistId, JSON.stringify(cachedData));
            } catch (e) {
            }
        }
        finishLoadingPlaylist(playlistId, title || playlistId, tracks, info.owner, info.thumbnailUrl);
    }).catch(function (err) {
        loadPlaylistBtn.disabled = false;
        setupLoading.classList.add('hidden');
        showSetupError(friendlyFetchError(err));
    });
}

function finishLoadingPlaylist(playlistId, title, tracks, owner, thumbnailUrl) {
    state.tracks = tracks;
    state.currentPlaylistId = playlistId;
    savePlaylistToHistory({id: playlistId, title: title, owner: owner, thumbnailUrl: thumbnailUrl});

    state.queue = shuffle(tracks);
    state.currentIndex = -1;
    renderQueue();
    showPlayerScreen();
    playTrackAt(0);
}

function showPlayerScreen() {
    setupScreen.classList.add('hidden');
    playerScreen.classList.remove('hidden');
}

function showSetupScreen() {
    pendingTrackId = null;
    stopProgressTimer();
    if (state.player) {
        if (state.player.stopVideo) state.player.stopVideo();
        else if (state.player.pauseVideo) state.player.pauseVideo();
    }
    state.isPlaying = false;
    iconPlay.style.display = '';
    iconPause.style.display = 'none';
    powerDot.classList.remove('playing');
    silentAudio.pause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    playerScreen.classList.add('hidden');
    setupScreen.classList.remove('hidden');
    closeDrawer();
    closeSettings(false);
}

function loadYTScript() {
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
}

window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    if (pendingTrackId) {
        initPlayer(pendingTrackId);
        pendingTrackId = null;
    }
};

function initPlayer(videoId) {
    var playerVars = {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 1,
        rel: 0,
        cc_load_policy: 0,
        iv_load_policy: 3,
        hl: 'en'
    };
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
        playerVars.origin = window.location.origin;
    }
    state.player = new YT.Player('yt-player', {
        videoId: videoId,
        playerVars: playerVars,
        isPlaying: true,
        events: {
            onReady: onPlayerReady,
            onStateChange: onPlayerStateChange,
            onError: onPlayerError,
        },
    });
}

function ensurePlayer(videoId) {
    if (state.player && state.player.loadVideoById) {
        state.player.loadVideoById(videoId);
        return;
    }
    if (!ytApiReady) {
        pendingTrackId = videoId;
        loadYTScript();
        return;
    }
    initPlayer(videoId);
}

function onPlayerReady() {
    lastPlayerSignal = Date.now();
    state.player.setVolume(parseInt(volumeInput.value, 10));
    setupMediaSessionHandlers();
    startProgressTimer();
    state.player.playVideo();
}

function onPlayerStateChange(e) {
    lastPlayerSignal = Date.now();
    var S = YT.PlayerState;
    if (e.data === S.PLAYING) {
        state.isPlaying = true;
        iconPlay.style.display = 'none';
        iconPause.style.display = '';
        state.player.setOption('captions', 'track', {});
        powerDot.classList.add('playing');
        silentAudio.play().catch(function () {
        });
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        startProgressTimer();
    } else if (e.data === S.PAUSED) {
        state.isPlaying = false;
        iconPlay.style.display = '';
        iconPause.style.display = 'none';
        powerDot.classList.remove('playing');
        silentAudio.pause();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    } else if (e.data === S.ENDED) {
        playNext(true);
    }
}

function onPlayerError(e) {
    lastPlayerSignal = Date.now();
    console.warn('YouTube player error code:', e && e.data, 'for video', state.queue[state.currentIndex] && state.queue[state.currentIndex].id);
    showToast('Track unavailable. Skipping...');
    var removedIndex = state.currentIndex;
    state.queue.splice(removedIndex, 1);
    renderQueue();
    if (state.queue.length === 0) {
        showToast('No playable tracks left in this playlist.');
        trackTitleEl.textContent = 'Nothing left to play';
        trackTitleEl.removeAttribute('href');
        trackChannelEl.textContent = '—';
        trackChannelEl.removeAttribute('href');
        return;
    }
    var nextIndex = removedIndex >= state.queue.length ? 0 : removedIndex;
    playTrackAt(nextIndex);
}

function playTrackAt(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.currentIndex = index;
    var track = state.queue[index];

    ensurePlayer(track.id);
    updateNowPlayingUI(track);
    updateMediaSessionMetadata(track);
    highlightQueueItem(index);

    var myToken = ++thumbLoadToken;
    bestThumbnailUrl(track.id, function (src) {
        if (myToken !== thumbLoadToken || !src) return;
        if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
            navigator.mediaSession.metadata.artwork = [{src: src, type: 'image/jpeg'}];
        }
        extractGlowColors(src, function (c1, c2) {
            if (myToken !== thumbLoadToken) return;
            updateAmbientGlow(c1, c2);
        });
    });

    curTimeEl.textContent = '0:00';
    durTimeEl.textContent = '0:00';
    seekInput.value = 0;
    setSliderFill(seekInput, 0);
}

function playNext(auto) {
    if (state.queue.length === 0) return;
    if (auto && state.repeatMode === 'one') {
        playTrackAt(state.currentIndex);
        return;
    }
    var next = state.currentIndex + 1;
    if (next >= state.queue.length) {
        if (state.repeatMode === 'all') {
            next = 0;
        } else {
            return;
        }
    }
    playTrackAt(next);
}

function playPrev() {
    if (state.queue.length === 0) return;
    if (state.player && state.player.getCurrentTime && state.player.getCurrentTime() > 3) {
        state.player.seekTo(0, true);
        return;
    }
    var prev = state.currentIndex - 1;
    if (prev < 0) {
        prev = state.repeatMode === 'all' ? state.queue.length - 1 : 0;
    }
    playTrackAt(prev);
}

function togglePlay() {
    if (!state.player || !state.player.playVideo) return;
    if (state.isPlaying) state.player.pauseVideo();
    else state.player.playVideo();
}

function cycleRepeatMode() {
    state.repeatMode = state.repeatMode === 'off' ? 'all' : state.repeatMode === 'all' ? 'one' : 'off';
    updateRepeatUI();
}

function updateRepeatUI() {
    repeatBtn.classList.toggle('active', state.repeatMode !== 'off');
    repeatBadge.classList.toggle('hidden', state.repeatMode !== 'one');
    repeatBtn.title = 'Repeat: ' + state.repeatMode;
}

function reshuffleQueue() {
    if (state.queue.length < 2) {
        showToast('Not enough tracks!');
        return;
    }
    var current = state.queue[state.currentIndex];
    var rest = state.queue.filter(function (_, i) {
        return i !== state.currentIndex;
    });
    var shuffledRest = shuffle(rest);
    state.queue = current ? [current].concat(shuffledRest) : shuffledRest;
    state.currentIndex = current ? 0 : -1;
    renderQueue();
    showToast('Queue reshuffled!');
}

function updateNowPlayingUI(track) {
    trackTitleEl.textContent = track.title;
    trackTitleEl.href = 'https://www.youtube.com/watch?v=' + track.id;
    trackChannelEl.textContent = track.channel;
    trackChannelEl.href = track.channelId
        ? 'https://music.youtube.com/channel/' + track.channelId
        : 'https://music.youtube.com/search?q=' + encodeURIComponent(track.channel);
}

function highlightQueueItem(index) {
    var items = queueListEl.querySelectorAll('.queue-item');
    items.forEach(function (el, i) {
        el.classList.toggle('active', i === index);
    });
    var activeEl = items[index];
    if (activeEl) activeEl.scrollIntoView({block: 'nearest'});
}

function renderQueue() {
    queueListEl.innerHTML = '';
    if (state.queue.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = 'The queue is empty.';
        queueListEl.appendChild(empty);
        return;
    }
    state.queue.forEach(function (track, i) {
        var li = document.createElement('li');
        li.className = 'queue-item' + (i === state.currentIndex ? ' active' : '');

        var idx = document.createElement('span');
        idx.className = 'idx';
        idx.textContent = String(i + 1);

        var thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.loading = 'lazy';
        thumb.src = 'https://i.ytimg.com/vi/' + track.id + '/hqdefault.jpg';
        thumb.alt = '';
        thumb.draggable = false;

        var meta = document.createElement('div');
        meta.className = 'meta';
        var qTitle = document.createElement('div');
        qTitle.className = 'q-title';
        qTitle.textContent = track.title;
        var qChannel = document.createElement('div');
        qChannel.className = 'q-channel';
        qChannel.textContent = track.channel;
        meta.appendChild(qTitle);
        meta.appendChild(qChannel);

        li.appendChild(idx);
        li.appendChild(thumb);
        li.appendChild(meta);

        li.tabIndex = 0;
        li.addEventListener('click', function () {
            playTrackAt(i);
        });
        li.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                playTrackAt(i);
            }
        });

        queueListEl.appendChild(li);
    });
}

function startProgressTimer() {
    stopProgressTimer();
    progressTimer = setInterval(updateProgressUI, 500);
}

function stopProgressTimer() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
}

function updateProgressUI() {
    if (!state.player || !state.player.getCurrentTime) return;
    var cur = state.player.getCurrentTime() || 0;
    var dur = state.player.getDuration() || 0;
    if (!isSeeking) {
        var pct = dur ? (cur / dur) * 100 : 0;
        seekInput.value = pct;
        setSliderFill(seekInput, pct);
        curTimeEl.textContent = formatTime(cur);
    }
    durTimeEl.textContent = formatTime(dur);

    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur > 0 && isFinite(dur)) {
        try {
            navigator.mediaSession.setPositionState({
                duration: dur,
                playbackRate: 1,
                position: Math.min(cur, dur)
            });
        } catch (e) {
        }
    }
}

function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.setActionHandler('play', function () {
            silentAudio.play().catch(function () {
            });
            state.player && state.player.playVideo();
        });
        navigator.mediaSession.setActionHandler('pause', function () {
            state.player && state.player.pauseVideo();
        });
        navigator.mediaSession.setActionHandler('previoustrack', function () {
            playPrev();
        });
        navigator.mediaSession.setActionHandler('nexttrack', function () {
            playNext(false);
        });
        navigator.mediaSession.setActionHandler('seekto', function (details) {
            if (state.player && details.seekTime != null) state.player.seekTo(details.seekTime, true);
        });
        navigator.mediaSession.setActionHandler('stop', function () {
            state.player && state.player.pauseVideo();
        });
    } catch (e) {
    }
}

function updateMediaSessionMetadata(track, src) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: cleanChannelName(track.channel),
    });
}

function setupSilentAudio() {
    var sampleRate = 8000;
    var seconds = 10;
    var numSamples = sampleRate * seconds;
    var buffer = new ArrayBuffer(44 + numSamples);
    var view = new DataView(buffer);

    function writeStr(offset, str) {
        for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples, true);
    for (var i = 0; i < numSamples; i++) view.setUint8(44 + i, 128);
    var blob = new Blob([buffer], {type: 'audio/wav'});
    silentAudio.src = URL.createObjectURL(blob);
    silentAudio.volume = 0;
}

function openDrawer() {
    queueDrawer.classList.add('open');
    drawerBackdrop.classList.add('open');
    queueBtn.classList.add('active');
    playerScreen.classList.add('queue-open');
}

function closeDrawer() {
    queueDrawer.classList.remove('open');
    drawerBackdrop.classList.remove('open');
    queueBtn.classList.remove('active');
    playerScreen.classList.remove('queue-open');
}

function toggleDrawer() {
    if (queueDrawer.classList.contains('open')) closeDrawer();
    else openDrawer();
}

function openSettings() {
    closeDrawer();
    settingsBackdrop.classList.add('open');
    settingsBackdrop.setAttribute('aria-hidden', 'false');
    settingsBtn.classList.add('active');
    settingsBtn.setAttribute('aria-expanded', 'true');
    settingsCloseBtn.focus();
}

function closeSettings(restoreFocus) {
    settingsBackdrop.classList.remove('open');
    settingsBackdrop.setAttribute('aria-hidden', 'true');
    settingsBtn.classList.remove('active');
    settingsBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !playerScreen.classList.contains('hidden')) settingsBtn.focus();
}

function toggleSettings() {
    if (settingsBackdrop.classList.contains('open')) closeSettings(true);
    else openSettings();
}

loadPlaylistBtn.addEventListener('click', function () {
    beginLoadPlaylist(false);
});
playlistInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') beginLoadPlaylist();
});

setupBtn.addEventListener('click', showSetupScreen);
settingsBtn.addEventListener('click', toggleSettings);
settingsCloseBtn.addEventListener('click', function () { closeSettings(true); });
settingsBackdrop.addEventListener('click', function (e) {
    if (e.target === settingsBackdrop) closeSettings(true);
});
queueBtn.addEventListener('click', toggleDrawer);
drawerCloseBtn.addEventListener('click', closeDrawer);
drawerBackdrop.addEventListener('click', closeDrawer);
reshuffleBtn.addEventListener('click', reshuffleQueue);

playPauseBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', playPrev);
nextBtn.addEventListener('click', function () {
    playNext(false);
});
repeatBtn.addEventListener('click', cycleRepeatMode);

seekInput.addEventListener('input', function () {
    isSeeking = true;
    setSliderFill(seekInput, seekInput.value);
    if (state.player && state.player.getDuration) {
        var dur = state.player.getDuration() || 0;
        curTimeEl.textContent = formatTime((seekInput.value / 100) * dur);
    }
});
seekInput.addEventListener('change', function () {
    if (state.player && state.player.getDuration) {
        var dur = state.player.getDuration() || 0;
        state.player.seekTo((seekInput.value / 100) * dur, true);
    }
    isSeeking = false;
});

volumeInput.addEventListener('input', function () {
    setSliderFill(volumeInput, volumeInput.value);
    if (state.player && state.player.setVolume) state.player.setVolume(parseInt(volumeInput.value, 10));
    localStorage.setItem('ytsp_volume', volumeInput.value);
});

document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (playerScreen.classList.contains('hidden')) return;

    if (e.key === 'Escape') {
        if (settingsBackdrop.classList.contains('open')) closeSettings(true);
        else if (queueDrawer.classList.contains('open')) closeDrawer();
        return;
    }

    if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
    } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        playNext(false);
    } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        playPrev();
    } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        volumeInput.value = Math.min(100, parseInt(volumeInput.value, 10) + 5);
        volumeInput.dispatchEvent(new Event('input'));
    } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        volumeInput.value = Math.max(0, parseInt(volumeInput.value, 10) - 5);
        volumeInput.dispatchEvent(new Event('input'));
    }
});

function init() {
    setupSilentAudio();
    loadYTScript();

    var savedVolume = localStorage.getItem('ytsp_volume');
    if (savedVolume != null) volumeInput.value = savedVolume;
    setSliderFill(volumeInput, volumeInput.value);
    setSliderFill(seekInput, 0);
    updateRepeatUI();
    renderSavedPlaylists();
}

init();
