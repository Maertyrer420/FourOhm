const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dataDir = path.join(process.env.APPDATA || require('os').homedir(), 'VoiceClient_GlobalAuth');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'users.json');

// Init DB
if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify([]));
}

function getUsers() {
    return JSON.parse(fs.readFileSync(dbFile));
}
function saveUsers(users) {
    fs.writeFileSync(dbFile, JSON.stringify(users, null, 2));
}

module.exports = {
    register: (username, password) => {
        const users = getUsers();
        if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
            throw new Error('Benutzername bereits vergeben.');
        }
        const hashedPassword = bcrypt.hashSync(password, 8);
        const newUser = {
            id: Date.now().toString(),
            username,
            password: hashedPassword,
            friends: [],
            settings: {}
        };
        users.push(newUser);
        saveUsers(users);
        return newUser;
    },
    login: (username, password) => {
        const users = getUsers();
        const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!user) throw new Error('Benutzer nicht gefunden.');
        
        const isValid = bcrypt.compareSync(password, user.password);
        if (!isValid) throw new Error('Falsches Passwort.');
        
        return user;
    },
    getUserById: (id) => {
        return getUsers().find(u => u.id === id);
    },
    getUserByUsername: (username) => {
        return getUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
    },
    addFriend: (userId, friendUsername) => {
        const users = getUsers();
        const user = users.find(u => u.id === userId);
        const friend = users.find(u => u.username.toLowerCase() === friendUsername.toLowerCase());
        
        if (!user) throw new Error("User nicht gefunden");
        if (!friend) throw new Error("Freund existiert nicht");
        if (user.id === friend.id) throw new Error("Du kannst dich nicht selbst adden");
        
        if (!user.friends) user.friends = [];
        if (user.friends.includes(friend.id)) throw new Error("Bereits befreundet");
        
        user.friends.push(friend.id);
        
        // Add reciprocally
        if (!friend.friends) friend.friends = [];
        if (!friend.friends.includes(user.id)) friend.friends.push(user.id);
        
        saveUsers(users);
        return { id: friend.id, username: friend.username };
    },
    removeFriend: (userId, friendId) => {
        const users = getUsers();
        const user = users.find(u => u.id === userId);
        const friend = users.find(u => u.id === friendId);
        if(user && user.friends) user.friends = user.friends.filter(id => id !== friendId);
        if(friend && friend.friends) friend.friends = friend.friends.filter(id => id !== userId);
        saveUsers(users);
    },
    getFriends: (userId) => {
        const users = getUsers();
        const user = users.find(u => u.id === userId);
        if(!user || !user.friends) return [];
        return users.filter(u => user.friends.includes(u.id)).map(u => ({ id: u.id, username: u.username }));
    },
    getSettings: (userId) => {
        const user = getUsers().find(u => u.id === userId);
        return user ? (user.settings || {}) : {};
    },
    saveSettings: (userId, settings) => {
        const users = getUsers();
        const user = users.find(u => u.id === userId);
        if (user) {
            user.settings = { ...user.settings, ...settings };
            saveUsers(users);
            return user.settings;
        }
        return {};
    },
    // --- User's Saved Servers ---
    getUserServers: (userId) => {
        const user = getUsers().find(u => u.id === userId);
        return user ? (user.servers || []) : [];
    },
    addUserServer: (userId, serverData) => {
        const users = getUsers();
        const user = users.find(u => u.id === userId);
        if (user) {
            if(!user.servers) user.servers = [];
            
            // Generate a random ID if not provided
            if(!serverData.id) serverData.id = Date.now().toString();
            
            user.servers.push(serverData);
            saveUsers(users);
            return serverData;
        }
        throw new Error("User not found");
    },
    removeUserServer: (userId, serverId) => {
        const users = getUsers();
        const user = users.find(u => u.id === userId);
        if (user && user.servers) {
            user.servers = user.servers.filter(s => s.id !== serverId);
            saveUsers(users);
        }
    },
    updateUserServer: (userId, serverId, data) => {
        const users = getUsers();
        const user = users.find(u => u.id === userId);
        if (user && user.servers) {
            const s = user.servers.find(s => s.id === serverId);
            if (s) {
                if (data.name !== undefined) s.name = data.name;
                if (data.motd !== undefined) s.motd = data.motd;
                saveUsers(users);
                return s;
            }
        }
        throw new Error("Server nicht gefunden");
    }
};
