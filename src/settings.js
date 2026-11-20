const api = window.settingsApi;
const rootElement = document.documentElement;
const toastElement = document.querySelector("#toast");
const fontSelect = document.querySelector("#font");
const fontSearch = document.querySelector("#font-search");
const fontSizeInput = document.querySelector("#font-size");
const fontSizeValue = document.querySelector("#font-size-value");

let state = null;
let installedFonts = [];
let fontsReady = false;
let fontsFailed = false;
let lastFontRender = null;
let fontSearchTimer = null;
let fontPreviewFrame = null;
let fontListVisible = false;
const previewedFontOptions = new Set();
let selectedFont = "";
let selectedFontSize = 12;
let toastTimer = null;

function $(selector) {
  return document.querySelector(selector);
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function quoteFontFamily(fontFamily) {
  if (!fontFamily) return null;
  const escaped = String(fontFamily)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function createFontOption(label, value) {
  return new Option(label, value);
}

function scheduleFontPreviews() {
  if (!fontListVisible || fontPreviewFrame !== null) return;
  fontPreviewFrame = requestAnimationFrame(() => {
    fontPreviewFrame = null;
    if (!fontListVisible || !fontSelect.options.length) return;
    // Fixed-height native options retain keyboard navigation and scroll position.
    const rowHeight = fontSelect.options[0].getBoundingClientRect().height + 1;
    if (rowHeight <= 1) return;
    const first = Math.max(0, Math.floor(fontSelect.scrollTop / rowHeight) - 1);
    const end = Math.min(fontSelect.options.length, first + Math.ceil(fontSelect.clientHeight / rowHeight) + 3);
    const visible = new Set();
    for (let index = first; index < end; index++) {
      const option = fontSelect.options[index];
      if (option.value && !option.disabled) visible.add(option);
    }
    for (const option of previewedFontOptions) {
      if (visible.has(option)) continue;
      option.style.removeProperty("font-family");
      previewedFontOptions.delete(option);
    }
    for (const option of visible) {
      if (previewedFontOptions.has(option)) continue;
      option.style.fontFamily = quoteFontFamily(option.value);
      previewedFontOptions.add(option);
    }
  });
}

function applyAppearance(appearance, fontFamily = appearance?.fontFamily || "") {
  const quotedFont = quoteFontFamily(fontFamily);
  if (quotedFont) {
    rootElement.style.setProperty("--user-font", quotedFont);
    rootElement.style.setProperty("--font-display", quotedFont);
  } else {
    rootElement.style.removeProperty("--user-font");
    rootElement.style.removeProperty("--font-display");
  }

  const fontSize = Number(appearance?.fontSize);
  if (Number.isFinite(fontSize)) {
    rootElement.style.setProperty("--preview-font-size", `${fontSize}px`);
  } else {
    rootElement.style.removeProperty("--preview-font-size");
  }

  if (appearance?.bubbleBgColor) {
    rootElement.style.setProperty("--bubble-bg", appearance.bubbleBgColor);
  } else {
    rootElement.style.removeProperty("--bubble-bg");
  }
  if (appearance?.bubbleTextColor) {
    rootElement.style.setProperty("--bubble-ink", appearance.bubbleTextColor);
    const textHex = String(appearance.bubbleTextColor).trim();
    if (textHex.startsWith("#") && textHex.length === 7) {
      rootElement.style.setProperty("--bubble-muted", textHex + "a6");
    } else {
      rootElement.style.setProperty("--bubble-muted", textHex);
    }
  } else {
    rootElement.style.removeProperty("--bubble-ink");
    rootElement.style.removeProperty("--bubble-muted");
  }
}

function showError(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = String(message || "오류가 발생했습니다.");
  toastElement.hidden = false;
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
    toastElement.textContent = "";
  }, 4500);
}

function responseError(response, fallback) {
  return response?.error || fallback;
}

function setButtonBusy(button, busy, busyLabel = "처리 중…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.dataset.wasDisabled = String(button.disabled);
    button.textContent = busyLabel;
    button.disabled = true;
    return;
  }
  if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = button.dataset.wasDisabled === "true";
  delete button.dataset.wasDisabled;
}

function replaceOptions(select, options, selectedValue) {
  select.replaceChildren(...options);
  select.value = selectedValue || "";
}

function resolveInstalledFontFamily(fontFamily) {
  const requested = String(fontFamily || "").trim();
  if (!requested) return "";
  // Keep the saved choice while discovery is pending or unavailable.
  if (!fontsReady || installedFonts.length === 0) return requested;
  const exact = installedFonts.find(
    (font) => font.toLocaleLowerCase("en") === requested.toLocaleLowerCase("en")
  );
  if (exact) return exact;

  // 이전 버전은 Arial Bold처럼 개별 face 이름을 저장했습니다. 현재 목록은 CSS가 실제로
  // 인식하는 family 이름만 제공하므로, 남아 있는 style 꼬리표를 한 번 걷어내 이관합니다.
  const family = requested.replace(
    /\s+(?:Regular|Roman|Book|Medium|SemiBold|DemiBold|Bold|Light|Thin|Black|Italic)$/i,
    ""
  );
  return installedFonts.find(
    (font) => font.toLocaleLowerCase("en") === family.toLocaleLowerCase("en")
  ) || "";
}

function updateFontPreview() {
  $("#font-preview-name").textContent = selectedFont || "시스템 기본";
  fontSizeInput.value = String(selectedFontSize);
  fontSizeValue.value = `${selectedFontSize}px`;
  applyAppearance({ ...(state?.appearance || {}), fontSize: selectedFontSize }, selectedFont);
}

function renderFonts() {
  const query = fontSearch.value.trim().toLocaleLowerCase("ko");
  if (lastFontRender?.fonts === installedFonts && lastFontRender.query === query
    && lastFontRender.selected === selectedFont && lastFontRender.ready === fontsReady
    && lastFontRender.failed === fontsFailed) {
    updateFontPreview();
    return;
  }
  lastFontRender = { fonts: installedFonts, query, selected: selectedFont, ready: fontsReady, failed: fontsFailed };
  const filteredFonts = query
    ? installedFonts.filter((font) => font.toLocaleLowerCase("ko").includes(query))
    : installedFonts;
  const options = [createFontOption("시스템 기본", "")];

  if (selectedFont && !filteredFonts.includes(selectedFont)) {
    options.push(createFontOption(`${selectedFont} · 현재`, selectedFont));
  }
  options.push(...filteredFonts.map((font) => createFontOption(font, font)));
  if (fontsReady && query && filteredFonts.length === 0) {
    const empty = new Option("검색 결과 없음", "__empty__");
    empty.disabled = true;
    options.push(empty);
  }

  replaceOptions(fontSelect, options, selectedFont);
  previewedFontOptions.clear();
  fontSelect.setAttribute("aria-busy", String(!fontsReady && !fontsFailed));
  $("#font-count").textContent = !fontsReady ? (fontsFailed ? "조회 실패" : "불러오는 중") : query
    ? `${filteredFonts.length} / ${installedFonts.length}개`
    : `${installedFonts.length}개`;
  updateFontPreview();
  scheduleFontPreviews();
}

async function loadFonts() {
  try {
    const response = await api.fonts();
    if (!response?.ok || !Array.isArray(response.data)) throw new Error("fonts unavailable");
    installedFonts = response.data;
    fontsReady = true;
    selectedFont = resolveInstalledFontFamily(selectedFont);
  } catch {
    fontsFailed = true;
  }
  if (state) renderFonts();
}

function renderGeneral({ resetAppearance = false } = {}) {
  if (!state) return;
  if (resetAppearance) {
    selectedFont = resolveInstalledFontFamily(state.appearance.fontFamily);
    selectedFontSize = Number(state.appearance.fontSize) || 12;
  }
  replaceOptions(
    $("#pet"),
    state.pets.map((pet) => new Option(pet.label, pet.key)),
    state.petKey
  );
  $("#bubble-mode").value = state.activityBubbleMode;
  $("#autostart").checked = state.autoStart;
  $("#work-mode").checked = Boolean(state.appearance.workMode);

  const bgVal = state.appearance.bubbleBgColor || "";
  $("#bubble-bg-color").value = bgVal;
  if (/^#[0-9a-fA-F]{6}$/.test(bgVal) || /^#[0-9a-fA-F]{3}$/.test(bgVal) || /^#[0-9a-fA-F]{8}$/.test(bgVal)) {
    $("#bubble-bg-picker").value = bgVal.slice(0, 7);
  } else {
    $("#bubble-bg-picker").value = "#ffffff";
  }

  const textVal = state.appearance.bubbleTextColor || "";
  $("#bubble-text-color").value = textVal;
  if (/^#[0-9a-fA-F]{6}$/.test(textVal) || /^#[0-9a-fA-F]{3}$/.test(textVal)) {
    $("#bubble-text-picker").value = textVal.slice(0, 7);
  } else {
    $("#bubble-text-picker").value = "#09090b";
  }

  renderFonts();
}

function accountInitial(account, provider) {
  const source = account.email || account.label || provider.label || "C";
  return source.trim().slice(0, 1).toLocaleUpperCase("ko") || "C";
}

function createEmptyState(title) {
  const empty = createElement("div", "empty-state");
  empty.appendChild(createElement("strong", "", title));
  return empty;
}

function createGrokDockerRow(provider) {
  const status = provider.dockerRead;
  const hostSync = status.loginMode === "host-sync";
  const row = createElement("article", "list-row docker-runtime-row");
  const identity = createElement("div", "list-identity");
  identity.appendChild(createElement("span", "account-avatar", "D"));

  const copy = createElement("div", "list-copy");
  const titleRow = createElement("span");
  titleRow.appendChild(createElement("strong", "", "Docker 워크스페이스"));
  if (status.authenticated) titleRow.appendChild(createElement("span", "active-chip", "연결됨"));
  copy.append(
    titleRow,
    createElement("small", "", status.reason || "프로젝트 하나만 읽기 전용으로 격리합니다.")
  );
  identity.appendChild(copy);

  let actionLabel = hostSync ? "인증 동기화" : "Docker 로그인";
  if (status.available === false) actionLabel = "사용 불가";
  else if (status.authenticated) actionLabel = hostSync ? "다시 동기화" : "다시 로그인";
  const button = createElement(
    "button",
    "button",
    actionLabel
  );
  button.type = "button";
  button.disabled = status.available === false;
  button.addEventListener("click", () =>
    runAccountAction({ provider: provider.id, action: "docker-login" }, button)
  );
  row.append(identity, button);
  return row;
}

function createProviderGroup(provider) {
  const group = createElement("section", "provider-group");
  const heading = createElement("header", "provider-heading");
  const title = createElement("div", "provider-title");
  title.append(
    createElement("span", "provider-mark", provider.label.slice(0, 1)),
    createElement("h2", "", provider.label)
  );

  const addButton = createElement("button", "button", "계정 추가");
  addButton.type = "button";
  addButton.addEventListener("click", () =>
    runAccountAction({ provider: provider.id, action: "login" }, addButton)
  );
  heading.append(title, addButton);
  group.appendChild(heading);

  const list = createElement("div", "stack-list");
  if (provider.id === "grok" && provider.dockerRead) {
    list.appendChild(createGrokDockerRow(provider));
  }
  if (!provider.accounts?.length) {
    list.appendChild(createEmptyState("저장된 계정 없음"));
  }

  for (const account of provider.accounts || []) {
    const row = createElement("article", "list-row");
    const identity = createElement("div", "list-identity");
    identity.appendChild(
      createElement("span", "account-avatar", accountInitial(account, provider))
    );

    const copy = createElement("div", "list-copy");
    const titleRow = createElement("span");
    titleRow.appendChild(createElement("strong", "", account.email || account.label));
    if (account.active) titleRow.appendChild(createElement("span", "active-chip", "현재"));
    copy.appendChild(titleRow);
    if (account.plan) copy.appendChild(createElement("small", "", account.plan));
    identity.appendChild(copy);

    const actions = createElement("div", "list-actions");
    const switchButton = createElement(
      "button",
      "button",
      account.active ? "사용 중" : "전환"
    );
    switchButton.type = "button";
    switchButton.disabled = account.active;
    switchButton.addEventListener("click", () =>
      runAccountAction(
        { provider: provider.id, action: "switch", profileKey: account.key },
        switchButton
      )
    );
    actions.appendChild(switchButton);

    const deleteButton = createElement("button", "button danger-button", "삭제");
    deleteButton.type = "button";
    deleteButton.disabled = account.active;
    deleteButton.addEventListener("click", () => {
      const accountLabel = account.email || account.label || provider.label;
      if (!window.confirm(`"${accountLabel}" 저장 계정을 삭제할까요?`)) return;
      runAccountAction(
        { provider: provider.id, action: "delete", profileKey: account.key },
        deleteButton
      );
    });
    actions.appendChild(deleteButton);
    row.append(identity, actions);
    list.appendChild(row);
  }
  group.appendChild(list);
  return group;
}

function renderAccounts() {
  const root = $("#provider-groups");
  root.replaceChildren();
  for (const provider of state?.providers || []) {
    root.appendChild(createProviderGroup(provider));
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function resetLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(String(value))) {
    return String(value);
  }
  return `${new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)} 초기화`;
}

function createUsageGauge(gauge) {
  const used = clampPercent(gauge.usedPercent);
  const remaining = Math.round(100 - used);
  const container = createElement("div", "usage-gauge");
  const row = createElement("div", "usage-row");
  row.append(
    createElement("span", "", gauge.label),
    createElement("strong", "", `${remaining}% 남음`)
  );
  const track = createElement("div", "usage-track");
  const fill = createElement("i", used >= 90 ? "is-danger" : used >= 70 ? "is-warn" : "");
  fill.style.width = `${remaining}%`;
  track.appendChild(fill);
  container.append(row, track, createElement("small", "", resetLabel(gauge.resetText)));
  return container;
}

function renderUsage() {
  const root = $("#usage-cards");
  root.replaceChildren();
  for (const item of state?.usage || []) {
    const card = createElement("article", "usage-card");
    const heading = createElement("header", "usage-card-heading");
    heading.append(
      createElement("span", "provider-mark", item.label.slice(0, 1)),
      createElement("h2", "", item.label)
    );
    card.appendChild(heading);

    if (item.error) {
      card.appendChild(createElement("p", "usage-error", item.error));
    } else if (!item.gauges?.length) {
      card.appendChild(createElement("p", "usage-error", "한도 정보 없음"));
    } else {
      for (const gauge of item.gauges) card.appendChild(createUsageGauge(gauge));
    }
    root.appendChild(card);
  }
}

function renderAll(options = {}) {
  renderGeneral(options);
  renderAccounts();
  renderUsage();
}

async function runAccountAction(input, sourceButton) {
  const busyLabel = input.action === "switch"
    ? "전환 중…"
    : input.action === "delete"
      ? "삭제 중…"
      : input.action === "docker-login"
        ? "준비 중…"
        : "여는 중…";
  setButtonBusy(sourceButton, true, busyLabel);
  try {
    const response = await api.account(input);
    if (!response?.ok) throw new Error(responseError(response, "계정 작업에 실패했습니다."));
    state = response.data;
    renderAccounts();
    renderUsage();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setButtonBusy(sourceButton, false);
  }
}

function activateSection(button, { focus = false } = {}) {
  const sectionId = button.dataset.section;
  for (const navButton of document.querySelectorAll(".nav-item")) {
    const active = navButton === button;
    navButton.classList.toggle("is-active", active);
    navButton.setAttribute("aria-selected", String(active));
    navButton.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll(".panel")) {
    const active = panel.id === sectionId;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  $("#section-label").textContent = button.dataset.label;
  if (focus) button.focus();
  $(".workspace").scrollTo({ top: 0, behavior: "smooth" });
}

function registerNavigation() {
  const buttons = [...document.querySelectorAll(".nav-item")];
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => activateSection(button));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      let targetIndex = index;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        targetIndex = (index + 1) % buttons.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        targetIndex = (index - 1 + buttons.length) % buttons.length;
      } else if (event.key === "Home") {
        targetIndex = 0;
      } else if (event.key === "End") {
        targetIndex = buttons.length - 1;
      }
      activateSection(buttons[targetIndex], { focus: true });
    });
  });
  api.onNavigate((section) => {
    const target = buttons.find((button) => button.dataset.section === section);
    if (target) activateSection(target);
  });
}

function registerAppearanceControls() {
  fontSearch.addEventListener("input", () => {
    clearTimeout(fontSearchTimer);
    fontSearchTimer = setTimeout(renderFonts, 100);
  });
  fontSelect.addEventListener("scroll", scheduleFontPreviews, { passive: true });
  window.addEventListener("resize", scheduleFontPreviews);
  const fontVisibility = new IntersectionObserver(([entry]) => {
    fontListVisible = entry.isIntersecting;
    scheduleFontPreviews();
  });
  fontVisibility.observe(fontSelect);
  fontSelect.addEventListener("change", () => {
    if (fontSelect.value === "__empty__") return;
    selectedFont = fontSelect.value;
    updateFontPreview();
    scheduleFontPreviews();
  });
  fontSizeInput.addEventListener("input", () => {
    selectedFontSize = Number(fontSizeInput.value) || 12;
    updateFontPreview();
  });
  $("#save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "적용 중…");
    try {
      const response = await api.save({
        fontFamily: selectedFont || null,
        fontSize: selectedFontSize,
        workMode: $("#work-mode").checked,
        petKey: $("#pet").value,
        activityBubbleMode: $("#bubble-mode").value,
        autoStart: $("#autostart").checked,
        bubbleBgColor: $("#bubble-bg-color").value.trim() || null,
        bubbleTextColor: $("#bubble-text-color").value.trim() || null,
      });
      if (!response?.ok) throw new Error(responseError(response, "설정을 적용하지 못했습니다."));
      state = response.data;
      renderAll({ resetAppearance: true });
      applyAppearance(state.appearance, selectedFont);
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerProviderControls() {
  $("#refresh-accounts").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "확인 중…");
    try {
      const response = await api.get();
      if (!response?.ok) throw new Error(responseError(response, "계정을 확인하지 못했습니다."));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });

  $("#refresh-usage").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "확인 중…");
    try {
      const response = await api.usage();
      if (!response?.ok) throw new Error(responseError(response, "사용량을 확인하지 못했습니다."));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerAppearanceUpdates() {
  api.onAppearance((appearance) => {
    if (Number.isFinite(Number(appearance?.fontSize))) {
      selectedFontSize = Number(appearance.fontSize);
      fontSizeInput.value = String(selectedFontSize);
      fontSizeValue.value = `${selectedFontSize}px`;
    }
    applyAppearance(appearance, appearance?.fontFamily || selectedFont);
    if (state) state.appearance = { ...state.appearance, ...appearance };
  });
}

function registerTitlebarControls() {
  $("#btn-minimize").addEventListener("click", () => api.minimize());
  $("#btn-maximize").addEventListener("click", () => api.maximize());
  $("#btn-close").addEventListener("click", () => api.close());

  api.onMaximizedState((isMaximized) => {
    const btn = $("#btn-maximize");
    const maxIcon = btn.querySelector(".icon-maximize");
    const restoreIcon = btn.querySelector(".icon-restore");
    if (isMaximized) {
      if (maxIcon) maxIcon.style.display = "none";
      if (restoreIcon) restoreIcon.style.display = "block";
      btn.setAttribute("aria-label", "이전 크기로 복원");
    } else {
      if (maxIcon) maxIcon.style.display = "block";
      if (restoreIcon) restoreIcon.style.display = "none";
      btn.setAttribute("aria-label", "최대화");
    }
  });
}

function registerColorPickerControls() {
  const bgPicker = $("#bubble-bg-picker");
  const bgInput = $("#bubble-bg-color");
  const textPicker = $("#bubble-text-picker");
  const textInput = $("#bubble-text-color");

  function isValidColor(str) {
    const s = new Option().style;
    s.color = str;
    return s.color !== '';
  }

  bgPicker.addEventListener("input", () => {
    bgInput.value = bgPicker.value;
    updateLiveColors();
  });
  textPicker.addEventListener("input", () => {
    textInput.value = textPicker.value;
    updateLiveColors();
  });

  bgInput.addEventListener("input", () => {
    const val = bgInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val) || /^#[0-9a-fA-F]{8}$/.test(val)) {
      bgPicker.value = val.slice(0, 7);
    }
    updateLiveColors();
  });
  textInput.addEventListener("input", () => {
    const val = textInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val)) {
      textPicker.value = val.slice(0, 7);
    }
    updateLiveColors();
  });

  function updateLiveColors() {
    const bgVal = bgInput.value.trim();
    const textVal = textInput.value.trim();

    if (bgVal && isValidColor(bgVal)) {
      rootElement.style.setProperty("--bubble-bg", bgVal);
    } else {
      rootElement.style.removeProperty("--bubble-bg");
    }

    if (textVal && isValidColor(textVal)) {
      rootElement.style.setProperty("--bubble-ink", textVal);
    } else {
      rootElement.style.removeProperty("--bubble-ink");
    }
  }
}

async function initialize() {
  registerTitlebarControls();
  registerColorPickerControls();
  registerNavigation();
  registerAppearanceControls();
  registerProviderControls();
  registerAppearanceUpdates();
  registerUpdateControls();

  void loadFonts();
  try {
    const settingsResponse = await api.get();
    if (!settingsResponse?.ok) {
      throw new Error(responseError(settingsResponse, "설정을 불러오지 못했습니다."));
    }
    state = settingsResponse.data;
    selectedFont = resolveInstalledFontFamily(state.appearance.fontFamily);
    selectedFontSize = Number(state.appearance.fontSize) || 12;
    renderAll({ resetAppearance: true });
    applyAppearance(state.appearance, selectedFont);
  } catch (error) {
    showError(error.message || String(error));
  }
}

function registerUpdateControls() {
  const button = $("#download-update");
  const checkButton = $("#check-update");
  const feedback = $("#update-status");
  const version = $("#app-version");
  let checking = false;
  let busy = false;
  let currentVersion = version.textContent;
  let actionLabel = "새 버전 다운로드";
  function renderProgress(update) {
    busy = ["downloading", "verifying", "restarting"].includes(update?.phase);
    button.disabled = busy;
    checkButton.disabled = checking || busy;
    button.setAttribute("aria-busy", String(busy));
    const label = update?.phase === "downloading" ? `다운로드 ${update.percent || 0}%`
      : update?.phase === "verifying" ? "파일 확인 중…"
        : update?.phase === "restarting" ? "재시작 중…" : null;
    version.textContent = label || currentVersion;
    button.title = label || actionLabel;
    button.setAttribute("aria-label", button.title);
    if (busy) button.hidden = false;
  }
  async function refresh(force = false) {
    if (checking || busy) return;
    checking = true;
    checkButton.disabled = true;
    checkButton.setAttribute("aria-busy", "true");
    feedback.textContent = "업데이트를 확인하는 중…";
    try {
      const result = await api.checkUpdate(force);
      if (result?.currentVersion) currentVersion = `VERSION ${result.currentVersion}`;
      if (busy) return;
      button.hidden = result?.status !== "available";
      if (!button.hidden) {
        actionLabel = result.automatic ? `새 버전 ${result.latestVersion} 업데이트 후 재시작` : `새 버전 ${result.latestVersion} 다운로드`;
      }
      renderProgress(result?.update);
      feedback.textContent = result?.status === "available" ? `새 버전 ${result.latestVersion}을 사용할 수 있습니다.`
        : result?.status === "up-to-date" ? "최신 버전입니다."
          : "업데이트를 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.";
      if (result?.retryAfterMs) feedback.textContent += ` ${Math.ceil(result.retryAfterMs / 1000)}초 후 다시 확인할 수 있습니다.`;
    } catch {
      button.hidden = true;
      feedback.textContent = "업데이트를 확인하지 못했습니다. 다시 시도해 주세요.";
    } finally {
      checking = false;
      checkButton.disabled = busy;
      checkButton.setAttribute("aria-busy", "false");
    }
  }
  button.addEventListener("click", async () => {
    if (busy) return;
    renderProgress({ phase: "downloading", percent: 0 });
    try {
      const result = await api.downloadUpdate();
      if (!result?.ok) {
        renderProgress({ phase: "error" });
        showError(responseError(result, "업데이트를 시작하지 못했습니다."));
      } else {
        renderProgress({ phase: result.restarting ? "restarting" : "idle" });
      }
    } catch {
      renderProgress({ phase: "error" });
      showError("업데이트를 시작하지 못했습니다. 다시 시도해 주세요.");
    }
  });
  api.onUpdateProgress?.(renderProgress);
  checkButton.addEventListener("click", () => refresh(true));
  window.addEventListener("focus", () => refresh());
  void refresh();
}

initialize();
