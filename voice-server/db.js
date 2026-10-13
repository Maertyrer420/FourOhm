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
                        { id: 'general-voice', name: 'General', type: 'voice' },
                        { id: 'gaming-voice', name: 'Gaming', type: 'voice' }
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
                    banned: []
                };
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
        if (pgPool) {
            await pgPool.query('INSERT INTO messages (server_id, room, sender, msg, is_media, ts) VALUES ($1,$2,$3,$4,$5,$6)',
                [serverId, room, msgObj.senderName, msgObj.msg, !!msgObj.isMedia, msgObj.timestamp]);
        } else {
            const srv = await module.exports.getVirtualServer(serverId);
            if (!srv.messages) srv.messages = {};
            if (!srv.messages[room]) srv.messages[room] = [];
            srv.messages[room].push(msgObj);
            if (srv.messages[room].length > MAX_HISTORY) srv.messages[room] = srv.messages[room].slice(-MAX_HISTORY);
            await module.exports.saveVirtualServer(serverId, srv);
        }
    },

    getMessages: async (serverId, room) => {
        serverId = serverId || 'default';
        if (pgPool) {
            const res = await pgPool.query(
                'SELECT sender, msg, is_media, ts FROM (SELECT * FROM messages WHERE server_id = $1 AND room = $2 ORDER BY ts DESC LIMIT $3) t ORDER BY ts ASC',
                [serverId, room, MAX_HISTORY]);
            return res.rows.map(r => ({ senderName: r.sender, msg: r.msg, isMedia: r.is_media, timestamp: Number(r.ts) }));
        }
        const srv = await module.exports.getVirtualServer(serverId);
        return (srv.messages && srv.messages[room]) || [];
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

    cleanupMedia: async () => {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (pgPool) {
            await pgPool.query('UPDATE messages SET msg = NULL WHERE is_media = true AND msg IS NOT NULL AND ts < $1', [cutoff]);
        }
    },

    usingPostgres: () => !!pgPool
};
