const STORAGE_KEY = "cellBenchBookings.v2";
const TABLE_NAME = "bookings";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_DATE = getBeijingDate();
const DAY_START = 0;
const DAY_END = 24 * 60;
const DAY_RANGE = DAY_END - DAY_START;
const REFRESH_INTERVAL_MS = 60 * 1000;
const RECONNECT_DELAY_MS = 5 * 1000;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8";
const XLSX_STYLE = {
  DEFAULT: 0,
  HEADER: 1,
  NUMBER: 2,
  PERCENT: 3,
};

const benches = [
  { id: "west-1-inside", room: "西区细胞房1", position: "里面", color: "#1f7a5c" },
  { id: "west-1-outside", room: "西区细胞房1", position: "外面", color: "#315c9d" },
  { id: "west-2-inside", room: "西区细胞房2", position: "里面", color: "#8a5a12" },
  { id: "west-2-outside", room: "西区细胞房2", position: "外面", color: "#7b3f98" },
  { id: "east-window", room: "东区细胞房", position: "靠窗", color: "#2d7f89" },
  { id: "east-wall", room: "东区细胞房", position: "靠墙", color: "#986330" },
];

let bookings = [];
let selectedDate = DEFAULT_DATE;
let lastKnownBeijingDate = DEFAULT_DATE;
let autoFollowToday = true;
let selectedBenchFilter = "all";
let dataMode = "local";
let supabaseClient = null;
let realtimeChannel = null;
let refreshTimer = null;
let reconnectTimer = null;

const elements = {
  form: document.querySelector("#bookingForm"),
  bookingDate: document.querySelector("#bookingDate"),
  viewDate: document.querySelector("#viewDate"),
  benchSelect: document.querySelector("#benchSelect"),
  benchFilter: document.querySelector("#benchFilter"),
  personInput: document.querySelector("#personInput"),
  startTime: document.querySelector("#startTime"),
  durationSelect: document.querySelector("#durationSelect"),
  formMessage: document.querySelector("#formMessage"),
  submitButton: document.querySelector("#submitButton"),
  scheduleGrid: document.querySelector("#scheduleGrid"),
  bookingCount: document.querySelector("#bookingCount"),
  freeCount: document.querySelector("#freeCount"),
  freeBenchList: document.querySelector("#freeBenchList"),
  daySummary: document.querySelector("#daySummary"),
  copyDayButton: document.querySelector("#copyDayButton"),
  exportStartDate: document.querySelector("#exportStartDate"),
  exportEndDate: document.querySelector("#exportEndDate"),
  exportStartTime: document.querySelector("#exportStartTime"),
  exportEndTime: document.querySelector("#exportEndTime"),
  exportButton: document.querySelector("#exportButton"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  exportMessage: document.querySelector("#exportMessage"),
  storageState: document.querySelector("#storageState"),
  benchTemplate: document.querySelector("#benchTemplate"),
  bookingTemplate: document.querySelector("#bookingTemplate"),
};

init();

async function init() {
  fillBenchOptions();
  fillStartTimeOptions();
  setActiveDate(selectedDate, { syncExport: true, forceStart: true });
  elements.form.addEventListener("submit", handleSubmit);
  elements.viewDate.addEventListener("change", handleDateChange);
  elements.bookingDate.addEventListener("change", handleDateChange);
  elements.benchSelect.addEventListener("change", render);
  elements.startTime.addEventListener("change", render);
  elements.durationSelect.addEventListener("change", render);
  elements.benchFilter.addEventListener("change", handleBenchFilterChange);
  elements.copyDayButton.addEventListener("click", copyCurrentDay);
  elements.exportButton.addEventListener("click", handleExport);
  elements.exportCsvButton.addEventListener("click", handleCsvExport);

  render();
  await startDataLayer();
  render();
}

function getBeijingDate(now = new Date()) {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function setActiveDate(nextDate, options = {}) {
  const previousDate = selectedDate;
  selectedDate = nextDate || getBeijingDate();
  elements.bookingDate.min = getBeijingDate();
  elements.bookingDate.value = selectedDate;
  elements.viewDate.value = selectedDate;

  if (options.syncExport || (elements.exportStartDate.value === previousDate && elements.exportEndDate.value === previousDate)) {
    elements.exportStartDate.value = selectedDate;
    elements.exportEndDate.value = selectedDate;
  }

  syncStartTimeForActiveDate(options);
}

function syncStartTimeForActiveDate(options = {}) {
  const latestStart = DAY_END - 30;
  const currentValue = elements.startTime.value;
  const nextBookableStart = getNextBookableStartMinutes();
  const hasBookableSlotToday = selectedDate !== getBeijingDate() || nextBookableStart <= latestStart;
  const minimumStart = selectedDate === getBeijingDate() ? nextBookableStart : 0;

  if (!hasBookableSlotToday) {
    elements.startTime.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "今天已无可预约时段";
    elements.startTime.append(option);
    return;
  }

  fillStartTimeOptions(minimumStart, latestStart);

  if (options.forceStart || !currentValue || timeToMinutes(currentValue) < minimumStart || timeToMinutes(currentValue) > latestStart) {
    elements.startTime.value = minutesToTime(minimumStart);
  } else {
    elements.startTime.value = currentValue;
  }
}

function getNextBookableStartMinutes(now = new Date()) {
  const shifted = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const totalSeconds =
    shifted.getUTCHours() * 3600 +
    shifted.getUTCMinutes() * 60 +
    shifted.getUTCSeconds() +
    shifted.getUTCMilliseconds() / 1000;
  return Math.ceil(totalSeconds / (30 * 60)) * 30;
}

function createId() {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `booking-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function startDataLayer() {
  setBusy(true);

  if (hasSupabaseConfig()) {
    try {
      await startSupabaseMode();
      return;
    } catch (error) {
      console.error("Supabase setup failed", error);
      showMessage("共享数据库连接失败，已临时切换为本机模式。请检查 config.js 和 Supabase 表设置。", "error");
    } finally {
      setBusy(false);
    }
  }

  startLocalMode();
  setBusy(false);
}

function hasSupabaseConfig() {
  const config = window.CELL_BOOKING_CONFIG || {};
  const url = String(config.supabaseUrl || "").trim();
  const anonKey = String(config.supabaseAnonKey || "").trim();
  return url.startsWith("https://") && anonKey.length > 40 && !url.includes("your-project");
}

async function startSupabaseMode() {
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error("Supabase JS client is not loaded.");
  }

  const config = window.CELL_BOOKING_CONFIG;
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  dataMode = "supabase";
  setStorageState("连接共享库", "loading");

  await fetchRemoteBookings();
  subscribeToRealtime();
  startPeriodicRefresh();
  setStorageState("多人实时", "online");
}

function startLocalMode() {
  stopRemoteTimers();
  dataMode = "local";
  supabaseClient = null;
  bookings = loadLocalBookings();
  setStorageState("本机模式", "local");

  if (!hasSupabaseConfig()) {
    showMessage("未配置 Supabase，当前只保存在本机。填好 config.js 后可启用多人实时同步。", "error");
  }
}

async function fetchRemoteBookings() {
  const { data, error } = await supabaseClient
    .from(TABLE_NAME)
    .select("id,bench_id,booking_date,start_time,end_time,person,created_at")
    .eq("booking_date", selectedDate)
    .order("start_time", { ascending: true });

  if (error) {
    throw error;
  }

  bookings = data.map(fromSupabaseRow);
}

function subscribeToRealtime() {
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabaseClient
    .channel("bookings-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: TABLE_NAME }, handleRealtimePayload)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearReconnectTimer();
        setStorageState("多人实时", "online");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setStorageState("实时断开", "error");
        scheduleRealtimeReconnect();
      }
    });
}

function startPeriodicRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = window.setInterval(async () => {
    if (dataMode !== "supabase" || !supabaseClient) {
      return;
    }

    try {
      handleBeijingDateRollover();
      syncStartTimeForActiveDate();
      await fetchRemoteBookings();
      render();
    } catch (error) {
      console.warn("Periodic refresh failed", error);
      setStorageState("同步异常", "error");
      scheduleRealtimeReconnect();
    }
  }, REFRESH_INTERVAL_MS);
}

function handleBeijingDateRollover() {
  const today = getBeijingDate();
  if (today === lastKnownBeijingDate) {
    return false;
  }

  lastKnownBeijingDate = today;
  if (!autoFollowToday) {
    return false;
  }

  const shouldSyncExport = elements.exportStartDate.value === selectedDate && elements.exportEndDate.value === selectedDate;
  setActiveDate(today, { syncExport: shouldSyncExport });
  showMessage(`已按北京时间切换到 ${today}。`, "success");
  return true;
}

function stopRemoteTimers() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  clearReconnectTimer();
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleRealtimeReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = null;

    if (dataMode !== "supabase" || !supabaseClient) {
      return;
    }

    try {
      setStorageState("重连中", "loading");
      await fetchRemoteBookings();
      subscribeToRealtime();
      render();
    } catch (error) {
      console.warn("Realtime reconnect failed", error);
      setStorageState("实时断开", "error");
      scheduleRealtimeReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

function handleRealtimePayload(payload) {
  if (payload.eventType === "DELETE") {
    const deletedDate = payload.old.booking_date;
    if (deletedDate && deletedDate !== selectedDate) {
      return;
    }
    bookings = bookings.filter((item) => item.id !== payload.old.id);
  } else if (payload.new) {
    const nextBooking = fromSupabaseRow(payload.new);
    if (nextBooking.date !== selectedDate) {
      return;
    }
    upsertBooking(nextBooking);
  }

  render();
}

function loadLocalBookings() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    saveLocalBookings([]);
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    console.warn("Failed to parse saved bookings", error);
  }

  saveLocalBookings([]);
  return [];
}

function saveLocalBookings(nextBookings = bookings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBookings));
}

function fillBenchOptions() {
  elements.benchSelect.innerHTML = "";
  elements.benchFilter.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "全部细胞台";
  elements.benchFilter.append(allOption);

  benches.forEach((bench) => {
    const option = document.createElement("option");
    option.value = bench.id;
    option.textContent = `${bench.room} ${bench.position}`;
    elements.benchSelect.append(option);

    const filterOption = option.cloneNode(true);
    elements.benchFilter.append(filterOption);
  });
}

function fillStartTimeOptions(startMinutes = 0, endMinutes = DAY_END - 30) {
  elements.startTime.innerHTML = "";
  const safeStart = Math.max(0, Math.min(startMinutes, endMinutes));

  for (let minutes = safeStart; minutes <= endMinutes; minutes += 30) {
    const option = document.createElement("option");
    option.value = minutesToTime(minutes);
    option.textContent = minutesToTime(minutes);
    elements.startTime.append(option);
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const nextBooking = {
    id: createId(),
    benchId: elements.benchSelect.value,
    date: elements.bookingDate.value,
    person: elements.personInput.value.trim(),
    start: elements.startTime.value,
    end: calculateEndTime(elements.startTime.value, elements.durationSelect.value),
    createdAt: new Date().toISOString(),
  };

  const validation = validateBooking(nextBooking);
  if (!validation.ok) {
    showMessage(validation.message, "error");
    return;
  }

  setBusy(true);
  const result = await saveNewBooking(nextBooking);
  setBusy(false);

  if (!result.ok) {
    showMessage(result.message, "error");
    return;
  }

  selectedDate = nextBooking.date;
  autoFollowToday = selectedDate === getBeijingDate();
  setActiveDate(selectedDate);
  elements.personInput.value = "";
  showMessage(dataMode === "supabase" ? "预约已同步给所有人。" : "预约已添加到本机。", "success");
  render();
}

async function saveNewBooking(nextBooking) {
  if (dataMode === "supabase") {
    const { data, error } = await supabaseClient
      .from(TABLE_NAME)
      .insert(toSupabaseRow(nextBooking))
      .select()
      .single();

    if (error) {
      return { ok: false, message: mapDatabaseError(error) };
    }

    upsertBooking(fromSupabaseRow(data));
    return { ok: true };
  }

  bookings = [...bookings, nextBooking];
  saveLocalBookings();
  return { ok: true };
}

function validateBooking(nextBooking) {
  if (!nextBooking.date || !nextBooking.benchId || !nextBooking.person || !nextBooking.start || !nextBooking.end) {
    return { ok: false, message: "请把日期、细胞台、姓名、开始时间和使用时长填写完整。" };
  }

  if (nextBooking.person.length > 40) {
    return { ok: false, message: "预约人姓名请控制在 40 个字符以内。" };
  }

  const start = timeToMinutes(nextBooking.start);
  const end = timeToMinutes(nextBooking.end);
  const today = getBeijingDate();
  if (nextBooking.date < today) {
    return { ok: false, message: "不能预约已经过去的日期。" };
  }

  const nextBookableStart = getNextBookableStartMinutes();
  if (nextBooking.date === today && nextBookableStart > DAY_END - 30) {
    return { ok: false, message: "今天已无可预约时段，请预约明天。" };
  }

  if (nextBooking.date === today && start < nextBookableStart) {
    return { ok: false, message: `不能预约已经过去的时间，请选择 ${minutesToTime(nextBookableStart)} 之后。` };
  }

  if (start % 30 !== 0) {
    return { ok: false, message: "开始时间请按半小时选择，例如 09:00 或 09:30。" };
  }

  if (end <= start) {
    return { ok: false, message: "使用时长至少需要 30 分钟。" };
  }

  if (end - start < 30) {
    return { ok: false, message: "一次预约最少 30 分钟。" };
  }

  if (end > DAY_END) {
    return { ok: false, message: "预约不能跨到第二天，请缩短使用时长或提前开始。" };
  }

  const conflict = findConflict(nextBooking);
  if (conflict) {
    return {
      ok: false,
      message: `与 ${conflict.person} 的 ${conflict.start}-${conflict.end} 预约冲突。`,
    };
  }

  return { ok: true };
}

function findConflict(nextBooking) {
  const start = timeToMinutes(nextBooking.start);
  const end = timeToMinutes(nextBooking.end);

  return bookings.find((existing) => {
    if (existing.id === nextBooking.id || existing.date !== nextBooking.date || existing.benchId !== nextBooking.benchId) {
      return false;
    }

    const existingStart = timeToMinutes(existing.start);
    const existingEnd = timeToMinutes(existing.end);
    return start < existingEnd && end > existingStart;
  });
}

function hasExactBooking(nextBooking) {
  return bookings.some((existing) => {
    return (
      existing.date === nextBooking.date &&
      existing.benchId === nextBooking.benchId &&
      existing.start === nextBooking.start &&
      existing.end === nextBooking.end &&
      existing.person === nextBooking.person
    );
  });
}

async function handleDateChange(event) {
  const nextDate = event.target.value || getBeijingDate();
  autoFollowToday = nextDate === getBeijingDate();
  setActiveDate(nextDate);
  clearMessage();

  if (dataMode === "supabase" && supabaseClient) {
    try {
      setStorageState("同步中", "loading");
      await fetchRemoteBookings();
      setStorageState("多人实时", "online");
    } catch (error) {
      console.warn("Date refresh failed", error);
      setStorageState("同步异常", "error");
      showMessage("当前日期数据刷新失败，请检查网络后重试。", "error");
    }
  }

  render();
}

function handleBenchFilterChange(event) {
  selectedBenchFilter = event.target.value || "all";
  render();
}

function render() {
  const dayBookings = bookings
    .filter((item) => item.date === selectedDate)
    .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  const visibleBenches = getVisibleBenches();
  const slotAvailability = getSlotAvailability(dayBookings);

  elements.scheduleGrid.innerHTML = "";
  elements.daySummary.textContent = getDaySummary(dayBookings.length);
  elements.bookingCount.textContent = String(dayBookings.length);
  elements.freeCount.textContent = slotAvailability.countText;
  elements.freeBenchList.textContent = slotAvailability.message;

  visibleBenches.forEach((bench) => {
    const benchBookings = dayBookings.filter((item) => item.benchId === bench.id);
    elements.scheduleGrid.append(renderBench(bench, benchBookings));
  });

}

function getVisibleBenches() {
  if (selectedBenchFilter === "all") {
    return benches;
  }

  return benches.filter((bench) => bench.id === selectedBenchFilter);
}

function getDaySummary(count) {
  if (selectedBenchFilter === "all") {
    return `${formatDate(selectedDate)}，共 ${count} 条预约`;
  }

  const bench = benches.find((item) => item.id === selectedBenchFilter);
  const label = bench ? `${bench.room} ${bench.position}` : "筛选细胞台";
  return `${formatDate(selectedDate)}，${label}`;
}

function getSlotAvailability(dayBookings) {
  const start = elements.startTime.value;
  const end = calculateEndTime(start, elements.durationSelect.value);

  if (!start || !end) {
    return { countText: "-", message: selectedDate === getBeijingDate() ? "今天已无可预约时段" : "选择开始时间和使用时长后显示" };
  }

  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  if (selectedDate === getBeijingDate() && startMinutes < getNextBookableStartMinutes()) {
    return { countText: "-", message: `请选择 ${minutesToTime(getNextBookableStartMinutes())} 之后的时段` };
  }

  if (startMinutes % 30 !== 0) {
    return { countText: "-", message: "开始时间请按半小时选择" };
  }

  if (endMinutes <= startMinutes || endMinutes > DAY_END) {
    return { countText: "0", message: "所选时长超出当天，请缩短时长" };
  }

  const freeBenches = benches.filter((bench) => {
    return !dayBookings.some((booking) => {
      if (booking.benchId !== bench.id) {
        return false;
      }

      const existingStart = timeToMinutes(booking.start);
      const existingEnd = timeToMinutes(booking.end);
      return startMinutes < existingEnd && endMinutes > existingStart;
    });
  });

  if (freeBenches.length === 0) {
    return { countText: "0", message: `${start}-${end} 全部已占用` };
  }

  const selectedBench = benches.find((bench) => bench.id === elements.benchSelect.value);
  const selectedIsFree = selectedBench ? freeBenches.some((bench) => bench.id === selectedBench.id) : false;
  const statusText = selectedBench && !selectedIsFree ? "当前选择已占用；空闲：" : "当前选择可用；空闲：";

  return {
    countText: String(freeBenches.length),
    message: `${start}-${end} ${statusText}${freeBenches.map((bench) => `${bench.room} ${bench.position}`).join("、")}`,
  };
}

function renderBench(bench, benchBookings) {
  const node = elements.benchTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector("h3").textContent = bench.room;
  node.querySelector("p").textContent = bench.position;
  node.querySelector(".bench-status").textContent = benchBookings.length ? `${benchBookings.length} 条` : "空闲";

  const timeline = node.querySelector(".timeline");
  const list = node.querySelector(".booking-list");

  if (benchBookings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前日期暂无预约";
    list.append(empty);
    return node;
  }

  benchBookings.forEach((item) => {
    timeline.append(renderTimelineBlock(item, bench));
    list.append(renderBookingItem(item));
  });

  return node;
}

function renderTimelineBlock(item, bench) {
  const block = document.createElement("div");
  const start = clamp(timeToMinutes(item.start), DAY_START, DAY_END);
  const end = clamp(timeToMinutes(item.end), DAY_START, DAY_END);
  const left = ((start - DAY_START) / DAY_RANGE) * 100;
  const width = ((end - start) / DAY_RANGE) * 100;
  block.className = "timeline-block";
  block.style.left = `${left.toFixed(3)}%`;
  block.style.width = `max(16px, ${width.toFixed(3)}%)`;
  block.style.setProperty("--block-color", bench.color);
  block.title = `${item.person} ${item.start}-${item.end}`;
  block.innerHTML = `${escapeHtml(item.person)}<span>${item.start}-${item.end}</span>`;
  return block;
}

function renderBookingItem(item) {
  const node = elements.bookingTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".booking-time").textContent = `${item.start}-${item.end}`;
  node.querySelector(".booking-person").textContent = item.person;
  node.querySelector(".delete-booking").addEventListener("click", () => deleteBooking(item.id));
  return node;
}

async function deleteBooking(id) {
  const target = bookings.find((item) => item.id === id);
  if (!target) {
    return;
  }

  const confirmed = window.confirm(`删除 ${target.person} 的 ${target.start}-${target.end} 预约？`);
  if (!confirmed) {
    return;
  }

  setBusy(true);

  if (dataMode === "supabase") {
    const { error } = await supabaseClient.from(TABLE_NAME).delete().eq("id", id);
    setBusy(false);

    if (error) {
      showMessage(mapDatabaseError(error), "error");
      return;
    }
  } else {
    bookings = bookings.filter((item) => item.id !== id);
    saveLocalBookings();
    setBusy(false);
  }

  bookings = bookings.filter((item) => item.id !== id);
  showMessage("预约已删除。", "success");
  render();
}

async function copyCurrentDay() {
  const dayBookings = bookings
    .filter((item) => item.date === selectedDate)
    .sort((a, b) => {
      if (a.benchId === b.benchId) {
        return timeToMinutes(a.start) - timeToMinutes(b.start);
      }
      return benches.findIndex((bench) => bench.id === a.benchId) - benches.findIndex((bench) => bench.id === b.benchId);
    });

  const lines = ["细胞房超净台预约", formatDate(selectedDate), ""];
  benches.forEach((bench) => {
    const items = dayBookings.filter((item) => item.benchId === bench.id);
    lines.push(`${bench.room} ${bench.position}`);
    if (items.length === 0) {
      lines.push("暂无预约");
    } else {
      items.forEach((item) => lines.push(`${item.start}-${item.end} ${item.person}`));
    }
    lines.push("");
  });

  const text = lines.join("\n").trim();
  try {
    await navigator.clipboard.writeText(text);
    showMessage("当前日期预约已复制。", "success");
  } catch (error) {
    console.warn("Clipboard failed", error);
    showMessage("浏览器未允许复制，可以手动选中页面内容复制。", "error");
  }
}

async function handleExport() {
  const range = getExportRange();
  if (!range.ok) {
    showExportMessage(range.message, "error");
    return;
  }

  setExportBusy(true);
  clearExportMessage();

  try {
    const exportBookings = await fetchExportBookings(range);
    const sheets = buildExportWorkbookSheets(exportBookings, range);
    const fileName = buildExportFileName(range);
    downloadXlsx(sheets, fileName);

    if (exportBookings.length === 0) {
      showExportMessage("Excel 已导出；所选范围内没有预约记录，使用率为 0%。", "success");
    } else {
      showExportMessage(`已导出 Excel：${exportBookings.length} 条预约记录，并包含区间使用率柱状图。`, "success");
    }
  } catch (error) {
    console.error("Export failed", error);
    showExportMessage("导出失败，请检查网络后重试。", "error");
  } finally {
    setExportBusy(false);
  }
}

async function handleCsvExport() {
  const range = getExportRange();
  if (!range.ok) {
    showExportMessage(range.message, "error");
    return;
  }

  setExportBusy(true);
  clearExportMessage();

  try {
    const exportBookings = await fetchExportBookings(range);
    const rows = buildCsvRows(exportBookings, range);
    const fileName = buildCsvFileName(range);
    downloadCsv(rows, fileName);

    if (exportBookings.length === 0) {
      showExportMessage("CSV 已导出；所选范围内没有预约记录，使用率为 0%。", "success");
    } else {
      showExportMessage(`已导出 CSV：${exportBookings.length} 条预约记录，并统计每日每台使用率。`, "success");
    }
  } catch (error) {
    console.error("CSV export failed", error);
    showExportMessage("CSV 导出失败，请检查网络后重试。", "error");
  } finally {
    setExportBusy(false);
  }
}

function getExportRange() {
  const startDate = elements.exportStartDate.value;
  const endDate = elements.exportEndDate.value;
  const startTime = elements.exportStartTime.value;
  const endTime = elements.exportEndTime.value;

  if (!startDate || !endDate || !startTime || !endTime) {
    return { ok: false, message: "请填写完整的导出日期和时间范围。" };
  }

  if (endDate < startDate) {
    return { ok: false, message: "结束日期不能早于开始日期。" };
  }

  if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    return { ok: false, message: "结束时间必须晚于开始时间。" };
  }

  return { ok: true, startDate, endDate, startTime, endTime };
}

async function fetchExportBookings(range) {
  let sourceBookings = [];

  if (dataMode === "supabase" && supabaseClient) {
    const { data, error } = await supabaseClient
      .from(TABLE_NAME)
      .select("id,bench_id,booking_date,start_time,end_time,person,created_at")
      .gte("booking_date", range.startDate)
      .lte("booking_date", range.endDate)
      .order("booking_date", { ascending: true })
      .order("start_time", { ascending: true })
      .limit(5000);

    if (error) {
      throw error;
    }

    sourceBookings = data.map(fromSupabaseRow);
  } else {
    sourceBookings = loadLocalBookings();
  }

  return sourceBookings
    .filter((item) => {
      return item.date >= range.startDate && item.date <= range.endDate && bookingOverlapsTimeRange(item, range);
    })
    .sort(compareBookings);
}

function bookingOverlapsTimeRange(item, range) {
  const bookingStart = timeToMinutes(item.start);
  const bookingEnd = timeToMinutes(item.end);
  const rangeStart = getExportStartMinutes(range);
  const rangeEnd = getExportEndMinutes(range);
  return bookingStart < rangeEnd && bookingEnd > rangeStart;
}

function getExportStartMinutes(range) {
  return timeToMinutes(range.startTime);
}

function getExportEndMinutes(range) {
  return range.endTime === "23:59" ? DAY_END : timeToMinutes(range.endTime);
}

function compareBookings(a, b) {
  if (a.date !== b.date) {
    return a.date.localeCompare(b.date);
  }

  if (a.benchId !== b.benchId) {
    return benches.findIndex((bench) => bench.id === a.benchId) - benches.findIndex((bench) => bench.id === b.benchId);
  }

  return timeToMinutes(a.start) - timeToMinutes(b.start);
}

function buildExportRows(exportBookings) {
  const rows = [["日期", "细胞房", "位置", "细胞台", "开始时间", "结束时间", "预约人", "创建时间"]];

  exportBookings.forEach((item) => {
    const bench = benches.find((candidate) => candidate.id === item.benchId);
    const room = bench ? bench.room : item.benchId;
    const position = bench ? bench.position : "";
    rows.push([
      item.date,
      room,
      position,
      `${room} ${position}`.trim(),
      item.start,
      item.end,
      item.person,
      formatCreatedAt(item.createdAt),
    ]);
  });

  return rows;
}

function buildExportWorkbookSheets(exportBookings, range) {
  const summaryRows = buildPeriodUtilizationRows(exportBookings, range, { format: "workbook" });
  const summaryDataStartRow = 4;
  const summaryDataEndRow = summaryRows.length;

  return [
    {
      name: "区间汇总",
      rows: summaryRows,
      headerRows: [3],
      autoFilterRow: 3,
      columnWidths: [16, 10, 22, 12, 12, 18, 18, 14],
      chart: {
        title: "所选区间细胞台使用率",
        seriesName: "统计窗口使用率",
        categoryColumn: 3,
        valueColumn: 7,
        startRow: summaryDataStartRow,
        endRow: summaryDataEndRow,
      },
    },
    {
      name: "每日使用率",
      rows: buildUtilizationRows(exportBookings, range, { format: "workbook" }),
      headerRows: [1],
      autoFilterRow: 1,
      columnWidths: [14, 16, 10, 22, 12, 12, 16, 16, 14],
    },
    {
      name: "预约明细",
      rows: buildExportRows(exportBookings),
      headerRows: [1],
      autoFilterRow: 1,
      columnWidths: [14, 16, 10, 22, 12, 12, 14, 24],
    },
  ];
}

function buildCsvRows(exportBookings, range) {
  return [
    ["预约明细"],
    ...buildExportRows(exportBookings),
    [],
    ["所选区间每台使用率"],
    ...buildPeriodUtilizationRows(exportBookings, range),
    [],
    ["每日每台使用率"],
    ...buildUtilizationRows(exportBookings, range),
  ];
}

function buildPeriodUtilizationRows(exportBookings, range, options = {}) {
  const workbookMode = options.format === "workbook";
  const dateCount = getDateRange(range.startDate, range.endDate).length;
  const windowMinutes = getExportEndMinutes(range) - getExportStartMinutes(range);
  const totalWindowMinutes = windowMinutes * dateCount;
  const totalDayMinutes = DAY_RANGE * dateCount;
  const usageMap = buildBenchUsageMap(exportBookings, range);
  const rows = [];

  if (workbookMode) {
    rows.push(["日期范围", `${range.startDate} 至 ${range.endDate}`, "每天统计时间", `${range.startTime}-${range.endTime}`, "统计天数", numberCell(dateCount)]);
    rows.push([]);
  }

  rows.push(["细胞房", "位置", "细胞台", "使用分钟", "使用小时", "统计窗口可用分钟", "统计窗口使用率", "全天使用率"]);

  benches.forEach((bench) => {
    const usedMinutes = usageMap.get(bench.id) || 0;
    rows.push(
      buildUtilizationDataRow({
        date: null,
        bench,
        usedMinutes,
        windowMinutes: totalWindowMinutes,
        dayMinutes: totalDayMinutes,
        workbookMode,
      }),
    );
  });

  return rows;
}

function buildUtilizationRows(exportBookings, range, options = {}) {
  const workbookMode = options.format === "workbook";
  const rows = [["日期", "细胞房", "位置", "细胞台", "使用分钟", "使用小时", "统计窗口分钟", "统计窗口使用率", "全天使用率"]];
  const usageMap = buildUsageMap(exportBookings, range);
  const windowMinutes = getExportEndMinutes(range) - getExportStartMinutes(range);

  getDateRange(range.startDate, range.endDate).forEach((date) => {
    benches.forEach((bench) => {
      const usedMinutes = usageMap.get(buildUsageKey(date, bench.id)) || 0;
      rows.push(
        buildUtilizationDataRow({
          date,
          bench,
          usedMinutes,
          windowMinutes,
          dayMinutes: DAY_RANGE,
          workbookMode,
        }),
      );
    });
  });

  return rows;
}

function buildUtilizationDataRow({ date, bench, usedMinutes, windowMinutes, dayMinutes, workbookMode }) {
  const textCells = [bench.room, bench.position, `${bench.room} ${bench.position}`.trim()];
  const numberCells = workbookMode
    ? [
        numberCell(usedMinutes),
        numberCell(usedMinutes / 60, XLSX_STYLE.NUMBER),
        numberCell(windowMinutes),
        percentCell(usedMinutes / windowMinutes),
        percentCell(usedMinutes / dayMinutes),
      ]
    : [
        usedMinutes,
        (usedMinutes / 60).toFixed(2),
        windowMinutes,
        formatPercent(usedMinutes / windowMinutes),
        formatPercent(usedMinutes / dayMinutes),
      ];

  return date ? [date, ...textCells, ...numberCells] : [...textCells, ...numberCells];
}

function buildUsageMap(exportBookings, range) {
  const usageMap = new Map();

  exportBookings.forEach((item) => {
    const usedMinutes = getBookingMinutesWithinRange(item, range);
    if (usedMinutes <= 0) {
      return;
    }

    const key = buildUsageKey(item.date, item.benchId);
    usageMap.set(key, (usageMap.get(key) || 0) + usedMinutes);
  });

  return usageMap;
}

function buildBenchUsageMap(exportBookings, range) {
  const usageMap = new Map();

  exportBookings.forEach((item) => {
    const usedMinutes = getBookingMinutesWithinRange(item, range);
    if (usedMinutes <= 0) {
      return;
    }

    usageMap.set(item.benchId, (usageMap.get(item.benchId) || 0) + usedMinutes);
  });

  return usageMap;
}

function getBookingMinutesWithinRange(item, range) {
  const bookingStart = clamp(timeToMinutes(item.start), DAY_START, DAY_END);
  const bookingEnd = clamp(timeToMinutes(item.end), DAY_START, DAY_END);
  const rangeStart = getExportStartMinutes(range);
  const rangeEnd = getExportEndMinutes(range);
  return Math.max(0, Math.min(bookingEnd, rangeEnd) - Math.max(bookingStart, rangeStart));
}

function buildUsageKey(date, benchId) {
  return `${date}::${benchId}`;
}

function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);

  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "0.00%";
  }

  return `${(value * 100).toFixed(2)}%`;
}

function numberCell(value, styleId = XLSX_STYLE.DEFAULT) {
  return {
    type: "number",
    value: Number.isFinite(value) ? value : 0,
    styleId,
  };
}

function percentCell(value) {
  return numberCell(Number.isFinite(value) ? value : 0, XLSX_STYLE.PERCENT);
}

function buildExportFileName(range) {
  return `${buildExportBaseName(range)}.xlsx`;
}

function buildCsvFileName(range) {
  return `${buildExportBaseName(range)}.csv`;
}

function buildExportBaseName(range) {
  const startTime = range.startTime.replace(":", "");
  const endTime = range.endTime.replace(":", "");
  return `cell-bench-bookings_${range.startDate}_${range.endDate}_${startTime}-${endTime}`;
}

function downloadXlsx(sheetNameOrSheets, rowsOrFileName, maybeFileName) {
  const sheets = Array.isArray(sheetNameOrSheets) ? sheetNameOrSheets : [{ name: sheetNameOrSheets, rows: rowsOrFileName }];
  const fileName = Array.isArray(sheetNameOrSheets) ? rowsOrFileName : maybeFileName;
  const files = createXlsxFiles(sheets);
  const zipBytes = createStoredZip(files);
  const blob = new Blob([zipBytes], { type: XLSX_MIME });
  downloadBlob(blob, fileName);
}

function downloadCsv(rows, fileName) {
  const csvText = `\uFEFF${rowsToCsv(rows)}`;
  const blob = new Blob([csvText], { type: CSV_MIME });
  downloadBlob(blob, fileName);
}

function rowsToCsv(rows) {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

function escapeCsvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createXlsxFiles(inputSheets) {
  const sheets = normalizeWorkbookSheets(inputSheets);
  let chartIndex = 0;

  sheets.forEach((sheet, index) => {
    sheet.sheetIndex = index + 1;
    if (sheet.chart) {
      chartIndex += 1;
      sheet.drawingId = chartIndex;
      sheet.chartId = chartIndex;
      sheet.drawingRelId = "rId1";
    }
  });

  return [
    {
      name: "[Content_Types].xml",
      content: createContentTypesXml(sheets),
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: "docProps/app.xml",
      content: createAppPropertiesXml(sheets),
    },
    {
      name: "docProps/core.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>细胞房超净台预约记录</dc:title>
  <dc:creator>Cellroom Booking</dc:creator>
  <cp:lastModifiedBy>Cellroom Booking</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
    },
    {
      name: "xl/workbook.xml",
      content: createWorkbookXml(sheets),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: createWorkbookRelationshipsXml(sheets),
    },
    {
      name: "xl/styles.xml",
      content: createStylesXml(),
    },
    ...sheets.flatMap((sheet) => {
      const files = [
        {
          name: `xl/worksheets/sheet${sheet.sheetIndex}.xml`,
          content: createWorksheetXml(sheet),
        },
      ];

      if (sheet.chart) {
        files.push(
          {
            name: `xl/worksheets/_rels/sheet${sheet.sheetIndex}.xml.rels`,
            content: createWorksheetRelationshipsXml(sheet),
          },
          {
            name: `xl/drawings/drawing${sheet.drawingId}.xml`,
            content: createDrawingXml(sheet),
          },
          {
            name: `xl/drawings/_rels/drawing${sheet.drawingId}.xml.rels`,
            content: createDrawingRelationshipsXml(sheet),
          },
          {
            name: `xl/charts/chart${sheet.chartId}.xml`,
            content: createChartXml(sheet),
          },
        );
      }

      return files;
    }),
  ];
}

function normalizeWorkbookSheets(inputSheets) {
  const usedNames = new Set();
  return inputSheets.map((sheet, index) => {
    const name = getUniqueSheetName(sheet.name || `Sheet${index + 1}`, usedNames);
    return {
      ...sheet,
      name,
      rows: sheet.rows && sheet.rows.length ? sheet.rows : [[]],
      headerRows: sheet.headerRows || [1],
    };
  });
}

function getUniqueSheetName(name, usedNames) {
  const baseName = sanitizeSheetName(name);
  let nextName = baseName;
  let counter = 2;

  while (usedNames.has(nextName)) {
    const suffix = ` ${counter}`;
    nextName = `${baseName.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }

  usedNames.add(nextName);
  return nextName;
}

function createContentTypesXml(sheets) {
  const worksheetOverrides = sheets
    .map((sheet) => `  <Override PartName="/xl/worksheets/sheet${sheet.sheetIndex}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("\n");
  const drawingOverrides = sheets
    .filter((sheet) => sheet.chart)
    .map(
      (sheet) => `  <Override PartName="/xl/drawings/drawing${sheet.drawingId}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
  <Override PartName="/xl/charts/chart${sheet.chartId}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${worksheetOverrides}
${drawingOverrides}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function createAppPropertiesXml(sheets) {
  const sheetNames = sheets.map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Cellroom Booking</Application>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="${sheets.length}" baseType="lpstr">${sheetNames}</vt:vector>
  </TitlesOfParts>
</Properties>`;
}

function createWorkbookXml(sheets) {
  const sheetXml = sheets
    .map((sheet) => `    <sheet name="${escapeXml(sheet.name)}" sheetId="${sheet.sheetIndex}" r:id="rId${sheet.sheetIndex}"/>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${sheetXml}
  </sheets>
  <calcPr calcId="124519" fullCalcOnLoad="1"/>
</workbook>`;
}

function createWorkbookRelationshipsXml(sheets) {
  const worksheetRels = sheets
    .map((sheet) => `  <Relationship Id="rId${sheet.sheetIndex}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheet.sheetIndex}.xml"/>`)
    .join("\n");
  const stylesRelId = sheets.length + 1;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${worksheetRels}
  <Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function createStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
}

function createWorksheetXml(sheet) {
  const rows = sheet.rows;
  const lastColumn = getColumnName(getMaxColumnCount(rows));
  const lastRow = Math.max(1, rows.length);
  const sheetData = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row
        .map((value, columnIndex) => {
          const cellRef = `${getColumnName(columnIndex + 1)}${rowNumber}`;
          return createCellXml(value, cellRef, rowNumber, sheet);
        })
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  ${createColumnsXml(sheet, lastColumn)}
  <sheetData>${sheetData}</sheetData>
  ${createAutoFilterXml(sheet, lastColumn, lastRow)}
  ${sheet.chart ? `<drawing r:id="${sheet.drawingRelId}"/>` : ""}
</worksheet>`;
}

function getMaxColumnCount(rows) {
  return Math.max(1, ...rows.map((row) => row.length));
}

function createCellXml(value, cellRef, rowNumber, sheet) {
  const isHeaderCell = sheet.headerRows.includes(rowNumber);
  const cell = normalizeCell(value, isHeaderCell);
  const styleAttribute = cell.styleId ? ` s="${cell.styleId}"` : "";

  if (cell.type === "number") {
    return `<c r="${cellRef}"${styleAttribute}><v>${formatXlsxNumber(cell.value)}</v></c>`;
  }

  const spaceAttribute = /^\s|\s$/.test(cell.value) ? ' xml:space="preserve"' : "";
  return `<c r="${cellRef}"${styleAttribute} t="inlineStr"><is><t${spaceAttribute}>${escapeXml(cell.value)}</t></is></c>`;
}

function normalizeCell(value, isHeaderCell) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.type === "number") {
    return {
      type: "number",
      value: Number.isFinite(value.value) ? value.value : 0,
      styleId: value.styleId || 0,
    };
  }

  if (typeof value === "number") {
    return {
      type: "number",
      value,
      styleId: 0,
    };
  }

  return {
    type: "string",
    value: String(value ?? ""),
    styleId: isHeaderCell ? XLSX_STYLE.HEADER : 0,
  };
}

function createColumnsXml(sheet, lastColumnName) {
  const lastColumnNumber = columnNameToNumber(lastColumnName);
  const widths = sheet.columnWidths || [];
  const columns = Array.from({ length: lastColumnNumber }, (_, index) => {
    const columnNumber = index + 1;
    const width = widths[index] || 14;
    return `    <col min="${columnNumber}" max="${columnNumber}" width="${width}" customWidth="1"/>`;
  }).join("\n");

  return `<cols>
${columns}
  </cols>`;
}

function createAutoFilterXml(sheet, lastColumn, lastRow) {
  if (sheet.autoFilter === false) {
    return "";
  }

  const autoFilterRow = sheet.autoFilterRow || 1;
  if (lastRow < autoFilterRow) {
    return "";
  }

  return `<autoFilter ref="A${autoFilterRow}:${lastColumn}${lastRow}"/>`;
}

function createWorksheetRelationshipsXml(sheet) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="${sheet.drawingRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${sheet.drawingId}.xml"/>
</Relationships>`;
}

function createDrawingXml(sheet) {
  const fromRow = Math.max(sheet.rows.length + 1, 11);
  const toRow = fromRow + 18;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="使用率柱状图"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm>
        <a:off x="0" y="0"/>
        <a:ext cx="0" cy="0"/>
      </xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;
}

function createDrawingRelationshipsXml(sheet) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${sheet.chartId}.xml"/>
</Relationships>`;
}

function createChartXml(sheet) {
  const chart = sheet.chart;
  const categoryRange = createCellRangeFormula(sheet.name, chart.categoryColumn, chart.startRow, chart.endRow);
  const valueRange = createCellRangeFormula(sheet.name, chart.valueColumn, chart.startRow, chart.endRow);
  const categories = getChartCategoryValues(sheet, chart);
  const values = getChartNumberValues(sheet, chart);
  const categoryAxisId = 48650112;
  const valueAxisId = 48672768;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:date1904 val="0"/>
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx>
      <c:layout/>
    </c:title>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:varyColors val="0"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:v>${escapeXml(chart.seriesName)}</c:v></c:tx>
          <c:cat>
            <c:strRef>
              <c:f>${escapeXml(categoryRange)}</c:f>
              ${createStringCacheXml(categories)}
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>${escapeXml(valueRange)}</c:f>
              ${createNumberCacheXml(values)}
            </c:numRef>
          </c:val>
        </c:ser>
        <c:dLbls>
          <c:showLegendKey val="0"/>
          <c:showVal val="0"/>
          <c:showCatName val="0"/>
          <c:showSerName val="0"/>
          <c:showPercent val="0"/>
          <c:showBubbleSize val="0"/>
        </c:dLbls>
        <c:axId val="${categoryAxisId}"/>
        <c:axId val="${valueAxisId}"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="${categoryAxisId}"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="b"/>
        <c:tickLblPos val="nextTo"/>
        <c:crossAx val="${valueAxisId}"/>
        <c:crosses val="autoZero"/>
        <c:auto val="1"/>
        <c:lblAlgn val="ctr"/>
        <c:lblOffset val="100"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="${valueAxisId}"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="l"/>
        <c:numFmt formatCode="0%" sourceLinked="0"/>
        <c:majorGridlines/>
        <c:tickLblPos val="nextTo"/>
        <c:crossAx val="${categoryAxisId}"/>
        <c:crosses val="autoZero"/>
      </c:valAx>
    </c:plotArea>
    <c:legend>
      <c:legendPos val="b"/>
      <c:layout/>
    </c:legend>
    <c:plotVisOnly val="1"/>
  </c:chart>
</c:chartSpace>`;
}

function getChartCategoryValues(sheet, chart) {
  return getChartRangeValues(sheet, chart.categoryColumn, chart.startRow, chart.endRow).map((value) => String(value ?? ""));
}

function getChartNumberValues(sheet, chart) {
  return getChartRangeValues(sheet, chart.valueColumn, chart.startRow, chart.endRow).map((value) => {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  });
}

function getChartRangeValues(sheet, columnNumber, startRow, endRow) {
  const columnIndex = columnNumber - 1;
  const values = [];

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const cell = sheet.rows[rowNumber - 1]?.[columnIndex];
    values.push(getCellValue(cell));
  }

  return values;
}

function getCellValue(cell) {
  if (cell && typeof cell === "object" && !Array.isArray(cell) && Object.prototype.hasOwnProperty.call(cell, "value")) {
    return cell.value;
  }

  return cell;
}

function createCellRangeFormula(sheetName, columnNumber, startRow, endRow) {
  const columnName = getColumnName(columnNumber);
  return `${quoteSheetName(sheetName)}!$${columnName}$${startRow}:$${columnName}$${endRow}`;
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

function createStringCacheXml(values) {
  const points = values.map((value, index) => `<c:pt idx="${index}"><c:v>${escapeXml(value)}</c:v></c:pt>`).join("");
  return `<c:strCache><c:ptCount val="${values.length}"/>${points}</c:strCache>`;
}

function createNumberCacheXml(values) {
  const points = values.map((value, index) => `<c:pt idx="${index}"><c:v>${formatXlsxNumber(value)}</c:v></c:pt>`).join("");
  return `<c:numCache><c:formatCode>0.00%</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numCache>`;
}

function formatXlsxNumber(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return String(Math.round(value * 1000000000000) / 1000000000000);
}

function createStoredZip(files) {
  const textEncoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = textEncoder.encode(file.name);
    const dataBytes = textEncoder.encode(file.content);
    const crc = crc32(dataBytes);
    const localHeader = createLocalFileHeader(nameBytes, dataBytes, crc);
    const centralHeader = createCentralDirectoryHeader(nameBytes, dataBytes, crc, offset);
    localParts.push(localHeader, dataBytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  });

  const centralDirectory = concatUint8Arrays(centralParts);
  const endRecord = createEndOfCentralDirectory(files.length, centralDirectory.length, offset);
  return concatUint8Arrays([...localParts, centralDirectory, endRecord]);
}

function createLocalFileHeader(nameBytes, dataBytes, crc) {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, 0x04034b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 0x0800);
  writeUint16(view, 8, 0);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, 33);
  writeUint32(view, 14, crc);
  writeUint32(view, 18, dataBytes.length);
  writeUint32(view, 22, dataBytes.length);
  writeUint16(view, 26, nameBytes.length);
  writeUint16(view, 28, 0);
  header.set(nameBytes, 30);
  return header;
}

function createCentralDirectoryHeader(nameBytes, dataBytes, crc, localOffset) {
  const header = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, 0x02014b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 20);
  writeUint16(view, 8, 0x0800);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, 0);
  writeUint16(view, 14, 33);
  writeUint32(view, 16, crc);
  writeUint32(view, 20, dataBytes.length);
  writeUint32(view, 24, dataBytes.length);
  writeUint16(view, 28, nameBytes.length);
  writeUint16(view, 30, 0);
  writeUint16(view, 32, 0);
  writeUint16(view, 34, 0);
  writeUint16(view, 36, 0);
  writeUint32(view, 38, 0);
  writeUint32(view, 42, localOffset);
  header.set(nameBytes, 46);
  return header;
}

function createEndOfCentralDirectory(fileCount, centralSize, centralOffset) {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  writeUint32(view, 0, 0x06054b50);
  writeUint16(view, 4, 0);
  writeUint16(view, 6, 0);
  writeUint16(view, 8, fileCount);
  writeUint16(view, 10, fileCount);
  writeUint32(view, 12, centralSize);
  writeUint32(view, 16, centralOffset);
  writeUint16(view, 20, 0);
  return record;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function concatUint8Arrays(parts) {
  const totalLength = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function getColumnName(number) {
  let name = "";
  let value = number;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function columnNameToNumber(name) {
  return String(name)
    .split("")
    .reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0);
}

function sanitizeSheetName(value) {
  return String(value).replace(/[\[\]:*?/\\]/g, " ").slice(0, 31) || "预约记录";
}

function fromSupabaseRow(row) {
  return {
    id: row.id,
    benchId: row.bench_id,
    date: row.booking_date,
    start: trimTime(row.start_time),
    end: trimTime(row.end_time),
    person: row.person,
    createdAt: row.created_at,
  };
}

function toSupabaseRow(item) {
  return {
    bench_id: item.benchId,
    booking_date: item.date,
    start_time: item.start,
    end_time: item.end,
    person: item.person,
  };
}

function upsertBooking(nextBooking) {
  const index = bookings.findIndex((item) => item.id === nextBooking.id);
  if (index >= 0) {
    bookings = bookings.map((item) => (item.id === nextBooking.id ? nextBooking : item));
  } else {
    bookings = [...bookings, nextBooking];
  }
}

function mapDatabaseError(error) {
  if (error.code === "23P01" || String(error.message || "").includes("no_booking_overlap")) {
    return "这个时间段刚被别人预约或与已有预约冲突，请换一个时间。";
  }

  if (error.code === "23514") {
    return "预约数据不符合表规则；如果是 07:00 前或 23:00 后，请先在 Supabase 运行全天预约 SQL。";
  }

  if (error.code === "42501") {
    return "没有数据库写入权限，请检查 Supabase 的 RLS policy。";
  }

  return error.message || "数据库操作失败。";
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function calculateEndTime(startTime, durationValue) {
  if (!startTime || !durationValue) {
    return "";
  }

  const duration = Number(durationValue);
  if (!Number.isFinite(duration)) {
    return "";
  }

  return minutesToTime(timeToMinutes(startTime) + duration);
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function trimTime(value) {
  return String(value).slice(0, 5);
}

function formatDate(value) {
  const [year, month, day] = value.split("-");
  return `${year}-${month}-${day}`;
}

function formatCreatedAt(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function setStorageState(text, state) {
  elements.storageState.textContent = text;
  elements.storageState.className = `storage-pill ${state}`;
}

function setBusy(isBusy) {
  elements.submitButton.disabled = isBusy;
}

function setExportBusy(isBusy) {
  elements.exportButton.disabled = isBusy;
  elements.exportCsvButton.disabled = isBusy;
  setButtonText(elements.exportButton, isBusy ? "导出中..." : "导出 Excel");
  setButtonText(elements.exportCsvButton, isBusy ? "导出中..." : "导出 CSV");
}

function setButtonText(button, text) {
  const label = button.querySelector("span") || button;
  label.textContent = text;
}

function showMessage(message, type) {
  elements.formMessage.textContent = message;
  elements.formMessage.className = `form-message ${type}`;
}

function showExportMessage(message, type) {
  elements.exportMessage.textContent = message;
  elements.exportMessage.className = `form-message ${type}`;
}

function clearMessage() {
  elements.formMessage.textContent = "";
  elements.formMessage.className = "form-message";
}

function clearExportMessage() {
  elements.exportMessage.textContent = "";
  elements.exportMessage.className = "form-message";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character];
  });
}

function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => {
    const entities = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character];
  });
}
