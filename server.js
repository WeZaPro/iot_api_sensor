// ==============================
// Import modules
// ==============================
const fs = require("fs");
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser"); // หรือใช้ express.json() ก็ได้
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const TelegramBot = require("node-telegram-bot-api");

// ==============================
// Config
// ==============================
const PORT = 8080; // HTTP port
const JWT_SECRET = "SuperServerSecretKey123";

// ESP32 secret keys
const ESP32_KEYS = {
  esp32_1: "ESP32_1_SECRET",
  esp32_2: "ESP32_2_SECRET",
  esp32_dest_1: "ESP32_DEST_1_SECRET", // ปลายทาง
};

// ==============================
// MySQL connection
// ==============================
const pool = mysql.createPool({
  host: "localhost",
  user: "topon_Sensor",
  password: "Taweesak5050",
  database: "sensor_topon_",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ==============================
// Function ดึง bot config จาก DB
// ==============================
async function getBotConfig(botName) {
  const [rows] = await pool.query(
    "SELECT botToken, chatId FROM IOT WHERE botName = ?",
    [botName]
  );
  if (rows.length === 0) throw new Error("Bot not found in DB");
  return { botToken: rows[0].botToken, chatId: rows[0].chatId };
}

// ==============================
// Init Telegram bot
// ==============================
let bot;
let chatId;

(async () => {
  try {
    const config = await getBotConfig("MySensorBot"); // ชื่อ bot ใน DB
    bot = new TelegramBot(config.botToken, { polling: true });
    chatId = config.chatId;
    console.log("Telegram bot initialized:", config);
  } catch (err) {
    console.error("Failed to initialize Telegram bot:", err.message);
  }
})();

// ==============================
// Express app
// ==============================
const app = express();
app.use(bodyParser.json()); // หรือ app.use(express.json());

// ==============================
// HTTP Server
// ==============================
const server = http.createServer(app);

// ==============================
// POST /login → ESP32 request JWT
// ==============================
app.post("/login", (req, res) => {
  const { clientId, signature, timestamp } = req.body;

  if (!ESP32_KEYS[clientId]) {
    console.log("Unknown clientId:", clientId);
    return res.status(401).json({ ok: false, msg: "Unknown clientId" });
  }

  const payload = clientId + timestamp;
  const serverSig = crypto
    .createHmac("sha256", ESP32_KEYS[clientId])
    .update(payload)
    .digest("hex");

  if (serverSig !== signature) {
    console.log("Invalid signature from:", clientId);
    return res.status(401).json({ ok: false, msg: "Invalid signature" });
  }

  const token = jwt.sign({ clientId }, JWT_SECRET, { expiresIn: "1h" });
  console.log("JWT issued for:", clientId);
  res.json({ ok: true, token });
});

// ==============================
// WebSocket server
// ==============================
const clients = {};
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("New WS connection, waiting for JWT auth");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      // ---------- Auth phase ----------
      if (!ws.isAuthorized) {
        const { token } = data;
        if (!token) return ws.close();

        try {
          const payload = jwt.verify(token, JWT_SECRET);
          ws.isAuthorized = true;
          ws.clientId = payload.clientId;
          clients[ws.clientId] = ws;
          console.log("Authorized:", ws.clientId);
          ws.send(JSON.stringify({ ok: true, msg: "Auth success" }));
        } catch (e) {
          console.log("JWT verify failed:", e.message);
          ws.close();
        }
        return;
      }

      // ---------- Sensor phase ----------
      const { sensor, timestamp, signature, boardId, targetId } = data;
      const secretKey = ESP32_KEYS[ws.clientId];
      const payloadStr = sensor + timestamp;
      const serverSig = crypto
        .createHmac("sha256", secretKey)
        .update(payloadStr)
        .digest("hex");

      if (serverSig !== signature) {
        console.log("Invalid sensor signature from", ws.clientId);
        return;
      }

      const raw = Number(sensor);
      const volt = (raw / 4095) * 3.3;

      console.log(
        `Board: ${boardId} | ADC: ${raw} | Volt: ${volt.toFixed(
          3
        )}V | Timestamp: ${timestamp} | Target: ${targetId}`
      );

      // ส่ง Telegram ถ้ามี bot
      if (volt > 0 && bot) {
        const text = `📟 Sensor Alert\nBoard: ${boardId}\nADC: ${raw}\nVolt: ${volt.toFixed(
          3
        )}V\nTime: ${timestamp}`;
        await bot.sendMessage(chatId, text);
      }

      // Forward ไปยัง target ESP32 ถ้ามี
      if (targetId && clients[targetId]) {
        clients[targetId].send(
          JSON.stringify({
            from: boardId,
            sensor: raw,
            volt,
            timestamp,
          })
        );
      }
    } catch (e) {
      console.log("Invalid message:", msg);
    }
  });

  ws.on("close", () => {
    if (ws.clientId) {
      delete clients[ws.clientId];
      console.log("Client disconnected:", ws.clientId);
    }
  });
});

// ==============================
// API Endpoints
// ==============================

// เช็คสถานะเซิร์ฟเวอร์
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    msg: "Server is running",
    activeWSClients: Object.keys(clients).length,
    timestamp: new Date().toISOString(),
  });
});

// Default sensor config
app.get("/api/default", (req, res) => {
  res.json({
    ok: true,
    defaultVoltThreshold: 1.0,
    defaultBoardId: "esp32_1",
    message: "This is default API response",
  });
});

// GET sensor data ตัวอย่าง
app.get("/api/sensor", (req, res) => {
  const { boardId } = req.query;
  if (!boardId) {
    return res.status(400).json({ ok: false, msg: "Missing boardId" });
  }
  res.json({
    ok: true,
    boardId,
    lastVolt: Math.random() * 3.3, // ตัวอย่าง
    timestamp: new Date().toISOString(),
  });
});

// ==============================
// Start HTTP server
// ==============================
server.listen(PORT, () => {
  console.log(`HTTP server running at http://localhost:${PORT}`);
  console.log(`WebSocket ws://localhost:${PORT}`);
});
