const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Optional PostgreSQL support
let pgPool = null;
if (process.env.DATABASE_URL) {
    try {
        const { Pool } = require('pg');
        let connStr = process.env.DATABASE_URL;
        // Fix for pg security warning regarding SSL modes:
        // Explicitly use sslmode=verify-full or disable if localhost
        if (connStr.includes('sslmode=') && !connStr.includes('uselibpqcompat')) {
            connStr = connStr.replace(/sslmode=(require|prefer|verify-ca)/g, 'sslmode=verify-full');
        }
        pgPool = new Pool({
            connectionString: connStr,
            ssl: connStr.includes('localhost') ? false : { rejectUnauthorized: false }
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
const dmsFile = path.join(dataDir, 'direct_messages.json');

if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, JSON.stringify([], null, 2));
}
if (!fs.existsSync(serversFile)) {
    fs.writeFileSync(serversFile, JSON.stringify({}, null, 2));
}
if (!fs.existsSync(dmsFile)) {
    fs.writeFileSync(dmsFile, JSON.stringify([], null, 2));
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
                requests_in JSONB DEFAULT '[]'::jsonb,
                requests_out JSONB DEFAULT '[]'::jsonb,
                bio TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                ring_color TEXT DEFAULT '#00ff00',
                settings JSONB DEFAULT '{}'::jsonb,
                servers JSONB DEFAULT '[]'::jsonb
            );
            ALTER TABLE users ADD COLUMN IF NOT EXISTS requests_in JSONB DEFAULT '[]'::jsonb;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS requests_out JSONB DEFAULT '[]'::jsonb;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS ring_color TEXT DEFAULT '#00ff00';

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

            CREATE TABLE IF NOT EXISTS direct_messages (
                id SERIAL PRIMARY KEY,
                sender TEXT NOT NULL,
                receiver TEXT NOT NULL,
                msg TEXT,
                is_media BOOLEAN DEFAULT false,
                ts BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages (sender, receiver, ts);
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

function getLocalDMs() {
    try {
        return JSON.parse(fs.readFileSync(dmsFile, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveLocalDMs(data) {
    const tmp = dmsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, dmsFile);
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

    changePassword: async (userId, oldPassword, newPassword) => {
        if (!oldPassword || !newPassword) throw new Error('Altes und neues Passwort erforderlich.');
        if (newPassword.length < 4) throw new Error('Neues Passwort muss mindestens 4 Zeichen lang sein.');
        
        let user = null;
        if (pgPool) {
            const res = await pgPool.query('SELECT * FROM users WHERE id = $1', [userId]);
            user = res.rows[0];
        } else {
            const users = getLocalUsers();
            user = users.find(u => u.id === userId);
        }

        if (!user) throw new Error('Benutzer nicht gefunden.');
        const isValid = bcrypt.compareSync(oldPassword, user.password);
        if (!isValid) throw new Error('Altes Passwort ist inkorrekt.');

        const hashedPassword = bcrypt.hashSync(newPassword, 8);
        if (pgPool) {
            await pgPool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
        } else {
            const users = getLocalUsers();
            const u = users.find(u => u.id === userId);
            if (u) {
                u.password = hashedPassword;
                saveLocalUsers(users);
            }
        }
        return { success: true, message: 'Passwort erfolgreich geändert.' };
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
        return await module.exports.sendFriendRequest(userId, friendUsername);
    },

    sendFriendRequest: async (userId, targetUsername) => {
        if (typeof targetUsername === 'object' && targetUsername !== null) {
            targetUsername = targetUsername.username || targetUsername.id;
        }
        if (!targetUsername) throw new Error('Benutzername erforderlich.');
        targetUsername = String(targetUsername).trim();

        if (pgPool) {
            const uRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [userId]);
            const tRes = await pgPool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [targetUsername]);
            const user = uRes.rows[0];
            const target = tRes.rows[0];

            if (!user) throw new Error('Nutzer nicht gefunden.');
            if (!target) throw new Error('Nutzer "' + targetUsername + '" existiert nicht.');
            if (user.id === target.id) throw new Error('Du kannst dir nicht selbst eine Anfrage senden.');

            const uFriends = Array.isArray(user.friends) ? user.friends : [];
            if (uFriends.includes(target.id)) throw new Error('Ihr seid bereits befreundet.');

            const uOut = Array.isArray(user.requests_out) ? user.requests_out : [];
            const tIn = Array.isArray(target.requests_in) ? target.requests_in : [];

            if (uOut.some(r => r.id === target.id)) throw new Error('Anfrage bereits gesendet.');

            const uIn = Array.isArray(user.requests_in) ? user.requests_in : [];
            if (uIn.some(r => r.id === target.id)) {
                return await module.exports.acceptFriendRequest(userId, target.id);
            }

            uOut.push({ id: target.id, username: target.username, ts: Date.now() });
            tIn.push({ id: user.id, username: user.username, ts: Date.now() });

            await pgPool.query('UPDATE users SET requests_out = $1 WHERE id = $2', [JSON.stringify(uOut), user.id]);
            await pgPool.query('UPDATE users SET requests_in = $1 WHERE id = $2', [JSON.stringify(tIn), target.id]);
            return { success: true, targetId: target.id, targetUsername: target.username };
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            const target = users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());

            if (!user) throw new Error('Nutzer nicht gefunden.');
            if (!target) throw new Error('Nutzer "' + targetUsername + '" existiert nicht.');
            if (user.id === target.id) throw new Error('Du kannst dir nicht selbst eine Anfrage senden.');

            if (!user.friends) user.friends = [];
            if (user.friends.includes(target.id)) throw new Error('Ihr seid bereits befreundet.');

            if (!user.requestsOut) user.requestsOut = [];
            if (!target.requestsIn) target.requestsIn = [];

            if (user.requestsOut.some(r => r.id === target.id)) throw new Error('Anfrage bereits gesendet.');

            user.requestsOut.push({ id: target.id, username: target.username, ts: Date.now() });
            target.requestsIn.push({ id: user.id, username: user.username, ts: Date.now() });

            saveLocalUsers(users);
            return { success: true, targetId: target.id, targetUsername: target.username };
        }
    },

    getFriendRequests: async (userId) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT requests_in, requests_out FROM users WHERE id = $1', [userId]);
            const row = res.rows[0];
            return {
                incoming: (row && Array.isArray(row.requests_in)) ? row.requests_in : [],
                outgoing: (row && Array.isArray(row.requests_out)) ? row.requests_out : []
            };
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            return {
                incoming: (user && user.requestsIn) || [],
                outgoing: (user && user.requestsOut) || []
            };
        }
    },

    acceptFriendRequest: async (userId, targetIdentifier) => {
        if (typeof targetIdentifier === 'object' && targetIdentifier !== null) {
            targetIdentifier = targetIdentifier.username || targetIdentifier.id;
        }
        if (!targetIdentifier) throw new Error('Ziel-Nutzer erforderlich.');
        targetIdentifier = String(targetIdentifier).trim();
        if (pgPool) {
            const uRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [userId]);
            const user = uRes.rows[0];
            if (!user) throw new Error('Nutzer nicht gefunden.');

            let tRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [targetIdentifier]);
            if (!tRes.rows[0]) {
                tRes = await pgPool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [targetIdentifier]);
            }
            const target = tRes.rows[0];
            if (!target) throw new Error('Ziel-Nutzer nicht gefunden.');
            const targetId = target.id;

            const uIn = (user.requests_in || []).filter(r => (typeof r === 'object' ? r.id !== targetId : r !== targetId && r !== target.username));
            const tOut = (target.requests_out || []).filter(r => (typeof r === 'object' ? r.id !== userId : r !== userId && r !== user.username));

            const uFriends = Array.isArray(user.friends) ? user.friends : [];
            const tFriends = Array.isArray(target.friends) ? target.friends : [];
            if (!uFriends.includes(targetId) && targetId !== userId) uFriends.push(targetId);
            if (!tFriends.includes(userId) && userId !== targetId) tFriends.push(userId);

            await pgPool.query('UPDATE users SET requests_in = $1, friends = $2 WHERE id = $3', [JSON.stringify(uIn), JSON.stringify(uFriends), userId]);
            await pgPool.query('UPDATE users SET requests_out = $1, friends = $2 WHERE id = $3', [JSON.stringify(tOut), JSON.stringify(tFriends), targetId]);
            return { success: true, friend: { id: target.id, username: target.username } };
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            if (!user) throw new Error('Nutzer nicht gefunden.');
            const target = users.find(u => u.id === targetIdentifier || u.username.toLowerCase() === targetIdentifier.toLowerCase());
            if (!target) throw new Error('Ziel-Nutzer nicht gefunden.');
            const targetId = target.id;

            user.requestsIn = (user.requestsIn || []).filter(r => (typeof r === 'object' ? r.id !== targetId : r !== targetId && r !== target.username));
            target.requestsOut = (target.requestsOut || []).filter(r => (typeof r === 'object' ? r.id !== userId : r !== userId && r !== user.username));

            if (!user.friends) user.friends = [];
            if (!target.friends) target.friends = [];
            if (!user.friends.includes(targetId) && targetId !== userId) user.friends.push(targetId);
            if (!target.friends.includes(userId) && userId !== targetId) target.friends.push(userId);

            saveLocalUsers(users);
            return { success: true, friend: { id: target.id, username: target.username } };
        }
    },

    declineFriendRequest: async (userId, targetIdentifier) => {
        if (typeof targetIdentifier === 'object' && targetIdentifier !== null) {
            targetIdentifier = targetIdentifier.username || targetIdentifier.id;
        }
        if (!targetIdentifier) throw new Error('Ziel-Nutzer erforderlich.');
        targetIdentifier = String(targetIdentifier).trim();
        if (pgPool) {
            const uRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [userId]);
            let tRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [targetIdentifier]);
            if (!tRes.rows[0]) {
                tRes = await pgPool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [targetIdentifier]);
            }
            const target = tRes.rows[0];
            const targetId = target ? target.id : targetIdentifier;

            if (uRes.rows[0]) {
                const uIn = (uRes.rows[0].requests_in || []).filter(r => (typeof r === 'object' ? r.id !== targetId : r !== targetId && (!target || r !== target.username)));
                await pgPool.query('UPDATE users SET requests_in = $1 WHERE id = $2', [JSON.stringify(uIn), userId]);
            }
            if (target) {
                const tOut = (target.requests_out || []).filter(r => (typeof r === 'object' ? r.id !== userId : r !== userId));
                await pgPool.query('UPDATE users SET requests_out = $1 WHERE id = $2', [JSON.stringify(tOut), targetId]);
            }
            return { success: true };
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            const target = users.find(u => u.id === targetIdentifier || u.username.toLowerCase() === targetIdentifier.toLowerCase());
            const targetId = target ? target.id : targetIdentifier;

            if (user) user.requestsIn = (user.requestsIn || []).filter(r => (typeof r === 'object' ? r.id !== targetId : r !== targetId && (!target || r !== target.username)));
            if (target) target.requestsOut = (target.requestsOut || []).filter(r => (typeof r === 'object' ? r.id !== userId : r !== userId));
            saveLocalUsers(users);
            return { success: true };
        }
    },

    cancelFriendRequest: async (userId, targetIdentifier) => {
        if (typeof targetIdentifier === 'object' && targetIdentifier !== null) {
            targetIdentifier = targetIdentifier.username || targetIdentifier.id;
        }
        if (!targetIdentifier) throw new Error('Ziel-Nutzer erforderlich.');
        targetIdentifier = String(targetIdentifier).trim();
        if (pgPool) {
            const uRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [userId]);
            let tRes = await pgPool.query('SELECT * FROM users WHERE id = $1', [targetIdentifier]);
            if (!tRes.rows[0]) {
                tRes = await pgPool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [targetIdentifier]);
            }
            const target = tRes.rows[0];
            const targetId = target ? target.id : targetIdentifier;

            if (uRes.rows[0]) {
                const uOut = (uRes.rows[0].requests_out || []).filter(r => (typeof r === 'object' ? r.id !== targetId : r !== targetId && (!target || r !== target.username)));
                await pgPool.query('UPDATE users SET requests_out = $1 WHERE id = $2', [JSON.stringify(uOut), userId]);
            }
            if (target) {
                const tIn = (target.requests_in || []).filter(r => (typeof r === 'object' ? r.id !== userId : r !== userId));
                await pgPool.query('UPDATE users SET requests_in = $1 WHERE id = $2', [JSON.stringify(tIn), targetId]);
            }
            return { success: true };
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            const target = users.find(u => u.id === targetIdentifier || u.username.toLowerCase() === targetIdentifier.toLowerCase());
            const targetId = target ? target.id : targetIdentifier;

            if (user) user.requestsOut = (user.requestsOut || []).filter(r => (typeof r === 'object' ? r.id !== targetId : r !== targetId && (!target || r !== target.username)));
            if (target) target.requestsIn = (target.requestsIn || []).filter(r => (typeof r === 'object' ? r.id !== userId : r !== userId));
            saveLocalUsers(users);
            return { success: true };
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
            let friendIds = res.rows[0]?.friends || [];
            if (typeof friendIds === 'string') {
                try { friendIds = JSON.parse(friendIds); } catch(e) { friendIds = []; }
            }
            friendIds = (Array.isArray(friendIds) ? friendIds : []).filter(id => id && id !== userId);
            if (!friendIds.length) return [];
            const friendsRes = await pgPool.query('SELECT id, username, bio, avatar, ring_color FROM users WHERE id = ANY($1)', [friendIds]);
            return friendsRes.rows
                .filter(r => r.id !== userId)
                .map(r => ({
                    id: r.id,
                    username: r.username,
                    bio: r.bio || '',
                    avatar: r.avatar || '',
                    ringColor: r.ring_color || '#00ff00'
                }));
        } else {
            const users = getLocalUsers();
            const user = users.find(u => u.id === userId);
            if (!user || !user.friends) return [];
            let fList = Array.isArray(user.friends) ? user.friends : [];
            fList = fList.filter(id => id && id !== userId);
            return users
                .filter(u => fList.includes(u.id) && u.id !== userId)
                .map(u => ({
                    id: u.id,
                    username: u.username,
                    bio: u.bio || '',
                    avatar: u.avatar || '',
                    ringColor: u.ringColor || '#00ff00'
                }));
        }
    },

    getProfile: async (userId) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT id, username, bio, avatar, ring_color FROM users WHERE id = $1', [userId]);
            const row = res.rows[0];
            if (!row) throw new Error('Nutzer nicht gefunden');
            return { id: row.id, username: row.username, bio: row.bio || '', avatar: row.avatar || '', ringColor: row.ring_color || '#00ff00' };
        }
        const user = getLocalUsers().find(u => u.id === userId);
        if (!user) throw new Error('Nutzer nicht gefunden');
        return { id: user.id, username: user.username, bio: user.bio || '', avatar: user.avatar || '', ringColor: user.ringColor || '#00ff00' };
    },

    saveProfile: async (userId, data) => {
        const bio = typeof data.bio === 'string' ? data.bio.slice(0, 255) : '';
        const avatar = typeof data.avatar === 'string' ? data.avatar : '';
        const ringColor = typeof data.ringColor === 'string' ? data.ringColor : '#00ff00';

        if (pgPool) {
            await pgPool.query('UPDATE users SET bio = $1, avatar = $2, ring_color = $3 WHERE id = $4', [bio, avatar, ringColor, userId]);
            return { bio, avatar, ringColor };
        }
        const users = getLocalUsers();
        const user = users.find(u => u.id === userId);
        if (user) {
            user.bio = bio;
            user.avatar = avatar;
            user.ringColor = ringColor;
            saveLocalUsers(users);
        }
        return { bio, avatar, ringColor };
    },

    addDirectMessage: async (sender, receiver, msg, isMedia = false) => {
        const ts = Date.now();
        if (pgPool) {
            await pgPool.query('INSERT INTO direct_messages (sender, receiver, msg, is_media, ts) VALUES ($1, $2, $3, $4, $5)',
                [sender, receiver, msg, !!isMedia, ts]);
        } else {
            const dms = getLocalDMs();
            dms.push({ sender, receiver, msg, isMedia: !!isMedia, ts });
            if (dms.length > 2000) dms.splice(0, dms.length - 2000);
            saveLocalDMs(dms);
        }
        return { sender, receiver, msg, isMedia, ts };
    },

    getDirectMessages: async (userA, userB) => {
        if (pgPool) {
            const res = await pgPool.query(
                'SELECT sender, receiver, msg, is_media, ts FROM direct_messages WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1) ORDER BY ts ASC LIMIT 300',
                [userA, userB]
            );
            return res.rows.map(r => ({ sender: r.sender, receiver: r.receiver, text: r.msg, isMedia: r.is_media, time: Number(r.ts) }));
        }
        const dms = getLocalDMs();
        return dms.filter(m => (m.sender === userA && m.receiver === userB) || (m.sender === userB && m.receiver === userA))
            .slice(-300)
            .map(m => ({ sender: m.sender, receiver: m.receiver, text: m.msg, isMedia: m.isMedia, time: m.ts }));
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

    cleanupMedia: async () => {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (pgPool) {
            await pgPool.query('UPDATE messages SET msg = NULL WHERE is_media = true AND msg IS NOT NULL AND ts < $1', [cutoff]);
        }
    },

    usingPostgres: () => !!pgPool
};
