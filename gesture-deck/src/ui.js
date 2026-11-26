export const $ = id => document.getElementById(id);

const icons = {
  'gesture-screen': '<rect x="2" y="3" width="20" height="15" rx="2"/><path d="m9 18-2 3m8-3 2 3M8 13l-.7-2a.9.9 0 0 1 1.6-.8l.8 1.2V7a1 1 0 0 1 2 0v3-4a1 1 0 0 1 2 0v4-2a1 1 0 0 1 2 0v4a4 4 0 0 1-7.7 1Z"/>',
  hand: '<path d="M5.3 13 4 10.4a1.35 1.35 0 0 1 2.3-1.3l1.8 2.3V5a1.35 1.35 0 0 1 2.7 0v5.5-7a1.35 1.35 0 0 1 2.7 0v7-5.7a1.35 1.35 0 0 1 2.7 0v6.1-3.5a1.35 1.35 0 0 1 2.7 0v7.1c0 4.35-2.7 7.1-6.7 7.1-3.1 0-4.6-1.6-5.6-4.1L5.3 13Z"/>',
  'motion-right': '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 10h4m-4 5h4m10-5h4m-4 5h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  timeline: '<path d="M3 16h4l3-8 4 11 3-6h4M3 5h18"/>',
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  play: '<path d="m9 5 12 7-12 7V5Z"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  upload: '<path d="M3 16v4h18v-4M12 16V4m-5 5 5-5 5 5"/>',
  pin: '<path d="M19 10c0 6-7 11-7 11s-7-5-7-11a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  checklist: '<path d="m3 6 2 2 4-4m-6 9 2 2 4-4m3-4h9m-9 7h9m-9 6h9"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 4v4m8 2v4m-6 2v4" stroke-width="3"/>',
  expand: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>'
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

let toastTimer;
export function notify(message, error = false) {
  const toast = $('toast');
  toast.classList.toggle('error', error);
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4800);
}

export function timestamp(milliseconds, precise = false) {
  const seconds = Math.max(0, milliseconds) / 1000;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  const base = `${String(minutes).padStart(2, '0')}:${remainder}`;
  return precise ? `${base}.${Math.floor((milliseconds % 1000) / 100)}` : base;
}

export function button(label, onClick, className = 'button small') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.onclick = onClick;
  return element;
}

export async function readJson(file) {
  try {
    return JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('无法读取 JSON。请选择完整的配置、实验包或轨迹文件。');
  }
}

export function bindFile(buttonId, inputId, onLoad) {
  const input = $(inputId);
  let reading = false;
  $(buttonId).onclick = () => input.click();
  input.onchange = async () => {
    const [file] = input.files;
    input.value = '';
    if (!file || reading) return;
    reading = true;
    try {
      await onLoad(file);
    } catch (error) {
      notify(error.message, true);
    } finally {
      reading = false;
    }
  };
}

export function saveJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function filenameStem(name) {
  return name?.replace(/[^\p{L}\p{N}_.-]+/gu, '_').slice(0, 60) || 'gesture';
}
