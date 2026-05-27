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
const GOOGLE_DRIVE_FOLDER_ID = String(process.env.GOOGLE_DRIVE_FOLDER_ID || "");
const GOOGLE_SERVICE_ACCOUNT_EMAIL = String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "");
const GOOGLE_PRIVATE_KEY = String(process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const clients = new Set();
let googleDriveToken = { accessToken: "", expiresAt: 0 };

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

    if (url.pathname === "/api/storage" && request.method === "GET") {
      return sendJson(response, {
        driveEnabled: isGoogleDriveEnabled(),
        storage: isGoogleDriveEnabled() ? "google-drive" : "local",
      });
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
  const rawStartDate = String(task.startDate || inputDateFromIso(task.createdAt) || dueDate);
  const startDate = rawStartDate > dueDate ? dueDate : rawStartDate;
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
    return { name: fileNameFromUrl(text) || text, url: text, size: 0, type: "", storage: documentStorageFromUrl(text), uploadedAt: "" };
  }
  const url = String(documentItem.url || "").trim();
  const name = String(documentItem.name || fileNameFromUrl(url) || "Dokumen").trim();
  if (!name && !url) return null;
  return {
    name,
    url,
    size: Number(documentItem.size || 0),
    type: String(documentItem.type || ""),
    storage: String(documentItem.storage || documentStorageFromUrl(url)),
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

function documentStorageFromUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.includes("drive.google.com") || host.includes("docs.google.com") ? "google-drive" : "link";
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
  const files = [];
  for (const part of parts) {
    const originalName = sanitizeFileName(part.filename);
    files.push(await saveUploadedBuffer({
      originalName,
      content: part.content,
      fileType: part.contentType || "application/octet-stream",
    }));
  }

  return files;
}

async function saveUploadedBuffer({ originalName, content, fileType }) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const storedName = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${originalName}`;
  const filePath = path.join(UPLOAD_DIR, storedName);
  await writeBufferAtomic(filePath, content);
  return publishStoredFile({
    filePath,
    storedName,
    originalName,
    fileType,
    fileSize: content.length,
  });
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

  return publishStoredFile({
    filePath,
    storedName,
    originalName,
    fileType,
    fileSize: fileSize || totalSize,
  });
}

async function publishStoredFile({ filePath, storedName, originalName, fileType, fileSize }) {
  if (isGoogleDriveEnabled()) {
    try {
      const driveFile = await uploadFileToGoogleDrive({ filePath, originalName, fileType, fileSize });
      await fs.rm(filePath, { force: true });
      return driveFile;
    } catch (error) {
      console.error("Google Drive upload failed. Keeping file in local storage.", error);
    }
  }

  return {
    name: originalName,
    url: `/uploads/${encodeURIComponent(storedName)}`,
    size: fileSize,
    type: fileType,
    storage: "local",
    uploadedAt: new Date().toISOString(),
  };
}

function isGoogleDriveEnabled() {
  return Boolean(GOOGLE_DRIVE_FOLDER_ID && GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY);
}

async function uploadFileToGoogleDrive({ filePath, originalName, fileType, fileSize }) {
  const accessToken = await getGoogleDriveAccessToken();
  const metadata = {
    name: originalName,
    parents: [GOOGLE_DRIVE_FOLDER_ID],
  };
  const sessionResponse = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,webContentLink", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
      "X-Upload-Content-Type": fileType,
      "X-Upload-Content-Length": String(fileSize),
    },
    body: JSON.stringify(metadata),
  });

  if (!sessionResponse.ok) {
    throw new Error(`Google Drive session failed: ${sessionResponse.status} ${await sessionResponse.text()}`);
  }

  const uploadUrl = sessionResponse.headers.get("location");
  if (!uploadUrl) throw new Error("Google Drive upload URL missing");

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": fileType,
      "Content-Length": String(fileSize),
    },
    body: createReadStream(filePath),
    duplex: "half",
  });

  if (!uploadResponse.ok) {
    throw new Error(`Google Drive upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
  }

  const driveFile = await uploadResponse.json();
  await shareGoogleDriveFile(driveFile.id, accessToken).catch((error) => {
    console.warn("Google Drive sharing skipped.", error);
  });

  return {
    name: originalName,
    url: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`,
    downloadUrl: driveFile.webContentLink || "",
    size: fileSize,
    type: fileType,
    storage: "google-drive",
    uploadedAt: new Date().toISOString(),
  };
}

async function getGoogleDriveAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (googleDriveToken.accessToken && googleDriveToken.expiresAt - 60 > now) {
    return googleDriveToken.accessToken;
  }

  const assertion = createGoogleJwt(now);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Google token failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }

  const token = await tokenResponse.json();
  googleDriveToken = {
    accessToken: token.access_token,
    expiresAt: now + Number(token.expires_in || 3600),
  };
  return googleDriveToken.accessToken;
}

function createGoogleJwt(now) {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const input = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(GOOGLE_PRIVATE_KEY);
  return `${input}.${base64Url(signature)}`;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function shareGoogleDriveFile(fileId, accessToken) {
  if (!fileId) return;
  await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
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
