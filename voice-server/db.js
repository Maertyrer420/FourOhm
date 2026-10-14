const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Optional PostgreSQL support
let pgPool = null;
if (process.env.DATABASE_URL) {
    try {
        const { Pool } = require('pg');
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
        });
        console.log('[DB] PostgreSQL configured via DATABASE_URL');
    } catch (e) {
        console.error('[DB] Failed to initialize PostgreSQL pool:', e.message);
        pgPool = null;
    }
}

// Fallback: Local JSON database stored in data/ directory
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const usersFile = path.join(dataDir, 'users.json');
const serversFile = path.join(dataDir, 'virtual_servers.json');

if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, JSON.stringify([], null, 2));
}
if (!fs.existsSync(serversFile)) {
    fs.writeFileSync(serversFile, JSON.stringify({}, null, 2));
}

// Initialize PostgreSQL tables if pool is active
let rawQuery = null;
async function initPgTables() {
    if (!pgPool) return;
    try {
        await rawQuery(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT,
                friends JSONB DEFAULT '[]'::jsonb,
                settings JSONB DEFAULT '{}'::jsonb,
                servers JSONB DEFAULT '[]'::jsonb
            );
            CREATE TABLE IF NOT EXISTS virtual_servers (
                id TEXT PRIMARY KEY,
                data JSONB
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                server_id TEXT NOT NULL,
                room TEXT NOT NULL,
                sender TEXT,
                msg TEXT,
                is_media BOOLEAN DEFAULT false,
                ts BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (server_id, room, ts);
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false;
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}'::jsonb;
        `);
        console.log('[DB] PostgreSQL tables ready');
    } catch (e) {
        console.error('[DB] PostgreSQL table init failed:', e.message);
    }
}
let pgReady = Promise.resolve();
if (pgPool) {
    rawQuery = pgPool.query.bind(pgPool);
    pgReady = initPgTables();
    // Every query waits until the tables exist
    pgPool.query = async (...args) => { await pgReady; return rawQuery(...args); };
    pgPool.on('error', (e) => console.error('[DB] Pool error:', e.message));
}

// Local file helpers
function getLocalUsers() {
    try {
        return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveLocalUsers(users) {
    const tmp = usersFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, usersFile);
}

function getLocalVirtualServers() {
    try {
        return JSON.parse(fs.readFileSync(serversFile, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveLocalVirtualServers(data) {
    const tmp = serversFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, serversFile);
}

const vsCache = {};
const vsLoading = {};
const MAX_HISTORY = 300;

module.exports = {
    register: async (username, password) => {
        if (!username || !password) throw new Error('Benutzername und Passwort erforderlich.');
        username = username.trim();
        const hashedPassword = bcrypt.hashSync(password, 8);
        const newUser = {
            id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 4),
            username,
            password: hashedPassword,
            friends: [],
            settings: {},
            servers: []
        };

        if (pgPool) {
            try {
                const res = await pgPool.query(
                    'INSERT INTO users (id, username, password, friends, settings, servers) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                    [newUser.id, newUser.username, newUser.password, JSON.stringify([]), JSON.stringify({}), JSON.stringify([])]
                );
                return res.rows[0];
            } catch (e) {
                if (e.code === '23505') throw new Error('Benutzername bereits vergeben.');
                throw e;
            }
        } else {
            const users = getLocalUsers();
            if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
                throw new Error('Benutzername bereits vergeben.');
            }
            users.push(newUser);
            saveLocalUsers(users);
            return newUser;
        }
    },

    login: async (username, password) => {
        if (!username || !password) throw new Error('Benutzername und Passwort erforderlich.');
        username = username.trim();

        let user = null;
        if (pgPool) {
            const res = await pgPool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
            user = res.rows[0];
        } else {
            const users = getLocalUsers();
            user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
        }

        if (!user) throw new Error('Benutzer nicht gefunden.');
        const isValid = bcrypt.compareSync(password, user.password);
        if (!isValid) throw new Error('Falsches Passwort.');
        return user;
    },

    getUserById: async (id) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT * FROM users WHERE id = $1', [id]);
            return res.rows[0] || null;
        }
        return getLocalUsers().find(u => u.id === id) || null;
    },

    getUserByUsername: async (username) => {
        if (!username) return null;
        username = username.trim();
        if (pgPool) {
            const res = await pgPool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
            return res.rows[0] || null;
        }
        return getLocalUsers().find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
    },

    addFriend: async (userId, friendUsername) => {
        if (!friendUsername) throw new Error('Ungültiger Name');
        friendUsername = friendUsername.trim();

        if (pgPool) {
            const uRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [userId]);
            const fRes = await pgPool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [friendUsername]);
            const user = uRes.rows[0];
            const friend = fRes.rows[0];

            if (!user) throw new Error('User nicht gefunden');
            if (!friend) throw new Error('Freund existiert nicht');
            if (user.id === friend.id) throw new Error('Du kannst dich nicht selbst adden');

            const uFriends = Array.isArray(user.friends) ? user.friends : [];
            const fFriends = Array.isArray(friend.friends) ? friend.friends : [];

            if (uFriends.includes(friend.id)) throw new Error('Bereits befreundet');
            uFriends.push(friend.id);
            if (!fFriends.includes(user.id)) fFriends.push(user.id);

            await pgPool.query('UPDATE users SET friends = $1 WHERE id = $2', [JSON.stringify(uFriends), user.id]);
            await pgPool.query('UPDATE users SET friends = $1 WHERE id = $2', [JSON.stringify(fFriends), friend.id]);
            return { id: friend.id, username: friend.username };
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            const friend = users.find(u => u.username.toLowerCase() === friendUsername.toLowerCase());

            if (!user) throw new Error('User nicht gefunden');
            if (!friend) throw new Error('Freund existiert nicht');
            if (user.id === friend.id) throw new Error('Du kannst dich nicht selbst adden');

            if (!user.friends) user.friends = [];
            if (user.friends.includes(friend.id)) throw new Error('Bereits befreundet');
            user.friends.push(friend.id);

            if (!friend.friends) friend.friends = [];
            if (!friend.friends.includes(user.id)) friend.friends.push(user.id);

            saveLocalUsers(users);
            return { id: friend.id, username: friend.username };
        }
    },

    removeFriend: async (userId, friendId) => {
        if (pgPool) {
            const uRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [userId]);
            const fRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [friendId]);
            if (uRes.rows[0]) {
                const friends = (uRes.rows[0].friends || []).filter(id => id !== friendId);
                await pgPool.query('UPDATE users SET friends = $1 WHERE id = $2', [JSON.stringify(friends), userId]);
            }
            if (fRes.rows[0]) {
                const friends = (fRes.rows[0].friends || []).filter(id => id !== userId);
                await pgPool.query('UPDATE users SET friends = $1 WHERE id = $2', [JSON.stringify(friends), friendId]);
            }
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            const friend = users.find(u => u.id === friendId);
            if (user && user.friends) user.friends = user.friends.filter(id => id !== friendId);
            if (friend && friend.friends) friend.friends = friend.friends.filter(id => id !== userId);
            saveLocalUsers(users);
        }
    },

    getFriends: async (userId) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT friends FROM users WHERE id = $1', [userId]);
            const friendIds = res.rows[0]?.friends || [];
            if (!friendIds.length) return [];
            const friendsRes = await pgPool.query('SELECT id, username FROM users WHERE id = ANY($1)', [friendIds]);
            return friendsRes.rows;
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            if (!user || !user.friends) return [];
            return users.filter(u => user.friends.includes(u.id)).map(u => ({ id: u.id, username: u.username }));
        }
    },

    getSettings: async (userId) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT settings FROM users WHERE id = $1', [userId]);
            return res.rows[0]?.settings || {};
        }
        const user = getLocalUsers().find(u => u.id === userId);
        return user ? (user.settings || {}) : {};
    },

    saveSettings: async (userId, settings) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT settings FROM users WHERE id = $1', [userId]);
            const current = res.rows[0]?.settings || {};
            const merged = { ...current, ...settings };
            await pgPool.query('UPDATE users SET settings = $1 WHERE id = $2', [JSON.stringify(merged), userId]);
            return merged;
        }
        const users = getLocalUsers();
        const user = users.find(u => u.id === userId);
        if (user) {
            user.settings = { ...user.settings, ...settings };
            saveLocalUsers(users);
            return user.settings;
        }
        return {};
    },

    getUserServers: async (userId) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT servers FROM users WHERE id = $1', [userId]);
            return res.rows[0]?.servers || [];
        }
        const user = getLocalUsers().find(u => u.id === userId);
        return user ? (user.servers || []) : [];
    },

    addUserServer: async (userId, serverData) => {
        if (!serverData.id) serverData.id = 'srv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

        if (pgPool) {
            const res = await pgPool.query('SELECT servers FROM users WHERE id = $1', [userId]);
            const servers = res.rows[0]?.servers || [];
            servers.push(serverData);
            await pgPool.query('UPDATE users SET servers = $1 WHERE id = $2', [JSON.stringify(servers), userId]);
            return serverData;
        }
        const users = getLocalUsers();
        const user = users.find(u => u.id === userId);
        if (user) {
            if (!user.servers) user.servers = [];
            user.servers.push(serverData);
            saveLocalUsers(users);
            return serverData;
        }
        throw new Error('User not found');
    },

    removeUserServer: async (userId, serverId) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT servers FROM users WHERE id = $1', [userId]);
            let servers = res.rows[0]?.servers || [];
            servers = servers.filter(s => s.id !== serverId);
            await pgPool.query('UPDATE users SET servers = $1 WHERE id = $2', [JSON.stringify(servers), userId]);
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            if (user && user.servers) {
                user.servers = user.servers.filter(s => s.id !== serverId);
                saveLocalUsers(users);
            }
        }
    },

    updateUserServer: async (userId, serverId, data) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT servers FROM users WHERE id = $1', [userId]);
            let servers = res.rows[0]?.servers || [];
            const s = servers.find(s => s.id === serverId);
            if (s) {
                if (data.name !== undefined) s.name = data.name;
                if (data.ip !== undefined) s.ip = data.ip;
                if (data.motd !== undefined) s.motd = data.motd;
                await pgPool.query('UPDATE users SET servers = $1 WHERE id = $2', [JSON.stringify(servers), userId]);
                return s;
            }
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            if (user && user.servers) {
                const s = user.servers.find(s => s.id === serverId);
                if (s) {
                    if (data.name !== undefined) s.name = data.name;
                    if (data.ip !== undefined) s.ip = data.ip;
                    if (data.motd !== undefined) s.motd = data.motd;
                    saveLocalUsers(users);
                    return s;
                }
            }
        }
        throw new Error('Server nicht gefunden');
    },

    // --- Virtual Servers (Channels, Roles, Settings) ---
    // Cached in memory: every request works on the same object, so simultaneous
    // changes can't overwrite each other. Writes go straight through to the DB.
    getVirtualServer: async (serverId) => {
        serverId = serverId || 'default';
        if (vsCache[serverId]) return vsCache[serverId];
        if (vsLoading[serverId]) return vsLoading[serverId];

        vsLoading[serverId] = (async () => {
            let data = null;
            if (pgPool) {
                const res = await pgPool.query('SELECT data FROM virtual_servers WHERE id = $1', [serverId]);
                if (res.rows[0]) data = res.rows[0].data;
            } else {
                const all = getLocalVirtualServers();
                if (all[serverId]) data = all[serverId];
            }
            let isNew = false;
            if (!data) {
                isNew = true;
                data = {
                    id: serverId,
                    channels: [
                        { id: 'lobby', name: 'Lobby', type: 'text' },
                        { id: 'moderation-text', name: 'moderation', type: 'text', minPower: 50 },
                        { id: 'general-voice', name: 'General', type: 'voice' },
                        { id: 'gaming-voice', name: 'Gaming', type: 'voice' },
                        { id: 'afk-voice', name: '💤 AFK', type: 'voice', isAfkChannel: true }
                    ],
                    groups: {
                        'owner': { name: 'Owner', power: 100 },
                        'admin': { name: 'Admin', power: 75 },
                        'supporter': { name: 'Supporter', power: 50 },
                        'user': { name: 'User', power: 5 },
                        'gast': { name: 'Gast', power: 1 },
                        'banned': { name: 'Banned', power: 0 }
                    },
                    userGroups: {},
                    settings: { welcomeMessage: 'Willkommen auf dem Server!', defaultRole: 'user' },
                    banned: [],
                    pinnedMessages: {}
                };
            } else {
                if (!Array.isArray(data.channels)) data.channels = [];
                if (!data.pinnedMessages) data.pinnedMessages = {};
                // Ensure AFK channel exists
                if (!data.channels.some(c => c.isAfkChannel || c.id === 'afk-voice' || (c.name && c.name.toLowerCase().includes('afk')))) {
                    data.channels.push({ id: 'afk-voice', name: '💤 AFK', type: 'voice', isAfkChannel: true });
                    isNew = true;
                }
                // Ensure Moderation text channel exists
                if (!data.channels.some(c => c.minPower >= 50 || c.id === 'moderation-text' || c.name === 'moderation')) {
                    data.channels.push({ id: 'moderation-text', name: 'moderation', type: 'text', minPower: 50 });
                    isNew = true;
                }
            }
            // Migrate legacy inline messages into the messages store
            if (pgPool && data.messages) {
                for (const room in data.messages) {
                    for (const m of data.messages[room] || []) {
                        await pgPool.query('INSERT INTO messages (server_id, room, sender, msg, is_media, ts) VALUES ($1,$2,$3,$4,$5,$6)',
                            [serverId, room, m.senderName, m.msg, !!m.isMedia, m.timestamp || Date.now()]);
                    }
                }
                delete data.messages;
                isNew = true;
            }
            vsCache[serverId] = data;
            if (isNew) await module.exports.saveVirtualServer(serverId, data);
            return data;
        })();

        try { return await vsLoading[serverId]; }
        finally { delete vsLoading[serverId]; }
    },

    saveVirtualServer: async (serverId, data) => {
        serverId = serverId || 'default';
        vsCache[serverId] = data;
        if (pgPool) {
            const { messages, ...rest } = data; // messages live in their own table
            await pgPool.query(`
                INSERT INTO virtual_servers (id, data) VALUES ($1, $2)
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
            `, [serverId, JSON.stringify(rest)]);
        } else {
            const all = getLocalVirtualServers();
            all[serverId] = data;
            saveLocalVirtualServers(all);
        }
    },

    // --- Chat Messages ---
    addMessage: async (serverId, room, msgObj) => {
        serverId = serverId || 'default';
        if (!msgObj.id) {
            msgObj.id = 'msg_' + (msgObj.timestamp || Date.now()) + '_' + Math.random().toString(36).substr(2, 6);
        }
        if (pgPool) {
            try {
                const res = await pgPool.query(
                    'INSERT INTO messages (server_id, room, sender, msg, is_media, ts, edited, reactions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
                    [serverId, room, msgObj.senderName, msgObj.msg, !!msgObj.isMedia, msgObj.timestamp || Date.now(), !!msgObj.edited, JSON.stringify(msgObj.reactions || {})]
                );
                if (res.rows && res.rows[0]) {
                    msgObj.id = String(res.rows[0].id);
                }
            } catch (e) {
                // Fallback without new columns in case of table schema delay
                const fallbackRes = await pgPool.query(
                    'INSERT INTO messages (server_id, room, sender, msg, is_media, ts) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
                    [serverId, room, msgObj.senderName, msgObj.msg, !!msgObj.isMedia, msgObj.timestamp || Date.now()]
                );
                if (fallbackRes.rows && fallbackRes.rows[0]) {
                    msgObj.id = String(fallbackRes.rows[0].id);
                }
            }
        } else {
            const srv = await module.exports.getVirtualServer(serverId);
            if (!srv.messages) srv.messages = {};
            if (!srv.messages[room]) srv.messages[room] = [];
            srv.messages[room].push(msgObj);
            if (srv.messages[room].length > MAX_HISTORY) srv.messages[room] = srv.messages[room].slice(-MAX_HISTORY);
            await module.exports.saveVirtualServer(serverId, srv);
        }
        return msgObj;
    },

    getMessages: async (serverId, room) => {
        serverId = serverId || 'default';
        if (pgPool) {
            try {
                const res = await pgPool.query(
                    'SELECT id, sender, msg, is_media, ts, edited, reactions FROM (SELECT * FROM messages WHERE server_id = $1 AND room = $2 ORDER BY ts DESC LIMIT $3) t ORDER BY ts ASC',
                    [serverId, room, MAX_HISTORY]);
                return res.rows.map(r => {
                    let reacs = {};
                    if (r.reactions) {
                        try { reacs = typeof r.reactions === 'string' ? JSON.parse(r.reactions) : r.reactions; } catch (e) { reacs = {}; }
                    }
                    return {
                        id: String(r.id),
                        senderName: r.sender,
                        msg: r.msg,
                        isMedia: r.is_media,
                        timestamp: Number(r.ts),
                        edited: !!r.edited,
                        reactions: reacs || {}
                    };
                });
            } catch (e) {
                const res = await pgPool.query(
                    'SELECT id, sender, msg, is_media, ts FROM (SELECT * FROM messages WHERE server_id = $1 AND room = $2 ORDER BY ts DESC LIMIT $3) t ORDER BY ts ASC',
                    [serverId, room, MAX_HISTORY]);
                return res.rows.map(r => ({
                    id: String(r.id),
                    senderName: r.sender,
                    msg: r.msg,
                    isMedia: r.is_media,
                    timestamp: Number(r.ts),
                    edited: false,
                    reactions: {}
                }));
            }
        }
        const srv = await module.exports.getVirtualServer(serverId);
        return (srv.messages && srv.messages[room]) || [];
    },

    editMessage: async (serverId, room, messageId, newText) => {
        serverId = serverId || 'default';
        if (pgPool) {
            const numId = parseInt(messageId, 10);
            if (!isNaN(numId)) {
                await pgPool.query('UPDATE messages SET msg = $1, edited = true WHERE server_id = $2 AND room = $3 AND id = $4', [newText, serverId, room, numId]);
            } else {
                await pgPool.query('UPDATE messages SET msg = $1, edited = true WHERE server_id = $2 AND room = $3 AND ts = $4', [newText, serverId, room, Number(messageId)]);
            }
        } else {
            const srv = await module.exports.getVirtualServer(serverId);
            if (srv.messages && srv.messages[room]) {
                const m = srv.messages[room].find(x => String(x.id) === String(messageId) || String(x.timestamp) === String(messageId));
                if (m) {
                    m.msg = newText;
                    m.edited = true;
                    await module.exports.saveVirtualServer(serverId, srv);
                }
            }
        }
    },

    deleteMessage: async (serverId, room, messageId) => {
        serverId = serverId || 'default';
        if (pgPool) {
            const numId = parseInt(messageId, 10);
            if (!isNaN(numId)) {
                await pgPool.query('DELETE FROM messages WHERE server_id = $1 AND room = $2 AND id = $3', [serverId, room, numId]);
            } else {
                await pgPool.query('DELETE FROM messages WHERE server_id = $1 AND room = $2 AND ts = $3', [serverId, room, Number(messageId)]);
            }
        } else {
            const srv = await module.exports.getVirtualServer(serverId);
            if (srv.messages && srv.messages[room]) {
                srv.messages[room] = srv.messages[room].filter(x => String(x.id) !== String(messageId) && String(x.timestamp) !== String(messageId));
                await module.exports.saveVirtualServer(serverId, srv);
            }
        }
    },

    updateReaction: async (serverId, room, messageId, emoji, username) => {
        serverId = serverId || 'default';
        let updatedReactions = {};
        if (pgPool) {
            try {
                const numId = parseInt(messageId, 10);
                const query = !isNaN(numId) 
                    ? 'SELECT reactions FROM messages WHERE server_id = $1 AND room = $2 AND id = $3'
                    : 'SELECT reactions FROM messages WHERE server_id = $1 AND room = $2 AND ts = $3';
                const param = !isNaN(numId) ? numId : Number(messageId);
                const res = await pgPool.query(query, [serverId, room, param]);
                if (res.rows && res.rows[0]) {
                    let r = res.rows[0].reactions;
                    if (typeof r === 'string') {
                        try { r = JSON.parse(r); } catch (e) { r = {}; }
                    }
                    r = r || {};
                    if (!r[emoji]) r[emoji] = [];
                    const idx = r[emoji].indexOf(username);
                    if (idx > -1) {
                        r[emoji].splice(idx, 1);
                        if (r[emoji].length === 0) delete r[emoji];
                    } else {
                        r[emoji].push(username);
                    }
                    updatedReactions = r;
                    const updateQ = !isNaN(numId)
                        ? 'UPDATE messages SET reactions = $1 WHERE server_id = $2 AND room = $3 AND id = $4'
                        : 'UPDATE messages SET reactions = $1 WHERE server_id = $2 AND room = $3 AND ts = $4';
                    await pgPool.query(updateQ, [JSON.stringify(r), serverId, room, param]);
                }
            } catch (e) {
                console.warn('[DB] Reaction update error:', e.message);
            }
        } else {
            const srv = await module.exports.getVirtualServer(serverId);
            if (srv.messages && srv.messages[room]) {
                const m = srv.messages[room].find(x => String(x.id) === String(messageId) || String(x.timestamp) === String(messageId));
                if (m) {
                    if (!m.reactions) m.reactions = {};
                    if (!m.reactions[emoji]) m.reactions[emoji] = [];
                    const idx = m.reactions[emoji].indexOf(username);
                    if (idx > -1) {
                        m.reactions[emoji].splice(idx, 1);
                        if (m.reactions[emoji].length === 0) delete m.reactions[emoji];
                    } else {
                        m.reactions[emoji].push(username);
                    }
                    updatedReactions = m.reactions;
                    await module.exports.saveVirtualServer(serverId, srv);
                }
            }
        }
        return updatedReactions;
    },

    renameChannelMessages: async (serverId, oldName, newName) => {
        serverId = serverId || 'default';
        if (!oldName || !newName || oldName === newName) return;
        if (pgPool) {
            await pgPool.query('UPDATE messages SET room = $3 WHERE server_id = $1 AND room = $2', [serverId, oldName, newName]);
        } else {
            const srv = await module.exports.getVirtualServer(serverId);
            if (srv.messages && srv.messages[oldName]) {
                const oldMsgs = srv.messages[oldName] || [];
                const existingNew = srv.messages[newName] || [];
                srv.messages[newName] = existingNew.concat(oldMsgs);
                delete srv.messages[oldName];
                await module.exports.saveVirtualServer(serverId, srv);
            }
        }
    },

    pinMessage: async (serverId, room, messageId, isPinned) => {
        serverId = serverId || 'default';
        const srv = await module.exports.getVirtualServer(serverId);
        if (!srv.pinnedMessages) srv.pinnedMessages = {};
        if (!srv.pinnedMessages[room]) srv.pinnedMessages[room] = [];

        if (isPinned) {
            let msg = null;
            if (srv.messages && srv.messages[room]) {
                msg = srv.messages[room].find(m => String(m.id) === String(messageId) || String(m.timestamp) === String(messageId));
            }
            if (!msg) {
                const msgs = await module.exports.getMessages(serverId, room);
                msg = msgs.find(m => String(m.id) === String(messageId) || String(m.timestamp) === String(messageId));
            }
            if (msg) {
                msg.isPinned = true;
                const existingIdx = srv.pinnedMessages[room].findIndex(m => String(m.id) === String(messageId) || String(m.timestamp) === String(messageId));
                if (existingIdx > -1) {
                    srv.pinnedMessages[room][existingIdx] = { ...msg, isPinned: true };
                } else {
                    srv.pinnedMessages[room].unshift({ ...msg, isPinned: true });
                }
            }
        } else {
            srv.pinnedMessages[room] = srv.pinnedMessages[room].filter(m => String(m.id) !== String(messageId) && String(m.timestamp) !== String(messageId));
            if (srv.messages && srv.messages[room]) {
                const m = srv.messages[room].find(x => String(x.id) === String(messageId) || String(x.timestamp) === String(messageId));
                if (m) m.isPinned = false;
            }
        }
        await module.exports.saveVirtualServer(serverId, srv);
        return srv.pinnedMessages[room];
    },

    getPinnedMessages: async (serverId, room) => {
        serverId = serverId || 'default';
        const srv = await module.exports.getVirtualServer(serverId);
        return (srv.pinnedMessages && srv.pinnedMessages[room]) || [];
    },

    votePoll: async (serverId, room, messageId, optionIndex, username) => {
        serverId = serverId || 'default';
        if (!username || optionIndex === undefined || optionIndex === null) return null;
        const srv = await module.exports.getVirtualServer(serverId);
        let msg = null;
        if (srv.messages && srv.messages[room]) {
            msg = srv.messages[room].find(m => String(m.id) === String(messageId) || String(m.timestamp) === String(messageId));
        }
        if (!msg) {
            const msgs = await module.exports.getMessages(serverId, room);
            msg = msgs.find(m => String(m.id) === String(messageId) || String(m.timestamp) === String(messageId));
        }
        if (msg && msg.poll && Array.isArray(msg.poll.options) && msg.poll.options[optionIndex]) {
            let wasSelected = false;
            msg.poll.options.forEach((opt, idx) => {
                if (!Array.isArray(opt.votes)) opt.votes = [];
                const uIdx = opt.votes.indexOf(username);
                if (uIdx > -1) {
                    opt.votes.splice(uIdx, 1);
                    if (idx === optionIndex) wasSelected = true;
                }
            });
            if (!wasSelected) {
                msg.poll.options[optionIndex].votes.push(username);
            }
            if (srv.pinnedMessages && srv.pinnedMessages[room]) {
                const pIdx = srv.pinnedMessages[room].findIndex(m => String(m.id) === String(messageId) || String(m.timestamp) === String(messageId));
                if (pIdx > -1) {
                    srv.pinnedMessages[room][pIdx] = { ...msg };
                }
            }
            await module.exports.saveVirtualServer(serverId, srv);
            return msg.poll;
        }
        return null;
    },

    cleanupMedia: async () => {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (pgPool) {
            await pgPool.query('UPDATE messages SET msg = NULL WHERE is_media = true AND msg IS NOT NULL AND ts < $1', [cutoff]);
        }
    },

    usingPostgres: () => !!pgPool
};
