const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. DETERMINISTIC DAILY CHALLENGE ENGINE ---
const CURATED_PAIRS = [
  { start: "The_Great_Barrier_Reef", target: "Quantum_computing" },
  { start: "Renaissance", target: "Artificial_intelligence" },
  { start: "Cleopatra", target: "Moon_landing" },
  { start: "Coffee", target: "Black_hole" },
  { start: "Ancient_Egypt", target: "Internet" },
  { start: "Samurai", target: "Silicon_Valley" },
  { start: "Leonardo_da_Vinci", target: "Nuclear_power" }
];

function getDailyChallenge() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getUTCFullYear(), 0, 0)) / 1000 / 60 / 60 / 24);
  const pair = CURATED_PAIRS[dayOfYear % CURATED_PAIRS.length];
  return { day: dayOfYear, ...pair };
}

// Global in-memory daily leaderboard
let dailyLeaderboard = [];

app.get('/api/daily', (req, res) => {
  res.json({ daily: getDailyChallenge() });
});

app.get('/api/daily-leaderboard', (req, res) => {
  res.json({ leaderboard: dailyLeaderboard.sort((a, b) => a.clicks - b.clicks || a.timeSeconds - b.timeSeconds).slice(0, 50) });
});

app.post('/api/daily-submit', (req, res) => {
  const { username, clicks, timeSeconds, attempt, route } = req.body;
  if (!username || !clicks || !timeSeconds) return res.status(400).json({ error: "Invalid data" });
  
  dailyLeaderboard.push({
    username,
    clicks,
    timeSeconds,
    attempt: attempt || 1,
    route: route || [],
    timestamp: Date.now()
  });
  res.json({ success: true });
});

// --- 2. MULTIPLAYER ROOM & SYNC ENGINE ---
const rooms = new Map();

io.on('connection', (socket) => {
  // Create Room
  socket.on('create_room', ({ username, rules, startPage, targetPage }) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    const daily = getDailyChallenge();

    const room = {
      id: roomId,
      hostId: socket.id,
      status: 'LOBBY', // LOBBY, RACING, FINISHED
      startPage: startPage || daily.start,
      targetPage: targetPage || daily.target,
      rules: {
        maxAttempts: rules?.maxAttempts || 3,
        banCtrlF: rules?.banCtrlF ?? true,
        banTabSwitch: rules?.banTabSwitch ?? true,
        allowBacktrack: rules?.allowBacktrack ?? false
      },
      players: new Map()
    };

    room.players.set(socket.id, {
      id: socket.id,
      username: username || "Host",
      isHost: true,
      currentClicks: 0,
      currentPage: room.startPage,
      isFinished: false,
      isDisqualified: false,
      finishTime: null
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('room_created', { roomId, room: serializeRoom(room) });
  });

  // Join Room
  socket.on('join_room', ({ roomId, username }) => {
    const cleanId = (roomId || '').trim().toUpperCase();
    const room = rooms.get(cleanId);

    if (!room) return socket.emit('error_message', "Room does not exist.");
    if (room.status !== 'LOBBY') return socket.emit('error_message', "Match already started.");

    room.players.set(socket.id, {
      id: socket.id,
      username: username || `Racer_${socket.id.substring(0, 4)}`,
      isHost: false,
      currentClicks: 0,
      currentPage: room.startPage,
      isFinished: false,
      isDisqualified: false,
      finishTime: null
    });

    socket.join(cleanId);
    socket.emit('room_joined', { roomId: cleanId, room: serializeRoom(room) });
    io.to(cleanId).emit('room_updated', serializeRoom(room));
  });

  // Host starts game
  socket.on('start_race', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    room.status = 'RACING';
    io.to(roomId).emit('race_started', {
      startPage: room.startPage,
      targetPage: room.targetPage,
      rules: room.rules
    });
  });

  // Player navigates in real-time
  socket.on('player_navigated', ({ roomId, newPage }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'RACING') return;
    const player = room.players.get(socket.id);
    if (!player || player.isDisqualified || player.isFinished) return;

    player.currentPage = newPage;
    player.currentClicks += 1;

    // Check Win
    if (newPage.toLowerCase().replace(/_/g, ' ') === room.targetPage.toLowerCase().replace(/_/g, ' ')) {
      player.isFinished = true;
      player.finishTime = Date.now();
      io.to(roomId).emit('player_won', {
        username: player.username,
        clicks: player.currentClicks
      });
    }

    io.to(roomId).emit('race_progress', {
      playerId: socket.id,
      username: player.username,
      clicks: player.currentClicks,
      currentPage: player.currentPage
    });
  });

  // Rule violation: Tab switch
  socket.on('violation_tab_switch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.rules.banTabSwitch || room.status !== 'RACING') return;
    const player = room.players.get(socket.id);
    if (!player || player.isDisqualified) return;

    player.isDisqualified = true;
    io.to(roomId).emit('player_disqualified', {
      username: player.username,
      reason: "Tab minimized / focus lost"
    });
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        if (room.players.size === 0) {
          rooms.delete(roomId);
        } else {
          if (room.hostId === socket.id) {
            const nextHost = room.players.keys().next().value;
            room.hostId = nextHost;
            room.players.get(nextHost).isHost = true;
          }
          io.to(roomId).emit('room_updated', serializeRoom(room));
        }
      }
    });
  });
});

function serializeRoom(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    status: room.status,
    startPage: room.startPage,
    targetPage: room.targetPage,
    rules: room.rules,
    players: Array.from(room.players.values())
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WikiSprint live on port ${PORT}`));
