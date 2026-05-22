const STORAGE_KEY = "mandalaTaskSystem.v1";
const ARCHIVE_KEY = "mandalaTaskArchive.v1";
const SETTINGS_KEY = "mandalaTaskSettings.v1";
const HIDDEN_DATES_KEY = "mandalaTaskHiddenDates.v1";
const CLIENT_ID = `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const projectNoteTimers = new Map();

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
  hiddenDates: loadHiddenDates(),
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
  projectNoteCount: document.querySelector("#projectNoteCount"),
  taskForm: document.querySelector("#taskForm"),
  taskId: document.querySelector("#taskId"),
  taskTitle: document.querySelector("#taskTitle"),
  taskProject: document.querySelector("#taskProject"),
  taskAssignee: document.querySelector("#taskAssignee"),
  taskDueDate: document.querySelector("#taskDueDate"),
  taskPriority: document.querySelector("#taskPriority"),
  taskStatus: document.querySelector("#taskStatus"),
  taskProjectNote: document.querySelector("#taskProjectNote"),
  taskReminderAt: document.querySelector("#taskReminderAt"),
  taskDocuments: document.querySelector("#taskDocuments"),
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
  if (!els.taskProjectNote.value.trim()) {
    els.taskProjectNote.value = "Selesai.";
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
  const groupToggle = event.target.closest("[data-group-toggle]");
  if (groupToggle) {
    toggleDateGroup(groupToggle.dataset.date);
    return;
  }

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
  const input = event.target.closest("[data-project-note-input]");
  if (!input) return;
  updateTaskProjectNote(input.dataset.id, input.value, { forceUpdateEntry: true });
});

els.taskTableBody.addEventListener("input", (event) => {
  const input = event.target.closest("[data-project-note-input]");
  if (!input) return;
  scheduleProjectNoteSave(input.dataset.id, input.value);
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
    sampleTask("Finalisasi checklist dokumen PBG", "PBG Villa Maharani", "Wahyu", today, "high", "doing", "MEP masih menunggu revisi dari tim gambar.", ""),
    sampleTask("Follow up approval invoice termin", "Administrasi Mandala", "Ayu", today, "medium", "review", "Draft invoice siap, menunggu konfirmasi nominal.", ""),
    sampleTask("Survey kebutuhan gambar as-built", "SLF Apotek BIA", "Made", tomorrow, "medium", "todo", "Jadwal survey sudah dikonfirmasi dengan pihak lokasi.", ""),
    sampleTask("Rekap progress mingguan untuk owner", "PBG Villa Maharani", "Indra", yesterday, "high", "doing", "Data dari tim gambar sudah masuk sebagian.", ""),
    sampleTask("Upload backup file proyek ke drive", "Administrasi Mandala", "Ayu", today, "low", "done", "Backup dokumen selesai diunggah.", ""),
  ];
}

function sampleTask(title, project, assignee, dueDate, priority, status, projectNote, documents) {
  return {
    id: createId(),
    title,
    project,
    assignee,
    dueDate,
    priority,
    status,
    projectNote,
    documents,
    notes: "",
    updates: [{ date: todayInput(), text: "Tugas dibuat.", projectNote }],
    reminderAt: "",
    alarmFiredAt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function saveTaskFromForm() {
  const id = els.taskId.value || createId();
  const existing = getTask(id);
  const projectNote = els.taskProjectNote.value.trim();
  const documents = els.taskDocuments.value.trim();
  const status = els.taskStatus.value;
  const updates = existing ? [...(existing.updates || [])] : [];
  const reminderAt = els.taskReminderAt.value;

  if (!existing || documents !== (existing.documents || "") || projectNote !== (existing.projectNote || "")) {
    updates.push({
      date: state.focusDate,
      text: existing ? "Tugas diperbarui." : "Tugas dibuat.",
      projectNote,
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
    projectNote,
    documents,
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
  els.taskProjectNote.value = "";
  els.taskReminderAt.value = "";
  els.taskDocuments.value = "";
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
  els.taskProjectNote.value = task.projectNote || "";
  els.taskReminderAt.value = task.reminderAt || "";
  els.taskDocuments.value = task.documents || "";
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
  if (!task.projectNote) task.projectNote = "Selesai.";
  task.alarmFiredAt = task.reminderAt || task.alarmFiredAt || "";
  addUpdate(task, "Tugas ditandai selesai.");
  persist();
  render();
  showToast("Tugas selesai.");
}

function scheduleProjectNoteSave(id, value) {
  window.clearTimeout(projectNoteTimers.get(id));
  projectNoteTimers.set(id, window.setTimeout(() => {
    updateTaskProjectNote(id, value, { renderAfter: false, silent: true });
    projectNoteTimers.delete(id);
  }, 700));
}

function updateTaskProjectNote(id, value, options = {}) {
  const task = getTask(id);
  if (!task) return;
  const nextNote = String(value || "").trim();
  if ((task.projectNote || "") === nextNote && !options.forceUpdateEntry) return;

  task.projectNote = nextNote;
  task.updatedAt = new Date().toISOString();
  if (!options.silent) {
    addUpdate(task, nextNote ? `Catatan project: ${nextNote}` : "Catatan project dikosongkan.");
  }
  persist();
  if (options.renderAfter !== false) render();
  if (!options.silent) showToast("Catatan project diperbarui.");
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
  if (status === "done" && !task.projectNote) task.projectNote = "Selesai.";
  addUpdate(task, `Status berubah ke ${statusLabel(status)}.`);
  persist();
  render();
  showToast(`Status: ${statusLabel(status)}.`);
}

function addUpdate(task, text) {
  task.updatedAt = new Date().toISOString();
  task.updates = [
    ...(task.updates || []),
    { date: state.focusDate, text, projectNote: task.projectNote || "" },
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
  const withProjectNote = state.tasks.filter((task) => task.projectNote).length;

  els.totalCount.textContent = total;
  els.activeCount.textContent = active;
  els.doneCount.textContent = done;
  els.overdueCount.textContent = overdue;
  els.projectNoteCount.textContent = withProjectNote;
}

function renderTable() {
  const tasks = getFilteredTasks();
  const groups = groupTasksByDate(tasks);
  let rowNumber = 0;
  const hiddenCount = groups.reduce((sum, group) => sum + (state.hiddenDates.has(group.date) ? group.tasks.length : 0), 0);
  const visibleCount = tasks.length - hiddenCount;

  els.taskTableBody.innerHTML = tasks.length
    ? groups.map((group) => {
      const hidden = state.hiddenDates.has(group.date);
      return `
        ${renderDateGroupRow(group, hidden)}
        ${hidden ? "" : group.tasks.map((task) => renderRow(task, rowNumber++)).join("")}
      `;
    }).join("")
    : `<tr><td class="empty-row" colspan="11">Belum ada tugas yang cocok dengan filter.</td></tr>`;
  els.tableNote.textContent = tableNoteText(tasks.length, visibleCount, hiddenCount, groups.length);
}

function groupTasksByDate(tasks) {
  return tasks.reduce((groups, task) => {
    const date = task.dueDate || "Tanpa deadline";
    const group = groups.find((item) => item.date === date);
    if (group) {
      group.tasks.push(task);
    } else {
      groups.push({ date, tasks: [task] });
    }
    return groups;
  }, []);
}

function renderDateGroupRow(group, hidden) {
  const done = group.tasks.filter((task) => task.status === "done").length;
  const active = group.tasks.length - done;
  const overdue = group.tasks.some(isOverdue);
  const today = group.date === todayInput();
  const meta = [
    `${group.tasks.length} tugas`,
    active ? `${active} aktif` : "",
    done ? `${done} selesai` : "",
    hidden ? "disembunyikan" : "",
  ].filter(Boolean).join(" - ");

  return `
    <tr class="date-group-row ${today ? "date-group-today" : ""} ${overdue ? "date-group-overdue" : ""} ${hidden ? "date-group-hidden" : ""}">
      <td colspan="11">
        <div class="date-group-content">
          <div class="date-group-main">
            <span class="date-group-title">${escapeHtml(dateGroupLabel(group.date))}</span>
            <span class="date-group-meta">${escapeHtml(meta)}</span>
          </div>
          <button
            class="mini-button date-group-toggle"
            type="button"
            data-group-toggle
            data-date="${escapeAttribute(group.date)}"
            aria-expanded="${hidden ? "false" : "true"}"
          >${hidden ? "Tampilkan" : "Sembunyikan"}</button>
        </div>
      </td>
    </tr>
  `;
}

function toggleDateGroup(date) {
  if (!date) return;
  if (state.hiddenDates.has(date)) {
    state.hiddenDates.delete(date);
    showToast(`${dateGroupLabel(date)} ditampilkan.`);
  } else {
    state.hiddenDates.add(date);
    showToast(`${dateGroupLabel(date)} disembunyikan.`);
  }
  saveHiddenDates();
  renderTable();
}

function tableNoteText(total, visible, hidden, days) {
  if (!total) return "0 tugas ditampilkan.";
  if (hidden) return `${visible} dari ${total} tugas ditampilkan. ${hidden} tugas disembunyikan.`;
  return `${total} tugas dalam ${days} hari ditampilkan.`;
}

function renderRow(task, index) {
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
      <td class="project-note-cell">
        <textarea
          data-project-note-input
          data-id="${escapeAttribute(task.id)}"
          rows="2"
          aria-label="Catatan project ${escapeAttribute(task.title)}"
          placeholder="Tulis catatan"
        >${escapeHtml(task.projectNote || "")}</textarea>
      </td>
      <td>${renderAlarmCell(task, alarmDue)}</td>
      <td>${renderDocumentsCell(task)}</td>
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
      const search = `${task.title} ${task.project} ${task.assignee} ${task.notes} ${task.projectNote} ${task.documents}`.toLowerCase();
      if (state.filters.search && !search.includes(state.filters.search)) return false;
      if (state.filters.project && task.project !== state.filters.project) return false;
      if (state.filters.assignee && task.assignee !== state.filters.assignee) return false;
      if (state.filters.status && task.status !== state.filters.status) return false;
      if (state.filters.priority && task.priority !== state.filters.priority) return false;
      return true;
    })
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const dueDateOrder = compareDueDates(a.dueDate, b.dueDate);
      if (dueDateOrder) return dueDateOrder;
      if (a.status === "done" && b.status !== "done") return 1;
      if (a.status !== "done" && b.status === "done") return -1;
      return (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1)
        || a.project.localeCompare(b.project)
        || a.title.localeCompare(b.title);
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
  const projectNote = String(task.projectNote || task.progressNote || legacyProgressNote(task.progress) || "");
  return {
    id: task.id || createId(),
    title: task.title || "Tugas tanpa judul",
    project: task.project || "Project Umum",
    assignee: task.assignee || "Belum ditentukan",
    dueDate: task.dueDate || todayInput(),
    priority: priorities[task.priority] ? task.priority : "medium",
    status: statuses.some((status) => status.key === task.status) ? task.status : "todo",
    projectNote,
    documents: String(task.documents || ""),
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
    projectNote: String(update.projectNote || update.progressNote || legacyProgressNote(update.progress) || ""),
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

function loadHiddenDates() {
  try {
    const dates = JSON.parse(localStorage.getItem(HIDDEN_DATES_KEY) || "[]");
    return new Set(Array.isArray(dates) ? dates.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveHiddenDates() {
  localStorage.setItem(HIDDEN_DATES_KEY, JSON.stringify([...state.hiddenDates]));
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

function renderDocumentsCell(task) {
  const documents = parseDocumentLines(task.documents);
  if (!documents.length) return `<div class="document-cell"><span>Belum ada dokumen</span></div>`;

  return `
    <div class="document-cell">
      ${documents.map((documentText, index) => renderDocumentItem(documentText, index)).join("")}
    </div>
  `;
}

function renderDocumentItem(documentText, index) {
  if (isHttpUrl(documentText)) {
    return `<a href="${escapeAttribute(documentText)}" target="_blank" rel="noopener">Dokumen ${index + 1}</a>`;
  }
  return `<span>${escapeHtml(documentText)}</span>`;
}

function parseDocumentLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

function compareDueDates(firstDate, secondDate) {
  const firstRank = dueDateRank(firstDate);
  const secondRank = dueDateRank(secondDate);
  if (firstRank !== secondRank) return firstRank - secondRank;
  if (firstRank === 1) return String(secondDate || "").localeCompare(String(firstDate || ""));
  return String(firstDate || "").localeCompare(String(secondDate || ""));
}

function dueDateRank(inputDate) {
  if (!inputDate) return 3;
  const today = todayInput();
  if (inputDate === today) return 0;
  if (inputDate < today) return 1;
  return 2;
}

function dateGroupLabel(inputDate) {
  if (!inputDate || inputDate === "Tanpa deadline") return "Tanpa deadline";
  const label = humanDate(inputDate);
  if (inputDate === todayInput()) return `Hari ini - ${label}`;
  if (inputDate === addDays(todayInput(), 1)) return `Besok - ${label}`;
  if (inputDate === addDays(todayInput(), -1)) return `Kemarin - ${label}`;
  return label;
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
  return `Catatan lama: progress ${Math.max(0, Math.min(100, number))}%.`;
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
