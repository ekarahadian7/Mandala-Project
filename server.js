const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream } = require("node:fs");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "tasks.json");
const MAX_BODY_SIZE = 5 * 1024 * 1024;

const clients = new Set();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      return sendJson(response, await readData());
    }

    if (url.pathname === "/api/tasks" && request.method === "PUT") {
      const body = await readBody(request);
      const payload = JSON.parse(body || "{}");
      if (!Array.isArray(payload.tasks)) {
        return sendJson(response, { error: "tasks must be an array" }, 400);
      }

      const data = {
        tasks: payload.tasks.map(normalizeTask),
        updatedAt: new Date().toISOString(),
      };
      const clientId = typeof payload.clientId === "string" ? payload.clientId : "";
      await writeData(data);
      broadcast({ type: "tasks", clientId, ...data });
      return sendJson(response, data);
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      return connectEvents(request, response);
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    return sendJson(response, { error: "Server error" }, 500);
  }
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`Mandala Task real-time server running at http://${shownHost}:${PORT}`);
});

async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks.map(normalizeTask) : [],
      updatedAt: data.updatedAt || null,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { tasks: [], updatedAt: null };
  }
}

async function writeData(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpFile = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(data, null, 2));
  await fs.rename(tmpFile, DATA_FILE);
}

function normalizeTask(task) {
  const now = new Date().toISOString();
  const projectNote = String(task.projectNote || task.progressNote || legacyProgressNote(task.progress) || "");
  return {
    id: String(task.id || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    title: String(task.title || "Tugas tanpa judul"),
    project: String(task.project || "Project Umum"),
    assignee: String(task.assignee || "Belum ditentukan"),
    dueDate: String(task.dueDate || new Date().toISOString().slice(0, 10)),
    priority: ["high", "medium", "low"].includes(task.priority) ? task.priority : "medium",
    status: ["todo", "doing", "review", "done"].includes(task.status) ? task.status : "todo",
    projectNote,
    documents: String(task.documents || ""),
    reminderAt: String(task.reminderAt || ""),
    alarmFiredAt: String(task.alarmFiredAt || ""),
    notes: String(task.notes || ""),
    updates: Array.isArray(task.updates) ? task.updates.map(normalizeUpdate) : [],
    createdAt: String(task.createdAt || now),
    updatedAt: String(task.updatedAt || now),
  };
}

function normalizeUpdate(update) {
  return {
    date: String(update.date || new Date().toISOString().slice(0, 10)),
    text: String(update.text || ""),
    projectNote: String(update.projectNote || update.progressNote || legacyProgressNote(update.progress) || ""),
  };
}

function legacyProgressNote(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `Catatan lama: progress ${Math.max(0, Math.min(100, number))}%.`;
}

function connectEvents(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 3000\n\n");

  const client = response;
  clients.add(client);

  readData().then((data) => {
    sendEvent(client, { type: "tasks", ...data });
  }).catch(() => {});

  const heartbeat = setInterval(() => {
    client.write(": ping\n\n");
  }, 25000);

  request.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

function broadcast(event) {
  for (const client of clients) {
    sendEvent(client, event);
  }
}

function sendEvent(client, event) {
  client.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function serveStatic(urlPath, response) {
  const pathname = decodeURIComponent(urlPath.split("?")[0]);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(ROOT, relativePath));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return serveStatic("/index.html", response);

    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": path.basename(filePath) === "service-worker.js" ? "no-cache" : "public, max-age=60",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") return serveStatic("/index.html", response);
    throw error;
  }
}
