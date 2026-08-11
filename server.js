/**
 * server.js
 * Server-authoritative-ish multiplayer relay for Ardadashak.
 * The server owns rooms, the shared seed, room-browser listing, the
 * global (all-time) leaderboard, and player bookkeeping. Actual
 * physics/collision stays client-side (client-prediction style) — the
 * server just relays state at a fixed rate and settles disputes like
 * "who's the host" / "is this room full".
 *
 * NOT: Bu sunucu istemciden (InfinityFree'de barınan statik dosyalar)
 * BAĞIMSIZ çalışır — sadece Socket.IO / REST API sağlar. Statik dosya
 * servisi yapmaz; istemci ayrı bir hostta (InfinityFree htdocs) durur ve
 * js/network.js içindeki SERVER_URL üzerinden bu sunucuya bağlanır.
 */

const cors = require('cors');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const rooms = new RoomManager();

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'ardadashak-server', time: Date.now(), rooms: rooms.rooms.size });
});

// Optional plain REST mirrors of the socket endpoints below — handy for
// quick debugging or for a future non-socket dashboard. The game itself
// talks to the server exclusively over Socket.IO.
app.get('/rooms', (req, res) => res.json(rooms.listPublicRooms()));
app.get('/leaderboard', (req, res) => res.json(rooms.getTopScores(10)));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const leaderboardTimers = new Map(); // code -> interval handle

function broadcastRoom(room) {
    io.to(room.code).emit('room_update', publicRoom(room));
}

function publicRoom(room) {
    return {
        code: room.code,
        name: room.name,
        maxPlayers: room.maxPlayers,
        difficulty: room.difficulty,
        privacy: room.privacy,
        started: room.started,
        players: room.players
    };
}

function broadcastRoomList() {
    io.emit('rooms_list', rooms.listPublicRooms());
}

function startLeaderboardBroadcast(room) {
    stopLeaderboardBroadcast(room.code);
    const handle = setInterval(() => {
        const r = rooms.rooms.get(room.code);
        if (!r) { stopLeaderboardBroadcast(room.code); return; }
        io.to(room.code).emit('leaderboard', r.players);
    }, 500);
    leaderboardTimers.set(room.code, handle);
}
function stopLeaderboardBroadcast(code) {
    const h = leaderboardTimers.get(code);
    if (h) { clearInterval(h); leaderboardTimers.delete(code); }
}

io.on('connection', (socket) => {

    socket.on('create_room', (opts = {}) => {
        const room = rooms.createRoom(socket.id, opts.name, opts);
        socket.join(room.code);
        broadcastRoom(room);
        broadcastRoomList();
    });

    socket.on('join_room', ({ code, name } = {}) => {
        const result = rooms.joinRoom(socket.id, code, name);
        if (result.error) return socket.emit('room_error', result.error);
        socket.join(result.room.code);
        broadcastRoom(result.room);
        broadcastRoomList();
    });

    socket.on('quick_join', ({ name } = {}) => {
        const result = rooms.quickJoin(socket.id, name);
        if (result.error) return socket.emit('room_error', result.error);
        socket.join(result.room.code);
        broadcastRoom(result.room);
        broadcastRoomList();
    });

    // Server Browser: client asks for the current public room list. Uses a
    // Socket.IO ack callback so it behaves like a simple request/response.
    socket.on('list_rooms', (opts, cb) => {
        const fn = typeof opts === 'function' ? opts : cb;
        const list = rooms.listPublicRooms();
        if (typeof fn === 'function') fn(list);
    });

    socket.on('start_game', () => {
        const result = rooms.startGame(socket.id);
        if (result.error) return socket.emit('room_error', result.error);
        io.to(result.room.code).emit('game_started', { seed: result.room.seed, startTime: result.room.startTime });
        broadcastRoom(result.room);
        broadcastRoomList();
        startLeaderboardBroadcast(result.room);
    });

    socket.on('leave_room', () => {
        const before = rooms.getRoomBySocket(socket.id);
        const code = before ? before.code : null;
        const result = rooms.leaveRoom(socket.id);
        if (code) {
            socket.leave(code);
            io.to(code).emit('player_left', { id: socket.id });
            if (result && result.room) broadcastRoom(result.room);
            else stopLeaderboardBroadcast(code);
            broadcastRoomList();
        }
    });

    // Real-time gameplay state relay (throttled client-side to ~12Hz already)
    socket.on('player_state', (data) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        const p = room.players[socket.id];
        if (p) {
            p.score = data.score || 0;
            p.alive = data.alive !== false;
            p.eliminated = !p.alive;
        }
        socket.to(room.code).volatile.emit('player_state', Object.assign({ id: socket.id }, data));
    });

    socket.on('player_eliminated', () => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        const p = room.players[socket.id];
        if (p) { p.alive = false; p.eliminated = true; }
        io.to(room.code).emit('leaderboard', room.players);
    });

    socket.on('emp_attack', ({ targetId } = {}) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room || !targetId || !room.players[targetId]) return;
        const attacker = room.players[socket.id];
        io.to(targetId).emit('emp_hit', { from: attacker ? attacker.name : 'Rakip' });
    });

    socket.on('chat_emoji', ({ emoji } = {}) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        socket.to(room.code).emit('chat_emoji', { id: socket.id, emoji });
    });

    // ---- Global (all-time) leaderboard ----
    socket.on('submit_score', (data = {}) => {
        const top = rooms.submitScore(data);
        io.emit('global_leaderboard', top);
    });
    socket.on('get_leaderboard', (opts, cb) => {
        const fn = typeof opts === 'function' ? opts : cb;
        if (typeof fn === 'function') fn(rooms.getTopScores(10));
    });

    socket.on('ping_check', (sentAt) => {
        socket.emit('pong_check', sentAt);
    });

    socket.on('disconnect', () => {
        const before = rooms.getRoomBySocket(socket.id);
        const code = before ? before.code : null;
        const result = rooms.leaveRoom(socket.id);
        if (code) {
            io.to(code).emit('player_left', { id: socket.id });
            if (result && result.room) broadcastRoom(result.room);
            else stopLeaderboardBroadcast(code);
            broadcastRoomList();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Ardadashak multiplayer server running on port ${PORT}`);
});
