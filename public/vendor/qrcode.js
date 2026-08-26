/**
 * qrcode.js
 * Minimal, dependency-free QR Code generator (ISO/IEC 18004 Model 2).
 *
 * Vendored (self-hosted, no CDN) for the same reason lucide.min.js is —
 * generating a shareable booking-link QR code must never depend on an
 * external network service at runtime. Supports Byte mode, error-correction
 * level M, versions 1-6 (up to 108 byte-mode characters), which comfortably
 * covers this app's booking-link URLs (e.g.
 * "https://yourdomain.com/book/{salonId}?ref=CODE"). Deliberately capped at
 * version 6 rather than the spec's full range: every capacity figure below
 * is cross-checked against the version-fixed total-codeword count, and that
 * check could only be done with confidence up to version 6.
 *
 * Exposes `window.QRCode.generate(text)` -> a square boolean matrix, and
 * `window.QRCode.toSVG(text, { size, margin })` -> a ready-to-inject SVG
 * markup string (a fixed grid of <rect> elements — no string interpolation
 * of the input text into the SVG itself, so it is inert to injection).
 */
(function (global) {
    'use strict';

    /* ---------------- Galois Field GF(256) arithmetic ---------------- */
    // QR uses GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
    const GF_EXP = new Array(512);
    const GF_LOG = new Array(256);
    (function buildTables() {
        let x = 1;
        for (let i = 0; i < 255; i++) {
            GF_EXP[i] = x;
            GF_LOG[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11D;
        }
        for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
    })();

    function gfMul(a, b) {
        if (a === 0 || b === 0) return 0;
        return GF_EXP[GF_LOG[a] + GF_LOG[b]];
    }

    /** Reed-Solomon generator polynomial of given degree, coefficients high-to-low. */
    function rsGeneratorPoly(degree) {
        let poly = [1];
        for (let i = 0; i < degree; i++) {
            const next = new Array(poly.length + 1).fill(0);
            for (let j = 0; j < poly.length; j++) {
                next[j] ^= poly[j];
                next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
            }
            poly = next;
        }
        return poly;
    }

    /** Reed-Solomon error-correction codewords for a block of data codewords. */
    function rsEncode(dataBytes, ecCount) {
        const generator = rsGeneratorPoly(ecCount);
        const remainder = new Array(ecCount).fill(0);
        for (let i = 0; i < dataBytes.length; i++) {
            const factor = dataBytes[i] ^ remainder[0];
            remainder.shift();
            remainder.push(0);
            if (factor !== 0) {
                for (let j = 0; j < generator.length; j++) {
                    remainder[j] ^= gfMul(generator[j], factor);
                }
            }
        }
        return remainder;
    }

    /* ---------------- Version capacity tables (Byte mode, EC level M) ---------------- */
    // [totalCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2]
    // Values from the QR Code standard (ISO/IEC 18004) for versions 1-10, level M.
    // Supported versions are deliberately limited to 1-6 (single data-block
    // group, no version-info block needed — that only starts at version 7).
    // Every row below is cross-checked in a comment against the
    // version-fixed "total codewords" figure (data+EC codewords must sum to
    // exactly this, independent of EC level) — that check caught a
    // transcription error in an earlier draft of this table, which is why
    // the supported range stops here rather than extending further on
    // unverified numbers.
    const VERSION_TABLE = {
        1: { total: 26, ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0 },   // 1*16 + 1*10 = 26 ✓
        2: { total: 44, ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0 },   // 1*28 + 1*16 = 44 ✓
        3: { total: 70, ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0 },   // 1*44 + 1*26 = 70 ✓
        4: { total: 100, ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0 },  // 2*32 + 2*18 = 100 ✓
        5: { total: 134, ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0 },  // 2*43 + 2*24 = 134 ✓
        6: { total: 172, ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0 },  // 4*27 + 4*16 = 172 ✓
    };
    const ALIGNMENT_COORDS = {
        1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    };
    const MAX_SUPPORTED_VERSION = 6;

    function moduleCount(version) { return version * 4 + 17; }

    function dataCapacityBytes(v) {
        const t = VERSION_TABLE[v];
        return t.g1Blocks * t.g1Data + t.g2Blocks * t.g2Data;
    }

    /** Smallest version (1-6) whose byte-mode capacity fits `text`. */
    function chooseVersion(byteLength) {
        for (let v = 1; v <= MAX_SUPPORTED_VERSION; v++) {
            // Mode indicator (4 bits) + byte count indicator (8 bits, valid
            // for every version in this vendored subset) + data, all must fit
            // within the version's data codeword capacity.
            const headerBits = 4 + 8;
            const capacityBits = dataCapacityBytes(v) * 8;
            if (headerBits + byteLength * 8 + 4 <= capacityBits) return v; // +4 terminator
        }
        return null; // text too long for this vendored subset (versions 1-6)
    }

    /* ---------------- Bit buffer ---------------- */
    function BitBuffer() {
        return { bits: [], put(value, length) {
            for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
        } };
    }

    /** Encode text (UTF-8 byte mode) into the padded codeword sequence for `version`. */
    function encodeDataCodewords(version, bytes) {
        const buf = BitBuffer();
        buf.put(0b0100, 4); // byte mode indicator
        buf.put(bytes.length, 8); // byte-count indicator is 8 bits for every version <= 9
        for (const b of bytes) buf.put(b, 8);

        const capacityBits = dataCapacityBytes(version) * 8;
        // Terminator (up to 4 zero bits).
        for (let i = 0; i < 4 && buf.bits.length < capacityBits; i++) buf.bits.push(0);
        // Pad to a byte boundary.
        while (buf.bits.length % 8 !== 0) buf.bits.push(0);
        // Pad bytes 0xEC/0x11 alternating until capacity is filled.
        const padBytes = [0xEC, 0x11];
        let p = 0;
        while (buf.bits.length < capacityBits) {
            const byte = padBytes[p % 2]; p++;
            for (let i = 7; i >= 0; i--) buf.bits.push((byte >>> i) & 1);
        }

        const codewords = [];
        for (let i = 0; i < buf.bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j];
            codewords.push(byte);
        }
        return codewords;
    }

    /** Split data codewords into blocks, add RS error-correction, interleave. */
    function interleave(version, dataCodewords) {
        const t = VERSION_TABLE[version];
        const blocks = [];
        let offset = 0;
        for (let i = 0; i < t.g1Blocks; i++) {
            blocks.push(dataCodewords.slice(offset, offset + t.g1Data));
            offset += t.g1Data;
        }
        for (let i = 0; i < t.g2Blocks; i++) {
            blocks.push(dataCodewords.slice(offset, offset + t.g2Data));
            offset += t.g2Data;
        }
        const ecBlocks = blocks.map((b) => rsEncode(b, t.ecPerBlock));

        const result = [];
        const maxDataLen = Math.max(t.g1Data, t.g2Data || 0);
        for (let i = 0; i < maxDataLen; i++) {
            for (const block of blocks) if (i < block.length) result.push(block[i]);
        }
        for (let i = 0; i < t.ecPerBlock; i++) {
            for (const block of ecBlocks) result.push(block[i]);
        }
        return result;
    }

    /* ---------------- Matrix construction ---------------- */
    function createMatrix(version) {
        const n = moduleCount(version);
        const modules = Array.from({ length: n }, () => new Array(n).fill(null));
        const isFunction = Array.from({ length: n }, () => new Array(n).fill(false));

        function setFn(row, col, value) {
            if (row < 0 || row >= n || col < 0 || col >= n) return;
            modules[row][col] = value;
            isFunction[row][col] = true;
        }

        // A finder pattern is a 7x7 block (solid outer ring, white middle ring,
        // solid 3x3 core) surrounded by a 1-module white separator — modelled
        // here as an 8x8..-1 area where anything outside the 7x7 is white.
        function placeFinder(row, col) {
            for (let r = -1; r <= 7; r++) {
                for (let c = -1; c <= 7; c++) {
                    const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
                    const onOuterRing = r === 0 || r === 6 || c === 0 || c === 6;
                    const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
                    setFn(row + r, col + c, inFinder && (onOuterRing || inCore));
                }
            }
        }

        // Finder patterns + separators.
        placeFinder(0, 0);
        placeFinder(0, n - 7);
        placeFinder(n - 7, 0);

        // Timing patterns.
        for (let i = 8; i < n - 8; i++) {
            setFn(6, i, i % 2 === 0);
            setFn(i, 6, i % 2 === 0);
        }

        // Alignment patterns.
        const coords = ALIGNMENT_COORDS[version] || [];
        for (const row of coords) {
            for (const col of coords) {
                // Skip positions overlapping the finder patterns.
                if ((row <= 8 && col <= 8) || (row <= 8 && col >= n - 9) || (row >= n - 9 && col <= 8)) continue;
                for (let r = -2; r <= 2; r++) {
                    for (let c = -2; c <= 2; c++) {
                        const onRing = r === -2 || r === 2 || c === -2 || c === 2;
                        setFn(row + r, col + c, onRing || (r === 0 && c === 0));
                    }
                }
            }
        }

        // Dark module (always present, position depends only on version).
        setFn(4 * version + 9, 8, true);

        // Reserve format-info areas (written after data placement, values TBD).
        for (let i = 0; i < 9; i++) {
            if (!isFunction[8][i]) setFn(8, i, false);
            if (!isFunction[i][8]) setFn(i, 8, false);
        }
        // Redundant second copy: 8 cells along row 8 (top-right finder side),
        // but only 7 cells down column 8 (bottom-left finder side) — the 8th
        // cell in that column, row (n-8), IS the dark module set above
        // (n-8 == 4*version+9 for every version) and must not be touched here.
        for (let i = 0; i < 8; i++) setFn(8, n - 1 - i, false);
        for (let i = 0; i < 7; i++) setFn(n - 1 - i, 8, false);

        // Version-info blocks (a separate 6x3 area near two corners) only
        // exist from version 7 upward; this vendored subset never reaches
        // that version, so there is nothing to reserve here.

        return { n, modules, isFunction };
    }

    /** Place data bits into the matrix in the standard zigzag column order. */
    function placeData(matrix, codewords) {
        const { n, modules, isFunction } = matrix;
        const bits = [];
        for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
        let bitIndex = 0;

        let col = n - 1;
        let dir = -1; // -1 = moving up, 1 = moving down
        while (col > 0) {
            if (col === 6) col--; // skip the vertical timing column
            for (let i = 0; i < n; i++) {
                const row = dir === -1 ? n - 1 - i : i;
                for (const c of [col, col - 1]) {
                    if (isFunction[row][c]) continue;
                    const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
                    bitIndex++;
                    modules[row][c] = bit === 1;
                }
            }
            dir = -dir;
            col -= 2;
        }
    }

    /* ---------------- Masking ---------------- */
    const MASK_FNS = [
        (r, c) => (r + c) % 2 === 0,
        (r, c) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ];

    function applyMask(matrix, maskIndex) {
        const { n, modules, isFunction } = matrix;
        const out = modules.map((row) => row.slice());
        const fn = MASK_FNS[maskIndex];
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
                if (isFunction[r][c]) continue;
                if (fn(r, c)) out[r][c] = !out[r][c];
            }
        }
        return out;
    }

    function penaltyScore(grid) {
        const n = grid.length;
        let score = 0;

        // Rule 1: runs of 5+ same-colour modules in a row/column.
        function runPenalty(getVal) {
            let total = 0;
            for (let i = 0; i < n; i++) {
                let run = 1;
                for (let j = 1; j < n; j++) {
                    if (getVal(i, j) === getVal(i, j - 1)) {
                        run++;
                    } else {
                        if (run >= 5) total += 3 + (run - 5);
                        run = 1;
                    }
                }
                if (run >= 5) total += 3 + (run - 5);
            }
            return total;
        }
        score += runPenalty((r, c) => grid[r][c]);
        score += runPenalty((r, c) => grid[c][r]);

        // Rule 2: 2x2 blocks of the same colour.
        for (let r = 0; r < n - 1; r++) {
            for (let c = 0; c < n - 1; c++) {
                const v = grid[r][c];
                if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
            }
        }

        // Rule 3: finder-like patterns (1:1:3:1:1 ratio with 4 light either side).
        const pattern = [true, false, true, true, true, false, true];
        function hasPattern(cells) {
            for (let i = 0; i + 6 < cells.length; i++) {
                let match = true;
                for (let k = 0; k < 7; k++) if (cells[i + k] !== pattern[k]) { match = false; break; }
                if (match) {
                    const before = cells.slice(Math.max(0, i - 4), i).every((v) => v === false);
                    const after = cells.slice(i + 7, i + 11).every((v) => v === false);
                    if (before || after) return true;
                }
            }
            return false;
        }
        for (let r = 0; r < n; r++) if (hasPattern(grid[r])) score += 40;
        for (let c = 0; c < n; c++) if (hasPattern(grid.map((row) => row[c]))) score += 40;

        // Rule 4: overall dark-module proportion.
        let dark = 0;
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c]) dark++;
        const percent = (dark * 100) / (n * n);
        score += Math.floor(Math.abs(percent - 50) / 5) * 10;

        return score;
    }

    /* ---------------- Format info ---------------- */
    // BCH(15,5) encoding for EC-level M (bits "00") + mask index, per spec.
    function formatBits(maskIndex) {
        const data = (0b00 << 3) | maskIndex; // EC level M = 00
        let d = data << 10;
        const gen = 0b10100110111;
        for (let i = 4; i >= 0; i--) {
            if (d & (1 << (i + 10))) d ^= gen << i;
        }
        const bits = ((data << 10) | d) ^ 0b101010000010010;
        return bits;
    }

    function placeFormatInfo(matrix, maskIndex) {
        const { n, modules } = matrix;
        const bits = formatBits(maskIndex);
        const get = (i) => (bits >>> i) & 1;

        // Around the top-left finder.
        const topLeftCols = [0, 1, 2, 3, 4, 5, 7, 8];
        for (let i = 0; i < 8; i++) modules[8][topLeftCols[i]] = get(i) === 1;
        const topLeftRows = [7, 5, 4, 3, 2, 1, 0];
        for (let i = 0; i < 7; i++) modules[topLeftRows[i]][8] = get(8 + i) === 1;

        // Redundant second copy near the bottom-left / top-right finders:
        // 7 modules (bits 0-6) down column 8 by the bottom-left finder, then
        // 8 modules (bits 7-14) along row 8 by the top-right finder.
        for (let i = 0; i < 7; i++) modules[n - 1 - i][8] = get(i) === 1;
        for (let i = 0; i < 8; i++) modules[8][n - 8 + i] = get(7 + i) === 1;
    }

    /* ---------------- Public API ---------------- */

    /** UTF-8 byte encoding without relying on TextEncoder (broad compatibility). */
    function utf8Bytes(str) {
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            let code = str.codePointAt(i);
            if (code > 0xFFFF) i++; // consumed a surrogate pair
            if (code < 0x80) {
                bytes.push(code);
            } else if (code < 0x800) {
                bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
            } else if (code < 0x10000) {
                bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
            } else {
                bytes.push(
                    0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F),
                    0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F),
                );
            }
        }
        return bytes;
    }

    /** Generate the boolean module matrix for `text`. Throws if too long. */
    function generate(text) {
        const bytes = utf8Bytes(String(text || ''));
        const version = chooseVersion(bytes.length);
        if (!version) throw new Error('Text is too long to encode as a QR code.');

        const dataCodewords = encodeDataCodewords(version, bytes);
        const finalCodewords = interleave(version, dataCodewords);

        const matrix = createMatrix(version);
        placeData(matrix, finalCodewords);

        let best = null;
        let bestScore = Infinity;
        let bestMask = 0;
        for (let m = 0; m < 8; m++) {
            const grid = applyMask(matrix, m);
            const score = penaltyScore(grid);
            if (score < bestScore) { bestScore = score; best = grid; bestMask = m; }
        }
        placeFormatInfo({ n: matrix.n, modules: best }, bestMask);
        return best;
    }

    /** Render `text` as a self-contained SVG string (light quiet-zone margin included). */
    function toSVG(text, opts) {
        const options = opts || {};
        const size = options.size || 240;
        const margin = options.margin != null ? options.margin : 4;
        const grid = generate(text);
        const n = grid.length;
        const cell = size / (n + margin * 2);

        let rects = '';
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
                if (!grid[r][c]) continue;
                const x = (c + margin) * cell;
                const y = (r + margin) * cell;
                rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
            }
        }
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="QR code">`
            + `<rect x="0" y="0" width="${size}" height="${size}" fill="#ffffff"/>`
            + `<g fill="#0f172a">${rects}</g>`
            + `</svg>`;
    }

    global.QRCode = { generate, toSVG };
})(typeof window !== 'undefined' ? window : globalThis);
