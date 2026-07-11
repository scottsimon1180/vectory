/* fileName: path-finder.js */

// Pathfinder (Illustrator-style shape modes): Unite / Minus Front / Intersect / Exclude.
//
// The four buttons live in the Properties panel (#propsPathfinderGroup, below the align row) and
// act on the canvas multi-selection (editSelectedIndices, 2+ eligible vector objects). Each op
// runs a true curve (cubic Bezier) boolean -- curves stay curves, no flattening -- and replaces
// the selected shapes with ONE result <path> written in root (viewBox) space:
//
//   unite        A + B + ...                     result styled like the TOPMOST object
//   minus-front  back - (union of all fronts)    result styled like the BACKMOST object
//   intersect    A ^ B ^ ...                     result styled like the TOPMOST object
//   exclude      symmetric difference (XOR)      result styled like the TOPMOST object
//
// The result path sits at the style donor's z-position, keeps its label/id/paint attributes, and
// becomes the new selection. An empty result (e.g. Intersect on disjoint shapes) CANCELS the op
// (originals untouched, Illustrator-style). Raster <image> layers are never eligible; open paths
// and polylines are implicitly closed; zero-area geometry (bare lines) contributes nothing.
//
// Engine outline (self-contained; no DOM reads during the math):
//   1. Each shape -> closed loops of cubic segments in root space (arcs/quads -> cubics), then
//      normalized to a canonical nonzero region: sliver/redundant loops dropped, loop orientation
//      fixed by containment-depth parity (this also resolves fill-rule="evenodd" compound paths).
//   2. Binary boolean core: all A-segment x B-segment intersections (analytic for lines, clipped
//      subdivision + Newton for curves, with coincident-overlap detection), segments split at the
//      hits, every fragment classified by the OTHER region's winding number at its midpoint, kept
//      or discarded (or reversed) per op, then chained into closed loops through shared vertices.
//   3. n-ary ops fold the binary core; the final region serializes to one absolute M/L/C/Z path.
// Known limits (documented in docs/pathfinder.md): individual input paths are assumed not to
// self-cross; exotic tangencies are handled by sample-retry heuristics.

(function () {
    'use strict';

    const PF_SVGNS = 'http://www.w3.org/2000/svg';
    const PF_KAPPA = 0.5522847498307936;                    // quarter-arc cubic constant
    const PF_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
    // Attributes NOT copied from the style donor onto the result path (geometry, transform --
    // the result's coordinates are already in root space -- and the per-shape index/fill-rule).
    const PF_SKIP_ATTRS = new Set(['d', 'points', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy',
        'r', 'x1', 'y1', 'x2', 'y2', 'pathLength', 'fill-rule', 'transform', 'data-pf-index']);
    // Fragment-midpoint sample params: winding is evaluated at t=0.5 first and walks outward when
    // a sample lands on a numeric hazard (ray through a vertex / tangent graze).
    const PF_T_SAMPLES = [0.5, 0.371, 0.637, 0.253, 0.751, 0.11, 0.89];

    /* ---- Cubic segment primitives --------------------------------------------------------- */
    // A segment is one cubic Bezier {x0,y0 .. x3,y3}. line:true means the control points sit at
    // the thirds of the chord (kept exact through splits/affine maps) so it serializes back to L.

    const seg = (x0, y0, x1, y1, x2, y2, x3, y3, line) => ({ x0, y0, x1, y1, x2, y2, x3, y3, line: !!line });
    const segLine = (x0, y0, x3, y3) =>
        seg(x0, y0, x0 + (x3 - x0) / 3, y0 + (y3 - y0) / 3, x0 + (x3 - x0) * 2 / 3, y0 + (y3 - y0) * 2 / 3, x3, y3, true);
    const segReverse = (s) => seg(s.x3, s.y3, s.x2, s.y2, s.x1, s.y1, s.x0, s.y0, s.line);
    const mapSeg = (s, m) => seg(
        m.a * s.x0 + m.c * s.y0 + m.e, m.b * s.x0 + m.d * s.y0 + m.f,
        m.a * s.x1 + m.c * s.y1 + m.e, m.b * s.x1 + m.d * s.y1 + m.f,
        m.a * s.x2 + m.c * s.y2 + m.e, m.b * s.x2 + m.d * s.y2 + m.f,
        m.a * s.x3 + m.c * s.y3 + m.e, m.b * s.x3 + m.d * s.y3 + m.f, s.line);

    const segPointAt = (s, t) => {
        const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        return { x: a * s.x0 + b * s.x1 + c * s.x2 + d * s.x3, y: a * s.y0 + b * s.y1 + c * s.y2 + d * s.y3 };
    };
    const segDerivAt = (s, t) => {
        const u = 1 - t;
        return {
            x: 3 * (u * u * (s.x1 - s.x0) + 2 * u * t * (s.x2 - s.x1) + t * t * (s.x3 - s.x2)),
            y: 3 * (u * u * (s.y1 - s.y0) + 2 * u * t * (s.y2 - s.y1) + t * t * (s.y3 - s.y2))
        };
    };
    // Control-point hull box: conservative (always contains the curve), cheap, cached per segment.
    const segBBox = (s) => s._bb || (s._bb = {
        minX: Math.min(s.x0, s.x1, s.x2, s.x3), maxX: Math.max(s.x0, s.x1, s.x2, s.x3),
        minY: Math.min(s.y0, s.y1, s.y2, s.y3), maxY: Math.max(s.y0, s.y1, s.y2, s.y3)
    });
    // Polynomial coefficients (x(t), y(t) = a t^3 + b t^2 + c t + d), cached per segment.
    const segCoefs = (s) => s._co || (s._co = {
        ax: -s.x0 + 3 * s.x1 - 3 * s.x2 + s.x3, bx: 3 * (s.x0 - 2 * s.x1 + s.x2), cx: 3 * (s.x1 - s.x0), dx: s.x0,
        ay: -s.y0 + 3 * s.y1 - 3 * s.y2 + s.y3, by: 3 * (s.y0 - 2 * s.y1 + s.y2), cy: 3 * (s.y1 - s.y0), dy: s.y0
    });

    // de Casteljau split at t -> [left, right]. Thirds-control lines stay exact lines.
    const segSplitAt = (s, t) => {
        const u = 1 - t;
        const x01 = u * s.x0 + t * s.x1, y01 = u * s.y0 + t * s.y1;
        const x12 = u * s.x1 + t * s.x2, y12 = u * s.y1 + t * s.y2;
        const x23 = u * s.x2 + t * s.x3, y23 = u * s.y2 + t * s.y3;
        const x012 = u * x01 + t * x12, y012 = u * y01 + t * y12;
        const x123 = u * x12 + t * x23, y123 = u * y12 + t * y23;
        const xm = u * x012 + t * x123, ym = u * y012 + t * y123;
        return [seg(s.x0, s.y0, x01, y01, x012, y012, xm, ym, s.line), seg(xm, ym, x123, y123, x23, y23, s.x3, s.y3, s.line)];
    };

    /* ---- Polynomial root solving ---------------------------------------------------------- */

    const solveQuadratic = (a, b, c, out) => {
        if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) out.push(-c / b); return; }
        const disc = b * b - 4 * a * c;
        if (disc < 0) return;
        const sq = Math.sqrt(disc);
        const q = -0.5 * (b + (b >= 0 ? sq : -sq));
        const r1 = q / a;
        out.push(r1);
        out.push(Math.abs(q) > 1e-14 ? c / q : -b / a - r1);
    };

    // All real roots of a t^3 + b t^2 + c t + d (normalized + Newton-polished).
    const solveCubicRoots = (a, b, c, d) => {
        const out = [];
        const mag = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
        if (mag < 1e-14) return out;
        a /= mag; b /= mag; c /= mag; d /= mag;
        if (Math.abs(a) < 1e-10) {
            solveQuadratic(b, c, d, out);
        } else {
            const bn = b / a, cn = c / a, dn = d / a;
            const p = cn - bn * bn / 3;
            const q = 2 * bn * bn * bn / 27 - bn * cn / 3 + dn;
            const off = -bn / 3;
            const disc = q * q / 4 + p * p * p / 27;
            if (disc > 1e-14) {
                const sq = Math.sqrt(disc);
                out.push(Math.cbrt(-q / 2 + sq) + Math.cbrt(-q / 2 - sq) + off);
            } else if (disc < -1e-14) {
                const r = Math.sqrt(-p * p * p / 27);
                const phi = Math.acos(Math.min(1, Math.max(-1, -q / (2 * r))));
                const m = 2 * Math.sqrt(-p / 3);
                out.push(m * Math.cos(phi / 3) + off, m * Math.cos((phi + 2 * Math.PI) / 3) + off, m * Math.cos((phi + 4 * Math.PI) / 3) + off);
            } else if (Math.abs(q) < 1e-14) {
                out.push(off);
            } else {
                const u = Math.cbrt(-q / 2);
                out.push(2 * u + off, -u + off);
            }
        }
        return out.map(t => {
            for (let i = 0; i < 3; i++) {
                const f = ((a * t + b) * t + c) * t + d;
                const df = (3 * a * t + 2 * b) * t + c;
                if (Math.abs(df) > 1e-12) t -= f / df;
            }
            return t;
        });
    };

    /* ---- Winding number (nonzero) + crossing parity --------------------------------------- */
    // Horizontal ray from (px,py) toward +x, half-open in t ([0,1)) so shared loop vertices count
    // once. hazard flags any numerically unsafe encounter (root at a segment end, tangent graze,
    // hit at the ray origin) -- callers retry from a different sample point.

    const windingAt = (region, px, py, tol, diag) => {
        let w = 0, cross = 0, hazard = false;
        const dyTol = 1e-8 * diag;
        for (const loop of region) {
            for (const s of loop) {
                const bb = segBBox(s);
                if (bb.minY > py + tol || bb.maxY < py - tol || bb.maxX <= px - tol) continue;
                const co = segCoefs(s);
                const ts = solveCubicRoots(co.ay, co.by, co.cy, co.dy - py);
                for (let t of ts) {
                    if (t < -1e-7 || t > 1 + 1e-7) continue;
                    if (t < 1e-7 || t > 1 - 1e-7) hazard = true;
                    if (t >= 1 - 1e-7) continue;                    // t=1 counts as the next segment's t=0
                    t = Math.max(0, t);
                    const x = ((co.ax * t + co.bx) * t + co.cx) * t + co.dx;
                    if (Math.abs(x - px) <= tol * 8) hazard = true;
                    if (x <= px) continue;
                    const dy = (3 * co.ay * t + 2 * co.by) * t + co.cy;
                    if (Math.abs(dy) < dyTol) { hazard = true; continue; }
                    w += dy > 0 ? 1 : -1;
                    cross++;
                }
            }
        }
        return { w, cross, hazard };
    };

    // Winding of `region` at a safe sample point of segment s (retries away from hazards).
    const windingForSeg = (region, s, tol, diag) => {
        let last = null;
        for (const t of PF_T_SAMPLES) {
            const p = segPointAt(s, t);
            const r = windingAt(region, p.x, p.y, tol, diag);
            if (!r.hazard) return r;
            last = r;
        }
        return last || { w: 0, cross: 0, hazard: true };
    };

    /* ---- Loop / region helpers ------------------------------------------------------------ */

    // Signed area via a fixed-subdivision shoelace -- only used for orientation signs and
    // sliver/empty thresholds, so approximation error is irrelevant.
    const loopAreaApprox = (loop) => {
        let area = 0;
        for (const s of loop) {
            const n = s.line ? 1 : 8;
            let px = s.x0, py = s.y0;
            for (let i = 1; i <= n; i++) {
                const p = segPointAt(s, i / n);
                area += px * p.y - p.x * py;
                px = p.x; py = p.y;
            }
        }
        return area / 2;
    };

    const reverseLoop = (loop) => loop.slice().reverse().map(segReverse);

    const regionBBox = (region) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const loop of region) for (const s of loop) {
            const bb = segBBox(s);
            if (bb.minX < minX) minX = bb.minX;
            if (bb.minY < minY) minY = bb.minY;
            if (bb.maxX > maxX) maxX = bb.maxX;
            if (bb.maxY > maxY) maxY = bb.maxY;
        }
        return { minX, minY, maxX, maxY };
    };

    // Is `loop`'s sample point inside `other`? (Orientation-independent; retries past hazards.)
    const loopContains = (other, loop, tol, diag) => {
        for (const s of loop) {
            for (const t of [0.5, 0.29, 0.71]) {
                const p = segPointAt(s, t);
                const r = windingAt([other], p.x, p.y, tol, diag);
                if (!r.hazard) return r.w !== 0;
            }
        }
        return false;
    };

    // Does crossing this loop actually flip filled/unfilled in the whole (multi-loop) region?
    // Probes a pair of points straddling the loop; escalates the offset past hazards. Loops that
    // never flip fill (e.g. a same-direction nested duplicate) are redundant and dropped.
    const loopFlipsFill = (allLoops, loop, fillOf, tol, diag) => {
        for (const s of loop) {
            for (const t of [0.5, 0.3, 0.7]) {
                const p = segPointAt(s, t), dv = segDerivAt(s, t);
                const len = Math.hypot(dv.x, dv.y);
                if (len < 1e-12) continue;
                const nx = -dv.y / len, ny = dv.x / len;
                for (const k of [1e-5, 1e-4, 1e-3]) {
                    const dd = diag * k;
                    const rA = windingAt(allLoops, p.x + nx * dd, p.y + ny * dd, tol, diag);
                    if (rA.hazard) continue;
                    const rB = windingAt(allLoops, p.x - nx * dd, p.y - ny * dd, tol, diag);
                    if (rB.hazard) continue;
                    return fillOf(rA) !== fillOf(rB);
                }
            }
        }
        return true;   // undecidable -> keep (safe default)
    };

    // Normalize raw shape loops to a canonical NONZERO region: filled interior winds +1, holes
    // wind -1. Drops sliver + redundant loops, then orients every kept loop by containment-depth
    // parity (even depth = positive area). Honouring evenOdd here is what makes evenodd compound
    // paths behave: the parity fill test decides which loops are real boundaries.
    const normalizeRegion = (loops, evenOdd, tol, diag) => {
        const areaEps = diag * diag * 1e-12;
        let kept = loops.filter(l => l.length && Math.abs(loopAreaApprox(l)) > areaEps);
        if (kept.length > 1) {
            const fillOf = (r) => evenOdd ? ((r.cross & 1) === 1) : (r.w !== 0);
            kept = kept.filter(loop => loopFlipsFill(kept, loop, fillOf, tol, diag));
            kept = kept.map((loop, li) => {
                let depth = 0;
                kept.forEach((other, lj) => { if (lj !== li && loopContains(other, loop, tol, diag)) depth++; });
                const wantPositive = (depth % 2) === 0;
                return (loopAreaApprox(loop) > 0) === wantPositive ? loop : reverseLoop(loop);
            });
        } else if (kept.length === 1 && loopAreaApprox(kept[0]) < 0) {
            kept[0] = reverseLoop(kept[0]);
        }
        return kept;
    };

    /* ---- Segment x segment intersections --------------------------------------------------- */
    // Every hit is recorded symmetrically as {t, p} on both segments' split lists, SHARING the
    // same point object so the split junctions land on identical coordinates (the vertex
    // clustering then welds A-side and B-side fragments together). Coincident overlaps register
    // their interval endpoints as splits; the equal pieces are paired up later by geometry.

    const recordHit = (ea, t, eb, ss, p) => {
        ea.splits.push({ t, p });
        eb.splits.push({ t: ss, p });
    };

    // Closest-point parameter of q on segment s (coarse scan + Newton on dot(P-q, P') = 0).
    const projectOnSeg = (s, qx, qy) => {
        let bt = 0, bd = Infinity;
        for (let i = 0; i <= 16; i++) {
            const t = i / 16, p = segPointAt(s, t);
            const d = (p.x - qx) * (p.x - qx) + (p.y - qy) * (p.y - qy);
            if (d < bd) { bd = d; bt = t; }
        }
        for (let i = 0; i < 4; i++) {
            const p = segPointAt(s, bt), dv = segDerivAt(s, bt);
            const g = (p.x - qx) * dv.x + (p.y - qy) * dv.y;
            const p2 = segPointAt(s, Math.min(1, bt + 1e-5));
            const dv2 = segDerivAt(s, Math.min(1, bt + 1e-5));
            const g2 = (p2.x - qx) * dv2.x + (p2.y - qy) * dv2.y;
            const dg = (g2 - g) / 1e-5;
            if (Math.abs(dg) < 1e-12) break;
            bt = Math.min(1, Math.max(0, bt - g / dg));
        }
        return bt;
    };
    const distToSeg = (s, qx, qy) => {
        const p = segPointAt(s, projectOnSeg(s, qx, qy));
        return Math.hypot(p.x - qx, p.y - qy);
    };

    // Overlap of two (near-)coincident segments: clamp b's span onto a's [0,1], register both
    // interval endpoints as shared splits on each side.
    const recordOverlap = (ea, eb, tol) => {
        const sa = ea.s, sb = eb.s;
        let t0 = projectOnSeg(sa, sb.x0, sb.y0), t1 = projectOnSeg(sa, sb.x3, sb.y3);
        if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
        t0 = Math.max(0, t0); t1 = Math.min(1, t1);
        if (t1 - t0 < 1e-6) return;
        for (const t of [t0, t1]) {
            const p = segPointAt(sa, t);
            const ss = projectOnSeg(sb, p.x, p.y);
            recordHit(ea, t, eb, ss, { x: p.x, y: p.y });
        }
    };

    // Do the two curves run along the same trace? (all samples of each within lim of the other)
    const segsCoincide = (sa, sb, lim) => {
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const p = segPointAt(sb, t);
            if (distToSeg(sa, p.x, p.y) > lim) return false;
        }
        for (const t of [0.25, 0.5, 0.75]) {
            const p = segPointAt(sa, t);
            if (distToSeg(sb, p.x, p.y) > lim) return false;
        }
        return true;
    };

    const lineLineHits = (ea, eb, tol, vtol) => {
        const a = ea.s, b = eb.s;
        const rx = a.x3 - a.x0, ry = a.y3 - a.y0;
        const sx = b.x3 - b.x0, sy = b.y3 - b.y0;
        const den = rx * sy - ry * sx;
        const qpx = b.x0 - a.x0, qpy = b.y0 - a.y0;
        if (Math.abs(den) < 1e-12 * (Math.abs(rx) + Math.abs(ry)) * (Math.abs(sx) + Math.abs(sy)) + 1e-30) {
            // Parallel: collinear (both b endpoints on a's line) -> interval overlap.
            const lenA = Math.hypot(rx, ry) || 1;
            const d0 = Math.abs(qpx * ry - qpy * rx) / lenA;
            const d1 = Math.abs((b.x3 - a.x0) * ry - (b.y3 - a.y0) * rx) / lenA;
            if (d0 <= vtol && d1 <= vtol) recordOverlap(ea, eb, tol);
            return;
        }
        const t = (qpx * sy - qpy * sx) / den;
        const u = (qpx * ry - qpy * rx) / den;
        if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return;
        const p = { x: a.x0 + t * rx, y: a.y0 + t * ry };
        recordHit(ea, Math.min(1, Math.max(0, t)), eb, Math.min(1, Math.max(0, u)), p);
    };

    const lineCubicHits = (eLine, eCubic, tol, vtol, lineIsA) => {
        const L = eLine.s, C = eCubic.s;
        const dx = L.x3 - L.x0, dy = L.y3 - L.y0;
        const len = Math.hypot(dx, dy);
        if (len < 1e-12) return;
        const nx = -dy / len, ny = dx / len;                     // unit normal of the line
        const cc = -(nx * L.x0 + ny * L.y0);
        // Degenerate cubic lying ON the line -> collinear overlap.
        if (Math.abs(nx * C.x0 + ny * C.y0 + cc) <= vtol && Math.abs(nx * C.x1 + ny * C.y1 + cc) <= vtol &&
            Math.abs(nx * C.x2 + ny * C.y2 + cc) <= vtol && Math.abs(nx * C.x3 + ny * C.y3 + cc) <= vtol) {
            if (lineIsA) recordOverlap(eLine, eCubic, tol); else recordOverlap(eCubic, eLine, tol);
            return;
        }
        const co = segCoefs(C);
        const a = nx * co.ax + ny * co.ay;
        const b = nx * co.bx + ny * co.by;
        const c = nx * co.cx + ny * co.cy;
        const d = nx * co.dx + ny * co.dy + cc;
        for (let t of solveCubicRoots(a, b, c, d)) {
            if (t < -1e-7 || t > 1 + 1e-7) continue;
            t = Math.min(1, Math.max(0, t));
            const p = segPointAt(C, t);
            const u = ((p.x - L.x0) * dx + (p.y - L.y0) * dy) / (len * len);
            if (u < -1e-7 || u > 1 + 1e-7) continue;
            const uc = Math.min(1, Math.max(0, u));
            const pl = { x: L.x0 + uc * dx, y: L.y0 + uc * dy };
            if (Math.hypot(pl.x - p.x, pl.y - p.y) > tol * 8) continue;   // clamped off the segment
            const pp = { x: (p.x + pl.x) / 2, y: (p.y + pl.y) / 2 };
            if (lineIsA) recordHit(eLine, uc, eCubic, t, pp); else recordHit(eCubic, t, eLine, uc, pp);
        }
    };

    const segFlat = (s, tol) => {
        const dx = s.x3 - s.x0, dy = s.y3 - s.y0;
        const len = Math.hypot(dx, dy);
        if (len < tol) return true;
        const d1 = Math.abs((s.x1 - s.x0) * dy - (s.y1 - s.y0) * dx) / len;
        const d2 = Math.abs((s.x2 - s.x0) * dy - (s.y2 - s.y0) * dx) / len;
        return Math.max(d1, d2) <= tol;
    };

    // Newton-refine an intersection param pair (2D root of Pa(t) - Pb(s)).
    const refinePair = (sa, sb, t, s) => {
        for (let i = 0; i < 10; i++) {
            const pa = segPointAt(sa, t), pb = segPointAt(sb, s);
            const fx = pa.x - pb.x, fy = pa.y - pb.y;
            const da = segDerivAt(sa, t), db = segDerivAt(sb, s);
            const det = -da.x * db.y + db.x * da.y;
            if (Math.abs(det) < 1e-16) break;
            const dt = (fx * db.y - db.x * fy) / det;
            const ds = (-da.x * fy + fx * da.y) / det;
            t = Math.min(1, Math.max(0, t - dt));
            s = Math.min(1, Math.max(0, s - ds));
            if (Math.abs(dt) < 1e-12 && Math.abs(ds) < 1e-12) break;
        }
        return { t, s };
    };

    const cubicCubicRecurse = (sa, ta0, ta1, sb, tb0, tb1, tol, depth, out) => {
        if (out.length > 64) return;
        const ba = segBBox(sa), bb = segBBox(sb);
        if (ba.minX > bb.maxX + tol || bb.minX > ba.maxX + tol || ba.minY > bb.maxY + tol || bb.minY > ba.maxY + tol) return;
        if (depth <= 0 || (segFlat(sa, tol) && segFlat(sb, tol))) {
            out.push({ t: (ta0 + ta1) / 2, s: (tb0 + tb1) / 2 });
            return;
        }
        const spanA = Math.max(ba.maxX - ba.minX, ba.maxY - ba.minY);
        const spanB = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
        if (spanA >= spanB) {
            const tm = (ta0 + ta1) / 2;
            const [l, r] = segSplitAt(sa, 0.5);
            cubicCubicRecurse(l, ta0, tm, sb, tb0, tb1, tol, depth - 1, out);
            cubicCubicRecurse(r, tm, ta1, sb, tb0, tb1, tol, depth - 1, out);
        } else {
            const tm = (tb0 + tb1) / 2;
            const [l, r] = segSplitAt(sb, 0.5);
            cubicCubicRecurse(sa, ta0, ta1, l, tb0, tm, tol, depth - 1, out);
            cubicCubicRecurse(sa, ta0, ta1, r, tm, tb1, tol, depth - 1, out);
        }
    };

    const cubicCubicHits = (ea, eb, tol, vtol) => {
        if (segsCoincide(ea.s, eb.s, vtol)) { recordOverlap(ea, eb, tol); return; }
        const raw = [];
        cubicCubicRecurse(ea.s, 0, 1, eb.s, 0, 1, tol, 40, raw);
        if (!raw.length) return;
        raw.sort((p, q) => p.t - q.t);
        const hits = [];
        for (const h of raw) {
            const r = refinePair(ea.s, eb.s, h.t, h.s);
            const pa = segPointAt(ea.s, r.t), pb = segPointAt(eb.s, r.s);
            if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > tol * 32) continue;   // diverged: spurious box hit
            if (hits.some(e => Math.abs(e.t - r.t) < 1e-6 && Math.abs(e.s - r.s) < 1e-6)) continue;
            hits.push(r);
        }
        for (const h of hits) {
            const pa = segPointAt(ea.s, h.t), pb = segPointAt(eb.s, h.s);
            recordHit(ea, h.t, eb, h.s, { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
        }
    };

    const intersectSegPair = (ea, eb, tol, vtol) => {
        const ba = segBBox(ea.s), bb = segBBox(eb.s);
        if (ba.minX > bb.maxX + tol || bb.minX > ba.maxX + tol || ba.minY > bb.maxY + tol || bb.minY > ba.maxY + tol) return;
        if (ea.s.line && eb.s.line) lineLineHits(ea, eb, tol, vtol);
        else if (ea.s.line) lineCubicHits(ea, eb, tol, vtol, true);
        else if (eb.s.line) lineCubicHits(eb, ea, tol, vtol, false);
        else cubicCubicHits(ea, eb, tol, vtol);
    };

    /* ---- Fragments: split, weld vertices, pair coincident pieces --------------------------- */

    // Spatial vertex welder: endpoints within vtol collapse to one shared vertex id.
    const makeVtxIndex = (vtol) => {
        const cells = new Map(), pts = [];
        const idFor = (x, y) => {
            const gx = Math.round(x / vtol), gy = Math.round(y / vtol);
            for (let ix = gx - 1; ix <= gx + 1; ix++) {
                for (let iy = gy - 1; iy <= gy + 1; iy++) {
                    const arr = cells.get(ix + ':' + iy);
                    if (!arr) continue;
                    for (const id of arr) {
                        const p = pts[id];
                        if (Math.hypot(p.x - x, p.y - y) <= vtol) return id;
                    }
                }
            }
            const id = pts.length;
            pts.push({ x, y });
            const k = gx + ':' + gy;
            const arr = cells.get(k);
            if (arr) arr.push(id); else cells.set(k, [id]);
            return id;
        };
        return { idFor, pts };
    };

    const buildFragments = (entries, vtx, vtol) => {
        const frags = [];
        for (const e of entries) {
            const ts = e.splits
                .filter(sp => sp.t > 1e-7 && sp.t < 1 - 1e-7)
                .sort((a, b) => a.t - b.t);
            const pieces = [];
            let rest = e.s, base = 0;
            for (const sp of ts) {
                const local = (sp.t - base) / (1 - base);
                if (local <= 1e-7 || local >= 1 - 1e-7) continue;
                const [l, r] = segSplitAt(rest, local);
                l.x3 = sp.p.x; l.y3 = sp.p.y;                     // weld the junction onto the recorded hit
                r.x0 = sp.p.x; r.y0 = sp.p.y;
                pieces.push(l);
                rest = r;
                base = sp.t;
            }
            pieces.push(rest);
            for (const s of pieces) {
                const v0 = vtx.idFor(s.x0, s.y0), v1 = vtx.idFor(s.x3, s.y3);
                s.x0 = vtx.pts[v0].x; s.y0 = vtx.pts[v0].y;       // snap onto the shared vertex
                s.x3 = vtx.pts[v1].x; s.y3 = vtx.pts[v1].y;
                s._bb = null; s._co = null;
                if (v0 === v1) {                                   // closed or degenerate piece
                    const bb = segBBox(s);
                    if (bb.maxX - bb.minX < vtol * 2 && bb.maxY - bb.minY < vtol * 2) continue;
                }
                frags.push({ s, v0, v1, mid: segPointAt(s, 0.5), co: false, coSameDir: false, used: false });
            }
        }
        return frags;
    };

    // Pair up geometrically identical fragments across the two operands (shared edges).
    const markCoincident = (fragsA, fragsB, vtol) => {
        const map = new Map();
        for (const f of fragsA) {
            const k = Math.min(f.v0, f.v1) + ':' + Math.max(f.v0, f.v1);
            const arr = map.get(k);
            if (arr) arr.push(f); else map.set(k, [f]);
        }
        for (const f of fragsB) {
            const arr = map.get(Math.min(f.v0, f.v1) + ':' + Math.max(f.v0, f.v1));
            if (!arr) continue;
            for (const a of arr) {
                if (a.co) continue;
                if (Math.hypot(a.mid.x - f.mid.x, a.mid.y - f.mid.y) > vtol * 8) continue;
                a.co = true;
                a.coSameDir = (a.v0 === f.v0 && a.v1 === f.v1);
                f.co = true;
                break;
            }
        }
    };

    const chainFragments = (frags) => {
        const byStart = new Map();
        for (const f of frags) {
            const arr = byStart.get(f.v0);
            if (arr) arr.push(f); else byStart.set(f.v0, [f]);
        }
        const loops = [];
        for (const f0 of frags) {
            if (f0.used) continue;
            f0.used = true;
            const chain = [f0];
            let cur = f0.v1;
            let guard = frags.length + 2;
            while (cur !== f0.v0 && guard-- > 0) {
                const arr = byStart.get(cur);
                let next = null;
                if (arr) for (const c of arr) { if (!c.used) { next = c; break; } }
                if (!next) break;
                next.used = true;
                chain.push(next);
                cur = next.v1;
            }
            if (cur === f0.v0) loops.push(chain.map(c => c.s));
            // else: numerically orphaned open chain -> discarded
        }
        return loops;
    };

    /* ---- Binary boolean core ---------------------------------------------------------------- */
    // Both operands must be canonical nonzero regions (interior winds +1). Every boundary
    // fragment of A is classified by B's winding at its midpoint (and vice versa) -- coincident
    // pairs are resolved by the rule table instead, keeping at most the A-side copy.

    const pfBinary = (A, B, op, tol, vtol, diag) => {
        if (!A.length && !B.length) return [];
        let disjoint = !A.length || !B.length;
        if (!disjoint) {
            const ba = regionBBox(A), bb = regionBBox(B);
            disjoint = ba.minX > bb.maxX + vtol || bb.minX > ba.maxX + vtol || ba.minY > bb.maxY + vtol || bb.minY > ba.maxY + vtol;
        }
        if (disjoint) {
            if (op === 'union' || op === 'xor') return A.concat(B);
            if (op === 'subtract') return A;
            return [];                                             // intersect
        }

        const entriesA = [], entriesB = [];
        A.forEach(loop => loop.forEach(s => entriesA.push({ s, splits: [] })));
        B.forEach(loop => loop.forEach(s => entriesB.push({ s, splits: [] })));
        for (const ea of entriesA) for (const eb of entriesB) intersectSegPair(ea, eb, tol, vtol);

        const vtx = makeVtxIndex(vtol);
        const fragsA = buildFragments(entriesA, vtx, vtol);
        const fragsB = buildFragments(entriesB, vtx, vtol);
        markCoincident(fragsA, fragsB, vtol);

        const revFrag = (f) => ({ s: segReverse(f.s), v0: f.v1, v1: f.v0, used: false });
        const kept = [];
        for (const f of fragsA) {
            let keep, rev = false;
            if (f.co) {
                keep = f.coSameDir ? (op === 'union' || op === 'intersect') : (op === 'subtract');
            } else {
                const w = windingForSeg(B, f.s, tol, diag).w;
                if (op === 'union' || op === 'subtract') keep = w === 0;
                else if (op === 'intersect') keep = w !== 0;
                else { keep = true; rev = w !== 0; }               // xor
            }
            if (keep) kept.push(rev ? revFrag(f) : f);
        }
        for (const f of fragsB) {
            let keep = false, rev = false;
            if (!f.co) {
                const w = windingForSeg(A, f.s, tol, diag).w;
                if (op === 'union') keep = w === 0;
                else if (op === 'intersect') keep = w !== 0;
                else if (op === 'subtract') { keep = w !== 0; rev = true; }
                else { keep = true; rev = w !== 0; }               // xor
            }
            if (keep) kept.push(rev ? revFrag(f) : f);
        }

        const loops = chainFragments(kept);
        const areaEps = diag * diag * 1e-12;
        return loops.filter(l => Math.abs(loopAreaApprox(l)) > areaEps);
    };

    /* ---- Shape -> loops (local coordinates) ------------------------------------------------ */

    const numAttr = (el, name, fallback = 0) => {
        const v = parseFloat(el.getAttribute(name));
        return Number.isFinite(v) ? v : fallback;
    };

    const rectLoops = (el) => {
        const x = numAttr(el, 'x'), y = numAttr(el, 'y');
        const w = numAttr(el, 'width'), h = numAttr(el, 'height');
        if (w <= 0 || h <= 0) return [];
        let rx = el.getAttribute('rx'), ry = el.getAttribute('ry');
        rx = rx == null ? null : parseFloat(rx);
        ry = ry == null ? null : parseFloat(ry);
        if (rx == null) rx = ry;
        if (ry == null) ry = rx;
        rx = Math.min(Math.max(rx || 0, 0), w / 2);
        ry = Math.min(Math.max(ry || 0, 0), h / 2);
        if (rx < 1e-9 || ry < 1e-9) {
            return [[segLine(x, y, x + w, y), segLine(x + w, y, x + w, y + h), segLine(x + w, y + h, x, y + h), segLine(x, y + h, x, y)]];
        }
        const kx = rx * PF_KAPPA, ky = ry * PF_KAPPA;
        return [[
            segLine(x + rx, y, x + w - rx, y),
            seg(x + w - rx, y, x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry),
            segLine(x + w, y + ry, x + w, y + h - ry),
            seg(x + w, y + h - ry, x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h),
            segLine(x + w - rx, y + h, x + rx, y + h),
            seg(x + rx, y + h, x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry),
            segLine(x, y + h - ry, x, y + ry),
            seg(x, y + ry, x, y + ry - ky, x + rx - kx, y, x + rx, y)
        ]];
    };

    const ellipseLoops = (cx, cy, rx, ry) => {
        if (rx <= 0 || ry <= 0) return [];
        const kx = rx * PF_KAPPA, ky = ry * PF_KAPPA;
        return [[
            seg(cx + rx, cy, cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
            seg(cx, cy + ry, cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
            seg(cx - rx, cy, cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
            seg(cx, cy - ry, cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy)
        ]];
    };

    const pointsLoops = (el) => {
        const raw = (el.getAttribute('points') || '').trim();
        if (!raw) return [];
        const nums = raw.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        const segs = [];
        for (let i = 0; i + 3 < nums.length; i += 2) {
            if (Math.hypot(nums[i + 2] - nums[i], nums[i + 3] - nums[i + 1]) > 1e-9)
                segs.push(segLine(nums[i], nums[i + 1], nums[i + 2], nums[i + 3]));
        }
        if (!segs.length) return [];
        const first = segs[0], last = segs[segs.length - 1];
        if (Math.hypot(last.x3 - first.x0, last.y3 - first.y0) > 1e-9)
            segs.push(segLine(last.x3, last.y3, first.x0, first.y0));   // implicit close
        return [segs];
    };

    // SVG elliptical arc -> cubic segments (W3C F.6.5 endpoint -> center parameterization).
    const arcToSegs = (x1, y1, rx, ry, phiDeg, laf, sf, x2, y2, out) => {
        if (Math.abs(x2 - x1) < 1e-12 && Math.abs(y2 - y1) < 1e-12) return;
        rx = Math.abs(rx); ry = Math.abs(ry);
        if (rx < 1e-12 || ry < 1e-12) { out.push(segLine(x1, y1, x2, y2)); return; }
        const phi = phiDeg * Math.PI / 180;
        const cosP = Math.cos(phi), sinP = Math.sin(phi);
        const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
        const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
        const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
        const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        let coef = den > 1e-30 ? Math.sqrt(Math.max(0, num / den)) : 0;
        if (laf === sf) coef = -coef;
        const cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx;
        const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
        const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
        const angOf = (ux, uy) => Math.atan2(uy, ux);
        const th1 = angOf((x1p - cxp) / rx, (y1p - cyp) / ry);
        let dth = angOf((-x1p - cxp) / rx, (-y1p - cyp) / ry) - th1;
        if (!sf && dth > 0) dth -= 2 * Math.PI;
        else if (sf && dth < 0) dth += 2 * Math.PI;
        const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
        const delta = dth / n;
        const alpha = 4 / 3 * Math.tan(delta / 4);
        let th = th1;
        let px = x1, py = y1;
        for (let i = 0; i < n; i++) {
            const th2 = th + delta;
            const c1 = Math.cos(th), s1 = Math.sin(th), c2 = Math.cos(th2), s2 = Math.sin(th2);
            const ex = cx + rx * cosP * c2 - ry * sinP * s2;
            const ey = cy + rx * sinP * c2 + ry * cosP * s2;
            out.push(seg(
                px, py,
                px + alpha * (-rx * cosP * s1 - ry * sinP * c1), py + alpha * (-rx * sinP * s1 + ry * cosP * c1),
                ex - alpha * (-rx * cosP * s2 - ry * sinP * c2), ey - alpha * (-rx * sinP * s2 + ry * cosP * c2),
                ex, ey
            ));
            px = ex; py = ey; th = th2;
        }
    };

    // Full path-data parser: absolute/relative M L H V C S Q T A Z, arc-flag aware, quadratics
    // elevated to cubics, arcs converted, every subpath implicitly closed (boolean semantics).
    const parsePathLoops = (d) => {
        const loops = [];
        let segs = [];
        let i = 0;
        const n = d.length;
        const isWS = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\f' || ch === '\v';
        const skipWS = () => { while (i < n && isWS(d[i])) i++; };
        const isDigit = (ch) => ch >= '0' && ch <= '9';
        const readNum = () => {
            skipWS();
            const start = i;
            if (d[i] === '+' || d[i] === '-') i++;
            while (i < n && isDigit(d[i])) i++;
            if (d[i] === '.') { i++; while (i < n && isDigit(d[i])) i++; }
            if (d[i] === 'e' || d[i] === 'E') { i++; if (d[i] === '+' || d[i] === '-') i++; while (i < n && isDigit(d[i])) i++; }
            if (i === start) return null;
            const v = parseFloat(d.slice(start, i));
            return Number.isFinite(v) ? v : null;
        };
        const readFlag = () => {
            skipWS();
            if (d[i] === '0' || d[i] === '1') return d[i++] === '1';
            return null;
        };

        let cx = 0, cy = 0, sx = 0, sy = 0;
        let cmd = null, lastType = '';
        let pcx = 0, pcy = 0;                                     // previous C/S second control (for S)
        let pqx = 0, pqy = 0;                                     // previous Q/T control (for T)
        const flush = () => {
            if (segs.length) {
                if (Math.hypot(cx - sx, cy - sy) > 1e-9) segs.push(segLine(cx, cy, sx, sy));
                loops.push(segs);
            }
            segs = [];
        };
        const pushLine = (x, y) => { if (Math.hypot(x - cx, y - cy) > 1e-12) segs.push(segLine(cx, cy, x, y)); cx = x; cy = y; };
        const pushCubic = (x1, y1, x2, y2, x, y) => { segs.push(seg(cx, cy, x1, y1, x2, y2, x, y)); cx = x; cy = y; };

        while (i < n) {
            skipWS();
            if (i >= n) break;
            const ch = d[i];
            if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) { cmd = ch; i++; }
            else if (cmd == null) { i++; continue; }
            const rel = cmd >= 'a';
            const C = cmd.toUpperCase();
            if (C === 'Z') { flush(); cx = sx; cy = sy; lastType = 'Z'; cmd = null; continue; }
            let x, y, x1, y1, x2, y2;
            switch (C) {
                case 'M':
                    x = readNum(); y = readNum();
                    if (x == null || y == null) { i = n; break; }
                    if (rel) { x += cx; y += cy; }
                    flush();
                    cx = sx = x; cy = sy = y;
                    cmd = rel ? 'l' : 'L';                        // implicit repeats are linetos
                    lastType = 'M';
                    break;
                case 'L':
                    x = readNum(); y = readNum();
                    if (x == null || y == null) { i = n; break; }
                    if (rel) { x += cx; y += cy; }
                    pushLine(x, y); lastType = 'L';
                    break;
                case 'H':
                    x = readNum();
                    if (x == null) { i = n; break; }
                    pushLine(rel ? cx + x : x, cy); lastType = 'L';
                    break;
                case 'V':
                    y = readNum();
                    if (y == null) { i = n; break; }
                    pushLine(cx, rel ? cy + y : y); lastType = 'L';
                    break;
                case 'C':
                    x1 = readNum(); y1 = readNum(); x2 = readNum(); y2 = readNum(); x = readNum(); y = readNum();
                    if (y == null) { i = n; break; }
                    if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
                    pushCubic(x1, y1, x2, y2, x, y);
                    pcx = x2; pcy = y2; lastType = 'C';
                    break;
                case 'S':
                    x2 = readNum(); y2 = readNum(); x = readNum(); y = readNum();
                    if (y == null) { i = n; break; }
                    if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
                    x1 = (lastType === 'C') ? 2 * cx - pcx : cx;
                    y1 = (lastType === 'C') ? 2 * cy - pcy : cy;
                    pushCubic(x1, y1, x2, y2, x, y);
                    pcx = x2; pcy = y2; lastType = 'C';
                    break;
                case 'Q':
                    x1 = readNum(); y1 = readNum(); x = readNum(); y = readNum();
                    if (y == null) { i = n; break; }
                    if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
                    pushCubic(cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy), x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y), x, y);
                    pqx = x1; pqy = y1; lastType = 'Q';
                    break;
                case 'T': {
                    x = readNum(); y = readNum();
                    if (y == null) { i = n; break; }
                    if (rel) { x += cx; y += cy; }
                    const qx = (lastType === 'Q') ? 2 * cx - pqx : cx;
                    const qy = (lastType === 'Q') ? 2 * cy - pqy : cy;
                    pushCubic(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y);
                    pqx = qx; pqy = qy; lastType = 'Q';
                    break;
                }
                case 'A': {
                    const rx = readNum(), ry = readNum(), rot = readNum();
                    const laf = readFlag(), sf = readFlag();
                    x = readNum(); y = readNum();
                    if (rx == null || ry == null || rot == null || laf == null || sf == null || y == null) { i = n; break; }
                    if (rel) { x += cx; y += cy; }
                    arcToSegs(cx, cy, rx, ry, rot, laf, sf, x, y, segs);
                    cx = x; cy = y; lastType = 'A';
                    break;
                }
                default:
                    cmd = null;                                    // unknown command: skip
            }
        }
        flush();
        return loops;
    };

    const shapeToLocalLoops = (shape) => {
        switch ((shape.tagName || '').toLowerCase()) {
            case 'rect': return rectLoops(shape);
            case 'circle': return ellipseLoops(numAttr(shape, 'cx'), numAttr(shape, 'cy'), numAttr(shape, 'r'), numAttr(shape, 'r'));
            case 'ellipse': return ellipseLoops(numAttr(shape, 'cx'), numAttr(shape, 'cy'), numAttr(shape, 'rx'), numAttr(shape, 'ry'));
            case 'polygon':
            case 'polyline': return pointsLoops(shape);
            case 'line': {
                const x1 = numAttr(shape, 'x1'), y1 = numAttr(shape, 'y1'), x2 = numAttr(shape, 'x2'), y2 = numAttr(shape, 'y2');
                return (Math.hypot(x2 - x1, y2 - y1) > 1e-9)
                    ? [[segLine(x1, y1, x2, y2), segLine(x2, y2, x1, y1)]]   // zero-area: pruned by normalize
                    : [];
            }
            case 'path': return parsePathLoops(shape.getAttribute('d') || '');
            default: return [];
        }
    };

    /* ---- Serialization ---------------------------------------------------------------------- */

    const regionToPathData = (region) => {
        const R = (v) => String(roundCoord(v));                   // shared 4-dp formatter (properties.js)
        const parts = [];
        for (const loop of region) {
            if (!loop.length) continue;
            parts.push('M', R(loop[0].x0), R(loop[0].y0));
            loop.forEach((s, idx) => {
                if (s.line) {
                    if (idx < loop.length - 1) parts.push('L', R(s.x3), R(s.y3));   // final line = the Z
                } else {
                    parts.push('C', R(s.x1), R(s.y1), R(s.x2), R(s.y2), R(s.x3), R(s.y3));
                }
            });
            parts.push('Z');
        }
        return parts.join(' ');
    };

    /* ---- Apply ------------------------------------------------------------------------------- */

    // Selected, Pathfinder-eligible shapes from the live model, in DOCUMENT order (back -> front).
    const pfSelectedMembers = () => {
        if (!globalOptimizedSvg || editSelectedIndices.size < 2) return [];
        const out = [];
        globalOptimizedSvg.querySelectorAll('[data-pf-index]').forEach(shape => {
            if (!editSelectedIndices.has(shape.getAttribute('data-pf-index'))) return;
            if (PF_TAGS.has((shape.tagName || '').toLowerCase())) out.push(shape);
        });
        return out;
    };

    const computeResultRegion = (op, members) => {
        // Every member -> canonical nonzero region in root (viewBox) space.
        const rawRegions = members.map(shape => {
            const P = cumulativeAncestorMatrix(shape, globalOptimizedSvg);
            const own = svgTransformToMatrix(shape.getAttribute('transform') || '');
            const F = P.multiply(own);
            return {
                loops: shapeToLocalLoops(shape).map(loop => loop.map(s => mapSeg(s, F))),
                evenOdd: shape.getAttribute('fill-rule') === 'evenodd'
            };
        });
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        rawRegions.forEach(r => r.loops.forEach(loop => loop.forEach(s => {
            const bb = segBBox(s);
            if (bb.minX < minX) minX = bb.minX;
            if (bb.minY < minY) minY = bb.minY;
            if (bb.maxX > maxX) maxX = bb.maxX;
            if (bb.maxY > maxY) maxY = bb.maxY;
        })));
        if (!(maxX > minX) && !(maxY > minY)) return null;
        const diag = Math.max(1e-6, Math.hypot(maxX - minX, maxY - minY));
        const tol = Math.max(1e-9, diag * 1e-9);
        const vtol = Math.max(1e-6, diag * 1e-5);
        const regions = rawRegions.map(r => normalizeRegion(r.loops, r.evenOdd, tol, diag));

        let R;
        if (op === 'minus-front') {
            let cutter = regions[1];
            for (let k = 2; k < regions.length; k++) cutter = pfBinary(cutter, regions[k], 'union', tol, vtol, diag);
            R = pfBinary(regions[0], cutter, 'subtract', tol, vtol, diag);
        } else {
            const bin = op === 'unite' ? 'union' : op === 'intersect' ? 'intersect' : 'xor';
            R = regions[0];
            for (let k = 1; k < regions.length; k++) R = pfBinary(R, regions[k], bin, tol, vtol, diag);
        }
        return (R && R.length) ? R : null;
    };

    const applyPathfinder = (op) => {
        const members = pfSelectedMembers();
        if (members.length < 2) return;

        window.setHistoryLabel?.(({ 'unite': 'Unite', 'minus-front': 'Minus Front', 'intersect': 'Intersect', 'exclude': 'Exclude' })[op] || 'Pathfinder', 'pathfinder-' + op);

        let region = null;
        try {
            region = computeResultRegion(op, members);
        } catch (err) {
            console.error('Pathfinder: geometry engine failed -- operation cancelled.', err);
            return;
        }
        if (!region) {
            console.warn('Pathfinder: the result would be empty -- operation cancelled.');
            return;                                                // Illustrator-style abort, originals untouched
        }

        // Style donor: topmost member (minus front: the surviving back object). The result path
        // takes its paint attributes, label, id, and z-position; geometry is root-space, so no
        // transform is carried over, and fill-rule is dropped (loops are nonzero-oriented).
        const donor = (op === 'minus-front') ? members[0] : members[members.length - 1];
        const resultPath = document.createElementNS(PF_SVGNS, 'path');
        for (const attr of Array.from(donor.attributes)) {
            if (!PF_SKIP_ATTRS.has(attr.name)) resultPath.setAttribute(attr.name, attr.value);
        }
        resultPath.setAttribute('d', regionToPathData(region));
        const newIndex = window.getNextLayerPfIndex();
        resultPath.setAttribute('data-pf-index', newIndex);

        donor.parentNode.insertBefore(resultPath, donor);
        members.forEach(m => m.remove());

        // Tidy the model like deleteSelectedLayer: drop emptied groups + orphaned generated gradients.
        const wrapper = globalOptimizedSvg.querySelector(':scope > g#ink-wrapper') || globalOptimizedSvg;
        wrapper.querySelectorAll('g').forEach(g => { if (g.id !== 'ink-wrapper' && !g.children.length) g.remove(); });
        const usedIds = new Set();
        globalOptimizedSvg.querySelectorAll('*').forEach(el => {
            ['fill', 'stroke'].forEach(a => {
                const v = el.getAttribute(a);
                if (v && v.includes('url(#')) { const m = v.match(/url\(['"]?#([^)'"]+)['"]?\)/); if (m) usedIds.add(m[1]); }
            });
        });
        const defs = globalOptimizedSvg.querySelector('defs');
        if (defs) {
            Array.from(defs.children).forEach(c => { if (c.id && c.id.startsWith('pf-grad-') && !usedIds.has(c.id)) c.remove(); });
            if (!defs.children.length) defs.remove();
        }

        buildLayersPanel();
        window.selectLayer?.(newIndex);                            // highlight the result's card
        renderOutput(false);
        window.adoptCanvasSelection?.([newIndex]);                 // keep the result selected on canvas
        window.updateAllScrollbars?.();
    };

    /* ---- Buttons ------------------------------------------------------------------------------ */

    const pfButtons = Array.from(document.querySelectorAll('#propsPathfinderGroup [data-pf-op]'));

    // Enabled only with 2+ eligible vector objects in the canvas edit selection, outside the
    // artboard / guide / anchor Properties modes. Called from refreshElementProperties()'s tails.
    window.refreshPathfinderButtons = () => {
        const enabled = !window.isArtboardToolActive?.() && !window.isGuidePropertiesMode?.() && !window.isDirectSelectionAnchorMode?.()
            && pfSelectedMembers().length >= 2;
        pfButtons.forEach(btn => { btn.disabled = !enabled; });
    };

    pfButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            applyPathfinder(btn.getAttribute('data-pf-op'));
        });
    });

    window.refreshPathfinderButtons();
})();
