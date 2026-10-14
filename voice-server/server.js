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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', server: '4Ohm Dedicated Voice Server', timestamp: Date.now() });
});

// In-memory profile cache for fast user lookup
const cachedUserProfiles = {};

// Profile Route
app.get('/api/profile/:username', async (req, res) => {
    const uName = req.params.username;
    if (cachedUserProfiles[uName]) {
        return res.json(cachedUserProfiles[uName]);
    }
    // Search connected rooms
    for (const roomKey in rooms) {
        for (const sockId in rooms[roomKey]) {
            const u = rooms[roomKey][sockId];
            if (u && u.name && u.name.toLowerCase() === uName.toLowerCase()) {
                const prof = {
                    username: u.name,
                    avatar: u.avatar || '',
                    banner: u.banner || '',
                    bio: u.bio || '',
                    ringColor: u.ringColor || u.ring_color || '#00ff00',
                    role: u.groupId || 'user',
                    steamId: u.steamId || u.steam_id || '',
                    steamUsername: u.steamUsername || u.steam_username || '',
                    steamAvatar: u.steamAvatar || u.steam_avatar || '',
                    cs2InventoryMode: u.cs2InventoryMode || u.cs2_inventory_mode || 'filtered',
                    cs2ShowcaseItems: Array.isArray(u.cs2ShowcaseItems || u.cs2_showcase_items) ? (u.cs2ShowcaseItems || u.cs2_showcase_items) : [],
                    currentGame: u.currentGame || null
                };
                cachedUserProfiles[u.name] = prof;
                return res.json(prof);
            }
        }
    }
    res.status(404).json({ error: 'Nutzer nicht gefunden' });
});

// CS2 Inventory Proxy (delegates to auth server)
app.get('/api/cs2/inventory/:username', async (req, res) => {
    const authUrl = process.env.AUTH_SERVER_URL || 'https://fourohm-auth.onrender.com';
    try {
        const response = await fetch(`${authUrl}/api/cs2/inventory/${encodeURIComponent(req.params.username)}${req.query.refresh === 'true' ? '?refresh=true' : ''}`);
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post('/api/cs2/inventory/sync', async (req, res) => {
    const authUrl = process.env.AUTH_SERVER_URL || 'https://fourohm-auth.onrender.com';
    try {
        const response = await fetch(`${authUrl}/api/cs2/inventory/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Settings & Server Meta
app.get(['/api/settings', '/api/server/settings'], async (req, res) => {
    const srvId = req.query.serverId || req.body?.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    res.json({
        ...(srv.settings || {}),
        serverName: srv.name || srv.settings?.serverName || 'Server',
        icon: srv.icon || srv.settings?.icon || ''
    });
});

app.post(['/api/settings', '/api/server/settings'], async (req, res) => {
    const srvId = req.query.serverId || req.body?.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    const { serverName, icon } = req.body;
    if (serverName && typeof serverName === 'string') {
        srv.name = serverName.trim();
        if (!srv.settings) srv.settings = {};
        srv.settings.serverName = srv.name;
    }
    if (icon !== undefined) {
        srv.icon = icon;
        if (!srv.settings) srv.settings = {};
        srv.settings.icon = icon;
    }
    srv.settings = { ...srv.settings, ...req.body };
    await db.saveVirtualServer(srvId, srv);
    io.to(srvId).emit('server-info-updated', {
        serverId: srvId,
        name: srv.name || srv.settings?.serverName || 'Server',
        icon: srv.icon || srv.settings?.icon || ''
    });
    res.json({ success: true, settings: srv.settings, serverName: srv.name, icon: srv.icon });
});

// Channels
function sanitizeChannels(channels, userPower = 100) {
    if (!Array.isArray(channels)) return [];
    return channels
        .filter(c => {
            const req = c.minPower ? Number(c.minPower) : 0;
            return userPower >= req;
        })
        .map(c => {
            const copy = { ...c };
            copy.hasPassword = !!copy.password;
            copy.userLimit = c.userLimit ? Number(c.userLimit) : 0;
            copy.isHub = !!c.isHub;
            copy.isTemp = !!c.isTemp;
            copy.isAfkChannel = !!c.isAfkChannel;
            copy.minPower = c.minPower ? Number(c.minPower) : 0;
            delete copy.password;
            return copy;
        });
}

async function broadcastChannelsUpdate(sId) {
    try {
        const srv = await db.getVirtualServer(sId);
        const sockets = await io.in(sId).fetchSockets();
        for (const s of sockets) {
            const u = s.handshake.query.username;
            const role = (u && srv.userGroups && srv.userGroups[u]) || srv.settings?.defaultRole || 'user';
            const pwr = u ? (powerMap[role] || 0) : 5;
            s.emit('channels-update', sanitizeChannels(srv.channels || [], pwr));
        }
    } catch(e) {
        console.warn('Error broadcasting channels update:', e.message);
    }
}

app.get('/api/channels', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const username = req.query.username;
    const srv = await db.getVirtualServer(srvId);
    const reqRole = (username && srv.userGroups && srv.userGroups[username]) || srv.settings?.defaultRole || 'user';
    const reqPower = username ? (powerMap[reqRole] || 0) : 100;
    res.json(sanitizeChannels(srv.channels || [], reqPower));
});

app.post('/api/channels', async (req, res) => {
    const { name, type, password, userLimit, isHub, isAfkChannel, minPower } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const srvId = req.query.serverId || req.body.serverId || 'default';
    const srv = await db.getVirtualServer(srvId);
    if (!srv.channels) srv.channels = [];

    const newChannel = {
        id: name.toLowerCase().replace(/\s+/g, '-') + '_' + Date.now().toString().slice(-4),
        name,
        type: type || 'text',
        password: password ? String(password) : '',
        hasPassword: !!password,
        userLimit: userLimit ? Math.max(0, parseInt(userLimit, 10)) : 0,
        isHub: !!isHub,
        isAfkChannel: !!isAfkChannel,
        minPower: minPower ? Number(minPower) : 0,
        whitelist: []
    };
    srv.channels.push(newChannel);
    await db.saveVirtualServer(srvId, srv);

    await broadcastChannelsUpdate(srvId);
    res.json({ success: true, channel: { ...newChannel, password: undefined }, channels: sanitizeChannels(srv.channels, 100) });
});

app.post('/api/channels/rename', async (req, res) => {
    try {
        const srvId = req.body.serverId || 'default';
        const { oldName, newName, requestingUser } = req.body;
        if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
        const srv = await db.getVirtualServer(srvId);
        const reqRole = (srv.userGroups && srv.userGroups[requestingUser]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;
        if (reqPower < 75 && requestingUser) {
            return res.status(403).json({ error: 'Unzureichende Berechtigung' });
        }
        if (!srv.channels) srv.channels = [];
        const ch = srv.channels.find(c => c.name === oldName || c.id === oldName);
        if (!ch) return res.status(404).json({ error: 'Kanal nicht gefunden' });
        ch.name = newName;
        await db.saveVirtualServer(srvId, srv);
        await db.renameChannelMessages(srvId, oldName, newName);
        await broadcastChannelsUpdate(srvId);
        io.to(srvId).emit('channel-renamed', { oldName, newName, channelId: ch.id });
        res.json({ success: true, channels: sanitizeChannels(srv.channels, reqPower) });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/channels/verify-password', async (req, res) => {
    try {
        const srvId = req.body.serverId || 'default';
        const { channelName, password, username } = req.body;
        const srv = await db.getVirtualServer(srvId);
        const ch = (srv.channels || []).find(c => c.name === channelName || c.id === channelName);
        if (!ch) return res.status(404).json({ error: 'Kanal nicht gefunden' });
        if (!ch.password) return res.json({ success: true });

        // Whitelist bypass (case-insensitive)
        if (username && Array.isArray(ch.whitelist) && ch.whitelist.some(u => String(u).trim().toLowerCase() === String(username).trim().toLowerCase())) {
            return res.json({ success: true, whitelisted: true });
        }

        // Admin bypass
        const reqRole = (srv.userGroups && srv.userGroups[username]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;
        if (reqPower >= 75) {
            return res.json({ success: true, admin: true });
        }

        if (ch.password === password) {
            return res.json({ success: true });
        }
        return res.status(401).json({ success: false, error: 'Falsches Passwort' });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/channels/whitelist', async (req, res) => {
    try {
        const srvId = req.body.serverId || 'default';
        const { channelName, whitelist, requestingUser } = req.body;
        const srv = await db.getVirtualServer(srvId);
        const reqRole = (srv.userGroups && srv.userGroups[requestingUser]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;
        if (reqPower < 75 && requestingUser) {
            return res.status(403).json({ error: 'Unzureichende Berechtigung' });
        }
        const ch = (srv.channels || []).find(c => c.name === channelName || c.id === channelName);
        if (!ch) return res.status(404).json({ error: 'Kanal nicht gefunden' });
        ch.whitelist = Array.isArray(whitelist) ? whitelist : [];
        await db.saveVirtualServer(srvId, srv);
        await broadcastChannelsUpdate(srvId);
        res.json({ success: true, channel: ch });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/channels/:name', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const username = req.query.username;
    const srv = await db.getVirtualServer(srvId);

    const reqRole = (srv.userGroups && srv.userGroups[username]) || srv.settings?.defaultRole || 'user';
    const reqPower = powerMap[reqRole] || 0;

    if (reqPower >= 75 || !username) {
        srv.channels = (srv.channels || []).filter(c => c.name !== req.params.name);
        await db.saveVirtualServer(srvId, srv);
        await broadcastChannelsUpdate(srvId);
        return res.json({ success: true, channels: sanitizeChannels(srv.channels, reqPower) });
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
            const existingMap = new Map((srv.channels || []).map(c => [c.id || c.name, c]));
            srv.channels = channels.map(c => {
                const ex = existingMap.get(c.id || c.name);
                return {
                    ...c,
                    password: ex?.password || c.password || '',
                    hasPassword: !!(ex?.password || c.password),
                    whitelist: ex?.whitelist || c.whitelist || []
                };
            });
            await db.saveVirtualServer(srvId, srv);
            await broadcastChannelsUpdate(srvId);
            return res.json({ success: true, channels: sanitizeChannels(srv.channels, reqPower) });
        }
        res.status(403).json({ error: 'Unzureichende Berechtigung zum Umordnen' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Emotes
app.get('/api/emotes', async (req, res) => {
    try {
        const srvId = req.query.serverId || 'default';
        const srv = await db.getVirtualServer(srvId);
        res.json(srv.emotes || []);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/emotes', async (req, res) => {
    try {
        const { serverId = 'default', name, imageUrl, requestingUser } = req.body;
        if (!name || !imageUrl) return res.status(400).json({ error: 'Name und Bild erforderlich' });
        const srv = await db.getVirtualServer(serverId);
        const reqRole = (srv.userGroups && srv.userGroups[requestingUser]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;
        if (reqPower < 75 && requestingUser) {
            return res.status(403).json({ error: 'Nur Owner und Admins können Emotes hochladen' });
        }
        if (!srv.emotes) srv.emotes = [];
        const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
        srv.emotes = srv.emotes.filter(e => e.name !== cleanName);
        srv.emotes.push({ name: cleanName, url: imageUrl });
        await db.saveVirtualServer(serverId, srv);
        io.to(serverId).emit('emotes-update', srv.emotes);
        res.json({ success: true, emotes: srv.emotes });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/emotes/:name', async (req, res) => {
    try {
        const serverId = req.query.serverId || 'default';
        const requestingUser = req.query.requestingUser;
        const srv = await db.getVirtualServer(serverId);
        const reqRole = (srv.userGroups && srv.userGroups[requestingUser]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;
        if (reqPower < 75 && requestingUser) {
            return res.status(403).json({ error: 'Nur Owner und Admins können Emotes löschen' });
        }
        srv.emotes = (srv.emotes || []).filter(e => e.name !== req.params.name);
        await db.saveVirtualServer(serverId, srv);
        io.to(serverId).emit('emotes-update', srv.emotes);
        res.json({ success: true, emotes: srv.emotes });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Messages & Pinned Messages
app.get('/api/messages/pinned', async (req, res) => {
    try {
        const srvId = req.query.serverId || 'default';
        const roomId = req.query.roomId;
        if (!roomId) return res.status(400).json({ error: 'roomId required' });
        const pins = await db.getPinnedMessages(srvId, roomId);
        res.json(pins);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/messages/:room', async (req, res) => {
    const srvId = req.query.serverId || 'default';
    const username = req.query.username;
    const srv = await db.getVirtualServer(srvId);
    const ch = (srv.channels || []).find(c => c.name === req.params.room || c.id === req.params.room);
    if (ch && ch.minPower) {
        const role = (username && srv.userGroups && srv.userGroups[username]) || srv.settings?.defaultRole || 'user';
        const pwr = username ? (powerMap[role] || 0) : 0;
        if (pwr < ch.minPower) {
            return res.status(403).json({ error: 'Keine Berechtigung' });
        }
    }
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

    const myRole = (username && srv.userGroups && srv.userGroups[username]) || srv.settings?.defaultRole || 'user';
    const myPower = username ? (powerMap[myRole] || 0) : 5;

    socket.emit('group-update', srv.userGroups || {});
    socket.emit('channels-update', sanitizeChannels(srv.channels || [], myPower));
    socket.emit('emotes-update', srv.emotes || []);
    socket.emit('server-info-updated', {
        serverId,
        name: srv.name || srv.settings?.serverName || 'Server',
        icon: srv.icon || srv.settings?.icon || ''
    });

    async function cleanupEmptyTempChannels(sId, rId) {
        const rKey = sId + '_' + rId;
        if (!rooms[rKey] || Object.keys(rooms[rKey]).length === 0) {
            const srv = await db.getVirtualServer(sId);
            if (srv && srv.channels) {
                const idx = srv.channels.findIndex(c => (c.name === rId || c.id === rId) && c.isTemp);
                if (idx > -1) {
                    srv.channels.splice(idx, 1);
                    await db.saveVirtualServer(sId, srv);
                    await broadcastChannelsUpdate(sId);
                }
            }
        }
    }

    socket.on('join-room', async (roomId, peerId, userObj) => {
        const roomKey = serverId + '_' + roomId;
        const srvData = await db.getVirtualServer(serverId);
        const uName = (userObj && userObj.name) || peerId || username || 'Gast';
        const role = (srvData.userGroups && srvData.userGroups[uName]) || srvData.settings?.defaultRole || 'user';
        const reqPower = powerMap[role] || 0;

        const channels = srvData.channels || [];
        const ch = channels.find(c => c.name === roomId || c.id === roomId);

        // 1. Hub Channel Handler (Join-to-Create)
        if (ch && ch.isHub) {
            const tempId = 'temp_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            const tempName = `🔊 ${uName}'s Kanal`;
            const tempChannel = {
                id: tempId,
                name: tempName,
                type: 'voice',
                isTemp: true,
                creator: uName,
                userLimit: ch.userLimit || 0
            };
            srvData.channels.push(tempChannel);
            await db.saveVirtualServer(serverId, srvData);
            await broadcastChannelsUpdate(serverId);
            socket.emit('redirect-to-room', { newRoomId: tempName, newRoomName: tempName });
            return;
        }

        // 2. User Limit Check
        if (ch && ch.userLimit > 0) {
            const currentCount = rooms[roomKey] ? Object.keys(rooms[roomKey]).length : 0;
            if ((!rooms[roomKey] || !rooms[roomKey][socket.id]) && currentCount >= ch.userLimit && reqPower < 75) {
                socket.emit('channel-full', { roomId, limit: ch.userLimit });
                return;
            }
        }

        socket.join(roomKey);
        if (!rooms[roomKey]) rooms[roomKey] = {};

        const isAfkCh = ch && (ch.isAfkChannel || (ch.name && ch.name.toLowerCase().includes('afk')));
        const member = {
            socketId: socket.id,
            peerId,
            name: uName,
            groupId: role,
            currentGame: (userObj && userObj.currentGame) ? String(userObj.currentGame).trim().slice(0, 60) : null,
            ...(typeof userObj === 'object' ? userObj : {}),
            isMuted: isAfkCh ? true : !!(userObj && userObj.isMuted),
            isAfk: isAfkCh ? true : !!(userObj && userObj.isAfk)
        };
        rooms[roomKey][socket.id] = member;

        if (uName) {
            cachedUserProfiles[uName] = {
                username: uName,
                avatar: member.avatar || '',
                banner: member.banner || '',
                bio: member.bio || '',
                ringColor: member.ringColor || member.ring_color || '#00ff00',
                role: role,
                currentGame: member.currentGame || null
            };
        }

        socket.to(roomKey).emit('user-connected', socket.id, peerId, rooms[roomKey][socket.id]);
        io.to(serverId).emit('room-users-update', roomId, Object.values(rooms[roomKey]));
    });

    socket.on('leave-room', async (roomId) => {
        const roomKey = serverId + '_' + roomId;
        if (rooms[roomKey] && rooms[roomKey][socket.id]) {
            delete rooms[roomKey][socket.id];
            socket.to(roomKey).emit('user-disconnected', socket.id);
            socket.leave(roomKey);
            io.to(serverId).emit('room-users-update', roomId, Object.values(rooms[roomKey]));
            await cleanupEmptyTempChannels(serverId, roomId);
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
                const [sid, ...parts] = roomKey.split('_');
                const rId = parts.join('_');
                const srvChannels = srv.channels || [];
                const ch = srvChannels.find(c => c.name === rId || c.id === rId);
                const isAfkRoom = ch && (ch.isAfkChannel || (ch.name && ch.name.toLowerCase().includes('afk')));
                rooms[roomKey][socket.id].isMuted = isAfkRoom ? true : !!isMuted;
                rooms[roomKey][socket.id].isDeafened = !!isDeafened;
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

    socket.on('user-game-status', ({ game, username: explicitUser }) => {
        const uName = explicitUser || username;
        const cleanGame = game ? String(game).trim().slice(0, 60) : null;
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                rooms[roomKey][socket.id].currentGame = cleanGame;
                const [sid, ...parts] = roomKey.split('_');
                const rId = parts.join('_');
                io.to(sid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
            }
        }
        if (uName) {
            if (!cachedUserProfiles[uName]) {
                cachedUserProfiles[uName] = { username: uName };
            }
            cachedUserProfiles[uName].currentGame = cleanGame;
        }
        io.to(serverId).emit('user-game-updated', { username: uName, game: cleanGame });
    });

    socket.on('join-text-room', async (roomId) => {
        if (!roomId) return;
        const srvData = await db.getVirtualServer(serverId);
        const ch = (srvData.channels || []).find(c => c.name === roomId || c.id === roomId);
        const role = (srvData.userGroups && srvData.userGroups[username]) || srvData.settings?.defaultRole || 'user';
        const reqPower = powerMap[role] || 0;
        if (ch && ch.minPower && reqPower < ch.minPower) {
            return; // Not permitted to join restricted text room
        }
        const roomKey = serverId + '_' + roomId;
        socket.join(roomKey);
    });

    socket.on('chat-message', async (roomId, msg, name, isMedia) => {
        if (!roomId || !msg) return;
        const srvData = await db.getVirtualServer(serverId);
        const sender = name || username || 'Gast';
        const role = (srvData.userGroups && srvData.userGroups[sender]) || srvData.settings?.defaultRole || 'user';
        const reqPower = powerMap[role] || 0;

        const ch = (srvData.channels || []).find(c => c.name === roomId || c.id === roomId);
        if (ch && ch.minPower && reqPower < ch.minPower) {
            return; // Not permitted to post in this room
        }

        // Moderation text commands (/kick, /ban, /mute) in moderation / staff rooms or by staff
        if (typeof msg === 'string' && msg.startsWith('/') && reqPower >= 50) {
            const parts = msg.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase();
            const targetUser = parts[1];

            if (cmd === '/kick' && targetUser) {
                io.to(serverId).emit('user-kicked', targetUser);
                const auditMsg = {
                    id: 'audit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                    senderName: '🛡️ SYSTEM-AUDIT',
                    msg: `Moderator **${sender}** hat **${targetUser}** per Chat-Befehl gekickt.`,
                    timestamp: Date.now(),
                    isMedia: false,
                    edited: false,
                    reactions: {}
                };
                await db.addMessage(serverId, roomId, auditMsg);
                io.to(serverId + '_' + roomId).emit('chat-message', 'system', auditMsg.senderName, auditMsg.msg, roomId, auditMsg.timestamp, auditMsg.id, {}, false, null, null, false);
                return;
            } else if (cmd === '/ban' && targetUser && reqPower >= 75) {
                srvData.banned = srvData.banned || [];
                if (!srvData.banned.includes(targetUser)) srvData.banned.push(targetUser);
                await db.saveVirtualServer(serverId, srvData);
                io.to(serverId).emit('user-banned', targetUser);
                const auditMsg = {
                    id: 'audit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                    senderName: '🛡️ SYSTEM-AUDIT',
                    msg: `Administrator **${sender}** hat **${targetUser}** per Chat-Befehl dauerhaft gebannt.`,
                    timestamp: Date.now(),
                    isMedia: false,
                    edited: false,
                    reactions: {}
                };
                await db.addMessage(serverId, roomId, auditMsg);
                io.to(serverId + '_' + roomId).emit('chat-message', 'system', auditMsg.senderName, auditMsg.msg, roomId, auditMsg.timestamp, auditMsg.id, {}, false, null, null, false);
                return;
            } else if (cmd === '/mute' && targetUser) {
                srvData.serverMuted = srvData.serverMuted || [];
                if (!srvData.serverMuted.includes(targetUser)) srvData.serverMuted.push(targetUser);
                await db.saveVirtualServer(serverId, srvData);
                io.to(serverId).emit('user-server-muted', targetUser);
                const auditMsg = {
                    id: 'audit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                    senderName: '🛡️ SYSTEM-AUDIT',
                    msg: `Moderator **${sender}** hat **${targetUser}** per Chat-Befehl stummgeschaltet.`,
                    timestamp: Date.now(),
                    isMedia: false,
                    edited: false,
                    reactions: {}
                };
                await db.addMessage(serverId, roomId, auditMsg);
                io.to(serverId + '_' + roomId).emit('chat-message', 'system', auditMsg.senderName, auditMsg.msg, roomId, auditMsg.timestamp, auditMsg.id, {}, false, null, null, false);
                return;
            }
        }

        const msgObj = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            senderName: sender,
            msg,
            timestamp: Date.now(),
            isMedia: !!isMedia,
            edited: false,
            reactions: {}
        };

        // Mini Games & Tools (/roll, /flip, /poll)
        if (typeof msg === 'string' && !isMedia) {
            const trimmed = msg.trim();
            if (/^\/roll(\s+\d+)?$/i.test(trimmed)) {
                const match = trimmed.match(/^\/roll(?:\s+(\d+))?/i);
                const max = match && match[1] ? Math.max(2, parseInt(match[1], 10)) : 100;
                const result = Math.floor(Math.random() * max) + 1;
                msgObj.game = { type: 'roll', max, result, user: sender };
                msgObj.msg = `🎲 **${sender}** würfelt eine **${result}** (1-${max})`;
            } else if (/^\/flip$/i.test(trimmed)) {
                const result = Math.random() < 0.5 ? 'Kopf' : 'Zahl';
                msgObj.game = { type: 'flip', result, user: sender };
                msgObj.msg = `🪙 **${sender}** wirft eine Münze: **${result}**!`;
            } else if (/^\/poll\s+/i.test(trimmed)) {
                const raw = trimmed.replace(/^\/poll\s+/i, '');
                let question = '';
                let optsPart = '';
                if (raw.includes('?') && raw.indexOf('?') < raw.indexOf('|')) {
                    const qIdx = raw.indexOf('?');
                    question = raw.slice(0, qIdx + 1).trim();
                    optsPart = raw.slice(qIdx + 1).trim();
                } else if (raw.includes('|')) {
                    const firstPipe = raw.indexOf('|');
                    question = raw.slice(0, firstPipe).trim();
                    optsPart = raw.slice(firstPipe + 1).trim();
                }
                const options = optsPart.split('|').map(s => s.trim()).filter(s => s.length > 0);
                if (question && options.length >= 2) {
                    msgObj.poll = {
                        question: question,
                        options: options.map(o => ({ text: o, votes: [] })),
                        creator: sender
                    };
                    msgObj.msg = `📊 **Umfrage:** ${question}`;
                }
            }
        }

        const saved = await db.addMessage(serverId, roomId, msgObj);
        const finalId = (saved && saved.id) || msgObj.id;

        const roomKey = serverId + '_' + roomId;
        const isRestricted = ch && ch.minPower && ch.minPower > 0;

        io.to(roomKey).emit('chat-message', socket.id, sender, msgObj.msg, roomId, msgObj.timestamp, finalId, msgObj.reactions, false, msgObj.poll || null, msgObj.game || null, msgObj.isPinned || false);
        if (!isRestricted) {
            io.to(serverId).emit('chat-message', socket.id, sender, msgObj.msg, roomId, msgObj.timestamp, finalId, msgObj.reactions, false, msgObj.poll || null, msgObj.game || null, msgObj.isPinned || false);
        }
    });

    socket.on('pin-message', async ({ roomId, messageId, isPinned, requestingUser }) => {
        const uName = requestingUser || username;
        const srvData = await db.getVirtualServer(serverId);
        const role = (srvData.userGroups && srvData.userGroups[uName]) || srvData.settings?.defaultRole || 'user';
        const reqPower = powerMap[role] || 0;
        if (reqPower < 50) return; // Only supporters, admins, owner can pin
        const pinnedList = await db.pinMessage(serverId, roomId, messageId, isPinned);
        io.to(serverId + '_' + roomId).emit('pinned-messages-updated', { roomId, pinnedMessages: pinnedList });
        io.to(serverId).emit('pinned-messages-updated', { roomId, pinnedMessages: pinnedList });
    });

    socket.on('get-pinned-messages', async ({ roomId }, callback) => {
        if (!roomId) return;
        const pinnedList = await db.getPinnedMessages(serverId, roomId);
        if (typeof callback === 'function') {
            callback(pinnedList);
        } else {
            socket.emit('pinned-messages-updated', { roomId, pinnedMessages: pinnedList });
        }
    });

    socket.on('poll-vote', async ({ roomId, messageId, optionIndex, username: voter }) => {
        const uName = voter || username;
        if (!roomId || !messageId || optionIndex === undefined || !uName) return;
        const updatedPoll = await db.votePoll(serverId, roomId, messageId, optionIndex, uName);
        if (updatedPoll) {
            io.to(serverId + '_' + roomId).emit('poll-updated', { roomId, messageId, poll: updatedPoll });
            io.to(serverId).emit('poll-updated', { roomId, messageId, poll: updatedPoll });
        }
    });

    socket.on('edit-message', async ({ roomId, messageId, newText }) => {
        if (!roomId || !messageId || !newText) return;
        await db.editMessage(serverId, roomId, messageId, newText);
        io.to(serverId).emit('message-edited', { roomId, messageId, newText, timestamp: Date.now() });
    });

    socket.on('delete-message', async ({ roomId, messageId }) => {
        if (!roomId || !messageId) return;
        await db.deleteMessage(serverId, roomId, messageId);
        io.to(serverId).emit('message-deleted', { roomId, messageId, timestamp: Date.now() });
    });

    socket.on('toggle-reaction', async ({ roomId, messageId, emoji, username: reactingUser }) => {
        const uName = reactingUser || username;
        if (!roomId || !messageId || !emoji || !uName) return;
        const updated = await db.updateReaction(serverId, roomId, messageId, emoji, uName);
        io.to(serverId).emit('reaction-updated', { roomId, messageId, reactions: updated });
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

    socket.on('ping-check', (clientTimestamp, callback) => {
        if (typeof callback === 'function') {
            callback(clientTimestamp);
        } else {
            socket.emit('pong-check', clientTimestamp);
        }
    });

    socket.on('whisper-start', ({ targets, senderName }) => {
        const uName = senderName || username;
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                for (const targetSockId in rooms[roomKey]) {
                    const targetUser = rooms[roomKey][targetSockId];
                    if (targetUser && Array.isArray(targets) && targets.includes(targetUser.name)) {
                        io.to(targetSockId).emit('whisper-start', { senderName: uName, senderSocketId: socket.id });
                    }
                }
            }
        }
    });

    socket.on('whisper-stop', ({ senderName }) => {
        const uName = senderName || username;
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                for (const targetSockId in rooms[roomKey]) {
                    io.to(targetSockId).emit('whisper-stop', { senderName: uName, senderSocketId: socket.id });
                }
            }
        }
    });

    socket.on('disconnect', async () => {
        for (const roomKey in rooms) {
            if (rooms[roomKey][socket.id]) {
                delete rooms[roomKey][socket.id];
                socket.to(roomKey).emit('user-disconnected', socket.id);
                const [sid, ...parts] = roomKey.split('_');
                const rId = parts.join('_');
                io.to(sid).emit('room-users-update', rId, Object.values(rooms[roomKey]));
                await cleanupEmptyTempChannels(sid, rId);
            }
        }
    });
});

const PORT = process.env.PORT || 4000;
http.listen(PORT, () => {
    console.log(`4Ohm Dedicated Voice Server running on port ${PORT}`);
});
