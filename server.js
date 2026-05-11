const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const rooms = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .createHash("sha256")
    .update(`${salt}:${password}`)
    .digest("hex");
  return { salt, hash };
}

function verifyRoom(body) {
  const roomName = String(body.room || "").trim();
  const password = String(body.password || "");
  const room = rooms.get(roomName);

  if (!room) return { error: "部屋が見つかりません。" };
  const check = hashPassword(password, room.salt);
  if (check.hash !== room.passwordHash) return { error: "パスワードが違います。" };

  return { roomName, room };
}

function publicRoom(room) {
  return {
    version: room.version,
    snapshot: room.snapshot,
    players: {
      black: Boolean(room.black),
      white: Boolean(room.white)
    }
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      throw new Error("送信データが大きすぎます。");
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleApi(request, response) {
  try {
    if (request.method === "POST" && request.url === "/api/create") {
      const body = await readBody(request);
      const roomName = String(body.room || "").trim();
      const password = String(body.password || "");
      const clientId = String(body.clientId || "");

      if (!/^[\w-]{2,24}$/.test(roomName)) {
        sendJson(response, 400, { error: "部屋名は2〜24文字の英数字・_・-で入力してください。" });
        return;
      }
      if (password.length < 3) {
        sendJson(response, 400, { error: "パスワードは3文字以上にしてください。" });
        return;
      }
      if (!clientId) {
        sendJson(response, 400, { error: "接続IDがありません。" });
        return;
      }
      if (rooms.has(roomName)) {
        sendJson(response, 409, { error: "同じ名前の部屋がすでにあります。" });
        return;
      }

      const { salt, hash } = hashPassword(password);
      const room = {
        salt,
        passwordHash: hash,
        black: clientId,
        white: "",
        version: 1,
        snapshot: body.snapshot || null,
        updatedAt: Date.now()
      };
      rooms.set(roomName, room);
      sendJson(response, 200, { ...publicRoom(room), player: 1 });
      return;
    }

    if (request.method === "POST" && request.url === "/api/join") {
      const body = await readBody(request);
      const clientId = String(body.clientId || "");
      const verified = verifyRoom(body);
      if (verified.error) {
        sendJson(response, 403, { error: verified.error });
        return;
      }

      const room = verified.room;
      let player = 0;
      if (room.black === clientId) {
        player = 1;
      } else if (room.white === clientId) {
        player = -1;
      } else if (!room.white) {
        room.white = clientId;
        player = -1;
        room.updatedAt = Date.now();
      }

      sendJson(response, 200, { ...publicRoom(room), player });
      return;
    }

    if (request.method === "POST" && request.url === "/api/sync") {
      const body = await readBody(request);
      const clientId = String(body.clientId || "");
      const verified = verifyRoom(body);
      if (verified.error) {
        sendJson(response, 403, { error: verified.error });
        return;
      }

      const room = verified.room;
      if (clientId !== room.black && clientId !== room.white) {
        sendJson(response, 403, { error: "観戦者は盤面を更新できません。" });
        return;
      }

      room.snapshot = body.snapshot || room.snapshot;
      room.version += 1;
      room.updatedAt = Date.now();
      sendJson(response, 200, publicRoom(room));
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/api/state?")) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const verified = verifyRoom({
        room: url.searchParams.get("room"),
        password: url.searchParams.get("password")
      });
      if (verified.error) {
        sendJson(response, 403, { error: verified.error });
        return;
      }

      sendJson(response, 200, publicRoom(verified.room));
      return;
    }

    sendJson(response, 404, { error: "APIが見つかりません。" });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "サーバーエラーです。" });
  }
}

async function serveFile(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const rawPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(rawPath)));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api/")) {
    handleApi(request, response);
    return;
  }
  serveFile(request, response);
});

setInterval(() => {
  const maxAge = 1000 * 60 * 60 * 6;
  const now = Date.now();
  for (const [name, room] of rooms) {
    if (now - room.updatedAt > maxAge) rooms.delete(name);
  }
}, 1000 * 60 * 15).unref();

server.listen(PORT, HOST, () => {
  console.log(`Online othello server: http://${HOST}:${PORT}`);
});
