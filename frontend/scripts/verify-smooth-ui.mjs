#!/usr/bin/env node
/**
 * verify-smooth-ui.mjs — mechanical conformance check for the smooth-ui skill.
 *
 *   node verify-smooth-ui.mjs [path-to-src]   (default: ./src)
 *   node verify-smooth-ui.mjs src --json
 *
 * Exit 0 = no errors (warnings allowed). Exit 1 = at least one error.
 * Zero dependencies. Heuristic by design: it catches the mechanical tells,
 * not taste. A clean run does not mean the layout is right.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, basename } from 'node:path';

const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'src';
const asJson = process.argv.includes('--json');

const EXT = new Set(['.css', '.scss', '.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.html', '.astro']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage', '.turbo', 'vendor']);
/** Files that legitimately define the system and are exempt from most rules. */
const TOKEN_FILE = /(^|[\\/])(tokens|patterns|primitives)\.(css|scss)$/;

if (!existsSync(root)) {
  console.error(`smooth-ui: path not found: ${root}`);
  process.exit(1);
}

/* ── collect files ──────────────────────────────────────────────────── */
const files = [];
(function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p);
    else if (EXT.has(extname(p))) files.push(p);
  }
})(root);

const findings = [];
const add = (level, rule, file, line, text, hint) =>
  findings.push({ level, rule, file: relative(process.cwd(), file), line, text: text.trim().slice(0, 120), hint });

/* ── per-line rules ─────────────────────────────────────────────────── */
const RULES = [
  {
    rule: 'gradient',
    level: 'error',
    re: /(linear|radial|conic)-gradient\s*\(/,
    skip: (l, f) => {
      if (TOKEN_FILE.test(f)) return true;
      if (/brand-card|--card-brand|skeleton/.test(l)) return true;
      // Allowed: chart area fills at <=10% alpha. Check alpha INSIDE the
      // gradient call only — an unrelated rgba() elsewhere on the line
      // must not excuse the gradient.
      const call = l.match(/(?:linear|radial|conic)-gradient\s*\([^)]*(?:\([^)]*\)[^)]*)*\)/);
      if (!call) return false;
      const alphas = [...call[0].matchAll(/rgba?\([^)]*?,\s*(0?\.\d+)\s*\)/g)].map((m) => +m[1]);
      return alphas.length > 0 && alphas.every((a) => a <= 0.1);
    },
    hint: 'Flat matte surfaces only. Allowed: the brand-tint hover on marketing showcase cards, and <=10% alpha chart area fills.',
  },
  {
    rule: 'backdrop-filter',
    level: 'error',
    re: /backdrop-filter\s*:|backdrop-blur/,
    hint: 'No glassmorphism. Use a solid --surface-* step instead.',
  },
  {
    rule: 'box-shadow',
    level: 'error',
    re: /box-shadow\s*:|boxShadow\s*:|shadow-(sm|md|lg|xl|2xl)\b/,
    skip: (l, f) =>
      TOKEN_FILE.test(f) ||
      /--shadow-overlay|shadow-overlay|box-shadow:\s*none|shadow-none/.test(l) ||
      /overlay|modal|dropdown|popover|tooltip|toast|menu/i.test(l),
    hint: 'Shadows are for overlays only (dropdown, modal, popover, toast). Express elevation with surface steps + hairlines.',
  },
  {
    rule: 'hardcoded-color',
    level: 'error',
    re: /#[0-9a-fA-F]{3,8}\b|(?<!var\()\brgba?\(\s*\d/,
    skip: (l, f) =>
      TOKEN_FILE.test(f) ||
      /^\s*(\/\/|\/\*|\*)/.test(l) ||
      /currentColor|transparent/.test(l) ||
      /data:image\/svg/.test(l),
    hint: 'Every color must be a var(--token). Add it to tokens.css if it is genuinely new.',
  },
  {
    rule: 'slow-motion',
    level: 'error',
    re: /(?:duration|transition[^;:]*)[:=]?\s*["'{\s]*([5-9]\d{2}|[1-9]\d{3,})ms|duration:\s*(0?\.[5-9]|[1-9])\d*\s*[,}]/,
    // A width/progress fill may run up to 700ms; that is the one sanctioned
    // long duration. Look at surrounding lines, since the transition and the
    // animated property are usually on different lines.
    skip: (l, f, ctx) => /marquee|progress|skeleton|infinite|spin|width|bar\b/i.test(ctx),
    hint: 'UI motion is 150/200/300ms with a 450ms reveal tier. Longer reads as sluggish.',
  },
  {
    rule: 'off-scale-radius',
    level: 'warn',
    re: /\brounded-(sm|md|lg|xl|2xl|3xl)\b|border-radius:\s*(?!var\()[\d.]+(px|rem)/,
    skip: (l, f) => TOKEN_FILE.test(f),
    hint: 'Use the nested radius hierarchy: shell 40 > panel 20 > card 13 > chip 10 > ctl 6 > pill. Inner radius must be smaller than its container.',
  },
  {
    rule: 'transition-all',
    level: 'warn',
    re: /transition:\s*all\b|\btransition-all\b/,
    hint: 'Name the properties. `all` animates layout properties by accident and causes jank.',
  },
  {
    rule: 'outline-none',
    level: 'error',
    re: /outline:\s*none|\boutline-none\b/,
    skip: (l, f, ctx) => /focus-visible|focus:ring|focus:border|focus:shadow|box-shadow|boxShadow|outline:\s*2px/.test(ctx),
    hint: 'Never remove focus without replacing it. Pair with a :focus-visible ring.',
  },
  {
    rule: 'loose-density',
    level: 'warn',
    re: /text-\[(1[5-9]|[2-9]\d)px\]|font-size:\s*(1[5-9]|[2-9]\d)px|\btext-(xl|2xl|3xl|4xl|5xl)\b/,
    skip: (l, f) =>
      TOKEN_FILE.test(f) ||
      /metric|stat__value|headline|marketing|hero|landing/i.test(l) ||
      /tabular-nums|font-mono/.test(l),
    hint: 'Product UI body is 13px; chrome is 9-11px. 15px+ is for metric numerals or the marketing scale only.',
  },
  {
    rule: 'emoji-icon',
    level: 'warn',
    re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    skip: (l, f) => TOKEN_FILE.test(f) || /^\s*(\/\/|\/\*|\*|#)/.test(l),
    hint: 'No emoji in UI. Use a 16px stroke icon or a mono glyph.',
  },
  {
    rule: 'banned-copy',
    level: 'warn',
    re: /\b(Welcome back|Get started|Lorem ipsum|Card Title|Coming soon|Oops!?|Supercharge|Seamlessly|Powered by)\b/i,
    hint: 'Template microcopy. Say the number and the noun instead — see references/microcopy.md.',
  },
  {
    rule: 'crossfade-route',
    level: 'warn',
    // Only a KEYED child is a view swap. A conditional modal/toast child is
    // correct without mode="wait".
    re: /<AnimatePresence(?![^>]*mode=)/,
    skip: (l, f, ctx) => !/key=\{/.test(ctx),
    hint: 'Route transitions need mode="wait". Cross-fading two screens leaves overlapping ghosts.',
  },
  {
    rule: 'count-up',
    level: 'warn',
    re: /countUp|CountUp|useCountUp|animateValue|odometer/i,
    hint: 'Never animate a numeral counting up. Flash the row background instead.',
  },
  {
    rule: 'bounce-easing',
    level: 'error',
    re: /ease-in\b(?!-out)|cubic-bezier\([^)]*-[0-9.]+[^)]*\)|\bbounce\b|elastic|backOut|anticipate/,
    skip: (l, f) => TOKEN_FILE.test(f) || /ease-in-out/.test(l),
    hint: 'One decel family only. No overshoot, no bounce, no ease-in.',
  },
];

for (const file of files) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (/eslint-disable|smooth-ui-ignore/.test(line)) return;
    // Context window: some rules need the neighbouring lines, because the
    // declaration and its justification often sit apart (a transition on one
    // line, the property it animates on another).
    const ctx = lines.slice(Math.max(0, i - 3), i + 3).join('\n');
    for (const r of RULES) {
      if (!r.re.test(line)) continue;
      if (r.skip && r.skip(line, file, ctx)) continue;
      add(r.level, r.rule, file, i + 1, line, r.hint);
    }
  });
}

/* ── project-wide rules ─────────────────────────────────────────────── */
const all = files.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');

if (!/prefers-reduced-motion/.test(all)) {
  add('error', 'no-reduced-motion', root, 0, '(project)',
    'No prefers-reduced-motion block found. Ship the one in assets/tokens.css.');
}
if (!/focus-visible/.test(all)) {
  add('error', 'no-focus-visible', root, 0, '(project)',
    'No :focus-visible styling found. Every interactive element needs a 2px --accent-bright ring.');
}
if (!files.some((f) => /tokens\.(css|scss)$/.test(basename(f)))) {
  add('error', 'no-tokens', root, 0, '(project)',
    'No tokens.css found. Install assets/tokens.css and import it first (SKILL.md STEP 1).');
}
if (/font-mono|--font-mono/.test(all) && !/tabular-nums/.test(all)) {
  add('warn', 'no-tabular-nums', root, 0, '(project)',
    'Mono font in use but no tabular-nums anywhere. Numerals will reflow as values change.');
}

/* distinct font sizes — the density smell */
const sizes = new Set(
  (all.match(/text-\[[\d.]+px\]|font-size:\s*[\d.]+(px|rem)/g) || [])
    .map((s) => s.replace(/.*?([\d.]+)(px|rem).*/, '$1$2'))
);
if (sizes.size > 8) {
  add('warn', 'type-scale-sprawl', root, 0, `${sizes.size} distinct font sizes`,
    `Found ${sizes.size} font sizes: ${[...sizes].sort().join(', ')}. Target is <=6 (see references/layout.md).`);
}

/* ── report ─────────────────────────────────────────────────────────── */
const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

if (asJson) {
  console.log(JSON.stringify({ scanned: files.length, errors, warns }, null, 2));
  process.exit(errors.length ? 1 : 0);
}

const C = { red: '\x1b[31m', yel: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };
const byRule = (list) => {
  const m = new Map();
  for (const f of list) { if (!m.has(f.rule)) m.set(f.rule, []); m.get(f.rule).push(f); }
  return m;
};

const render = (list, color, heading) => {
  if (!list.length) return;
  console.log(`\n${color}${C.bold}${heading}${C.off}`);
  for (const [rule, items] of byRule(list)) {
    console.log(`\n  ${color}${rule}${C.off} ${C.dim}(${items.length})${C.off}`);
    console.log(`  ${C.dim}${items[0].hint}${C.off}`);
    for (const f of items.slice(0, 8)) {
      console.log(`    ${f.file}:${f.line}  ${C.dim}${f.text}${C.off}`);
    }
    if (items.length > 8) console.log(`    ${C.dim}… and ${items.length - 8} more${C.off}`);
  }
};

console.log(`${C.bold}smooth-ui${C.off} — scanned ${files.length} files in ${root}`);
render(errors, C.red, `${errors.length} error${errors.length === 1 ? '' : 's'}`);
render(warns, C.yel, `${warns.length} warning${warns.length === 1 ? '' : 's'}`);

if (!errors.length && !warns.length) {
  console.log('\n  No mechanical violations found.');
}
console.log(`\n${C.dim}Mechanical checks only. Still verify by hand: tab through for focus rings,
toggle reduced motion, and screenshot at 1440px and 390px.${C.off}\n`);

process.exit(errors.length ? 1 : 0);
