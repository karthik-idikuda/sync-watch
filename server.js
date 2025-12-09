const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const { v4: uuidv4 } = require('uuid');

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Store room states for syncing new users
const rooms = {}; // { roomId: [{ odId, username, avatar, socketId }] }
const roomStates = {}; // { roomId: { url, videoId, platform, currentTime, isPlaying, speed, queue, password, locked } }
const roomHosts = {}; // { roomId: odId }

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('check-room', (roomId, callback) => {
        if (rooms[roomId]) {
            const hasPassword = !!roomStates[roomId]?.password;
            const isLocked = !!roomStates[roomId]?.locked;
            callback({ exists: true, hasPassword, isLocked });
        } else {
            callback({ exists: false });
        }
    });

    socket.on('create-room', (password) => {
        const roomId = uuidv4();
        if (password) {
            roomStates[roomId] = { password }; // Init with password
        }
        socket.emit('room-created', roomId);
    });

    socket.on('join-room', (roomId, odId, username, password, avatar) => {
        // Validation for password protected rooms & locked rooms
        if (rooms[roomId]) {
            if (roomStates[roomId]?.locked) {
                socket.emit('error', 'Room is locked');
                return;
            }
            if (roomStates[roomId]?.password) {
                if (roomStates[roomId].password !== password) {
                    socket.emit('error', 'Incorrect password');
                    return;
                }
            }
        }

        socket.join(roomId);
        
        // Initialize room if new (and not created via create-room event yet)
        if (!rooms[roomId]) {
            rooms[roomId] = [];
            roomHosts[roomId] = odId; // First user is host
        }
        
        // Add user to room
        rooms[roomId].push({ 
            odId, 
            username: username || 'Guest', 
            avatar: avatar || '👤',
            socketId: socket.id 
        });
        
        console.log(`User ${username} joined ${roomId}`);
        
        // Check if this user is host
        const isHost = roomHosts[roomId] === odId;
        socket.emit('host-status', isHost);
        
        // Send current room state to new user
        if (roomStates[roomId]) {
            // Don't send password back to client
            const { password, ...safeState } = roomStates[roomId];
            socket.emit('room-state', safeState);
        }
        
        // Send user count to all
        io.to(roomId).emit('user-count', rooms[roomId].length);
        
        // Notify others in room
        socket.to(roomId).emit('user-connected', { odId, username, avatar });

        // Handle Kick (Admin only)
        socket.on('kick-user', (targetOdId) => {
            if (roomHosts[roomId] !== odId) return; // Only host can kick
            
            const target = rooms[roomId]?.find(u => u.odId === targetOdId);
            if (target) {
                io.to(target.socketId).emit('banned');
                // Disconnect them
                io.sockets.sockets.get(target.socketId)?.leave(roomId);
            }
        });
        
        // Handle Lock Room (Admin only)
        socket.on('lock-room', (locked) => {
             if (roomHosts[roomId] !== odId) return;
             if (!roomStates[roomId]) roomStates[roomId] = {};
             roomStates[roomId].locked = locked;
             io.to(roomId).emit('room-locked', locked);
        });

        // Handle Disconnect
        socket.on('disconnect', () => {
            console.log('User disconnected:', username || odId);
            socket.to(roomId).emit('user-disconnected', { odId });
            
            // Remove user from room
            const index = rooms[roomId]?.findIndex(u => u.odId === odId);
            if (index > -1) {
                rooms[roomId].splice(index, 1);
            }
            
            // Send updated user count
            if (rooms[roomId]) {
                io.to(roomId).emit('user-count', rooms[roomId].length);
            }
            
            // If host left, assign new host
            if (roomHosts[roomId] === odId && rooms[roomId]?.length > 0) {
                roomHosts[roomId] = rooms[roomId][0].odId;
                // Notify new host
                const newHostSocket = io.sockets.sockets.get(rooms[roomId][0].socketId);
                if (newHostSocket) {
                    newHostSocket.emit('host-status', true);
                }
            }
            
            // Clean up empty rooms
            if (rooms[roomId] && rooms[roomId].length === 0) {
                delete rooms[roomId];
                delete roomStates[roomId];
                delete roomHosts[roomId];
                console.log(`Room ${roomId} cleaned up`);
            }
        });
    });

    // --- WebRTC Signaling ---
    
    socket.on('offer', (data) => {
        socket.to(data.roomId).emit('offer', {
            offer: data.offer,
            odId: data.odId,
            username: data.username
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.roomId).emit('answer', {
            answer: data.answer,
            odId: data.odId,
            username: data.username
        });
    });

    socket.on('ice-candidate', (data) => {
        socket.to(data.roomId).emit('ice-candidate', {
            candidate: data.candidate,
            odId: data.odId
        });
    });

    // --- Video Synchronization ---
    
    socket.on('sync-action', (data) => {
        // Initialize room state if needed
        if (!roomStates[data.roomId]) {
            roomStates[data.roomId] = {
                url: null,
                videoId: null,
                platform: null,
                currentTime: 0,
                isPlaying: false,
                speed: 1,
                queue: []
            };
        }
        
        const state = roomStates[data.roomId];
        
        // Update stored state based on action type
        switch (data.type) {
            case 'url':
                state.url = data.url;
                state.videoId = data.videoId || null;
                state.platform = data.platform || 'direct';
                state.currentTime = data.currentTime || 0;
                state.isPlaying = false;
                break;
                
            case 'play':
                state.isPlaying = true;
                state.currentTime = data.currentTime;
                if (data.speed) state.speed = data.speed;
                break;
                
            case 'pause':
                state.isPlaying = false;
                state.currentTime = data.currentTime;
                break;
                
            case 'seeked':
                state.currentTime = data.currentTime;
                break;
                
            case 'speed':
                state.speed = data.speed;
                break;
                
            case 'queue-update':
                state.queue = data.queue || [];
                break;
        }
        
        // Broadcast to everyone else in the room
        socket.to(data.roomId).emit('sync-action', data);
    });
    
    // Request current state (for late joiners who missed initial state)
    socket.on('request-state', (roomId) => {
        if (roomStates[roomId]) {
            const { password, ...safeState } = roomStates[roomId];
            socket.emit('room-state', safeState);
        }
    });

    // --- Chat & Reactions ---
    
    socket.on('chat-message', (data) => {
        socket.to(data.roomId).emit('chat-message', {
            msg: data.msg,
            username: data.username || 'Guest',
            avatar: data.avatar || '👤'
        });
    });
    
    socket.on('reaction', (data) => {
        socket.to(data.roomId).emit('reaction', data);
    });
    
    // --- Typing Indicator ---
    
    socket.on('typing', (data) => {
        socket.to(data.roomId).emit('typing', {
            username: data.username,
            isTyping: data.isTyping
        });
    });
});

// --- API Endpoints ---

// Get room info
app.get('/api/room/:roomId', (req, res) => {
    const { roomId } = req.params;
    if (rooms[roomId]) {
        res.json({
            exists: true,
            userCount: rooms[roomId].length,
            hasVideo: !!roomStates[roomId]?.url
        });
    } else {
        res.json({ exists: false });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        rooms: Object.keys(rooms).length,
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════════╗
    ║                                           ║
    ║     🎬 SyncWatch Server Running! 🎬       ║
    ║                                           ║
    ║     http://localhost:${PORT}                  ║
    ║                                           ║
    ╚═══════════════════════════════════════════╝
    `);
});
