import crypto from 'node:crypto';
import { config } from './config.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function roomChannel(code) {
  return `room:${code}`;
}

function randomCode() {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

export function memberList(room) {
  return [...room.members.values()].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'host' ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

export function pushMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > config.maxChatHistory) {
    room.messages.splice(0, room.messages.length - config.maxChatHistory);
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  get size() {
    return this.rooms.size;
  }

  create(hostUser) {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));

    const room = {
      code,
      hostKey: crypto.randomBytes(24).toString('base64url'),
      host: {
        username: hostUser.username,
        displayName: hostUser.displayName,
        socketId: null,
      },
      members: new Map(),
      state: {
        url: '',
        mode: 'auto',
        title: '',
        scrollY: 0,
        video: { time: 0, paused: true, rate: 1 },
        share: false,
        updatedAt: Date.now(),
      },
      messages: [],
      hostTimer: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '').trim().toUpperCase()) || null;
  }

  delete(code) {
    const room = this.rooms.get(code);
    if (room?.hostTimer) clearTimeout(room.hostTimer);
    this.rooms.delete(code);
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const empty = room.members.size === 0;
      const stale = now - room.lastActivity > config.roomIdleMs;
      if ((empty && now - room.lastActivity > 10 * 60 * 1000) || stale) {
        this.delete(code);
      }
    }
  }
}
