import { createServer } from "http";
import { Server } from "socket.io";

const port = parseInt(process.env.PORT || "3001", 10);

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Socket.IO server running");
});

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

const users = {};

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.on("register", (userId) => {
    users[userId] = socket.id;
    socket.userId = userId;
    console.log(`User ${userId} registered with socket ${socket.id}`);
  });

  socket.on("call-user", ({ to, offer }) => {
    const targetSocketId = users[to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("incoming-call", {
        from: socket.userId,
        offer,
      });
    } else {
      socket.emit("call-error", { message: "User not found" });
    }
  });

  socket.on("accept-call", ({ to, answer }) => {
    const targetSocketId = users[to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("call-accepted", { answer });
    }
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    const targetSocketId = users[to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("ice-candidate", { candidate });
    }
  });

  socket.on("end-call", ({ to }) => {
    const targetSocketId = users[to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("call-ended");
    }
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      delete users[socket.userId];
      console.log(`User ${socket.userId} disconnected`);
    }
  });
});

server.listen(port, (err) => {
  if (err) {
    console.error("Server failed to start:", err);
    throw err;
  }
  console.log(`> Ready on http://localhost:${port}`);
});
