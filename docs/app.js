const menuButton = document.querySelector("#menu-button");
const primaryNav = document.querySelector("#primary-nav");
const copyToast = document.querySelector("#copy-toast");
const progressBar = document.querySelector("#reading-progress-bar");
let toastTimer;

function setMenu(open) {
  if (!menuButton || !primaryNav) return;
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  primaryNav.classList.toggle("is-open", open);
  document.body.classList.toggle("menu-open", open);
}

menuButton?.addEventListener("click", () => {
  setMenu(menuButton.getAttribute("aria-expanded") !== "true");
});

primaryNav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenu(false));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuButton?.getAttribute("aria-expanded") === "true") {
    setMenu(false);
    menuButton.focus();
  }
});

function updateProgress() {
  if (!progressBar) return;
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const progress = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
  progressBar.style.width = `${progress * 100}%`;
}

let progressFrame = 0;
window.addEventListener("scroll", () => {
  if (progressFrame) return;
  progressFrame = window.requestAnimationFrame(() => {
    updateProgress();
    progressFrame = 0;
  });
}, { passive: true });
updateProgress();

const observedSections = [...document.querySelectorAll("main section[id]")];
const sectionLinks = [...document.querySelectorAll(".primary-nav a[href^='#']")];
if ("IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    sectionLinks.forEach((link) => {
      const active = link.getAttribute("href") === `#${visible.target.id}`;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, { rootMargin: "-25% 0px -62%", threshold: [0, 0.2, 0.5] });
  observedSections.forEach((section) => sectionObserver.observe(section));
}

function showToast(message) {
  if (!copyToast) return;
  window.clearTimeout(toastTimer);
  copyToast.textContent = message;
  copyToast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => copyToast.classList.remove("is-visible"), 2600);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const temporary = document.createElement("textarea");
  temporary.value = text;
  temporary.setAttribute("readonly", "");
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.append(temporary);
  temporary.select();
  const copied = document.execCommand("copy");
  temporary.remove();
  if (!copied) throw new Error("Copy command was unavailable");
}

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    try {
      await copyText(target.innerText.trim());
      showToast("Copied to clipboard");
      const label = button.querySelector("span");
      if (label) {
        const previous = label.textContent;
        label.textContent = "Copied";
        window.setTimeout(() => { label.textContent = previous; }, 1800);
      }
    } catch {
      showToast("Copy failed — select the text manually");
    }
  });
});

const routeTabs = [...document.querySelectorAll("[data-route-tab]")];
const routePanels = [...document.querySelectorAll("[data-route-panel]")];

function selectRoute(name, moveFocus = false) {
  routeTabs.forEach((tab) => {
    const selected = tab.dataset.routeTab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) tab.focus();
  });
  routePanels.forEach((panel) => {
    const selected = panel.dataset.routePanel === name;
    panel.hidden = !selected;
    panel.classList.toggle("is-active", selected);
  });
}

routeTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectRoute(tab.dataset.routeTab));
  tab.addEventListener("keydown", (event) => {
    let nextIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % routeTabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + routeTabs.length) % routeTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = routeTabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectRoute(routeTabs[nextIndex].dataset.routeTab, true);
  });
});

const searchInput = document.querySelector("#docs-search");
const searchStatus = document.querySelector("#search-status");
const searchEmpty = document.querySelector("#search-empty");
const faqItems = [...document.querySelectorAll(".faq-list [data-search-card]")];

function normalize(value) {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function filterSupportTopics() {
  if (!searchInput) return;
  const query = normalize(searchInput.value);
  let matches = 0;
  faqItems.forEach((item) => {
    const matched = !query || normalize(item.textContent).includes(query);
    item.classList.toggle("is-search-hidden", !matched);
    if (matched) matches += 1;
  });
  if (searchStatus) {
    searchStatus.textContent = query
      ? `${matches} support topic${matches === 1 ? "" : "s"} matched`
      : "Showing all support topics";
  }
  if (searchEmpty) searchEmpty.hidden = matches !== 0;
}

searchInput?.addEventListener("input", filterSupportTopics);

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  if (event.key === "/" && !isTyping && searchInput) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth >= 960) setMenu(false);
});
