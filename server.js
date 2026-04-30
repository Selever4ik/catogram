const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7 // 10 MB для файлов
});

const PORT = process.env.PORT || 3000;
const sessionMiddleware = session({
    secret: 'catogram-secret-key-super-safe-2024',
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
    lastSeen: {} // login: timestamp
};

const hashPassword = (password) => crypto.createHash('sha256').update(password).digest('hex');

const getPublicUser = (login) => {
    const u = db.users[login];
    if (!u) return null;
    return {
        login: u.login,
        username: u.username,
        avatar: u.avatar,
        bio: u.bio,
        phone: u.phone,
        lastSeen: db.lastSeen[login] || Date.now()
    };
};

// API Routes
app.post('/api/register', (req, res) => {
    const { login, username, password } = req.body;
    
    if (!login || !username || password.length < 4) {
        return res.status(400).json({ error: 'Логин, @username и пароль (мин. 4 символа) обязательны' });
    }
    
    const cleanLogin = login.trim().toLowerCase();
    const cleanUsername = username.trim().replace(/^@/, '');
    
    if (db.users[cleanLogin]) return res.status(400).json({ error: 'Этот логин уже занят' });
    if (db.usernames[cleanUsername.toLowerCase()]) return res.status(400).json({ error: `@${cleanUsername} уже занят` });
    
    const newUser = {
        login: cleanLogin,
        username: cleanUsername,
        passwordHash: hashPassword(password),
        avatar: '',
        bio: '',
        phone: ''
    };
    
    db.users[cleanLogin] = newUser;
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

app.post('/api/settings', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    
    const { username, avatar, bio, phone } = req.body;
    const userLogin = req.session.user.login;
    const user = db.users[userLogin];
    
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    
    // Обновляем username если он изменился
    if (username !== undefined && username !== user.username) {
        const cleanUsername = username.trim().replace(/^@/, '');
        if (db.usernames[cleanUsername.toLowerCase()] && db.usernames[cleanUsername.toLowerCase()] !== userLogin) {
            return res.status(400).json({ error: `@${cleanUsername} уже занят` });
        }
        delete db.usernames[user.username.toLowerCase()];
        db.usernames[cleanUsername.toLowerCase()] = userLogin;
        user.username = cleanUsername;
        req.session.user.username = cleanUsername;
    }
    
    if (avatar !== undefined) user.avatar = avatar;
    if (bio !== undefined) user.bio = bio;
    if (phone !== undefined) user.phone = phone;
    
    res.json({ success: true, user: getPublicUser(userLogin) });
});

app.post('/api/logout', (req, res) => {
    if (req.session.user) {
        db.lastSeen[req.session.user.login] = Date.now();
    }
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/check-username', (req, res) => {
    const username = req.query.username?.trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'Username required' });
    const isTaken = !!db.usernames[username];
    res.json({ available: !isTaken });
});

app.get('/api/users', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    const users = Object.values(db.users)
        .filter(u => u.login !== req.session.user.login)
        .map(u => getPublicUser(u.login));
    res.json({ success: true, users });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io с сессиями
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
    
    // Обновляем время последнего онлайна
    db.lastSeen[login] = Date.now();
    
    Object.values(db.groups).forEach(g => {
        if (g.members.includes(login)) socket.join(g.id);
    });

    const broadcastUsersList = () => {
        const onlineLogins = Array.from(new Set(onlineUsers.values()));
        const publicUsers = Object.values(db.users).map(u => ({
            ...getPublicUser(u.login),
            isOnline: onlineLogins.includes(u.login)
        }));
        
        io.emit('users_list', {
            users: publicUsers,
            groups: Object.values(db.groups)
        });
    };

    broadcastUsersList();
    
    // Отправляем историю
    socket.emit('history', db.messages.filter(m => 
        m.to === 'global' || 
        m.to === login || 
        m.from === login || 
        (db.groups[m.to] && db.groups[m.to].members.includes(login))
    ));

    // Сообщения
    socket.on('send_message', (data) => {
        const msg = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            from: login,
            to: data.to,
            text: data.text || '',
            type: data.type || 'text',
            fileData: data.fileData || null,
            fileName: data.fileName || null,
            fileSize: data.fileSize || null,
            duration: data.duration || null,
            time: new Date().toISOString()
        };
        db.messages.push(msg);
        
        if (data.to === 'global') {
            io.emit('new_message', msg);
        } else if (db.groups[data.to]) {
            io.to(data.to).emit('new_message', msg);
        } else {
            io.to(data.to).emit('new_message', msg);
            socket.emit('new_message', msg);
        }
    });

    // Создание группы
    socket.on('create_group', (data) => {
        const groupId = 'group_' + Date.now();
        const members = [login, ...data.members].filter(v => db.users[v]);
        const uniqueMembers = Array.from(new Set(members));
        
        db.groups[groupId] = {
            id: groupId,
            name: data.name || 'Новая группа',
            members: uniqueMembers,
            avatar: ''
        };
        
        for (let [sId, sLogin] of onlineUsers.entries()) {
            if (db.groups[groupId].members.includes(sLogin)) {
                io.sockets.sockets.get(sId)?.join(groupId);
            }
        }
        broadcastUsersList();
    });

    // Индикатор печати
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

    // WebRTC
    socket.on('call_user', (data) => {
        const callerInfo = getPublicUser(login);
        io.to(data.userToCall).emit('incoming_call', {
            signal: data.signalData,
            from: login,
            caller: callerInfo
        });
    });

    socket.on('answer_call', (data) => {
        io.to(data.to).emit('call_accepted', data.signal);
    });

    socket.on('ice_candidate', (data) => {
        io.to(data.to).emit('ice_candidate', { candidate: data.candidate, from: login });
    });
    
    socket.on('end_call', (to) => {
        io.to(to).emit('call_ended');
    });

    socket.on('disconnect', () => {
        db.lastSeen[login] = Date.now();
        onlineUsers.delete(socket.id);
        broadcastUsersList();
    });
});

server.listen(PORT, () => {
    console.log(`🐱 Catogram запущен на порту ${PORT}`);
});