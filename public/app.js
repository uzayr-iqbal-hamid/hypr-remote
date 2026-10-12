// @ts-check
// hypr-remote phone client. Plain JS, no build step: the server serves this
// file as-is. The JSDoc types come from the server, so `bun run check` catches
// the two drifting apart.

/** @typedef {import("../src/actions").Action} Action */
/** @typedef {import("../src/actions").Reply} Reply */
/** @typedef {import("../src/state").State} State */
/** @typedef {{ type: "state"; state: State } | Reply} Message */

// Every id looked up is in index.html; a missing one is a bug, not a state.
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const pad2 = (/** @type {number} */ n) => String(n).padStart(2, "0");

/* -------------------------------------------------------------------------- */
/* Pairing                                                                    */
/* -------------------------------------------------------------------------- */

// The terminal's QR code carries ?t=<pairing code>. Keep it, then drop it
// from the address bar so it isn't left in screenshots or history.
const params = new URLSearchParams(location.search);
/**
 * @param {"get" | "set" | "clear"} action
 * @param {string | null} [value]
 */
function storage(action, value) {
  try {
    if (action === "get") return localStorage.getItem("hypr-remote-token");
    if (action === "clear") return localStorage.removeItem("hypr-remote-token");
    localStorage.setItem("hypr-remote-token", /** @type {string} */ (value));
  } catch {
    return null;
  }
}

// A phone trades the QR code's pairing code for a token of its own ("d_…"),
// which is what it keeps and uses. A code saved by an older version is
// traded the same way.
const fromCode = params.get("t");
if (fromCode) history.replaceState(null, "", location.pathname);
/** This phone's own token, once it has one. */
let token = storage("get");
/** A pairing code still to trade, from the QR code or an older version. */
let pairingCode = fromCode && !fromCode.startsWith("d_") ? fromCode : token && !token.startsWith("d_") ? token : null;
if (fromCode?.startsWith("d_")) {
  token = fromCode;
  storage("set", token);
}
if (!token?.startsWith("d_")) token = null;

// An iOS home-screen app launches with an empty localStorage of its own, at the
// manifest's start_url, so neither the token nor the pairing code reaches it.
// Point the link at the manifest with this phone's token and the server puts
// that token in start_url, which the app reads on its first launch and keeps.
// A phone without a token leaves the link alone and gets the plain manifest.
// Only over https: on http:// the token would ride the request in clear text,
// and the server ignores it there anyway.
function pointManifestAtToken() {
  if (!token || location.protocol !== "https:") return;
  const manifestLink = /** @type {HTMLLinkElement|null} */ (document.querySelector('link[rel="manifest"]'));
  if (manifestLink) manifestLink.href = `/manifest.webmanifest?t=${encodeURIComponent(token)}`;
}
pointManifestAtToken();

/** What this phone calls itself on the laptop's list of paired phones. */
async function phoneName() {
  try {
    const hints = await /** @type {any} */ (navigator).userAgentData?.getHighEntropyValues(["model"]);
    if (hints?.model) return String(hints.model);
  } catch {}
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iphone";
  if (/iPad/.test(agent)) return "ipad";
  if (/Android/.test(agent)) return "android phone";
  return "browser";
}

/** Trades the pairing code; false when the laptop turned it down. */
async function pair() {
  const response = await fetch("/pair", {
    method: "POST",
    headers: { "x-token": pairingCode ?? "", "content-type": "application/json" },
    body: JSON.stringify({ name: await phoneName(), previous: token }),
  });
  if (response.status === 401) {
    pairingCode = null;
    return false;
  }
  if (!response.ok) throw new Error(`/pair: ${response.status}`);
  token = String((await response.json()).token);
  storage("set", token);
  pairingCode = null;
  // Pairing just minted the token the manifest needs, so the link has to be
  // rewritten now too: a phone that arrived with only the QR code would
  // otherwise install an app that cannot pair.
  pointManifestAtToken();
  return true;
}

/**
 * This phone's settings, from the settings page. Speeds are percent,
 * warmths kelvin, `holdMs` milliseconds, `previewEvery` seconds; `…Off` lists
 * what's put away (tabs, top bar icons, dock icons).
 * @typedef {{
 *   tab: string; tabsOff: string[]; swipeTabs: boolean; textSize: string;
 *   stats: boolean; haptics: boolean; awake: boolean;
 *   headerOff: string[]; bellCount: boolean; notePopups: boolean; batteryAlert: number;
 *   dockSide: string; holdMs: number; deckOff: string[]; warm: number; warmer: number;
 *   newTile: boolean; confirmClose: boolean; windowRows: string;
 *   player: string; downloadsShown: number; previewQuality: string; previewEvery: number;
 *   speed: number; acceleration: boolean; tapToClick: boolean; naturalScroll: boolean; scrollSpeed: number;
 *   autocorrect: boolean;
 * }} PhoneSettings
 */
/** @typedef {"swipeTabs" | "stats" | "haptics" | "awake" | "bellCount" | "notePopups" | "newTile" | "confirmClose" | "acceleration" | "tapToClick" | "naturalScroll" | "autocorrect"} SwitchKey */
/** @typedef {"tabsOff" | "headerOff" | "deckOff"} ListKey */
const SETTINGS_KEY = "hypr-remote-settings";
/** @type {PhoneSettings} */
const DEFAULT_SETTINGS = {
  tab: "desk",
  tabsOff: [],
  swipeTabs: true,
  textSize: "normal",
  stats: true,
  haptics: true,
  awake: false,
  headerOff: [],
  bellCount: true,
  notePopups: true,
  batteryAlert: 20,
  dockSide: "right",
  holdMs: 1000,
  deckOff: [],
  warm: 4500,
  warmer: 3000,
  newTile: true,
  confirmClose: false,
  windowRows: "both",
  player: "all",
  downloadsShown: 5,
  previewQuality: "light",
  previewEvery: 1,
  speed: 100,
  acceleration: true,
  tapToClick: true,
  naturalScroll: true,
  scrollSpeed: 100,
  autocorrect: false,
};
/** The only values a choice may take; anything else saved falls back. */
/** @type {Partial<Record<keyof PhoneSettings, (string | number)[]>>} */
const CHOICES = {
  tab: ["desk", "control", "bridge", "input"],
  textSize: ["small", "normal", "large"],
  batteryAlert: [0, 10, 20, 30],
  dockSide: ["left", "right"],
  holdMs: [500, 1000, 2000],
  windowRows: ["both", "app", "title"],
  player: ["all", "control", "off"],
  downloadsShown: [3, 5, 10],
  previewQuality: ["light", "sharp"],
  previewEvery: [1, 3, 10],
};
/** @type {PhoneSettings} */
const settings = structuredClone(DEFAULT_SETTINGS);
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  for (const key of /** @type {(keyof PhoneSettings)[]} */ (Object.keys(DEFAULT_SETTINGS))) {
    const value = saved?.[key];
    const fits = Array.isArray(DEFAULT_SETTINGS[key])
      ? Array.isArray(value) && value.every((item) => typeof item === "string")
      : typeof value === typeof DEFAULT_SETTINGS[key] && (CHOICES[key]?.includes(value) ?? true);
    if (fits) /** @type {any} */ (settings)[key] = value;
  }
} catch {}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

/** A buzz, unless vibration is off in settings. @param {number | number[]} pattern */
function vibrate(pattern) {
  if (settings.haptics) navigator.vibrate?.(pattern);
}

// On plain http: where the secure version is, and whether this page may use
// the token at all (not once the laptop runs https).
const config = location.protocol === "http:" ? fetch("/config.json").then((r) => r.json()) : null;

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

/** @type {WebSocket | null} */
let socket = null;
let retry = 500;
let everOpened = false;
// Unset until the first state message; only the touchpad reads it before then.
/** @type {State} */
let state;

/** @param {string} text */
function showBanner(text) {
  $("banner").textContent = text;
  $("banner").dataset.show = text ? "true" : "false";
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/**
 * A short message over the tab bar, with a button when there's something to
 * do about it ("open it there").
 * @param {string} text
 * @param {{ label: string; run: () => void }} [action]
 */
function toast(text, action) {
  showToast(text, action);
}

/** Alerts wait for each other rather than one replacing the next. */
/** @type {[string, { label: string; run: () => void } | undefined][]} */
const alerts = [];

/**
 * @param {string} text
 * @param {{ label: string; run: () => void }} [action]
 */
function alertToast(text, action) {
  if ($("toast").dataset.show === "true") alerts.push([text, action]);
  else showToast(text, action);
}

/**
 * @param {string} text
 * @param {{ label: string; run: () => void }} [action]
 */
function showToast(text, action) {
  const box = $("toast");
  box.textContent = text;
  if (action) {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.addEventListener("click", () => {
      box.dataset.show = "false";
      action.run();
    });
    box.append(button);
  }
  box.dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.dataset.show = "false";
    const next = alerts.shift();
    if (next) setTimeout(() => showToast(...next), 250);
  }, action ? 4000 : 1800);
}

// Resolves once the first connection opens: shared links wait for it.
/** @type {() => void} */
let markOpened = () => {};
const opened = new Promise((resolve) => (markOpened = () => resolve(undefined)));

/** The dot beside the title: green while live, red while not. @param {"true" | "false"} live */
function setLive(live) {
  const dot = $("live-dot");
  dot.dataset.live = live;
  dot.setAttribute("aria-label", live === "true" ? "live" : "offline");
}

async function connect() {
  if (pairingCode) {
    try {
      await pair();
    } catch {
      // The laptop is out of reach; try again as a socket would.
      setLive("false");
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
      return;
    }
  }
  if (!token) {
    showBanner("not paired. scan the qr code in the terminal, or in the control center on your laptop.");
    return;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws?t=${encodeURIComponent(token)}`);

  socket.onopen = () => {
    everOpened = true;
    markOpened();
    retry = 500;
    setLive("true");
    renderLaptop();
    showBanner("");
  };

  socket.onmessage = (event) => {
    /** @type {Message} */
    const message = JSON.parse(event.data);
    if (message.type === "state") render(message.state);
    if (message.type === "toast") toast(message.text);
    if (message.type === "top") {
      topApps = { cpu: message.cpu, memory: message.memory };
      renderSheet();
    }
    if (message.type === "devices") {
      myDevice = message.you;
      renderDevices(message.list);
    }
  };

  socket.onclose = (event) => {
    setLive("false");
    renderLaptop();
    // Removed in settings, here or on another phone, or every phone unpaired.
    if (event.code === 4001) {
      storage("clear");
      token = null;
      showBanner("this phone was unpaired. scan the qr code on the laptop to pair again.");
      return;
    }
    // Refused before ever opening is almost always a stale token.
    if (!everOpened) showBanner("couldn't connect. if the laptop is on, re-scan its qr code to pair again.");
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}

/**
 * The old http:// address can't pair any more; point at the secure one.
 * @param {{ address: string; httpsPort: number }} config
 */
function guideToSecure({ address, httpsPort }) {
  const code = pairingCode ?? token;
  if (!code) return connect(); // shows "not paired"
  setLive("false");
  showBanner("this is the old http address, which would show your pairing to the whole wi-fi. ");
  const link = document.createElement("a");
  link.href = `https://${address}:${httpsPort}/?t=${encodeURIComponent(code)}`;
  link.textContent = "open the secure version";
  $("banner").append(
    link,
    " or re-scan the qr code. if the browser warns about the certificate, continue anyway, " +
      "or install the certificate from the bridge tab first.",
  );
}

/**
 * @param {Action} action
 * @param {{ buzz?: boolean }} [options]
 */
function send(action, { buzz = true } = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(action));
  if (buzz) vibrate(8);
  return true;
}

document.body.dataset.stats = settings.stats ? "on" : "off";

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} name
 * @param {1 | -1} [from] which side the tab slides in from, after a swipe
 */
function showTab(name, from) {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("nav [role=tab]")).forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  });
  const leaving = document.body.dataset.tab;
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".tab")).forEach((section) => {
    section.dataset.active = String(section.id === `tab-${name}`);
  });
  document.body.dataset.tab = name;
  /** @type {HTMLElement} */ (document.querySelector("nav [role=tablist]")).style.setProperty(
    "--tab-index",
    String(Math.max(0, visibleTabs().indexOf(name))),
  );
  // The mini player can be set to show on control only.
  if (state && leaving !== name) renderMedia();
  if (from) {
    $(`tab-${name}`).animate(
      [
        { transform: `translateX(${from * 2.5}rem)`, opacity: 0.4 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 200, easing: "ease-out" },
    );
  }
  updateScreenPolling();
}

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("nav [role=tab]")).forEach((tab) =>
  tab.addEventListener("click", () => showTab(/** @type {string} */ (tab.dataset.tab))),
);

const TAB_NAMES = ["desk", "control", "bridge", "input"];

/** The tabs in the tab bar: all but the ones put away in settings. */
function visibleTabs() {
  const shown = TAB_NAMES.filter((name) => !settings.tabsOff.includes(name));
  return shown.length ? shown : ["desk"];
}

/**
 * Puts the settings to work on everything already on screen. Anything drawn
 * from the laptop's state is drawn again.
 */
function applySettings() {
  document.documentElement.style.fontSize = { small: "15px", normal: "", large: "17.5px" }[settings.textSize] ?? "";
  document.body.dataset.stats = settings.stats ? "on" : "off";
  document.body.dataset.dock = settings.dockSide;

  // The tab bar: only the tabs kept, and off one that was just put away.
  const shown = visibleTabs();
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("nav [role=tab]")).forEach((tab) => {
    tab.hidden = !shown.includes(/** @type {string} */ (tab.dataset.tab));
  });
  const bar = /** @type {HTMLElement} */ (document.querySelector("nav [role=tablist]"));
  bar.style.gridTemplateColumns = `repeat(${shown.length}, 1fr)`;
  bar.style.setProperty("--tabs", String(shown.length));
  const current = /** @type {string} */ (document.body.dataset.tab);
  showTab(shown.includes(current) ? current : /** @type {string} */ (shown[0]));

  // The touchpad and keyboard.
  $("pad-hint").innerHTML = `${settings.tapToClick ? "tap to click · " : ""}double-tap and hold to drag<br />two fingers scroll or pinch · three swipe workspaces`;
  const typing = $("typing");
  typing.setAttribute("autocorrect", settings.autocorrect ? "on" : "off");
  typing.setAttribute("autocapitalize", settings.autocorrect ? "sentences" : "off");
  typing.setAttribute("spellcheck", String(settings.autocorrect));

  layoutDeck();
  // Cached renders keyed on the state alone would skip the new settings.
  windowsKey = "";
  filesKey = "";
  $("workspaces").dataset.rendered = "";
  if (state) render(state);
}
/**
 * Swipe left or right anywhere on the page for the next or previous tab,
 * except on what already swipes sideways: the workspaces card, window and
 * notification rows, sliders, text, card titles and the touchpad.
 */
function wireTabSwipe() {
  // Overlays (the full-screen preview, presenter, keyboard dock, sheets)
  // are theirs too.
  const OWN_SWIPE = [
    "#workspaces-card, .window, input, textarea, [data-card-handle], .pad",
    "#viewer, #presenter, #dock, .sheet, #sheet-backdrop, #drop-strip, #power-deck, .scene-row, .level, #settings",
  ].join(", ");
  /** @type {{ x: number; y: number; at: number } | null} */
  let start = null;
  document.addEventListener(
    "touchstart",
    (event) => {
      const touch = event.touches[0];
      const own = /** @type {Element} */ (event.target).closest(OWN_SWIPE);
      start =
        event.touches.length === 1 && touch && !own ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp } : null;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) start = null;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches[0];
      if (!start || !touch || !settings.swipeTabs) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const quick = event.timeStamp - start.at < 700;
      start = null;
      // Clearly sideways and far enough: a scroll that drifts doesn't count.
      if (!quick || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
      const step = dx < 0 ? 1 : -1;
      const names = visibleTabs();
      const next = names[names.indexOf(/** @type {string} */ (document.body.dataset.tab)) + step];
      if (next) showTab(next, step);
      else vibrate([10, 60, 10]);
    },
    { passive: true },
  );
  document.addEventListener("touchcancel", () => (start = null), { passive: true });
}
wireTabSwipe();

// Desk until the page is set up; then the tab picked in settings (at the end
// of this file, since showing a tab starts screen polling).
document.body.dataset.tab = "desk";
try {
  localStorage.removeItem("hypr-remote-tab");
} catch {}

/* -------------------------------------------------------------------------- */
/* Cards: this phone's order, the ones put away, and the colour               */
/* -------------------------------------------------------------------------- */

/**
 * Remembered on this phone only. `order` lists each tab's cards top to bottom;
 * cards added in a later version, missing from it, keep their place at the end.
 * @typedef {{ order: Record<string, string[]>; away: string[] }} Layout
 */
const LAYOUT_KEY = "hypr-remote-cards";

/** @returns {Layout} */
function readLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (saved && typeof saved.order === "object" && Array.isArray(saved.away)) return saved;
  } catch {}
  return { order: {}, away: [] };
}

let layout = readLayout();

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {}
}

/** @param {Element} tab */
const cardsOf = (tab) => /** @type {HTMLElement[]} */ ([...tab.querySelectorAll(":scope > [data-card]")]);
const cardName = (/** @type {HTMLElement} */ card) => /** @type {string} */ (card.dataset.card);

// The order they're written in, for "reset order".
/** @type {Record<string, string[]>} */
const defaultOrder = {};
document.querySelectorAll(".tab").forEach((tab) => (defaultOrder[tab.id] = cardsOf(tab).map(cardName)));

function applyLayout() {
  document.querySelectorAll(".tab").forEach((tab) => {
    const cards = cardsOf(tab);
    if (!cards.length) return;
    const saved = layout.order[tab.id] ?? [];
    const first = defaultOrder[tab.id] ?? [];
    const rank = (/** @type {HTMLElement} */ card) => {
      const at = saved.indexOf(cardName(card));
      return at === -1 ? saved.length + first.indexOf(cardName(card)) : at;
    };
    const sorted = [...cards].sort((a, b) => rank(a) - rank(b));
    for (const card of sorted) {
      card.dataset.away = String(layout.away.includes(cardName(card)));
      tab.append(card);
    }
    tab.append(restoreRow(tab, sorted));
  });
}

/**
 * The cards put away on this tab, one button each to bring it back.
 * @param {Element} tab
 * @param {HTMLElement[]} cards
 */
function restoreRow(tab, cards) {
  const row = tab.querySelector(":scope > .restore") ?? document.createElement("div");
  row.className = "restore";
  const away = cards.filter((card) => card.dataset.away === "true");
  row.toggleAttribute("hidden", !away.length);
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "hidden:";
  row.replaceChildren(
    label,
    ...away.map((card) => {
      const button = document.createElement("button");
      button.textContent = `show ${cardName(card)}`;
      button.addEventListener("click", () => {
        layout.away = layout.away.filter((name) => name !== cardName(card));
        saveLayout();
        applyLayout();
      });
      return button;
    }),
  );
  return row;
}

/**
 * Moves siblings to their new places smoothly: each starts where it was and
 * slides to where the reorder put it.
 * @param {HTMLElement[]} cards
 * @param {() => void} reorder
 */
function slideCards(cards, reorder) {
  const before = new Map(cards.map((card) => [card, card.getBoundingClientRect().top]));
  reorder();
  for (const card of cards) {
    if (card.dataset.lifted === "true") continue;
    const shift = /** @type {number} */ (before.get(card)) - card.getBoundingClientRect().top;
    if (!shift) continue;
    card.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], {
      duration: 180,
      easing: "ease-out",
    });
  }
}

/**
 * Puts `card` just before `target` by moving the cards between them: taking
 * the held card out of the page, even for a moment, loses the finger.
 * @param {HTMLElement} card
 * @param {Element | null} target
 */
function moveAround(card, target) {
  /** @type {Element[]} */
  const between = [];
  if (target && card.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING) {
    for (let node = /** @type {Element | null} */ (target); node && node !== card; node = node.nextElementSibling) {
      between.push(node);
    }
    card.after(...between);
  } else {
    for (let node = card.nextElementSibling; node && node !== target; node = node.nextElementSibling) between.push(node);
    card.before(...between);
  }
}

/**
 * Hold a card's title: drag it up or down to move it, or let go without
 * moving for its menu (hide it, or put the tab back in its first order).
 * @param {HTMLElement} card
 */
function wireCardHandle(card) {
  // The volume and brightness pills have no title: they stay where they are.
  const handle = /** @type {HTMLElement | null} */ (card.querySelector("[data-card-handle]"));
  if (!handle) return;
  const tab = /** @type {HTMLElement} */ (card.parentElement);
  /** @type {{ x: number; y: number } | null} */
  let start = null;
  /** @type {"press" | "held" | "drag"} */
  let mode = "press";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let holdTimer;
  // Where on the card the finger took it, and where the finger is now.
  let grab = 0;
  let pointerY = 0;
  let scrolling = 0;

  const follow = () => {
    card.style.transform = "";
    const natural = card.getBoundingClientRect().top;
    card.style.transform = `translateY(${pointerY - grab - natural}px)`;
  };

  const place = () => {
    const others = cardsOf(tab).filter((other) => other !== card && other.dataset.away !== "true");
    // The first card whose middle is below the finger goes after this one.
    const next = others.find((other) => {
      const box = other.getBoundingClientRect();
      return pointerY < box.top + box.height / 2;
    });
    const target = next ?? tab.querySelector(":scope > .restore");
    if (card.nextElementSibling !== target) slideCards(cardsOf(tab), () => moveAround(card, target));
    follow();
  };

  // Near the top or bottom edge the page scrolls, so a long tab stays reachable.
  const edgeScroll = () => {
    if (mode !== "drag") return;
    const bottom = innerHeight - $("stats-strip").getBoundingClientRect().height - 80;
    const speed = pointerY < 90 ? -(90 - pointerY) / 6 : pointerY > bottom ? (pointerY - bottom) / 6 : 0;
    if (speed) {
      scrollBy(0, speed);
      place();
    }
    scrolling = requestAnimationFrame(edgeScroll);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // The workspaces card's own swipe mustn't see this.
    event.stopPropagation();
    closeCardMenus();
    start = { x: event.clientX, y: event.clientY };
    mode = "press";
    handle.setPointerCapture(event.pointerId);
    holdTimer = setTimeout(() => {
      mode = "held";
      card.dataset.lifted = "true";
      vibrate(15);
    }, 450);
  });

  handle.addEventListener("pointermove", (event) => {
    if (!start) return;
    pointerY = event.clientY;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10;
    if (mode === "press" && moved) {
      clearTimeout(holdTimer);
      start = null;
      return;
    }
    if (mode === "held" && moved) {
      mode = "drag";
      grab = start.y - card.getBoundingClientRect().top;
      scrolling = requestAnimationFrame(edgeScroll);
    }
    if (mode === "drag") place();
  });

  // Once held, the finger moves the card, not the page.
  handle.addEventListener(
    "touchmove",
    (event) => {
      if (mode !== "press") event.preventDefault();
    },
    { passive: false },
  );

  const end = () => {
    clearTimeout(holdTimer);
    cancelAnimationFrame(scrolling);
    if (!start) return;
    start = null;
    card.dataset.lifted = "false";
    card.style.transform = "";
    if (mode === "held") openCardMenu(card);
    if (mode === "drag") {
      layout.order[tab.id] = cardsOf(tab).map(cardName);
      saveLayout();
    }
    mode = "press";
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("contextmenu", (event) => event.preventDefault());
}

function closeCardMenus() {
  document.querySelectorAll(".card-menu").forEach((menu) => menu.remove());
}

/** @param {HTMLElement} card */
function openCardMenu(card) {
  const tab = /** @type {HTMLElement} */ (card.parentElement);
  const menu = document.createElement("div");
  menu.className = "window-menu card-menu";
  /** @type {[string, () => void][]} */
  const items = [
    [
      `hide ${cardName(card)}`,
      () => {
        layout.away = [...new Set([...layout.away, cardName(card)])];
        saveLayout();
        applyLayout();
      },
    ],
  ];
  const saved = layout.order[tab.id];
  if (saved && saved.join() !== defaultOrder[tab.id]?.join()) {
    items.push([
      "reset order",
      () => {
        delete layout.order[tab.id];
        saveLayout();
        slideCards(cardsOf(tab), applyLayout);
      },
    ]);
  }
  items.push(["cancel", () => {}]);
  for (const [label, run] of items) {
    const button = document.createElement("button");
    button.textContent = label;
    button.addEventListener("click", () => {
      menu.remove();
      run();
    });
    menu.append(button);
  }
  // Under the title's row, at the top of the card.
  const head = /** @type {HTMLElement} */ (card.querySelector("[data-card-handle]"));
  const row = /** @type {HTMLElement} */ (head.closest(".card > *"));
  row.after(menu);
  menu.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

document.querySelectorAll(".tab > [data-card]").forEach((card) => wireCardHandle(/** @type {HTMLElement} */ (card)));
applyLayout();

const ACCENTS = [
  ["red", "#d71921"],
  ["blue", "#2f6bff"],
  ["green", "#1faa59"],
  ["orange", "#ff7a1a"],
  ["purple", "#8b5cf6"],
  ["pink", "#e0457b"],
  ["teal", "#0d9488"],
  ["gold", "#c98a00"],
];
const ACCENT_KEY = "hypr-remote-accent";

/** @param {number} index */
function setAccent(index) {
  const [, color] = /** @type {string[]} */ (ACCENTS[index]);
  document.documentElement.style.setProperty("--accent", /** @type {string} */ (color));
}

let accent = 0;
try {
  accent = Math.max(0, ACCENTS.findIndex(([name]) => name === localStorage.getItem(ACCENT_KEY)));
} catch {}
setAccent(accent);


/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} id
 * @param {number | null} percent
 */
function setMeter(id, percent, alert = false) {
  const meter = $(id);
  meter.dataset.alert = String(alert);
  /** @type {HTMLElement} */ (meter.firstElementChild).style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
}

// Sliders are left alone while a finger is on them, or the next state update
// would yank the thumb back mid-drag.
const dragging = new Set();
/**
 * @param {string} id
 * @param {number | null | undefined} value
 */
function setSlider(id, value) {
  const slider = /** @type {HTMLInputElement} */ ($(id));
  if (dragging.has(id) || value == null) return;
  slider.value = String(value);
  const [min, max] = [Number(slider.min), Number(slider.max)];
  slider.style.setProperty("--fill", `${((value - min) / (max - min)) * 100}%`);
}

/** @param {State} next */
function render(next) {
  state = next;
  renderDesk();
  renderControl();
  renderBridge();
  renderInput();
  // On every tab: the mini player, the bell, and the stats.
  renderMedia();
  renderNotifications();
  renderNightLight();
  renderStrip();
  layoutDeck();
}

function renderDesk() {
  $("workspace").textContent = state.activeWorkspace ? pad2(state.activeWorkspace) : "--";
  $("window").textContent = state.activeWindow ?? "—";
  renderRadios();
  renderTiles($("workspaces"), { actions: true });
  renderWindows();
}

/* -------------------------------------------------------------------------- */
/* Desk: workspaces                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The workspaces worth a tile: every one with windows or on a screen, then the
 * lowest free number, to start a new one.
 */
/** Workspaces in use, and the first free one ("new") unless `free` is false. */
function workspaceIds(free = true) {
  const ids = new Set(state.workspaces.filter((w) => w.windows > 0).map((w) => w.id));
  for (const monitor of state.monitors) if (monitor.workspace > 0) ids.add(monitor.workspace);
  if (state.activeWorkspace && state.activeWorkspace > 0) ids.add(state.activeWorkspace);
  return [...ids, ...(free ? [freeWorkspace(ids)] : [])].sort((a, b) => a - b);
}

/** @param {Set<number>} taken */
function freeWorkspace(taken) {
  let id = 1;
  while (taken.has(id)) id++;
  return id;
}

/**
 * The name a workspace was given in Hyprland, or null for a plain numbered one.
 * @param {number} id
 */
function workspaceName(id) {
  const name = state.workspaces.find((w) => w.id === id)?.name;
  return name && name !== String(id) ? name : null;
}

/** @param {number} id */
const workspaceLabel = (id) => workspaceName(id) ?? String(id);

/**
 * What's on a workspace, as the app used there most recently. Windows arrive
 * most recent first within each workspace.
 * @param {number} id
 */
const workspaceApp = (id) => state.windows.find((w) => w.workspace === id)?.app ?? "";

/**
 * Fills a grid of workspace tiles: the one on the desk, or the drop strip
 * shown while a window is dragged. Tiles with `actions` switch on tap.
 * @param {HTMLElement} grid
 * @param {{ actions: boolean }} options
 */
function renderTiles(grid, { actions }) {
  // Dropping a window always has "new"; the desk's card, as settings say.
  const ids = workspaceIds(!actions || settings.newTile);
  const occupied = new Set(state.workspaces.filter((w) => w.windows > 0).map((w) => w.id));
  const elsewhere = new Set(state.monitors.filter((m) => !m.focused).map((m) => m.workspace));
  /** @param {number} id */
  const hint = (id) => workspaceApp(id) || (occupied.has(id) || elsewhere.has(id) ? "" : "new");

  // Rebuilt only when the tiles themselves change, so one being held isn't
  // replaced under the finger.
  const key = ids.map((id) => `${id}:${workspaceLabel(id)}:${hint(id)}`).join();
  if (grid.dataset.rendered !== key) {
    grid.dataset.rendered = key;
    grid.replaceChildren(
      ...ids.map((id) => {
        const button = document.createElement("button");
        const label = document.createElement("span");
        label.className = "num truncate";
        label.textContent = workspaceLabel(id);
        const app = document.createElement("span");
        app.className = "app truncate";
        app.textContent = hint(id);
        button.append(label, app);
        button.setAttribute("aria-label", `workspace ${workspaceName(id) ?? id}${hint(id) ? `, ${hint(id)}` : ""}`);
        if (actions) button.dataset.action = JSON.stringify({ type: "workspace", id });
        button.dataset.id = String(id);
        button.dataset.drop = "true";
        return button;
      }),
    );
  }
  grid.querySelectorAll("button").forEach((button) => {
    const id = Number(button.dataset.id);
    button.dataset.active = String(id === state.activeWorkspace);
    button.dataset.occupied = String(occupied.has(id));
    button.dataset.visible = String(elsewhere.has(id) && id !== state.activeWorkspace);
  });
}

/**
 * Swipe across the card for the next or previous workspace with windows; hold
 * a tile to send the focused window there.
 */
function wireWorkspaceCard() {
  const card = $("workspaces-card");
  /** @type {{ x: number; y: number } | null} */
  let start = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let holdTimer;
  // A swipe or hold that ends on a tile mustn't also count as a tap on it.
  let swallowClick = false;

  card.addEventListener("pointerdown", (event) => {
    swallowClick = false;
    start = { x: event.clientX, y: event.clientY };
    clearTimeout(holdTimer);
    /** @type {HTMLElement | null} */
    const tile = /** @type {Element} */ (event.target).closest("#workspaces button");
    if (!tile) return;
    holdTimer = setTimeout(() => {
      start = null;
      swallowClick = true;
      tile.dataset.holding = "true";
      setTimeout(() => (tile.dataset.holding = "false"), 250);
      moveFocusedTo(Number(tile.dataset.id));
    }, 500);
  });

  card.addEventListener("pointermove", (event) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearTimeout(holdTimer);
  });

  card.addEventListener("pointerup", (event) => {
    clearTimeout(holdTimer);
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swallowClick = true;
      stepWorkspace(dx < 0 ? 1 : -1);
    }
  });

  card.addEventListener("pointercancel", () => {
    clearTimeout(holdTimer);
    start = null;
  });

  card.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
    },
    true,
  );
  card.addEventListener("contextmenu", (event) => event.preventDefault());
}
wireWorkspaceCard();

/** @param {1 | -1} direction */
function stepWorkspace(direction) {
  const current = state?.activeWorkspace;
  if (!current) return;
  const occupied = state.workspaces.filter((w) => w.windows > 0).map((w) => w.id);
  const next = direction > 0 ? occupied.find((id) => id > current) : occupied.findLast((id) => id < current);
  if (next) send({ type: "workspace", id: next });
  else vibrate([10, 60, 10]);
}

/** @param {number} id */
function moveFocusedTo(id) {
  const focused = state?.windows.find((w) => w.focused);
  if (!focused) return toast("no window is focused");
  if (focused.workspace === id) return toast(`${focused.app || "it"} is already on ${workspaceLabel(id)}`);
  send({ type: "window-move", address: focused.address, workspace: id });
  toast(`moved ${focused.app || "window"} to ${workspaceLabel(id)}`);
}

/* -------------------------------------------------------------------------- */
/* Desk: windows                                                              */
/* -------------------------------------------------------------------------- */

// Enough for most desks, and short enough to fit on a phone screen.
const WINDOW_CAP = 6;

// The list is rebuilt only when what it shows changes, and never while a
// finger is on a row: it'd be replaced mid-swipe or mid-drag.
let windowsKey = "";
let touchingWindow = false;
let showAllWindows = false;
/** The row swiped open to show close. @type {string | null} */
let revealedAddress = null;
/** The row held open to show its menu. @type {string | null} */
let menuAddress = null;

/** @param {State["windows"]} windows */
function shownWindows(windows) {
  if (showAllWindows || windows.length <= WINDOW_CAP) return windows;
  const shown = windows.slice(0, WINDOW_CAP);
  // The focused window always makes the cut. Windows are in workspace order,
  // so one past the cut belongs at the end.
  const focused = windows.find((w) => w.focused);
  if (focused && !shown.includes(focused)) shown[WINDOW_CAP - 1] = focused;
  return shown;
}

function renderWindows() {
  const windows = state.windows;
  $("window-count").textContent = String(windows.length);
  if (touchingWindow) return;

  const shown = shownWindows(windows);
  const key = JSON.stringify([
    shown.map((w) => [w.address, w.title, w.app, w.workspace, w.focused, w.fullscreen, w.floating]),
    windows.length,
    revealedAddress,
    menuAddress,
  ]);
  if (key === windowsKey) return;
  windowsKey = key;

  const more = /** @type {HTMLButtonElement} */ ($("windows-more"));
  more.hidden = windows.length <= WINDOW_CAP;
  more.textContent = showAllWindows ? "show less" : `show ${windows.length - shown.length} more`;

  $("windows").replaceChildren(
    ...shown.map((win) => {
      const item = document.createElement("div");
      const row = document.createElement("div");
      row.className = "window";
      row.dataset.focused = String(win.focused);
      row.innerHTML = `
        <button class="close">close</button>
        <div class="window-body">
          <span class="ws"></span>
          <div style="min-width: 0">
            <p class="app truncate" style="margin: 0"></p>
            <p class="title truncate" style="margin: 0"></p>
          </div>
        </div>`;
      const body = /** @type {HTMLElement} */ (row.querySelector(".window-body"));
      const close = /** @type {HTMLElement} */ (row.querySelector(".close"));
      // textContent, not innerHTML: window titles are arbitrary text.
      /** @type {HTMLElement} */ (row.querySelector(".ws")).textContent = String(win.workspace);
      /** @type {HTMLElement} */ (row.querySelector(".app")).textContent =
        win.app + (win.fullscreen ? " · fullscreen" : win.floating ? " · floating" : "");
      /** @type {HTMLElement} */ (row.querySelector(".title")).textContent = win.title;
      // Settings can keep only the app, or only the title.
      /** @type {HTMLElement} */ (row.querySelector(".app")).hidden = settings.windowRows === "title";
      /** @type {HTMLElement} */ (row.querySelector(".title")).hidden = settings.windowRows === "app";
      close.setAttribute("aria-label", `close ${win.app || win.title}`);
      close.addEventListener("click", () => {
        send({ type: "window", op: "close", address: win.address });
        revealedAddress = null;
      });
      if (revealedAddress === win.address) {
        row.dataset.open = "true";
        body.style.transform = "translateX(-5.5rem)";
      }
      body.addEventListener("contextmenu", (event) => event.preventDefault());

      item.append(row);
      if (menuAddress === win.address) item.append(windowMenu(win));
      attachWindowGestures(row, body, win);
      return item;
    }),
  );
}

$("windows-more").addEventListener("click", () => {
  showAllWindows = !showAllWindows;
  renderWindows();
});

/** @param {State["windows"][number]} win */
function windowMenu(win) {
  const menu = document.createElement("div");
  menu.className = "window-menu";
  /** @type {[string, "fullscreen" | "float" | "kill"][]} */
  const items = [
    [win.fullscreen ? "exit fullscreen" : "fullscreen", "fullscreen"],
    [win.floating ? "tile" : "float", "float"],
    ["force kill", "kill"],
  ];
  for (const [label, op] of items) {
    const button = document.createElement("button");
    button.textContent = label;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let disarm;
    button.addEventListener("click", () => {
      // Killing loses unsaved work, so it takes a second tap.
      if (op === "kill" && button.dataset.armed !== "true") {
        button.dataset.armed = "true";
        button.textContent = "tap again";
        disarm = setTimeout(() => {
          button.dataset.armed = "false";
          button.textContent = label;
        }, 3000);
        return;
      }
      clearTimeout(disarm);
      send({ type: "window", op, address: win.address });
      menuAddress = null;
      renderWindows();
    });
    menu.append(button);
  }
  return menu;
}

/**
 * One row's gestures: tap to focus; swipe left to reveal close, or all the way
 * to close at once; hold, then drag onto a workspace or let go for the menu.
 * @param {HTMLElement} row
 * @param {HTMLElement} body
 * @param {State["windows"][number]} win
 */
function attachWindowGestures(row, body, win) {
  /** @type {{ x: number; y: number } | null} */
  let start = null;
  /** @type {"press" | "swipe" | "scroll" | "held" | "drag"} */
  let mode = "press";
  let dx = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let holdTimer;
  const revealWidth = () => /** @type {HTMLElement} */ (row.querySelector(".close")).offsetWidth;
  const offset = () => (revealedAddress === win.address ? -revealWidth() : 0);

  body.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    mode = "press";
    dx = offset();
    touchingWindow = true;
    body.setPointerCapture(event.pointerId);
    holdTimer = setTimeout(() => {
      mode = "held";
      body.dataset.held = "true";
      vibrate(15);
    }, 450);
  });

  body.addEventListener("pointermove", (event) => {
    if (!start) return;
    const mx = event.clientX - start.x;
    const my = event.clientY - start.y;
    if (mode === "press" && Math.hypot(mx, my) > 10) {
      clearTimeout(holdTimer);
      mode = Math.abs(mx) > Math.abs(my) ? "swipe" : "scroll";
      if (mode === "swipe") {
        body.dataset.dragging = "true";
        row.dataset.open = "true";
      }
    }
    if (mode === "swipe") {
      dx = Math.min(0, offset() + mx);
      body.style.transform = `translateX(${dx}px)`;
    }
    if (mode === "held" && Math.hypot(mx, my) > 10) {
      mode = "drag";
      body.dataset.held = "false";
      startDrag(win, body);
    }
    if (mode === "drag") moveDrag(event.clientX, event.clientY);
  });

  // Once held, the finger drags the window, not the page.
  body.addEventListener(
    "touchmove",
    (event) => {
      if (mode === "held" || mode === "drag") event.preventDefault();
    },
    { passive: false },
  );

  /** @param {boolean} cancelled */
  const end = (cancelled) => {
    clearTimeout(holdTimer);
    if (!start) return;
    start = null;
    touchingWindow = false;
    body.dataset.held = "false";
    body.dataset.dragging = "false";

    if (cancelled) {
      endDrag(false);
      body.style.transform = offset() ? `translateX(${offset()}px)` : "";
      row.dataset.open = String(Boolean(offset()));
    } else if (mode === "press") {
      // A tap on an open row, or while another is open, just closes it.
      if (revealedAddress) revealedAddress = null;
      else send({ type: "window", op: "focus", address: win.address });
      menuAddress = null;
    } else if (mode === "swipe") {
      // All the way closes at once, unless settings ask first: then it
      // stops at the close button.
      if (-dx > row.clientWidth * 0.6 && !settings.confirmClose) {
        body.style.transform = "translateX(-100%)";
        send({ type: "window", op: "close", address: win.address });
        revealedAddress = null;
      } else if (-dx > revealWidth() / 2) {
        body.style.transform = `translateX(-${revealWidth()}px)`;
        revealedAddress = win.address;
      } else {
        body.style.transform = "";
        if (revealedAddress === win.address) revealedAddress = null;
        body.addEventListener("transitionend", () => (row.dataset.open = "false"), { once: true });
      }
    } else if (mode === "held") {
      menuAddress = menuAddress === win.address ? null : win.address;
    } else if (mode === "drag") {
      endDrag(true);
    }
    mode = "press";
    // Catch up on anything that arrived while the finger was down.
    renderWindows();
  };
  body.addEventListener("pointerup", () => end(false));
  body.addEventListener("pointercancel", () => end(true));
}

/**
 * The window being dragged, its stand-in under the finger, and the tile it's
 * over.
 * @type {{ win: State["windows"][number]; body: HTMLElement; ghost: HTMLElement; target: HTMLElement | null } | null}
 */
let drag = null;

/**
 * @param {State["windows"][number]} win
 * @param {HTMLElement} body
 */
function startDrag(win, body) {
  const ghost = document.createElement("div");
  ghost.className = "ghost truncate";
  ghost.textContent = win.app || win.title;
  document.body.append(ghost);
  body.dataset.lifted = "true";
  // Tiles pinned to the top, reachable however far down the list is.
  renderTiles($("drop-targets"), { actions: false });
  $("drop-strip").hidden = false;
  drag = { win, body, ghost, target: null };
  vibrate(8);
}

/**
 * @param {number} x
 * @param {number} y
 */
function moveDrag(x, y) {
  if (!drag) return;
  drag.ghost.style.left = `${x}px`;
  drag.ghost.style.top = `${y}px`;
  /** @type {HTMLElement | null} */
  const tile = document.elementFromPoint(x, y)?.closest("[data-drop]") ?? null;
  if (tile === drag.target) return;
  if (drag.target) drag.target.dataset.target = "false";
  drag.target = tile;
  if (tile) {
    tile.dataset.target = "true";
    vibrate(5);
  }
}

/** @param {boolean} drop */
function endDrag(drop) {
  if (!drag) return;
  const { win, body, ghost, target } = drag;
  drag = null;
  ghost.remove();
  body.dataset.lifted = "false";
  if (target) target.dataset.target = "false";
  $("drop-strip").hidden = true;
  if (!drop || !target) return;
  const id = Number(target.dataset.id);
  if (id === win.workspace) return;
  send({ type: "window-move", address: win.address, workspace: id });
  toast(`moved ${win.app || "window"} to ${workspaceLabel(id)}`);
}

/* -------------------------------------------------------------------------- */
/* Media: the mini player over the tab bar, and its sheet                     */
/* -------------------------------------------------------------------------- */

/**
 * Where the track was when the laptop last said, and when that was: the bar
 * counts on from there on its own, rather than asking every second.
 */
let mediaClock = { position: 0, at: 0, playing: false };

/** @param {number} total */
function clockTime(total) {
  const s = Math.max(0, Math.floor(total));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours ? `${hours}:${pad2(minutes)}:${pad2(s % 60)}` : `${minutes}:${pad2(s % 60)}`;
}

function renderMedia() {
  const media = state.media;
  $("media-status").textContent = media?.status ? `${media.status} · ${media.player}` : "nothing playing";
  $("media-title").textContent = media?.title || "—";
  $("media-artist").textContent = media?.artist || " ";
  const icon = media?.status === "Playing" ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" />' : '<path d="M8 5v14l11-7z" />';
  $("play-icon").innerHTML = icon;
  $("player-play-icon").innerHTML = icon;

  // The player shows while a player has something loaded, playing or paused.
  // Settings can keep it to control, or off.
  const here = settings.player === "all" || (settings.player === "control" && document.body.dataset.tab === "control");
  const showing = Boolean(media?.status) && here;
  $("player").hidden = !showing;
  document.body.dataset.playing = String(showing);
  if (!media?.status && !$("media-sheet").hidden) closeSheet();
  $("player-title").textContent = media?.title || media?.player || "";
  $("player-artist").textContent = media?.artist || media?.status?.toLowerCase() || "";

  mediaClock = { position: media?.position ?? 0, at: performance.now(), playing: media?.status === "Playing" };
  const seek = /** @type {HTMLInputElement} */ ($("media-seek"));
  const length = media?.length ?? null;
  seek.disabled = !length || media?.position == null;
  seek.max = String(Math.max(1, Math.round(length ?? 1)));
  $("media-length").textContent = length ? clockTime(length) : "--:--";
  tickMedia();

  $("media-volume-level").textContent = state.volume ? String(state.volume.level) : "--";
  setSlider("media-volume", state.volume?.level);
  loadArt(media?.art ?? null);
}

function tickMedia() {
  const media = state?.media;
  if (dragging.has("media-seek")) return;
  if (media?.position == null) {
    $("media-elapsed").textContent = "--:--";
    setSlider("media-seek", 0);
    return;
  }
  const running = mediaClock.playing ? (performance.now() - mediaClock.at) / 1000 : 0;
  const elapsed = Math.min(media.length ?? Infinity, mediaClock.position + running);
  $("media-elapsed").textContent = clockTime(elapsed);
  setSlider("media-seek", Math.round(elapsed));
}
setInterval(() => {
  if (state && document.visibilityState === "visible" && !$("media-sheet").hidden) tickMedia();
}, 500);

// Seeking waits for the finger to lift: one jump, not one per pixel.
{
  const seek = /** @type {HTMLInputElement} */ ($("media-seek"));
  seek.addEventListener("pointerdown", () => dragging.add("media-seek"));
  seek.addEventListener("pointercancel", () => dragging.delete("media-seek"));
  seek.addEventListener("input", () => {
    seek.style.setProperty("--fill", `${(Number(seek.value) / Number(seek.max)) * 100}%`);
    $("media-elapsed").textContent = clockTime(Number(seek.value));
  });
  seek.addEventListener("change", () => {
    send({ type: "media-seek", to: Number(seek.value) }, { buzz: false });
    mediaClock = { ...mediaClock, position: Number(seek.value), at: performance.now() };
    dragging.delete("media-seek");
  });
}

// Album art comes over HTTP with the token in a header, like screen frames.
/** @type {string | null} */
let artKey = null;
/** @type {string | null} */
let artUrl = null;

/** @param {string | null} key */
function loadArt(key) {
  if (key === artKey) return;
  artKey = key;
  const images = /** @type {HTMLImageElement[]} */ ([$("media-art"), $("player-art")]);
  /** @param {string | null} url */
  const show = (url) => {
    if (artUrl) URL.revokeObjectURL(artUrl);
    artUrl = url;
    for (const image of images) {
      image.hidden = !url;
      if (url) image.src = url;
      else image.removeAttribute("src");
    }
  };
  if (!key) return show(null);
  fetch(`/art?k=${encodeURIComponent(key)}`, { headers: { "x-token": token ?? "" } })
    .then((response) => {
      if (!response.ok) throw new Error(`art: ${response.status}`);
      return response.blob();
    })
    .then((blob) => artKey === key && show(URL.createObjectURL(blob)))
    .catch(() => artKey === key && show(null));
}

function renderControl() {
  renderScenes();
  renderVolume();
  renderBrightness();
}

/* -------------------------------------------------------------------------- */
/* Control: scenes                                                            */
/* -------------------------------------------------------------------------- */

function renderScenes() {
  const row = $("scenes");
  const key = JSON.stringify(state.scenes.map(({ active: _a, undo: _u, ...scene }) => scene));
  if (row.dataset.rendered !== key) {
    row.dataset.rendered = key;
    const add = document.createElement("button");
    add.className = "scene-add";
    add.textContent = "+";
    add.setAttribute("aria-label", "new scene");
    add.addEventListener("click", () => openSceneEditor(null));
    // The server keeps at most twelve.
    add.hidden = state.scenes.length >= 12;
    row.replaceChildren(
      ...state.scenes.map((scene) => {
        const button = document.createElement("button");
        button.className = "truncate";
        button.textContent = scene.label;
        button.dataset.id = scene.id;
        tapOrHold(button, {
          tap: () => send({ type: "scene", id: scene.id }),
          hold: () => openSceneEditor(scene),
        });
        return button;
      }),
      add,
    );
  }
  state.scenes.forEach((scene, index) => {
    /** @type {HTMLElement} */ (row.children[index]).dataset.active = String(scene.active);
  });
}

/* -------------------------------------------------------------------------- */
/* Control: the scene editor                                                  */
/* -------------------------------------------------------------------------- */

/** @typedef {import("../src/scenes").SceneInput} SceneInput */

/** The scene being edited; settings left undefined are ones it leaves alone. @type {SceneInput} */
let draft = { label: "" };

/** @param {State["scenes"][number] | null} scene */
function openSceneEditor(scene) {
  if (scene) {
    const { active: _a, undo: _u, ...settings } = scene;
    draft = settings;
  } else {
    draft = { label: "" };
  }
  const del = $("scene-delete");
  del.hidden = !scene;
  del.dataset.armed = "false";
  del.textContent = "delete";
  /** @type {HTMLInputElement} */ ($("scene-name")).value = draft.label;
  $("scene-sheet-title").textContent = scene ? `edit ${scene.label}` : "new scene";
  renderSceneEditor();
  closeSheet();
  $("scene-sheet").hidden = false;
  $("sheet-backdrop").hidden = false;
}

/** Which choice each setting shows: "leave" when the scene doesn't set it. */
function sceneChoices() {
  const night = draft.nightLight;
  return {
    volume: draft.volume === undefined ? "leave" : "set",
    brightness: draft.brightness === undefined ? "leave" : "set",
    dnd: draft.dnd === undefined ? "leave" : draft.dnd ? "on" : "off",
    nightLight: night === undefined ? "leave" : night === false ? "off" : nightStep(night) === 1 ? "warm" : "warmer",
    media: draft.media ?? "leave",
  };
}

function renderSceneEditor() {
  const choices = /** @type {Record<string, string>} */ (sceneChoices());
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#scene-sheet [data-setting]")).forEach((button) => {
    button.dataset.active = String(choices[/** @type {string} */ (button.dataset.setting)] === button.dataset.value);
  });
  for (const [id, value] of /** @type {[string, number | undefined][]} */ ([
    ["scene-volume", draft.volume],
    ["scene-brightness", draft.brightness],
  ])) {
    $(id).hidden = value === undefined;
    if (value !== undefined) setSlider(id, value);
  }
}

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#scene-sheet [data-setting]")).forEach((button) =>
  button.addEventListener("click", () => {
    const value = button.dataset.value;
    const leave = value === "leave";
    switch (button.dataset.setting) {
      case "volume":
        draft.volume = leave ? undefined : (draft.volume ?? state.volume?.level ?? 50);
        break;
      case "brightness":
        draft.brightness = leave ? undefined : (draft.brightness ?? Math.max(5, state.brightness.screens[0]?.level ?? 60));
        break;
      case "dnd":
        draft.dnd = leave ? undefined : value === "on";
        break;
      case "nightLight":
        draft.nightLight = leave ? undefined : value === "off" ? false : value === "warm" ? settings.warm : settings.warmer;
        break;
      case "media":
        draft.media = leave ? undefined : /** @type {"play" | "pause"} */ (value);
        break;
    }
    renderSceneEditor();
  }),
);

for (const [id, key] of /** @type {const} */ ([
  ["scene-volume", "volume"],
  ["scene-brightness", "brightness"],
])) {
  const slider = /** @type {HTMLInputElement} */ ($(id));
  slider.addEventListener("input", () => {
    draft[key] = Number(slider.value);
    const [min, max] = [Number(slider.min), Number(slider.max)];
    slider.style.setProperty("--fill", `${((Number(slider.value) - min) / (max - min)) * 100}%`);
  });
}

$("scene-name").addEventListener("input", () => {
  draft.label = /** @type {HTMLInputElement} */ ($("scene-name")).value;
});

// Fills in the volume, brightness, do not disturb and night light as they are.
$("scene-now").addEventListener("click", () => {
  if (state.volume) draft.volume = state.volume.level;
  const level = state.brightness.screens[0]?.level;
  if (level != null) draft.brightness = Math.max(5, level);
  if (state.notifications) draft.dnd = state.notifications.dnd;
  if (state.nightLight) draft.nightLight = state.nightLight.on ? state.nightLight.temperature : false;
  renderSceneEditor();
});

$("scene-save").addEventListener("click", () => {
  const label = draft.label.trim();
  if (!label) {
    toast("give it a name");
    $("scene-name").focus();
    return;
  }
  if (send({ type: "scene-put", scene: { ...draft, label } })) closeSheet();
});

// Deleting takes a second tap.
$("scene-delete").addEventListener("click", () => {
  const del = $("scene-delete");
  if (del.dataset.armed !== "true") {
    del.dataset.armed = "true";
    del.textContent = "tap again";
    setTimeout(() => {
      del.dataset.armed = "false";
      del.textContent = "delete";
    }, 3000);
    return;
  }
  if (draft.id && send({ type: "scene-delete", id: draft.id })) closeSheet();
});

/* -------------------------------------------------------------------------- */
/* Control: volume and the microphone                                         */
/* -------------------------------------------------------------------------- */

function renderVolume() {
  const volume = state.volume;
  setPill("volume-pill", volume?.level ?? null, volume?.muted ? "muted" : undefined);
  $("volume-pill").dataset.muted = String(Boolean(volume?.muted));

  const mic = $("mic");
  mic.hidden = !state.mic;
  mic.dataset.muted = String(Boolean(state.mic?.muted));
  $("mic-text").textContent = state.mic?.muted ? "mic muted" : "mic on";
}

/* -------------------------------------------------------------------------- */
/* Control: brightness and night light                                        */
/* -------------------------------------------------------------------------- */

function renderBrightness() {
  const { screens, ddc } = state.brightness;
  // One pill for every screen; it shows the first (the laptop's, usually).
  setPill("brightness-pill", screens.find((screen) => screen.level != null)?.level ?? null);
  $("brightness-pill").hidden = screens.length === 0;

  const hint = $("ddc-hint");
  hint.hidden = !ddc;
  hint.innerHTML =
    ddc === "missing"
      ? "your other screen needs <code>ddcutil</code> for brightness. run <code>scripts/setup-input.sh</code>, or install it."
      : "<code>ddcutil</code> can't reach your other screen. run <code>scripts/setup-input.sh</code> to allow it.";
}

/* -------------------------------------------------------------------------- */
/* Control: the volume and brightness pills                                   */
/* -------------------------------------------------------------------------- */

/**
 * Shows a level on a pill, unless a finger is on it.
 * @param {string} id
 * @param {number | null} level
 * @param {string} [text] shown instead of the number
 */
function setPill(id, level, text) {
  const pill = $(id);
  if (pill.dataset.dragging === "true") return;
  const [min, max] = [Number(pill.getAttribute("aria-valuemin")), Number(pill.getAttribute("aria-valuemax"))];
  pill.style.setProperty("--level", String(level == null ? 0 : (level - min) / (max - min)));
  pill.setAttribute("aria-valuenow", String(level ?? min));
  /** @type {HTMLElement} */ (pill.querySelector(".level-value")).textContent = text ?? (level == null ? "--" : String(level));
}

/**
 * A pill follows the finger up and down from wherever it lands, like a phone's
 * own sliders: it moves from the level it had, rather than jumping to the
 * finger. `live` sends while moving (at most every 80ms); `done` once it lifts;
 * `tap` when it lifts without having moved.
 * @param {string} id
 * @param {{ live?: (level: number) => Action; done: (level: number) => Action; tap?: () => Action }} actions
 */
function wirePill(id, { live, done, tap }) {
  const pill = $(id);
  const min = Number(pill.getAttribute("aria-valuemin"));
  const max = Number(pill.getAttribute("aria-valuemax"));
  /** @type {{ y: number; level: number } | null} */
  let start = null;
  let level = min;
  let sent = 0;

  pill.addEventListener("pointerdown", (event) => {
    pill.setPointerCapture(event.pointerId);
    start = { y: event.clientY, level: Number(pill.getAttribute("aria-valuenow") ?? min) };
    level = start.level;
  });

  pill.addEventListener("pointermove", (event) => {
    if (!start) return;
    const moved = start.y - event.clientY;
    if (pill.dataset.dragging !== "true" && Math.abs(moved) < 4) return;
    pill.dataset.dragging = "true";
    level = Math.round(Math.min(max, Math.max(min, start.level + (moved / pill.clientHeight) * (max - min))));
    pill.style.setProperty("--level", String((level - min) / (max - min)));
    pill.setAttribute("aria-valuenow", String(level));
    /** @type {HTMLElement} */ (pill.querySelector(".level-value")).textContent = String(level);
    if (live && Date.now() - sent > 80) {
      sent = Date.now();
      send(live(level), { buzz: false });
    }
  });

  /** @param {boolean} cancelled */
  const end = (cancelled) => {
    if (!start) return;
    const moved = pill.dataset.dragging === "true";
    start = null;
    pill.dataset.dragging = "false";
    if (moved) send(done(level), { buzz: false });
    else if (tap && !cancelled) send(tap());
  };
  pill.addEventListener("pointerup", () => end(false));
  pill.addEventListener("pointercancel", () => end(true));
}

wirePill("volume-pill", {
  live: (level) => ({ type: "volume-set", level }),
  done: (level) => ({ type: "volume-set", level }),
  tap: () => ({ type: "volume", command: "mute" }),
});
// The laptop follows the finger; every screen (monitors over DDC take up to a
// second each) gets the level once it lifts.
wirePill("brightness-pill", {
  live: (level) => ({ type: "brightness-set", level, screen: "laptop" }),
  done: (level) => ({ type: "brightness-set", level }),
});


/* -------------------------------------------------------------------------- */
/* Notifications: the bell in the header, its sheet, and the deck's toggle    */
/* -------------------------------------------------------------------------- */

const NOTE_CAP = 6;
let notesKey = "";
let showAllNotes = false;
let touchingNote = false;
/** The deck's do-not-disturb, as last tapped. @type {{ on: boolean; until: number } | null} */
let dndTapped = null;

/** @param {number} time */
function timeAgo(time) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function renderNotifications() {
  const notifications = state.notifications;
  $("notifications-body").hidden = !notifications;
  $("notifications-missing").hidden = Boolean(notifications);
  $("deck-dnd").dataset.supported = String(Boolean(notifications));
  // The badge counts what the sheet lists, not ones from before the remote.
  const listed = notifications?.list.length ?? 0;
  $("notification-count").textContent = listed ? String(listed) : "";
  $("bell-count").hidden = listed === 0 || !settings.bellCount;
  $("bell-count").textContent = listed > 99 ? "99+" : String(listed);
  $("bell").setAttribute("aria-label", listed ? `notifications, ${listed}` : "notifications");
  if (!notifications) return;

  $("bell").dataset.dnd = String(notifications.dnd);
  popUpNew(notifications);
  // A state sent before a tap reached the laptop mustn't flick it back.
  const tapped = dndTapped && Date.now() < dndTapped.until ? dndTapped.on : null;
  $("deck-dnd").dataset.on = String(tapped ?? notifications.dnd);
  // Only notifications: none at all says so, and hides what acts on them.
  $("notes-empty").hidden = listed > 0;
  $("notes-clear").hidden = listed === 0;
  $("notes-hint").hidden = listed === 0;
  $("notes-hint").textContent = "tap to open on the laptop · swipe either way to dismiss";
  renderNotes();
}

// Notifications already seen; null until the first list, which pops nothing.
/** @type {Set<number> | null} */
let seenNotes = null;

/**
 * A notification that arrives while the remote is open pops up here and
 * buzzes, unless do not disturb is on or pop-ups are off in settings.
 * @param {NonNullable<State["notifications"]>} notifications
 */
function popUpNew(notifications) {
  const fresh = seenNotes ? notifications.list.filter((note) => !seenNotes?.has(note.id)) : [];
  seenNotes = new Set(notifications.list.map((note) => note.id));
  const note = fresh.at(-1);
  if (!note || !settings.notePopups || notifications.dnd || document.visibilityState !== "visible") return;
  vibrate([20, 50, 20]);
  const text = [note.app, note.title || note.body].filter(Boolean).join(": ").slice(0, 80);
  alertToast(fresh.length > 1 ? `${text} (+${fresh.length - 1} more)` : text, {
    label: "open",
    run: () => send({ type: "notification", op: "open", id: note.id }),
  });
}

function renderNotes() {
  if (touchingNote || !state.notifications) return;
  const list = state.notifications.list;
  const shown = showAllNotes ? list : list.slice(0, NOTE_CAP);
  const more = /** @type {HTMLButtonElement} */ ($("notes-more"));
  more.hidden = list.length <= NOTE_CAP;
  more.textContent = showAllNotes ? "show less" : `show ${list.length - shown.length} more`;

  // Minutes are part of the key, so "2m" becomes "3m".
  const key = JSON.stringify(shown.map((note) => [note.id, timeAgo(note.time)]));
  if (key === notesKey) return;
  notesKey = key;
  $("notes").replaceChildren(
    ...shown.map((note) => {
      const row = document.createElement("div");
      row.className = "window note";
      row.innerHTML = `
        <div class="window-body">
          <div style="min-width: 0">
            <p class="app truncate" style="margin: 0"></p>
            <p class="title truncate" style="margin: 0"></p>
            <p class="text truncate"></p>
          </div>
        </div>`;
      const body = /** @type {HTMLElement} */ (row.querySelector(".window-body"));
      // textContent, not innerHTML: notifications are anyone's text.
      /** @type {HTMLElement} */ (row.querySelector(".app")).textContent = `${note.app || "notification"} · ${timeAgo(note.time)}`;
      /** @type {HTMLElement} */ (row.querySelector(".title")).textContent = note.title;
      const text = /** @type {HTMLElement} */ (row.querySelector(".text"));
      text.textContent = note.body;
      text.hidden = !note.body;
      attachNoteGestures(row, body, note.id);
      return row;
    }),
  );
}

$("notes-more").addEventListener("click", () => {
  showAllNotes = !showAllNotes;
  renderNotes();
});

/**
 * Tap to open the app on the laptop; swipe either way, past a third of the
 * row, to dismiss it.
 * @param {HTMLElement} row
 * @param {HTMLElement} body
 * @param {number} id
 */
function attachNoteGestures(row, body, id) {
  /** @type {{ x: number; y: number } | null} */
  let start = null;
  /** @type {"press" | "swipe" | "scroll"} */
  let mode = "press";
  let dx = 0;

  body.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    mode = "press";
    dx = 0;
    touchingNote = true;
    body.setPointerCapture(event.pointerId);
  });

  body.addEventListener("pointermove", (event) => {
    if (!start) return;
    const mx = event.clientX - start.x;
    const my = event.clientY - start.y;
    if (mode === "press" && Math.hypot(mx, my) > 10) {
      mode = Math.abs(mx) > Math.abs(my) ? "swipe" : "scroll";
      if (mode === "swipe") {
        body.dataset.dragging = "true";
        row.dataset.open = "true";
      }
    }
    if (mode === "swipe") {
      dx = mx;
      body.style.transform = `translateX(${dx}px)`;
    }
  });

  /** @param {boolean} cancelled */
  const end = (cancelled) => {
    if (!start) return;
    start = null;
    touchingNote = false;
    body.dataset.dragging = "false";
    if (!cancelled && mode === "press") send({ type: "notification", op: "open", id });
    if (!cancelled && mode === "swipe" && Math.abs(dx) > row.clientWidth / 3) {
      body.style.transform = `translateX(${dx < 0 ? -100 : 100}%)`;
      send({ type: "notification", op: "close", id });
    } else if (mode === "swipe" || cancelled) {
      body.style.transform = "";
      body.addEventListener("transitionend", () => (row.dataset.open = "false"), { once: true });
    }
    renderNotes();
  };
  body.addEventListener("pointerup", () => end(false));
  body.addEventListener("pointercancel", () => end(true));
}

/* -------------------------------------------------------------------------- */
/* Desk header: Wi-Fi and Bluetooth                                           */
/* -------------------------------------------------------------------------- */

function renderRadios() {
  const { wifi, bluetooth } = state.radios;
  const off = settings.headerOff;
  $("wifi").hidden = !wifi || off.includes("wifi");
  $("wifi").dataset.on = String(Boolean(wifi?.network));
  $("bluetooth").hidden = !bluetooth || off.includes("bluetooth");
  $("bluetooth").dataset.on = String(Boolean(bluetooth?.on));

  // The laptop's battery, a number inside a battery as a phone shows its own.
  const battery = state.stats.battery;
  const icon = $("battery");
  icon.hidden = !battery || off.includes("battery");
  if (!battery) return;
  icon.dataset.state = battery.charging ? "charging" : battery.level <= 20 ? "low" : "normal";
  /** @type {HTMLElement} */ (icon.querySelector(".battery-body")).style.setProperty("--level", String(battery.level / 100));
  $("battery-level").textContent = String(battery.level);
  icon.setAttribute("aria-label", `laptop battery ${battery.level}%${battery.charging ? ", charging" : ""}`);
  alertBattery(battery);
}

// Laptop battery low: once as it drops to the level set in settings, and
// again only after charging or climbing back above it.
let batteryArmed = true;

/** @param {{ level: number; charging: boolean }} battery */
function alertBattery({ level, charging }) {
  const at = settings.batteryAlert;
  if (charging || !at || level > at + 2) {
    batteryArmed = true;
    return;
  }
  if (!batteryArmed || level > at) return;
  batteryArmed = false;
  vibrate([30, 60, 30]);
  alertToast(`laptop battery at ${level}%. plug it in`);
}

$("battery").addEventListener("click", () => {
  const battery = state?.stats.battery;
  if (battery) toast(`laptop battery ${battery.level}%${battery.charging ? ", charging" : ""}`);
});

function renderBridge() {
  renderClipboard();
  renderFiles();
  renderScreen();
}

function renderInput() {
  const { keyboard, clicks } = state.input;
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-needs="keyboard"]')).forEach(
    (b) => (b.disabled = !keyboard),
  );
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-needs="clicks"]')).forEach(
    (b) => (b.disabled = !clicks),
  );
  /** @type {HTMLInputElement} */ ($("typing")).disabled = !keyboard;
  $("keyboard-hint").hidden = keyboard;
  $("clicks-hint").hidden = clicks;
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

// data-action sends its JSON; data-key presses a named key. Either can carry
// data-repeat to keep firing while held (volume, arrows, backspace).
/** @type {ReturnType<typeof setTimeout> | undefined} */
let repeatTimer = undefined;
let repeated = false;
function stopRepeat() {
  clearTimeout(repeatTimer);
  clearInterval(repeatTimer);
  repeatTimer = undefined;
}

/**
 * @param {HTMLElement} button
 * @returns {Action}
 */
const actionOf = (button) =>
  button.dataset.action
    ? JSON.parse(button.dataset.action)
    : /** @type {Action} */ ({ type: "key", key: button.dataset.key });

// Click, not pointerdown: the browser withholds it when a touch turns into a
// scroll, and keyboards and switch access produce it too.
document.addEventListener("click", (event) => {
  /** @type {HTMLButtonElement | null} */
  const button = /** @type {Element} */ (event.target).closest("[data-action], [data-key]");
  if (!button || button.disabled) return;
  // A hold has already sent; its release shouldn't add one more. Keyboard
  // clicks (detail 0) never follow a hold.
  if (repeated && event.detail !== 0) return;
  send(actionOf(button));
});

// Holding a data-repeat button starts sending once the hold is sure. A scroll
// begun on it is a pointercancel before then, so it sends nothing.
document.addEventListener("pointerdown", (event) => {
  stopRepeat();
  repeated = false;
  /** @type {HTMLButtonElement | null} */
  const button = /** @type {Element} */ (event.target).closest("[data-repeat]");
  if (!button || button.disabled) return;
  const action = actionOf(button);
  repeatTimer = setTimeout(() => {
    repeated = true;
    send(action);
    repeatTimer = setInterval(() => send(action, { buzz: false }), 110);
  }, 400);
});
["pointerup", "pointercancel"].forEach((type) => document.addEventListener(type, stopRepeat));

/**
 * A range input that sends while dragging, at most every 80ms, or (with
 * `live: false`) only once the finger lifts.
 * @param {HTMLInputElement} slider
 * @param {(level: number) => Action} toAction
 * @param {{ live?: boolean }} [options]
 */
function wireRange(slider, toAction, { live = true } = {}) {
  let last = 0;
  slider.addEventListener("pointerdown", () => dragging.add(slider.id));
  slider.addEventListener("pointercancel", () => dragging.delete(slider.id));
  slider.addEventListener("input", () => {
    const [min, max] = [Number(slider.min), Number(slider.max)];
    slider.style.setProperty("--fill", `${((Number(slider.value) - min) / (max - min)) * 100}%`);
    if (!live || Date.now() - last < 80) return;
    last = Date.now();
    send(toAction(Number(slider.value)), { buzz: false });
  });
  slider.addEventListener("change", () => {
    send(toAction(Number(slider.value)), { buzz: false });
    dragging.delete(slider.id);
  });
}

/**
 * @param {string} id
 * @param {(level: number) => Action} toAction
 */
const wireSlider = (id, toAction) => wireRange(/** @type {HTMLInputElement} */ ($(id)), toAction);
wireSlider("media-volume", (level) => ({ type: "volume-set", level }));

/**
 * A tap does one thing, a half-second hold another (and not the tap too).
 * @param {HTMLElement} element
 * @param {{ tap: () => void; hold: () => void }} handlers
 */
function tapOrHold(element, { tap, hold }) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {{ x: number; y: number } | null} */
  let start = null;
  let held = false;
  element.addEventListener("pointerdown", (event) => {
    held = false;
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      held = true;
      vibrate(15);
      hold();
    }, 500);
  });
  element.addEventListener("pointermove", (event) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearTimeout(timer);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) =>
    element.addEventListener(type, () => clearTimeout(timer)),
  );
  element.addEventListener("click", () => {
    if (held) held = false;
    else tap();
  });
  element.addEventListener("contextmenu", (event) => event.preventDefault());
}

// On the desk's deck: one tap, unlike the power holds. It turns the accent
// colour at once rather than waiting for the laptop to say so.
$("deck-dnd").addEventListener("click", () => {
  const on = $("deck-dnd").dataset.on !== "true";
  if (!send({ type: "dnd", mode: on ? "on" : "off" })) return;
  dndTapped = { on, until: Date.now() + 2000 };
  $("deck-dnd").dataset.on = String(on);
  toast(on ? "do not disturb on" : "do not disturb off");
});

// Night light on the deck: each tap steps off → warm → warmer → off, at the
// warmths set in settings.
const NIGHT_NAMES = ["night light off", "night light warm", "night light warmer"];
/** @type {{ level: number; until: number } | null} */
let nightTapped = null;

/** 1 for warm, 2 for warmer: whichever the warmth is nearest. @param {number} temperature */
function nightStep(temperature) {
  return Math.abs(temperature - settings.warm) <= Math.abs(temperature - settings.warmer) ? 1 : 2;
}

/** 0 off, else the step night light is on. */
function nightLevel() {
  const night = state?.nightLight;
  return night?.on ? nightStep(night.temperature) : 0;
}

function renderNightLight() {
  const button = $("deck-night");
  button.dataset.supported = String(Boolean(state.nightLight));
  // As with do not disturb: a stale state mustn't undo a tap.
  const level = nightTapped && Date.now() < nightTapped.until ? nightTapped.level : nightLevel();
  button.dataset.level = String(level);
  button.dataset.on = String(level > 0);
}

$("deck-night").addEventListener("click", () => {
  const level = (Number($("deck-night").dataset.level) + 1) % NIGHT_NAMES.length;
  const temperature = [null, settings.warm, settings.warmer][level];
  const sent = temperature ? send({ type: "night-light-set", temperature }) : send({ type: "night-light", on: false });
  if (!sent) return;
  nightTapped = { level, until: Date.now() + 2000 };
  renderNightLight();
  toast(/** @type {string} */ (NIGHT_NAMES[level]));
});

// Wi-Fi only says what it's on: turning it off would cut this very remote.
$("wifi").addEventListener("click", () => {
  const wifi = state?.radios.wifi;
  toast(!wifi?.on ? "wi-fi is off" : wifi.network ? `on ${wifi.network}` : "wi-fi is on, no network");
});
tapOrHold($("bluetooth"), {
  tap: () => send({ type: "bluetooth", on: !state?.radios.bluetooth?.on }),
  hold() {
    const bluetooth = state?.radios.bluetooth;
    const connected = bluetooth?.connected ?? [];
    toast(!bluetooth?.on ? "bluetooth is off" : connected.length ? `connected to ${connected.join(", ")}` : "nothing connected");
  },
});

// Power on the desk's dock: each is a hold, so a stray tap in a pocket can't
// lock or power off the laptop. The accent floods the dock from the held icon,
// and the action happens once it's full (after the hold time in settings);
// letting go early drains it.
const DECK = { width: 48, height: 400 }; // the dock's viewBox; its height fits the icons shown

/**
 * Shows the icons picked in settings (do not disturb and night light only
 * where the laptop has them), and sizes the dock to them: the same shoulders,
 * a longer or shorter body. 1 unit is 1px at 16px per rem, as in the CSS.
 */
function layoutDeck() {
  /** @type {HTMLElement[]} */
  const buttons = [...document.querySelectorAll("#power-deck [data-deck]")].map((button) => /** @type {HTMLElement} */ (button));
  for (const button of buttons) {
    button.hidden = button.dataset.supported === "false" || settings.deckOff.includes(/** @type {string} */ (button.dataset.deck));
  }
  const holds = buttons.filter((button) => !button.hidden && button.classList.contains("deck-hold")).length;
  const taps = buttons.filter((button) => !button.hidden && button.classList.contains("deck-tap")).length;
  $("deck-divider").hidden = !holds || !taps;
  $("power-deck").dataset.empty = String(!holds && !taps);
  // 40 per icon, 14 for the divider, 73 above and below them.
  const height = 146 + (holds + taps) * 40 + (holds && taps ? 14 : 0);
  if (height === DECK.height) return;
  DECK.height = height;
  $("power-deck").style.height = `${height / 16}rem`;
  $("deck-shape").setAttribute("viewBox", `0 0 ${DECK.width} ${height}`);
  const h = height;
  const d = `M49 0 L48 0 L8.6 53.7 Q1 64 1 76.8 L1 ${h - 76.8} Q1 ${h - 64} 8.6 ${h - 53.7} L48 ${h} L49 ${h} Z`;
  document.querySelectorAll(".deck-path").forEach((path) => path.setAttribute("d", d));
}
layoutDeck();
const flood = /** @type {SVGCircleElement} */ (/** @type {unknown} */ ($("deck-flood")));
/** @type {Animation | null} */
let flooding = null;
/** @type {Animation | null} */
let fading = null;

/** @param {HTMLElement} button */
function startFlood(button) {
  const deck = /** @type {Element} */ (flood.ownerSVGElement).getBoundingClientRect();
  const icon = button.getBoundingClientRect();
  const unit = DECK.width / deck.width;
  const across = (icon.left + icon.width / 2 - deck.left) * unit;
  // On the left edge the drawing is mirrored, so x runs the other way.
  const cx = settings.dockSide === "left" ? DECK.width - across : across;
  const cy = (icon.top + icon.height / 2 - deck.top) * unit;
  // Just big enough to reach the farthest corner: full exactly at the end.
  const corners = [
    [0, 0],
    [DECK.width, 0],
    [0, DECK.height],
    [DECK.width, DECK.height],
  ];
  const r = Math.max(...corners.map(([x, y]) => Math.hypot(/** @type {number} */ (x) - cx, /** @type {number} */ (y) - cy)));
  flood.setAttribute("cx", String(cx));
  flood.setAttribute("cy", String(cy));
  flood.setAttribute("r", String(r));
  flooding?.cancel();
  fading?.cancel();
  flooding = flood.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], {
    duration: settings.holdMs,
    easing: "cubic-bezier(0.4, 0, 0.8, 1)",
    fill: "forwards",
  });
  return flooding;
}

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-hold]")).forEach((button) => {
  /** @type {Animation | null} */
  let mine = null;
  const drain = () => {
    if (!mine || mine.playState !== "running") return;
    mine.updatePlaybackRate(-4);
  };
  button.addEventListener("pointerdown", () => {
    const animation = startFlood(button);
    mine = animation;
    animation.onfinish = () => {
      if (animation.playbackRate < 0) return animation.cancel();
      mine = null;
      vibrate([20, 40, 20]);
      send(JSON.parse(/** @type {string} */ (button.dataset.hold)));
      // Full for a moment, then fades back to black.
      fading = flood.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, delay: 350, easing: "ease-out" });
      fading.finished.then(
        () => animation.cancel(),
        () => {},
      );
    };
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) => button.addEventListener(type, drain));
  button.addEventListener("contextmenu", (event) => event.preventDefault());
});

/* -------------------------------------------------------------------------- */
/* Bridge: fetching from the laptop                                           */
/* -------------------------------------------------------------------------- */

/** @typedef {import("../src/features/clipboard").ClipView} ClipView */
/** @typedef {import("../src/features/files").FileView} FileView */
/** @typedef {import("../src/features/stats").TopApp} TopApp */

const clamp = (/** @type {number} */ value, /** @type {number} */ low, /** @type {number} */ high) =>
  Math.min(Math.max(value, low), high);

/**
 * Something paired-only (a clip, a file, a frame), with the token in a header
 * rather than the URL.
 * @param {string} path
 */
async function fetchPaired(path) {
  const response = await fetch(path, { headers: { "x-token": token ?? "" }, cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.blob();
}

/**
 * Thumbnails as object URLs, fetched once per path; the ones no longer shown
 * are let go.
 */
function thumbCache() {
  /** @type {Map<string, Promise<string>>} */
  const urls = new Map();
  return {
    /**
     * @param {string} path
     * @param {HTMLImageElement} img
     */
    show(path, img) {
      let url = urls.get(path);
      if (!url) {
        url = fetchPaired(path).then((blob) => URL.createObjectURL(blob));
        url.catch(() => urls.delete(path));
        urls.set(path, url);
      }
      url.then((src) => (img.src = src)).catch(() => {});
    },
    /** @param {string[]} paths */
    keep(paths) {
      for (const [path, url] of urls) {
        if (paths.includes(path)) continue;
        urls.delete(path);
        url.then((src) => URL.revokeObjectURL(src)).catch(() => {});
      }
    },
  };
}
const clipThumbs = thumbCache();
const fileThumbs = thumbCache();

/**
 * Saves a blob into the phone's downloads.
 * @param {Blob} blob
 * @param {string} name
 */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** @param {number} bytes */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} b`;
  const units = ["kb", "mb", "gb"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A row to tap: a line of text, with a thumbnail and a small label if given.
 * @param {{ text: string; label?: string; thumb?: { cache: ReturnType<typeof thumbCache>; path: string } }} content
 * @param {() => void} onTap
 */
function tapRow({ text, label, thumb }, onTap) {
  const row = document.createElement("button");
  row.className = "clip";
  if (thumb) {
    const img = document.createElement("img");
    img.alt = "";
    thumb.cache.show(thumb.path, img);
    row.append(img);
  } else {
    row.style.gridTemplateColumns = "minmax(0, 1fr)";
  }
  const lines = document.createElement("span");
  if (label) {
    const small = document.createElement("span");
    small.className = "app truncate";
    small.textContent = label;
    lines.append(small);
  }
  const line = document.createElement("span");
  line.className = "truncate";
  // textContent: the clipboard and file names are anyone's text.
  line.textContent = text;
  lines.append(line);
  row.append(lines);
  row.addEventListener("click", onTap);
  return row;
}

/* -------------------------------------------------------------------------- */
/* Bridge: clipboard                                                          */
/* -------------------------------------------------------------------------- */

let clipsKey = "";
const clipPath = (/** @type {ClipView} */ clip) => `/clip?k=${encodeURIComponent(clip.key)}`;

function renderClipboard() {
  const { current, history } = state.clipboard;
  const key = JSON.stringify([current, history]);
  if (key === clipsKey) return;
  clipsKey = key;

  /**
   * @param {ClipView} clip
   * @param {string} [label]
   */
  const clipRow = (clip, label) =>
    tapRow(
      {
        text: clip.kind === "image" ? `image · ${clip.preview}` : clip.preview,
        label,
        thumb: clip.kind === "image" ? { cache: clipThumbs, path: clipPath(clip) } : undefined,
      },
      () => copyToPhone(clip),
    );

  if (current) {
    const row = clipRow(current, "copied on the laptop");
    row.dataset.now = "true";
    $("clip-now").replaceChildren(row);
  } else {
    const empty = document.createElement("div");
    empty.className = "clip";
    empty.dataset.empty = "true";
    empty.textContent = "nothing copied on the laptop yet";
    $("clip-now").replaceChildren(empty);
  }
  $("clip-history-label").hidden = history.length === 0;
  $("clip-history").replaceChildren(...history.map((clip) => clipRow(clip)));
  clipThumbs.keep([...(current ? [current] : []), ...history].map(clipPath));
}

/**
 * A PNG of any image the browser can draw: phones only take PNGs as copied
 * images.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function asPng(blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("no png"))), "image/png"),
  );
}

/**
 * Copies a laptop clip onto the phone. The clipboard item is made inside the
 * tap, with its bytes still on the way: Safari only lets a write that starts
 * in the tap through.
 * @param {ClipView} clip
 */
async function copyToPhone(clip) {
  const image = clip.kind === "image";
  const blob = fetchPaired(clipPath(clip)).then((raw) =>
    image ? asPng(raw) : new Blob([raw], { type: "text/plain" }),
  );
  blob.catch(() => {});
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("no clipboard");
    await navigator.clipboard.write([new ClipboardItem({ [image ? "image/png" : "text/plain"]: blob })]);
    toast(image ? "image copied to your phone" : "copied to your phone");
    return;
  } catch {}
  // Plain HTTP, or an older browser.
  try {
    if (image) {
      saveBlob(await blob, "clipboard.png");
      toast("saved the image to your phone");
      return;
    }
    const text = await (await blob).text();
    try {
      await navigator.clipboard.writeText(text);
      toast("copied to your phone");
    } catch {
      clipboardBox.value = text;
      updateLinkButton();
      toast("it's in the box: long-press it to copy");
    }
  } catch {
    toast("couldn't get that from the laptop");
  }
}

const clipboardBox = /** @type {HTMLTextAreaElement} */ ($("clipboard"));

/** "https://…", or a bare "example.com/page". One word, no spaces. */
const isLink = (/** @type {string} */ text) =>
  /^(https?:\/\/\S+|[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?)$/i.test(text.trim());
const asUrl = (/** @type {string} */ text) => (/^https?:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`);

function updateLinkButton() {
  $("link-open").hidden = !isLink(clipboardBox.value);
}
clipboardBox.addEventListener("input", updateLinkButton);

/** @param {string} text */
function sendText(text) {
  if (!send({ type: "clipboard-set", text })) return toast("not connected to the laptop");
  if (isLink(text)) {
    toast("copied to laptop", { label: "open it there", run: () => send({ type: "open-link", url: asUrl(text) }) });
  } else {
    toast("copied to laptop");
  }
}

/** @param {Blob} blob */
async function sendImage(blob) {
  const response = await fetch("/clipboard", { method: "POST", headers: { "x-token": token ?? "" }, body: blob });
  toast(response.ok ? "image copied to laptop" : "the laptop didn't take that image");
}

/**
 * What the phone has copied: an image if there is one, else text. Browsers
 * ask the first time, and some only offer text.
 * @returns {Promise<string | Blob>}
 */
async function readPhoneClipboard() {
  if (navigator.clipboard?.read) {
    try {
      for (const item of await navigator.clipboard.read()) {
        const image = item.types.find((type) => type.startsWith("image/"));
        if (image) return item.getType(image);
        if (item.types.includes("text/plain")) return (await item.getType("text/plain")).text();
      }
    } catch {}
  }
  return navigator.clipboard.readText();
}

// Typed text wins; with the box empty, what the phone copied goes.
$("clipboard-send").addEventListener("click", async () => {
  const typed = clipboardBox.value;
  if (typed) {
    sendText(typed);
    clipboardBox.value = "";
    updateLinkButton();
    return;
  }
  try {
    const copied = await readPhoneClipboard();
    if (typeof copied !== "string") return await sendImage(copied);
    if (!copied) return toast("your phone's clipboard is empty");
    sendText(copied);
  } catch {
    toast("your phone kept its clipboard: paste into the box, then send");
    clipboardBox.focus();
  }
});

$("link-open").addEventListener("click", () => {
  send({ type: "open-link", url: asUrl(clipboardBox.value) });
  clipboardBox.value = "";
  updateLinkButton();
});

/* -------------------------------------------------------------------------- */
/* Bridge: files                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One file per request, as the raw body, so the laptop can stream it straight
 * to disk. XHR rather than fetch: it reports upload progress. Resolves to the
 * saved name, or null.
 * @param {File} file
 * @param {(loaded: number) => void} onProgress
 * @returns {Promise<string | null>}
 */
function uploadFile(file, onProgress) {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onloadend = () => resolve(request.status === 200 ? JSON.parse(request.responseText).saved : null);
    request.open("POST", "/upload");
    request.setRequestHeader("x-token", token ?? "");
    // Header values must be plain ASCII; the laptop decodes it.
    request.setRequestHeader("x-filename", encodeURIComponent(file.name));
    request.send(file);
  });
}

/**
 * Sends files to the laptop's folder for them, then opens them there (unless
 * the laptop's settings say not to): one file in its app, several as their folder.
 * @param {File[]} files
 */
async function uploadAndOpen(files) {
  const bar = $("upload-progress");
  const fill = /** @type {HTMLElement} */ (bar.firstElementChild);
  bar.style.display = "block";
  const total = files.reduce((sum, file) => sum + file.size, 0) || 1;
  let done = 0;
  /** @type {string[]} */
  const saved = [];
  for (const file of files) {
    const name = await uploadFile(file, (loaded) => {
      fill.style.width = `${((done + loaded) / total) * 100}%`;
    });
    if (name) saved.push(name);
    done += file.size;
  }
  bar.style.display = "none";
  fill.style.width = "0";
  await opened;
  if (!saved.length) return toast("sending failed");
  const folder = state?.preferences.receiveTo ?? "downloads";
  if (state && !state.preferences.openReceived) {
    toast(saved.length === 1 ? `saved ${saved[0]} to ${folder}` : `saved ${saved.length} files to ${folder}`);
    return;
  }
  if (saved.length === 1) send({ type: "open-received", name: /** @type {string} */ (saved[0]) });
  else send({ type: "open-downloads" });
  if (saved.length < files.length) toast(`sent ${saved.length} of ${files.length} files`);
  else toast(saved.length === 1 ? `opened ${saved[0]} on the laptop` : `sent ${saved.length} files, opened ${folder}`);
}

$("file-pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async () => {
  const input = /** @type {HTMLInputElement} */ ($("file"));
  const files = [.../** @type {FileList} */ (input.files)];
  input.value = "";
  if (files.length) await uploadAndOpen(files);
});

let filesKey = "";
const filePath = (/** @type {FileView} */ file) => `/file?k=${encodeURIComponent(file.key)}`;

function renderFiles() {
  const { screenshot } = state.files;
  const downloads = state.files.downloads.slice(0, settings.downloadsShown);
  // Ages are part of the key, so "2m" becomes "3m".
  const key = JSON.stringify([screenshot?.key, downloads.map((file) => file.key), [screenshot, ...downloads].map((file) => file && timeAgo(file.time))]);
  if (key === filesKey) return;
  filesKey = key;

  $("take").hidden = !screenshot && downloads.length === 0;
  $("shot").hidden = !screenshot;
  if (screenshot) {
    $("shot-name").textContent = `${timeAgo(screenshot.time)} · ${screenshot.name}`;
    fileThumbs.show(filePath(screenshot), /** @type {HTMLImageElement} */ ($("shot").querySelector("img")));
  }
  $("downloads").replaceChildren(
    ...downloads.map((file) =>
      tapRow(
        {
          text: file.name,
          label: `${formatSize(file.size)} · ${timeAgo(file.time)}`,
          thumb: file.image ? { cache: fileThumbs, path: filePath(file) } : undefined,
        },
        () => takeFile(file),
      ),
    ),
  );
  fileThumbs.keep([...(screenshot ? [screenshot] : []), ...downloads.filter((file) => file.image)].map(filePath));
}

/** @param {FileView} file */
async function takeFile(file) {
  toast(`getting ${file.name}…`);
  try {
    saveBlob(await fetchPaired(filePath(file)), file.name);
    toast(`saved ${file.name} to your phone`);
  } catch {
    toast("couldn't get that file");
  }
}

$("shot").addEventListener("click", () => state.files.screenshot && takeFile(state.files.screenshot));

/* -------------------------------------------------------------------------- */
/* Bridge: screen                                                             */
/* -------------------------------------------------------------------------- */

// The monitor picked on the phone; until then, the one you're working on.
/** @type {string | null} */
let pickedMonitor = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let previewTimer = undefined;
let framePending = false;
let viewerOpen = false;
// Frames are shown through object URLs; the previous one is revoked so they
// don't pile up.
/** @type {string | null} */
let previewUrl = null;

function previewMonitor() {
  const monitors = state?.monitors ?? [];
  if (pickedMonitor && monitors.some((monitor) => monitor.name === pickedMonitor)) return pickedMonitor;
  return monitors.find((monitor) => monitor.focused)?.name ?? monitors[0]?.name ?? null;
}

/** @param {string} url */
function showFrame(url) {
  const old = previewUrl;
  previewUrl = url;
  /** @type {HTMLImageElement} */ ($("screen")).src = url;
  /** @type {HTMLImageElement} */ ($("viewer-img")).src = url;
  /** @type {HTMLImageElement} */ ($("present-screen")).src = url;
  $("screen").hidden = false;
  $("screen-empty").hidden = true;
  if (old) URL.revokeObjectURL(old);
}

function renderScreen() {
  const monitors = $("monitors");
  const key = state.monitors.map((monitor) => `${monitor.name}:${monitor.label}`).join();
  if (monitors.dataset.rendered !== key) {
    monitors.dataset.rendered = key;
    monitors.replaceChildren(
      ...state.monitors.map((monitor) => {
        const button = document.createElement("button");
        button.textContent = monitor.label;
        button.dataset.name = monitor.name;
        button.addEventListener("click", () => {
          pickedMonitor = monitor.name;
          renderMonitorPills();
          clearTimeout(previewTimer);
          updateScreenPolling();
        });
        return button;
      }),
    );
  }
  // One screen needs no choosing.
  monitors.hidden = state.monitors.length < 2;
  renderMonitorPills();
  if (previewTimer === undefined && !framePending) updateScreenPolling();
}

function renderMonitorPills() {
  const current = previewMonitor();
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#monitors button")).forEach((button) => {
    button.dataset.active = String(button.dataset.name === current);
  });
}

/**
 * Frames are fetched only while someone can see them (the bridge tab, or the
 * full-size view), each one after the last arrived: about one a second.
 */
function updateScreenPolling() {
  clearTimeout(previewTimer);
  previewTimer = undefined;
  const name = state ? previewMonitor() : null;
  const visible =
    document.visibilityState === "visible" &&
    (viewerOpen || presenterOpen || $("tab-bridge").dataset.active === "true");
  if (!name || !visible) {
    $("screen-status").textContent = "paused";
    return;
  }
  $("screen-status").textContent = "live";
  if (framePending) return;
  framePending = true;
  let delay = 3000;
  const quality = viewerOpen || settings.previewQuality === "sharp" ? "sharp" : "preview";
  fetchPaired(`/screen?m=${encodeURIComponent(name)}&q=${quality}`)
    .then(
      (blob) =>
        new Promise((resolve) => {
          // Decoded off-screen first, so the preview never flashes blank.
          const url = URL.createObjectURL(blob);
          const image = new Image();
          image.onload = () => {
            showFrame(url);
            delay = viewerOpen ? 1000 : settings.previewEvery * 1000;
            resolve(undefined);
          };
          image.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(undefined);
          };
          image.src = url;
        }),
    )
    .catch(() => {})
    .finally(() => {
      framePending = false;
      previewTimer = setTimeout(updateScreenPolling, delay);
    });
}
document.addEventListener("visibilitychange", updateScreenPolling);

async function saveScreen() {
  const name = previewMonitor();
  if (!name) return;
  const label = state.monitors.find((monitor) => monitor.name === name)?.label ?? name;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  toast("taking the screen…");
  try {
    saveBlob(await fetchPaired(`/screen?m=${encodeURIComponent(name)}&q=full`), `screen-${label.replace(/\W+/g, "-")}-${stamp}.png`);
    toast("saved to your phone");
  } catch {
    toast("couldn't take the screen");
  }
}
$("screen-save").addEventListener("click", saveScreen);
$("viewer-save").addEventListener("click", saveScreen);

/* The full-size view: pinch to zoom, drag to pan, tap to click there. */

const viewer = $("viewer");
const viewerImg = /** @type {HTMLImageElement} */ ($("viewer-img"));
const stage = $("viewer-stage");
let view = { scale: 1, x: 0, y: 0 };

function applyView() {
  viewerImg.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

/** Keeps a zoomed picture covering the view: no panning off into black. */
function clampView() {
  const maxX = ((view.scale - 1) * viewerImg.offsetWidth) / 2;
  const maxY = ((view.scale - 1) * viewerImg.offsetHeight) / 2;
  view.x = clamp(view.x, -maxX, maxX);
  view.y = clamp(view.y, -maxY, maxY);
}

function openViewer() {
  if (!previewMonitor()) return;
  viewerOpen = true;
  viewer.hidden = false;
  view = { scale: 1, x: 0, y: 0 };
  applyView();
  $("viewer-hint").textContent = state.input.clicks
    ? "tap to click · pinch to zoom"
    : "pinch to zoom · clicks need ydotool";
  // Back closes it, as it would any full-screen view.
  history.pushState({ viewer: true }, "");
  /** @type {any} */
  const orientation = window.screen.orientation;
  document.documentElement
    .requestFullscreen?.()
    .then(() => orientation?.lock?.("landscape"))
    .catch(() => {});
  clearTimeout(previewTimer);
  updateScreenPolling();
}

function closeViewer(fromHistory = false) {
  if (!viewerOpen) return;
  viewerOpen = false;
  viewer.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!fromHistory && history.state?.viewer) history.back();
  updateScreenPolling();
}

$("screen-open").addEventListener("click", openViewer);
$("viewer-close").addEventListener("click", () => closeViewer());
window.addEventListener("popstate", () => closeViewer(true));

/** @type {Map<number, { x: number; y: number }>} */
const fingers = new Map();
/** @type {{ at: number; x: number; y: number; moved: boolean; multi: boolean } | null} */
let press = null;
/** @type {{ distance: number; scale: number; midX: number; midY: number; x: number; y: number } | null} */
let pinch = null;

function startPinch() {
  const [a, b] = [...fingers.values()];
  if (!a || !b) return;
  pinch = {
    distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    scale: view.scale,
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    x: view.x,
    y: view.y,
  };
}

stage.addEventListener("pointerdown", (event) => {
  stage.setPointerCapture(event.pointerId);
  fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (fingers.size === 1) press = { at: Date.now(), x: event.clientX, y: event.clientY, moved: false, multi: false };
  else {
    if (press) press.multi = true;
    startPinch();
  }
});

stage.addEventListener("pointermove", (event) => {
  const last = fingers.get(event.pointerId);
  if (!last) return;
  const point = { x: event.clientX, y: event.clientY };
  fingers.set(event.pointerId, point);
  if (press && Math.hypot(point.x - press.x, point.y - press.y) > 8) press.moved = true;

  if (fingers.size >= 2 && pinch) {
    const [a, b] = /** @type {[{ x: number; y: number }, { x: number; y: number }]} */ ([...fingers.values()]);
    const scale = clamp((pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance, 1, 6);
    // The spot under the fingers stays under them as the picture grows.
    const rect = stage.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const ratio = scale / pinch.scale;
    view.scale = scale;
    view.x = (a.x + b.x) / 2 - center.x - (pinch.midX - center.x - pinch.x) * ratio;
    view.y = (a.y + b.y) / 2 - center.y - (pinch.midY - center.y - pinch.y) * ratio;
  } else if (fingers.size === 1 && view.scale > 1 && press?.moved) {
    view.x += point.x - last.x;
    view.y += point.y - last.y;
  } else {
    return;
  }
  clampView();
  applyView();
});

/** @param {PointerEvent} event */
function endFinger(event) {
  fingers.delete(event.pointerId);
  if (fingers.size < 2) pinch = null;
  if (fingers.size > 0 || !press) return;
  const tap = event.type === "pointerup" && !press.moved && !press.multi && Date.now() - press.at < 350;
  press = null;
  if (view.scale < 1.05) {
    view = { scale: 1, x: 0, y: 0 };
    applyView();
  }
  if (tap) clickAt(event.clientX, event.clientY);
}
stage.addEventListener("pointerup", endFinger);
stage.addEventListener("pointercancel", endFinger);

/**
 * Clicks on the laptop where the picture was tapped, as a fraction across
 * and down it; the laptop works out where that is.
 * @param {number} x
 * @param {number} y
 */
function clickAt(x, y) {
  const rect = viewerImg.getBoundingClientRect();
  const across = (x - rect.left) / rect.width;
  const down = (y - rect.top) / rect.height;
  const name = previewMonitor();
  if (!name || across < 0 || across > 1 || down < 0 || down > 1) return;
  send({ type: "screen-click", monitor: name, x: across, y: down });
  const dot = document.createElement("span");
  dot.className = "tap-dot";
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  document.body.append(dot);
  setTimeout(() => dot.remove(), 500);
  // Show what the click did now, not on the next frame.
  setTimeout(() => {
    if (!framePending) updateScreenPolling();
  }, 300);
}

/* -------------------------------------------------------------------------- */
/* Stats: the strip above the tab bar, and its panel                          */
/* -------------------------------------------------------------------------- */

/** @typedef {"cpu" | "memory" | "battery" | "temperature" | "disk"} StatName */

/** Megabytes as gigabytes: "6.1", or "120" once there's no room for a decimal. */
const gb = (/** @type {number} */ mb) => (mb / 1024).toFixed(mb >= 100 * 1024 ? 0 : 1);

/**
 * @param {StatName} name
 * @param {string} text
 * @param {boolean} alert
 */
function setStrip(name, text, alert) {
  const value = $(`strip-${name}`);
  value.textContent = text;
  /** @type {HTMLElement} */ (value.parentElement).dataset.alert = String(alert);
}

function renderStrip() {
  const { cpu, memory, battery, temperature, disk } = state.stats;
  setStrip("cpu", cpu == null ? "--" : `${cpu}%`, (cpu ?? 0) > 85);
  setStrip("memory", memory ? `${gb(memory.used)}g` : "--", memory ? memory.used / memory.total > 0.9 : false);
  // A desktop has no battery to show.
  $("strip-battery-button").hidden = !battery;
  if (battery) {
    $("strip-battery-label").textContent = battery.charging ? "chg" : "bat";
    setStrip("battery", `${battery.level}%`, battery.level <= 15 && !battery.charging);
  }
  setStrip("temperature", temperature == null ? "--" : `${temperature}°`, (temperature ?? 0) >= 85);
  setStrip("disk", disk ? `${gb(disk.free)}g` : "--", disk ? disk.free / disk.total < 0.05 : false);
  renderSheet();
}

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#stats-strip button")).forEach((button) =>
  button.addEventListener("click", () =>
    openSheet({ kind: "stat", stat: /** @type {StatName} */ (button.dataset.stat) }),
  ),
);

/** @type {{ kind: "stat"; stat: StatName } | { kind: "install" } | null} */
let sheet = null;
let sheetKey = "";
/** @type {{ cpu: TopApp[]; memory: TopApp[] } | null} */
let topApps = null;
/** @type {ReturnType<typeof setInterval> | undefined} */
let topTimer;
// The app held to quit, waiting for its confirming tap.
/** @type {string | null} */
let armedApp = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let disarmApp;
// Rows aren't rebuilt under a finger, or a hold would lose its button.
let touchingTop = false;

/** @param {NonNullable<typeof sheet>} next */
function openSheet(next) {
  document.querySelectorAll(".sheet").forEach((panel) => ((/** @type {HTMLElement} */ (panel)).hidden = true));
  sheet = next;
  sheetKey = "";
  topApps = null;
  armedApp = null;
  $("sheet").hidden = false;
  $("sheet-backdrop").hidden = false;
  clearInterval(topTimer);
  if (next.kind === "stat" && (next.stat === "cpu" || next.stat === "memory")) {
    send({ type: "top-apps" }, { buzz: false });
    topTimer = setInterval(() => send({ type: "top-apps" }, { buzz: false }), 3000);
  }
  renderSheet();
}

function closeSheet() {
  sheet = null;
  clearInterval(topTimer);
  document.querySelectorAll(".sheet").forEach((panel) => ((/** @type {HTMLElement} */ (panel)).hidden = true));
  $("sheet-backdrop").hidden = true;
}
// A sheet opened by a hold appears under the finger that's still down; the
// lift that follows mustn't count as a tap outside it.
let sheetOpened = 0;
new MutationObserver(() => {
  if (!$("sheet-backdrop").hidden) sheetOpened = Date.now();
}).observe($("sheet-backdrop"), { attributes: true, attributeFilter: ["hidden"] });
$("sheet-backdrop").addEventListener("click", () => {
  if (Date.now() - sheetOpened > 400) closeSheet();
});

/**
 * One of the sheets written into index.html, rather than drawn into #sheet;
 * tapping what opened it again closes it.
 * @param {string} id
 */
function toggleSheet(id) {
  if (!$(id).hidden) return closeSheet();
  closeSheet();
  $(id).hidden = false;
  $("sheet-backdrop").hidden = false;
}

// The full player: art, seeking, ±10 seconds and volume.
$("player-open").addEventListener("click", () => {
  toggleSheet("media-sheet");
  tickMedia();
});

$("bell").addEventListener("click", () => toggleSheet("notes-sheet"));

/**
 * A stat's figure, the words after it, and the range its graph spans.
 * @param {StatName} stat
 * @param {State["stats"]} stats
 * @returns {{ title: string; value: string; unit: string; range: [number, number] }}
 */
function statView(stat, stats) {
  const { cpu, memory, battery, temperature, disk } = stats;
  switch (stat) {
    case "cpu":
      return { title: "cpu", value: cpu == null ? "--" : String(cpu), unit: "%", range: [0, 100] };
    case "memory":
      return memory
        ? { title: "memory", value: gb(memory.used), unit: `of ${gb(memory.total)} gb`, range: [0, memory.total] }
        : { title: "memory", value: "--", unit: "", range: [0, 1] };
    case "battery":
      return {
        title: "battery",
        value: battery ? String(battery.level) : "--",
        unit: battery?.charging ? "% · charging" : "%",
        range: [0, 100],
      };
    case "temperature":
      return { title: "temperature", value: temperature == null ? "--" : String(temperature), unit: "°c", range: [30, 100] };
    case "disk":
      return disk
        ? { title: "disk", value: gb(disk.free), unit: `gb free of ${gb(disk.total)}`, range: [0, disk.total] }
        : { title: "disk", value: "--", unit: "", range: [0, 1] };
  }
}

/**
 * An SVG path through the last ten minutes, right-aligned so "now" is always
 * at the right edge. Gaps (no reading) break the line.
 * @param {(number | null)[]} values
 * @param {[number, number]} range
 */
function sparkPath(values, [low, high]) {
  const step = 100 / 59;
  let path = "";
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    const x = 100 - (values.length - 1 - index) * step;
    const y = 39 - (clamp((value - low) / (high - low || 1), 0, 1) * 38);
    path += `${drawing ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    drawing = true;
  });
  return path;
}

function renderSheet() {
  if (!sheet) return;
  if (sheet.kind === "install") {
    renderInstallSheet().catch(() => {});
    return;
  }
  if (!state || touchingTop) return;
  const { stat } = sheet;
  const stats = state.stats;
  const shown = statView(stat, stats);
  const apps = stat === "cpu" ? topApps?.cpu : stat === "memory" ? topApps?.memory : undefined;
  const key = JSON.stringify([stat, shown, stats.history[stat], stats.uptimeMinutes, apps, armedApp]);
  if (key === sheetKey) return;
  sheetKey = key;

  const box = $("sheet");
  box.innerHTML = `
    <div class="row"><p class="label"></p><p class="label"></p></div>
    <p class="dot sheet-value"><span></span><small></small></p>
    <svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path /></svg>
    <p class="hint"></p>`;
  const [title, uptime] = /** @type {HTMLElement[]} */ ([...box.querySelectorAll(".row .label")]);
  /** @type {HTMLElement} */ (title).textContent = shown.title;
  if (stats.uptimeMinutes != null) {
    const hours = Math.floor(stats.uptimeMinutes / 60);
    /** @type {HTMLElement} */ (uptime).textContent = `up ${hours ? `${hours}h ` : ""}${stats.uptimeMinutes % 60}m`;
  }
  /** @type {HTMLElement} */ (box.querySelector(".sheet-value span")).textContent = shown.value;
  /** @type {HTMLElement} */ (box.querySelector(".sheet-value small")).textContent = shown.unit;
  const history = stats.history[stat];
  /** @type {SVGPathElement} */ (box.querySelector(".spark path")).setAttribute("d", sparkPath(history, shown.range));
  /** @type {HTMLElement} */ (box.querySelector(".hint")).textContent =
    history.filter((value) => value !== null).length < 2 ? "collecting the last 10 minutes…" : "the last 10 minutes";

  if (apps === undefined) return;
  const label = document.createElement("p");
  label.className = "label";
  label.style.marginTop = "1.1rem";
  label.textContent = apps.length ? `${stat === "cpu" ? "busiest" : "largest"} apps · hold one to quit it` : "looking…";
  const list = document.createElement("div");
  list.className = "top-apps";
  list.addEventListener("pointerdown", () => (touchingTop = true));
  list.replaceChildren(
    ...apps.map((app) => {
      const button = document.createElement("button");
      const name = document.createElement("span");
      const value = document.createElement("span");
      const armed = armedApp === app.name;
      button.dataset.armed = String(armed);
      name.textContent = armed ? `tap to quit ${app.name}` : app.name;
      value.textContent =
        stat === "cpu" ? `${app.value}%` : app.value >= 1024 ? `${gb(app.value)} gb` : `${app.value} mb`;
      button.append(name, value);
      tapOrHold(button, {
        tap() {
          if (armedApp !== app.name) return toast("hold to quit it");
          clearTimeout(disarmApp);
          armedApp = null;
          send({ type: "quit-app", name: app.name });
          renderSheet();
        },
        hold() {
          armedApp = app.name;
          clearTimeout(disarmApp);
          disarmApp = setTimeout(() => {
            armedApp = null;
            renderSheet();
          }, 3000);
          touchingTop = false;
          renderSheet();
        },
      });
      return button;
    }),
  );
  box.append(label, list);
}
["pointerup", "pointercancel"].forEach((type) =>
  document.addEventListener(type, () => {
    if (!touchingTop) return;
    touchingTop = false;
    // Let the tap's click land on the row before it's rebuilt.
    setTimeout(renderSheet, 0);
  }),
);

/* -------------------------------------------------------------------------- */
/* Install (HTTPS + certificate)                                              */
/* -------------------------------------------------------------------------- */

// The worker only registers once the phone trusts the laptop's certificate
// (clicking through the warning isn't enough), and without it the browser
// won't offer to install.
const workerReady =
  "serviceWorker" in navigator && window.isSecureContext
    ? navigator.serviceWorker.register("/sw.js").then(() => true, () => false)
    : Promise.resolve(false);

const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches || /** @type {any} */ (navigator).standalone === true;

/** Chrome's own install prompt, kept for the "install now" button. */
/** @type {any} */
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  renderSheet();
});

// Installing lives in settings (general, laptop).
function renderInstallPill() {
  const done = installed();
  $("install-row").hidden = done;
  if (done && sheet?.kind === "install") closeSheet();
}
renderInstallPill();
window.addEventListener("appinstalled", renderInstallPill);

async function openSecure() {
  const { httpsPort, address } = await (config ?? fetch("/config.json").then((r) => r.json()));
  location.href = `https://${address}:${httpsPort}/?t=${encodeURIComponent(token ?? "")}`;
}

/**
 * The steps for this phone alone, each ticked off as it's done: the page can
 * tell when it's on HTTPS and when the certificate is trusted.
 */
async function renderInstallSheet() {
  const trusted = await workerReady;
  const secure = location.protocol === "https:";
  const iphone =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const key = JSON.stringify(["install", trusted, secure, iphone, Boolean(installPrompt)]);
  if (sheet?.kind !== "install" || key === sheetKey) return;
  sheetKey = key;

  /** @type {{ text: string; done: boolean; button?: { label: string; primary?: boolean; run?: () => void; href?: string } }[]} */
  const steps = [];
  if (!secure) {
    steps.push({ text: "open the secure address of this remote.", done: false, button: { label: "open secure version", primary: true, run: () => void openSecure() } });
  }
  steps.push({
    text: iphone ? "download the laptop's certificate, and allow the profile." : "download the laptop's certificate.",
    done: trusted,
    button: trusted ? undefined : { label: "download certificate", href: "/ca.crt" },
  });
  if (iphone) {
    steps.push({ text: "settings → general → vpn & device management → install the hypr-remote profile.", done: trusted });
    steps.push({ text: "settings → general → about → certificate trust settings → turn on hypr-remote.", done: trusted });
  } else {
    steps.push({
      text: "settings → security → encryption & credentials → install a certificate → ca certificate, and pick the file. (or search settings for “ca certificate”.)",
      done: trusted,
    });
  }
  steps.push({
    text: "come back here and reload.",
    done: trusted,
    button: trusted || !secure ? undefined : { label: "reload", run: () => location.reload() },
  });
  steps.push({
    text: iphone ? "tap share → add to home screen." : "open the browser menu → install app, or add to home screen.",
    done: false,
    button: installPrompt
      ? {
          label: "install now",
          primary: true,
          run: () =>
            installPrompt
              .prompt()
              .then(() => installPrompt.userChoice)
              .then(renderInstallPill)
              .catch(() => {}),
        }
      : undefined,
  });

  const box = $("sheet");
  box.innerHTML = `
    <div class="row"><p class="label">install the remote</p><p class="label">once · about 2 minutes</p></div>
    <p class="hint">it goes on your home screen, opens full screen, and lets you share links and files to the laptop from any app.</p>
    <ol class="steps"></ol>`;
  const list = /** @type {HTMLElement} */ (box.querySelector(".steps"));
  for (const step of steps) {
    const item = document.createElement("li");
    item.dataset.done = String(step.done);
    const body = document.createElement("div");
    body.textContent = step.text;
    const action = step.button;
    if (action && !step.done) {
      const button = document.createElement("button");
      button.textContent = action.label;
      if (action.primary) button.className = "primary";
      if (action.href) {
        const link = document.createElement("a");
        link.href = action.href;
        link.append(button);
        body.append(link);
      } else {
        button.addEventListener("click", () => action.run?.());
        body.append(button);
      }
    }
    item.append(body);
    list.append(item);
  }
}

/* -------------------------------------------------------------------------- */
/* Sharing from other apps (Android)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The share sheet posts to /share; the service worker (sw.js) parks what was
 * shared and reopens the page with ?shared. A link opens on the laptop, text
 * goes on its clipboard, and files go to ~/Downloads and open there.
 */
async function takeShared() {
  const flag = params.get("shared");
  if (!flag) return;
  history.replaceState(null, "", location.pathname);
  if (flag === "missed") return toast("open the installed remote once, then share again");

  const cache = await caches.open("hypr-remote-share");
  const response = await cache.match("/shared");
  if (!response) return;
  await cache.delete("/shared");
  const data = await response.formData();

  const files = /** @type {File[]} */ (data.getAll("files").filter((file) => file instanceof File && file.name));
  if (files.length) return uploadAndOpen(files);

  const texts = ["url", "text", "title"]
    .map((field) => data.get(field))
    .filter((value) => typeof value === "string" && value.trim() !== "");
  const link = texts.map((text) => String(text).match(/https?:\/\/\S+/)?.[0]).find(Boolean);
  await opened;
  if (link) send({ type: "open-link", url: link });
  else if (texts[0]) sendText(String(texts[0]));
}
takeShared().catch(() => toast("couldn't take what was shared"));

/* -------------------------------------------------------------------------- */
/* Input: touchpad and keyboard                                               */
/* -------------------------------------------------------------------------- */

const pad = $("pad");
/** @type {Map<number, { x: number; y: number }>} */
const touches = new Map();
let move = { dx: 0, dy: 0 };
/** @type {number | null} */
let moveFrame = null;

/**
 * Moves are batched to one message per animation frame.
 * @param {number} dx
 * @param {number} dy
 */
function queueMove(dx, dy) {
  move.dx += dx;
  move.dy += dy;
  if (moveFrame) return;
  moveFrame = requestAnimationFrame(() => {
    moveFrame = null;
    if (move.dx || move.dy) send({ type: "pointer-move", dx: move.dx, dy: move.dy }, { buzz: false });
    move = { dx: 0, dy: 0 };
  });
}

// Pointer acceleration: slow drags are precise, fast flicks cross the desk.
// Pointer speed from settings scales the lot; with acceleration off, a
// finger's move is always the same distance on the laptop.
const accelerate = (/** @type {number} */ delta) =>
  delta * (settings.acceleration ? 1.4 + Math.min(Math.abs(delta) * 0.12, 2.6) : 2.2) * (settings.speed / 100);

/**
 * One touch on the pad, from the first finger down to the last one up.
 * `kind` is what two fingers turned out to be doing; `dragging` is a
 * tap-and-drag holding the button down.
 * @typedef {{
 *   fingers: number;
 *   startTime: number;
 *   moved: number;
 *   carry: { x: number; y: number };
 *   kind: "scroll" | "pinch" | null;
 *   spread: { start: number; last: number; carry: number } | null;
 *   swipe: { x: number; y: number };
 *   dragReady: boolean;
 *   dragging: boolean;
 * }} Gesture
 */
/** @type {Gesture | null} */
let gesture = null;
// When the last one-finger tap ended: a touch soon after can drag.
let lastTap = 0;
const SCROLL_STEP = 28;
const ZOOM_STEP = 40;

const clicksOn = () => Boolean(state?.input.clicks);

function spread() {
  const [a, b] = [...touches.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

pad.addEventListener("pointerdown", (event) => {
  pad.setPointerCapture(event.pointerId);
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  gesture ??= {
    fingers: 0,
    startTime: Date.now(),
    moved: 0,
    carry: { x: 0, y: 0 },
    kind: null,
    spread: null,
    swipe: { x: 0, y: 0 },
    // A second touch right after a tap, as on a laptop's trackpad.
    dragReady: Date.now() - lastTap < 300,
    dragging: false,
  };
  gesture.fingers = Math.max(gesture.fingers, touches.size);
  if (touches.size === 2) {
    const distance = spread();
    gesture.spread = { start: distance, last: distance, carry: 0 };
  }
});

pad.addEventListener("pointermove", (event) => {
  const last = touches.get(event.pointerId);
  if (!last || !gesture) return;
  const dx = event.clientX - last.x;
  const dy = event.clientY - last.y;
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  gesture.moved += Math.abs(dx) + Math.abs(dy);
  const first = event.pointerId === [...touches.keys()][0];

  // Three fingers: a swipe between workspaces, judged when they lift.
  if (gesture.fingers >= 3) {
    if (first) {
      gesture.swipe.x += dx;
      gesture.swipe.y += dy;
    }
    return;
  }

  if (touches.size === 2 && gesture.spread) {
    const distance = spread();
    // Fingers moving apart or together pinch; moving together, they scroll.
    if (!gesture.kind) {
      if (Math.abs(distance - gesture.spread.start) > 24) gesture.kind = "pinch";
      else if (gesture.moved > 24) gesture.kind = "scroll";
    }
    if (gesture.kind === "pinch") {
      gesture.spread.carry += distance - gesture.spread.last;
      gesture.spread.last = distance;
      const steps = Math.trunc(gesture.spread.carry / ZOOM_STEP);
      if (steps) {
        gesture.spread.carry -= steps * ZOOM_STEP;
        if (clicksOn()) send({ type: "pointer-zoom", steps: clamp(steps, -10, 10) }, { buzz: false });
      }
      return;
    }
    // Only the first finger's movement counts, or both would scroll.
    if (gesture.kind !== "scroll" || !first) return;
    gesture.carry.x += dx;
    gesture.carry.y += dy;
    // Faster scrolling takes less finger per step.
    const step = (SCROLL_STEP * 100) / settings.scrollSpeed;
    const down = Math.trunc(gesture.carry.y / step);
    const across = Math.trunc(gesture.carry.x / step);
    if (down || across) {
      gesture.carry.y -= down * step;
      gesture.carry.x -= across * step;
      // Natural: the page follows the fingers, as on a phone.
      const way = settings.naturalScroll ? -1 : 1;
      if (clicksOn()) {
        send({ type: "pointer-scroll", dy: clamp(way * down, -20, 20), dx: clamp(way * across, -20, 20) }, { buzz: false });
      }
    }
    return;
  }

  // A finger left over after two or three moves nothing.
  if (gesture.fingers > 1) return;
  // Pressed before the first move goes out, so the drag starts where the
  // pointer was.
  if (gesture.dragReady && !gesture.dragging && clicksOn()) {
    gesture.dragging = true;
    vibrate(12);
    send({ type: "pointer-button", state: "down" }, { buzz: false });
  }
  queueMove(accelerate(dx), accelerate(dy));
});

/** @param {PointerEvent} event */
function endTouch(event) {
  touches.delete(event.pointerId);
  if (touches.size > 0 || !gesture) return;
  const ended = gesture;
  gesture = null;

  if (ended.dragging) {
    // After the last move has gone out.
    requestAnimationFrame(() => requestAnimationFrame(() => send({ type: "pointer-button", state: "up" }, { buzz: false })));
    return;
  }
  if (ended.fingers >= 3) {
    const { x, y } = ended.swipe;
    // Swiping left brings the next workspace in, as Hyprland's own gesture does.
    if (Math.abs(x) > 60 && Math.abs(x) > Math.abs(y)) stepWorkspace(x < 0 ? 1 : -1);
    return;
  }
  // A short touch that barely moved is a tap: one finger clicks, two
  // right-click.
  const tap = Date.now() - ended.startTime < 250 && ended.moved < 12;
  if (!tap) return;
  if (ended.fingers === 1) lastTap = Date.now();
  if (clicksOn() && settings.tapToClick) send({ type: "pointer-click", button: ended.fingers >= 2 ? "right" : "left" });
}
pad.addEventListener("pointerup", endTouch);
pad.addEventListener("pointercancel", endTouch);

// Live typing: the field stays empty and each edit is forwarded as it
// happens. beforeinput tells us what the phone keyboard meant (text,
// backspace, enter) even when autocorrect rewrites words.
const typing = /** @type {HTMLInputElement} */ ($("typing"));

// What went to the laptop lately, shown faded so typos can be spotted: the
// last 40 characters, cleared by enter or after ten quiet seconds.
let echo = "";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let echoTimer;
/** @param {(text: string) => string} change */
function updateEcho(change) {
  echo = change(echo).slice(-40);
  $("echo-text").textContent = echo;
  $("dock").dataset.echo = String(echo !== "");
  // Beside the echo there's only room for the caret.
  typing.placeholder = echo ? "" : "type here — it goes to the laptop";
  clearTimeout(echoTimer);
  echoTimer = setTimeout(() => updateEcho(() => ""), 10_000);
}

/** @param {string} text */
function typeOut(text) {
  send({ type: "type", text }, { buzz: false });
  updateEcho((shown) => shown + text);
}

typing.addEventListener("beforeinput", (event) => {
  event.preventDefault();
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText":
    case "insertFromPaste":
      if (event.data) typeOut(event.data);
      break;
    case "insertLineBreak":
    case "insertParagraph":
      send({ type: "key", key: "enter" }, { buzz: false });
      updateEcho(() => "");
      break;
    case "deleteContentBackward":
    case "deleteWordBackward":
      send({ type: "key", key: "backspace" }, { buzz: false });
      updateEcho((shown) => shown.slice(0, -1));
      break;
  }
});
// Some Android keyboards skip beforeinput for composed text; catch it here.
typing.addEventListener("input", () => {
  if (typing.value) {
    typeOut(typing.value);
    typing.value = "";
  }
});
typing.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    send({ type: "key", key: "enter" }, { buzz: false });
    updateEcho(() => "");
  }
});

/* The dock: over the phone keyboard, opened from the pad. */

const dock = $("dock");

/** Keeps the dock just above the phone keyboard, where the browser doesn't. */
function placeDock() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  dock.style.bottom = `${covered}px`;
}
window.visualViewport?.addEventListener("resize", placeDock);
window.visualViewport?.addEventListener("scroll", placeDock);

function openDock() {
  dock.hidden = false;
  document.body.dataset.dock = "true";
  // Inside the tap, or the phone won't raise its keyboard.
  typing.focus();
  placeDock();
}

function closeDock() {
  dock.hidden = true;
  document.body.dataset.dock = "false";
  typing.blur();
}

// The pad's own buttons aren't touches on the pad.
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".pad-tools button")).forEach((button) =>
  button.addEventListener("pointerdown", (event) => event.stopPropagation()),
);
$("keyboard-open").addEventListener("click", openDock);
$("dock-close").addEventListener("click", closeDock);
// Tapping a key mustn't take focus from the field, or the keyboard drops.
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#dock button")).forEach((button) =>
  button.addEventListener("pointerdown", (event) => event.preventDefault()),
);
/** @type {HTMLElement} */ (document.querySelector('#dock [data-key="backspace"]')).addEventListener("click", () =>
  updateEcho((shown) => shown.slice(0, -1)),
);
/** @type {HTMLElement} */ (document.querySelector('#dock [data-key="enter"]')).addEventListener("click", () =>
  updateEcho(() => ""),
);

/* -------------------------------------------------------------------------- */
/* Presenting                                                                 */
/* -------------------------------------------------------------------------- */

const presenter = $("presenter");
let presenterOpen = false;
let presentingSince = Date.now();
/** @type {ReturnType<typeof setInterval> | undefined} */
let presenterClock;
/** @type {any} */
let wakeLock = null;

async function keepAwake() {
  try {
    wakeLock = await /** @type {any} */ (navigator).wakeLock?.request("screen");
  } catch {}
}

function tickPresenter() {
  const now = new Date();
  $("present-clock").textContent = `${now.getHours()}:${pad2(now.getMinutes())}`;
  const seconds = Math.floor((Date.now() - presentingSince) / 1000);
  const minutes = Math.floor(seconds / 60);
  $("present-elapsed").textContent =
    minutes >= 60 ? `${Math.floor(minutes / 60)}:${pad2(minutes % 60)}:${pad2(seconds % 60)}` : `${minutes}:${pad2(seconds % 60)}`;
}

function openPresenter() {
  presenterOpen = true;
  presenter.hidden = false;
  presentingSince = Date.now();
  tickPresenter();
  presenterClock = setInterval(tickPresenter, 1000);
  // Back closes it, and the phone stays awake while it's open.
  history.pushState({ presenter: true }, "");
  document.documentElement.requestFullscreen?.().catch(() => {});
  void keepAwake();
  clearTimeout(previewTimer);
  updateScreenPolling();
}

function closePresenter(fromHistory = false) {
  if (!presenterOpen) return;
  presenterOpen = false;
  presenter.hidden = true;
  clearInterval(presenterClock);
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!fromHistory && history.state?.presenter) history.back();
  updateScreenPolling();
}

$("present-open").addEventListener("click", openPresenter);
$("present-close").addEventListener("click", () => closePresenter());
$("present-elapsed").addEventListener("click", () => {
  presentingSince = Date.now();
  tickPresenter();
});
// Starting the show starts the clock.
$("present-start").addEventListener("click", () => {
  presentingSince = Date.now();
  tickPresenter();
});
window.addEventListener("popstate", () => closePresenter(true));
// A wake lock lapses when the phone locks or the app goes to the background.
document.addEventListener("visibilitychange", () => {
  if (presenterOpen && document.visibilityState === "visible") void keepAwake();
});

/* -------------------------------------------------------------------------- */
/* Settings: a page of its own                                                */
/* -------------------------------------------------------------------------- */

let settingsOpen = false;

function openSettings() {
  closeSheet();
  settingsOpen = true;
  // Opens on the settings for the tab you came from.
  showSettingsTab(/** @type {string} */ (document.body.dataset.tab));
  renderSettings();
  $("settings").hidden = false;
  $("settings").scrollTop = 0;
  document.body.dataset.settings = "true";
  send({ type: "devices" }, { buzz: false });
  // The phone's back button leaves settings, as the back arrow does.
  history.pushState({ settings: true }, "");
}

function closeSettings(fromHistory = false) {
  if (!settingsOpen) return;
  settingsOpen = false;
  $("settings").hidden = true;
  delete document.body.dataset.settings;
  if (!fromHistory && history.state?.settings) history.back();
}

$("gear").addEventListener("click", openSettings);
$("settings-back").addEventListener("click", () => closeSettings());
window.addEventListener("popstate", () => closeSettings(true));

/** @param {string} name */
function showSettingsTab(name) {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-settings-tab]")).forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.settingsTab === name));
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-settings-panel]")).forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== name;
  });
}

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-settings-tab]")).forEach((tab) =>
  tab.addEventListener("click", () => {
    showSettingsTab(/** @type {string} */ (tab.dataset.settingsTab));
    $("settings").scrollTop = 0;
  }),
);

/** Marks every switch and choice on the page as the settings have them. */
function renderSettings() {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#accents button")).forEach((button, index) => {
    button.dataset.active = String(index === accent);
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-switch]")).forEach((button) => {
    button.setAttribute("aria-checked", String(Boolean(settings[/** @type {SwitchKey} */ (button.dataset.switch)])));
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-list]")).forEach((button) => {
    const list = settings[/** @type {ListKey} */ (button.dataset.list)];
    button.setAttribute("aria-checked", String(!list.includes(/** @type {string} */ (button.dataset.item))));
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-set]")).forEach((button) => {
    button.dataset.active = String(String(settings[/** @type {keyof PhoneSettings} */ (button.dataset.set)]) === button.dataset.value);
  });
  // The laptop's own, as it last said.
  const prefs = state?.preferences;
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-pref-switch]")).forEach((button) => {
    button.setAttribute("aria-checked", String(Boolean(prefs?.[/** @type {"hotAlert" | "openReceived"} */ (button.dataset.prefSwitch)])));
    button.toggleAttribute("disabled", !prefs);
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-pref]")).forEach((button) => {
    button.dataset.active = String(String(prefs?.[/** @type {"hotAt" | "receiveTo"} */ (button.dataset.pref)]) === button.dataset.value);
    button.toggleAttribute("disabled", !prefs || (button.dataset.pref === "hotAt" && !prefs.hotAlert));
  });
  renderWarmth();
  setSlider("set-speed", settings.speed);
  $("speed-value").textContent = `${(settings.speed / 100).toFixed(1)}×`;
  setSlider("set-scroll", settings.scrollSpeed);
  $("scroll-value").textContent = `${(settings.scrollSpeed / 100).toFixed(1)}×`;
  renderLaptop();
}

/** Saves, puts the settings to work, and shows them. */
function settingsChanged() {
  saveSettings();
  applySettings();
  renderSettings();
}

// Accent: one swatch per colour.
$("accents").replaceChildren(
  ...ACCENTS.map(([name, color], index) => {
    const button = document.createElement("button");
    button.className = "swatch";
    button.style.setProperty("--swatch", /** @type {string} */ (color));
    button.setAttribute("aria-label", /** @type {string} */ (name));
    button.addEventListener("click", () => {
      accent = index;
      setAccent(index);
      try {
        localStorage.setItem(ACCENT_KEY, /** @type {string} */ (name));
      } catch {}
      renderSettings();
    });
    return button;
  }),
);

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-switch]")).forEach((button) =>
  button.addEventListener("click", () => {
    const key = /** @type {SwitchKey} */ (button.dataset.switch);
    settings[key] = !settings[key];
    settingsChanged();
    if (key === "haptics") vibrate(8);
    if (key === "awake") {
      if (settings.awake) void stayAwake();
      else awakeLock?.release?.().catch(() => {});
    }
  }),
);

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-list]")).forEach((button) =>
  button.addEventListener("click", () => {
    const key = /** @type {ListKey} */ (button.dataset.list);
    const item = /** @type {string} */ (button.dataset.item);
    const off = settings[key].includes(item);
    // At least one tab stays, or there'd be nothing to show.
    if (!off && key === "tabsOff" && settings.tabsOff.length >= TAB_NAMES.length - 1) {
      toast("keep at least one tab");
      return;
    }
    settings[key] = off ? settings[key].filter((name) => name !== item) : [...settings[key], item];
    settingsChanged();
  }),
);

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-set]")).forEach((button) =>
  button.addEventListener("click", () => {
    const key = /** @type {keyof PhoneSettings} */ (button.dataset.set);
    const value = /** @type {string} */ (button.dataset.value);
    /** @type {any} */ (settings)[key] = typeof DEFAULT_SETTINGS[key] === "number" ? Number(value) : value;
    settingsChanged();
  }),
);

// The laptop's own: sent there, and shown once the laptop's state says so.
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-pref-switch]")).forEach((button) =>
  button.addEventListener("click", () => {
    const key = /** @type {"hotAlert" | "openReceived"} */ (button.dataset.prefSwitch);
    if (state) send({ type: "preferences", change: { [key]: !state.preferences[key] } });
  }),
);
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-pref]")).forEach((button) =>
  button.addEventListener("click", () => {
    const value = /** @type {string} */ (button.dataset.value);
    const change =
      button.dataset.pref === "hotAt"
        ? { hotAt: Number(value) }
        : { receiveTo: /** @type {State["preferences"]["receiveTo"]} */ (value) };
    send({ type: "preferences", change });
  }),
);

function renderWarmth() {
  setSlider("set-warm", settings.warm);
  setSlider("set-warmer", settings.warmer);
  $("warm-value").textContent = `${settings.warm}k`;
  $("warmer-value").textContent = `${settings.warmer}k`;
}

/**
 * Warmer never sits above warm (lower kelvin is warmer), so dragging one past
 * the other takes it along. While night light is on at the step being
 * dragged, the laptop follows.
 * @param {"warm" | "warmer"} which
 */
function wireWarmth(which) {
  const slider = /** @type {HTMLInputElement} */ ($(`set-${which}`));
  const step = which === "warm" ? 1 : 2;
  /** @type {boolean | null} */
  let following = null;
  let sent = 0;
  const apply = (/** @type {boolean} */ done) => {
    settings[which] = Number(slider.value);
    if (which === "warm") settings.warmer = Math.min(settings.warmer, settings.warm);
    else settings.warm = Math.max(settings.warm, settings.warmer);
    saveSettings();
    renderWarmth();
    following ??= Number($("deck-night").dataset.level) === step;
    if (following && (done || Date.now() - sent > 80)) {
      sent = Date.now();
      send({ type: "night-light-set", temperature: settings[which] }, { buzz: false });
      nightTapped = { level: step, until: Date.now() + 2000 };
    }
    if (done) following = null;
  };
  slider.addEventListener("input", () => apply(false));
  slider.addEventListener("change", () => apply(true));
}
wireWarmth("warm");
wireWarmth("warmer");

/** @param {string} id @param {"speed" | "scrollSpeed"} key */
function wireRate(id, key) {
  $(id).addEventListener("input", () => {
    settings[key] = Number(/** @type {HTMLInputElement} */ ($(id)).value);
    saveSettings();
    renderSettings();
  });
}
wireRate("set-speed", "speed");
wireRate("set-scroll", "scrollSpeed");

// Keeping the screen on: a wake lock, taken again whenever the remote comes
// back to the front (the phone drops it on the way out).
/** @type {any} */
let awakeLock = null;

async function stayAwake() {
  if (!settings.awake || document.visibilityState !== "visible" || awakeLock) return;
  try {
    awakeLock = await /** @type {any} */ (navigator).wakeLock?.request("screen");
    awakeLock?.addEventListener?.("release", () => (awakeLock = null));
  } catch {}
}
document.addEventListener("visibilitychange", () => void stayAwake());
void stayAwake();

/** What /config.json says about the laptop's copy: its version and commit. */
/** @type {{ version: string; commit: string | null } | null} */
let about = null;

function renderLaptop() {
  $("laptop-address").textContent = location.host;
  $("laptop-status").textContent = socket?.readyState === WebSocket.OPEN ? "live" : "offline";
  $("install-row").hidden = installed();
  $("version").textContent = about ? `${about.version}${about.commit ? ` · ${about.commit.slice(0, 7)}` : ""}` : "--";
  if (about === null && settingsOpen) {
    fetch("/config.json")
      .then((response) => response.json())
      .then((config) => {
        about = { version: String(config.version ?? "--"), commit: config.commit ?? null };
        renderLaptop();
      })
      .catch(() => {});
  }
}

$("settings-install").addEventListener("click", () => openSheet({ kind: "install" }));

/**
 * A button that needs a second tap within three seconds, for what can't be
 * undone from the phone.
 * @param {HTMLElement} button
 * @param {() => void} run
 */
function twoTaps(button, run) {
  const label = button.textContent;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let disarm;
  button.addEventListener("click", () => {
    if (button.dataset.armed !== "true") {
      button.dataset.armed = "true";
      button.textContent = "tap again";
      disarm = setTimeout(() => {
        button.dataset.armed = "false";
        button.textContent = label;
      }, 3000);
      return;
    }
    clearTimeout(disarm);
    button.dataset.armed = "false";
    button.textContent = label;
    run();
  });
}

/** Drops this phone's pairing and starts over: the QR code pairs it again. */
function forgetLaptop() {
  storage("clear");
  location.replace(location.pathname);
}

twoTaps($("forget"), () => {
  if (myDevice) send({ type: "device-remove", id: myDevice });
  forgetLaptop();
});
twoTaps($("unpair-all"), () => send({ type: "unpair-all" }));
twoTaps($("reset-settings"), () => {
  try {
    for (const key of [SETTINGS_KEY, ACCENT_KEY, LAYOUT_KEY]) localStorage.removeItem(key);
  } catch {}
  location.reload();
});

// Paired phones, as the laptop lists them. Removing this one forgets the laptop.
/** @type {string | null} */
let myDevice = null;

/** @param {import("../src/devices").DeviceView[]} list */
function renderDevices(list) {
  $("devices").replaceChildren(
    ...list.map((device) => {
      const row = document.createElement("div");
      row.className = "device";
      const text = document.createElement("div");
      const name = document.createElement("p");
      name.textContent = device.id === myDevice ? `${device.name} · this phone` : device.name;
      const when = document.createElement("small");
      when.textContent = `paired ${timeAgo(device.paired)} · ${device.id === myDevice ? "here now" : `seen ${timeAgo(device.seen)}`}`;
      text.append(name, when);
      const remove = document.createElement("button");
      remove.className = "small";
      remove.textContent = "remove";
      twoTaps(remove, () => {
        send({ type: "device-remove", id: device.id });
        if (device.id === myDevice) forgetLaptop();
      });
      row.append(text, remove);
      return row;
    }),
  );
}

// Whether the laptop's copy is behind GitHub's: compared by commit.
$("check-updates").addEventListener("click", async () => {
  const status = $("update-status");
  status.hidden = false;
  status.textContent = "checking…";
  const commit = about?.commit;
  if (!commit) {
    status.textContent = "the laptop's copy isn't a git checkout, so there's nothing to compare.";
    return;
  }
  try {
    const response = await fetch(`https://api.github.com/repos/uzayr-iqbal-hamid/hypr-remote/compare/${commit}...main`);
    if (!response.ok) throw new Error(String(response.status));
    const { ahead_by: ahead } = await response.json();
    status.textContent = ahead
      ? `${ahead} update${ahead === 1 ? "" : "s"} on github. on the laptop: git pull, then systemctl --user restart hypr-remote.`
      : "up to date.";
  } catch {
    status.textContent = "couldn't reach github. is the phone online?";
  }
});

// The tab picked in settings, now that everything is set up.
applySettings();
showTab(visibleTabs().includes(settings.tab) ? settings.tab : /** @type {string} */ (visibleTabs()[0]));

if (config) {
  config.then((c) => (c.httpAllowed ? connect() : guideToSecure(c))).catch(connect);
} else {
  connect();
}
