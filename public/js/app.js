(() => {
  'use strict';

  const MODES = new Set(['auto', 'proxy', 'direct']);

  const state = {
    me: null,
    socket: null,
    room: null,
    role: null,
    hostKey: null,
    mode: 'auto',
    url: '',
    title: '',
    history: [],
    historyIndex: -1,
    members: [],
    lastVideo: { time: 0, paused: true, rate: 1 },
    pendingVideo: null,
    videoRetry: null,
    scrollTimer: null,
    heartbeatTimer: null,
    lastSentScroll: -1,
    lastSentTitle: '',
    joined: false,
  };

  const el = {};

  function cacheElements() {
    const ids = {
      app: 'app',
      lobby: 'lobby',
      roomChip: 'room-chip',
      roomCode: 'room-code',
      copyLink: 'copy-link',
      status: 'status',
      statusText: 'status-text',
      avatar: 'avatar',
      userName: 'user-name',
      logout: 'logout',
      back: 'back',
      forward: 'forward',
      reload: 'reload',
      urlForm: 'url-form',
      urlInput: 'url-input',
      go: 'go',
      modeGroup: 'mode-group',
      modeSelect: 'mode-select',
      viewport: 'viewport',
      frame: 'frame',
      ytWrap: 'yt-wrap',
      ytPlayer: 'yt-player',
      emptyState: 'empty-state',
      frameLoading: 'frame-loading',
      autoplayHint: 'autoplay-hint',
      viewerBadge: 'viewer-badge',
      pageTitle: 'page-title',
      syncNote: 'sync-note',
      members: 'members',
      memberCount: 'member-count',
      messages: 'messages',
      chatForm: 'chat-form',
      chatInput: 'chat-input',
      createRoom: 'create-room',
      joinForm: 'join-form',
      joinCode: 'join-code',
      lobbyError: 'lobby-error',
      toast: 'toast',
    };
    for (const [key, id] of Object.entries(ids)) {
      el[key] = document.getElementById(id);
    }
  }

  // ------------------------------------------------------------- helpers ----

  function normalizeUrl(raw) {
    if (typeof raw !== 'string') return null;
    let value = raw.trim();
    if (!value) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  function detectYouTube(raw) {
    try {
      const url = new URL(raw);
      const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
      let id = null;
      if (host === 'youtu.be') {
        id = url.pathname.slice(1).split('/')[0];
      } else if (
        host === 'youtube.com' ||
        host === 'music.youtube.com' ||
        host === 'youtube-nocookie.com'
      ) {
        if (url.pathname === '/watch') id = url.searchParams.get('v');
        else {
          const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]+)/);
          if (match) id = match[1];
        }
      }
      return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function resolveMode(url) {
    if (state.mode === 'proxy' || state.mode === 'direct') return state.mode;
    return detectYouTube(url) ? 'youtube' : 'proxy';
  }

  function initials(name) {
    return (
      String(name || '?')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => (part[0] ? part[0].toUpperCase() : ''))
        .join('') || '?'
    );
  }

  function formatTime(ts) {
    return new Date(ts || Date.now()).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  let toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 2600);
  }

  function setStatus(text) {
    el.statusText.textContent = text;
    el.status.dataset.state = text;
  }

  function lobbyError(text) {
    el.lobbyError.textContent = text;
    el.lobbyError.hidden = false;
  }

  function showLobby(error) {
    state.joined = false;
    el.app.hidden = true;
    el.lobby.hidden = false;
    el.roomChip.hidden = true;
    if (error) lobbyError(error);
    else el.lobbyError.hidden = true;
  }

  // ------------------------------------------------------------ youtube -----

  let ytPlayer = null;
  let ytReady = false;
  let ytVideoId = null;
  let ytApiPromise = null;
  let pendingYtId = null;

  function ensureYtApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 15000);
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timeout);
        if (typeof previous === 'function') previous();
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('failed'));
      };
      document.head.appendChild(script);
    });
    return ytApiPromise;
  }

  function loadYouTube(url) {
    const id = detectYouTube(url);
    if (!id) {
      toast('That YouTube link could not be parsed.');
      return;
    }
    ensureYtApi()
      .then(() => {
        if (!ytPlayer) {
          ytPlayer = new window.YT.Player('yt-player', {
            videoId: id,
            playerVars: {
              autoplay: 0,
              rel: 0,
              modestbranding: 1,
              playsinline: 1,
              origin: window.location.origin,
            },
            events: {
              onReady: handleYtReady,
              onStateChange: handleYtState,
              onError: handleYtError,
            },
          });
          ytVideoId = id;
          return;
        }
        if (!ytReady) {
          pendingYtId = id;
          return;
        }
        if (ytVideoId !== id) {
          ytVideoId = id;
          ytPlayer.loadVideoById(id);
        }
      })
      .catch(() => toast('Could not load the YouTube player.'));
  }

  function handleYtReady() {
    ytReady = true;
    if (pendingYtId && pendingYtId !== ytVideoId) {
      ytVideoId = pendingYtId;
      try {
        ytPlayer.loadVideoById(pendingYtId);
      } catch {
        /* ignore */
      }
    }
    pendingYtId = null;

    if (state.role === 'viewer' && state.pendingVideo) {
      applyYt(state.pendingVideo);
    }
    if (state.role === 'host') {
      state.socket.emit('browser:state', { scrollY: 0, title: 'YouTube' });
    }
  }

  function handleYtState(event) {
    if (state.role !== 'host' || !ytPlayer || !ytReady) return;
    const time = ytPlayer.getCurrentTime() || 0;
    const rate = ytPlayer.getPlaybackRate() || 1;
    if (event.data === 1) emitVideo({ action: 'play', time, paused: false, rate });
    else if (event.data === 2) emitVideo({ action: 'pause', time, paused: true, rate });
    else if (event.data === 0) emitVideo({ action: 'ended', time, paused: true, rate });
  }

  function handleYtError() {
    toast('This video cannot be embedded.');
  }

  function emitVideo(command) {
    state.lastVideo = {
      time: command.time,
      paused: command.paused,
      rate: command.rate,
    };
    state.socket.emit('video:cmd', command);
  }

  function applyYt(command) {
    if (!command) return;
    if (!ytPlayer || !ytReady) {
      state.pendingVideo = command;
      scheduleVideoRetry();
      return;
    }
    state.pendingVideo = null;
    try {
      if (
        Number.isFinite(command.time) &&
        Math.abs((ytPlayer.getCurrentTime() || 0) - command.time) > 1
      ) {
        ytPlayer.seekTo(command.time, true);
      }
      if (Number.isFinite(command.rate) && command.rate > 0 && command.rate <= 4) {
        ytPlayer.setPlaybackRate(command.rate);
      }
      if (command.action === 'play' || command.paused === false) {
        ytPlayer.playVideo();
        setTimeout(() => {
          try {
            if (ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() !== 1) {
              showAutoplayHint();
            }
          } catch {
            /* ignore */
          }
        }, 1200);
      } else if (command.action === 'pause' || command.paused === true) {
        ytPlayer.pauseVideo();
      }
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- browser ----

  function getFrameDoc() {
    try {
      const doc = el.frame.contentDocument;
      if (!doc || !doc.documentElement) return null;
      return doc;
    } catch {
      return null;
    }
  }

  function applyScroll(doc, y) {
    try {
      if (doc.scrollingElement) doc.scrollingElement.scrollTop = y;
      doc.documentElement.scrollTop = y;
      if (doc.body) doc.body.scrollTop = y;
    } catch {
      /* ignore */
    }
  }

  function updateUrlBar() {
    if (document.activeElement !== el.urlInput) el.urlInput.value = state.url || '';
  }

  function updateNavButtons() {
    const isHost = state.role === 'host';
    el.back.disabled = !isHost || state.historyIndex <= 0;
    el.forward.disabled = !isHost || state.historyIndex >= state.history.length - 1;
  }

  function updateSyncNote() {
    if (!state.role) return;
    const resolved = resolveMode(state.url);
    if (state.role === 'host') {
      el.syncNote.textContent =
        resolved === 'youtube'
          ? 'YouTube mode - playback synced'
          : resolved === 'proxy'
            ? 'Proxy mode - page, scroll and video synced'
            : 'Direct mode - URL only';
    } else {
      el.syncNote.textContent =
        resolved === 'youtube'
          ? 'Following host (YouTube)'
          : resolved === 'proxy'
            ? 'Following host'
            : 'Following host (URL only)';
    }
  }

  function showEmptyState(isHost) {
    el.emptyState.hidden = false;
    el.frameLoading.hidden = true;
    el.frame.hidden = true;
    el.ytWrap.hidden = true;
    const title = el.emptyState.querySelector('h3');
    const text = el.emptyState.querySelector('p');
    if (title) title.textContent = isHost ? 'Open something to watch' : 'Waiting for the host';
    if (text) {
      text.textContent = isHost
        ? 'Paste a video or page URL above. Everyone in the room will follow you.'
        : 'The host has not opened a page yet.';
    }
  }

  function loadContent(url) {
    state.url = url;
    const resolved = resolveMode(url);
    el.emptyState.hidden = true;

    if (resolved === 'youtube') {
      el.frame.hidden = true;
      el.ytWrap.hidden = false;
      el.frameLoading.hidden = true;
      el.pageTitle.textContent = 'YouTube';
      try {
        el.frame.src = 'about:blank';
      } catch {
        /* ignore */
      }
      loadYouTube(url);
    } else {
      el.ytWrap.hidden = true;
      if (ytPlayer && ytReady) {
        try {
          ytPlayer.pauseVideo();
        } catch {
          /* ignore */
        }
      }
      el.frame.hidden = false;
      el.frameLoading.hidden = false;
      try {
        el.pageTitle.textContent = new URL(url).hostname;
      } catch {
        /* ignore */
      }
      const src = resolved === 'proxy' ? `/proxy?url=${encodeURIComponent(url)}` : url;
      el.frame.src = src;
    }

    updateUrlBar();
    updateSyncNote();
  }

  function pushHistory(url) {
    if (state.history[state.historyIndex] === url) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(url);
    state.historyIndex = state.history.length - 1;
    updateNavButtons();
  }

  function navigate(raw, options = {}) {
    const url = normalizeUrl(raw);
    if (!url) {
      toast('Enter a valid http(s) URL.');
      return;
    }
    if (options.push !== false) pushHistory(url);
    loadContent(url);
    if (state.role === 'host' && !options.fromRemote) {
      state.socket.emit('browser:navigate', { url, mode: state.mode });
    }
  }

  function goBack() {
    if (state.role !== 'host' || state.historyIndex <= 0) return;
    state.historyIndex -= 1;
    navigate(state.history[state.historyIndex], { push: false });
  }

  function goForward() {
    if (state.role !== 'host' || state.historyIndex >= state.history.length - 1) return;
    state.historyIndex += 1;
    navigate(state.history[state.historyIndex], { push: false });
  }

  function reloadContent() {
    if (!state.url) return;
    loadContent(state.url);
    if (state.role === 'host') {
      state.socket.emit('browser:navigate', { url: state.url, mode: state.mode });
    }
  }

  // --------------------------------------------------------------- video ----

  function showAutoplayHint() {
    el.autoplayHint.hidden = false;
  }

  function applyVideo(command) {
    if (!command) return;
    const doc = getFrameDoc();
    const media = doc ? doc.querySelector('video,audio') : null;
    if (!media) {
      state.pendingVideo = command;
      scheduleVideoRetry();
      return;
    }
    state.pendingVideo = null;
    try {
      if (
        Number.isFinite(command.time) &&
        Math.abs((media.currentTime || 0) - command.time) > 0.8
      ) {
        media.currentTime = command.time;
      }
      if (Number.isFinite(command.rate) && command.rate > 0 && command.rate <= 4) {
        media.playbackRate = command.rate;
      }
      if (command.action === 'play' || command.paused === false) {
        const promise = media.play();
        if (promise && typeof promise.catch === 'function') {
          promise.catch(() => showAutoplayHint());
        }
      } else if (command.action === 'pause' || command.paused === true) {
        media.pause();
      }
    } catch {
      /* ignore */
    }
  }

  function scheduleVideoRetry() {
    if (state.videoRetry) return;
    let attempts = 0;
    state.videoRetry = setInterval(() => {
      attempts += 1;
      if (!state.pendingVideo || attempts > 40) {
        clearInterval(state.videoRetry);
        state.videoRetry = null;
        return;
      }
      const command = state.pendingVideo;
      if (resolveMode(state.url) === 'youtube') applyYt(command);
      else applyVideo(command);
      if (!state.pendingVideo) {
        clearInterval(state.videoRetry);
        state.videoRetry = null;
      }
    }, 500);
  }

  // ------------------------------------------------------- host sync loop ---

  function startHostLoops() {
    stopHostLoops();
    state.scrollTimer = setInterval(hostTick, 300);
    state.heartbeatTimer = setInterval(hostHeartbeat, 3000);
  }

  function stopHostLoops() {
    if (state.scrollTimer) clearInterval(state.scrollTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.scrollTimer = null;
    state.heartbeatTimer = null;
  }

  function hostTick() {
    if (state.role !== 'host' || !state.url) return;
    if (resolveMode(state.url) === 'youtube') return;
    const doc = getFrameDoc();
    if (!doc) return;
    const scrollY = Math.round(
      doc.scrollingElement?.scrollTop ?? doc.documentElement?.scrollTop ?? 0
    );
    const title = doc.title || '';
    if (Math.abs(scrollY - state.lastSentScroll) > 24 || title !== state.lastSentTitle) {
      state.lastSentScroll = scrollY;
      state.lastSentTitle = title;
      state.socket.emit('browser:state', { scrollY, title });
      if (title) {
        state.title = title;
        el.pageTitle.textContent = title;
      }
    }
  }

  function hostHeartbeat() {
    if (state.role !== 'host' || !state.url) return;
    const resolved = resolveMode(state.url);
    let video = state.lastVideo;
    let scrollY = 0;

    if (resolved === 'youtube') {
      if (ytPlayer && ytReady) {
        try {
          const playerState = ytPlayer.getPlayerState();
          video = {
            time: ytPlayer.getCurrentTime() || 0,
            paused: playerState !== 1,
            rate: ytPlayer.getPlaybackRate() || 1,
          };
        } catch {
          /* ignore */
        }
      }
    } else {
      const doc = getFrameDoc();
      if (doc) {
        const media = doc.querySelector('video,audio');
        if (media) {
          video = {
            time: media.currentTime || 0,
            paused: Boolean(media.paused),
            rate: media.playbackRate || 1,
          };
        }
        scrollY = Math.round(
          doc.scrollingElement?.scrollTop ?? doc.documentElement?.scrollTop ?? 0
        );
      }
    }

    state.lastVideo = video;
    state.socket.emit('video:heartbeat', { url: state.url, ...video, scrollY });
  }

  // ------------------------------------------------------ remote handlers ---

  function onRemoteNavigate(payload) {
    if (state.role === 'host') return;
    if (payload?.mode && MODES.has(payload.mode)) {
      state.mode = payload.mode;
      el.modeSelect.value = payload.mode;
    }
    const url = normalizeUrl(payload?.url);
    if (!url || url === state.url) return;
    state.url = url;
    loadContent(url);
  }

  function onRemoteState(payload) {
    if (state.role === 'host') return;
    if (typeof payload?.title === 'string' && payload.title) {
      state.title = payload.title;
      el.pageTitle.textContent = payload.title;
    }
    if (typeof payload?.scrollY === 'number' && resolveMode(state.url) !== 'youtube') {
      const doc = getFrameDoc();
      if (!doc) return;
      const current = doc.scrollingElement?.scrollTop ?? doc.documentElement?.scrollTop ?? 0;
      if (Math.abs(current - payload.scrollY) > 40) applyScroll(doc, payload.scrollY);
    }
  }

  function onRemoteVideo(command) {
    if (state.role === 'host' || !command) return;
    state.lastVideo = {
      time: command.time,
      paused: command.paused,
      rate: command.rate,
    };
    if (resolveMode(state.url) === 'youtube') applyYt(command);
    else applyVideo(command);
  }

  function onRemoteHeartbeat(heartbeat) {
    if (state.role === 'host' || !heartbeat) return;

    if (heartbeat.url && heartbeat.url !== state.url) {
      state.url = heartbeat.url;
      loadContent(heartbeat.url);
      return;
    }

    state.lastVideo = {
      time: heartbeat.time,
      paused: heartbeat.paused,
      rate: heartbeat.rate,
    };

    if (resolveMode(state.url) === 'youtube') {
      if (!ytPlayer || !ytReady) return;
      try {
        if (Math.abs((ytPlayer.getCurrentTime() || 0) - heartbeat.time) > 1.5) {
          ytPlayer.seekTo(heartbeat.time, true);
        }
        const playerState = ytPlayer.getPlayerState();
        if (heartbeat.paused && playerState === 1) ytPlayer.pauseVideo();
        if (!heartbeat.paused && playerState !== 1) ytPlayer.playVideo();
      } catch {
        /* ignore */
      }
      return;
    }

    const doc = getFrameDoc();
    if (!doc) return;
    const media = doc.querySelector('video,audio');
    if (media) {
      try {
        if (Math.abs((media.currentTime || 0) - heartbeat.time) > 1.5) {
          media.currentTime = heartbeat.time;
        }
        if (heartbeat.paused && !media.paused) media.pause();
        if (!heartbeat.paused && media.paused) {
          const promise = media.play();
          if (promise && typeof promise.catch === 'function') {
            promise.catch(() => showAutoplayHint());
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (typeof heartbeat.scrollY === 'number') {
      const current = doc.scrollingElement?.scrollTop ?? doc.documentElement?.scrollTop ?? 0;
      if (Math.abs(current - heartbeat.scrollY) > 60) applyScroll(doc, heartbeat.scrollY);
    }
  }

  function onAgentMessage(event) {
    const data = event.data;
    if (!data || data.source !== 'weiwatch-agent') return;
    if (state.role !== 'host') return;

    if (data.type === 'navigate') {
      const url = normalizeUrl(data.url);
      if (!url || url === state.url) return;
      state.url = url;
      pushHistory(url);
      updateUrlBar();
      state.socket.emit('browser:navigate', { url, mode: state.mode });
      if (!data.soft) loadContent(url);
      return;
    }

    if (data.type === 'video') {
      const command = {
        action: data.action,
        time: Number(data.time) || 0,
        paused: data.paused === true,
        rate: Number(data.rate) || 1,
      };
      state.lastVideo = {
        time: command.time,
        paused: command.paused,
        rate: command.rate,
      };
      state.socket.emit('video:cmd', command);
      return;
    }

    if (data.type === 'ready') {
      if (data.title) {
        state.title = data.title;
        el.pageTitle.textContent = data.title;
      }
      state.socket.emit('browser:state', { scrollY: 0, title: data.title || '' });
    }
  }

  // ---------------------------------------------------------------- chat ----

  function appendMessage(message, options = {}) {
    if (!message) return;
    const node = document.createElement('div');

    if (message.type === 'system') {
      node.className = 'msg msg-system';
      node.textContent = message.text;
    } else {
      node.className = 'msg';
      if (message.username && state.me && message.username === state.me.username) {
        node.classList.add('msg-mine');
      }
      const head = document.createElement('div');
      head.className = 'msg-head';
      const name = document.createElement('span');
      name.className = 'msg-name';
      name.textContent = message.displayName || message.username || 'Unknown';
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = formatTime(message.ts);
      head.append(name, time);

      const body = document.createElement('div');
      body.className = 'msg-body';
      body.textContent = message.text;
      node.append(head, body);
    }

    el.messages.appendChild(node);
    if (options.scroll !== false) el.messages.scrollTop = el.messages.scrollHeight;
  }

  function renderMessages(messages) {
    el.messages.innerHTML = '';
    for (const message of messages) appendMessage(message, { scroll: false });
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function renderMembers(members) {
    state.members = members || [];
    el.members.innerHTML = '';
    el.memberCount.textContent = String(state.members.length);

    for (const member of state.members) {
      const item = document.createElement('li');
      item.className = 'member';

      const avatar = document.createElement('span');
      avatar.className = 'avatar avatar-sm';
      avatar.textContent = initials(member.displayName);

      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = member.displayName;

      item.append(avatar, name);

      if (member.role === 'host') {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Host';
        item.append(badge);
      }

      if (state.me && member.username === state.me.username) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = 'you';
        item.append(you);
      }

      el.members.appendChild(item);
    }
  }

  // --------------------------------------------------------------- rooms ----

  function enterRoom(response) {
    state.joined = true;
    state.room = response.code;
    state.role = response.role;
    state.mode = MODES.has(response.state?.mode) ? response.state.mode : 'auto';
    state.url = response.state?.url || '';
    state.title = response.state?.title || '';
    state.lastVideo = response.state?.video || { time: 0, paused: true, rate: 1 };
    state.history = state.url ? [state.url] : [];
    state.historyIndex = state.history.length - 1;
    state.lastSentScroll = -1;
    state.lastSentTitle = '';
    state.pendingVideo = null;

    el.lobby.hidden = true;
    el.app.hidden = false;
    el.roomChip.hidden = false;
    el.roomCode.textContent = response.code;
    el.modeSelect.value = state.mode;
    el.pageTitle.textContent = state.title || 'No page loaded';

    const isHost = state.role === 'host';
    el.urlInput.disabled = !isHost;
    el.go.disabled = !isHost;
    el.modeGroup.hidden = !isHost;
    el.viewerBadge.hidden = isHost;

    document.title = `Room ${response.code} - WeiWatch`;
    window.history.replaceState(null, '', `?room=${response.code}`);

    renderMembers(response.members || []);
    renderMessages(response.messages || []);

    if (isHost) {
      startHostLoops();
      if (state.url) loadContent(state.url);
      else showEmptyState(true);
    } else {
      stopHostLoops();
      if (state.url) {
        state.pendingVideo = state.lastVideo;
        loadContent(state.url);
      } else {
        showEmptyState(false);
      }
    }

    updateUrlBar();
    updateNavButtons();
    updateSyncNote();
    el.chatInput.focus();
  }

  function joinRoom(code, hostKey) {
    state.socket.emit('room:join', { code, hostKey }, (response) => {
      if (!response?.ok) {
        showLobby(response?.error || 'Could not join the room.');
        return;
      }
      if (response.role === 'host' && response.hostKey) {
        state.hostKey = response.hostKey;
        localStorage.setItem(`ww:host:${response.code}`, response.hostKey);
      }
      enterRoom(response);
    });
  }

  function rejoin() {
    state.socket.emit(
      'room:join',
      { code: state.room, hostKey: state.hostKey || undefined },
      (response) => {
        if (!response?.ok) {
          toast(response?.error || 'Could not rejoin the room.');
          showLobby(response?.error);
          return;
        }
        if (response.role === 'host' && response.hostKey) {
          state.hostKey = response.hostKey;
          localStorage.setItem(`ww:host:${response.code}`, response.hostKey);
        }
        state.role = response.role;
        if (response.state?.mode && MODES.has(response.state.mode)) {
          state.mode = response.state.mode;
          el.modeSelect.value = state.mode;
        }
        const isHost = state.role === 'host';
        el.urlInput.disabled = !isHost;
        el.go.disabled = !isHost;
        el.modeGroup.hidden = !isHost;
        el.viewerBadge.hidden = isHost;
        renderMembers(response.members || []);
        if (isHost) startHostLoops();
        else stopHostLoops();
        if (response.state?.url && response.state.url !== state.url) {
          state.url = response.state.url;
          loadContent(state.url);
        }
        updateNavButtons();
        updateSyncNote();
      }
    );
  }

  function autoJoin() {
    if (state.joined) return;
    const params = new URLSearchParams(window.location.search);
    const code = (params.get('room') || '').trim().toUpperCase();
    if (!code) {
      showLobby();
      return;
    }
    const hostKey = localStorage.getItem(`ww:host:${code}`) || undefined;
    joinRoom(code, hostKey);
  }

  // ---------------------------------------------------------------- init ----

  function bindUi() {
    el.createRoom.addEventListener('click', () => {
      el.createRoom.disabled = true;
      state.socket.emit('room:create', (response) => {
        el.createRoom.disabled = false;
        if (!response?.ok) {
          lobbyError(response?.error || 'Could not create a room.');
          return;
        }
        state.hostKey = response.hostKey;
        localStorage.setItem(`ww:host:${response.code}`, response.hostKey);
        enterRoom(response);
      });
    });

    el.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = el.joinCode.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) {
        lobbyError('Enter a valid room code.');
        return;
      }
      joinRoom(code);
    });

    el.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = el.chatInput.value.trim();
      if (!text) return;
      el.chatInput.value = '';
      state.socket.emit('chat:send', { text }, (response) => {
        if (response && !response.ok) toast(response.error || 'Message not sent.');
      });
    });

    el.urlForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (state.role !== 'host') return;
      navigate(el.urlInput.value);
    });

    el.back.addEventListener('click', goBack);
    el.forward.addEventListener('click', goForward);
    el.reload.addEventListener('click', reloadContent);

    el.modeSelect.addEventListener('change', () => {
      state.mode = MODES.has(el.modeSelect.value) ? el.modeSelect.value : 'auto';
      if (state.role !== 'host') return;
      if (state.url) {
        loadContent(state.url);
        state.socket.emit('browser:navigate', { url: state.url, mode: state.mode });
      }
      updateSyncNote();
    });

    el.copyLink.addEventListener('click', async () => {
      const link = `${window.location.origin}/app?room=${state.room}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied');
      } catch {
        toast(link);
      }
    });

    el.logout.addEventListener('click', async () => {
      try {
        state.socket?.emit('room:leave');
      } catch {
        /* ignore */
      }
      try {
        await fetch('/api/logout', { method: 'POST' });
      } catch {
        /* ignore */
      }
      window.location.replace('/');
    });

    el.autoplayHint.addEventListener('click', () => {
      el.autoplayHint.hidden = true;
      if (resolveMode(state.url) === 'youtube' && ytPlayer && ytReady) {
        try {
          ytPlayer.playVideo();
        } catch {
          /* ignore */
        }
        if (state.pendingVideo) applyYt(state.pendingVideo);
        return;
      }
      applyVideo(
        state.pendingVideo || {
          action: 'play',
          time: state.lastVideo.time,
          paused: false,
          rate: state.lastVideo.rate,
        }
      );
    });

    el.frame.addEventListener('load', () => {
      if (!state.url) return;
      if (resolveMode(state.url) === 'youtube') return;
      el.frameLoading.hidden = true;
      if (state.role === 'viewer' && state.pendingVideo) applyVideo(state.pendingVideo);
    });

    window.addEventListener('message', onAgentMessage);
  }

  function connect() {
    const socket = io({ withCredentials: true });
    state.socket = socket;

    socket.on('connect', () => {
      setStatus('online');
      if (state.joined && state.room) rejoin();
      else autoJoin();
    });

    socket.on('disconnect', () => setStatus('offline'));
    socket.io.on('reconnect_attempt', () => setStatus('connecting'));

    socket.on('connect_error', (error) => {
      if (String(error?.message || '').includes('unauthorized')) {
        window.location.replace('/');
        return;
      }
      setStatus('offline');
    });

    socket.on('chat:message', (message) => appendMessage(message));
    socket.on('room:members', (members) => renderMembers(members));

    socket.on('room:host-away', ({ graceMs }) => {
      if (state.role === 'host') return;
      setStatus('host away');
      appendMessage({
        type: 'system',
        text: `The host disconnected. Waiting up to ${Math.round(
          (graceMs || 0) / 1000
        )}s for them to come back...`,
        ts: Date.now(),
      });
    });

    socket.on('room:closed', ({ reason }) => {
      appendMessage({
        type: 'system',
        text: `Room closed: ${reason || 'the host left'}`,
        ts: Date.now(),
      });
      toast('Room closed');
      setTimeout(() => {
        window.location.href = '/app';
      }, 1600);
    });

    socket.on('browser:navigate', onRemoteNavigate);
    socket.on('browser:state', onRemoteState);
    socket.on('video:cmd', onRemoteVideo);
    socket.on('video:heartbeat', onRemoteHeartbeat);
  }

  async function init() {
    cacheElements();
    bindUi();

    try {
      const response = await fetch('/api/me', { credentials: 'same-origin' });
      if (!response.ok) {
        window.location.replace('/');
        return;
      }
      state.me = await response.json();
    } catch {
      window.location.replace('/');
      return;
    }

    el.userName.textContent = state.me.displayName;
    el.avatar.textContent = initials(state.me.displayName);
    connect();
  }

  init();
})();
