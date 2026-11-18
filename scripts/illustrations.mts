/**
 * Brings unDraw illustrations into Rallied, recoloured for its dark screens:
 * unDraw's purple accent becomes Rallied's ice blue, dark outlines turn
 * light, light fills turn into the dark surfaces they sit on. Skin and hair
 * tones stay as drawn.
 *
 *   pnpm illustrations <folder of unDraw SVGs>
 *
 * Writes public/illustrations/<name>.svg for each entry in SCENES below, and
 * stops (writing nothing) if an SVG holds a script or a colour the map
 * doesn't cover, so nothing lands half-recoloured. To add a scene: download
 * it from undraw.co (free, no attribution needed), add it to SCENES, rerun.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Rallied name -> unDraw file. Named by the moment, so the code reads as what it shows. */
const SCENES: Record<string, string> = {
  "no-groups": "nobody-home_znfu.svg",
  "no-votes": "empty-mailbox_ef0e.svg",
  "no-transactions": "empty-wallet_j0kn.svg",
  "no-proposals": "bright-ideas_z7u9.svg",
  "no-rule-changes": "guidelines_p5r7.svg",
  "no-role-changes": "team-permissions_1lrk.svg",
  "not-on-base": "invite-only_373f.svg",
  "sent-to-vote": "message-sent_iyz6.svg",
  "dues-paid": "adding-funds_gpjb.svg",
  "all-set": "completed_vjc6.svg",
};

/** unDraw's palette -> Rallied's (globals.css tokens). Lowercase hex; 3-digit forms are expanded first. */
const PALETTE: Record<string, string> = {
  "#6c63ff": "#a5c8ff", // the accent -> ice blue
  "#3f3d56": "#a1a1aa", // dark outlines -> ink-muted
  "#2f2e41": "#d4d4d8", // near-black -> light
  "#090814": "#d4d4d8",
  "#000000": "#d4d4d8",
  "#e6e6e6": "#303036", // light fills -> overlay
  "#f2f2f2": "#26262b", // lighter fills -> raised
  "#ebebeb": "#303036",
  "#e4e4e4": "#303036",
  "#cacaca": "#42424a",
  "#cccccc": "#42424a",
  "#d6d6e3": "#42424a",
  "#ffffff": "#1e1e22", // white -> the card's surface
  "#fafafa": "#26262b",
  "#f8f8f8": "#26262b",
  "#514e7f": "#7fa9f5", // the accent's shadow -> accent-deep
  "#464353": "#6b6b74", // dark shapes that must stay visible on dark -> mid greys
  "#33323d": "#52525b",
  "#8f8f98": "#6b6b74",
};
/** Skin, hair and small details: kept as drawn. */
const KEEP = new Set(["#ffb6b6", "#ffb8b8", "#a0616a", "#ed9da0", "#f2a7aa", "#9e616a", "#ffb7b7", "#ffb9b9", "#ffd0d0", "#feb8b8", "#9f616a"]);

const source = process.argv[2];
if (!source) {
  console.error("Usage: pnpm illustrations <folder of unDraw SVGs>");
  process.exit(1);
}

const outDir = join(process.cwd(), "public", "illustrations");
const results: [string, string][] = [];
const unknown = new Set<string>();

for (const [name, file] of Object.entries(SCENES)) {
  let svg = readFileSync(join(source, file), "utf8");
  if (/<script|on[a-z]+\s*=|javascript:/i.test(svg)) throw new Error(`${file} holds script; not using it`);
  // 3-digit hex -> 6-digit, lowercase, so one map covers every spelling.
  svg = svg.replace(/#([0-9a-fA-F]{3})(?![0-9a-fA-F])/g, (_, h: string) => `#${h.split("").map((c) => c + c).join("")}`.toLowerCase());
  svg = svg.replace(/#[0-9a-fA-F]{6}/g, (hex) => hex.toLowerCase());
  for (const hex of new Set(svg.match(/#[0-9a-f]{6}/g) ?? [])) {
    if (!(hex in PALETTE) && !KEEP.has(hex)) unknown.add(`${hex} (in ${file})`);
  }
  // Placeholders first, so a swapped colour is never swapped again.
  const keys = Object.keys(PALETTE);
  keys.forEach((hex, i) => (svg = svg.split(hex).join(`@@${i}@@`)));
  keys.forEach((hex, i) => (svg = svg.split(`@@${i}@@`).join(PALETTE[hex])));
  // No fixed size: the page sizes it.
  svg = svg.replace(/<svg([^>]*?)\swidth="[^"]*"/, "<svg$1").replace(/<svg([^>]*?)\sheight="[^"]*"/, "<svg$1");
  results.push([name, svg]);
}

if (unknown.size > 0) {
  console.error("Colours the palette doesn't cover yet (add each to PALETTE or KEEP, then rerun):");
  for (const line of unknown) console.error("  " + line);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const [name, svg] of results) writeFileSync(join(outDir, `${name}.svg`), svg);
console.log(`Wrote ${results.length} illustrations to public/illustrations`);
