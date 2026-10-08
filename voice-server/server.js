const fs = require('fs');
const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // 100 MB
});
const cors = require('cors');

app.use(cors());
app.use(express.json());

const dbFile = 'dedicated_db.json';
// virtualServers[serverId] = { channels: [], messages: {}, groups: {}, userGroups: {} }
let virtualServers = {};

if(fs.existsSync(dbFile)) {
    try {
        const data = JSON.parse(fs.readFileSync(dbFile));
        if (data.virtualServers) {
            virtualServers = data.virtualServers;
        } else if (data.channels || data.messages) {
            // Migrate legacy global DB to default server
            virtualServers['default'] = {
                channels: data.channels || [],
                messages: data.messages || {},
                groups: {
                    'owner': { name: 'Owner', power: 100 },
                    'admin': { name: 'Admin', power: 75 },
                    'supporter': { name: 'Supporter', power: 50 },
                    'user': { name: 'User', power: 10 }
                },
                userGroups: {} // username -> groupId
            };
        }
    } catch(e) { console.error('Failed to parse DB'); }
}

function saveDb() {
    fs.writeFileSync(dbFile, JSON.stringify({ virtualServers }));
}

function getServerData(serverId) {
    
    if (!virtualServers[serverId]) {
        virtualServers[serverId] = {
            channels: [
                { id: 'cat-1', name: 'Willkommen', type: 'category' },
                { id: 'lobby', name: 'Lobby', type: 'text' },
                { id: 'cat-2', name: 'Voice', type: 'category' },
                { id: 'general', name: 'General', type: 'voice' }
            ],
            messages: { 'lobby': [] },
            groups: {
                'owner': { name: 'Owner', power: 100 },
                'admin': { name: 'Admin', power: 75 },
                'supporter': { name: 'Supporter', power: 50 },
                'user': { name: 'User', power: 10 }
            },
            userGroups: {},
            ownerSet: false,
            settings: { welcomeMessage: 'Willkommen auf dem Server!', defaultRole: 'user' }
        };
        saveDb();
    }
    // Migrate old servers
    if (!virtualServers[serverId].settings) {
        virtualServers[serverId].settings = { welcomeMessage: 'Willkommen auf dem Server!', defaultRole: 'user' };
        saveDb();
    }

    return virtualServers[serverId];
}

// 7-Tage Cleanup
setInterval(() => {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    let changed = false;
    for (const sid in virtualServers) {
        const srv = virtualServers[sid];
        if (srv.messages) {
            for (const room in srv.messages) {
                srv.messages[room].forEach(msg => {
                    if (msg.isMedia && msg.msg !== null && (now - msg.timestamp > sevenDays)) {
                        msg.msg = null;
                        changed = true;
                    }
                });
            }
        }
    }
    if(changed) saveDb();
}, 60 * 60 * 1000);


app.get('/api/settings', (req, res) => {
    const srv = getServerData(req.query.serverId || 'default');
    res.json(srv.settings);
});

app.post('/api/settings', (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = getServerData(srvId);
    srv.settings = { ...srv.settings, ...req.body };
    saveDb();
    res.json({ success: true });
});

app.get('/api/channels', (req, res) => {
    const srv = getServerData(req.query.serverId || 'default');
    res.json(srv.channels);
});

app.post('/api/channels', (req, res) => {
    const { name, type } = req.body;
    const srvId = req.query.serverId || 'default';
    const srv = getServerData(srvId);
    srv.channels.push({
        id: name.toLowerCase().replace(/\\s+/g, '-'),
        name,
        type
    });
    saveDb();
    res.json({ success: true });
});

app.get('/api/messages/:room', (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = getServerData(srvId);
    res.json(srv.messages[req.params.room] || []);
});

// Group APIs
app.get('/api/groups', (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = getServerData(srvId);
    res.json({ groups: srv.groups, userGroups: srv.userGroups });
});

app.post('/api/groups/assign', (req, res) => {
    const srvId = req.query.serverId || 'default';
    const srv = getServerData(srvId);
    const { targetUser, groupId, requestingUser } = req.body;
    
    // Auth check
    const reqGroupId = srv.userGroups[requestingUser] || 'user';
    const reqPower = srv.groups[reqGroupId]?.power || 0;
    
    if (reqPower < 75) {
        return res.status(403).json({ error: "Insufficient permissions" });
    }
    
    srv.userGroups[targetUser] = groupId;
    saveDb();
    
    // Broadcast group update
    io.to(srvId).emit('group-update', srv.userGroups);
    res.json({ success: true });
});

let rooms = {};

io.on('connection', socket => {
    const serverId = socket.handshake.query.serverId || 'default';
    const username = socket.handshake.query.username;
    const srv = getServerData(serverId);
    
    socket.join(serverId); // Join server-wide namespace room
    
    // Claim ownership if first to connect
    if (!srv.ownerSet && username) {
        srv.ownerSet = true;
        srv.userGroups[username] = 'owner';
    } else if (username && !srv.userGroups[username]) {
        srv.userGroups[username] = srv.settings.defaultRole || 'user';
        saveDb();
        saveDb();
    }
    
    socket.emit('group-update', srv.userGroups);

    socket.on('join-room', (roomId, peerId, userObj) => {
        socket.join(serverId + '_' + roomId);
        if(!rooms[serverId + '_' + roomId]) rooms[serverId + '_' + roomId] = {};
        rooms[serverId + '_' + roomId][socket.id] = { peerId, ...userObj, groupId: srv.userGroups[userObj.name] || 'user' };
        
        socket.to(serverId + '_' + roomId).emit('user-connected', socket.id, peerId, userObj);
        io.to(serverId).emit('room-users-update', roomId, Object.values(rooms[serverId + '_' + roomId]));
    });

    socket.on('chat-message', (roomId, msg, name, isMedia) => {
        if(!srv.messages[roomId]) srv.messages[roomId] = [];
        const msgObj = { senderName: name, msg, timestamp: Date.now(), isMedia };
        srv.messages[roomId].push(msgObj);
        saveDb();
        io.to(serverId + '_' + roomId).emit('chat-message', socket.id, name, msg, roomId, msgObj.timestamp);
    });

    socket.on('ice-candidate', (targetId, candidate) => {
        socket.to(targetId).emit('ice-candidate', socket.id, candidate);
    });

    socket.on('disconnect', () => {
        for(let roomKey in rooms) {
            if(rooms[roomKey][socket.id]) {
                const user = rooms[roomKey][socket.id];
                delete rooms[roomKey][socket.id];
                socket.to(roomKey).emit('user-disconnected', socket.id);
                // roomKey is serverId_roomId
                const [sId, ...rIdParts] = roomKey.split('_');
                const roomId = rIdParts.join('_');
                io.to(serverId).emit('room-users-update', roomId, Object.values(rooms[roomKey]));
            }
        }
    });
    
    socket.on('leave-room', (roomId) => {
        if(rooms[serverId + '_' + roomId] && rooms[serverId + '_' + roomId][socket.id]) {
            delete rooms[serverId + '_' + roomId][socket.id];
            socket.to(serverId + '_' + roomId).emit('user-disconnected', socket.id);
            socket.leave(serverId + '_' + roomId);
            io.to(serverId).emit('room-users-update', roomId, Object.values(rooms[serverId + '_' + roomId]));
        }
    });
});

http.listen(4000, () => {
    console.log('Dedicated Server running on port 4000');
});
