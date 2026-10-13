const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // 100 MB
});
const cors = require('cors');
const db = require('./db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-123';
const powerMap = { owner: 100, admin: 75, supporter: 50, user: 5, gast: 1, banned: 0 };

app.use(cors());
app.use(express.json());

// --- JWT Middleware ---
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

// --- Health Check ---
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        server: '4Ohm Unified Server',
        database: db.usingPostgres() ? 'PostgreSQL (Neon Connected)' : 'Local JSON Fallback (Temporary)',
        timestamp: Date.now()
    });
});

// --- Server Info ---
app.get('/api/server-info', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(serverId);
    res.json({
        id: 'default',
        name: srv.name || '4Ohm Server',
        channels: srv.channels || [],
        welcomeMessage: srv.settings?.welcomeMessage || 'Willkommen auf dem 4Ohm Server!'
    });
});

// --- Auth Routes ---
app.post('/api/register', async (req, res) => {
    try {
        const user = await db.register(req.body.username, req.body.password);
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        res.json({ token, username: user.username });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await db.login(req.body.username, req.body.password);
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        res.json({ token, username: user.username });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Friends Routes ---
app.get('/api/friends', authenticateToken, async (req, res) => {
    try {
        const friends = await db.getFriends(req.user.id);
        res.json(friends);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/friends/requests', authenticateToken, async (req, res) => {
    try {
        const requests = await db.getFriendRequests(req.user.id);
        res.json(requests);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

function resolveTargetIdentifier(body) {
    let t = body.targetId || body.targetUsername || body.username || body.target;
    if (typeof t === 'object' && t !== null) {
        return t.username || t.id || '';
    }
    return t ? String(t).trim() : '';
}

app.post('/api/friends/request', authenticateToken, async (req, res) => {
    try {
        const target = resolveTargetIdentifier(req.body);
        const result = await db.sendFriendRequest(req.user.id, target);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    try {
        const target = resolveTargetIdentifier(req.body);
        const result = await db.acceptFriendRequest(req.user.id, target);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/friends/decline', authenticateToken, async (req, res) => {
    try {
        const target = resolveTargetIdentifier(req.body);
        const result = await db.declineFriendRequest(req.user.id, target);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/friends/cancel', authenticateToken, async (req, res) => {
    try {
        const target = resolveTargetIdentifier(req.body);
        const result = await db.cancelFriendRequest(req.user.id, target);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/friends/add', authenticateToken, async (req, res) => {
    try {
        const target = resolveTargetIdentifier(req.body);
        const friend = await db.addFriend(req.user.id, target);
        res.json(friend);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/friends/:id', authenticateToken, async (req, res) => {
    try {
        await db.removeFriend(req.user.id, req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Profile Routes ---
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const profile = await db.getProfile(req.user.id);
        res.json(profile);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/profile', authenticateToken, async (req, res) => {
    try {
        const updated = await db.saveProfile(req.user.id, req.body);
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/change-password', authenticateToken, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const result = await db.changePassword(req.user.id, oldPassword, newPassword);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/profile/:username', async (req, res) => {
    try {
        const u = await db.getUserByUsername(req.params.username);
        if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
        res.json({
            username: u.username,
            avatar: u.avatar || '',
            bio: u.bio || '',
            ringColor: u.ring_color || '#00ff00'
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Direct Messages Routes ---
app.get('/api/dm/:targetUser', authenticateToken, async (req, res) => {
    try {
        const messages = await db.getDirectMessages(req.user.username, req.params.targetUser);
        res.json({ success: true, messages });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/dm/:targetUser', authenticateToken, async (req, res) => {
    try {
        const msgText = req.body.msg || req.body.message || '';
        const isMedia = req.body.isMedia || false;
        const msg = await db.addDirectMessage(req.user.username, req.params.targetUser, msgText, isMedia);
        const ts = msg.ts || Date.now();
        io.to('user_' + req.params.targetUser).emit('private-message', req.user.username, msgText, ts, isMedia, req.params.targetUser);
        const toSocket = userSockets[req.params.targetUser];
        if (toSocket) {
            io.to(toSocket).emit('private-message', req.user.username, msgText, ts, isMedia, req.params.targetUser);
        }
        res.json({ success: true, message: msg });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Settings (User Settings & Server Settings) ---
app.get('/api/settings', async (req, res) => {
    const serverId = req.query.serverId;
    if (serverId) {
        const srv = await db.getVirtualServer(serverId);
        return res.json(srv.settings || {});
    }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const settings = await db.getSettings(decoded.id);
            return res.json(settings);
        } catch (e) {}
    }
    res.json({});
});

app.post('/api/settings', async (req, res) => {
    const serverId = req.query.serverId;
    if (serverId) {
        const srv = await db.getVirtualServer(serverId);
        srv.settings = { ...srv.settings, ...req.body };
        await db.saveVirtualServer(serverId, srv);
        return res.json({ success: true, settings: srv.settings });
    }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const saved = await db.saveSettings(decoded.id, req.body);
            return res.json(saved);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    }
    res.status(401).json({ error: 'Unauthorized' });
});

// --- User's Saved Server List ---
app.get('/api/servers', authenticateToken, async (req, res) => {
    try {
        const servers = await db.getUserServers(req.user.id);
        res.json(servers);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/servers', authenticateToken, async (req, res) => {
    try {
        const newServer = await db.addUserServer(req.user.id, {
            name: req.body.name,
            ip: req.body.ip,
            roles: { [req.user.id]: 'Owner' }
        });
        res.json(newServer);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/servers/:id', authenticateToken, async (req, res) => {
    try {
        await db.removeUserServer(req.user.id, req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/servers/:id', authenticateToken, async (req, res) => {
    try {
        const updated = await db.updateUserServer(req.user.id, req.params.id, req.body);
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Virtual Server Channels ---
app.get('/api/channels', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(serverId);
    res.json(srv.channels || []);
});

app.post('/api/channels', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const { name, type } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const srv = await db.getVirtualServer(serverId);
    if (!srv.channels) srv.channels = [];

    const newChannel = {
        id: name.toLowerCase().replace(/\s+/g, '-') + '_' + Date.now().toString().slice(-4),
        name,
        type: type || 'text'
    };
    srv.channels.push(newChannel);
    await db.saveVirtualServer(serverId, srv);

    // Live sync to all users on this server
    io.to(serverId).emit('channels-update', srv.channels);
    res.json({ success: true, channel: newChannel, channels: srv.channels });
});

app.delete('/api/channels/:name', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const username = req.query.username;
    const srv = await db.getVirtualServer(serverId);

    const reqRole = srv.userGroups[username] || srv.settings?.defaultRole || 'user';
    const reqPower = powerMap[reqRole] || 0;

    if (reqPower >= 75 || !username) {
        srv.channels = (srv.channels || []).filter(c => c.name !== req.params.name);
        await db.saveVirtualServer(serverId, srv);
        io.to(serverId).emit('channels-update', srv.channels);
        return res.json({ success: true, channels: srv.channels });
    }
    res.status(403).json({ error: 'Insufficient power level to delete channel' });
});

app.post('/api/channels/reorder', async (req, res) => {
    try {
        const { serverId = 'default', channels, requestingUser } = req.body;
        if (!Array.isArray(channels)) return res.status(400).json({ error: 'Kanäle Array erforderlich' });
        const srv = await db.getVirtualServer(serverId);
        if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });

        const reqRole = (srv.userGroups && srv.userGroups[requestingUser]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;

        if (reqPower >= 75 || !requestingUser) {
            srv.channels = channels;
            await db.saveVirtualServer(serverId, srv);
            io.to(serverId).emit('channels-update', srv.channels);
            return res.json({ success: true, channels: srv.channels });
        }
        res.status(403).json({ error: 'Unzureichende Berechtigung zum Umordnen von Kanälen' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Messages ---
app.get('/api/messages/:room', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const msgs = await db.getMessages(serverId, req.params.room);
    res.json(msgs);
});

// --- Roles & Groups ---
app.get('/api/groups', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(serverId);
    res.json({ groups: srv.groups, userGroups: srv.userGroups });
});

app.post('/api/groups/assign', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const { targetUser, groupId, requestingUser } = req.body;
    const srv = await db.getVirtualServer(serverId);

    const reqGroupId = srv.userGroups[requestingUser] || 'user';
    const reqPower = srv.groups?.[reqGroupId]?.power || powerMap[reqGroupId] || 0;

    if (reqPower < 75) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }

    if (!srv.userGroups) srv.userGroups = {};
    srv.userGroups[targetUser] = groupId;
    await db.saveVirtualServer(serverId, srv);

    io.to(serverId).emit('group-update', srv.userGroups);

    // Live update in all active voice rooms on this server:
    for (const roomKey in rooms) {
        if (roomKey.startsWith(serverId + '_')) {
            let changed = false;
            for (const sockId in rooms[roomKey]) {
                if (rooms[roomKey][sockId].name === targetUser) {
                    rooms[roomKey][sockId].groupId = groupId;
                    changed = true;
                }
            }
            if (changed) {
                const rId = roomKey.replace(serverId + '_', '');
                io.to(serverId).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
    }

    res.json({ success: true });
});

// --- Moderation ---
app.post('/api/moderate', async (req, res) => {
    const { serverId = 'default', targetUser, action, requestingUser } = req.body;
    const srv = await db.getVirtualServer(serverId);

    const reqRole = srv.userGroups[requestingUser] || srv.settings?.defaultRole || 'user';
    const reqPower = powerMap[reqRole] || 0;

    srv.banned = srv.banned || [];
    srv.serverMuted = srv.serverMuted || [];
    srv.chatRestricted = srv.chatRestricted || [];

    if (action === 'ban' && reqPower >= 75) {
        if (!srv.banned.includes(targetUser)) srv.banned.push(targetUser);
        await db.saveVirtualServer(serverId, srv);
        io.to(serverId).emit('user-banned', targetUser);
        return res.json({ success: true });
    }
    if (action === 'kick' && reqPower >= 50) {
        io.to(serverId).emit('user-kicked', targetUser);
        return res.json({ success: true });
    }
    if (action === 'mute' && reqPower >= 50) {
        if (!srv.serverMuted.includes(targetUser)) srv.serverMuted.push(targetUser);
        await db.saveVirtualServer(serverId, srv);
        io.to(serverId).emit('user-server-muted', targetUser);
        return res.json({ success: true });
    }
    if (action === 'chat-restrict' && reqPower >= 50) {
        if (!srv.chatRestricted.includes(targetUser)) srv.chatRestricted.push(targetUser);
        await db.saveVirtualServer(serverId, srv);
        io.to(serverId).emit('user-chat-restricted', targetUser);
        return res.json({ success: true });
    }
    return res.status(403).json({ error: 'Insufficient power level or unknown action' });
});

app.get('/api/moderation/lists', async (req, res) => {
    try {
        const serverId = req.query.serverId || 'default';
        const srv = await db.getVirtualServer(serverId);
        res.json({
            banned: srv.banned || [],
            serverMuted: srv.serverMuted || [],
            chatRestricted: srv.chatRestricted || []
        });
    } catch(e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/moderation/revoke', async (req, res) => {
    try {
        const { serverId = 'default', targetUser, type, requestingUser } = req.body;
        const srv = await db.getVirtualServer(serverId);
        const reqRole = srv.userGroups[requestingUser] || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;

        if (type === 'ban') {
            if (reqPower < 75) return res.status(403).json({ error: 'Keine Berechtigung' });
            srv.banned = (srv.banned || []).filter(u => u !== targetUser);
            await db.saveVirtualServer(serverId, srv);
            io.to(serverId).emit('user-unbanned', targetUser);
        } else if (type === 'mute') {
            if (reqPower < 50) return res.status(403).json({ error: 'Keine Berechtigung' });
            srv.serverMuted = (srv.serverMuted || []).filter(u => u !== targetUser);
            await db.saveVirtualServer(serverId, srv);
            io.to(serverId).emit('user-server-unmuted', targetUser);
        } else if (type === 'chat-restrict') {
            if (reqPower < 50) return res.status(403).json({ error: 'Keine Berechtigung' });
            srv.chatRestricted = (srv.chatRestricted || []).filter(u => u !== targetUser);
            await db.saveVirtualServer(serverId, srv);
            io.to(serverId).emit('user-chat-unrestricted', targetUser);
        }
        res.json({ success: true });
    } catch(e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/moderation/add', async (req, res) => {
    try {
        const { serverId = 'default', targetUser, type, requestingUser } = req.body;
        if (!targetUser) return res.status(400).json({ error: 'Benutzer erforderlich' });
        const srv = await db.getVirtualServer(serverId);
        const reqRole = srv.userGroups[requestingUser] || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;

        if (type === 'ban') {
            if (reqPower < 75) return res.status(403).json({ error: 'Keine Berechtigung' });
            srv.banned = srv.banned || [];
            if (!srv.banned.includes(targetUser)) srv.banned.push(targetUser);
            await db.saveVirtualServer(serverId, srv);
            io.to(serverId).emit('user-banned', targetUser);
        } else if (type === 'mute') {
            if (reqPower < 50) return res.status(403).json({ error: 'Keine Berechtigung' });
            srv.serverMuted = srv.serverMuted || [];
            if (!srv.serverMuted.includes(targetUser)) srv.serverMuted.push(targetUser);
            await db.saveVirtualServer(serverId, srv);
            io.to(serverId).emit('user-server-muted', targetUser);
        } else if (type === 'chat-restrict') {
            if (reqPower < 50) return res.status(403).json({ error: 'Keine Berechtigung' });
            srv.chatRestricted = srv.chatRestricted || [];
            if (!srv.chatRestricted.includes(targetUser)) srv.chatRestricted.push(targetUser);
            await db.saveVirtualServer(serverId, srv);
            io.to(serverId).emit('user-chat-restricted', targetUser);
        }
        res.json({ success: true });
    } catch(e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Realtime Presence, Chat & WebRTC Voice ---
const onlineUsers = {}; // socketId -> username
const userSockets = {}; // username -> socketId
const rooms = {};       // serverId_roomId -> { socketId: userObj }

io.on('connection', async (socket) => {
    const rawServerId = socket.handshake.query.serverId;
    const serverId = rawServerId || 'default';
    const username = socket.handshake.query.username;

    // 1. If connecting to a virtual server:
    if (rawServerId || username) {
        socket.join(serverId);
        const srv = await db.getVirtualServer(serverId);

        if (username) {
            socket.join('user_' + username);
            userSockets[username] = socket.id;
            onlineUsers[socket.id] = username;
            if (!srv.userGroups) srv.userGroups = {};
            // First person to join the server becomes Owner (100 Power)
            if (Object.keys(srv.userGroups).length === 0) {
                srv.userGroups[username] = 'owner';
                await db.saveVirtualServer(serverId, srv);
            } else if (!srv.userGroups[username]) {
                srv.userGroups[username] = srv.settings?.defaultRole || 'user';
                await db.saveVirtualServer(serverId, srv);
            }
        }
        socket.emit('group-update', srv.userGroups || {});
        socket.emit('channels-update', srv.channels || []);

        // Sync active channel members to the connecting user
        for (const roomKey in rooms) {
            if (roomKey.startsWith(serverId + '_')) {
                const rId = roomKey.replace(serverId + '_', '');
                socket.emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
    }

    // 2. Global Auth socket registration:
    socket.on('register-socket', async (uName) => {
        if (!uName) return;
        onlineUsers[socket.id] = uName;
        userSockets[uName] = socket.id;
        socket.join('user_' + uName);
        io.emit('online-users', Object.values(onlineUsers));
    });

    socket.on('private-message', async (toUser, msg, explicitFromName, isMedia = false) => {
        const fromName = explicitFromName || onlineUsers[socket.id] || socket.handshake.query.username;
        if (!fromName || !toUser || !msg) return;
        const timestamp = Date.now();
        try {
            await db.addDirectMessage(fromName, toUser, msg, isMedia);
        } catch (e) {
            console.error('[DM] Save failed:', e.message);
        }

        // Broadcast to recipient user room & direct socket
        io.to('user_' + toUser).emit('private-message', fromName, msg, timestamp, isMedia, toUser);
        const toSocket = userSockets[toUser];
        if (toSocket && toSocket !== socket.id) {
            io.to(toSocket).emit('private-message', fromName, msg, timestamp, isMedia, toUser);
        }

        // Acknowledge back to sender
        socket.emit('private-message-sent', toUser, msg, timestamp, isMedia, fromName);
    });

    // 3. Voice & Room Channel Management:
    socket.on('join-room', async (roomId, peerId, userObj) => {
        const currentSid = serverId || 'default';
        const roomKey = currentSid + '_' + roomId;

        socket.join(roomKey);
        if (!rooms[roomKey]) rooms[roomKey] = {};

        const srv = await db.getVirtualServer(currentSid);
        const uName = (userObj && userObj.name) || peerId || username || 'Gast';
        const role = (srv.userGroups && srv.userGroups[uName]) || srv.settings?.defaultRole || 'user';

        rooms[roomKey][socket.id] = {
            socketId: socket.id,
            peerId,
            name: uName,
            groupId: role,
            ...(typeof userObj === 'object' ? userObj : {})
        };

        // Notify room members for WebRTC peer connection
        socket.to(roomKey).emit('user-connected', socket.id, peerId, rooms[roomKey][socket.id]);
        // Broadcast user list to the entire server for TS-like channel view
        io.to(currentSid).emit('room-users-update', roomId, Object.values(rooms[roomKey]));
    });

    socket.on('leave-room', (roomId) => {
        const currentSid = serverId || 'default';
        const roomKey = currentSid + '_' + roomId;

        if (rooms[roomKey] && rooms[roomKey][socket.id]) {
            delete rooms[roomKey][socket.id];
            socket.to(roomKey).emit('user-disconnected', socket.id);
            socket.leave(roomKey);
            io.to(currentSid).emit('room-users-update', roomId, Object.values(rooms[roomKey]));
        }
    });

    socket.on('afk-status', ({ isAfk, afkMessage, username: explicitUser }) => {
        const currentSid = serverId || 'default';
        const uName = explicitUser || username || onlineUsers[socket.id];
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].isAfk = !!isAfk;
                rooms[roomKey][socket.id].afkMessage = afkMessage ? String(afkMessage).slice(0, 100) : '';
                const rId = roomKey.replace(currentSid + '_', '');
                io.to(currentSid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        io.to(currentSid).emit('user-afk-updated', { username: uName, isAfk: !!isAfk, afkMessage: afkMessage ? String(afkMessage).slice(0, 100) : '' });
    });

    socket.on('stream-status', ({ isStreaming, username: explicitUser }) => {
        const currentSid = serverId || 'default';
        const uName = explicitUser || username || onlineUsers[socket.id];
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].isStreaming = !!isStreaming;
                const rId = roomKey.replace(currentSid + '_', '');
                io.to(currentSid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        io.to(currentSid).emit('user-stream-updated', { username: uName, isStreaming: !!isStreaming });
    });

    socket.on('user-voice-state', ({ isMuted, isDeafened, username: explicitUser }) => {
        const currentSid = serverId || 'default';
        const uName = explicitUser || username || onlineUsers[socket.id];
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].isMuted = !!isMuted;
                rooms[roomKey][socket.id].isDeafened = !!isDeafened;
                const rId = roomKey.replace(currentSid + '_', '');
                io.to(currentSid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        io.to(currentSid).emit('user-voice-state-updated', { username: uName, isMuted: !!isMuted, isDeafened: !!isDeafened });
    });

    socket.on('user-ring-color-update', ({ ringColor, username: explicitUser }) => {
        const currentSid = serverId || 'default';
        const uName = explicitUser || username || onlineUsers[socket.id];
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].ringColor = ringColor;
                rooms[roomKey][socket.id].ring_color = ringColor;
                const rId = roomKey.replace(currentSid + '_', '');
                io.to(currentSid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        io.to(currentSid).emit('user-ring-color-updated', { username: uName, ringColor });
    });

    socket.on('chat-message', async (roomId, msg, name, isMedia) => {
        const currentSid = serverId || 'default';
        const msgObj = { senderName: name, msg, timestamp: Date.now(), isMedia };
        await db.addMessage(currentSid, roomId, msgObj);

        // Broadcast to all clients on this server
        io.to(currentSid).emit('chat-message', socket.id, name, msg, roomId, msgObj.timestamp);
    });

    // 4. WebRTC Signaling:
    socket.on('offer', (targetId, offer, senderName) => {
        io.to(targetId).emit('offer', socket.id, offer, senderName);
    });

    socket.on('answer', (targetId, answer, senderName) => {
        io.to(targetId).emit('answer', socket.id, answer, senderName);
    });

    socket.on('ice-candidate', (candidate, targetId) => {
        if (targetId) {
            io.to(targetId).emit('ice-candidate', socket.id, candidate);
        } else {
            socket.broadcast.emit('ice-candidate', socket.id, candidate);
        }
    });

    // 5. Disconnect Cleanup:
    socket.on('disconnect', () => {
        const uName = onlineUsers[socket.id];
        if (uName) {
            delete onlineUsers[socket.id];
            delete userSockets[uName];
            io.emit('online-users', Object.values(onlineUsers));
        }

        // Clean up any rooms the user was in
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                delete rooms[roomKey][socket.id];
                socket.to(roomKey).emit('user-disconnected', socket.id);
                const [sid, ...parts] = roomKey.split('_');
                const rId = parts.join('_');
                io.to(sid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`4Ohm Unified Server running on port ${PORT}`);
});
