#!/usr/bin/env node
/**
 * Optional signaling relay.
 *
 * The booth itself is a static Astro site — this file is NOT part of the app.
 * It exists only because WebRTC needs a way for two browsers to find each
 * other before the peer connection takes over. Swap it for any other relay
 * (or point PUBLIC_SIGNALING_URL at your own) and nothing else changes.
 *
 *   npm run relay          # ws://localhost:8787
 *   PUBLIC_SIGNALING_URL=ws://localhost:8787 npm run dev
 *
 * It moves presence and SDP/ICE payloads only. No photos, no accounts, no
 * storage of any kind.
 */

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const MAX_MEMBERS = 2;
const ROOM_TTL = 1000 * 60 * 60 * 6;

/** @type {Map<string, { members: string[], sockets: Map<string, import('ws').WebSocket>, hostId: string, createdAt: number }>} */
const rooms = new Map();

const wss = new WebSocketServer({ port: PORT });

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function sendTo(room, exceptId, message) {
  const entry = rooms.get(room);
  if (!entry) return;
  for (const [id, socket] of entry.sockets) {
    if (id !== exceptId) send(socket, message);
  }
}

function drop(socket) {
  const meta = socket.data;
  if (!meta?.room) return;
  const entry = rooms.get(meta.room);
  if (!entry) return;

  entry.sockets.delete(meta.id);
  entry.members = entry.members.filter((id) => id !== meta.id);
  sendTo(meta.room, meta.id, { t: 'peer-left', peerId: meta.id });

  if (entry.members.length === 0) rooms.delete(meta.room);
  meta.room = null;
}

wss.on('connection', (socket) => {
  const id = randomUUID().slice(0, 8);
  socket.data = { id, room: null };
  send(socket, { t: 'welcome', selfId: id });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    switch (msg.t) {
      case 'create': {
        const room = String(msg.room || '');
        const existing = rooms.get(room);
        if (existing && existing.members.length > 0) {
          send(socket, { t: 'error', code: 'exists' });
          return;
        }
        rooms.set(room, {
          members: [id],
          sockets: new Map([[id, socket]]),
          hostId: id,
          createdAt: Date.now(),
        });
        socket.data.room = room;
        send(socket, { t: 'created', room, role: 'host' });
        return;
      }

      case 'join': {
        const room = String(msg.room || '');
        const entry = rooms.get(room);
        if (!entry) {
          send(socket, { t: 'error', code: 'not-found' });
          return;
        }
        if (entry.members.length >= MAX_MEMBERS) {
          send(socket, { t: 'error', code: 'full' });
          return;
        }
        const role = entry.sockets.has(entry.hostId) ? 'guest' : 'host';
        if (role === 'host') entry.hostId = id;
        entry.members.push(id);
        entry.sockets.set(id, socket);
        socket.data.room = room;
        send(socket, {
          t: 'joined',
          room,
          role,
          peers: entry.members.filter((m) => m !== id),
        });
        sendTo(room, id, { t: 'peer-joined', peerId: id });
        return;
      }

      case 'signal': {
        const room = String(msg.room || socket.data.room || '');
        if (!rooms.has(room)) return;
        sendTo(room, id, { t: 'signal', from: id, data: msg.data });
        return;
      }

      case 'leave':
        drop(socket);
        return;

      default:
        return;
    }
  });

  socket.on('close', () => drop(socket));
  socket.on('error', () => drop(socket));
});

// Sweep rooms nobody ever joined.
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL;
  for (const [code, entry] of rooms) {
    if (entry.members.length === 0 && entry.createdAt < cutoff) rooms.delete(code);
  }
}, 60_000).unref();

console.log(`[photobooth] signaling relay listening on ws://localhost:${PORT}`);
console.log('[photobooth] set PUBLIC_SIGNALING_URL to point the app at it.');
