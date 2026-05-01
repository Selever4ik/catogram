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
    secret: 'catogram-secret-key-super-safe-2024-meow',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sessionMiddleware);
app.use(express.static(__dirname));

// ========== IN-MEMORY DATABASE ==========
const db = {
    users: {},        // login: { login, username, passwordHash, avatar, bio, phone, privacy }
    usernames: {},    // username_lowercase: login
    groups: {},       // groupId: { id, name, members[], admins[], avatar, createdBy }
    messages: [],     // { id, from, to, text, type, fileData, fileName, fileSize, time }
    lastSeen: {},     // login: timestamp
    polls: {}         // pollId: { id, groupId, question, options: [{text, votes:[]}], createdBy, createdAt }
};

// ========== HELPERS ==========
const hashPassword = (password) => crypto.createHash('sha256').update(password + 'cat-salt').digest('hex');

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

// ========== AUTH MIDDLEWARE ==========
function requireAuth(req, res, next) {
    if (req.session && req.session.user && db.users[req.session.user.login]) {
        db.lastSeen[req.session.user.login] = Date.now();
        next();
    } else {
        res.status(401).json({ error: 'Не авторизован' });
    }
}

// ========== API ROUTES ==========

// Регистрация
app.post('/api/register', (req, res) => {
    const { login, username, password } = req.body;
    if (!login || !username || password.length < 4) {
        return res.status(400).json({ error: 'Логин, @username и пароль (мин. 4 символа) обязательны' });
    }
    const cleanLogin = login.trim().toLowerCase();
    const cleanUsername = username.trim().replace(/^@/, '');
    
    if (cleanLogin.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
    if (cleanUsername.length < 3) return res.status(400).json({ error: 'Username минимум 3 символа' });
    if (db.users[cleanLogin]) return res.status(400).json({ error: 'Этот логин уже занят' });
    if (db.usernames[cleanUsername.toLowerCase()]) return res.status(400).json({ error: `@${cleanUsername} уже занят` });
    
    const newUser = {
        login: cleanLogin,
        username: cleanUsername,
        passwordHash: hashPassword(password),
        avatar: '',
        bio: '',
        phone: '',
        privacy: { hideOnline: false, hideLastSeen: false }
    };
    
    db.users[cleanLogin] = newUser;
    db.usernames[cleanUsername.toLowerCase()] = cleanLogin;
    db.lastSeen[cleanLogin] = Date.now();
    req.session.user = { login: cleanLogin, username: cleanUsername };
    
    console.log(`✅ Новый пользователь: @${cleanUsername} (${cleanLogin})`);
    res.json({ success: true, user: getPublicUser(cleanLogin) });
});

// Вход
app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    const cleanLogin = login.trim().toLowerCase();
    const user = db.users[cleanLogin];
    
    if (user && user.passwordHash === hashPassword(password)) {
        req.session.user = { login: user.login, username: user.username };
        db.lastSeen[cleanLogin] = Date.now();
        console.log(`🔑 Вход: @${user.username}`);
        res.json({ success: true, user: getPublicUser(cleanLogin) });
    } else {
        res.status(400).json({ error: 'Неверный логин или пароль' });
    }
});

// Проверка сессии
app.get('/api/me', (req, res) => {
    if (req.session.user && db.users[req.session.user.login]) {
        db.lastSeen[req.session.user.login] = Date.now();
        res.json({ success: true, user: getPublicUser(req.session.user.login) });
    } else {
        res.status(401).json({ error: 'Не авторизован' });
    }
});

// Настройки профиля
app.post('/api/settings', requireAuth, (req, res) => {
    const { username, avatar, bio, phone, privacy } = req.body;
    const userLogin = req.session.user.login;
    const user = db.users[userLogin];
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    
    if (username !== undefined && username !== user.username) {
        const cleanUsername = username.trim().replace(/^@/, '');
        if (cleanUsername.length < 3) return res.status(400).json({ error: 'Username минимум 3 символа' });
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
    if (privacy !== undefined) user.privacy = { ...user.privacy, ...privacy };
    
    console.log(`⚙️ Настройки обновлены: @${user.username}`);
    res.json({ success: true, user: getPublicUser(userLogin) });
});

// Выход
app.post('/api/logout', (req, res) => {
    if (req.session.user) {
        db.lastSeen[req.session.user.login] = Date.now();
        console.log(`👋 Выход: ${req.session.user.username}`);
    }
    req.session.destroy();
    res.json({ success: true });
});

// Проверка username
app.get('/api/check-username', (req, res) => {
    const username = req.query.username?.trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'Username required' });
    res.json({ available: !db.usernames[username] });
});

// Список пользователей
app.get('/api/users', requireAuth, (req, res) => {
    const users = Object.values(db.users)
        .filter(u => u.login !== req.session.user.login)
        .map(u => getPublicUser(u.login));
    res.json({ success: true, users });
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== SOCKET.IO ==========
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

const onlineUsers = new Map(); // socketId -> login
const groupCalls = {}; // groupId: Set of socketIds

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.user || !db.users[session.user.login]) {
        console.log('❌ Неавторизованное подключение');
        socket.disconnect();
        return;
    }

    const login = session.user.login;
    const username = db.users[login].username;
    
    onlineUsers.set(socket.id, login);
    socket.join(login);
    db.lastSeen[login] = Date.now();
    
    console.log(`🟢 ${username} подключился (всего онлайн: ${new Set(onlineUsers.values()).size})`);
    
    // Подключаем к комнатам групп
    Object.values(db.groups).forEach(g => {
        if (g.members.includes(login)) socket.join(g.id);
    });

    // Отправка списка пользователей и групп
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
    
    // Отправка истории сообщений
    socket.emit('history', db.messages.filter(m => 
        m.to === 'global' || m.to === login || m.from === login || 
        (db.groups[m.to] && db.groups[m.to].members.includes(login))
    ));

    // ===== СООБЩЕНИЯ =====
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
        
        // Ограничение истории (последние 500 сообщений)
        if (db.messages.length > 500) {
            db.messages = db.messages.slice(-500);
        }
        
        if (data.to === 'global') {
            io.emit('new_message', msg);
        } else if (db.groups[data.to]) {
            io.to(data.to).emit('new_message', msg);
        } else {
            // Личное сообщение
            io.to(data.to).emit('new_message', msg);
            socket.emit('new_message', msg);
        }
    });

    // Удаление сообщения
    socket.on('delete_message', (msgId) => {
        socket.emit('message_deleted', msgId);
    });

    // ===== ОПОВЕЩЕНИЕ О ПЕЧАТИ =====
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

    // ===== ГРУППЫ =====
    socket.on('create_group', (data) => {
        const groupId = 'group_' + Date.now();
        const members = [login, ...(data.members || [])].filter(v => db.users[v]);
        const uniqueMembers = Array.from(new Set(members));
        
        db.groups[groupId] = {
            id: groupId,
            name: data.name || 'Новая группа',
            members: uniqueMembers,
            admins: [login],
            avatar: '',
            createdBy: login
        };
        
        // Подключаем участников к комнате
        for (let [sId, sLogin] of onlineUsers.entries()) {
            if (uniqueMembers.includes(sLogin)) {
                io.sockets.sockets.get(sId)?.join(groupId);
            }
        }
        
        console.log(`👥 Группа "${data.name}" создана пользователем ${username}`);
        broadcastUsersList();
    });

    socket.on('add_member', (data) => {
        const group = db.groups[data.groupId];
        if (group && group.members.includes(login) && !group.members.includes(data.login)) {
            group.members.push(data.login);
            for (let [sId, sLogin] of onlineUsers.entries()) {
                if (sLogin === data.login) io.sockets.sockets.get(sId)?.join(data.groupId);
            }
            broadcastUsersList();
        }
    });

    socket.on('kick_member', (data) => {
        const group = db.groups[data.groupId];
        if (group && group.admins.includes(login) && group.members.includes(data.login)) {
            group.members = group.members.filter(m => m !== data.login);
            group.admins = group.admins.filter(a => a !== data.login);
            broadcastUsersList();
            io.to(data.groupId).emit('user_kicked', { login: data.login, groupId: data.groupId });
        }
    });

    socket.on('make_admin', (data) => {
        const group = db.groups[data.groupId];
        if (group && group.admins.includes(login) && !group.admins.includes(data.login)) {
            group.admins.push(data.login);
            broadcastUsersList();
        }
    });

    // ===== ОПРОСЫ =====
    socket.on('create_poll', (data) => {
        const pollId = 'poll_' + Date.now();
        db.polls[pollId] = {
            id: pollId,
            groupId: data.groupId,
            question: data.question,
            options: data.options.map(text => ({ text, votes: [] })),
            createdBy: username,
            createdAt: new Date().toISOString()
        };
        io.to(data.groupId).emit('new_poll', db.polls[pollId]);
        console.log(`📊 Опрос создан в группе ${data.groupId}`);
    });

    socket.on('vote_poll', (data) => {
        const poll = db.polls[data.pollId];
        if (poll && poll.options[data.optionIndex]) {
            // Удаляем предыдущий голос этого пользователя
            poll.options.forEach(opt => {
                opt.votes = opt.votes.filter(v => v !== login);
            });
            poll.options[data.optionIndex].votes.push(login);
            io.to(poll.groupId).emit('poll_updated', poll);
        }
    });

    // ===== WEBRTC ЗВОНКИ =====
    socket.on('call_user', (data) => {
        const callerInfo = getPublicUser(login);
        console.log(`📞 ${username} звонит пользователю ${data.userToCall}`);
        io.to(data.userToCall).emit('incoming_call', {
            signal: data.signalData,
            from: login,
            caller: callerInfo,
            isGroup: false,
            audioOnly: data.audioOnly || false
        });
    });

    socket.on('accept_call', (data) => {
        console.log(`✅ Звонок принят: ${data.to}`);
        io.to(data.to).emit('call_accepted', { signal: data.signal, from: login });
    });

    socket.on('end_call', (to) => {
        console.log(`🔴 Звонок завершён: ${to}`);
        io.to(to).emit('call_ended');
    });

    // Групповой звонок
    socket.on('start_group_call', (groupId) => {
        if (!groupCalls[groupId]) groupCalls[groupId] = new Set();
        groupCalls[groupId].add(socket.id);
        socket.to(groupId).emit('group_call_started', { groupId, from: login });
        console.log(`👥 Групповой звонок начат в ${groupId}`);
    });

    socket.on('join_group_call', (data) => {
        if (groupCalls[data.groupId]) {
            groupCalls[data.groupId].add(socket.id);
            socket.to(data.groupId).emit('new_peer', { peerId: socket.id, from: login });
            console.log(`👥 ${username} присоединился к групповому звонку`);
        }
    });

    socket.on('group_call_signal', (data) => {
        io.to(data.to).emit('group_call_signal', {
            signal: data.signal,
            from: socket.id,
            login: login
        });
    });

    socket.on('leave_group_call', (data) => {
        if (groupCalls[data.groupId]) {
            groupCalls[data.groupId].delete(socket.id);
            io.to(data.groupId).emit('peer_left', { peerId: socket.id, from: login });
            console.log(`👋 ${username} покинул групповой звонок`);
        }
    });

    // ICE кандидаты
    socket.on('ice_candidate', (data) => {
        io.to(data.to).emit('ice_candidate', { candidate: data.candidate, from: login });
    });

    // ===== ОТКЛЮЧЕНИЕ =====
    socket.on('disconnect', () => {
        db.lastSeen[login] = Date.now();
        onlineUsers.delete(socket.id);
        
        // Выход из групповых звонков
        Object.keys(groupCalls).forEach(groupId => {
            if (groupCalls[groupId]?.has(socket.id)) {
                groupCalls[groupId].delete(socket.id);
                io.to(groupId).emit('peer_left', { peerId: socket.id, from: login });
            }
        });
        
        console.log(`🔴 ${username} отключился (онлайн: ${new Set(onlineUsers.values()).size})`);
        broadcastUsersList();
    });
});

// ========== ЗАПУСК СЕРВЕРА ==========
server.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════╗');
    console.log('║     🐱 Catogram Server      ║');
    console.log(`║     Порт: ${PORT}               ║`);
    console.log('║     Мяу-мяу! 🐾             ║');
    console.log('╚══════════════════════════════╝');
});