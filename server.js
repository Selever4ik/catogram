const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7,
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const sessionMiddleware = session({
    secret: 'catogram-secret-meow-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sessionMiddleware);
app.use(express.static(__dirname));

const db = {
    users: {},
    usernames: {},
    groups: {},
    messages: [],
    lastSeen: {},
    polls: {}
};

const hashPassword = (p) => crypto.createHash('sha256').update(p + 'cat-salt').digest('hex');

const getPublicUser = (login) => {
    const u = db.users[login];
    if (!u) return null;
    return {
        login: u.login,
        username: u.username,
        avatar: u.avatar || '',
        bio: u.bio || '',
        phone: u.phone || '',
        privacy: u.privacy || { hideOnline: false, hideLastSeen: false },
        lastSeen: db.lastSeen[login] || Date.now()
    };
};

function requireAuth(req, res, next) {
    if (req.session && req.session.user && db.users[req.session.user.login]) {
        db.lastSeen[req.session.user.login] = Date.now();
        next();
    } else {
        res.status(401).json({ error: 'Не авторизован' });
    }
}

app.post('/api/register', (req, res) => {
    const { login, username, password } = req.body;
    if (!login || !username || password.length < 4) {
        return res.status(400).json({ error: 'Все поля обязательны, пароль мин. 4 символа' });
    }
    const cleanLogin = login.trim().toLowerCase();
    const cleanUsername = username.trim().replace(/^@/, '');
    
    if (cleanLogin.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
    if (cleanUsername.length < 3) return res.status(400).json({ error: 'Username минимум 3 символа' });
    if (db.users[cleanLogin]) return res.status(400).json({ error: 'Логин занят' });
    if (db.usernames[cleanUsername.toLowerCase()]) return res.status(400).json({ error: '@' + cleanUsername + ' занят' });
    
    db.users[cleanLogin] = {
        login: cleanLogin,
        username: cleanUsername,
        passwordHash: hashPassword(password),
        avatar: '',
        bio: '',
        phone: '',
        privacy: { hideOnline: false, hideLastSeen: false }
    };
    db.usernames[cleanUsername.toLowerCase()] = cleanLogin;
    db.lastSeen[cleanLogin] = Date.now();
    req.session.user = { login: cleanLogin, username: cleanUsername };
    res.json({ success: true, user: getPublicUser(cleanLogin) });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    const cleanLogin = login.trim().toLowerCase();
    const user = db.users[cleanLogin];
    if (user && user.passwordHash === hashPassword(password)) {
        req.session.user = { login: user.login, username: user.username };
        db.lastSeen[cleanLogin] = Date.now();
        res.json({ success: true, user: getPublicUser(cleanLogin) });
    } else {
        res.status(400).json({ error: 'Неверный логин или пароль' });
    }
});

app.get('/api/me', (req, res) => {
    if (req.session.user && db.users[req.session.user.login]) {
        db.lastSeen[req.session.user.login] = Date.now();
        res.json({ success: true, user: getPublicUser(req.session.user.login) });
    } else {
        res.status(401).json({ error: 'Не авторизован' });
    }
});

app.post('/api/settings', requireAuth, (req, res) => {
    const { username, avatar, bio, phone, privacy, theme, customBg } = req.body;
    const userLogin = req.session.user.login;
    const user = db.users[userLogin];
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    
    if (username !== undefined && username !== user.username) {
        const cleanUsername = username.trim().replace(/^@/, '');
        if (cleanUsername.length >= 3) {
            if (!db.usernames[cleanUsername.toLowerCase()] || db.usernames[cleanUsername.toLowerCase()] === userLogin) {
                delete db.usernames[user.username.toLowerCase()];
                db.usernames[cleanUsername.toLowerCase()] = userLogin;
                user.username = cleanUsername;
                req.session.user.username = cleanUsername;
            }
        }
    }
    
    if (avatar !== undefined) user.avatar = avatar;
    if (bio !== undefined) user.bio = bio;
    if (phone !== undefined) user.phone = phone;
    if (privacy !== undefined) user.privacy = { ...user.privacy, ...privacy };
    if (theme !== undefined) user.theme = theme;
    if (customBg !== undefined) user.customBg = customBg;
    
    res.json({ success: true, user: getPublicUser(userLogin) });
});

app.post('/api/logout', (req, res) => {
    if (req.session.user) db.lastSeen[req.session.user.login] = Date.now();
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/check-username', (req, res) => {
    const username = (req.query.username || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ error: '?' });
    res.json({ available: !db.usernames[username] });
});

app.get('/api/users', requireAuth, (req, res) => {
    const users = Object.values(db.users)
        .filter(u => u.login !== req.session.user.login)
        .map(u => getPublicUser(u.login));
    res.json({ success: true, users });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.user || !db.users[session.user.login]) {
        socket.disconnect();
        return;
    }

    const login = session.user.login;
    onlineUsers.set(socket.id, login);
    socket.join(login);
    db.lastSeen[login] = Date.now();
    
    Object.values(db.groups).forEach(g => {
        if (g.members.includes(login)) socket.join(g.id);
    });

    const broadcastUsersList = () => {
        const onlineLogins = Array.from(new Set(onlineUsers.values()));
        const publicUsers = Object.values(db.users).map(u => ({
            ...getPublicUser(u.login),
            isOnline: u.privacy?.hideOnline ? false : onlineLogins.includes(u.login)
        }));
        io.emit('users_list', {
            users: publicUsers,
            groups: Object.values(db.groups),
            polls: Object.values(db.polls)
        });
    };

    broadcastUsersList();
    
    socket.emit('history', db.messages.filter(m => 
        m.to === 'global' || m.to === login || m.from === login || 
        (db.groups[m.to] && db.groups[m.to].members.includes(login))
    ));

    socket.on('send_message', (data) => {
        if (!data.to || (!data.text && !data.fileData)) return;
        const msg = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            from: login,
            to: data.to,
            text: data.text || '',
            type: data.type || 'text',
            fileData: data.fileData || null,
            fileName: data.fileName || null,
            fileSize: data.fileSize || null,
            time: new Date().toISOString()
        };
        db.messages.push(msg);
        if (db.messages.length > 500) db.messages = db.messages.slice(-500);
        
        if (data.to === 'global') {
            io.emit('new_message', msg);
        } else if (db.groups[data.to]) {
            io.to(data.to).emit('new_message', msg);
        } else {
            io.to(data.to).emit('new_message', msg);
            socket.emit('new_message', msg);
        }
    });

    socket.on('delete_message', (msgId) => {
        socket.emit('message_deleted', msgId);
    });

    socket.on('typing', (to) => {
        const payload = { from: login, username: db.users[login].username, to };
        if (to === 'global') {
            socket.broadcast.emit('user_typing', payload);
        } else if (db.groups[to]) {
            socket.to(to).emit('user_typing', payload);
        } else {
            io.to(to).emit('user_typing', payload);
        }
    });

    socket.on('create_group', (data) => {
        const groupId = 'group_' + Date.now();
        const members = [login, ...(data.members || [])].filter(v => db.users[v]);
        const uniqueMembers = [...new Set(members)];
        db.groups[groupId] = {
            id: groupId, name: data.name || 'Группа', members: uniqueMembers,
            admins: [login], avatar: '', createdBy: login
        };
        for (let [sId, sLogin] of onlineUsers.entries()) {
            if (uniqueMembers.includes(sLogin)) io.sockets.sockets.get(sId)?.join(groupId);
        }
        broadcastUsersList();
    });

    socket.on('create_poll', (data) => {
        const pollId = 'poll_' + Date.now();
        db.polls[pollId] = {
            id: pollId, groupId: data.groupId, question: data.question,
            options: data.options.map(t => ({ text: t, votes: [] })),
            createdBy: db.users[login].username, createdAt: new Date().toISOString()
        };
        io.to(data.groupId).emit('new_poll', db.polls[pollId]);
    });

    socket.on('vote_poll', (data) => {
        const poll = db.polls[data.pollId];
        if (poll && poll.options[data.optionIndex]) {
            poll.options.forEach(o => o.votes = o.votes.filter(v => v !== login));
            poll.options[data.optionIndex].votes.push(login);
            io.to(poll.groupId).emit('poll_updated', poll);
        }
    });

    // WebRTC
    socket.on('call_user', (data) => {
        io.to(data.userToCall).emit('incoming_call', {
            signal: data.signalData, from: login,
            caller: getPublicUser(login), audioOnly: data.audioOnly || false
        });
    });
    socket.on('accept_call', (data) => {
        io.to(data.to).emit('call_accepted', { signal: data.signal, from: login });
    });
    socket.on('end_call', (to) => { io.to(to).emit('call_ended'); });
    socket.on('ice_candidate', (data) => {
        io.to(data.to).emit('ice_candidate', { candidate: data.candidate, from: login });
    });
    socket.on('join_group_call', (data) => {
        socket.to(data.groupId).emit('new_peer', { peerId: socket.id, from: login });
    });
    socket.on('group_call_signal', (data) => {
        io.to(data.to).emit('group_call_signal', { signal: data.signal, from: socket.id, login });
    });
    socket.on('leave_group_call', (data) => {
        io.to(data.groupId).emit('peer_left', { peerId: socket.id, from: login });
    });

    socket.on('disconnect', () => {
        db.lastSeen[login] = Date.now();
        onlineUsers.delete(socket.id);
        Object.keys(db.groups || {}).forEach(gid => {
            io.to(gid).emit('peer_left', { peerId: socket.id, from: login });
        });
        broadcastUsersList();
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('🐱 Catogram на порту ' + PORT);
});