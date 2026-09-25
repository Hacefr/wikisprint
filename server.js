const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io with CORS enabled
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve frontend files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store (Use Redis if scaling across multiple server instances)
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 1. Host creates a custom room
  socket.on('create_room', ({ username, rules, startPage, targetPage }) => {
    // Generate a 5-character alphanumeric room code
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();

    const roomData = {
      id: roomId,
      hostId: socket.id,
      status: 'LOBBY', // LOBBY, RACING, FINISHED
      startPage: startPage || "The Great Barrier Reef",
      targetPage: targetPage || "Quantum computing",
      rules: {
        maxAttempts: rules.maxAttempts || 3,
        banCtrlF: rules.banCtrlF ?? true,
        banTabSwitch: rules.banTabSwitch ?? true,
        allowBacktrack: rules.allowBacktrack ?? false
      },
      players: new Map()
    };

    // Add host as player
    roomData.players.set(socket.id, {
      id: socket.id,
      username: username || "Host",
      attemptsUsed: 0,
      currentClicks: 0,
      currentPage: roomData.startPage,
      isFinished: false,
      isDisqualified: false,
      finishTime: null
    });

    rooms.set(roomId, roomData);
    socket.join(roomId);

    socket.emit('room_created', { roomId, roomData: serializeRoom(roomData) });
  });

  // 2. Player joins room via code
  socket.on('join_room', ({ roomId, username }) => {
    const cleanCode = roomId.trim().toUpperCase();
    const room = rooms.get(cleanCode);

    if (!room) {
      return socket.emit('error_message', 'Room not found.');
    }

    if (room.status === 'RACING') {
      return socket.emit('error_message', 'Match is already in progress.');
    }

    room.players.set(socket.id, {
      id: socket.id,
      username: username || `Racer_${socket.id.substring(0, 4)}`,
      attemptsUsed: 0,
      currentClicks: 0,
      currentPage: room.startPage,
      isFinished: false,
      isDisqualified: false,
      finishTime: null
    });

    socket.join(cleanCode);
    io.to(cleanCode).emit('player_list_updated', serializeRoom(room));
  });

  // 3. Player clicks a link inside Wikipedia
  socket.on('player_navigated', ({ roomId, newPage }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'RACING') return;

    const player = room.players.get(socket.id);
    if (!player || player.isDisqualified || player.isFinished) return;

    player.currentPage = newPage;
    player.currentClicks += 1;

    // Check Win Condition
    if (newPage.toLowerCase() === room.targetPage.toLowerCase()) {
      player.isFinished = true;
      player.finishTime = Date.now();
      io.to(roomId).emit('player_finished', {
        playerId: socket.id,
        username: player.username,
        clicks: player.currentClicks
      });
    }

    // Broadcast live update to opponents
    io.to(roomId).emit('race_progress', {
      playerId: socket.id,
      currentPage: player.currentPage,
      clicks: player.currentClicks
    });
  });

  // 4. Rule Violation: Tab Switch / Blur
  socket.on('violation_tab_switch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.rules.banTabSwitch || room.status !== 'RACING') return;

    const player = room.players.get(socket.id);
    if (!player || player.isDisqualified) return;

    player.attemptsUsed += 1;

    if (player.attemptsUsed >= room.rules.maxAttempts) {
      player.isDisqualified = true;
      io.to(roomId).emit('player_disqualified', {
        playerId: socket.id,
        username: player.username,
        reason: 'Tab switch / focus loss'
      });
    } else {
      socket.emit('attempt_failed', {
        reason: 'Tab switch detected! Attempt lost.',
        attemptsUsed: player.attemptsUsed
      });
    }
  });

  // 5. Handle Disconnect
  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        io.to(roomId).emit('player_list_updated', serializeRoom(room));
        if (room.players.size === 0) rooms.delete(roomId);
      }
    });
  });
});

// Helper: Convert Map to plain JS object for socket serialization
function serializeRoom(room) {
  return {
    ...room,
    players: Array.from(room.players.values())
  };
}

// Render supplies the port dynamically in process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
