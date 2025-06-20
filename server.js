import { createServer } from "http";
import { Server } from "socket.io";

const port = parseInt(process.env.PORT || "3001", 10);

const server = createServer((req, res) => {
  // Add CORS headers for HTTP requests
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
      "http://localhost:3000",
      "https://your-domain.com",
      "https://ww-five-rust.vercel.app",
      /^https:\/\/.*\.vercel\.app$/,
      /^https:\/\/.*\.netlify\.app$/,
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
  allowEIO3: true,
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Store connected users and waiting queue
const connectedUsers = new Map(); // userId -> socket
const waitingQueue = new Set(); // Set of userIds waiting for match
const activeConnections = new Map(); // userId -> partnerId
const userLastSeen = new Map(); // userId -> timestamp

// Clean up inactive users periodically
setInterval(() => {
  const now = Date.now();
  const INACTIVE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

  for (const [userId, lastSeen] of userLastSeen.entries()) {
    if (now - lastSeen > INACTIVE_THRESHOLD) {
      console.log(`Cleaning up inactive user: ${userId}`);

      const socket = connectedUsers.get(userId);
      if (socket) {
        socket.disconnect(true);
      }

      cleanupUser(userId);
    }
  }
}, 60000); // Check every minute

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Generate unique user ID
  const userId = generateUserId();
  socket.userId = userId;
  connectedUsers.set(userId, socket);
  userLastSeen.set(userId, Date.now());

  console.log(`User ${userId} connected. Total users: ${connectedUsers.size}`);

  // Send online count to all users
  io.emit("online-count", connectedUsers.size);

  // Send welcome message with connection info
  socket.emit("connect-info", {
    userId,
    serverTime: new Date().toISOString(),
    onlineCount: connectedUsers.size,
  });

  socket.on("find-random", () => {
    console.log(`User ${userId} looking for random match`);
    userLastSeen.set(userId, Date.now());

    // Remove from any existing connection first
    if (activeConnections.has(userId)) {
      const partnerId = activeConnections.get(userId);
      endConnection(userId, partnerId);
    }

    // Remove from waiting queue if already there
    waitingQueue.delete(userId);

    // Try to find a match from waiting queue
    const availableUsers = Array.from(waitingQueue).filter(
      (id) =>
        id !== userId && connectedUsers.has(id) && !activeConnections.has(id)
    );

    if (availableUsers.length > 0) {
      // Match with random available user
      const partnerId =
        availableUsers[Math.floor(Math.random() * availableUsers.length)];
      const partnerSocket = connectedUsers.get(partnerId);

      if (partnerSocket && partnerSocket.connected) {
        // Remove both from waiting queue
        waitingQueue.delete(userId);
        waitingQueue.delete(partnerId);

        // Create connection
        activeConnections.set(userId, partnerId);
        activeConnections.set(partnerId, userId);

        console.log(`Matched ${userId} with ${partnerId}`);

        // Initiate WebRTC connection (user becomes initiator)
        socket.emit("match-found", { partnerId, initiator: true });
        partnerSocket.emit("match-found", {
          partnerId: userId,
          initiator: false,
        });
      } else {
        // Partner socket is not valid, clean up and add to queue
        if (partnerId) {
          cleanupUser(partnerId);
        }
        waitingQueue.add(userId);
        socket.emit("waiting-for-match");
      }
    } else {
      // Add to waiting queue
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
        partnerSocket.emit("webrtc-offer", {
          from: userId,
          offer,
        });
      } else {
        // Partner disconnected, end connection
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
        partnerSocket.emit("webrtc-answer", {
          from: userId,
          answer,
        });
      } else {
        // Partner disconnected, end connection
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
        partnerSocket.emit("ice-candidate", {
          from: userId,
          candidate,
        });
      } else {
        // Partner disconnected, end connection
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

    // Update online count
    io.emit("online-count", connectedUsers.size);
  });

  socket.on("error", (error) => {
    console.error(`Socket error for user ${userId}:`, error);
  });

  // Handle socket timeout
  socket.on("connect_timeout", () => {
    console.log(`Connection timeout for user ${userId}`);
    cleanupUser(userId);
  });
});

function endConnection(userId, partnerId) {
  if (!userId || !partnerId) return;

  // Remove from active connections
  activeConnections.delete(userId);
  activeConnections.delete(partnerId);

  // Notify both users that call ended
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

  // Remove from active connections
  const partnerId = activeConnections.get(userId);
  if (partnerId) {
    endConnection(userId, partnerId);
  }

  // Remove from waiting queue
  waitingQueue.delete(userId);

  // Remove from connected users
  connectedUsers.delete(userId);

  // Remove from last seen tracking
  userLastSeen.delete(userId);

  console.log(`Cleaned up user ${userId}`);
}

function generateUserId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Send periodic stats and health check
setInterval(() => {
  const stats = {
    totalUsers: connectedUsers.size,
    waitingUsers: waitingQueue.size,
    activeConnections: activeConnections.size / 2, // Divide by 2 since each connection is stored twice
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
  };

  console.log(`Stats: ${JSON.stringify(stats)}`);

  // Send stats to all connected clients
  io.emit("server-stats", stats);

  // Clean up any stale connections
  const connectedUserIds = Array.from(connectedUsers.keys());
  for (const userId of connectedUserIds) {
    const socket = connectedUsers.get(userId);
    if (!socket || !socket.connected) {
      console.log(`Cleaning up stale connection for user ${userId}`);
      cleanupUser(userId);
    }
  }
}, 30000); // Every 30 seconds

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");

  // Notify all users about server shutdown
  io.emit("server-shutdown", {
    message: "Server is shutting down. Please reconnect later.",
    timestamp: new Date().toISOString(),
  });

  // Close all active connections
  for (const [userId, socket] of connectedUsers.entries()) {
    if (socket && socket.connected) {
      socket.emit("call-ended");
      socket.disconnect(true);
    }
    cleanupUser(userId);
  }

  // Clear all data structures
  connectedUsers.clear();
  waitingQueue.clear();
  activeConnections.clear();
  userLastSeen.clear();

  // Close socket.io server
  io.close((err) => {
    if (err) {
      console.error("Error closing socket.io server:", err);
    }
    console.log("Socket.io server closed");
  });

  // Close HTTP server
  server.close((err) => {
    if (err) {
      console.error("Error closing HTTP server:", err);
      process.exit(1);
    }
    console.log("HTTP server closed");
    process.exit(0);
  });

  // Force exit if cleanup takes too long
  setTimeout(() => {
    console.error("Forceful shutdown due to timeout");
    process.exit(1);
  }, 10000); // 10 seconds timeout
});

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // Attempt graceful shutdown
  process.emit("SIGTERM");
});

// Handle unhandled promise rejections
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
