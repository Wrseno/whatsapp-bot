const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const express = require("express");
const QRCode = require("qrcode");
const axios = require("axios");
const pino = require("pino");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const LARAVEL_URL = process.env.LARAVEL_URL || "http://localhost:8000";

// Store active bot sessions
const activeSessions = new Map();

const logger = pino({level: "info"});

// Create WhatsApp bot session
async function createBotSession(sessionId) {
  try {
    const {state, saveCreds} = await useMultiFileAuthState(
      `./sessions/${sessionId}`
    );
    const {version} = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({level: "silent"}),
      auth: state,
    });

    sock.ev.on("connection.update", async (update) => {
      const {connection, lastDisconnect, qr} = update;

      if (qr) {
        const qrCode = await QRCode.toDataURL(qr);
        await sendWebhook("/api/webhook/wa/qr-update", {
          sessionId,
          qrCode,
        });
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;

        await sendWebhook("/api/webhook/wa/connection-update", {
          sessionId,
          status: "disconnected",
          phoneInfo: null,
        });

        if (shouldReconnect) {
          logger.info(`Reconnecting session ${sessionId}...`);
          setTimeout(() => createBotSession(sessionId), 3000);
        } else {
          activeSessions.delete(sessionId);
        }
      } else if (connection === "open") {
        logger.info(`Session ${sessionId} connected successfully`);

        const phoneInfo = {
          jid: sock.user.id,
          name: sock.user.name,
          phone: sock.user.id.split(":")[0],
        };

        await sendWebhook("/api/webhook/wa/connection-update", {
          sessionId,
          status: "connected",
          phoneInfo,
        });

        startHeartbeat(sessionId);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
      const msg = m.messages[0];
      if (!msg.key.fromMe && msg.message) {
        await forwardToLaravel(sock, msg, sessionId);
      }
    });

    activeSessions.set(sessionId, sock);
    return sock;
  } catch (error) {
    logger.error(`Error creating session ${sessionId}:`, error);
    await sendWebhook("/api/webhook/wa/connection-update", {
      sessionId,
      status: "disconnected",
      phoneInfo: null,
    });
  }
}

async function forwardToLaravel(sock, msg, sessionId) {
  try {
    const sender = msg.key.remoteJid;
    const messageText =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

    const response = await axios.post(
      `${LARAVEL_URL}/api/webhook/wa/incoming-message`,
      {
        sessionId,
        from: sender,
        text: messageText,
      }
    );

    logger.info(`Forwarded message from ${sender}: ${messageText}`);

    const reply = response.data?.reply;
    if (reply) {
      await sock.sendMessage(sender, {text: reply});
    }
  } catch (error) {
    logger.error("Failed to get reply from Laravel:", error.message);
  }
}

function startHeartbeat(sessionId) {
  const interval = setInterval(async () => {
    if (!activeSessions.has(sessionId)) {
      clearInterval(interval);
      return;
    }

    try {
      await sendWebhook("/api/webhook/wa/heartbeat", {sessionId});
    } catch (error) {
      logger.error(`Heartbeat failed for ${sessionId}:`, error);
    }
  }, 30000); // every 30 seconds
}

async function sendWebhook(endpoint, data) {
  try {
    await axios.post(`${LARAVEL_URL}${endpoint}`, data, {
      timeout: 5000,
    });
  } catch (error) {
    logger.error(`Webhook failed ${endpoint}:`, error.message);
  }
}

// Restore sessions from disk
async function restoreSessions() {
  const sessionDir = path.resolve(__dirname, "sessions");
  if (!fs.existsSync(sessionDir)) return;

  const sessions = fs
    .readdirSync(sessionDir, {withFileTypes: true})
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  for (const sessionId of sessions) {
    logger.info(`Restoring session: ${sessionId}`);
    await createBotSession(sessionId);
  }
}

// API endpoints
app.post("/bot/create", async (req, res) => {
  const {sessionId} = req.body;

  if (!sessionId) {
    return res.status(400).json({error: "Session ID required"});
  }

  if (activeSessions.has(sessionId)) {
    return res.status(400).json({error: "Session already exists"});
  }

  logger.info(`Creating bot session: ${sessionId}`);
  await createBotSession(sessionId);

  res.json({message: "Bot session creation initiated", sessionId});
});

app.post("/bot/destroy", async (req, res) => {
  const {sessionId} = req.body;

  if (!sessionId) {
    return res.status(400).json({error: "Session ID required"});
  }

  const sock = activeSessions.get(sessionId);
  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      logger.error(`Error logging out session ${sessionId}:`, error);
    }
    activeSessions.delete(sessionId);
  }

  try {
    await fsp.rm(`./sessions/${sessionId}`, {recursive: true, force: true});
  } catch (error) {
    logger.error(`Error cleaning session files ${sessionId}:`, error);
  }

  logger.info(`Bot session destroyed: ${sessionId}`);
  res.json({message: "Bot session destroyed", sessionId});
});

app.get("/bot/sessions", (req, res) => {
  const sessions = Array.from(activeSessions.keys());
  res.json({sessions, count: sessions.length});
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`WhatsApp Bot Service running on port ${PORT}`);

  if (!fs.existsSync("./sessions")) {
    fs.mkdirSync("./sessions");
  }

  restoreSessions(); // 🔁 Restore sessions on startup
});
