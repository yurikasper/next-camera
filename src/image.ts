import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { glyph, GLYPH_HEIGHT, GLYPH_WIDTH, textWidth } from "./font";

export interface Image {
    width: number;
    height: number;
    /** RGBA, 4 bytes per pixel */
    data: Uint8Array;
}

export type Color = [number, number, number];

export function decodePng(buffer: Buffer): Image {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(image: Image): Buffer {
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    return PNG.sync.write(png, { deflateLevel: 6 });
}

export function createImage(width: number, height: number, color: Color): Image {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        data[i + 3] = 255;
    }
    return { width, height, data };
}

// Area outside a screenshot (when the other one is bigger) is drawn as light diagonal stripes
function voidColor(x: number, y: number): Color {
    return ((x + y) >> 3) & 1 ? [228, 228, 231] : [244, 244, 245];
}

function padTo(image: Image, width: number, height: number): Image {
    if (image.width === width && image.height === height) return image;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (x < image.width && y < image.height) {
                const j = (y * image.width + x) * 4;
                data[i] = image.data[j];
                data[i + 1] = image.data[j + 1];
                data[i + 2] = image.data[j + 2];
                data[i + 3] = image.data[j + 3];
            } else {
                const [r, g, b] = voidColor(x, y);
                data[i] = r;
                data[i + 1] = g;
                data[i + 2] = b;
                data[i + 3] = 255;
            }
        }
    }
    return { width, height, data };
}

export function blit(src: Image, dst: Image, sx: number, sy: number, w: number, h: number, dx: number, dy: number) {
    for (let y = 0; y < h; y++) {
        const srcRow = sy + y;
        const dstRow = dy + y;
        if (srcRow < 0 || srcRow >= src.height || dstRow < 0 || dstRow >= dst.height) continue;
        const x0 = Math.max(0, -sx, -dx);
        const x1 = Math.min(w, src.width - sx, dst.width - dx);
        if (x1 <= x0) continue;
        const from = (srcRow * src.width + sx + x0) * 4;
        dst.data.set(src.data.subarray(from, from + (x1 - x0) * 4), (dstRow * dst.width + dx + x0) * 4);
    }
}

export function fillRect(image: Image, x: number, y: number, w: number, h: number, color: Color) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(image.width, x + w);
    const y1 = Math.min(image.height, y + h);
    for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
            const i = (py * image.width + px) * 4;
            image.data[i] = color[0];
            image.data[i + 1] = color[1];
            image.data[i + 2] = color[2];
            image.data[i + 3] = 255;
        }
    }
}

export function strokeRect(image: Image, x: number, y: number, w: number, h: number, thickness: number, color: Color) {
    fillRect(image, x, y, w, thickness, color);
    fillRect(image, x, y + h - thickness, w, thickness, color);
    fillRect(image, x, y, thickness, h, color);
    fillRect(image, x + w - thickness, y, thickness, h, color);
}

export function drawText(image: Image, text: string, x: number, y: number, scale: number, color: Color) {
    let cursor = x;
    for (const char of text) {
        const bits = glyph(char);
        for (let row = 0; row < GLYPH_HEIGHT; row++) {
            for (let col = 0; col < GLYPH_WIDTH; col++) {
                if (bits[row * GLYPH_WIDTH + col] === "#") {
                    fillRect(image, cursor + col * scale, y + row * scale, scale, scale, color);
                }
            }
        }
        cursor += (GLYPH_WIDTH + 1) * scale;
    }
}

// ---------- Diffing ----------

export interface Diff {
    width: number;
    height: number;
    base: Image;
    head: Image;
    /** 1 byte per pixel, 1 = different */
    mask: Uint8Array;
    diffPixels: number;
    baseSize: { width: number; height: number };
    headSize: { width: number; height: number };
}

export function diffScreenshots(basePng: Buffer, headPng: Buffer, threshold: number): Diff {
    const a = decodePng(basePng);
    const b = decodePng(headPng);
    const width = Math.max(a.width, b.width);
    const height = Math.max(a.height, b.height);
    const base = padTo(a, width, height);
    const head = padTo(b, width, height);
    const mask = new Uint8Array(width * height);
    let diffPixels = 0;

    if (!basePng.equals(headPng)) {
        const output = new Uint8Array(width * height * 4);
        pixelmatch(base.data, head.data, output, width, height, { threshold, includeAA: false, diffMask: true });
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                // Area that only exists in one screenshot always counts as changed
                const outside = x >= a.width || y >= a.height || x >= b.width || y >= b.height;
                if (outside || output[i * 4 + 3] > 0) {
                    mask[i] = 1;
                    diffPixels++;
                }
            }
        }
    }
    return {
        width,
        height,
        base,
        head,
        mask,
        diffPixels,
        baseSize: { width: a.width, height: a.height },
        headSize: { width: b.width, height: b.height },
    };
}

export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
    pixels: number;
}

/**
 * Group changed pixels into rectangular regions. Pixels closer than `gap` px end up in the same
 * region. If that yields more than maxRegions, the gap is doubled until it doesn't.
 */
export function findRegions(mask: Uint8Array, width: number, height: number, maxRegions = 8, gap = 32): Region[] {
    const cell = 8;
    const gw = Math.ceil(width / cell);
    const gh = Math.ceil(height / cell);
    const grid = new Uint32Array(gw * gh);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        const gridRow = ((y / cell) | 0) * gw;
        for (let x = 0; x < width; x++) {
            if (mask[row + x]) grid[gridRow + ((x / cell) | 0)]++;
        }
    }

    let regions: Region[] = [];
    for (let currentGap = gap; ; currentGap *= 2) {
        // Changes that would show up in overlapping crops are reported as one region
        regions = mergeWhere(groupCells(grid, gw, gh, cell, Math.ceil(currentGap / cell), width, height), (region) =>
            contextRect(region, width, height)
        );
        if (regions.length <= maxRegions || currentGap > Math.max(width, height)) break;
    }
    return regions.map((region) => tighten(region, mask, width)).sort((a, b) => a.y - b.y || a.x - b.x);
}

const MIN_CROP_WIDTH = 640;
const MIN_CROP_HEIGHT = 160;
const CROP_MARGIN = 24;

type Rect = { x: number; y: number; width: number; height: number };

/** Area shown around a region: at least MIN_CROP size so small changes keep their surroundings */
export function contextRect(region: Rect, width: number, height: number): Rect {
    const w = Math.min(width, Math.max(region.width + CROP_MARGIN * 2, MIN_CROP_WIDTH));
    const h = Math.min(height, Math.max(region.height + CROP_MARGIN * 2, MIN_CROP_HEIGHT));
    const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
    return {
        x: clamp(Math.round(region.x + region.width / 2 - w / 2), width - w),
        y: clamp(Math.round(region.y + region.height / 2 - h / 2), height - h),
        width: w,
        height: h,
    };
}

function groupCells(grid: Uint32Array, gw: number, gh: number, cell: number, reach: number, width: number, height: number): Region[] {
    const label = new Int32Array(gw * gh).fill(-1);
    const boxes: Region[] = [];
    const queue: number[] = [];
    for (let start = 0; start < grid.length; start++) {
        if (!grid[start] || label[start] !== -1) continue;
        const id = boxes.length;
        const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, pixels: 0 };
        label[start] = id;
        queue.push(start);
        while (queue.length) {
            const current = queue.pop()!;
            const cx = current % gw;
            const cy = (current / gw) | 0;
            box.x0 = Math.min(box.x0, cx);
            box.y0 = Math.min(box.y0, cy);
            box.x1 = Math.max(box.x1, cx);
            box.y1 = Math.max(box.y1, cy);
            box.pixels += grid[current];
            for (let ny = Math.max(0, cy - reach); ny <= Math.min(gh - 1, cy + reach); ny++) {
                for (let nx = Math.max(0, cx - reach); nx <= Math.min(gw - 1, cx + reach); nx++) {
                    const neighbor = ny * gw + nx;
                    if (grid[neighbor] && label[neighbor] === -1) {
                        label[neighbor] = id;
                        queue.push(neighbor);
                    }
                }
            }
        }
        boxes.push({
            x: box.x0 * cell,
            y: box.y0 * cell,
            width: Math.min(width, (box.x1 + 1) * cell) - box.x0 * cell,
            height: Math.min(height, (box.y1 + 1) * cell) - box.y0 * cell,
            pixels: box.pixels,
        });
    }
    return mergeWhere(boxes, (box) => box);
}

function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// Merge regions until no two of them have overlapping `area(region)` rectangles
function mergeWhere(regions: Region[], area: (region: Region) => Rect): Region[] {
    let merged = true;
    while (merged) {
        merged = false;
        outer: for (let i = 0; i < regions.length; i++) {
            for (let j = i + 1; j < regions.length; j++) {
                const a = regions[i];
                const b = regions[j];
                if (overlaps(area(a), area(b))) {
                    const x = Math.min(a.x, b.x);
                    const y = Math.min(a.y, b.y);
                    regions[i] = {
                        x,
                        y,
                        width: Math.max(a.x + a.width, b.x + b.width) - x,
                        height: Math.max(a.y + a.height, b.y + b.height) - y,
                        pixels: a.pixels + b.pixels,
                    };
                    regions.splice(j, 1);
                    merged = true;
                    break outer;
                }
            }
        }
    }
    return regions;
}

// Shrink a cell-aligned box to the exact changed pixels inside it
function tighten(region: Region, mask: Uint8Array, width: number): Region {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
            if (!mask[y * width + x]) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) return region;
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: region.pixels };
}

// ---------- Rendering ----------

const DIFF_RED: Color = [229, 20, 20];
const REGION_COLOR: Color = [217, 70, 239];
const BACKGROUND: Color = [241, 241, 243];
const BORDER: Color = [205, 205, 212];
const WHITE: Color = [255, 255, 255];

// Head screenshot faded to a pale grayscale with changed pixels in red
function highlight(diff: Diff, x0: number, y0: number, w: number, h: number): Image {
    const image = createImage(w, h, WHITE);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const sx = x0 + x;
            const sy = y0 + y;
            const o = (y * w + x) * 4;
            if (sx >= diff.width || sy >= diff.height) continue;
            const i = sy * diff.width + sx;
            if (diff.mask[i]) {
                image.data[o] = DIFF_RED[0];
                image.data[o + 1] = DIFF_RED[1];
                image.data[o + 2] = DIFF_RED[2];
            } else {
                const p = i * 4;
                const luma = 0.299 * diff.head.data[p] + 0.587 * diff.head.data[p + 1] + 0.114 * diff.head.data[p + 2];
                const value = 255 + (luma - 255) * 0.25;
                image.data[o] = image.data[o + 1] = image.data[o + 2] = value;
            }
        }
    }
    return image;
}

function drawBadge(image: Image, text: string, x: number, y: number, background: Color) {
    const scale = 2;
    const padding = 4;
    const w = textWidth(text, scale) + padding * 2;
    const h = GLYPH_HEIGHT * scale + padding * 2;
    fillRect(image, x, y, w, h, background);
    drawText(image, text, x + padding, y + padding, scale, WHITE);
    return { width: w, height: h };
}

export function renderOverview(diff: Diff, regions: Region[]): Image {
    const image = highlight(diff, 0, 0, diff.width, diff.height);
    regions.forEach((region, index) => {
        const pad = 4;
        strokeRect(image, region.x - pad, region.y - pad, region.width + pad * 2, region.height + pad * 2, 2, REGION_COLOR);
        const label = String(index + 1);
        const badgeHeight = GLYPH_HEIGHT * 2 + 8;
        const above = region.y - pad - badgeHeight;
        drawBadge(image, label, Math.max(0, region.x - pad), above >= 0 ? above : region.y + region.height + pad, REGION_COLOR);
    });
    return image;
}

const LABEL_HEIGHT = 22;
const GAP = 10;
const OUTER = 8;
const MAX_PANEL_HEIGHT = 1600;

export interface RegionImage {
    image: Image;
    crop: { x: number; y: number; width: number; height: number };
    truncated: boolean;
}

/** BEFORE / AFTER / DIFF panels for one region, laid out side by side or stacked, whichever is squarer */
export function renderRegion(diff: Diff, region: Region): RegionImage {
    const crop = contextRect(region, diff.width, diff.height);
    // Very tall regions (e.g. everything below an inserted element moved) start at the change and get cut off
    const truncated = crop.height > MAX_PANEL_HEIGHT;
    if (truncated) {
        crop.y = Math.max(0, region.y - CROP_MARGIN);
        crop.height = Math.min(MAX_PANEL_HEIGHT, diff.height - crop.y);
    }
    const { x: x0, y: y0, width: cw, height: ch } = crop;

    const panels: { label: string; color: Color; image: Image; sx: number; sy: number }[] = [
        { label: "BEFORE", color: [82, 82, 91], image: diff.base, sx: x0, sy: y0 },
        { label: "AFTER", color: [37, 99, 235], image: diff.head, sx: x0, sy: y0 },
        { label: "DIFF", color: [220, 38, 38], image: highlight(diff, x0, y0, cw, ch), sx: 0, sy: 0 },
    ];

    const panelWidth = Math.max(cw + 2, textWidth("BEFORE", 2) + 12);
    const panelHeight = LABEL_HEIGHT + ch + 2;
    const horizontal = { width: OUTER * 2 + panelWidth * 3 + GAP * 2, height: OUTER * 2 + panelHeight };
    const vertical = { width: OUTER * 2 + panelWidth, height: OUTER * 2 + panelHeight * 3 + GAP * 2 };
    const squareness = (size: { width: number; height: number }) => Math.abs(Math.log(size.width / size.height / 1.3));
    const useHorizontal = squareness(horizontal) <= squareness(vertical);
    const size = useHorizontal ? horizontal : vertical;

    const image = createImage(size.width, size.height, BACKGROUND);
    panels.forEach((panel, index) => {
        const px = OUTER + (useHorizontal ? index * (panelWidth + GAP) : 0);
        const py = OUTER + (useHorizontal ? 0 : index * (panelHeight + GAP));
        fillRect(image, px, py, panelWidth, LABEL_HEIGHT, panel.color);
        drawText(image, panel.label, px + 6, py + 4, 2, WHITE);
        strokeRect(image, px, py + LABEL_HEIGHT, cw + 2, ch + 2, 1, BORDER);
        blit(panel.image, image, panel.sx, panel.sy, cw, ch, px + 1, py + LABEL_HEIGHT + 1);
    });
    return { image, crop: { x: x0, y: y0, width: cw, height: ch }, truncated };
}
