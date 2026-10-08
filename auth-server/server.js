const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // 100 MB
});
const cors = require('cors');
const path = require('path');
const db = require('./db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'super-secret-key-123';

app.use(cors());
app.use(express.json());

// Users & Auth
app.post('/api/register', (req, res) => {
    try {
        const user = db.register(req.body.username, req.body.password);
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        res.json({ token, username: user.username });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/login', (req, res) => {
    try {
        const user = db.login(req.body.username, req.body.password);
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        res.json({ token, username: user.username });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// Friends
app.get('/api/friends', authenticateToken, (req, res) => {
    try { res.json(db.getFriends(req.user.id)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/friends/add', authenticateToken, (req, res) => {
    try { res.json(db.addFriend(req.user.id, req.body.username)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/friends/:id', authenticateToken, (req, res) => {
    try { 
        db.removeFriend(req.user.id, req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// Global User Settings
app.get('/api/settings', authenticateToken, (req, res) => {
    res.json(db.getSettings(req.user.id));
});

app.post('/api/settings', authenticateToken, (req, res) => {
    try { res.json(db.saveSettings(req.user.id, req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

// Saved Servers
app.get('/api/servers', authenticateToken, (req, res) => {
    try { res.json(db.getUserServers(req.user.id)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/servers', authenticateToken, (req, res) => {
    try {
        const newServer = db.addUserServer(req.user.id, {
            name: req.body.name,
            ip: req.body.ip || 'localhost:4000', // Default dedicated server IP
            roles: { [req.user.id]: 'Owner' }
        });
        res.json(newServer);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/servers/:id', authenticateToken, (req, res) => {
    try { 
        db.removeUserServer(req.user.id, req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/servers/:id', authenticateToken, (req, res) => {
    try {
        const updated = db.updateUserServer(req.user.id, req.params.id, req.body);
        res.json(updated);
    } catch(e) { res.status(400).json({ error: e.message }); }
});

// Socket.io for Global Presence & DMs
const onlineUsers = {}; // socket.id -> userId
const userSockets = {}; // userId -> socket.id

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('register-socket', (username) => {
        const user = db.getUserByUsername(username);
        if(!user) {
            currentUser = username;
            onlineUsers[socket.id] = username;
            userSockets[username] = socket.id;
        } else {
            currentUser = user.username;
            onlineUsers[socket.id] = user.username;
            userSockets[user.username] = socket.id;
        }
        console.log('[Auth] User online:', currentUser);
        io.emit('online-users', Object.values(onlineUsers)); // Broadcast online users
    });

    socket.on('private-message', (toUser, msg, fromName) => {
        const toSocket = userSockets[toUser];
        if (toSocket) {
            io.to(toSocket).emit('private-message', fromName, msg, new Date().toLocaleTimeString());
        }
    });

    socket.on('disconnect', () => {
        if(currentUser) {
            delete onlineUsers[socket.id];
            delete userSockets[currentUser];
            console.log('[Auth] User offline:', currentUser);
            io.emit('online-users', Object.values(onlineUsers)); // Broadcast online users
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Global Auth Server läuft auf http://localhost:${PORT}`);
});
