import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { Server } from 'socket.io';
import { config, ROOT } from './config.js';
import {
  findUser,
  verifyPassword,
  signSession,
  verifySession,
  parseCookies,
  sessionCookie,
  clearCookie,
} from './auth.js';
import { RoomManager, roomChannel, memberList, pushMessage } from './rooms.js';
import { proxyRouter } from './proxy.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const rooms = new RoomManager();
const app = express();

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!req.path.startsWith('/proxy')) res.setHeader('X-Frame-Options', 'DENY');
  next();
});

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return verifySession(cookies[config.cookieName]);
}

// --- login throttling -------------------------------------------------------
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function loginKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isLoginBlocked(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { first: now, count: 1 });
  } else {
    entry.count += 1;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, 60_000).unref();

// --- pages ------------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get('/', (req, res) => {
  if (getSession(req)) return res.redirect('app');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/app', (req, res) => {
  if (!getSession(req)) return res.redirect('./');
  res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
});

app.get('/app.html', (req, res) => res.redirect('app'));

// --- auth API ---------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const key = loginKey(req);
  if (isLoginBlocked(key)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  let user;
  try {
    user = findUser(username);
  } catch (err) {
    console.error(`[weiwatch] ${err.message}`);
    return res.status(500).json({ error: 'Server credentials are misconfigured.' });
  }

  if (!user || !verifyPassword(user, password)) {
    recordLoginFailure(key);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  loginAttempts.delete(key);
  res.setHeader('Set-Cookie', sessionCookie(signSession(user)));
  res.json({ ok: true, user: { username: user.username, displayName: user.displayName } });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  res.json({ username: session.u, displayName: session.n });
});

// --- proxy (authenticated) --------------------------------------------------
app.use('/proxy', (req, res, next) => {
  if (!getSession(req)) return res.status(401).type('text/plain').send('Sign in required.');
  next();
});
app.use(proxyRouter);

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      } else if (filePath.endsWith('sync-agent.js') || filePath.endsWith('js/app.js')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

// --- realtime ---------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  const session = verifySession(cookies[config.cookieName]);
  if (!session) return next(new Error('unauthorized'));
  socket.data.user = session;
  next();
});

const VIDEO_ACTIONS = new Set(['play', 'pause', 'seek', 'rate', 'ended', 'sync']);
const MODES = new Set(['auto', 'proxy', 'direct']);

function getRoom(socket) {
  return socket.data.roomCode ? rooms.get(socket.data.roomCode) : null;
}

function isHost(socket, room) {
  return Boolean(room) && room.host.socketId === socket.id;
}

function broadcastMembers(room) {
  io.to(roomChannel(room.code)).emit('room:members', memberList(room));
}

function systemMessage(room, text) {
  const message = { id: crypto.randomUUID(), type: 'system', text, ts: Date.now() };
  pushMessage(room, message);
  io.to(roomChannel(room.code)).emit('chat:message', message);
}

function sanitizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const chatBuckets = new Map();

function allowChat(socket) {
  const now = Date.now();
  const bucket = chatBuckets.get(socket.id) || { tokens: 5, updated: now };
  bucket.tokens = Math.min(5, bucket.tokens + (now - bucket.updated) / 1000);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    chatBuckets.set(socket.id, bucket);
    return false;
  }
  bucket.tokens -= 1;
  chatBuckets.set(socket.id, bucket);
  return true;
}

io.on('connection', (socket) => {
  const user = socket.data.user;

  socket.on('room:create', (...args) => {
    const ack = args.find((value) => typeof value === 'function');
    if (!ack) return;
    if (socket.data.roomCode) return ack({ ok: false, error: 'You are already in a room.' });

    const room = rooms.create({ username: user.u, displayName: user.n });
    room.host.socketId = socket.id;
    room.members.set(socket.id, {
      id: socket.id,
      username: user.u,
      displayName: user.n,
      role: 'host',
    });
    socket.join(roomChannel(room.code));
    socket.data.roomCode = room.code;
    socket.data.role = 'host';

    ack({
      ok: true,
      code: room.code,
      hostKey: room.hostKey,
      role: 'host',
      state: room.state,
      members: memberList(room),
      messages: room.messages,
    });
  });

  socket.on('room:join', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const code = String(payload?.code ?? '').trim().toUpperCase();
    const hostKey = typeof payload?.hostKey === 'string' ? payload.hostKey : '';
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'Room not found. Check the code.' });
    if (socket.data.roomCode && socket.data.roomCode !== code) {
      return ack({ ok: false, error: 'You are already in another room.' });
    }

    const wantsHost =
      Boolean(hostKey) && room.host.username === user.u && safeEqual(hostKey, room.hostKey);

    if (wantsHost) {
      if (room.host.socketId && room.host.socketId !== socket.id) {
        const previous = io.sockets.sockets.get(room.host.socketId);
        if (previous) {
          previous.emit('room:closed', { reason: 'The host reconnected from another tab.' });
          previous.leave(roomChannel(room.code));
          previous.data.roomCode = null;
        }
      }
      room.host.socketId = socket.id;
      if (room.hostTimer) {
        clearTimeout(room.hostTimer);
        room.hostTimer = null;
      }
      socket.data.role = 'host';
    } else {
      socket.data.role = 'viewer';
    }

    socket.join(roomChannel(room.code));
    socket.data.roomCode = room.code;
    room.members.set(socket.id, {
      id: socket.id,
      username: user.u,
      displayName: user.n,
      role: socket.data.role,
    });
    room.lastActivity = Date.now();

    ack({
      ok: true,
      code: room.code,
      role: socket.data.role,
      state: room.state,
      members: memberList(room),
      messages: room.messages,
    });
    broadcastMembers(room);
    if (!wantsHost) systemMessage(room, `${user.n} joined the room`);
  });

  socket.on('room:leave', () => leaveRoom(socket, true));

  socket.on('chat:send', (payload, ack) => {
    const room = getRoom(socket);
    if (!room) return ack?.({ ok: false, error: 'You are not in a room.' });
    if (!allowChat(socket)) return ack?.({ ok: false, error: 'Slow down a little.' });

    const text = String(payload?.text ?? '')
      .replace(/\s+$/, '')
      .slice(0, config.maxMessageLength);
    if (!text.trim()) return ack?.({ ok: false, error: 'Message is empty.' });

    const message = {
      id: crypto.randomUUID(),
      type: 'chat',
      username: user.u,
      displayName: user.n,
      text,
      ts: Date.now(),
    };
    pushMessage(room, message);
    io.to(roomChannel(room.code)).emit('chat:message', message);
    ack?.({ ok: true });
  });

  socket.on('browser:navigate', (payload) => {
    const room = getRoom(socket);
    if (!isHost(socket, room)) return;
    const url = sanitizeUrl(payload?.url);
    if (!url) return;
    const mode = MODES.has(payload?.mode) ? payload.mode : 'auto';

    room.state.url = url;
    room.state.mode = mode;
    room.state.updatedAt = Date.now();
    room.lastActivity = Date.now();
    socket.to(roomChannel(room.code)).emit('browser:navigate', { url, mode });
  });

  socket.on('browser:state', (payload) => {
    const room = getRoom(socket);
    if (!isHost(socket, room)) return;
    const scrollY = clampNumber(payload?.scrollY, 0, 5_000_000, 0);
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, 200) : '';

    room.state.scrollY = scrollY;
    if (title) room.state.title = title;
    room.state.updatedAt = Date.now();
    socket.to(roomChannel(room.code)).emit('browser:state', { scrollY, title });
  });

  socket.on('video:cmd', (payload) => {
    const room = getRoom(socket);
    if (!isHost(socket, room)) return;
    const command = {
      action: VIDEO_ACTIONS.has(payload?.action) ? payload.action : 'sync',
      time: clampNumber(payload?.time, 0, 60 * 60 * 24, 0),
      paused: payload?.paused === true,
      rate: clampNumber(payload?.rate, 0.25, 4, 1),
    };
    room.state.video = { time: command.time, paused: command.paused, rate: command.rate };
    room.state.updatedAt = Date.now();
    socket.to(roomChannel(room.code)).emit('video:cmd', command);
  });

  socket.on('video:heartbeat', (payload) => {
    const room = getRoom(socket);
    if (!isHost(socket, room)) return;
    const heartbeat = {
      url: sanitizeUrl(payload?.url) || room.state.url,
      time: clampNumber(payload?.time, 0, 60 * 60 * 24, 0),
      paused: payload?.paused === true,
      rate: clampNumber(payload?.rate, 0.25, 4, 1),
      scrollY: clampNumber(payload?.scrollY, 0, 5_000_000, 0),
    };
    room.state.video = {
      time: heartbeat.time,
      paused: heartbeat.paused,
      rate: heartbeat.rate,
    };
    room.state.scrollY = heartbeat.scrollY;
    room.state.updatedAt = Date.now();
    room.lastActivity = Date.now();
    socket.to(roomChannel(room.code)).emit('video:heartbeat', heartbeat);
  });

  socket.on('browser:request-state', (...args) => {
    const ack = args.find((value) => typeof value === 'function');
    const room = getRoom(socket);
    if (!room) return ack?.({ ok: false });
    ack?.({ ok: true, state: room.state });
  });

  // --- live tab sharing (WebRTC signaling only) ----------------------------
  socket.on('share:start', () => {
    const room = getRoom(socket);
    if (!isHost(socket, room)) return;
    room.state.share = true;
    socket.to(roomChannel(room.code)).emit('share:started', { hostId: socket.id });
  });

  socket.on('share:stop', () => {
    const room = getRoom(socket);
    if (!isHost(socket, room)) return;
    room.state.share = false;
    socket.to(roomChannel(room.code)).emit('share:stopped');
  });

  socket.on('webrtc:offer', (payload) => {
    const room = getRoom(socket);
    if (!isHost(socket, room)) return;
    const target = io.sockets.sockets.get(String(payload?.to || ''));
    if (!target || target.data.roomCode !== room.code) return;
    target.emit('webrtc:offer', { from: socket.id, sdp: payload?.sdp });
  });

  socket.on('webrtc:answer', (payload) => {
    const room = getRoom(socket);
    if (!room || socket.data.role !== 'viewer') return;
    const host = io.sockets.sockets.get(room.host.socketId);
    if (!host) return;
    host.emit('webrtc:answer', { from: socket.id, sdp: payload?.sdp });
  });

  socket.on('webrtc:ice', (payload) => {
    const room = getRoom(socket);
    if (!room) return;
    if (socket.data.role === 'host') {
      const target = io.sockets.sockets.get(String(payload?.to || ''));
      if (!target || target.data.roomCode !== room.code) return;
      target.emit('webrtc:ice', { from: socket.id, candidate: payload?.candidate });
      return;
    }
    const host = io.sockets.sockets.get(room.host.socketId);
    if (!host) return;
    host.emit('webrtc:ice', { from: socket.id, candidate: payload?.candidate });
  });

  socket.on('disconnect', () => {
    chatBuckets.delete(socket.id);
    leaveRoom(socket, false);
  });
});

function leaveRoom(socket, notify) {
  const room = getRoom(socket);
  if (!room) return;

  const wasHost = room.host.socketId === socket.id;
  const displayName = socket.data.user?.n || 'Someone';

  room.members.delete(socket.id);
  socket.leave(roomChannel(room.code));
  socket.data.roomCode = null;
  socket.data.role = null;
  room.lastActivity = Date.now();

  if (wasHost) {
    if (room.state.share) {
      room.state.share = false;
      io.to(roomChannel(room.code)).emit('share:stopped');
    }
    room.host.socketId = null;
    io.to(roomChannel(room.code)).emit('room:host-away', { graceMs: config.hostGraceMs });
    if (room.hostTimer) clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      io.to(roomChannel(room.code)).emit('room:closed', { reason: 'The host did not return.' });
      for (const memberId of room.members.keys()) {
        const member = io.sockets.sockets.get(memberId);
        if (member) {
          member.leave(roomChannel(room.code));
          member.data.roomCode = null;
        }
      }
      rooms.delete(room.code);
    }, config.hostGraceMs);
    room.hostTimer.unref?.();
  } else if (notify) {
    systemMessage(room, `${displayName} left the room`);
  }

  broadcastMembers(room);
}

server.listen(config.port, config.host, () => {
  console.log(`[weiwatch] listening on http://${config.host}:${config.port}`);
  try {
    const users = findUser('__probe__');
    void users;
  } catch (err) {
    console.warn(`[weiwatch] ${err.message}`);
  }
});
