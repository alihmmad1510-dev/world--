import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20000,
  pingInterval: 10000,
  transports: ['websocket', 'polling']
});

app.use(cors());

/* ============================================================
   إيجاد ملف index.html في كل الأماكن المحتملة
   ============================================================ */
const possiblePaths = [
  path.join(__dirname, 'index.html'),
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'dist', 'index.html'),
  path.join(process.cwd(), 'index.html'),
  path.join(process.cwd(), 'public', 'index.html')
];

let INDEX_FILE = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    INDEX_FILE = p;
    console.log(`✅ Found index.html at: ${p}`);
    break;
  }
}

if (!INDEX_FILE) {
  console.log('❌ index.html NOT FOUND!');
  console.log('📁 __dirname:', __dirname);
  console.log('📁 cwd:', process.cwd());
  try {
    console.log('📂 Files in __dirname:', fs.readdirSync(__dirname));
  } catch(e) {}
}

/* ============================================================
   خدمة الملفات الثابتة
   ============================================================ */
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(process.cwd()));

/* ============================================================
   صفحة رئيسية — تخدم index.html من أي مكان
   ============================================================ */
app.get('/', (req, res) => {
  if (INDEX_FILE && fs.existsSync(INDEX_FILE)) {
    res.sendFile(INDEX_FILE);
  } else {
    res.status(404).send(`
      <!DOCTYPE html>
      <html dir="rtl"><head><meta charset="UTF-8">
      <title>خطأ — index.html غير موجود</title>
      <style>
        body { font-family: Arial; background:#111; color:#fff; padding:40px; text-align:center; }
        h1 { color: #ff6666; }
        code { background:#222; padding:4px 8px; border-radius:4px; color:#ffcc00; }
        ul { text-align:right; max-width:600px; margin:20px auto; line-height:2; }
      </style></head><body>
        <h1>⚠️ index.html غير موجود</h1>
        <p>السيرفر شغال، لكن ما لقاش ملف <code>index.html</code></p>
        <p><b>تأكد إن الملفات في نفس المجلد على GitHub:</b></p>
        <ul>
          <li><code>index.html</code> ← في الجذر مباشرة</li>
          <li><code>server.js</code></li>
          <li><code>package.json</code></li>
        </ul>
        <p>المجلد الحالي: <code>${__dirname}</code></p>
      </body></html>
    `);
  }
});

/* ============================================================
   Health check
   ============================================================ */
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    indexFound: !!INDEX_FILE,
    indexPath: INDEX_FILE,
    rooms: rooms.size,
    totalPlayers: [...rooms.values()].reduce((s, r) => s + r.players.size, 0),
    uptime: Math.floor(process.uptime())
  });
});

/* ============================================================
   إدارة الغرف
   ============================================================ */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

const rooms = new Map();

io.on('connection', (socket) => {
  console.log('[+] Connected:', socket.id);
  let currentRoom = null;

  socket.on('createRoom', (data, cb) => {
    try {
      let code, attempts = 0;
      do { code = genCode(); attempts++; } while (rooms.has(code) && attempts < 30);

      rooms.set(code, {
        hostId: socket.id,
        createdAt: Date.now(),
        players: new Map()
      });

      socket.join(code);
      currentRoom = code;

      const reply = { ok: true, code };
      if (typeof cb === 'function') cb(reply);
      socket.emit('roomCreated', reply);
      console.log(`[ROOM] ${socket.id} created ${code}`);
    } catch (e) {
      if (typeof cb === 'function') cb({ ok: false, error: e.message });
    }
  });

  socket.on('joinRoom', ({ code, playerInfo } = {}, cb) => {
    try {
      code = (code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        const reply = { ok: false, error: 'ROOM_NOT_FOUND' };
        if (typeof cb === 'function') cb(reply);
        socket.emit('joinError', reply);
        return;
      }
      if (room.players.size >= 16) {
        const reply = { ok: false, error: 'ROOM_FULL' };
        if (typeof cb === 'function') cb(reply);
        socket.emit('joinError', reply);
        return;
      }

      room.players.set(socket.id, {
        id: socket.id,
        shirt: playerInfo?.shirt ?? 0x1f6fd0,
        pants: playerInfo?.pants ?? 0x23252b,
        x: 0, y: 0, z: 0, rot: 0,
        inCar: false,
        cx: 0, cy: 0, cz: 0, crot: 0,
        lastSeen: Date.now()
      });

      socket.join(code);
      currentRoom = code;

      const existing = [];
      room.players.forEach((p, id) => { if (id !== socket.id) existing.push(p); });

      const reply = { ok: true, code, players: existing, you: socket.id };
      if (typeof cb === 'function') cb(reply);
      socket.emit('roomJoined', reply);
      socket.to(code).emit('playerJoined', room.players.get(socket.id));
      console.log(`[ROOM] ${socket.id} joined ${code} (${room.players.size})`);
    } catch (e) {
      if (typeof cb === 'function') cb({ ok: false, error: e.message });
    }
  });

  socket.on('playerState', (state) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    Object.assign(p, {
      x: state.x, y: state.y, z: state.z, rot: state.rot,
      inCar: !!state.inCar,
      cx: state.cx, cy: state.cy, cz: state.cz, crot: state.crot,
      shirt: state.shirt, pants: state.pants,
      lastSeen: Date.now()
    });

    socket.to(currentRoom).emit('playerState', {
      id: socket.id,
      x: p.x, y: p.y, z: p.z, rot: p.rot,
      inCar: p.inCar,
      cx: p.cx, cy: p.cy, cz: p.cz, crot: p.crot,
      shirt: p.shirt, pants: p.pants
    });
  });

  socket.on('leaveRoom', () => leaveRoom());

  function leaveRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.players.delete(socket.id);
      socket.to(currentRoom).emit('playerLeft', { id: socket.id });
      if (room.players.size === 0) {
        rooms.delete(currentRoom);
        console.log(`[ROOM] ${currentRoom} deleted`);
      } else if (room.hostId === socket.id) {
        const firstId = room.players.keys().next().value;
        room.hostId = firstId;
        io.to(currentRoom).emit('hostChanged', { hostId: firstId });
      }
    }
    socket.leave(currentRoom);
    currentRoom = null;
  }

  socket.on('disconnect', () => {
    console.log('[-] Disconnected:', socket.id);
    leaveRoom();
  });
});

/* تنظيف الغرف الميتة */
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.size === 0) { rooms.delete(code); return; }
    room.players.forEach((p, id) => {
      if (now - p.lastSeen > 60000) {
        room.players.delete(id);
        io.to(code).emit('playerLeft', { id });
      }
    });
  });
}, 30000);

/* ============================================================
   تشغيل السيرفر
   ============================================================ */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚗 GTA 6 City running on port ${PORT}`);
  console.log(`   __dirname: ${__dirname}`);
  console.log(`   index.html: ${INDEX_FILE || 'NOT FOUND'}\n`);
});