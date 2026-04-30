const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Session middleware
const sessionMiddleware = session({
  secret: 'catogram-secret-key-meow-meow-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// In-memory storage
const users = {}; // { login: { passwordHash, createdAt } }
const chats = {
  general: {
    id: 'general',
    type: 'general',
    name: 'Общий чат',
    participants: [],
    messages: [],
  },
};
const groups = {}; // { groupId: { id, type: 'group', name, creator, participants: [], messages: [] } }
const onlineUsers = {}; // { login: { socketId, typingIn: null } }
const socketToUser = {}; // { socketId: login }

// Active calls: { callId: { caller, callee, offer, answer, iceCandidates } }
const activeCalls = {};

// Helper functions
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'cat-salt').digest('hex');
}

function generateGroupId() {
  return 'group_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

// Routes
app.post('/api/register', (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  if (login.length < 4 || password.length < 4) {
    return res.status(400).json({ error: 'Логин и пароль минимум 4 символа' });
  }

  if (users[login]) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }

  users[login] = {
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  };

  // Add user to general chat
  if (!chats.general.participants.includes(login)) {
    chats.general.participants.push(login);
  }

  req.session.user = login;
  req.session.save();

  return res.json({
    success: true,
    user: login,
    message: 'Регистрация успешна! Мяу! 🐱',
  });
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  const user = users[login];
  if (!user) {
    return res.status(400).json({ error: 'Пользователь не найден' });
  }

  if (user.passwordHash !== hashPassword(password)) {
    return res.status(400).json({ error: 'Неверный пароль' });
  }

  // Add user to general chat if not already
  if (!chats.general.participants.includes(login)) {
    chats.general.participants.push(login);
  }

  req.session.user = login;
  req.session.save();

  return res.json({
    success: true,
    user: login,
    message: 'Вход выполнен! Мяу! 🐱',
  });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user });
  }
  return res.status(401).json({ error: 'Not authenticated' });
});

app.post('/api/logout', (req, res) => {
  const user = req.session.user;
  req.session.destroy();
  if (user && onlineUsers[user]) {
    delete onlineUsers[user];
  }
  return res.json({ success: true });
});

app.get('/api/users', isAuthenticated, (req, res) => {
  const allUsers = Object.keys(users).map((login) => ({
    login,
    online: !!onlineUsers[login],
  }));
  return res.json({ users: allUsers });
});

app.get('/api/chats', isAuthenticated, (req, res) => {
  const currentUser = req.session.user;
  const chatList = [];

  // General chat
  if (chats.general.participants.includes(currentUser)) {
    chatList.push({
      id: chats.general.id,
      type: 'general',
      name: 'Общий чат 🐱',
      participants: chats.general.participants,
      lastMessage: chats.general.messages.length > 0 ? chats.general.messages[chats.general.messages.length - 1] : null,
    });
  }

  // Groups
  for (const groupId in groups) {
    const group = groups[groupId];
    if (group.participants.includes(currentUser)) {
      chatList.push({
        id: group.id,
        type: 'group',
        name: group.name,
        participants: group.participants,
        creator: group.creator,
        lastMessage: group.messages.length > 0 ? group.messages[group.messages.length - 1] : null,
      });
    }
  }

  // Private chats - one for each user
  const allUsersList = Object.keys(users).filter((u) => u !== currentUser);
  for (const otherUser of allUsersList) {
    const privateChatId = [currentUser, otherUser].sort().join('_private_');
    chatList.push({
      id: privateChatId,
      type: 'private',
      name: otherUser,
      participants: [currentUser, otherUser],
      online: !!onlineUsers[otherUser],
    });
  }

  return res.json({ chats: chatList });
});

app.post('/api/groups', isAuthenticated, (req, res) => {
  const { name, participants } = req.body;
  const creator = req.session.user;

  if (!name || !participants || !Array.isArray(participants)) {
    return res.status(400).json({ error: 'Название группы и список участников обязателен' });
  }

  const allParticipants = [...new Set([creator, ...participants])];

  // Validate all participants exist
  for (const p of allParticipants) {
    if (!users[p]) {
      return res.status(400).json({ error: `Пользователь ${p} не найден` });
    }
  }

  const groupId = generateGroupId();
  groups[groupId] = {
    id: groupId,
    type: 'group',
    name: name,
    creator: creator,
    participants: allParticipants,
    messages: [],
  };

  // Notify all participants
  for (const p of allParticipants) {
    if (onlineUsers[p]) {
      io.to(onlineUsers[p].socketId).emit('newGroup', groups[groupId]);
    }
  }

  return res.json({ success: true, group: groups[groupId] });
});

app.get('/api/messages/:chatId', isAuthenticated, (req, res) => {
  const { chatId } = req.params;
  const currentUser = req.session.user;

  if (chatId === 'general') {
    if (!chats.general.participants.includes(currentUser)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    return res.json({ messages: chats.general.messages });
  }

  // Check private chat
  if (chatId.includes('_private_')) {
    const [user1, user2] = chatId.split('_private_');
    if (user1 !== currentUser && user2 !== currentUser) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // Private messages are stored via socket, so return empty array
    // Actually we need to store private messages too
    // Let's use a messages map
    if (!privateMessages[chatId]) {
      privateMessages[chatId] = [];
    }
    return res.json({ messages: privateMessages[chatId] });
  }

  // Check group
  if (groups[chatId]) {
    if (!groups[chatId].participants.includes(currentUser)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    return res.json({ messages: groups[chatId].messages });
  }

  return res.status(404).json({ error: 'Chat not found' });
});

// Store for private messages
const privateMessages = {};

// Socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.on('connection', (socket) => {
  const session = socket.request.session;

  if (!session || !session.user) {
    socket.disconnect(true);
    return;
  }

  const userLogin = session.user;
  socketToUser[socket.id] = userLogin;

  // User comes online
  onlineUsers[userLogin] = { socketId: socket.id, typingIn: null };

  // Add to general chat
  if (!chats.general.participants.includes(userLogin)) {
    chats.general.participants.push(userLogin);
  }

  console.log(`🐱 ${userLogin} подключился`);

  // Broadcast online status
  io.emit('userOnline', { login: userLogin, online: true });
  io.emit('onlineUsers', Object.keys(onlineUsers));

  // Send current state to the connected user
  socket.emit('connected', { user: userLogin });
  socket.emit('onlineUsers', Object.keys(onlineUsers));

  // Send general chat messages
  socket.emit('chatHistory', { chatId: 'general', messages: chats.general.messages });

  // Handle join chat
  socket.on('joinChat', (chatId) => {
    if (chatId === 'general') {
      socket.emit('chatHistory', { chatId: 'general', messages: chats.general.messages });
    } else if (chatId.includes('_private_')) {
      if (!privateMessages[chatId]) {
        privateMessages[chatId] = [];
      }
      socket.emit('chatHistory', { chatId, messages: privateMessages[chatId] });
    } else if (groups[chatId]) {
      socket.emit('chatHistory', { chatId, messages: groups[chatId].messages });
    }
  });

  // Handle sending message
  socket.on('sendMessage', (data) => {
    const { chatId, message } = data;
    const currentUser = userLogin;

    const messageObj = {
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
      sender: currentUser,
      text: message,
      timestamp: Date.now(),
    };

    if (chatId === 'general') {
      chats.general.messages.push(messageObj);
      // Keep only last 200 messages
      if (chats.general.messages.length > 200) {
        chats.general.messages = chats.general.messages.slice(-200);
      }
      io.emit('newMessage', { chatId: 'general', message: messageObj });
    } else if (chatId.includes('_private_')) {
      if (!privateMessages[chatId]) {
        privateMessages[chatId] = [];
      }
      privateMessages[chatId].push(messageObj);
      if (privateMessages[chatId].length > 200) {
        privateMessages[chatId] = privateMessages[chatId].slice(-200);
      }

      // Send to both participants
      const [user1, user2] = chatId.split('_private_');
      for (const [socketId, login] of Object.entries(socketToUser)) {
        if (login === user1 || login === user2) {
          io.to(socketId).emit('newMessage', { chatId, message: messageObj });
        }
      }
    } else if (groups[chatId]) {
      groups[chatId].messages.push(messageObj);
      if (groups[chatId].messages.length > 200) {
        groups[chatId].messages = groups[chatId].messages.slice(-200);
      }

      // Send to all group participants
      for (const participant of groups[chatId].participants) {
        if (onlineUsers[participant]) {
          io.to(onlineUsers[participant].socketId).emit('newMessage', { chatId, message: messageObj });
        }
      }
    }

    // Clear typing status
    if (onlineUsers[currentUser]) {
      onlineUsers[currentUser].typingIn = null;
    }
  });

  // Handle typing
  socket.on('typing', (data) => {
    const { chatId } = data;
    const currentUser = userLogin;

    if (onlineUsers[currentUser]) {
      onlineUsers[currentUser].typingIn = chatId;
    }

    if (chatId === 'general') {
      socket.broadcast.emit('userTyping', { chatId, user: currentUser });
    } else if (chatId.includes('_private_')) {
      const [user1, user2] = chatId.split('_private_');
      const targetUser = user1 === currentUser ? user2 : user1;
      if (onlineUsers[targetUser]) {
        io.to(onlineUsers[targetUser].socketId).emit('userTyping', { chatId, user: currentUser });
      }
    } else if (groups[chatId]) {
      for (const participant of groups[chatId].participants) {
        if (participant !== currentUser && onlineUsers[participant]) {
          io.to(onlineUsers[participant].socketId).emit('userTyping', { chatId, user: currentUser });
        }
      }
    }
  });

  socket.on('stopTyping', (data) => {
    const { chatId } = data;
    const currentUser = userLogin;

    if (onlineUsers[currentUser]) {
      onlineUsers[currentUser].typingIn = null;
    }

    if (chatId === 'general') {
      socket.broadcast.emit('userStopTyping', { chatId, user: currentUser });
    } else if (chatId.includes('_private_')) {
      const [user1, user2] = chatId.split('_private_');
      const targetUser = user1 === currentUser ? user2 : user1;
      if (onlineUsers[targetUser]) {
        io.to(onlineUsers[targetUser].socketId).emit('userStopTyping', { chatId, user: currentUser });
      }
    } else if (groups[chatId]) {
      for (const participant of groups[chatId].participants) {
        if (participant !== currentUser && onlineUsers[participant]) {
          io.to(onlineUsers[participant].socketId).emit('userStopTyping', { chatId, user: currentUser });
        }
      }
    }
  });

  // WebRTC Signaling
  socket.on('callOffer', (data) => {
    const { targetUser, offer } = data;
    const caller = userLogin;

    const callId = [caller, targetUser].sort().join('_call_');
    activeCalls[callId] = {
      caller,
      callee: targetUser,
      offer,
      answer: null,
    };

    if (onlineUsers[targetUser]) {
      io.to(onlineUsers[targetUser].socketId).emit('incomingCall', {
        callId,
        caller,
        offer,
      });
    }
  });

  socket.on('callAnswer', (data) => {
    const { callId, answer } = data;

    if (activeCalls[callId]) {
      activeCalls[callId].answer = answer;

      const caller = activeCalls[callId].caller;
      if (onlineUsers[caller]) {
        io.to(onlineUsers[caller].socketId).emit('callAnswered', {
          callId,
          answer,
        });
      }
    }
  });

  socket.on('iceCandidate', (data) => {
    const { callId, candidate, targetUser } = data;

    if (onlineUsers[targetUser]) {
      io.to(onlineUsers[targetUser].socketId).emit('iceCandidate', {
        callId,
        candidate,
        from: userLogin,
      });
    }
  });

  socket.on('callRejected', (data) => {
    const { callId } = data;

    if (activeCalls[callId]) {
      const targetUser =
        activeCalls[callId].caller === userLogin
          ? activeCalls[callId].callee
          : activeCalls[callId].caller;

      if (onlineUsers[targetUser]) {
        io.to(onlineUsers[targetUser].socketId).emit('callRejected', { callId });
      }

      delete activeCalls[callId];
    }
  });

  socket.on('callEnded', (data) => {
    const { callId } = data;

    if (activeCalls[callId]) {
      const targetUser =
        activeCalls[callId].caller === userLogin
          ? activeCalls[callId].callee
          : activeCalls[callId].caller;

      if (onlineUsers[targetUser]) {
        io.to(onlineUsers[targetUser].socketId).emit('callEnded', { callId });
      }

      delete activeCalls[callId];
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const login = socketToUser[socket.id];
    if (login) {
      delete socketToUser[socket.id];

      // Check if user has other sockets
      let stillOnline = false;
      for (const [sid, ulogin] of Object.entries(socketToUser)) {
        if (ulogin === login) {
          stillOnline = true;
          break;
        }
      }

      if (!stillOnline) {
        delete onlineUsers[login];
        io.emit('userOnline', { login, online: false });
        io.emit('onlineUsers', Object.keys(onlineUsers));
        console.log(`🐱 ${login} отключился`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🐱 Catogram сервер запущен на порту ${PORT}`);
  console.log(`📱 Откройте http://localhost:${PORT}`);
});