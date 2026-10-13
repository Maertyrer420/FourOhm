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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
            ringColor: u.ring_color || u.ringColor || '#00ff00',
            banner: u.banner || '',
            steamId: u.steam_id || u.steamId || '',
            steamUsername: u.steam_username || u.steamUsername || '',
            steamAvatar: u.steam_avatar || u.steamAvatar || '',
            cs2InventoryMode: u.cs2_inventory_mode || u.cs2InventoryMode || 'filtered',
            cs2ShowcaseItems: Array.isArray(u.cs2_showcase_items || u.cs2ShowcaseItems) ? (u.cs2_showcase_items || u.cs2ShowcaseItems) : []
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Steam & CS2 Inventory Helper & Endpoints ---
const steamInventoryMemoryCache = {}; // username -> { ts: timestamp, items: [...] }

function parseValveInventoryDescriptions(data, steamId) {
    if (!data || !data.descriptions) {
        return [];
    }

    const descMap = {};
    for (const d of data.descriptions) {
        const key = `${d.classid}_${d.instanceid || '0'}`;
        descMap[key] = d;
    }

    const items = [];
    const assets = Array.isArray(data.assets) ? data.assets : [];

    for (const a of assets) {
        const key = `${a.classid}_${a.instanceid || '0'}`;
        const d = descMap[key];
        if (!d) continue;

        // Tags
        const tags = Array.isArray(d.tags) ? d.tags : [];
        const typeTag = tags.find(t => t.category === 'Type');
        const rarityTag = tags.find(t => t.category === 'Rarity');
        const weaponTag = tags.find(t => t.category === 'Weapon');
        const exteriorTag = tags.find(t => t.category === 'Exterior');

        const typeStr = d.type || typeTag?.localized_tag_name || '';
        const nameStr = d.market_hash_name || d.name || 'CS2 Item';
        
        // Category determination
        let category = 'other';
        const typeLower = (typeStr + ' ' + nameStr).toLowerCase();
        if (typeLower.includes('messer') || typeLower.includes('knife') || typeLower.includes('karambit') || typeLower.includes('bayonet') || typeLower.includes('daggers')) {
            category = 'knife';
        } else if (typeLower.includes('handschuh') || typeLower.includes('glove') || typeLower.includes('wraps')) {
            category = 'glove';
        } else if (typeLower.includes('gewehr') || typeLower.includes('rifle') || typeLower.includes('ak-47') || typeLower.includes('m4a4') || typeLower.includes('m4a1-s')) {
            category = 'rifle';
        } else if (typeLower.includes('scharfschütze') || typeLower.includes('sniper') || typeLower.includes('awp') || typeLower.includes('scout') || typeLower.includes('ssg 08')) {
            category = 'sniper';
        } else if (typeLower.includes('pistole') || typeLower.includes('pistol') || typeLower.includes('glock') || typeLower.includes('usp') || typeLower.includes('deagle')) {
            category = 'pistol';
        } else if (typeLower.includes('mp') || typeLower.includes('smg') || typeLower.includes('p90') || typeLower.includes('mp9') || typeLower.includes('mac-10')) {
            category = 'smg';
        } else if (typeLower.includes('kiste') || typeLower.includes('case') || typeLower.includes('container') || typeLower.includes('kapsel') || typeLower.includes('capsule')) {
            category = 'container';
        } else if (typeLower.includes('aufkleber') || typeLower.includes('sticker') || typeLower.includes('patch')) {
            category = 'sticker';
        } else if (typeLower.includes('agent') || typeLower.includes('agentin')) {
            category = 'agent';
        }

        const rarityName = rarityTag?.localized_tag_name || 'Standard';
        let rarityColor = rarityTag?.color ? ('#' + rarityTag.color) : '#b0c3d9';
        // Fallback colors for CS2 rarities if color tag missing
        if (!rarityTag?.color) {
            if (category === 'knife' || category === 'glove') rarityColor = '#e4ae39';
            else if (rarityName.toLowerCase().includes('verdeckt') || rarityName.toLowerCase().includes('covert')) rarityColor = '#eb4b4b';
            else if (rarityName.toLowerCase().includes('klassifiziert') || rarityName.toLowerCase().includes('classified')) rarityColor = '#d32ce6';
            else if (rarityName.toLowerCase().includes('vertraulich') || rarityName.toLowerCase().includes('restricted')) rarityColor = '#8847ff';
            else if (rarityName.toLowerCase().includes('militär') || rarityName.toLowerCase().includes('mil-spec')) rarityColor = '#4b69ff';
        }

        const iconUrl = d.icon_url 
            ? `https://community.cloudflare.steamstatic.com/economy/image/${d.icon_url}/360fx360f` 
            : '';
        const marketUrl = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(d.market_hash_name || d.name)}`;

        let inspectUrl = '';
        if (Array.isArray(d.actions) && d.actions.length > 0 && d.actions[0].link) {
            inspectUrl = d.actions[0].link
                .replace('%owner_steamid%', steamId)
                .replace('%assetid%', a.assetid);
        }

        items.push({
            assetid: a.assetid,
            classid: a.classid,
            instanceid: a.instanceid || '0',
            name: d.name,
            marketHashName: d.market_hash_name || d.name,
            iconUrl,
            type: typeStr,
            rarity: { name: rarityName, color: rarityColor },
            category,
            weapon: weaponTag?.localized_tag_name || '',
            exterior: exteriorTag?.localized_tag_name || '',
            marketUrl,
            inspectUrl
        });
    }

    return items;
}

async function fetchValveCs2Inventory(steamId) {
    if (!steamId) throw new Error('SteamID fehlt.');
    const url = `https://steamcommunity.com/inventory/${encodeURIComponent(steamId)}/730/2?l=german&count=2000`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://steamcommunity.com/'
        }
    });

    if (res.status === 401 || res.status === 403) {
        const err = new Error('private');
        err.statusCode = 403;
        throw err;
    }
    if (res.status === 429) {
        const err = new Error('rate_limited');
        err.statusCode = 429;
        throw err;
    }
    if (!res.ok) {
        throw new Error(`Steam API Fehler: HTTP ${res.status}`);
    }

    const data = await res.json();
    return parseValveInventoryDescriptions(data, steamId);
}

// 1. Steam OpenID Login Initiation
app.get('/api/auth/steam', (req, res) => {
    const userToken = req.query.token;
    if (!userToken) return res.status(400).send("Fehlendes Authentifizierungs-Token.");

    const host = (req.headers['x-forwarded-host'] || req.get('host') || 'fourohm-auth.onrender.com').split(',')[0].trim();
    const protocol = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const baseUrl = `${protocol}://${host}`;
    const realm = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const returnTo = `${baseUrl}/api/auth/steam/callback?token=${encodeURIComponent(userToken)}`;

    const params = new URLSearchParams({
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnTo,
        'openid.realm': realm,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
    });

    res.redirect(`https://steamcommunity.com/openid/login?${params.toString()}`);
});

// 2. Steam OpenID Callback & Verification
app.get('/api/auth/steam/callback', async (req, res) => {
    try {
        const userToken = req.query.token;
        if (!userToken) return res.status(400).send("Ungültige Anfrage: Kein Token angegeben.");

        let decoded;
        try {
            decoded = jwt.verify(userToken, JWT_SECRET);
        } catch (e) {
            return res.status(401).send("Sitzung abgelaufen. Bitte versuche es erneut in 4Ω.");
        }

        // Verify OpenID signature directly with Steam (send only openid.* params)
        const verifyParams = new URLSearchParams();
        for (const [key, val] of Object.entries(req.query)) {
            if (key.startsWith('openid.')) {
                verifyParams.set(key, val);
            }
        }
        verifyParams.set('openid.mode', 'check_authentication');

        const verifyRes = await fetch('https://steamcommunity.com/openid/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: verifyParams.toString()
        });
        const verifyText = await verifyRes.text();

        if (!verifyText.includes('is_valid:true')) {
            console.warn('[Steam Auth Callback] check_authentication failed:', verifyText);
            return res.status(400).send("Steam-Validierung fehlgeschlagen.");
        }

        const claimedId = req.query['openid.claimed_id'] || req.query['openid.identity'] || '';
        const match = claimedId.match(/\/id\/(\d+)/) || claimedId.match(/(\d{17})/);
        if (!match || !match[1]) {
            return res.status(400).send("SteamID konnte nicht ermittelt werden.");
        }
        const steamId = match[1];

        // Fetch Steam public profile info
        let steamUsername = '';
        let steamAvatar = '';
        try {
            const profileRes = await fetch(`https://steamcommunity.com/profiles/${steamId}?xml=1`);
            if (profileRes.ok) {
                const xml = await profileRes.text();
                const nameMatch = xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/) || xml.match(/<steamID>(.*?)<\/steamID>/);
                if (nameMatch) steamUsername = nameMatch[1];
                const avMatch = xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/) || xml.match(/<avatarFull>(.*?)<\/avatarFull>/);
                if (avMatch) steamAvatar = avMatch[1];
            }
        } catch (e) {}

        await db.linkSteamAccount(decoded.id, {
            steamId,
            steamUsername: steamUsername || steamId,
            steamAvatar: steamAvatar || ''
        });

        res.send(`
            <!DOCTYPE html>
            <html lang="de">
            <head>
                <meta charset="utf-8">
                <title>Steam verbunden | 4Ω</title>
                <style>
                    body { background: #0c0d12; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .card { background: #14151e; border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; padding: 40px; text-align: center; max-width: 440px; box-shadow: 0 20px 50px rgba(0,0,0,0.7); }
                    .icon { width: 64px; height: 64px; background: rgba(99,102,241,0.2); border: 1px solid rgba(99,102,241,0.5); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: #818cf8; font-size: 30px; font-weight: bold; }
                    h2 { margin: 0 0 10px; font-size: 22px; color: #fff; }
                    p { margin: 0 0 25px; font-size: 14px; color: #9ca3af; line-height: 1.5; }
                    .btn { display: inline-block; background: #6366f1; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 12px; font-weight: bold; font-size: 13px; transition: background 0.2s; cursor: pointer; border: none; }
                    .btn:hover { background: #4f46e5; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">✓</div>
                    <h2>Steam erfolgreich verknüpft!</h2>
                    <p>Dein Steam-Account (<strong>${steamUsername || steamId}</strong>) wurde erfolgreich mit deinem 4Ω-Konto verknüpft.</p>
                    <button class="btn" onclick="window.close()">Fenster schließen</button>
                </div>
                <script>
                    setTimeout(() => { try { window.close(); } catch(e){} }, 3000);
                </script>
            </body>
            </html>
        `);
    } catch (err) {
        console.error('[Steam Auth Callback] Error:', err);
        res.status(500).send("Interner Fehler bei der Steam-Verknüpfung: " + err.message);
    }
});

// 3. Manual Steam Account Link (Fallback / Direkteingabe)
app.post('/api/auth/steam/manual', authenticateToken, async (req, res) => {
    try {
        let input = String(req.body.steamId || '').trim();
        if (!input) return res.status(400).json({ error: 'SteamID64 oder Profil-URL erforderlich.' });

        // Extract steamId if vanity or profile link passed
        let steamId = input;
        const profileMatch = input.match(/\/profiles\/(\d+)/);
        if (profileMatch) {
            steamId = profileMatch[1];
        } else if (/^\d{17}$/.test(input)) {
            steamId = input;
        } else {
            // Could be a custom vanity URL, try resolving via xml
            const vanityMatch = input.match(/\/id\/([^\/]+)/) || [null, input];
            const vanityName = vanityMatch[1] || input;
            try {
                const xmlRes = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanityName)}?xml=1`);
                if (xmlRes.ok) {
                    const xmlText = await xmlRes.text();
                    const idMatch = xmlText.match(/<steamID64>(\d+)<\/steamID64>/);
                    if (idMatch) steamId = idMatch[1];
                }
            } catch (e) {}
        }

        if (!/^\d{17}$/.test(steamId)) {
            return res.status(400).json({ error: 'Ungültige SteamID64 (muss eine 17-stellige Zahl sein).' });
        }

        // Fetch display name & avatar
        let steamUsername = '';
        let steamAvatar = '';
        try {
            const profileRes = await fetch(`https://steamcommunity.com/profiles/${steamId}?xml=1`);
            if (profileRes.ok) {
                const xml = await profileRes.text();
                const nameMatch = xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/) || xml.match(/<steamID>(.*?)<\/steamID>/);
                if (nameMatch) steamUsername = nameMatch[1];
                const avMatch = xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/) || xml.match(/<avatarFull>(.*?)<\/avatarFull>/);
                if (avMatch) steamAvatar = avMatch[1];
            }
        } catch (e) {}

        const result = await db.linkSteamAccount(req.user.id, {
            steamId,
            steamUsername: steamUsername || steamId,
            steamAvatar: steamAvatar || ''
        });
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 4. Steam Unlink
app.post('/api/auth/steam/unlink', authenticateToken, async (req, res) => {
    try {
        await db.unlinkSteamAccount(req.user.id);
        res.json({ success: true, message: 'Steam-Verknüpfung aufgehoben.' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 5. CS2 Inventory Endpoint
app.get('/api/cs2/inventory/:username', async (req, res) => {
    const targetUsername = req.params.username;
    const forceRefresh = req.query.refresh === 'true';

    try {
        const u = await db.getUserByUsername(targetUsername);
        if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

        const steamId = u.steam_id || u.steamId;
        if (!steamId) {
            return res.status(400).json({ error: 'no_steam', message: 'Nutzer hat keinen Steam-Account verknüpft.' });
        }

        const mode = u.cs2_inventory_mode || u.cs2InventoryMode || 'filtered';
        const showcase = Array.isArray(u.cs2_showcase_items || u.cs2ShowcaseItems) ? (u.cs2_showcase_items || u.cs2ShowcaseItems) : [];

        // Check cache (memory or DB)
        const now = Date.now();
        const cacheTtlMs = 30 * 60 * 1000; // 30 minutes
        const memCache = steamInventoryMemoryCache[u.username.toLowerCase()];

        if (!forceRefresh && memCache && (now - memCache.ts < cacheTtlMs)) {
            return res.json({
                success: true,
                cached: true,
                steamId,
                steamUsername: u.steam_username || u.steamUsername || '',
                steamAvatar: u.steam_avatar || u.steamAvatar || '',
                mode,
                showcaseItems: showcase,
                items: memCache.items,
                total: memCache.items.length
            });
        }

        // Try DB cache if memcache missing
        if (!forceRefresh) {
            const dbCache = await db.getCs2InventoryCache(u.id);
            if (dbCache && dbCache.ts && (now - dbCache.ts < cacheTtlMs) && Array.isArray(dbCache.items)) {
                steamInventoryMemoryCache[u.username.toLowerCase()] = dbCache;
                return res.json({
                    success: true,
                    cached: true,
                    steamId,
                    steamUsername: u.steam_username || u.steamUsername || '',
                    steamAvatar: u.steam_avatar || u.steamAvatar || '',
                    mode,
                    showcaseItems: showcase,
                    items: dbCache.items,
                    total: dbCache.items.length
                });
            }
        }

        // Fetch fresh from Valve
        try {
            const items = await fetchValveCs2Inventory(steamId);
            const cacheObj = { ts: now, items };
            steamInventoryMemoryCache[u.username.toLowerCase()] = cacheObj;
            await db.saveCs2InventoryCache(u.id, cacheObj);

            res.json({
                success: true,
                cached: false,
                steamId,
                steamUsername: u.steam_username || u.steamUsername || '',
                steamAvatar: u.steam_avatar || u.steamAvatar || '',
                mode,
                showcaseItems: showcase,
                items,
                total: items.length
            });
        } catch (fetchErr) {
            // If rate limited or error, fall back to existing cache if available
            const fallback = memCache || (await db.getCs2InventoryCache(u.id));
            if (fallback && Array.isArray(fallback.items)) {
                return res.json({
                    success: true,
                    cached: true,
                    notice: 'Steam API temporär überlastet, zeige gecachte Daten.',
                    steamId,
                    steamUsername: u.steam_username || u.steamUsername || '',
                    steamAvatar: u.steam_avatar || u.steamAvatar || '',
                    mode,
                    showcaseItems: showcase,
                    items: fallback.items,
                    total: fallback.items.length
                });
            }

            if (fetchErr.message === 'private' || fetchErr.statusCode === 403) {
                return res.status(403).json({
                    error: 'private',
                    message: 'Das Steam-Inventar dieses Nutzers ist privat (in den Steam-Datenschutzeinstellungen auf öffentlich stellen).'
                });
            }
            if (fetchErr.message === 'rate_limited' || fetchErr.statusCode === 429) {
                return res.status(429).json({
                    error: 'rate_limited',
                    steamId,
                    steamUsername: u.steam_username || u.steamUsername || '',
                    message: 'Steam API Rate-Limit erreicht. Bitte in wenigen Minuten erneut versuchen.'
                });
            }
            throw fetchErr;
        }
    } catch (e) {
        console.error('[CS2 Inventory] Error:', e);
        res.status(500).json({ error: e.message || 'Fehler beim Laden des CS2-Inventars' });
    }
});

// 6. CS2 Inventory Client Sync (Workaround for Datacenter IP 429 rate limits)
app.post('/api/cs2/inventory/sync', async (req, res) => {
    try {
        const { username, rawData } = req.body;
        if (!username || !rawData) return res.status(400).json({ error: 'Parameter fehlen' });

        const u = await db.getUserByUsername(username);
        if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

        const steamId = u.steam_id || u.steamId;
        if (!steamId) return res.status(400).json({ error: 'Kein Steam-Account verknüpft' });

        const items = parseValveInventoryDescriptions(rawData, steamId);
        const cacheObj = { ts: Date.now(), items };
        steamInventoryMemoryCache[u.username.toLowerCase()] = cacheObj;
        await db.saveCs2InventoryCache(u.id, cacheObj);

        const mode = u.cs2_inventory_mode || u.cs2InventoryMode || 'filtered';
        const showcase = Array.isArray(u.cs2_showcase_items || u.cs2ShowcaseItems) ? (u.cs2_showcase_items || u.cs2ShowcaseItems) : [];

        res.json({
            success: true,
            cached: false,
            steamId,
            steamUsername: u.steam_username || u.steamUsername || '',
            steamAvatar: u.steam_avatar || u.steamAvatar || '',
            mode,
            showcaseItems: showcase,
            items,
            total: items.length
        });
    } catch(e) {
        console.error('[CS2 Inventory Sync Error]:', e);
        res.status(500).json({ error: e.message });
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
        const ts = msg.ts || Date.now();
        io.to('user_' + req.params.targetUser).emit('private-message', req.user.username, msgText, ts, isMedia, req.params.targetUser);
        res.json({ success: true, message: msg });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Settings (User Settings & Server Settings) ---
app.get(['/api/settings', '/api/server/settings'], async (req, res) => {
    const serverId = req.query.serverId || req.body?.serverId;
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

app.post(['/api/settings', '/api/server/settings'], async (req, res) => {
    const serverId = req.query.serverId || req.body?.serverId;
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

// --- Virtual Server Channels & Emotes ---
function sanitizeChannels(channels) {
    if (!Array.isArray(channels)) return [];
    return channels.map(c => {
        const copy = { ...c };
        copy.hasPassword = !!copy.password;
        delete copy.password;
        return copy;
    });
}

app.get('/api/channels', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const srv = await db.getVirtualServer(serverId);
    res.json(sanitizeChannels(srv.channels || []));
});

app.post('/api/channels', async (req, res) => {
    const serverId = req.query.serverId || 'default';
    const { name, type, password } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const srv = await db.getVirtualServer(serverId);
    if (!srv.channels) srv.channels = [];

    const newChannel = {
        id: name.toLowerCase().replace(/\s+/g, '-') + '_' + Date.now().toString().slice(-4),
        name,
        type: type || 'text',
        password: password ? String(password) : '',
        hasPassword: !!password,
        whitelist: []
    };
    srv.channels.push(newChannel);
    await db.saveVirtualServer(serverId, srv);

    const safe = sanitizeChannels(srv.channels);
    io.to(serverId).emit('channels-update', safe);
    res.json({ success: true, channel: { ...newChannel, password: undefined }, channels: safe });
});

app.post('/api/channels/rename', async (req, res) => {
    try {
        const { serverId = 'default', oldName, newName, requestingUser } = req.body;
        if (!oldName || !newName) return res.status(400).json({ error: 'oldName und newName erforderlich' });
        const srv = await db.getVirtualServer(serverId);
        const reqRole = (srv.userGroups && srv.userGroups[requestingUser]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;
        if (reqPower < 75 && requestingUser) {
            return res.status(403).json({ error: 'Unzureichende Berechtigung zum Umbenennen' });
        }
        if (!srv.channels) srv.channels = [];
        const ch = srv.channels.find(c => c.name === oldName || c.id === oldName);
        if (!ch) return res.status(404).json({ error: 'Kanal nicht gefunden' });
        ch.name = newName;
        await db.saveVirtualServer(serverId, srv);
        await db.renameChannelMessages(serverId, oldName, newName);
        const safe = sanitizeChannels(srv.channels);
        io.to(serverId).emit('channels-update', safe);
        io.to(serverId).emit('channel-renamed', { oldName, newName, channelId: ch.id });
        res.json({ success: true, channels: safe });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/channels/verify-password', async (req, res) => {
    try {
        const { serverId = 'default', channelName, password, username } = req.body;
        const srv = await db.getVirtualServer(serverId);
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
        const { serverId = 'default', channelName, whitelist, requestingUser } = req.body;
        const srv = await db.getVirtualServer(serverId);
        const reqRole = (srv.userGroups && srv.userGroups[requestingUser]) || srv.settings?.defaultRole || 'user';
        const reqPower = powerMap[reqRole] || 0;
        if (reqPower < 75 && requestingUser) {
            return res.status(403).json({ error: 'Unzureichende Berechtigung' });
        }
        const ch = (srv.channels || []).find(c => c.name === channelName || c.id === channelName);
        if (!ch) return res.status(404).json({ error: 'Kanal nicht gefunden' });
        ch.whitelist = Array.isArray(whitelist) ? whitelist : [];
        await db.saveVirtualServer(serverId, srv);
        const safe = sanitizeChannels(srv.channels);
        io.to(serverId).emit('channels-update', safe);
        res.json({ success: true, channel: ch });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
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
        const safe = sanitizeChannels(srv.channels);
        io.to(serverId).emit('channels-update', safe);
        return res.json({ success: true, channels: safe });
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
            // Keep passwords and whitelists if reordered array stripped them
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
            await db.saveVirtualServer(serverId, srv);
            const safe = sanitizeChannels(srv.channels);
            io.to(serverId).emit('channels-update', safe);
            return res.json({ success: true, channels: safe });
        }
        res.status(403).json({ error: 'Unzureichende Berechtigung zum Umordnen von Kanälen' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Emotes ---
app.get('/api/emotes', async (req, res) => {
    try {
        const serverId = req.query.serverId || 'default';
        const srv = await db.getVirtualServer(serverId);
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
        socket.emit('channels-update', sanitizeChannels(srv.channels || []));
        socket.emit('emotes-update', srv.emotes || []);

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

        // Broadcast to recipient user room
        io.to('user_' + toUser).emit('private-message', fromName, msg, timestamp, isMedia, toUser);

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
