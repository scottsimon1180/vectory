/* fileName: scissors-tool.js */

// Canvas Scissors Tool (Illustrator-style). Hovering any visible unlocked vector shape reveals
// its outline + anchors; a small screen-space x marks the exact anchor/segment cut point. Clicking
// opens a closed subpath at that point or splits an open subpath into two adjacent path layers.
// Geometry runs through the shared Direct Selection model and the Pen tool's curve hit/split math.

(() => {

    let scissorsActive = false;
    let scissorsHoverIndex = null;
    let scissorsPointer = null;       // { x, y, target } in client px
    let scissorsRaf = 0;
    let scissorsAnimRaf = 0, scissorsAnimUntil = 0;
    let scissorsKeepHoverOnRefresh = false;
    let scissorsDrawnIndex = null, scissorsChromeDirty = true;

    const SCISSORS_GREEN = '#00E676';
    const SCISSORS_W = '1.5';
    const SCISSORS_ANCHOR_PX = 6;
    const SCISSORS_HIT_PX = 6;
    const SCISSORS_X_PX = 8;
    const SVGNS = 'http://www.w3.org/2000/svg';

    const scissorsOverlay = $('scissorsToolOverlay');
    const scissorsPreviewSvg = () => previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    const modelBridge = () => window.dselModelBridge;
    const geometryBridge = () => window.pathEditGeometryBridge;
    const isBlockedTarget = (el) => !!(el && el.closest && el.closest('.canvas-statusbar, .canvas-ruler, .ruler-corner'));

    const scissorsShapeFromTarget = (el, svg = scissorsPreviewSvg()) => {
        const idx = el && el.getAttribute ? el.getAttribute('data-pf-index') : null;
        return (svg && el && el.tagName && el.matches && el.matches(SVG_VECTOR_LAYER_SHAPE_SELECTOR)
            && idx != null && !lockedLayers.has(String(idx)) && svg.contains(el)) ? el : null;
    };

    // Stroke-alignment expansion can place a non-layer ghost over the real shape. elementsFromPoint
    // lets the tool look through that ghost while still choosing the topmost actual editable layer.
    const scissorsShapeAtPoint = (clientX, clientY, eventTarget) => {
        const svg = scissorsPreviewSvg();
        const direct = scissorsShapeFromTarget(eventTarget, svg);
        if (direct) return direct;
        if (!document.elementsFromPoint) return null;
        const stack = document.elementsFromPoint(clientX, clientY);
        for (const el of stack) {
            const shape = scissorsShapeFromTarget(el, svg);
            if (shape) return shape;
        }
        return null;
    };

    const scissorsGlobalShape = (idx) =>
        (globalOptimizedSvg && idx != null) ? globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`) : null;

    const scissorsAreaMetrics = () => {
        const areaRect = previewArea.getBoundingClientRect();
        const areaStyle = getComputedStyle(previewArea);
        const borderL = parseFloat(areaStyle.borderLeftWidth) || 0;
        const borderT = parseFloat(areaStyle.borderTopWidth) || 0;
        return {
            areaRect, borderL, borderT,
            areaW: areaRect.width - borderL - (parseFloat(areaStyle.borderRightWidth) || 0),
            areaH: areaRect.height - borderT - (parseFloat(areaStyle.borderBottomWidth) || 0)
        };
    };

    const scissorsClientToOverlay = (clientX, clientY) => {
        const m = scissorsAreaMetrics();
        return { x: clientX - m.areaRect.left - m.borderL, y: clientY - m.areaRect.top - m.borderT };
    };

    // Projection matrix: viewBox-root coords -> #scissorsToolOverlay screen px.
    const scissorsScreenMatrix = () => {
        const svg = scissorsPreviewSvg();
        if (!svg || !scissorsOverlay) return null;
        const m = scissorsAreaMetrics();
        const svgRect = svg.getBoundingClientRect();
        const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
        let vbX = 0, vbY = 0;
        let vbW = parseFloat(svg.dataset.nativeW) || 128;
        let vbH = parseFloat(svg.dataset.nativeH) || 128;
        if (vb) {
            const p = vb.trim().split(/[\s,]+/);
            if (p.length === 4) {
                vbX = parseFloat(p[0]) || 0; vbY = parseFloat(p[1]) || 0;
                vbW = parseFloat(p[2]) || vbW; vbH = parseFloat(p[3]) || vbH;
            }
        }
        if (m.areaW <= 0 || m.areaH <= 0 || vbW <= 0 || vbH <= 0 || svgRect.width <= 0 || svgRect.height <= 0) return null;

        scissorsOverlay.setAttribute('viewBox', `0 0 ${m.areaW} ${m.areaH}`);
        scissorsOverlay.setAttribute('width', m.areaW);
        scissorsOverlay.setAttribute('height', m.areaH);

        return new DOMMatrix()
            .translate(svgRect.left - m.areaRect.left - m.borderL, svgRect.top - m.areaRect.top - m.borderT)
            .scale(svgRect.width / vbW, svgRect.height / vbH)
            .translate(-vbX, -vbY);
    };

    const scissorsGeom = (idx) => {
        const svg = scissorsPreviewSvg();
        const previewShape = (svg && idx != null) ? svg.querySelector(`[data-pf-index="${idx}"]`) : null;
        if (!svg || !previewShape) return null;
        const P = cumulativeAncestorMatrix(previewShape, svg);
        const own = svgTransformToMatrix(previewShape.getAttribute('transform') || '');
        const F = P.multiply(own);
        if (![F.a, F.b, F.c, F.d, F.e, F.f].every(Number.isFinite)) return null;
        return { svg, previewShape, F };
    };

    const hideScissorsOverlay = () => {
        if (scissorsRaf) { cancelAnimationFrame(scissorsRaf); scissorsRaf = 0; }
        if (scissorsAnimRaf) { cancelAnimationFrame(scissorsAnimRaf); scissorsAnimRaf = 0; }
        scissorsAnimUntil = 0;
        scissorsDrawnIndex = null;
        scissorsChromeDirty = true;
        if (!scissorsOverlay) return;
        if (scissorsOverlay.hasAttribute('hidden') && !scissorsOverlay.children.length) return;
        scissorsOverlay.replaceChildren();
        scissorsOverlay.toggleAttribute('hidden', true);
    };

    const clearScissorsHover = () => {
        scissorsHoverIndex = null;
        scissorsPointer = null;
        hideScissorsOverlay();
    };

    window.clearScissorsToolHover = clearScissorsHover;
    window.clearScissorsToolOverlay = hideScissorsOverlay;

    const scissorsHitData = (idx, clientX, clientY, screenMatrix) => {
        const g = scissorsGeom(idx);
        const globalShape = scissorsGlobalShape(idx);
        const bridge = modelBridge();
        const geometry = geometryBridge();
        if (!g || !globalShape || !bridge || !geometry || lockedLayers.has(String(idx))) return null;
        const model = bridge.getModel(globalShape, idx);
        if (!model) return null;

        const clientPoint = scissorsClientToOverlay(clientX, clientY);
        const anchorHit = geometry.nearestAnchor(model, g, clientX, clientY, screenMatrix, clientPoint);
        let hit = null;
        let near = false;
        let endpointBlocked = false;

        // Anchors win over nearby segments. Existing endpoints of an open subpath are shown but
        // deliberately invalid, matching Illustrator's no-op endpoint behavior.
        if (anchorHit && anchorHit.distPx <= SCISSORS_HIT_PX) {
            const sub = model.subpaths[anchorHit.sub];
            const anchor = sub && sub.anchors[anchorHit.ai];
            if (anchor) {
                near = true;
                endpointBlocked = (sub.closed && sub.anchors.length < 2)
                    || (!sub.closed && (anchorHit.ai === 0 || anchorHit.ai === sub.anchors.length - 1));
                if (!endpointBlocked) {
                    hit = {
                        kind: 'anchor', sub: anchorHit.sub, ai: anchorHit.ai,
                        point: { x: anchor.x, y: anchor.y }, distPx: anchorHit.distPx
                    };
                }
            }
        }

        if (!hit && !endpointBlocked) {
            const segmentHit = geometry.nearestOnModel(model, g, clientX, clientY, screenMatrix, clientPoint);
            if (segmentHit && segmentHit.distPx <= SCISSORS_HIT_PX) {
                const sub = model.subpaths[segmentHit.sub];
                const A = sub && sub.anchors;
                const a = A && A[segmentHit.seg];
                const b = A && A[(segmentHit.seg + 1) % A.length];
                if (a && b) {
                    near = true;
                    hit = {
                        kind: 'segment', sub: segmentHit.sub, seg: segmentHit.seg,
                        t: segmentHit.t, point: geometry.segmentPoint(a, b, segmentHit.t),
                        distPx: segmentHit.distPx
                    };
                }
            }
        }

        return { idx: String(idx), g, globalShape, model, hit, near };
    };

    const scissorsResolveTarget = (screenMatrix) => {
        if (!scissorsPointer || isBlockedTarget(scissorsPointer.target)) return null;
        const directShape = scissorsShapeAtPoint(scissorsPointer.x, scissorsPointer.y, scissorsPointer.target);
        const directIdx = directShape ? directShape.getAttribute('data-pf-index') : null;
        const idx = directIdx != null ? String(directIdx) : scissorsHoverIndex;
        if (idx == null) return null;
        const data = scissorsHitData(idx, scissorsPointer.x, scissorsPointer.y, screenMatrix);
        if (!data || (directIdx == null && !data.near)) return null;
        scissorsHoverIndex = String(idx);
        return data;
    };

    const scissorsDrawOutline = (data, screenMatrix) => {
        const outline = data.g.previewShape.cloneNode(false);
        ['id', 'data-pf-index', 'data-pf-default-fill', 'class', 'style', 'clip-path', 'mask', 'filter',
         'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dasharray'].forEach(a => outline.removeAttribute(a));
        const full = screenMatrix.multiply(data.g.F);
        if (full.isIdentity) outline.removeAttribute('transform');
        else outline.setAttribute('transform', matrixToString(full));
        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', SCISSORS_GREEN);
        outline.setAttribute('stroke-width', SCISSORS_W);
        outline.setAttribute('vector-effect', 'non-scaling-stroke');
        outline.setAttribute('stroke-linecap', 'round');
        outline.setAttribute('stroke-linejoin', 'round');
        outline.setAttribute('pointer-events', 'none');
        scissorsOverlay.appendChild(outline);
    };

    const scissorsDrawAnchors = (data, screenMatrix) => {
        const full = screenMatrix.multiply(data.g.F);
        const half = SCISSORS_ANCHOR_PX / 2;
        data.model.subpaths.forEach(sub => sub.anchors.forEach(a => {
            const p = full.transformPoint(new DOMPoint(a.x, a.y));
            const r = document.createElementNS(SVGNS, 'rect');
            r.setAttribute('x', p.x - half); r.setAttribute('y', p.y - half);
            r.setAttribute('width', SCISSORS_ANCHOR_PX); r.setAttribute('height', SCISSORS_ANCHOR_PX);
            r.setAttribute('fill', '#ffffff');
            r.setAttribute('stroke', SCISSORS_GREEN);
            r.setAttribute('stroke-width', '1');
            r.setAttribute('pointer-events', 'none');
            scissorsOverlay.appendChild(r);
        }));
    };

    const scissorsDrawCutMarker = (data, screenMatrix) => {
        if (!data.hit || !data.hit.point) return;
        const full = screenMatrix.multiply(data.g.F);
        const p = full.transformPoint(new DOMPoint(data.hit.point.x, data.hit.point.y));
        const half = SCISSORS_X_PX / 2;
        const d = `M ${p.x - half} ${p.y - half} L ${p.x + half} ${p.y + half} M ${p.x + half} ${p.y - half} L ${p.x - half} ${p.y + half}`;
        const draw = (stroke, width) => {
            const x = document.createElementNS(SVGNS, 'path');
            x.setAttribute('d', d);
            x.setAttribute('fill', 'none');
            x.setAttribute('stroke', stroke);
            x.setAttribute('stroke-width', width);
            x.setAttribute('stroke-linecap', 'round');
            x.setAttribute('pointer-events', 'none');
            x.setAttribute('data-scissors-marker', '');
            scissorsOverlay.appendChild(x);
        };
        draw('rgba(0,0,0,0.72)', '3.5');
        draw(SCISSORS_GREEN, SCISSORS_W);
    };

    const redrawScissorsOverlay = () => {
        if (!scissorsActive || !scissorsOverlay || !scissorsPointer) { hideScissorsOverlay(); return; }
        const screenMatrix = scissorsScreenMatrix();
        if (!screenMatrix) { hideScissorsOverlay(); return; }
        const data = scissorsResolveTarget(screenMatrix);
        if (!data) {
            scissorsHoverIndex = null;
            scissorsOverlay.replaceChildren();
            scissorsOverlay.toggleAttribute('hidden', true);
            scissorsDrawnIndex = null;
            scissorsChromeDirty = true;
            return;
        }
        if (scissorsChromeDirty || scissorsDrawnIndex !== data.idx) {
            scissorsOverlay.replaceChildren();
            scissorsDrawOutline(data, screenMatrix);
            scissorsDrawAnchors(data, screenMatrix);
            scissorsDrawnIndex = data.idx;
            scissorsChromeDirty = false;
        } else {
            scissorsOverlay.querySelectorAll('[data-scissors-marker]').forEach(el => el.remove());
        }
        scissorsDrawCutMarker(data, screenMatrix);
        scissorsOverlay.toggleAttribute('hidden', !scissorsOverlay.children.length);
    };

    const queueScissorsRedraw = () => {
        if (scissorsRaf || scissorsAnimRaf) return;
        scissorsRaf = requestAnimationFrame(() => {
            scissorsRaf = 0;
            redrawScissorsOverlay();
        });
    };

    const scissorsCloneAnchor = (a) => ({
        x: a.x, y: a.y,
        hIn: a.hIn ? { ...a.hIn } : null,
        hOut: a.hOut ? { ...a.hOut } : null
    });

    // One cut on a closed path opens it in place: the cut anchor becomes two coincident endpoints.
    const scissorsOpenClosedSubpath = (sub, cutAi) => {
        const A = sub.anchors;
        const ordered = A.slice(cutAi).concat(A.slice(0, cutAi)).map(scissorsCloneAnchor);
        if (!ordered.length) return false;
        ordered[0].hIn = null;
        const end = scissorsCloneAnchor(A[cutAi]);
        end.hOut = null;
        ordered.push(end);
        sub.anchors = ordered;
        sub.closed = false;
        return true;
    };

    // An internal cut on an open path produces two independent open subpaths with coincident
    // endpoints. Untouched compound-path subpaths remain on the original layer.
    const scissorsSplitOpenSubpath = (sub, cutAi) => {
        if (cutAi <= 0 || cutAi >= sub.anchors.length - 1) return null;
        const left = { closed: false, anchors: sub.anchors.slice(0, cutAi + 1).map(scissorsCloneAnchor) };
        const right = { closed: false, anchors: sub.anchors.slice(cutAi).map(scissorsCloneAnchor) };
        left.anchors[left.anchors.length - 1].hOut = null;
        right.anchors[0].hIn = null;
        return { left, right };
    };

    const scissorsLayerName = (shape, idx) => {
        const card = layersList.querySelector(`.layer-item[data-pf-index="${idx}"] .layer-title`);
        return (card && card.textContent.trim()) || resolveLayerName(shape, 0) || 'Path';
    };

    const scissorsSelectAffected = (indices, scrollIdx, rebuild) => {
        if (rebuild) buildLayersPanel();
        window.setEditSelectionSet?.(indices);
        window.setLayerSelectionSet?.(indices);
        if (scrollIdx != null) {
            const card = layersList.querySelector(`.layer-item[data-pf-index="${scrollIdx}"]`);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    };

    const scissorsCut = (data, e) => {
        const bridge = modelBridge();
        const geometry = geometryBridge();
        const hit = data && data.hit;
        if (!bridge || !geometry || !hit || !globalOptimizedSvg) return false;

        const idx = String(data.idx);
        let globalShape = scissorsGlobalShape(idx);
        const model = globalShape ? bridge.getModel(globalShape, idx) : null;
        if (!globalShape || !model || !model.subpaths[hit.sub]) return false;

        const sourceSub = model.subpaths[hit.sub];
        if (!sourceSub.closed) {
            if (hit.kind === 'anchor' && (hit.ai === 0 || hit.ai === sourceSub.anchors.length - 1)) return false;
            const lastSeg = sourceSub.anchors.length - 2;
            if (hit.kind === 'segment' && ((hit.seg === 0 && hit.t <= 1e-5) || (hit.seg === lastSeg && hit.t >= 1 - 1e-5))) return false;
        }

        const sourceName = scissorsLayerName(globalShape, idx);
        let converted = false;
        if (model.kind !== 'path') {
            globalShape = bridge.convertToPath(globalShape, model);
            converted = true;
        }
        // Illustrator resets non-center stroke alignment when a cut makes the geometry open.
        globalShape.removeAttribute('data-stroke-align');

        let cutAi;
        if (hit.kind === 'segment') {
            geometry.insertAnchor(model, hit);
            cutAi = hit.seg + 1;
        } else {
            cutAi = hit.ai;
        }

        const sub = model.subpaths[hit.sub];
        if (!sub || !sub.anchors[cutAi]) return false;

        let newIdx = null;
        if (sub.closed) {
            if (!scissorsOpenClosedSubpath(sub, cutAi)) return false;
            bridge.writeGeometry(globalShape, model);
        } else {
            const pieces = scissorsSplitOpenSubpath(sub, cutAi);
            if (!pieces) return false;
            model.subpaths[hit.sub] = pieces.left;

            const newPath = globalShape.cloneNode(false);
            newIdx = window.getNextLayerPfIndex ? window.getNextLayerPfIndex() : '0';
            newPath.removeAttribute('id');
            newPath.setAttribute('data-pf-index', newIdx);
            newPath.setAttribute('data-pf-label', `${sourceName} - Cut`);
            globalShape.parentNode.insertBefore(newPath, globalShape.nextSibling);

            bridge.writeGeometry(globalShape, model);
            bridge.writeGeometry(newPath, { kind: 'path', needsConversion: false, subpaths: [pieces.right] });
        }

        const affected = newIdx == null ? [idx] : [idx, String(newIdx)];
        scissorsSelectAffected(affected, newIdx == null ? idx : newIdx, converted || newIdx != null);

        scissorsHoverIndex = String(newIdx == null ? idx : newIdx);
        scissorsPointer = { x: e.clientX, y: e.clientY, target: null };
        scissorsKeepHoverOnRefresh = true;
        window.setHistoryLabel?.('Cut Path', 'scissors-tool');
        renderOutput(false);
        window.updateAllScrollbars?.();
        return true;
    };

    previewArea.addEventListener('pointermove', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!scissorsActive || window.isHandToolTemporaryPan?.()) return;
        if (isBlockedTarget(e.target)) { clearScissorsHover(); return; }
        scissorsPointer = { x: e.clientX, y: e.clientY, target: e.target };
        queueScissorsRedraw();
    });

    previewArea.addEventListener('pointerleave', () => {
        if (scissorsActive && !window.isHandToolTemporaryPan?.()) clearScissorsHover();
    });

    previewArea.addEventListener('pointerdown', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!scissorsActive || e.button !== 0 || window.isHandToolTemporaryPan?.() || isBlockedTarget(e.target)) return;
        scissorsPointer = { x: e.clientX, y: e.clientY, target: e.target };
        const screenMatrix = scissorsScreenMatrix();
        const data = screenMatrix ? scissorsResolveTarget(screenMatrix) : null;
        if (!data || !data.hit) { queueScissorsRedraw(); return; }
        e.preventDefault();
        scissorsCut(data, e);
    });

    /* ==== Renderer / import hooks =========================================================== */

    window.syncScissorsToolOverlay = (animate = false) => {
        if (window.isGuideDragActive?.()) { hideScissorsOverlay(); return; }
        if (!scissorsActive || !scissorsPointer) { hideScissorsOverlay(); return; }
        scissorsChromeDirty = true;
        if (animate) {
            scissorsAnimUntil = performance.now() + VIEW_TRANSITION_MS + 40;
            const tick = () => {
                scissorsChromeDirty = true;
                redrawScissorsOverlay();
                if (performance.now() < scissorsAnimUntil) scissorsAnimRaf = requestAnimationFrame(tick);
                else scissorsAnimRaf = 0;
            };
            if (!scissorsAnimRaf) scissorsAnimRaf = requestAnimationFrame(tick);
            return;
        }
        queueScissorsRedraw();
    };

    window.refreshScissorsToolOverlay = () => {
        if (window.isGuideDragActive?.()) { hideScissorsOverlay(); return; }
        if (!scissorsActive) { hideScissorsOverlay(); return; }
        if (!scissorsKeepHoverOnRefresh) { clearScissorsHover(); return; }
        scissorsKeepHoverOnRefresh = false;
        scissorsChromeDirty = true;
        if (scissorsRaf) { cancelAnimationFrame(scissorsRaf); scissorsRaf = 0; }
        if (scissorsAnimRaf) { cancelAnimationFrame(scissorsAnimRaf); scissorsAnimRaf = 0; scissorsAnimUntil = 0; }
        redrawScissorsOverlay();
    };

    window.clearScissorsToolState = clearScissorsHover;

    /* ==== Activation / shortcut ============================================================= */

    const scissorsDeactivate = () => {
        scissorsActive = false;
        $('btnScissorsTool')?.classList.remove('active');
        previewArea.classList.remove('scissors-active');
        scissorsKeepHoverOnRefresh = false;
        clearScissorsHover();
    };

    window.deactivateScissorsTool = () => { if (scissorsActive) scissorsDeactivate(); };

    window.toggleScissorsTool = (btn) => {
        if (scissorsActive) { scissorsDeactivate(); return; }
        window.deactivateSelectionTool?.();
        window.deactivateDirectSelectionTool?.();
        window.deactivateHandTool?.();
        window.deactivateArtboardTool?.();
        window.deactivateShapeTool?.();
        window.deactivatePenTool?.();
        scissorsActive = true;
        (btn || $('btnScissorsTool'))?.classList.add('active');
        previewArea.classList.add('scissors-active');
    };

    document.addEventListener('keydown', (e) => {
        if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !e.repeat
            && !scissorsActive && globalOptimizedSvg && !isTextInputFocused() && !isEyedropperMode) {
            e.preventDefault();
            window.toggleScissorsTool();
            return;
        }
        if (e.key === 'Escape' && scissorsActive && !isEyedropperMode) scissorsDeactivate();
    });

})();
