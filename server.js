import { createServer } from "http";
import { Server } from "socket.io";

const port = parseInt(process.env.PORT || "3001", 10);

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Random Voice Chat Server Running");
});

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: ["http://localhost:3000", "https://your-domain.com"],
    methods: ["GET", "POST"],
  },
});

// Store connected users and waiting queue
const connectedUsers = new Map(); // userId -> socket
const waitingQueue = new Set(); // Set of userIds waiting for match
const activeConnections = new Map(); // userId -> partnerId

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Generate unique user ID
  const userId = generateUserId();
  socket.userId = userId;
  connectedUsers.set(userId, socket);

  console.log(`User ${userId} connected. Total users: ${connectedUsers.size}`);

  // Send online count to all users
  io.emit("online-count", connectedUsers.size);

  socket.on("find-random", () => {
    console.log(`User ${userId} looking for random match`);

    // Remove from any existing connection first
    if (activeConnections.has(userId)) {
      const partnerId = activeConnections.get(userId);
      endConnection(userId, partnerId);
    }

    // Try to find a match from waiting queue
    const availableUsers = Array.from(waitingQueue).filter(
      (id) => id !== userId && connectedUsers.has(id)
    );

    if (availableUsers.length > 0) {
      // Match with random available user
      const partnerId =
        availableUsers[Math.floor(Math.random() * availableUsers.length)];
      const partnerSocket = connectedUsers.get(partnerId);

      if (partnerSocket) {
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
    const partnerId = activeConnections.get(userId);
    if (partnerId && connectedUsers.has(partnerId)) {
      connectedUsers.get(partnerId).emit("webrtc-offer", {
        from: userId,
        offer,
      });
    }
  });

  socket.on("webrtc-answer", ({ answer }) => {
    const partnerId = activeConnections.get(userId);
    if (partnerId && connectedUsers.has(partnerId)) {
      connectedUsers.get(partnerId).emit("webrtc-answer", {
        from: userId,
        answer,
      });
    }
  });

  socket.on("ice-candidate", ({ candidate }) => {
    const partnerId = activeConnections.get(userId);
    if (partnerId && connectedUsers.has(partnerId)) {
      connectedUsers.get(partnerId).emit("ice-candidate", {
        from: userId,
        candidate,
      });
    }
  });

  socket.on("end-call", () => {
    const partnerId = activeConnections.get(userId);
    if (partnerId) {
      endConnection(userId, partnerId);
    }
  });

  socket.on("disconnect", () => {
    console.log(`User ${userId} disconnected`);

    // Clean up user data
    const partnerId = activeConnections.get(userId);
    if (partnerId) {
      endConnection(userId, partnerId);
    }

    waitingQueue.delete(userId);
    connectedUsers.delete(userId);

    // Update online count
    io.emit("online-count", connectedUsers.size);
  });
});

function endConnection(userId, partnerId) {
  // Remove from active connections
  activeConnections.delete(userId);
  activeConnections.delete(partnerId);

  // Notify both users that call ended
  const userSocket = connectedUsers.get(userId);
  const partnerSocket = connectedUsers.get(partnerId);

  if (userSocket) {
    userSocket.emit("call-ended");
  }

  if (partnerSocket) {
    partnerSocket.emit("call-ended");
  }

  console.log(`Ended connection between ${userId} and ${partnerId}`);
}

function generateUserId() {
  return Math.random().toString(36).substr(2, 9);
}

// Send periodic stats
setInterval(() => {
  const stats = {
    totalUsers: connectedUsers.size,
    waitingUsers: waitingQueue.size,
    activeConnections: activeConnections.size / 2, // Divide by 2 since each connection is stored twice
  };

  console.log(`Stats: ${JSON.stringify(stats)}`);
  io.emit("server-stats", stats);
}, 30000); // Every 30 seconds

server.listen(port, (err) => {
  if (err) {
    console.error("Server failed to start:", err);
    throw err;
  }
  console.log(`> Random Voice Chat Server ready on http://localhost:${port}`);
});
