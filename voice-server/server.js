const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // 100 MB
});
const cors = require('cors');
const db = require('./db');

const powerMap = { owner: 100, admin: 75, supporter: 50, user: 5, gast: 1, banned: 0 };

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', server: '4Ohm Dedicated Voice Server', timestamp: Date.now() });
});

// Settings
app.get('/api/settings', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    res.json(srv.settings || {});
});

app.post('/api/settings', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    srv.settings = { ...srv.settings, ...req.body };
    await db.saveVirtualServer(srvId, srv);
    res.json({ success: true, settings: srv.settings });
});

// Channels
app.get('/api/channels', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    res.json(srv.channels || []);
});

app.post('/api/channels', async (req, res) => {
    const { name, type } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const srvId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    if (!srv.channels) srv.channels = [];

    const newChannel = {
        id: name.toLowerCase().replace(/\s+/g, '-') + '_' + Date.now().toString().slice(-4),
        name,
        type: type || 'text'
    };
    srv.channels.push(newChannel);
    await db.saveVirtualServer(srvId, srv);

    io.to(srvId).emit('channels-update', srv.channels);
    res.json({ success: true, channel: newChannel, channels: srv.channels });
});

app.delete('/api/channels/:name', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const username = req.query.username;
    const srv = await db.getVirtualServer(srvId);

    const reqRole = srv.userGroups[username] || srv.settings?.defaultRole || 'user';
    const reqPower = powerMap[reqRole] || 0;

    if (reqPower >= 75 || !username) {
        srv.channels = (srv.channels || []).filter(c => c.name !== req.params.name);
        await db.saveVirtualServer(srvId, srv);
        io.to(srvId).emit('channels-update', srv.channels);
        return res.json({ success: true, channels: srv.channels });
    }
    return res.status(403).json({ error: 'Insufficient power' });
});

app.post('/api/channels/reorder', async (req, res) => {
    try {
        const srvId = req.body.serverId || 'default';
        const { channels, requestingUser } = req.body;
        if (!Array.isArray(channels)) return res.status(400).json({ error: 'Kanäle Array erforderlich' });
        const srv = await db.getVirtualServer(srvId);
        if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });

        const reqRole = (srv.userGroups && srv.userGroups[requestingUser]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;

        if (reqPower >= 75 || !requestingUser) {
            srv.channels = channels;
            await db.saveVirtualServer(srvId, srv);
            io.to(srvId).emit('channels-update', srv.channels);
            return res.json({ success: true, channels: srv.channels });
        }
        res.status(403).json({ error: 'Unzureichende Berechtigung zum Umordnen' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Messages
app.get('/api/messages/:room', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const msgs = await db.getMessages(srvId, req.params.room);
    res.json(msgs);
});

// Groups & Roles
app.get('/api/groups', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    res.json({ groups: srv.groups, userGroups: srv.userGroups });
});

app.post('/api/groups/assign', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    const { targetUser, groupId, requestingUser } = req.body;

    const reqGroupId = srv.userGroups[requestingUser] || 'user';
    const reqPower = srv.groups?.[reqGroupId]?.power || powerMap[reqGroupId] || 0;

    if (reqPower < 75) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }

    if (!srv.userGroups) srv.userGroups = {};
    srv.userGroups[targetUser] = groupId;
    await db.saveVirtualServer(srvId, srv);

    io.to(srvId).emit('group-update', srv.userGroups);

    // Live update in all active voice rooms on this server:
    for (const roomKey in rooms) {
        if (roomKey.startsWith(srvId + '_')) {
            let changed = false;
            for (const sockId in rooms[roomKey]) {
                if (rooms[roomKey][sockId].name === targetUser) {
                    rooms[roomKey][sockId].groupId = groupId;
                    changed = true;
                }
            }
            if (changed) {
                const rId = roomKey.replace(srvId + '_', '');
                io.to(srvId).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
    }

    res.json({ success: true });
});

// Moderation
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
    return res.status(403).json({ error: 'Insufficient power or invalid action' });
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

// Sockets & WebRTC
let rooms = {};

io.on('connection', async (socket) => {
    const serverId = socket.handshake.query.serverId || 'default';
    const username = socket.handshake.query.username;
    const srv = await db.getVirtualServer(serverId);

    socket.join(serverId);

    if (username) {
        if (!srv.userGroups) srv.userGroups = {};
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

    socket.on('join-room', async (roomId, peerId, userObj) => {
        const roomKey = serverId + '_' + roomId;
        socket.join(roomKey);
        if (!rooms[roomKey]) rooms[roomKey] = {};

        const srvData = await db.getVirtualServer(serverId);
        const uName = (userObj && userObj.name) || peerId || username || 'Gast';
        const role = (srvData.userGroups && srvData.userGroups[uName]) || srvData.settings?.defaultRole || 'user';

        rooms[roomKey][socket.id] = {
            socketId: socket.id,
            peerId,
            name: uName,
            groupId: role,
            ...(typeof userObj === 'object' ? userObj : {})
        };

        socket.to(roomKey).emit('user-connected', socket.id, peerId, rooms[roomKey][socket.id]);
        io.to(serverId).emit('room-users-update', roomId, Object.values(rooms[roomKey]));
    });

    socket.on('leave-room', (roomId) => {
        const roomKey = serverId + '_' + roomId;
        if (rooms[roomKey] && rooms[roomKey][socket.id]) {
            delete rooms[roomKey][socket.id];
            socket.to(roomKey).emit('user-disconnected', socket.id);
            socket.leave(roomKey);
            io.to(serverId).emit('room-users-update', roomId, Object.values(rooms[roomKey]));
        }
    });

    socket.on('afk-status', ({ isAfk, afkMessage, username: explicitUser }) => {
        const uName = explicitUser || username;
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].isAfk = !!isAfk;
                rooms[roomKey][socket.id].afkMessage = afkMessage ? String(afkMessage).slice(0, 100) : '';
                const [sid, ...parts] = roomKey.split('_');
                const rId = parts.join('_');
                io.to(sid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        io.to(serverId).emit('user-afk-updated', { username: uName, isAfk: !!isAfk, afkMessage: afkMessage ? String(afkMessage).slice(0, 100) : '' });
    });

    socket.on('stream-status', ({ isStreaming, username: explicitUser }) => {
        const uName = explicitUser || username;
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].isStreaming = !!isStreaming;
                const [sid, ...parts] = roomKey.split('_');
                const rId = parts.join('_');
                io.to(sid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        io.to(serverId).emit('user-stream-updated', { username: uName, isStreaming: !!isStreaming });
    });

    socket.on('user-voice-state', ({ isMuted, isDeafened, username: explicitUser }) => {
        const uName = explicitUser || username;
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].isMuted = !!isMuted;
                rooms[roomKey][socket.id].isDeafened = !!isDeafened;
                const [sid, ...parts] = roomKey.split('_');
                const rId = parts.join('_');
                io.to(sid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        io.to(serverId).emit('user-voice-state-updated', { username: uName, isMuted: !!isMuted, isDeafened: !!isDeafened });
    });

    socket.on('user-ring-color-update', ({ ringColor, username: explicitUser }) => {
        const uName = explicitUser || username;
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].ringColor = ringColor;
                rooms[roomKey][socket.id].ring_color = ringColor;
                const [sid, ...parts] = roomKey.split('_');
                const rId = parts.join('_');
                io.to(sid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        io.to(serverId).emit('user-ring-color-updated', { username: uName, ringColor });
    });

    socket.on('chat-message', async (roomId, msg, name, isMedia) => {
        const msgObj = { senderName: name, msg, timestamp: Date.now(), isMedia };
        await db.addMessage(serverId, roomId, msgObj);

        const roomKey = serverId + '_' + roomId;
        io.to(roomKey).emit('chat-message', socket.id, name, msg, roomId, msgObj.timestamp);
    });

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

    socket.on('disconnect', () => {
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

const PORT = process.env.PORT || 4000;
http.listen(PORT, () => {
    console.log(`4Ohm Dedicated Voice Server running on port ${PORT}`);
});
