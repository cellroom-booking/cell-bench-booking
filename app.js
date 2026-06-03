const STORAGE_KEY = "cellBenchBookings.v2";
const TABLE_NAME = "bookings";
const DEFAULT_DATE = "2026-06-03";
const DAY_START = 0;
const DAY_END = 24 * 60;
const DAY_RANGE = DAY_END - DAY_START;
const REFRESH_INTERVAL_MS = 60 * 1000;
const RECONNECT_DELAY_MS = 5 * 1000;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
  endTime: document.querySelector("#endTime"),
  formMessage: document.querySelector("#formMessage"),
  submitButton: document.querySelector("#submitButton"),
  scheduleGrid: document.querySelector("#scheduleGrid"),
  bookingCount: document.querySelector("#bookingCount"),
  freeCount: document.querySelector("#freeCount"),
  daySummary: document.querySelector("#daySummary"),
  copyDayButton: document.querySelector("#copyDayButton"),
  exportStartDate: document.querySelector("#exportStartDate"),
  exportEndDate: document.querySelector("#exportEndDate"),
  exportStartTime: document.querySelector("#exportStartTime"),
  exportEndTime: document.querySelector("#exportEndTime"),
  exportButton: document.querySelector("#exportButton"),
  exportMessage: document.querySelector("#exportMessage"),
  storageState: document.querySelector("#storageState"),
  benchTemplate: document.querySelector("#benchTemplate"),
  bookingTemplate: document.querySelector("#bookingTemplate"),
};

init();

async function init() {
  fillBenchOptions();
  elements.bookingDate.value = selectedDate;
  elements.viewDate.value = selectedDate;
  elements.exportStartDate.value = selectedDate;
  elements.exportEndDate.value = selectedDate;
  elements.form.addEventListener("submit", handleSubmit);
  elements.viewDate.addEventListener("change", handleDateChange);
  elements.bookingDate.addEventListener("change", handleDateChange);
  elements.benchFilter.addEventListener("change", handleBenchFilterChange);
  elements.copyDayButton.addEventListener("click", copyCurrentDay);
  elements.exportButton.addEventListener("click", handleExport);

  render();
  await startDataLayer();
  render();
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
      await fetchRemoteBookings();
      render();
    } catch (error) {
      console.warn("Periodic refresh failed", error);
      setStorageState("同步异常", "error");
      scheduleRealtimeReconnect();
    }
  }, REFRESH_INTERVAL_MS);
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

async function handleSubmit(event) {
  event.preventDefault();

  const nextBooking = {
    id: createId(),
    benchId: elements.benchSelect.value,
    date: elements.bookingDate.value,
    person: elements.personInput.value.trim(),
    start: elements.startTime.value,
    end: elements.endTime.value,
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
  elements.viewDate.value = selectedDate;
  elements.bookingDate.value = selectedDate;
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
    return { ok: false, message: "请把日期、细胞台、姓名和时间填写完整。" };
  }

  if (nextBooking.person.length > 40) {
    return { ok: false, message: "预约人姓名请控制在 40 个字符以内。" };
  }

  const start = timeToMinutes(nextBooking.start);
  const end = timeToMinutes(nextBooking.end);
  if (end <= start) {
    return { ok: false, message: "结束时间必须晚于开始时间。" };
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
  selectedDate = event.target.value || DEFAULT_DATE;
  elements.viewDate.value = selectedDate;
  elements.bookingDate.value = selectedDate;
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

  elements.scheduleGrid.innerHTML = "";
  elements.daySummary.textContent = getDaySummary(dayBookings.length);
  elements.bookingCount.textContent = String(dayBookings.length);
  elements.freeCount.textContent = String(countFreeBenches(dayBookings));

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
    if (exportBookings.length === 0) {
      showExportMessage("所选范围内没有预约记录。", "error");
      return;
    }

    const rows = buildExportRows(exportBookings);
    const fileName = buildExportFileName(range);
    downloadXlsx("预约记录", rows, fileName);
    showExportMessage(`已导出 ${exportBookings.length} 条预约记录。`, "success");
  } catch (error) {
    console.error("Export failed", error);
    showExportMessage("导出失败，请检查网络后重试。", "error");
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
  const rangeStart = timeToMinutes(range.startTime);
  const rangeEnd = timeToMinutes(range.endTime);
  return bookingStart < rangeEnd && bookingEnd > rangeStart;
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

function buildExportFileName(range) {
  const startTime = range.startTime.replace(":", "");
  const endTime = range.endTime.replace(":", "");
  return `cell-bench-bookings_${range.startDate}_${range.endDate}_${startTime}-${endTime}.xlsx`;
}

function downloadXlsx(sheetName, rows, fileName) {
  const files = createXlsxFiles(sheetName, rows);
  const zipBytes = createStoredZip(files);
  const blob = new Blob([zipBytes], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createXlsxFiles(sheetName, rows) {
  const safeSheetName = sanitizeSheetName(sheetName);
  return [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
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
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Cellroom Booking</Application>
</Properties>`,
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
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(safeSheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: createWorksheetXml(rows),
    },
  ];
}

function createWorksheetXml(rows) {
  const lastColumn = getColumnName(Math.max(1, rows[0]?.length || 1));
  const lastRow = Math.max(1, rows.length);
  const sheetData = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row
        .map((value, columnIndex) => {
          const cellRef = `${getColumnName(columnIndex + 1)}${rowNumber}`;
          return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(String(value ?? ""))}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>
    <col min="1" max="1" width="14" customWidth="1"/>
    <col min="2" max="4" width="18" customWidth="1"/>
    <col min="5" max="6" width="12" customWidth="1"/>
    <col min="7" max="7" width="14" customWidth="1"/>
    <col min="8" max="8" width="24" customWidth="1"/>
  </cols>
  <sheetData>${sheetData}</sheetData>
  <autoFilter ref="A1:${lastColumn}${lastRow}"/>
</worksheet>`;
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

function countFreeBenches(dayBookings) {
  const occupied = new Set(dayBookings.map((item) => item.benchId));
  return benches.length - occupied.size;
}

function timeToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
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
  elements.exportButton.textContent = isBusy ? "导出中..." : "导出 Excel";
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
