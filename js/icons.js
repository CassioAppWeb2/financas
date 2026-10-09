// Ícones em SVG (traço fino, 24×24), desenhados para o app. Herdam a cor do texto (currentColor).
const P = {
  home: '<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  chat: '<path d="M5 18.5V6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9z"/><path d="M9 9h6M9 12h4"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  bank: '<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>',
  budget: '<path d="M12 4a8 8 0 1 0 8 8h-8z"/><path d="M15 3.5A6 6 0 0 1 20.5 9H15z"/>',
  repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h12"/><path d="m16 3 3 3-3 3"/><path d="M20 13v2a3 3 0 0 1-3 3H5"/><path d="m8 21-3-3 3-3"/>',
  tag: '<path d="M3.5 12.5V5a1.5 1.5 0 0 1 1.5-1.5h7.5L21 12l-8.5 8.5z"/><circle cx="8" cy="8" r="1.4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  send: '<path d="M4 12 20 4l-5 16-3.5-6.5z"/><path d="M11.5 13.5 20 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 19h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.8a3 3 0 0 1 0 5.4M17 14.2a5.5 5.5 0 0 1 3.5 4.8"/>',
  left: '<path d="m14.5 6-6 6 6 6"/>',
  right: '<path d="m9.5 6 6 6-6 6"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M16 13.5h1.5"/>',
  split: '<path d="M12 3v7"/><path d="M12 10 6 16v4M12 10l6 6v4"/>',
  handshake: '<path d="M3 11 7 7l4 1.5L14 7l7 4"/><path d="M7 7 3 13l5 5 2-1.5 2 1.5 2-1.5 2 1.5 4-5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  up: '<path d="M7 10.5v9H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M7 10.5 11 3.5a2 2 0 0 1 2.6 1.9L13 9.5h5.3a2 2 0 0 1 2 2.4l-1.3 6.2a2 2 0 0 1-2 1.6H7"/>',
  down: '<path d="M7 13.5v-9H4.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1z"/><path d="M7 13.5l4 7a2 2 0 0 0 2.6-1.9L13 14.5h5.3a2 2 0 0 0 2-2.4l-1.3-6.2a2 2 0 0 0-2-1.6H7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4l3 2"/>',
  trend: '<path d="M3.5 17.5 9 12l4 3.5 7-8"/><path d="M15 7.5h5v5"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16.5 5.5 12 10 7.5M5.5 12H16"/>',
};

export function icon(name, size = 20, cls = "") {
  return `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ""}</svg>`;
}

/** Marca do app: um anel de moeda com uma linha de tendência — finanças da casa sob controle. */
export function logo(size = 34) {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">
    <rect width="40" height="40" rx="11" fill="var(--logo-bg)"/>
    <circle cx="20" cy="20" r="11.5" fill="none" stroke="var(--logo-ring)" stroke-width="1.6" opacity=".55"/>
    <path d="M12.5 24.5 17.5 19l3.5 3.2 6.5-7.2" fill="none" stroke="var(--logo-line)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="27.5" cy="15" r="2" fill="var(--logo-line)"/>
  </svg>`;
}
