const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. LOCAL PERSISTENT DATABASE ---
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initData = { users: {}, sessions: {}, dailyLeaderboard: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initData, null, 2));
    return initData;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: {}, sessions: {}, dailyLeaderboard: [] };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDB();

// --- 2. CRYPTO UTILITIES ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const checkHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return checkHash === hash;
}

// Authentication Middleware
function authMiddleware(req, res, next) {
  const token = req.headers['authorization'];
  if (!token || !db.sessions[token]) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }
  req.username = db.sessions[token];
  req.user = db.users[req.username];
  next();
}

// --- 3. AUTHENTICATION ENDPOINTS ---

// Register New Account
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  const cleanName = (username || '').trim();

  if (!cleanName || cleanName.length < 3) {
    return res.status(400).json({ error: "Username must be at least 3 characters." });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  // Check case-insensitive collision
  const exists = Object.keys(db.users).some(u => u.toLowerCase() === cleanName.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: "This username is already taken. Please log in instead." });
  }

  const { salt, hash } = hashPassword(password);
  const token = crypto.randomBytes(32).toString('hex');

  const newUser = {
    username: cleanName,
    salt,
    hash,
    level: 1,
    exp: 0,
    wins: 0,
    streak: 0,
    dailyAttempts: 0,
    lastDailyDate: null,
    joinedAt: Date.now()
  };

  db.users[cleanName] = newUser;
  db.sessions[token] = cleanName;
  saveDB(db);

  const { salt: _, hash: __, ...safeUser } = newUser;
  res.json({ token, user: safeUser });
});

// Login Existing Account
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const cleanName = (username || '').trim();

  const user = db.users[cleanName];
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = cleanName;
  saveDB(db);

  const { salt, hash, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// Fetch Profile
app.get('/api/me', authMiddleware, (req, res) => {
  const { salt, hash, ...safeUser } = req.user;
  res.json({ user: safeUser });
});

// --- 4. DETERMINISTIC DAILY CHALLENGE & LEADERBOARD ---
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

app.get('/api/daily', (req, res) => {
  res.json({ daily: getDailyChallenge() });
});

app.get('/api/daily-leaderboard', (req, res) => {
  res.json({
    leaderboard: db.dailyLeaderboard
      .sort((a, b) => a.clicks - b.clicks || a.timeSeconds - b.timeSeconds)
      .slice(0, 50)
  });
});

// Authenticated Daily Submit
app.post('/api/daily-submit', authMiddleware, (req, res) => {
  const { clicks, timeSeconds, attempt, route } = req.body;
  const username = req.username;

  db.dailyLeaderboard.push({
    username,
    clicks,
    timeSeconds,
    attempt: attempt || 1,
    route: route || [],
    timestamp: Date.now()
  });

  // Award EXP & Streak
  const user = req.user;
  user.exp += 250;
  user.streak += 1;
  user.dailyAttempts = (user.dailyAttempts || 0) + 1;

  if (user.exp >= user.level * 500) {
    user.exp -= user.level * 500;
    user.level += 1;
  }

  saveDB(db);
  const { salt, hash, ...safeUser } = user;
  res.json({ success: true, user: safeUser });
});

// Update Profile Post-Match (Multiplayer / Practice)
app.post('/api/match-finish', authMiddleware, (req, res) => {
  const { won, exp } = req.body;
  const user = req.user;

  user.exp += (exp || 50);
  if (won) user.wins += 1;

  if (user.exp >= user.level * 500) {
    user.exp -= user.level * 500;
    user.level += 1;
  }

  saveDB(db);
  const { salt, hash, ...safeUser } = user;
  res.json({ success: true, user: safeUser });
});

// --- 5. MULTIPLAYER ROOM & WIN-CONDITION ENGINE ---
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('create_room', ({ token, rules, startPage, targetPage }) => {
    const username = db.sessions[token] || `Guest_${socket.id.substring(0, 4)}`;
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    const daily = getDailyChallenge();

    const room = {
      id: roomId,
      hostId: socket.id,
      status: 'LOBBY',
      startPage: startPage || daily.start,
      targetPage: targetPage || daily.target,
      rules: {
        winCondition: rules?.winCondition || 'BOTH',
        banNewTabs: rules?.banNewTabs ?? true,
        banCtrlF: rules?.banCtrlF ?? true,
        banTabSwitch: rules?.banTabSwitch ?? true,
        maxAttempts: rules?.maxAttempts || 3
      },
      players: new Map()
    };

    room.players.set(socket.id, {
      id: socket.id,
      username,
      isHost: true,
      currentClicks: 0,
      currentPage: room.startPage,
      isFinished: false,
      isDisqualified: false,
      finishTimeSeconds: null
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('room_created', { roomId, room: serializeRoom(room) });
  });

  socket.on('join_room', ({ roomId, token }) => {
    const username = db.sessions[token] || `Guest_${socket.id.substring(0, 4)}`;
    const cleanId = (roomId || '').trim().toUpperCase();
    const room = rooms.get(cleanId);

    if (!room) return socket.emit('error_message', "Room does not exist.");
    if (room.status !== 'LOBBY') return socket.emit('error_message', "Match is already in progress.");

    room.players.set(socket.id, {
      id: socket.id,
      username,
      isHost: false,
      currentClicks: 0,
      currentPage: room.startPage,
      isFinished: false,
      isDisqualified: false,
      finishTimeSeconds: null
    });

    socket.join(cleanId);
    socket.emit('room_joined', { roomId: cleanId, room: serializeRoom(room) });
    io.to(cleanId).emit('room_updated', serializeRoom(room));
  });

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

  socket.on('player_navigated', ({ roomId, newPage, timeSeconds }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'RACING') return;
    const player = room.players.get(socket.id);
    if (!player || player.isDisqualified || player.isFinished) return;

    player.currentPage = newPage;
    player.currentClicks += 1;

    const isTarget = newPage.toLowerCase().replace(/_/g, ' ') === room.targetPage.toLowerCase().replace(/_/g, ' ');

    if (isTarget) {
      player.isFinished = true;
      player.finishTimeSeconds = timeSeconds || 0;

      const finished = Array.from(room.players.values()).filter(p => p.isFinished);

      finished.sort((a, b) => {
        if (room.rules.winCondition === 'TIME') return a.finishTimeSeconds - b.finishTimeSeconds;
        if (room.rules.winCondition === 'STEPS') return a.currentClicks - b.currentClicks;
        if (a.currentClicks !== b.currentClicks) return a.currentClicks - b.currentClicks;
        return a.finishTimeSeconds - b.finishTimeSeconds;
      });

      io.to(roomId).emit('player_finished_run', {
        winnerName: finished[0].username,
        finisher: player.username,
        clicks: player.currentClicks,
        timeSeconds: player.finishTimeSeconds,
        winCondition: room.rules.winCondition,
        standings: finished.map(p => ({
          username: p.username,
          clicks: p.currentClicks,
          timeSeconds: p.finishTimeSeconds
        }))
      });
    }

    io.to(roomId).emit('race_progress', {
      username: player.username,
      clicks: player.currentClicks,
      currentPage: player.currentPage
    });
  });

  socket.on('violation_tab_switch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.rules.banTabSwitch || room.status !== 'RACING') return;
    const player = room.players.get(socket.id);
    if (!player || player.isDisqualified) return;

    player.isDisqualified = true;
    io.to(roomId).emit('player_disqualified', {
      username: player.username,
      reason: "Tab minimized / window lost focus"
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
