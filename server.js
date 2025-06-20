import { createServer } from "http";
import { Server } from "socket.io";

const port = parseInt(process.env.PORT || "10000", 10);

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Random Voice Chat Server Running");
});

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: [
      "https://ww-five-rust.vercel.app",
      "https://anonymoluscall-1.onrender.com",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
  allowEIO3: true,
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

const connectedUsers = new Map();
const waitingQueue = new Set();
const activeConnections = new Map();
const userLastSeen = new Map();

setInterval(() => {
  const now = Date.now();
  const INACTIVE_THRESHOLD = 5 * 60 * 1000;

  for (const [userId, lastSeen] of userLastSeen.entries()) {
    if (now - lastSeen > INACTIVE_THRESHOLD) {
      console.log(`Cleaning up inactive user: ${userId}`);
      const socket = connectedUsers.get(userId);
      if (socket && socket.connected) {
        socket.disconnect(true);
      }
      cleanupUser(userId);
    }
  }
}, 60000);

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  const userId = generateUserId();
  socket.userId = userId;
  connectedUsers.set(userId, socket);
  userLastSeen.set(userId, Date.now());

  console.log(`User ${userId} connected. Total users: ${connectedUsers.size}`);

  io.emit("online-count", connectedUsers.size);

  socket.emit("connect-info", {
    userId,
    serverTime: new Date().toISOString(),
    onlineCount: connectedUsers.size,
  });

  socket.on("find-random", () => {
    console.log(`User ${userId} looking for random match`);
    userLastSeen.set(userId, Date.now());

    if (!socket.connected) {
      console.log(`User ${userId} disconnected before matching`);
      cleanupUser(userId);
      return;
    }

    if (activeConnections.has(userId)) {
      const partnerId = activeConnections.get(userId);
      endConnection(userId, partnerId);
    }

    waitingQueue.delete(userId);

    const availableUsers = Array.from(waitingQueue).filter(
      (id) =>
        id !== userId &&
        connectedUsers.has(id) &&
        !activeConnections.has(id) &&
        connectedUsers.get(id).connected
    );

    if (availableUsers.length > 0) {
      const partnerId =
        availableUsers[Math.floor(Math.random() * availableUsers.length)];
      const partnerSocket = connectedUsers.get(partnerId);

      if (partnerSocket && partnerSocket.connected) {
        // Add delay to ensure client readiness
        setTimeout(() => {
          if (
            socket.connected &&
            partnerSocket.connected &&
            !activeConnections.has(userId) &&
            !activeConnections.has(partnerId)
          ) {
            waitingQueue.delete(userId);
            waitingQueue.delete(partnerId);
            activeConnections.set(userId, partnerId);
            activeConnections.set(partnerId, userId);

            console.log(`Matched ${userId} with ${partnerId}`);

            socket.emit("match-found", { partnerId, initiator: true });
            partnerSocket.emit("match-found", {
              partnerId: userId,
              initiator: false,
            });
          } else {
            console.log(
              `Match aborted: one or both users (${userId}, ${partnerId}) not ready`
            );
            waitingQueue.add(userId);
            socket.emit("waiting-for-match");
          }
        }, 2000); // 2-second delay
      } else {
        if (partnerId) {
          cleanupUser(partnerId);
        }
        waitingQueue.add(userId);
        socket.emit("waiting-for-match");
      }
    } else {
      waitingQueue.add(userId);
      socket.emit("waiting-for-match");
      console.log(
        `User ${userId} added to waiting queue. Queue size: ${waitingQueue.size}`
      );
    }
  });

  socket.on("webrtc-offer", ({ offer }) => {
    userLastSeen.set(userId, Date.now());
    const partnerId = activeConnections.get(userId);

    if (partnerId && connectedUsers.has(partnerId)) {
      const partnerSocket = connectedUsers.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit("webrtc-offer", { from: userId, offer });
      } else {
        endConnection(userId, partnerId);
      }
    }
  });

  socket.on("webrtc-answer", ({ answer }) => {
    userLastSeen.set(userId, Date.now());
    const partnerId = activeConnections.get(userId);

    if (partnerId && connectedUsers.has(partnerId)) {
      const partnerSocket = connectedUsers.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit("webrtc-answer", { from: userId, answer });
      } else {
        endConnection(userId, partnerId);
      }
    }
  });

  socket.on("ice-candidate", ({ candidate }) => {
    userLastSeen.set(userId, Date.now());
    const partnerId = activeConnections.get(userId);

    if (partnerId && connectedUsers.has(partnerId)) {
      const partnerSocket = connectedUsers.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit("ice-candidate", { from: userId, candidate });
      } else {
        endConnection(userId, partnerId);
      }
    }
  });

  socket.on("end-call", () => {
    console.log(`User ${userId} ended call`);
    userLastSeen.set(userId, Date.now());

    const partnerId = activeConnections.get(userId);
    if (partnerId) {
      endConnection(userId, partnerId);
    }
  });

  socket.on("heartbeat", () => {
    userLastSeen.set(userId, Date.now());
    socket.emit("heartbeat-ack");
  });

  socket.on("disconnect", (reason) => {
    console.log(`User ${userId} disconnected: ${reason}`);
    cleanupUser(userId);
    io.emit("online-count", connectedUsers.size);
  });

  socket.on("error", (error) => {
    console.error(`Socket error for user ${userId}:`, error);
  });

  socket.on("connect_timeout", () => {
    console.log(`Connection timeout for user ${userId}`);
    cleanupUser(userId);
  });
});

function endConnection(userId, partnerId) {
  if (!userId || !partnerId) return;

  activeConnections.delete(userId);
  activeConnections.delete(partnerId);

  const userSocket = connectedUsers.get(userId);
  const partnerSocket = connectedUsers.get(partnerId);

  if (userSocket && userSocket.connected) {
    userSocket.emit("call-ended");
  }

  if (partnerSocket && partnerSocket.connected) {
    partnerSocket.emit("call-ended");
  }

  console.log(`Ended connection between ${userId} and ${partnerId}`);
}

function cleanupUser(userId) {
  if (!userId) return;

  const partnerId = activeConnections.get(userId);
  if (partnerId) {
    endConnection(userId, partnerId);
  }

  waitingQueue.delete(userId);
  connectedUsers.delete(userId);
  userLastSeen.delete(userId);

  console.log(`Cleaned up user ${userId}`);
}

function generateUserId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

setInterval(() => {
  const stats = {
    totalUsers: connectedUsers.size,
    waitingUsers: waitingQueue.size,
    activeConnections: activeConnections.size / 2,
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
  };

  console.log(`Stats: ${JSON.stringify(stats)}`);
  io.emit("server-stats", stats);

  const connectedUserIds = Array.from(connectedUsers.keys());
  for (const userId of connectedUserIds) {
    const socket = connectedUsers.get(userId);
    if (!socket || !socket.connected) {
      console.log(`Cleaning up stale connection for user ${userId}`);
      cleanupUser(userId);
    }
  }
}, 30000);

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");

  io.emit("server-shutdown", {
    message: "Server is shutting down. Please reconnect later.",
    timestamp: new Date().toISOString(),
  });

  for (const [userId, socket] of connectedUsers.entries()) {
    if (socket && socket.connected) {
      socket.emit("call-ended");
      socket.disconnect(true);
    }
    cleanupUser(userId);
  }

  connectedUsers.clear();
  waitingQueue.clear();
  activeConnections.clear();
  userLastSeen.clear();

  io.close((err) => {
    if (err) {
      console.error("Error closing socket.io server:", err);
    }
    console.log("Socket.io server closed");
  });

  server.close((err) => {
    if (err) {
      console.error("Error closing HTTP server:", err);
      process.exit(1);
    }
    console.log("HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forceful shutdown due to timeout");
    process.exit(1);
  }, 10000);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.emit("SIGTERM");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

server.listen(port, (err) => {
  if (err) {
    console.error("Server failed to start:", err);
    throw err;
  }
  console.log(`> Random Voice Chat Server ready on http://localhost:${port}`);
});
