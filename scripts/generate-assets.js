/**
 * generate-assets.js — PillSignal brand asset generation
 *
 * Generates all favicon sizes and the OG image from SVG via sharp.
 *
 * Usage:
 *   node scripts/generate-assets.js
 */

import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = join(__dirname, '..', 'docs');

// ─── Brand icon SVG ───────────────────────────────────────────────────────────
// Concept: teal-green rounded-square background, white horizontal pill capsule
// (two-tone halves), teal ECG/signal wave clipped to the pill interior.

function iconSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#00A67E"/>
  <clipPath id="pill">
    <path d="M30,36 L70,36 A14,14 0 0 1 70,64 L30,64 A14,14 0 0 1 30,36 Z"/>
  </clipPath>
  <path d="M30,36 L50,36 L50,64 L30,64 A14,14 0 0 1 30,36 Z" fill="#FFFFFF"/>
  <path d="M50,36 L70,36 A14,14 0 0 1 70,64 L50,64 Z" fill="rgba(255,255,255,0.80)"/>
  <rect x="48.5" y="36" width="3" height="28" fill="rgba(0,80,60,0.12)"/>
  <polyline
    clip-path="url(#pill)"
    points="22,50 32,50 36,40 40,60 44,50 56,50 60,40 64,60 68,50 78,50"
    fill="none"
    stroke="#00A67E"
    stroke-width="4"
    stroke-linecap="round"
    stroke-linejoin="round"/>
</svg>`;
}

// ─── OG image SVG (1200×630) ──────────────────────────────────────────────────

function ogSvg() {
  // Embed the icon as an inline group scaled to ~200px (2× the 100-unit viewBox)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <!-- Background -->
  <rect width="1200" height="630" fill="#00A67E"/>
  <!-- Subtle vignette for depth -->
  <radialGradient id="vg" cx="50%" cy="50%" r="70%">
    <stop offset="0%" stop-color="rgba(255,255,255,0.06)"/>
    <stop offset="100%" stop-color="rgba(0,0,0,0.12)"/>
  </radialGradient>
  <rect width="1200" height="630" fill="url(#vg)"/>

  <!-- Icon centered at top (2× scale, translated so center is at 600,195) -->
  <g transform="translate(500,95) scale(2)">
    <rect width="100" height="100" rx="22" fill="rgba(255,255,255,0.18)"/>
    <clipPath id="pill-og">
      <path d="M30,36 L70,36 A14,14 0 0 1 70,64 L30,64 A14,14 0 0 1 30,36 Z"/>
    </clipPath>
    <path d="M30,36 L50,36 L50,64 L30,64 A14,14 0 0 1 30,36 Z" fill="#FFFFFF"/>
    <path d="M50,36 L70,36 A14,14 0 0 1 70,64 L50,64 Z" fill="rgba(255,255,255,0.80)"/>
    <rect x="48.5" y="36" width="3" height="28" fill="rgba(0,80,60,0.15)"/>
    <polyline
      clip-path="url(#pill-og)"
      points="22,50 32,50 36,40 40,60 44,50 56,50 60,40 64,60 68,50 78,50"
      fill="none"
      stroke="#00A67E"
      stroke-width="4"
      stroke-linecap="round"
      stroke-linejoin="round"/>
  </g>

  <!-- Wordmark -->
  <text
    x="600" y="410"
    text-anchor="middle"
    fill="#ffffff"
    font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
    font-size="108"
    font-weight="800"
    letter-spacing="-2">PillSignal</text>

  <!-- Tagline -->
  <text
    x="600" y="490"
    text-anchor="middle"
    fill="rgba(255,255,255,0.82)"
    font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
    font-size="40"
    font-weight="400"
    letter-spacing="0.2">Explore FDA adverse event reports</text>
</svg>`;
}

// ─── Twitter/X banner SVG (1500×500) ─────────────────────────────────────────

function twitterBannerSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
  <!-- Background -->
  <rect width="1500" height="500" fill="#00A67E"/>
  <!-- Subtle vignette for depth -->
  <radialGradient id="vg" cx="50%" cy="50%" r="75%">
    <stop offset="0%" stop-color="rgba(255,255,255,0.07)"/>
    <stop offset="100%" stop-color="rgba(0,0,0,0.14)"/>
  </radialGradient>
  <rect width="1500" height="500" fill="url(#vg)"/>

  <!-- Wordmark -->
  <text
    x="750" y="228"
    text-anchor="middle"
    dominant-baseline="auto"
    fill="#ffffff"
    font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
    font-size="148"
    font-weight="800"
    letter-spacing="-3">PillSignal</text>

  <!-- Divider dot -->
  <circle cx="750" cy="268" r="4" fill="rgba(255,255,255,0.5)"/>

  <!-- Tagline -->
  <text
    x="750" y="320"
    text-anchor="middle"
    fill="rgba(255,255,255,0.82)"
    font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
    font-size="44"
    font-weight="400"
    letter-spacing="0.5">Explore FDA Adverse Event Reports</text>
</svg>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPillSignal — Generate Brand Assets\n');

  const favicons = [
    { file: 'favicon-16x16.png',          size: 16  },
    { file: 'favicon-32x32.png',          size: 32  },
    { file: 'apple-touch-icon.png',       size: 180 },
    { file: 'android-chrome-192x192.png', size: 192 },
    { file: 'android-chrome-512x512.png', size: 512 },
  ];

  for (const { file, size } of favicons) {
    await sharp(Buffer.from(iconSvg(size))).png().toFile(join(DOCS, file));
    console.log(`  ${file}`);
  }

  // favicon.ico — browsers accept a 32×32 PNG with the .ico extension
  await sharp(Buffer.from(iconSvg(32))).png().toFile(join(DOCS, 'favicon.ico'));
  console.log('  favicon.ico');

  // OG image
  await sharp(Buffer.from(ogSvg())).png().toFile(join(DOCS, 'og-image.png'));
  console.log('  og-image.png (1200×630)');

  // Twitter/X banner
  await sharp(Buffer.from(twitterBannerSvg())).png().toFile(join(DOCS, 'twitter-banner.png'));
  console.log('  twitter-banner.png (1500×500)');

  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
