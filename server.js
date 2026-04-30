const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройки
const PORT = process.env.PORT || 3000;
const sessionMiddleware = session({
    secret: 'catogram-secret-key-super-safe-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 дней
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(express.static(__dirname));

// In-memory хранилище
const db = {
    users: {},       // login: { login, username, passwordHash, avatar, bio, phone }
    usernames: {},   // username (нижний регистр): login (для проверки уникальности)
    groups: {},      // groupId: { id, name, members: [logins], avatar }
    messages: []     // { from, to (login or groupId or 'global'), text, time, type }
};

// Хэширование
const hashPassword = (password) => crypto.createHash('sha256').update(password).digest('hex');

// Вспомогательная функция для получения публичных данных пользователя
const getPublicUser = (login) => {
    const u = db.users[login];
    if (!u) return null;
    return {
        login: u.login,
        username: u.username,
        avatar: u.avatar,
        bio: u.bio,
        phone: u.phone
    };
};

// Маршруты API
app.post('/api/register', (req, res) => {
    const { login, username, password } = req.body;
    
    // Валидация
    if (!login || !username || password.length < 4) {
        return res.status(400).json({ error: 'Логин, @username и пароль (мин. 4 символа) обязательны' });
    }
    
    const cleanLogin = login.trim().toLowerCase();
    const cleanUsername = username.trim().replace(/^@/, ''); // Убираем @ если вставили
    
    if (db.users[cleanLogin]) return res.status(400).json({ error: 'Этот логин уже занят' });
    if (db.usernames[cleanUsername.toLowerCase()]) return res.status(400).json({ error: `@${cleanUsername} уже занят` });
    
    // Создаем пользователя
    const newUser = {
        login: cleanLogin,
        username: cleanUsername,
        passwordHash: hashPassword(password),
        avatar: '', // Пустая строка, на фронте сгенерируем инициалы
        bio: '',
        phone: ''
    };
    
    db.users[cleanLogin] = newUser;
    db.usernames[cleanUsername.toLowerCase()] = cleanLogin;
    
    req.session.user = { login: cleanLogin, username: cleanUsername };
    res.json({ success: true, user: getPublicUser(cleanLogin) });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    const cleanLogin = login.trim().toLowerCase();
    const user = db.users[cleanLogin];
    
    if (user && user.passwordHash === hashPassword(password)) {
        req.session.user = { login: user.login, username: user.username };
        res.json({ success: true, user: getPublicUser(cleanLogin) });
    } else {
        res.status(400).json({ error: 'Неверный логин или пароль' });
    }
});

app.get('/api/me', (req, res) => {
    if (req.session.user && db.users[req.session.user.login]) {
        res.json({ success: true, user: getPublicUser(req.session.user.login) });
    } else {
        res.status(401).json({ error: 'Не авторизован' });
    }
});

app.post('/api/settings', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
    
    const { login, username, avatar, bio, phone } = req.body;
    const oldLogin = req.session.user.login;
    const user = db.users[oldLogin];
    
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    
    // Проверка на смену логина
    if (login && login !== oldLogin) {
        const newLogin = login.trim().toLowerCase();
        if (db.users[newLogin]) return res.status(400).json({ error: 'Логин занят' });
        
        // Обновляем ключ в объекте users
        user.login = newLogin;
        db.users[newLogin] = user;
        delete db.users[oldLogin];
        
        // Обновляем связь username -> login
        if (db.usernames[user.username.toLowerCase()] === oldLogin) {
            db.usernames[user.username.toLowerCase()] = newLogin;
        }
        req.session.user.login = newLogin;
    }
    
    // Проверка на смену username
    if (username && username !== user.username) {
        const cleanUsername = username.trim().replace(/^@/, '');
        if (db.usernames[cleanUsername.toLowerCase()] && db.usernames[cleanUsername.toLowerCase()] !== user.login) {
            return res.status(400).json({ error: `@${cleanUsername} уже занят` });
        }
        
        // Освобождаем старый username
        delete db.usernames[user.username.toLowerCase()];
        // Занимаем новый
        db.usernames[cleanUsername.toLowerCase()] = user.login;
        user.username = cleanUsername;
        req.session.user.username = cleanUsername;
    }
    
    if (avatar !== undefined) user.avatar = avatar;
    if (bio !== undefined) user.bio = bio;
    if (phone !== undefined) user.phone = phone;
    
    res.json({ success: true, user: getPublicUser(user.login) });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Проверка доступности username (для фронта)
app.get('/api/check-username', (req, res) => {
    const username = req.query.username?.trim().toLowerCase();
    if (!username) return res.status(400).json({ error: 'Username required' });
    const isTaken = !!db.usernames[username];
    res.json({ available: !isTaken });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Интеграция сессий в Socket.io
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

const onlineUsers = new Map(); // socket.id -> login

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.user || !db.users[session.user.login]) {
        socket.disconnect();
        return;
    }

    const login = session.user.login;
    onlineUsers.set(socket.id, login);
    socket.join(login); // Комната для ЛС и звонков
    
    // Подключаем к группам, в которых состоит пользователь
    Object.values(db.groups).forEach(g => {
        if (g.members.includes(login)) socket.join(g.id);
    });

    // Функция рассылки обновленного списка всем
    const broadcastOnline = () => {
        const onlineLogins = Array.from(new Set(onlineUsers.values()));
        const publicUsers = Object.values(db.users).map(u => ({
            login: u.login,
            username: u.username,
            avatar: u.avatar,
            bio: u.bio,
            isOnline: onlineLogins.includes(u.login)
        }));
        
        // Отправляем ВСЕХ пользователей и группы, где состоит текущий юзер, ему самому
        socket.emit('users_list', {
            users: publicUsers,
            groups: Object.values(db.groups).filter(g => g.members.includes(login))
        });
        
        // ВСЕМ отправляем обновленный статус онлайна (без групп, только список id онлайн)
        io.emit('online_update', { onlineLogins });
    };

    broadcastOnline();
    io.emit('online_update', { onlineLogins: Array.from(new Set(onlineUsers.values())) }); // Отправим всем начальный статус
    
    // Отправка истории сообщений
    socket.emit('history', db.messages.filter(m => 
        m.to === 'global' || 
        m.to === login || 
        m.from === login || 
        (db.groups[m.to] && db.groups[m.to].members.includes(login))
    ));

    // Обработка сообщений
    socket.on('send_message', (data) => {
        const msg = {
            from: login,
            to: data.to,
            text: data.text,
            time: new Date().toISOString(),
            type: data.type || 'text' // text, image, file и т.д.
        };
        db.messages.push(msg);
        
        if (data.to === 'global') {
            io.emit('new_message', msg);
        } else if (db.groups[data.to]) {
            io.to(data.to).emit('new_message', msg);
        } else {
            // ЛС
            io.to(data.to).emit('new_message', msg); // Получателю
            socket.emit('new_message', msg); // Себе, для отображения в своем окне
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
        
        // Подключаем всех онлайн-участников к комнате группы
        for (let [sId, sLogin] of onlineUsers.entries()) {
            if (db.groups[groupId].members.includes(sLogin)) {
                io.sockets.sockets.get(sId)?.join(groupId);
            }
        }
        // Обновляем список групп у всех
        broadcastOnline();
    });

    // Индикатор "печатает..."
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

    // --- WebRTC Сигнализация ---
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

    // Отключение
    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('online_update', { onlineLogins: Array.from(new Set(onlineUsers.values())) });
    });
});

server.listen(PORT, () => {
    console.log(`🐱 Catogram сервер запущен на порту ${PORT}`);
});