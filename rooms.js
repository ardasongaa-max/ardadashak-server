/**
 * rooms.js
 * Pure in-memory room/lobby state + global (all-time) leaderboard storage.
 * No socket.io references here — keeps this testable and keeps server.js
 * focused on wiring events.
 */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const MAX_GLOBAL_ENTRIES = 100;
const GLOBAL_LEADERBOARD_TOP = 10;

function genCode() {
    let code = 'ARD-';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return code;
}

class RoomManager {
    constructor() {
        this.rooms = new Map();        // code -> room
        this.socketToRoom = new Map(); // socketId -> code
        this.globalLeaderboard = [];   // [{name, score, character, ts}] sorted desc by score
    }

    createRoom(socketId, name, opts) {
        let code;
        do { code = genCode(); } while (this.rooms.has(code));

        const room = {
            code,
            name: safeRoomName(opts.roomName, name),
            hostId: socketId,
            maxPlayers: Math.min(Math.max(parseInt(opts.maxPlayers, 10) || 6, 2), 8),
            difficulty: ['easy', 'normal', 'hard'].includes(opts.difficulty) ? opts.difficulty : 'normal',
            privacy: opts.privacy === 'private' ? 'private' : 'public',
            seed: null,
            startTime: null,
            started: false,
            createdAt: Date.now(),
            players: {}
        };
        room.players[socketId] = { id: socketId, name: safeName(name), host: true, score: 0, alive: true };
        this.rooms.set(code, room);
        this.socketToRoom.set(socketId, code);
        return room;
    }

    joinRoom(socketId, code, name) {
        const room = this.rooms.get((code || '').toUpperCase());
        if (!room) return { error: 'Oda bulunamadı.' };
        if (Object.keys(room.players).length >= room.maxPlayers) return { error: 'Oda dolu.' };
        if (room.started) return { error: 'Oyun zaten başladı.' };
        room.players[socketId] = { id: socketId, name: safeName(name), host: false, score: 0, alive: true };
        this.socketToRoom.set(socketId, room.code);
        return { room };
    }

    quickJoin(socketId, name) {
        // pick the fullest-but-not-full open public room so players cluster together
        let best = null;
        for (const room of this.rooms.values()) {
            if (room.privacy === 'public' && !room.started && Object.keys(room.players).length < room.maxPlayers) {
                if (!best || Object.keys(room.players).length > Object.keys(best.players).length) best = room;
            }
        }
        if (best) return this.joinRoom(socketId, best.code, name);
        // nothing open — spin up a fresh public room
        const room = this.createRoom(socketId, name, { maxPlayers: 6, difficulty: 'normal', privacy: 'public' });
        return { room };
    }

    startGame(socketId) {
        const room = this.getRoomBySocket(socketId);
        if (!room) return { error: 'Oda bulunamadı.' };
        if (room.hostId !== socketId) return { error: 'Sadece host oyunu başlatabilir.' };
        room.seed = Math.floor(Math.random() * 1e9).toString(36) + Date.now().toString(36);
        room.startTime = Date.now() + 1500; // small buffer so all clients are ready
        room.started = true;
        Object.values(room.players).forEach(p => { p.score = 0; p.alive = true; });
        return { room };
    }

    leaveRoom(socketId) {
        const room = this.getRoomBySocket(socketId);
        if (!room) return null;
        delete room.players[socketId];
        this.socketToRoom.delete(socketId);

        if (Object.keys(room.players).length === 0) {
            this.rooms.delete(room.code);
            return { room: null, code: room.code };
        }
        if (room.hostId === socketId) {
            const nextHost = Object.keys(room.players)[0];
            room.hostId = nextHost;
            room.players[nextHost].host = true;
        }
        return { room };
    }

    getRoomBySocket(socketId) {
        const code = this.socketToRoom.get(socketId);
        return code ? this.rooms.get(code) : null;
    }

    // ---- Server Browser ----
    // Public, not-yet-started rooms, newest first.
    listPublicRooms() {
        return Array.from(this.rooms.values())
            .filter(r => r.privacy === 'public' && !r.started)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(r => ({
                code: r.code,
                name: r.name,
                players: Object.keys(r.players).length,
                maxPlayers: r.maxPlayers,
                difficulty: r.difficulty
            }));
    }

    // ---- Global Leaderboard (all-time, in-memory) ----
    submitScore(entry) {
        const clean = {
            name: safeName(entry.name),
            score: Math.max(0, Math.floor(Number(entry.score) || 0)),
            character: String(entry.character || 'neon_runner').slice(0, 32),
            mode: entry.mode === 'multiplayer' ? 'multiplayer' : 'solo',
            ts: Date.now()
        };
        if (clean.score <= 0) return this.getTopScores();
        this.globalLeaderboard.push(clean);
        this.globalLeaderboard.sort((a, b) => b.score - a.score);
        if (this.globalLeaderboard.length > MAX_GLOBAL_ENTRIES) {
            this.globalLeaderboard.length = MAX_GLOBAL_ENTRIES;
        }
        return this.getTopScores();
    }

    getTopScores(limit) {
        return this.globalLeaderboard.slice(0, limit || GLOBAL_LEADERBOARD_TOP);
    }
}

function safeName(name) {
    const n = String(name || '').trim().slice(0, 14);
    return n || ('Player' + Math.floor(Math.random() * 999));
}

function safeRoomName(roomName, hostName) {
    const n = String(roomName || '').trim().slice(0, 24);
    if (n) return n;
    const h = String(hostName || '').trim().slice(0, 14) || 'Oyuncu';
    return h + "'nin Odası";
}

module.exports = { RoomManager };
