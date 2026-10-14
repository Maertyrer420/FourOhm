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
            ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT DEFAULT '';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS audio_input_device TEXT DEFAULT 'default';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS audio_output_device TEXT DEFAULT 'default';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id TEXT DEFAULT '';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_username TEXT DEFAULT '';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_avatar TEXT DEFAULT '';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS cs2_inventory_mode TEXT DEFAULT 'filtered';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS cs2_showcase_items JSONB DEFAULT '[]'::jsonb;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS cs2_inventory_cache JSONB DEFAULT NULL;

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
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll JSONB DEFAULT NULL;
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS game JSONB DEFAULT NULL;
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT false;

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
            const friendsRes = await pgPool.query('SELECT id, username, bio, avatar, ring_color, banner FROM users WHERE id = ANY($1)', [friendIds]);
            return friendsRes.rows
                .filter(r => r.id !== userId)
                .map(r => ({
                    id: r.id,
                    username: r.username,
                    bio: r.bio || '',
                    avatar: r.avatar || '',
                    ringColor: r.ring_color || '#00ff00',
                    banner: r.banner || ''
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
                    ringColor: u.ringColor || '#00ff00',
                    banner: u.banner || ''
                }));
        }
    },

    getProfile: async (userId) => {
        if (pgPool) {
            const res = await pgPool.query('SELECT id, username, bio, avatar, ring_color, banner, audio_input_device, audio_output_device, steam_id, steam_username, steam_avatar, cs2_inventory_mode, cs2_showcase_items FROM users WHERE id = $1', [userId]);
            const row = res.rows[0];
            if (!row) throw new Error('Nutzer nicht gefunden');
            return { 
                id: row.id, 
                username: row.username, 
                bio: row.bio || '', 
                avatar: row.avatar || '', 
                ringColor: row.ring_color || '#00ff00',
                banner: row.banner || '',
                audioInputDevice: row.audio_input_device || 'default',
                audioOutputDevice: row.audio_output_device || 'default',
                steamId: row.steam_id || '',
                steamUsername: row.steam_username || '',
                steamAvatar: row.steam_avatar || '',
                cs2InventoryMode: row.cs2_inventory_mode || 'filtered',
                cs2ShowcaseItems: Array.isArray(row.cs2_showcase_items) ? row.cs2_showcase_items : []
            };
        }
        const user = getLocalUsers().find(u => u.id === userId);
        if (!user) throw new Error('Nutzer nicht gefunden');
        return { 
            id: user.id, 
            username: user.username, 
            bio: user.bio || '', 
            avatar: user.avatar || '', 
            ringColor: user.ringColor || '#00ff00',
            banner: user.banner || '',
            audioInputDevice: user.audioInputDevice || 'default',
            audioOutputDevice: user.audioOutputDevice || 'default',
            steamId: user.steamId || user.steam_id || '',
            steamUsername: user.steamUsername || user.steam_username || '',
            steamAvatar: user.steamAvatar || user.steam_avatar || '',
            cs2InventoryMode: user.cs2InventoryMode || user.cs2_inventory_mode || 'filtered',
            cs2ShowcaseItems: Array.isArray(user.cs2ShowcaseItems || user.cs2_showcase_items) ? (user.cs2ShowcaseItems || user.cs2_showcase_items) : []
        };
    },

    saveProfile: async (userId, data) => {
        let existing = {};
        if (pgPool) {
            try {
                const current = await pgPool.query('SELECT bio, avatar, ring_color, banner, audio_input_device, audio_output_device, steam_id, steam_username, steam_avatar, cs2_inventory_mode, cs2_showcase_items FROM users WHERE id = $1', [userId]);
                if (current.rows && current.rows.length > 0) existing = current.rows[0];
            } catch (e) {}
        } else {
            const users = getLocalUsers();
            const u = users.find(x => x.id === userId);
            if (u) existing = { 
                bio: u.bio, 
                avatar: u.avatar, 
                ring_color: u.ringColor || u.ring_color, 
                banner: u.banner, 
                audio_input_device: u.audioInputDevice, 
                audio_output_device: u.audioOutputDevice,
                steam_id: u.steamId || u.steam_id,
                steam_username: u.steamUsername || u.steam_username,
                steam_avatar: u.steamAvatar || u.steam_avatar,
                cs2_inventory_mode: u.cs2InventoryMode || u.cs2_inventory_mode,
                cs2_showcase_items: u.cs2ShowcaseItems || u.cs2_showcase_items
            };
        }

        const bio = typeof data.bio === 'string' ? data.bio.slice(0, 255) : (existing.bio || '');
        const avatar = typeof data.avatar === 'string' ? data.avatar : (existing.avatar || '');
        const ringColor = typeof data.ringColor === 'string' ? data.ringColor : (typeof data.ring_color === 'string' ? data.ring_color : (existing.ring_color || existing.ringColor || '#00ff00'));
        const banner = typeof data.banner === 'string' ? data.banner : (existing.banner || '');
        const audioInputDevice = typeof data.audioInputDevice === 'string' ? data.audioInputDevice : (typeof data.audio_input_device === 'string' ? data.audio_input_device : (existing.audio_input_device || existing.audioInputDevice || 'default'));
        const audioOutputDevice = typeof data.audioOutputDevice === 'string' ? data.audioOutputDevice : (typeof data.audio_output_device === 'string' ? data.audio_output_device : (existing.audio_output_device || existing.audioOutputDevice || 'default'));
        const steamId = data.steamId !== undefined ? String(data.steamId) : (data.steam_id !== undefined ? String(data.steam_id) : (existing.steam_id || ''));
        const steamUsername = data.steamUsername !== undefined ? String(data.steamUsername) : (data.steam_username !== undefined ? String(data.steam_username) : (existing.steam_username || ''));
        const steamAvatar = data.steamAvatar !== undefined ? String(data.steamAvatar) : (data.steam_avatar !== undefined ? String(data.steam_avatar) : (existing.steam_avatar || ''));
        const cs2InventoryMode = data.cs2InventoryMode !== undefined ? String(data.cs2InventoryMode) : (data.cs2_inventory_mode !== undefined ? String(data.cs2_inventory_mode) : (existing.cs2_inventory_mode || 'filtered'));
        const cs2ShowcaseItems = Array.isArray(data.cs2ShowcaseItems || data.cs2_showcase_items) ? (data.cs2ShowcaseItems || data.cs2_showcase_items) : (Array.isArray(existing.cs2_showcase_items) ? existing.cs2_showcase_items : []);

        if (pgPool) {
            await pgPool.query('UPDATE users SET bio = $1, avatar = $2, ring_color = $3, banner = $4, audio_input_device = $5, audio_output_device = $6, steam_id = $7, steam_username = $8, steam_avatar = $9, cs2_inventory_mode = $10, cs2_showcase_items = $11 WHERE id = $12', [
                bio, avatar, ringColor, banner, audioInputDevice, audioOutputDevice, steamId, steamUsername, steamAvatar, cs2InventoryMode, JSON.stringify(cs2ShowcaseItems), userId
            ]);
            return { success: true, bio, avatar, ringColor, ring_color: ringColor, banner, audioInputDevice, audio_input_device: audioInputDevice, audioOutputDevice, audio_output_device: audioOutputDevice, steamId, steam_id: steamId, steamUsername, steam_username: steamUsername, steamAvatar, steam_avatar: steamAvatar, cs2InventoryMode, cs2_inventory_mode: cs2InventoryMode, cs2ShowcaseItems, cs2_showcase_items: cs2ShowcaseItems };
        }
        const users = getLocalUsers();
        const user = users.find(u => u.id === userId);
        if (user) {
            user.bio = bio;
            user.avatar = avatar;
            user.ringColor = ringColor;
            user.banner = banner;
            user.audioInputDevice = audioInputDevice;
            user.audioOutputDevice = audioOutputDevice;
            user.steamId = steamId;
            user.steam_id = steamId;
            user.steamUsername = steamUsername;
            user.steam_username = steamUsername;
            user.steamAvatar = steamAvatar;
            user.steam_avatar = steamAvatar;
            user.cs2InventoryMode = cs2InventoryMode;
            user.cs2_inventory_mode = cs2InventoryMode;
            user.cs2ShowcaseItems = cs2ShowcaseItems;
            user.cs2_showcase_items = cs2ShowcaseItems;
            saveLocalUsers(users);
        }
        return { success: true, bio, avatar, ringColor, ring_color: ringColor, banner, audioInputDevice, audio_input_device: audioInputDevice, audioOutputDevice, audio_output_device: audioOutputDevice, steamId, steam_id: steamId, steamUsername, steam_username: steamUsername, steamAvatar, steam_avatar: steamAvatar, cs2InventoryMode, cs2_inventory_mode: cs2InventoryMode, cs2ShowcaseItems, cs2_showcase_items: cs2ShowcaseItems };
    },

    linkSteamAccount: async (userId, { steamId, steamUsername = '', steamAvatar = '' }) => {
        if (!userId || !steamId) throw new Error('UserId und SteamId erforderlich');
        if (pgPool) {
            await pgPool.query('UPDATE users SET steam_id = $1, steam_username = $2, steam_avatar = $3 WHERE id = $4', [
                String(steamId), String(steamUsername), String(steamAvatar), userId
            ]);
            return { success: true, steamId, steamUsername, steamAvatar };
        }
        const users = getLocalUsers();
        const user = users.find(u => u.id === userId);
        if (user) {
            user.steamId = String(steamId);
            user.steam_id = String(steamId);
            user.steamUsername = String(steamUsername);
            user.steam_username = String(steamUsername);
            user.steamAvatar = String(steamAvatar);
            user.steam_avatar = String(steamAvatar);
            saveLocalUsers(users);
        }
        return { success: true, steamId, steamUsername, steamAvatar };
    },

    unlinkSteamAccount: async (userId) => {
        if (!userId) throw new Error('UserId erforderlich');
        if (pgPool) {
            await pgPool.query('UPDATE users SET steam_id = $1, steam_username = $2, steam_avatar = $3, cs2_inventory_cache = NULL WHERE id = $4', [
                '', '', '', userId
            ]);
            return { success: true };
        }
        const users = getLocalUsers();
        const user = users.find(u => u.id === userId);
        if (user) {
            user.steamId = '';
            user.steam_id = '';
            user.steamUsername = '';
            user.steam_username = '';
            user.steamAvatar = '';
            user.steam_avatar = '';
            delete user.cs2InventoryCache;
            delete user.cs2_inventory_cache;
            saveLocalUsers(users);
        }
        return { success: true };
    },

    getCs2InventoryCache: async (userIdOrUsername) => {
        if (!userIdOrUsername) return null;
        if (pgPool) {
            const res = await pgPool.query('SELECT cs2_inventory_cache FROM users WHERE id = $1 OR LOWER(username) = LOWER($1)', [userIdOrUsername]);
            return res.rows[0]?.cs2_inventory_cache || null;
        }
        const users = getLocalUsers();
        const u = users.find(x => x.id === userIdOrUsername || (x.username && x.username.toLowerCase() === userIdOrUsername.toLowerCase()));
        return u?.cs2InventoryCache || u?.cs2_inventory_cache || null;
    },

    saveCs2InventoryCache: async (userIdOrUsername, cacheData) => {
        if (!userIdOrUsername) return;
        if (pgPool) {
            await pgPool.query('UPDATE users SET cs2_inventory_cache = $1 WHERE id = $2 OR LOWER(username) = LOWER($2)', [
                JSON.stringify(cacheData), userIdOrUsername
            ]);
            return;
        }
        const users = getLocalUsers();
        const u = users.find(x => x.id === userIdOrUsername || (x.username && x.username.toLowerCase() === userIdOrUsername.toLowerCase()));
        if (u) {
            u.cs2InventoryCache = cacheData;
            u.cs2_inventory_cache = cacheData;
            saveLocalUsers(users);
        }
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
            return res.rows.map(r => ({
                sender: r.sender,
                receiver: r.receiver,
                text: r.msg,
                message: r.msg,
                isMedia: !!r.is_media,
                time: Number(r.ts),
                created_at: new Date(Number(r.ts)).toISOString()
            }));
        }
        const dms = getLocalDMs();
        return dms.filter(m => (m.sender === userA && m.receiver === userB) || (m.sender === userB && m.receiver === userA))
            .slice(-300)
            .map(m => ({
                sender: m.sender,
                receiver: m.receiver,
                text: m.msg,
                message: m.msg,
                isMedia: !!m.isMedia,
                time: Number(m.ts),
                created_at: new Date(Number(m.ts)).toISOString()
            }));
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
                if (!data.channels.some(c => (c.minPower && c.minPower >= 50) || c.id === 'moderation-text' || c.name === 'moderation')) {
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
                    'INSERT INTO messages (server_id, room, sender, msg, is_media, ts, edited, reactions, poll, game, is_pinned) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
                    [
                        serverId,
                        room,
                        msgObj.senderName,
                        msgObj.msg,
                        !!msgObj.isMedia,
                        msgObj.timestamp || Date.now(),
                        !!msgObj.edited,
                        JSON.stringify(msgObj.reactions || {}),
                        msgObj.poll ? JSON.stringify(msgObj.poll) : null,
                        msgObj.game ? JSON.stringify(msgObj.game) : null,
                        !!msgObj.isPinned
                    ]
                );
                if (res.rows && res.rows[0]) {
                    msgObj.id = String(res.rows[0].id);
                }
            } catch (e) {
                try {
                    const res = await pgPool.query(
                        'INSERT INTO messages (server_id, room, sender, msg, is_media, ts, edited, reactions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
                        [serverId, room, msgObj.senderName, msgObj.msg, !!msgObj.isMedia, msgObj.timestamp || Date.now(), !!msgObj.edited, JSON.stringify(msgObj.reactions || {})]
                    );
                    if (res.rows && res.rows[0]) msgObj.id = String(res.rows[0].id);
                } catch (e2) {
                    const fallbackRes = await pgPool.query(
                        'INSERT INTO messages (server_id, room, sender, msg, is_media, ts) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
                        [serverId, room, msgObj.senderName, msgObj.msg, !!msgObj.isMedia, msgObj.timestamp || Date.now()]
                    );
                    if (fallbackRes.rows && fallbackRes.rows[0]) {
                        msgObj.id = String(fallbackRes.rows[0].id);
                    }
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
                    'SELECT id, sender, msg, is_media, ts, edited, reactions, poll, game, is_pinned FROM (SELECT * FROM messages WHERE server_id = $1 AND room = $2 ORDER BY ts DESC LIMIT $3) t ORDER BY ts ASC',
                    [serverId, room, MAX_HISTORY]);
                return res.rows.map(r => {
                    let reacs = {};
                    if (r.reactions) {
                        try { reacs = typeof r.reactions === 'string' ? JSON.parse(r.reactions) : r.reactions; } catch (e) { reacs = {}; }
                    }
                    let poll = null;
                    if (r.poll) {
                        try { poll = typeof r.poll === 'string' ? JSON.parse(r.poll) : r.poll; } catch (e) { poll = null; }
                    }
                    let game = null;
                    if (r.game) {
                        try { game = typeof r.game === 'string' ? JSON.parse(r.game) : r.game; } catch (e) { game = null; }
                    }
                    return {
                        id: String(r.id),
                        senderName: r.sender,
                        msg: r.msg,
                        isMedia: r.is_media,
                        timestamp: Number(r.ts),
                        edited: !!r.edited,
                        reactions: reacs || {},
                        poll: poll,
                        game: game,
                        isPinned: !!r.is_pinned
                    };
                });
            } catch (e) {
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
                } catch (e2) {
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
        if (pgPool) {
            try {
                const numId = parseInt(messageId, 10);
                if (!isNaN(numId)) {
                    await pgPool.query('UPDATE messages SET is_pinned = $1 WHERE server_id = $2 AND room = $3 AND id = $4', [!!isPinned, serverId, room, numId]);
                } else {
                    await pgPool.query('UPDATE messages SET is_pinned = $1 WHERE server_id = $2 AND room = $3 AND ts = $4', [!!isPinned, serverId, room, Number(messageId)]);
                }
            } catch (e) {
                console.warn('[DB] pinMessage pg update error:', e.message);
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
            if (pgPool) {
                try {
                    const numId = parseInt(messageId, 10);
                    if (!isNaN(numId)) {
                        await pgPool.query('UPDATE messages SET poll = $1 WHERE server_id = $2 AND room = $3 AND id = $4', [JSON.stringify(msg.poll), serverId, room, numId]);
                    } else {
                        await pgPool.query('UPDATE messages SET poll = $1 WHERE server_id = $2 AND room = $3 AND ts = $4', [JSON.stringify(msg.poll), serverId, room, Number(messageId)]);
                    }
                } catch (e) {
                    console.warn('[DB] votePoll pg update error:', e.message);
                }
            }
            await module.exports.saveVirtualServer(serverId, srv);
            return msg.poll;
        }
        return null;
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
