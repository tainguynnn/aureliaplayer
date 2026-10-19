const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([typeBuf, data]);
  const crc = crc32(typeAndData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, typeAndData, crcBuf]);
}

function createPng(width, height, pixelFn) {
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bits per channel
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = makeChunk('IHDR', ihdrData);

  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // Filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const idx = 1 + x * 4;
      row[idx] = r;
      row[idx + 1] = g;
      row[idx + 2] = b;
      row[idx + 3] = a;
    }
    rawRows.push(row);
  }

  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([header, ihdr, idat, iend]);
}

// Generate Dynamic Island icon (Width 64, Height 64)
// Sleek dark pill / capsule with golden vinyl disc and animated EQ bars
const size = 64;
const pngBuf = createPng(size, size, (x, y, w, h) => {
  // Center is (32, 32)
  // Pill bounds: x between 4 and 60, y between 14 and 50 (height 36, radius 18)
  const pillY1 = 16;
  const pillY2 = 48;
  const rPill = 16;
  const xLeftCenter = 16 + 4;
  const xRightCenter = w - 16 - 4;

  // Signed distance function to pill
  let dPill = 999;
  if (x < xLeftCenter) {
    const dx = x - xLeftCenter;
    const dy = y - 32;
    dPill = Math.sqrt(dx * dx + dy * dy) - rPill;
  } else if (x > xRightCenter) {
    const dx = x - xRightCenter;
    const dy = y - 32;
    dPill = Math.sqrt(dx * dx + dy * dy) - rPill;
  } else {
    dPill = Math.abs(y - 32) - rPill;
  }

  // Outside pill
  if (dPill > 1.0) {
    return [0, 0, 0, 0];
  }

  // Pill border anti-aliasing
  let pillAlpha = 1.0;
  if (dPill > 0.0) {
    pillAlpha = 1.0 - dPill;
  }

  // Default pill background: deep obsidian glass (#080a10) with subtle gradient
  let bgR = 10;
  let bgG = 12;
  let bgB = 18;

  // Pill outer glow / border ring
  if (dPill >= -1.8) {
    // Golden border
    const borderT = (dPill + 1.8) / 1.8;
    return [
      Math.round(245 * 0.9),
      Math.round(158 * 0.9),
      Math.round(11 * 0.9),
      Math.round(240 * pillAlpha)
    ];
  }

  // Inside Pill:
  // 1. Vinyl disc on the left (Center: (21, 32), Radius: 10)
  const discX = 20;
  const discY = 32;
  const dDisc = Math.sqrt((x - discX) ** 2 + (y - discY) ** 2);
  
  if (dDisc <= 10.5) {
    if (dDisc <= 2.2) {
      // Center spindle hole
      return [10, 12, 18, Math.round(255 * pillAlpha)];
    }
    if (dDisc <= 4.2) {
      // Center gold label
      return [245, 158, 11, Math.round(255 * pillAlpha)];
    }
    // Grooves
    const groove = Math.sin(dDisc * 4.5);
    if (groove > 0.3) {
      return [217, 119, 6, Math.round(255 * pillAlpha)];
    } else {
      return [251, 191, 36, Math.round(255 * pillAlpha)];
    }
  }

  // 2. Dynamic Island Waveform EQ Bars on the right
  // 4 bars at X: 35, 41, 47, 53
  // Heights: 12px, 20px, 16px, 10px (centered at Y: 32)
  const bars = [
    { cx: 36, h: 12 },
    { cx: 42, h: 22 },
    { cx: 48, h: 17 },
    { cx: 54, h: 11 }
  ];

  for (const bar of bars) {
    const halfH = bar.h / 2;
    const barTop = 32 - halfH;
    const barBottom = 32 + halfH;
    const barRadius = 1.5;
    
    // Check if (x, y) is inside rounded bar
    if (Math.abs(x - bar.cx) <= barRadius && y >= barTop && y <= barBottom) {
      // Amber / Gold EQ bar
      return [251, 191, 36, Math.round(255 * pillAlpha)];
    }
    if (Math.abs(x - bar.cx) <= barRadius) {
      const dyTop = Math.abs(y - barTop);
      const dyBot = Math.abs(y - barBottom);
      if (dyTop <= 1.2 || dyBot <= 1.2) {
        return [245, 158, 11, Math.round(220 * pillAlpha)];
      }
    }
  }

  // Pill fill background
  return [bgR, bgG, bgB, Math.round(245 * pillAlpha)];
});

const outPath = path.resolve('f:/aureliaplayer/src-tauri/icons/tray.png');
fs.writeFileSync(outPath, pngBuf);
console.log('Created tray icon at:', outPath, 'size:', pngBuf.length, 'bytes');
