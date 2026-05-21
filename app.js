const STORAGE_KEY = "mandalaTaskSystem.v1";
const ARCHIVE_KEY = "mandalaTaskArchive.v1";
const SETTINGS_KEY = "mandalaTaskSettings.v1";
const CLIENT_ID = `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const progressNoteTimers = new Map();

const statuses = [
  { key: "todo", label: "Belum Mulai" },
  { key: "doing", label: "Berjalan" },
  { key: "review", label: "Review" },
  { key: "done", label: "Selesai" },
];

const priorities = {
  high: "Tinggi",
  medium: "Normal",
  low: "Rendah",
};

const state = {
  tasks: loadTasks(),
  focusDate: todayInput(),
  settings: loadSettings(),
  serverOnline: false,
  lastServerErrorAt: 0,
  filters: {
    search: "",
    project: "",
    assignee: "",
    status: "",
    priority: "",
  },
};

const els = {
  focusDate: document.querySelector("#focusDate"),
  totalCount: document.querySelector("#totalCount"),
  activeCount: document.querySelector("#activeCount"),
  doneCount: document.querySelector("#doneCount"),
  overdueCount: document.querySelector("#overdueCount"),
  progressNoteCount: document.querySelector("#progressNoteCount"),
  taskForm: document.querySelector("#taskForm"),
  taskId: document.querySelector("#taskId"),
  taskTitle: document.querySelector("#taskTitle"),
  taskProject: document.querySelector("#taskProject"),
  taskAssignee: document.querySelector("#taskAssignee"),
  taskDueDate: document.querySelector("#taskDueDate"),
  taskPriority: document.querySelector("#taskPriority"),
  taskStatus: document.querySelector("#taskStatus"),
  taskProgressNote: document.querySelector("#taskProgressNote"),
  taskReminderAt: document.querySelector("#taskReminderAt"),
  taskUpdate: document.querySelector("#taskUpdate"),
  taskNotes: document.querySelector("#taskNotes"),
  formTitle: document.querySelector("#formTitle"),
  submitTaskButton: document.querySelector("#submitTaskButton"),
  resetFormButton: document.querySelector("#resetFormButton"),
  markDoneButton: document.querySelector("#markDoneButton"),
  searchInput: document.querySelector("#searchInput"),
  projectFilter: document.querySelector("#projectFilter"),
  assigneeFilter: document.querySelector("#assigneeFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  priorityFilter: document.querySelector("#priorityFilter"),
  projectOptions: document.querySelector("#projectOptions"),
  teamOptions: document.querySelector("#teamOptions"),
  taskTableBody: document.querySelector("#taskTableBody"),
  tableNote: document.querySelector("#tableNote"),
  exportButton: document.querySelector("#exportButton"),
  importButton: document.querySelector("#importButton"),
  importInput: document.querySelector("#importInput"),
  alarmPermissionButton: document.querySelector("#alarmPermissionButton"),
  alarmSoundToggle: document.querySelector("#alarmSoundToggle"),
  printButton: document.querySelector("#printButton"),
  clearDoneButton: document.querySelector("#clearDoneButton"),
  toast: document.querySelector("#toast"),
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

connectRealtime();
loadRemoteTasks();

els.focusDate.value = state.focusDate;
els.taskDueDate.value = state.focusDate;
els.alarmSoundToggle.checked = state.settings.soundEnabled;
updateAlarmButton();
els.focusDate.addEventListener("change", () => {
  state.focusDate = els.focusDate.value || todayInput();
  render();
});

[
  ["search", els.searchInput],
  ["project", els.projectFilter],
  ["assignee", els.assigneeFilter],
  ["status", els.statusFilter],
  ["priority", els.priorityFilter],
].forEach(([field, element]) => {
  element.addEventListener("input", () => {
    state.filters[field] = field === "search" ? element.value.trim().toLowerCase() : element.value;
    renderTable();
  });
  element.addEventListener("change", () => {
    state.filters[field] = field === "search" ? element.value.trim().toLowerCase() : element.value;
    renderTable();
  });
});

els.taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveTaskFromForm();
});

els.resetFormButton.addEventListener("click", resetForm);
els.markDoneButton.addEventListener("click", () => {
  els.taskStatus.value = "done";
  if (!els.taskProgressNote.value.trim()) {
    els.taskProgressNote.value = "Selesai.";
  }
  if (!els.taskUpdate.value.trim()) {
    els.taskUpdate.value = "Tugas selesai.";
  }
});

els.exportButton.addEventListener("click", exportData);
els.importButton.addEventListener("click", () => els.importInput.click());
els.importInput.addEventListener("change", importData);
els.alarmPermissionButton.addEventListener("click", requestAlarmPermission);
els.alarmSoundToggle.addEventListener("change", () => {
  state.settings.soundEnabled = els.alarmSoundToggle.checked;
  saveSettings();
  showToast(state.settings.soundEnabled ? "Bunyi alarm aktif." : "Bunyi alarm dimatikan.");
});
els.printButton.addEventListener("click", () => window.print());
els.clearDoneButton.addEventListener("click", archiveDoneTasks);

els.taskTableBody.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;

  const task = getTask(action.dataset.id);
  if (!task) return;

  if (action.dataset.action === "edit") editTask(task.id);
  if (action.dataset.action === "advance") advanceTask(task.id);
  if (action.dataset.action === "done") completeTask(task.id);
  if (action.dataset.action === "delete") deleteTask(task.id);
});

els.taskTableBody.addEventListener("change", (event) => {
  const input = event.target.closest("[data-progress-note-input]");
  if (!input) return;
  updateTaskProgressNote(input.dataset.id, input.value, { forceUpdateEntry: true });
});

els.taskTableBody.addEventListener("input", (event) => {
  const input = event.target.closest("[data-progress-note-input]");
  if (!input) return;
  scheduleProgressNoteSave(input.dataset.id, input.value);
});

render();
window.setInterval(checkAlarms, 30000);
window.setTimeout(checkAlarms, 1200);

async function loadRemoteTasks() {
  try {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) throw new Error("Remote tasks unavailable");
    const data = await response.json();
    if (Array.isArray(data.tasks)) {
      state.serverOnline = true;
      state.tasks = data.tasks.map(normalizeTask);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
      render();
      showToast("Terhubung real-time.");
    }
  } catch {
    state.serverOnline = false;
  }
}

function connectRealtime() {
  if (!("EventSource" in window)) return;

  try {
    const events = new EventSource(`/api/events?client=${encodeURIComponent(CLIENT_ID)}`);
    events.onopen = () => {
      state.serverOnline = true;
    };
    events.onmessage = (message) => {
      const event = JSON.parse(message.data || "{}");
      if (event.type !== "tasks" || !Array.isArray(event.tasks)) return;
      state.serverOnline = true;
      if (event.clientId === CLIENT_ID) return;
      state.tasks = event.tasks.map(normalizeTask);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
      render();
      checkAlarms();
    };
    events.onerror = () => {
      state.serverOnline = false;
    };
  } catch {
    state.serverOnline = false;
  }
}

function loadTasks() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(stored) && stored.length) return stored.map(normalizeTask);
  } catch {
    // Use sample data when local storage is empty or invalid.
  }

  const today = todayInput();
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  return [
    sampleTask("Finalisasi checklist dokumen PBG", "PBG Villa Maharani", "Wahyu", today, "high", "doing", "MEP masih menunggu revisi dari tim gambar.", "Checklist struktur dan arsitektur sudah dicek, MEP masih menunggu revisi."),
    sampleTask("Follow up approval invoice termin", "Administrasi Mandala", "Ayu", today, "medium", "review", "Draft invoice siap, menunggu konfirmasi nominal.", "Draft pesan dan invoice sudah siap, menunggu konfirmasi nominal."),
    sampleTask("Survey kebutuhan gambar as-built", "SLF Apotek BIA", "Made", tomorrow, "medium", "todo", "Jadwal survey sudah dikonfirmasi dengan pihak lokasi.", "Jadwal survey sudah dikonfirmasi dengan pihak lokasi."),
    sampleTask("Rekap progress mingguan untuk owner", "PBG Villa Maharani", "Indra", yesterday, "high", "doing", "Data dari tim gambar sudah masuk sebagian.", "Data dari tim gambar sudah masuk sebagian."),
    sampleTask("Upload backup file proyek ke drive", "Administrasi Mandala", "Ayu", today, "low", "done", "Backup dokumen selesai diunggah.", "Backup dokumen selesai diunggah."),
  ];
}

function sampleTask(title, project, assignee, dueDate, priority, status, progressNote, updateText) {
  return {
    id: createId(),
    title,
    project,
    assignee,
    dueDate,
    priority,
    status,
    progressNote,
    notes: "",
    updates: [{ date: todayInput(), text: updateText, progressNote }],
    reminderAt: "",
    alarmFiredAt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function saveTaskFromForm() {
  const id = els.taskId.value || createId();
  const existing = getTask(id);
  const progressNote = els.taskProgressNote.value.trim();
  const status = els.taskStatus.value;
  const updateText = els.taskUpdate.value.trim();
  const updates = existing ? [...(existing.updates || [])] : [];
  const reminderAt = els.taskReminderAt.value;

  if (updateText || !existing) {
    updates.push({
      date: state.focusDate,
      text: updateText || "Tugas dibuat.",
      progressNote,
    });
  }

  const task = {
    id,
    title: els.taskTitle.value.trim(),
    project: els.taskProject.value.trim(),
    assignee: els.taskAssignee.value.trim(),
    dueDate: els.taskDueDate.value,
    priority: els.taskPriority.value,
    status,
    progressNote,
    reminderAt,
    alarmFiredAt: existing && existing.reminderAt === reminderAt ? existing.alarmFiredAt || "" : "",
    notes: els.taskNotes.value.trim(),
    updates,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    state.tasks = state.tasks.map((item) => item.id === id ? task : item);
    showToast("Tugas diperbarui.");
  } else {
    state.tasks.unshift(task);
    showToast("Tugas baru disimpan.");
  }

  persist();
  resetForm();
  render();
}

function resetForm() {
  els.taskId.value = "";
  els.taskTitle.value = "";
  els.taskProject.value = "";
  els.taskAssignee.value = "";
  els.taskDueDate.value = state.focusDate;
  els.taskPriority.value = "medium";
  els.taskStatus.value = "todo";
  els.taskProgressNote.value = "";
  els.taskReminderAt.value = "";
  els.taskUpdate.value = "";
  els.taskNotes.value = "";
  els.formTitle.textContent = "Tambah Tugas";
  els.submitTaskButton.textContent = "Simpan Tugas";
}

function editTask(id) {
  const task = getTask(id);
  if (!task) return;

  els.taskId.value = task.id;
  els.taskTitle.value = task.title;
  els.taskProject.value = task.project;
  els.taskAssignee.value = task.assignee;
  els.taskDueDate.value = task.dueDate;
  els.taskPriority.value = task.priority;
  els.taskStatus.value = task.status;
  els.taskProgressNote.value = task.progressNote || "";
  els.taskReminderAt.value = task.reminderAt || "";
  els.taskUpdate.value = "";
  els.taskNotes.value = task.notes || "";
  els.formTitle.textContent = "Edit Tugas";
  els.submitTaskButton.textContent = "Update Tugas";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function advanceTask(id) {
  const task = getTask(id);
  if (!task) return;
  const index = statuses.findIndex((status) => status.key === task.status);
  const nextStatus = statuses[Math.min(index + 1, statuses.length - 1)].key;
  updateStatus(task.id, nextStatus);
}

function completeTask(id) {
  const task = getTask(id);
  if (!task) return;
  task.status = "done";
  if (!task.progressNote) task.progressNote = "Selesai.";
  task.alarmFiredAt = task.reminderAt || task.alarmFiredAt || "";
  addUpdate(task, "Tugas ditandai selesai.");
  persist();
  render();
  showToast("Tugas selesai.");
}

function scheduleProgressNoteSave(id, value) {
  window.clearTimeout(progressNoteTimers.get(id));
  progressNoteTimers.set(id, window.setTimeout(() => {
    updateTaskProgressNote(id, value, { renderAfter: false, silent: true });
    progressNoteTimers.delete(id);
  }, 700));
}

function updateTaskProgressNote(id, value, options = {}) {
  const task = getTask(id);
  if (!task) return;
  const nextNote = String(value || "").trim();
  if ((task.progressNote || "") === nextNote && !options.forceUpdateEntry) return;

  task.progressNote = nextNote;
  task.updatedAt = new Date().toISOString();
  if (!options.silent) {
    addUpdate(task, nextNote ? `Keterangan progress: ${nextNote}` : "Keterangan progress dikosongkan.");
  }
  persist();
  if (options.renderAfter !== false) render();
  if (!options.silent) showToast("Keterangan progress diperbarui.");
}

function deleteTask(id) {
  const task = getTask(id);
  if (!task) return;
  if (!window.confirm(`Hapus tugas "${task.title}"?`)) return;
  state.tasks = state.tasks.filter((item) => item.id !== id);
  persist();
  render();
  showToast("Tugas dihapus.");
}

function updateStatus(id, status) {
  const task = getTask(id);
  if (!task || task.status === status) return;

  task.status = status;
  if (status === "done" && !task.progressNote) task.progressNote = "Selesai.";
  addUpdate(task, `Status berubah ke ${statusLabel(status)}.`);
  persist();
  render();
  showToast(`Status: ${statusLabel(status)}.`);
}

function addUpdate(task, text) {
  task.updatedAt = new Date().toISOString();
  task.updates = [
    ...(task.updates || []),
    { date: state.focusDate, text, progressNote: task.progressNote || "" },
  ];
}

function archiveDoneTasks() {
  const doneTasks = state.tasks.filter((task) => task.status === "done");
  if (!doneTasks.length) {
    showToast("Belum ada tugas selesai untuk diarsipkan.");
    return;
  }
  if (!window.confirm(`Arsipkan ${doneTasks.length} tugas selesai?`)) return;
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...doneTasks, ...loadArchive()]));
  state.tasks = state.tasks.filter((task) => task.status !== "done");
  persist();
  render();
  showToast("Tugas selesai diarsipkan.");
}

function render() {
  renderOptions();
  renderSummary();
  renderTable();
}

function renderOptions() {
  const projects = uniqueValues(state.tasks.map((task) => task.project));
  const assignees = uniqueValues(state.tasks.map((task) => task.assignee));

  renderSelectOptions(els.projectFilter, projects, "Semua project", state.filters.project);
  renderSelectOptions(els.assigneeFilter, assignees, "Semua PIC", state.filters.assignee);

  els.projectOptions.innerHTML = projects.map((project) => `<option value="${escapeAttribute(project)}"></option>`).join("");
  els.teamOptions.innerHTML = assignees.map((name) => `<option value="${escapeAttribute(name)}"></option>`).join("");
}

function renderSummary() {
  const total = state.tasks.length;
  const active = state.tasks.filter((task) => task.status !== "done").length;
  const done = state.tasks.filter((task) => task.status === "done").length;
  const overdue = state.tasks.filter(isOverdue).length;
  const withProgressNote = state.tasks.filter((task) => task.progressNote).length;

  els.totalCount.textContent = total;
  els.activeCount.textContent = active;
  els.doneCount.textContent = done;
  els.overdueCount.textContent = overdue;
  els.progressNoteCount.textContent = withProgressNote;
}

function renderTable() {
  const tasks = getFilteredTasks();
  els.taskTableBody.innerHTML = tasks.length
    ? tasks.map(renderRow).join("")
    : `<tr><td class="empty-row" colspan="11">Belum ada tugas yang cocok dengan filter.</td></tr>`;
  els.tableNote.textContent = `${tasks.length} tugas ditampilkan.`;
}

function renderRow(task, index) {
  const lastUpdate = getLastUpdate(task);
  const overdue = isOverdue(task);
  const alarmDue = isAlarmDue(task);
  const rowClass = `${overdue ? "overdue" : ""} ${task.status === "done" ? "done" : ""}`.trim();

  return `
    <tr class="${rowClass}">
      <td>${index + 1}</td>
      <td>
        <span class="task-title">${escapeHtml(task.title)}</span>
        ${task.notes ? `<div class="task-notes">${escapeHtml(task.notes)}</div>` : ""}
      </td>
      <td>${escapeHtml(task.project)}</td>
      <td>${escapeHtml(task.assignee)}</td>
      <td>
        ${humanDate(task.dueDate)}
        ${overdue ? `<br><span class="pill status-overdue">Terlambat</span>` : ""}
      </td>
      <td><span class="pill priority-${task.priority}">${priorities[task.priority] || "Normal"}</span></td>
      <td><span class="pill status-${task.status}">${statusLabel(task.status)}</span></td>
      <td class="progress-note-cell">
        <textarea
          data-progress-note-input
          data-id="${escapeAttribute(task.id)}"
          rows="2"
          aria-label="Keterangan progress ${escapeAttribute(task.title)}"
          placeholder="Tulis keterangan"
        >${escapeHtml(task.progressNote || "")}</textarea>
      </td>
      <td>${renderAlarmCell(task, alarmDue)}</td>
      <td><div class="last-update">${lastUpdate ? escapeHtml(lastUpdate.text) : "-"}</div></td>
      <td>
        <div class="row-actions">
          <button class="mini-button" type="button" data-action="edit" data-id="${task.id}">Edit</button>
          <button class="mini-button" type="button" data-action="advance" data-id="${task.id}">Geser</button>
          <button class="mini-button" type="button" data-action="done" data-id="${task.id}">Selesai</button>
          <button class="mini-button delete-button" type="button" data-action="delete" data-id="${task.id}">Hapus</button>
        </div>
      </td>
    </tr>
  `;
}

function getFilteredTasks() {
  return [...state.tasks]
    .filter((task) => {
      const search = `${task.title} ${task.project} ${task.assignee} ${task.notes} ${task.progressNote}`.toLowerCase();
      if (state.filters.search && !search.includes(state.filters.search)) return false;
      if (state.filters.project && task.project !== state.filters.project) return false;
      if (state.filters.assignee && task.assignee !== state.filters.assignee) return false;
      if (state.filters.status && task.status !== state.filters.status) return false;
      if (state.filters.priority && task.priority !== state.filters.priority) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.status === "done" && b.status !== "done") return 1;
      if (a.status !== "done" && b.status === "done") return -1;
      return a.dueDate.localeCompare(b.dueDate) || a.project.localeCompare(b.project);
    });
}

function renderSelectOptions(select, values, defaultLabel, selectedValue) {
  select.innerHTML = `<option value="">${defaultLabel}</option>${values.map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`).join("")}`;
  select.value = values.includes(selectedValue) ? selectedValue : "";
}

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "Mandala Tabel Tugas",
    tasks: state.tasks,
    archive: loadArchive(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `mandala-tugas-${state.focusDate}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Backup JSON dibuat.");
}

function importData(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(String(reader.result || "{}"));
      const tasks = Array.isArray(payload) ? payload : payload.tasks;
      if (!Array.isArray(tasks)) throw new Error("Format tidak valid");
      state.tasks = tasks.map(normalizeTask);
      persist();
      render();
      showToast("Data berhasil diimpor.");
    } catch {
      window.alert("File tidak bisa diimpor. Pastikan formatnya JSON backup dari sistem ini.");
    } finally {
      els.importInput.value = "";
    }
  };
  reader.readAsText(file);
}

function normalizeTask(task) {
  const progressNote = String(task.progressNote || legacyProgressNote(task.progress) || "");
  return {
    id: task.id || createId(),
    title: task.title || "Tugas tanpa judul",
    project: task.project || "Project Umum",
    assignee: task.assignee || "Belum ditentukan",
    dueDate: task.dueDate || todayInput(),
    priority: priorities[task.priority] ? task.priority : "medium",
    status: statuses.some((status) => status.key === task.status) ? task.status : "todo",
    progressNote,
    reminderAt: task.reminderAt || "",
    alarmFiredAt: task.alarmFiredAt || "",
    notes: task.notes || "",
    updates: Array.isArray(task.updates) ? task.updates.map(normalizeUpdate) : [],
    createdAt: task.createdAt || new Date().toISOString(),
    updatedAt: task.updatedAt || new Date().toISOString(),
  };
}

function normalizeUpdate(update) {
  return {
    date: update.date || todayInput(),
    text: update.text || "",
    progressNote: String(update.progressNote || legacyProgressNote(update.progress) || ""),
  };
}

function persist(options = {}) {
  const shouldSync = options.sync !== false;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
  if (shouldSync) pushTasksToServer();
}

async function pushTasksToServer() {
  try {
    const response = await fetch("/api/tasks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: CLIENT_ID, tasks: state.tasks }),
    });
    if (!response.ok) throw new Error("Sync failed");
    state.serverOnline = true;
  } catch {
    state.serverOnline = false;
    const now = Date.now();
    if (now - state.lastServerErrorAt > 8000) {
      showToast("Mode lokal: server real-time belum terhubung.");
      state.lastServerErrorAt = now;
    }
  }
}

function loadSettings() {
  try {
    return { soundEnabled: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { soundEnabled: true };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function loadArchive() {
  try {
    const archive = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");
    return Array.isArray(archive) ? archive : [];
  } catch {
    return [];
  }
}

function getTask(id) {
  return state.tasks.find((task) => task.id === id);
}

function getLastUpdate(task) {
  const updates = task.updates || [];
  return updates[updates.length - 1];
}

function isOverdue(task) {
  return task.status !== "done" && task.dueDate < state.focusDate;
}

function isAlarmDue(task) {
  if (!task.reminderAt || task.status === "done") return false;
  return new Date(task.reminderAt).getTime() <= Date.now();
}

function renderAlarmCell(task, alarmDue) {
  if (!task.reminderAt) return `<div class="alarm-cell"><span class="alarm-off">Tidak disetel</span></div>`;
  const alarmText = humanDateTime(task.reminderAt);
  const fired = task.alarmFiredAt === task.reminderAt;
  return `
    <div class="alarm-cell">
      <strong class="${alarmDue && !fired ? "alarm-due" : ""}">${alarmText}</strong>
      <span>${fired ? "Sudah berbunyi" : alarmDue ? "Waktunya alarm" : "Menunggu"}</span>
    </div>
  `;
}

async function requestAlarmPermission() {
  if (!("Notification" in window)) {
    showToast("Browser ini belum mendukung notifikasi alarm.");
    return;
  }

  if (Notification.permission === "granted") {
    showToast("Alarm sudah aktif.");
    updateAlarmButton();
    return;
  }

  const permission = await Notification.requestPermission();
  updateAlarmButton();
  showToast(permission === "granted" ? "Alarm aktif. Biarkan aplikasi tetap terbuka." : "Izin alarm belum diberikan.");
}

function updateAlarmButton() {
  if (!els.alarmPermissionButton) return;
  if (!("Notification" in window)) {
    els.alarmPermissionButton.textContent = "Alarm Browser";
    return;
  }
  els.alarmPermissionButton.textContent = Notification.permission === "granted" ? "Alarm Aktif" : "Aktifkan Alarm";
}

function checkAlarms() {
  const dueTasks = state.tasks.filter((task) => isAlarmDue(task) && task.alarmFiredAt !== task.reminderAt);
  if (!dueTasks.length) return;

  dueTasks.forEach((task) => {
    task.alarmFiredAt = task.reminderAt;
    showAlarm(task);
  });
  persist();
  renderTable();
}

function showAlarm(task) {
  const message = `${task.title} - PIC ${task.assignee}`;
  showToast(`Alarm tugas: ${message}`);
  playAlarmSound();

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Alarm tugas", {
      body: `${message}. Deadline ${humanDate(task.dueDate)}.`,
      tag: task.id,
      renotify: true,
    });
  }
}

function playAlarmSound() {
  if (!state.settings.soundEnabled) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.55);
    gain.connect(context.destination);

    [0, 0.18, 0.36].forEach((offset) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, context.currentTime + offset);
      oscillator.connect(gain);
      oscillator.start(context.currentTime + offset);
      oscillator.stop(context.currentTime + offset + 0.12);
    });
  } catch {
    // Some browsers require a user gesture before audio can play.
  }
}

function statusLabel(key) {
  const item = statuses.find((status) => status.key === key);
  return item ? item.label : key;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function createId() {
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayInput() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function addDays(inputDate, days) {
  const date = new Date(`${inputDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function humanDate(inputDate) {
  if (!inputDate) return "-";
  const date = new Date(`${inputDate}T00:00:00`);
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function humanDateTime(inputDateTime) {
  if (!inputDateTime) return "-";
  const date = new Date(inputDateTime);
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function legacyProgressNote(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `Progress sebelumnya ${Math.max(0, Math.min(100, number))}%.`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
