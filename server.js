const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream } = require("node:fs");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const STARTED_AT = new Date().toISOString();
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, "data"));
const DATA_FILE = path.join(DATA_DIR, "tasks.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const UPLOAD_CHUNK_DIR = path.join(DATA_DIR, "upload-chunks");
const MAX_JSON_BODY_SIZE = 5 * 1024 * 1024;
const MAX_UPLOAD_BODY_SIZE = 40 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024 * 1024;

const clients = new Set();

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return sendJson(response, {
        ok: true,
        app: "Mandala Tabel Tugas",
        startedAt: STARTED_AT,
        storage: process.env.RAILWAY_VOLUME_MOUNT_PATH ? "railway-volume" : "local",
      });
    }

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      return sendJson(response, await readData());
    }

    if (url.pathname === "/api/tasks" && request.method === "PUT") {
      const body = await readBody(request, MAX_JSON_BODY_SIZE);
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

    if (url.pathname === "/api/uploads" && request.method === "POST") {
      const files = await handleUploads(request);
      return sendJson(response, { files });
    }

    if (url.pathname === "/api/uploads/chunk" && request.method === "POST") {
      const file = await handleUploadChunk(request);
      return sendJson(response, file ? { complete: true, file } : { complete: false });
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      return connectEvents(request, response);
    }

    if (url.pathname.startsWith("/uploads/") && request.method === "GET") {
      return serveUpload(url.pathname, response);
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    return sendJson(response, { error: status >= 500 ? "Server error" : error.message }, status);
  }
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`Mandala Task real-time server running at http://${shownHost}:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
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
  await writeTextAtomic(DATA_FILE, JSON.stringify(data, null, 2));
}

function normalizeTask(task) {
  const now = new Date().toISOString();
  const projectNote = String(task.projectNote || task.progressNote || legacyProgressNote(task.progress) || "");
  const dueDate = String(task.dueDate || new Date().toISOString().slice(0, 10));
  const startDate = String(task.startDate || inputDateFromIso(task.createdAt) || dueDate);
  return {
    id: String(task.id || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    title: String(task.title || "Tugas tanpa judul"),
    project: String(task.project || "Project Umum"),
    assignee: String(task.assignee || "Belum ditentukan"),
    startDate,
    dueDate,
    priority: ["high", "medium", "low"].includes(task.priority) ? task.priority : "medium",
    status: ["todo", "doing", "review", "done"].includes(task.status) ? task.status : "todo",
    projectNote,
    documents: normalizeDocuments(task.documents),
    reminderAt: String(task.reminderAt || ""),
    alarmFiredAt: String(task.alarmFiredAt || ""),
    notes: String(task.notes || ""),
    updates: Array.isArray(task.updates) ? task.updates.map(normalizeUpdate) : [],
    createdAt: String(task.createdAt || now),
    updatedAt: String(task.updatedAt || now),
  };
}

function inputDateFromIso(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function normalizeUpdate(update) {
  return {
    date: String(update.date || new Date().toISOString().slice(0, 10)),
    text: String(update.text || ""),
    projectNote: String(update.projectNote || update.progressNote || legacyProgressNote(update.progress) || ""),
  };
}

function normalizeDocuments(value) {
  if (Array.isArray(value)) return value.map(normalizeDocument).filter(Boolean);
  return String(value || "")
    .split(/\r?\n/)
    .map((line, index) => normalizeDocument({ name: `Dokumen ${index + 1}`, url: line.trim() }))
    .filter(Boolean);
}

function normalizeDocument(documentItem) {
  if (!documentItem) return null;
  if (typeof documentItem === "string") {
    const text = documentItem.trim();
    if (!text) return null;
    return { name: fileNameFromUrl(text) || text, url: text, size: 0, type: "", uploadedAt: "" };
  }
  const url = String(documentItem.url || "").trim();
  const name = String(documentItem.name || fileNameFromUrl(url) || "Dokumen").trim();
  if (!name && !url) return null;
  return {
    name,
    url,
    size: Number(documentItem.size || 0),
    type: String(documentItem.type || ""),
    uploadedAt: String(documentItem.uploadedAt || ""),
  };
}

function fileNameFromUrl(value) {
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    return name || "";
  } catch {
    return "";
  }
}

function legacyProgressNote(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `Catatan lama: progress ${Math.max(0, Math.min(100, number))}%.`;
}

async function handleUploads(request) {
  const contentType = request.headers["content-type"] || "";
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("Missing multipart boundary");

  const boundary = match[1] || match[2];
  const body = await readBodyBuffer(request, MAX_UPLOAD_BODY_SIZE);
  const parts = parseMultipart(body, boundary).filter((part) => part.filename && part.content.length);
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const files = [];
  for (const part of parts) {
    const originalName = sanitizeFileName(part.filename);
    const storedName = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${originalName}`;
    const filePath = path.join(UPLOAD_DIR, storedName);
    await fs.writeFile(filePath, part.content);
    files.push({
      name: originalName,
      url: `/uploads/${encodeURIComponent(storedName)}`,
      size: part.content.length,
      type: part.contentType || "application/octet-stream",
      uploadedAt: new Date().toISOString(),
    });
  }

  return files;
}

async function handleUploadChunk(request) {
  const uploadId = sanitizeUploadId(request.headers["x-upload-id"]);
  const originalName = sanitizeFileName(decodeHeader(request.headers["x-file-name"]) || "dokumen");
  const fileType = decodeHeader(request.headers["x-file-type"]) || "application/octet-stream";
  const fileSize = toSafeInteger(request.headers["x-file-size"], 0);
  const chunkIndex = toSafeInteger(request.headers["x-chunk-index"], -1);
  const totalChunks = toSafeInteger(request.headers["x-total-chunks"], 0);

  if (!uploadId || chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks) {
    throw new HttpError(400, "Data upload tidak lengkap. Coba ulangi upload.");
  }

  if (fileSize > MAX_UPLOAD_FILE_SIZE || totalChunks > 10000) {
    throw new HttpError(413, "File terlalu besar untuk storage website. Coba kompres atau pecah file.");
  }

  const completedUpload = await readCompletedUpload(uploadId);
  if (completedUpload) return completedUpload;

  const body = await readBodyBuffer(request, MAX_UPLOAD_CHUNK_SIZE);
  const chunkDir = path.join(UPLOAD_CHUNK_DIR, uploadId);
  await fs.mkdir(chunkDir, { recursive: true });
  await writeBufferAtomic(path.join(chunkDir, `${chunkIndex}.part`), body);

  const complete = await uploadChunksComplete(chunkDir, totalChunks);
  if (!complete) return null;

  const file = await assembleUploadChunks({
    chunkDir,
    totalChunks,
    originalName,
    fileType,
    fileSize,
  });
  await writeCompletedUpload(uploadId, file);
  return file;
}

async function uploadChunksComplete(chunkDir, totalChunks) {
  for (let index = 0; index < totalChunks; index += 1) {
    try {
      const stat = await fs.stat(path.join(chunkDir, `${index}.part`));
      if (!stat.isFile()) return false;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function assembleUploadChunks({ chunkDir, totalChunks, originalName, fileType, fileSize }) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const storedName = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${originalName}`;
  const filePath = path.join(UPLOAD_DIR, storedName);
  const fileHandle = await fs.open(filePath, "w");
  let totalSize = 0;

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = await fs.readFile(path.join(chunkDir, `${index}.part`));
      totalSize += chunk.length;
      await fileHandle.write(chunk);
    }
  } finally {
    await fileHandle.close();
  }

  if (fileSize && totalSize !== fileSize) {
    await fs.rm(filePath, { force: true });
    throw new HttpError(400, "Ukuran file tidak cocok. Upload dibatalkan, coba ulangi lagi.");
  }

  await fs.rm(chunkDir, { recursive: true, force: true });

  return {
    name: originalName,
    url: `/uploads/${encodeURIComponent(storedName)}`,
    size: fileSize || totalSize,
    type: fileType,
    uploadedAt: new Date().toISOString(),
  };
}

async function readCompletedUpload(uploadId) {
  try {
    const raw = await fs.readFile(path.join(UPLOAD_CHUNK_DIR, `${uploadId}.json`), "utf8");
    const file = JSON.parse(raw);
    return file && file.url ? file : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCompletedUpload(uploadId, file) {
  await fs.mkdir(UPLOAD_CHUNK_DIR, { recursive: true });
  await writeTextAtomic(path.join(UPLOAD_CHUNK_DIR, `${uploadId}.json`), JSON.stringify(file));
}

async function writeBufferAtomic(filePath, buffer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmpFile, buffer);
  await fs.rename(tmpFile, filePath);
}

async function writeTextAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmpFile, text);
  await fs.rename(tmpFile, filePath);
}

function parseMultipart(buffer, boundary) {
  const boundaryText = `--${boundary}`;
  return buffer.toString("binary")
    .split(boundaryText)
    .slice(1, -1)
    .map(parseMultipartPart)
    .filter(Boolean);
}

function parseMultipartPart(part) {
  let text = part;
  if (text.startsWith("\r\n")) text = text.slice(2);
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headers = text.slice(0, headerEnd);
  const content = Buffer.from(text.slice(headerEnd + 4), "binary");
  const disposition = headers.match(/content-disposition:\s*([^\r\n]+)/i)?.[1] || "";
  const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || "";
  const fieldName = disposition.match(/name="([^"]*)"/i)?.[1] || "";
  const contentType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "";
  return { fieldName, filename, contentType, content };
}

function sanitizeFileName(fileName) {
  const safe = path.basename(String(fileName || "dokumen"))
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || "dokumen";
}

function sanitizeUploadId(value) {
  const safe = String(value || "")
    .replace(/[^\w.-]+/g, "")
    .slice(0, 80);
  return safe;
}

function decodeHeader(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function toSafeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
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

function readBody(request, maxSize = MAX_JSON_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxSize) {
        reject(new HttpError(413, "Data terlalu besar."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function readBodyBuffer(request, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new HttpError(413, "Potongan upload terlalu besar. Coba ulangi upload."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function serveUpload(urlPath, response) {
  const fileName = path.basename(decodeURIComponent(urlPath));
  const filePath = path.normalize(path.join(UPLOAD_DIR, fileName));

  if (!isPathInside(filePath, UPLOAD_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    throw error;
  }
}

async function serveStatic(urlPath, response) {
  const pathname = decodeURIComponent(urlPath.split("?")[0]);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(ROOT, relativePath));

  if (!isPathInside(filePath, ROOT)) {
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

function isPathInside(targetPath, parentPath) {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
