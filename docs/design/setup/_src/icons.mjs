const S = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1Z"/>',
  layers:
    '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  pause:
    '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1Z"/><path d="M12 15l-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2Z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/>',
  github:
    '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.1-1.3-.3-2.5-1-3.5.3-1.2.3-2.4 0-3.5 0 0-1 0-3 1.5a10.3 10.3 0 0 0-5 0C9 2 8 2 8 2c-.3 1.1-.3 2.3 0 3.5A5.4 5.4 0 0 0 7 9c0 3.5 3 5.5 6 5.5-.4.4-.7.9-.9 1.5-.2.6-.3 1.2-.2 1.8V22"/><path d="M9 18c-4.5 2-5-2-7-2"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  store:
    '<path d="M3 9 4.5 4h15L21 9"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z"/><path d="M5 13v7h14v-7"/>',
  wand: '<path d="m15 4 5 5L8 21l-5-5Z"/><path d="M14 3l1-2M20 8l2-1M18 3l2-2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  heart:
    '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  idcard:
    '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2.5"/><path d="M14 10h5M14 14h3"/>',
  slash: '<circle cx="12" cy="12" r="9.5"/><path d="m5.5 5.5 13 13"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  search: '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="7.5" cy="15.5" r="5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  laptop:
    '<rect x="4" y="4" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
  monitor:
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone:
    '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  gamepad:
    '<rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4M8 10v4"/><path d="M15 13h.01M18 11h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>',
  alert: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5M12 16.2h.01"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  package:
    '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7Z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/><path d="m7.5 4.3 9 5.2"/>',
  passkey:
    '<circle cx="9" cy="7.5" r="4"/><path d="M2.5 21v-.5A6.5 6.5 0 0 1 12 14.7"/><circle cx="18" cy="13" r="2.6"/><path d="M18 15.6V21.5M18 18.5h2.2M18 20.7h1.6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  trash:
    '<path d="M3 6h18M8 6V4h8v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  filter: '<path d="M3 5h18l-7 8.5V19l-4 2v-7.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  system:
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  sealCheck:
    '<circle cx="12" cy="12" r="9.5"/><path d="m8 12.2 2.8 2.8L16.5 9"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 17.5h.01"/>',
  library:
    '<rect x="3" y="3" width="7.5" height="9" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.5"/><rect x="3" y="15" width="7.5" height="6" rx="1.5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  shieldUser:
    '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5a6.5 6.5 0 0 1 11 0"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  sparkCode: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  play: '<path d="M7 4.5v15l13-7.5Z"/>',
  globe:
    '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.8 3.8 6 3.8 9.5s-1.2 6.7-3.8 9.5c-2.6-2.8-3.8-6-3.8-9.5S9.4 5.3 12 2.5Z"/>',
  iphone:
    '<rect x="6.5" y="2" width="11" height="20" rx="2.8"/><path d="M10.5 4.6h3"/>',
  command:
    '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z"/>',
  sparkle: '<path d="M12 3v18M3 12h18"/>',
  enter: '<path d="M20 5v7a3 3 0 0 1-3 3H5"/><path d="m9 11-4 4 4 4"/>',
  arrowsUD: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  disc: '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="2.5"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5Z"/><path d="M4 21.5A2.5 2.5 0 0 1 6.5 19H20v3H6.5"/>',
  flathub:
    '<path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Z"/><path d="M12 2.5V12m0 0 8.5-5M12 12l-8.5-5M12 12v9.5"/>',
  lock: '<rect x="4" y="10.5" width="16" height="11" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  cloud:
    '<path d="M7 19h10.5a4.5 4.5 0 0 0 .6-9A6.5 6.5 0 0 0 5.6 11.4 3.8 3.8 0 0 0 7 19Z"/>',
  cloudSync:
    '<path d="M7 19h10.5a4.5 4.5 0 0 0 .6-9A6.5 6.5 0 0 0 5.6 11.4 3.8 3.8 0 0 0 7 19Z"/><path d="M9.5 14.5a2.6 2.6 0 0 1 4.6-1.4M14.5 14a2.6 2.6 0 0 1-4.6 1.4"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M14 21h3M20 18v3M17 17v4"/>',
  tv: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  compass:
    '<circle cx="12" cy="12" r="9.5"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>',
  unlink:
    '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/><path d="M3 3l18 18"/>',
  shield:
    '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6Z"/><path d="m8.5 12 2.5 2.5 4.5-4.5"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13"/><path d="M12 8C10 4 7 4 7 6s2.5 2 5 2c2.5 0 5 0 5-2s-3-2-5 2Z"/>',
  merge:
    '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 7.5v9M6 9c0 3 3 3 6 3h3.5"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  fileText:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  wifiOff:
    '<path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.3-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 11 5"/><path d="M12 20h.01"/>',
};
const F = {
  apple:
    '<path d="M16.4 12.7c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.5-1-2.5-3.9ZM14 5.6c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.6 2.8-1.4Z"/>',
  windows:
    '<path d="M3 5.6 10.4 4.6v7H3ZM11.6 4.4 21 3v8.6h-9.4ZM3 12.6h7.4v7L3 18.5ZM11.6 12.6H21V21l-9.4-1.3Z"/>',
  linux:
    '<path fill-rule="evenodd" d="M12 2.5c-2.6 0-4 2.2-4 4.8 0 1.2-.6 2.2-1.5 3.4C5.3 12.3 4.5 14 4.5 16c0 3 2.6 5.5 7.5 5.5s7.5-2.5 7.5-5.5c0-2-.8-3.7-2-5.3-.9-1.2-1.5-2.2-1.5-3.4 0-2.6-1.4-4.8-4-4.8Zm0 9c2.2 0 3.6 2 3.6 4.4S14.2 20 12 20s-3.6-1.7-3.6-4.1S9.8 11.5 12 11.5ZM10.3 6.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Zm3.4 0a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z"/><path d="M5.5 21.6c0-1 1.6-1.7 3.2-1.7s2.6.6 2.6 1.1-1.4 1-3 1-2.8-.1-2.8-.4Zm7.2-.6c0-.5 1-1.1 2.6-1.1s3.2.7 3.2 1.7-1.2.4-2.8.4-3-.5-3-1Z"/>',
  android:
    '<path d="M6.5 10h11v7.5a1.5 1.5 0 0 1-1.5 1.5H8a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M6.5 9a5.5 5.5 0 0 1 11 0Z"/><rect x="3.5" y="10" width="2" height="6" rx="1"/><rect x="18.5" y="10" width="2" height="6" rx="1"/><rect x="8.5" y="18" width="2" height="4" rx="1"/><rect x="13.5" y="18" width="2" height="4" rx="1"/>',
  steam:
    '<path d="M12 2a10 10 0 0 0-10 9.2l5.4 2.2a2.8 2.8 0 0 1 1.7-.5l2.4-3.5v-.1a3.8 3.8 0 1 1 3.8 3.8h-.1l-3.4 2.4a2.9 2.9 0 0 1-5.7.7L2.3 14.6A10 10 0 1 0 12 2Zm-3.7 15.2-1.2-.5a2.1 2.1 0 1 0 1.9-3l1.3.5a1.6 1.6 0 1 1-2 3Zm9.3-7.8a2.5 2.5 0 1 0-2.5 2.5 2.5 2.5 0 0 0 2.5-2.5Zm-4.4 0a1.9 1.9 0 1 1 1.9 1.9 1.9 1.9 0 0 1-1.9-1.9Z"/>',
  appstore:
    '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-4.9 14.6-.8 1.3a.9.9 0 0 1-1.5-.9l.8-1.3Zm5.5-2.6H5.5a.9.9 0 0 1 0-1.8h2.3l3-5.2-.9-1.5a.9.9 0 0 1 1.5-.9l.4.7.4-.7a.9.9 0 0 1 1.5.9l-3.9 6.7h2.6Zm5.9 0h-1.5l1 1.7a.9.9 0 0 1-1.5.9l-3.5-6 1-1.8 2.1 3.4h2.4a.9.9 0 0 1 0 1.8Z"/>',
  gplay:
    '<path d="M4 2.8v18.4c0 .5.5.8.9.6L15 12 4.9 2.2c-.4-.2-.9.1-.9.6Zm12.2 10.4-2.4-2.4L5.9 21.5ZM5.9 2.5l7.9 10.7 2.4-2.4Zm11.4 7.2-2.5 2.3 2.5 2.3 2.9-1.6a.8.8 0 0 0 0-1.4Z"/>',
  gamecenter:
    '<circle cx="8" cy="9" r="4.4" opacity=".9"/><circle cx="16" cy="8" r="3.4" opacity=".7"/><circle cx="15" cy="16" r="4.6" opacity=".8"/><circle cx="7.5" cy="17" r="2.6" opacity=".6"/>',
  google:
    '<path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4Z"/><path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" opacity=".8"/><path d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9Z" opacity=".6"/><path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5L6.4 10C7.2 7.8 9.4 6 12 6Z" opacity=".7"/>',
  itch: '<path d="M3.1 3.5C2 4.2 0 6.5 0 7.1v1c0 1.3 1.2 2.4 2.3 2.4 1.3 0 2.4-1.1 2.4-2.4 0 1.3 1.1 2.4 2.4 2.4s2.3-1.1 2.3-2.4c0 1.3 1.1 2.4 2.5 2.4h.1c1.4 0 2.5-1.1 2.5-2.4 0 1.3 1 2.4 2.3 2.4s2.4-1.1 2.4-2.4c0 1.3 1.1 2.4 2.4 2.4S24 9.4 24 8.1v-1c0-.6-2-2.9-3.1-3.6-3.5-.1-5.9-.2-8.9-.2s-7.4.1-8.9.2Zm6.3 6.4a2.7 2.7 0 0 1-4.7 0 2.7 2.7 0 0 1-2.5 1.3c.2 6.3-.2 9.8 1 11 2.6.6 7.4.9 8.8.9s6.2-.3 8.8-.9c1.2-1.2.8-4.7 1-11a2.7 2.7 0 0 1-2.5-1.3 2.7 2.7 0 0 1-4.7 0 2.7 2.7 0 0 1-2.4 1.4H12a2.7 2.7 0 0 1-2.6-1.4Zm1 3.2c1 0 1.9 0 3 1.2l.8-.1.8.1c1.1-1.2 2-1.2 3-1.2.5 0 2.4 0 3.8 3.8l1.5 5.3c1.1 3.9-.3 4-2.1 4-2.6-.1-4.1-2-4.1-4l-2.9.1-2.9-.1c0 2-1.5 3.9-4.1 4-1.8 0-3.2-.1-2.1-4l1.5-5.3c1.3-3.8 3.3-3.8 3.8-3.8Zm1.6 2.6s-2.5 2.3-2.9 3.1l1.6-.1v1.4h2.6v-1.4l1.6.1c-.5-.8-2.9-3.1-2.9-3.1Z"/>',
  msstore:
    '<path d="M3 7h18l-1 13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2ZM8 7V5a4 4 0 0 1 8 0v2"/>',
};

// SETUP.md additions (2026-10-05): storefront and wizard glyphs not in the EXPERIENCE set.
Object.assign(S, {
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/><path d="M12 17v5"/>',
  homebrew:
    '<path d="M5 8h11v10a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M7 5c0-1.5 1-2 2-2 .6-1 2.4-1 3 0 1.2 0 2 .7 2 2"/>',
  scoop:
    '<path d="M4 10h16l-2 10a2 2 0 0 1-2 1.6H8A2 2 0 0 1 6 20Z"/><path d="M8 10a4 4 0 0 1 8 0"/>',
  winget:
    '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5Z"/><path d="M12 9v7m-3-3 3 3 3-3"/>',
  altstore:
    '<path d="M12 2.5 21.5 12 12 21.5 2.5 12Z"/><path d="M8.5 15 12 7l3.5 8M9.8 12.4h4.4"/>',
  fdroid:
    '<rect x="4.5" y="8" width="15" height="10" rx="3"/><path d="M7 5l1.5 3M17 5l-1.5 3"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
  obtainium:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12 18 6"/>',
  installer:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 7v8m-3.5-3.5L12 15l3.5-3.5M8 18h8"/>',
  snap: '<path d="M4 4h9l7 7-9 9-7-7Z"/><path d="M9 9h4"/>',
  qrc: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3z"/>',
});

export function icon(name, { size = 20, cls = "", label = "" } = {}) {
  const aria = label
    ? `role="img" aria-label="${label}"`
    : 'aria-hidden="true"';
  if (S[name])
    return `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${aria}>${S[name]}</svg>`;
  if (F[name])
    return `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" ${aria}>${F[name]}</svg>`;
  throw new Error("no icon " + name);
}
export const PLATFORM_ICON = {
  macos: "apple",
  ios: "iphone",
  windows: "windows",
  linux: "linux",
  android: "android",
  play: "gplay",
  steamdeck: "steam",
  web: "globe",
};
export const PLATFORM_LABEL = {
  macos: "macOS",
  ios: "iPhone & iPad",
  windows: "Windows",
  linux: "Linux",
  android: "Android",
  steamdeck: "Steam Deck",
  web: "Web",
};
