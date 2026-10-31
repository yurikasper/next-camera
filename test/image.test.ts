import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyph } from "../src/font";
import {
    contextRect,
    createImage,
    decodePng,
    diffScreenshots,
    encodePng,
    fillRect,
    findRegions,
    renderOverview,
    renderRegion,
    type Color,
} from "../src/image";

function page(width: number, height: number, boxes: { x: number; y: number; w: number; h: number; color: Color }[]): Buffer {
    const image = createImage(width, height, [255, 255, 255]);
    for (const box of boxes) fillRect(image, box.x, box.y, box.w, box.h, box.color);
    return encodePng(image);
}

describe("diff", () => {
    test("identical screenshots have no changes", () => {
        const png = page(200, 100, [{ x: 10, y: 10, w: 50, h: 20, color: [0, 0, 255] }]);
        const diff = diffScreenshots(png, png, 0.1);
        expect(diff.diffPixels).toBe(0);
        expect(findRegions(diff.mask, diff.width, diff.height)).toEqual([]);
    });

    test("separate changes become separate regions", () => {
        const base = page(1600, 1200, [
            { x: 10, y: 10, w: 40, h: 20, color: [0, 0, 255] },
            { x: 1400, y: 1000, w: 30, h: 30, color: [0, 128, 0] },
        ]);
        const head = page(1600, 1200, [
            { x: 10, y: 10, w: 40, h: 20, color: [255, 0, 0] },
            { x: 1400, y: 1000, w: 30, h: 30, color: [255, 160, 0] },
        ]);
        const diff = diffScreenshots(base, head, 0.1);
        expect(diff.diffPixels).toBe(40 * 20 + 30 * 30);
        const regions = findRegions(diff.mask, diff.width, diff.height);
        expect(regions.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
            { x: 10, y: 10, width: 40, height: 20 },
            { x: 1400, y: 1000, width: 30, height: 30 },
        ]);
    });

    test("changes that would appear in the same crop are merged into one region", () => {
        // Two fragments of one change on the same row (e.g. both edges of a button that got wider)
        const sameRow = diffScreenshots(
            page(1280, 800, []),
            page(1280, 800, [
                { x: 490, y: 440, w: 190, h: 40, color: [0, 0, 0] },
                { x: 770, y: 440, w: 20, h: 40, color: [0, 0, 0] },
            ]),
            0.1
        );
        expect(findRegions(sameRow.mask, sameRow.width, sameRow.height)).toEqual([
            { x: 490, y: 440, width: 300, height: 40, pixels: 190 * 40 + 20 * 40 },
        ]);
        // Far apart vertically: separate regions
        const apart = diffScreenshots(
            page(1280, 1200, []),
            page(1280, 1200, [
                { x: 100, y: 100, w: 50, h: 20, color: [0, 0, 0] },
                { x: 100, y: 900, w: 50, h: 20, color: [0, 0, 0] },
            ]),
            0.1
        );
        expect(findRegions(apart.mask, apart.width, apart.height)).toHaveLength(2);
    });

    test("crops keep surrounding context for small changes", () => {
        expect(contextRect({ x: 600, y: 400, width: 20, height: 10 }, 1280, 800)).toEqual({ x: 290, y: 325, width: 640, height: 160 });
        // Clamped to the page edges
        expect(contextRect({ x: 0, y: 0, width: 20, height: 10 }, 1280, 800)).toEqual({ x: 0, y: 0, width: 640, height: 160 });
        expect(contextRect({ x: 10, y: 10, width: 20, height: 10 }, 390, 100)).toEqual({ x: 0, y: 0, width: 390, height: 100 });
        // Large regions just get a margin
        expect(contextRect({ x: 100, y: 100, width: 800, height: 300 }, 1280, 800)).toEqual({ x: 76, y: 76, width: 848, height: 348 });
    });

    test("nearby changes are merged and the region count is capped", () => {
        const boxes = Array.from({ length: 20 }, (_, i) => ({ x: 10 + i * 60, y: 10, w: 10, h: 10, color: [0, 0, 0] as Color }));
        const diff = diffScreenshots(page(1300, 100, []), page(1300, 100, boxes), 0.1);
        const regions = findRegions(diff.mask, diff.width, diff.height, 8);
        expect(regions.length).toBeLessThanOrEqual(8);
        expect(regions.reduce((sum, region) => sum + region.pixels, 0)).toBe(20 * 100);
    });

    test("a taller page counts the extra area as changed", () => {
        const diff = diffScreenshots(page(100, 100, []), page(100, 150, []), 0.1);
        expect(diff.width).toBe(100);
        expect(diff.height).toBe(150);
        expect(diff.diffPixels).toBe(100 * 50);
        expect(diff.baseSize).toEqual({ width: 100, height: 100 });
        expect(diff.headSize).toEqual({ width: 100, height: 150 });
    });

    test("renders overview and region panels", () => {
        const base = page(600, 400, [{ x: 100, y: 100, w: 80, h: 30, color: [0, 0, 255] }]);
        const head = page(600, 400, [{ x: 100, y: 100, w: 120, h: 30, color: [0, 0, 255] }]);
        const diff = diffScreenshots(base, head, 0.1);
        const regions = findRegions(diff.mask, diff.width, diff.height);
        expect(regions).toHaveLength(1);
        const overview = decodePng(encodePng(renderOverview(diff, regions)));
        expect(overview.width).toBe(600);
        expect(overview.height).toBe(400);
        const { image, crop, truncated } = renderRegion(diff, regions[0]);
        expect(crop).toEqual({ x: 0, y: 35, width: 600, height: 160 });
        expect(truncated).toBe(false);
        // Wide crop: the three panels (label + bordered crop) are stacked
        expect(image.width).toBe(8 * 2 + 602);
        expect(image.height).toBe(8 * 2 + (22 + 162) * 3 + 10 * 2);
        expect(() => PNG.sync.read(encodePng(image))).not.toThrow();
    });

    test("very tall regions start at the change and are cut off", () => {
        const diff = diffScreenshots(page(800, 4000, []), page(800, 4000, [{ x: 0, y: 500, w: 800, h: 3000, color: [0, 0, 0] }]), 0.1);
        const [region] = findRegions(diff.mask, diff.width, diff.height);
        const { crop, truncated } = renderRegion(diff, region);
        expect(truncated).toBe(true);
        expect(crop).toEqual({ x: 0, y: 476, width: 800, height: 1600 });
    });
});

describe("font", () => {
    test("every glyph is 5x7", () => {
        for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.#():/%") {
            expect(glyph(char)).toHaveLength(GLYPH_WIDTH * GLYPH_HEIGHT);
        }
    });
});
