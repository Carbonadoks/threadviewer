
from __future__ import annotations

import json
import random
import math
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from shapely.geometry import box, Polygon, MultiPolygon, GeometryCollection
from shapely.ops import unary_union
from PIL import Image, ImageDraw, ImageFont

OUT = Path("/mnt/data")
PNG = OUT / "orl_clean_band_layouts_3x3.png"
SVG = OUT / "orl_clean_band_layouts_3x3.svg"
JSON_PATH = OUT / "orl_clean_band_layouts_3x3.orl.json"

# =============================================================================
# ORL-CLEAN-BAND-1.0
# =============================================================================
#
# This version is a deliberately constrained page language:
#
# - The central white main content is a simple rectangle.
# - The page is built from nested rectangular bands.
# - The inner band is split into four meaningful corner-wrap L regions,
#   so no single commentary owns an entire edge of the main content.
# - The next band may merge radially with an inner L region, allowing a section
#   to span two rings for a reason.
# - Outer apparatus is mostly straight shelves/rails.
# - Regions are rectangles or single-corner L shapes. No U-shapes.
# - Adjacent sections never interlock with jagged/random boundaries.
#
# The key idea:
#   Shells are structural, but regions are semantic territories.
#   A territory may be:
#     rect
#     L_arc(layer)
#     L_arc(layer) + L_arc(layer+1)  # radial span
#
# Disallowed:
#   random-walk polyominoes
#   U-shaped brackets
#   multi-step interlocking seams

PAGE_BG = "#ECE6D8"
TILE_BG = "#FBF7ED"
BORDER = "#151515"
CORE = "C"

@dataclass(frozen=True)
class Role:
    code: str
    name: str
    color: str
    layer_hint: str

ROLES: Dict[str, Role] = {
    "C": Role("C", "main content", "#FFFFFF", "core"),

    # direct, touching main content
    "G": Role("G", "direct gloss", "#4B9ED0", "inner"),
    "S": Role("S", "direct source", "#59B96B", "inner"),
    "D": Role("D", "direct dispute", "#E69A38", "inner"),
    "A": Role("A", "direct application", "#9D70C8", "inner"),

    # second band / commentary-on-commentary
    "H": Role("H", "supergloss", "#86BFE0", "middle"),
    "K": Role("K", "source apparatus", "#A7D86F", "middle"),
    "V": Role("V", "variant / correction", "#F2B567", "middle"),
    "N": Role("N", "note on application", "#C08BE2", "middle"),

    # outer apparatus shelves
    "P": Role("P", "provenance shelf", "#69C7B7", "outer"),
    "R": Role("R", "parallel refs", "#D7BE63", "outer"),
    "Y": Role("Y", "backlink index", "#C989AD", "outer"),
    "M": Role("M", "editorial meta", "#A9B0B2", "outer"),
    "U": Role("U", "outer source rail", "#B7DDD4", "outer"),
    "W": Role("W", "outer bibliography", "#E4D99A", "outer"),
    "X": Role("X", "outer cross-index", "#D9B4C9", "outer"),
    "Z": Role("Z", "outer errata", "#C9CFD0", "outer"),
}

DIRECT_CODES = {"NW": "G", "NE": "S", "SE": "D", "SW": "A"}
SECOND_CODES = {"NW": "H", "NE": "K", "SE": "V", "SW": "N"}

# The page-side apparatus roles are assigned per side.
OUTER_SIDE_CODES = {
    "N": ["P", "U", "R", "W"],
    "E": ["R", "W", "Y", "X"],
    "S": ["Y", "X", "M", "Z"],
    "W": ["M", "Z", "P", "U"],
}

Rect = Tuple[float, float, float, float]

def B(r: Rect):
    x1, y1, x2, y2 = r
    return box(x1, y1, x2, y2)

def clean_union(parts):
    if not parts:
        return GeometryCollection()
    return unary_union(parts).buffer(0)

def add(territories: Dict[str, List], code: str, geom) -> None:
    if geom.is_empty:
        return
    territories.setdefault(code, []).append(geom)

def nested_rects(rng: random.Random) -> Dict[str, Rect]:
    # Slightly off-center / variable proportions, but still central and readable.
    cx = rng.uniform(0.48, 0.52)
    cy = rng.uniform(0.48, 0.52)
    cw = rng.uniform(0.28, 0.36)
    ch = rng.uniform(0.26, 0.34)

    core = (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2)

    # Three rings with asymmetric thicknesses. Direct band is often wider because
    # that is where the main commentary lives.
    l1 = rng.uniform(0.085, 0.13)
    r1 = rng.uniform(0.085, 0.13)
    t1 = rng.uniform(0.075, 0.12)
    b1 = rng.uniform(0.075, 0.12)

    l2 = rng.uniform(0.06, 0.10)
    r2 = rng.uniform(0.06, 0.10)
    t2 = rng.uniform(0.055, 0.095)
    b2 = rng.uniform(0.055, 0.095)

    l3 = rng.uniform(0.055, 0.09)
    r3 = rng.uniform(0.055, 0.09)
    t3 = rng.uniform(0.05, 0.08)
    b3 = rng.uniform(0.05, 0.08)

    d = (core[0] - l1, core[1] - t1, core[2] + r1, core[3] + b1)
    m = (d[0] - l2, d[1] - t2, d[2] + r2, d[3] + b2)
    o = (m[0] - l3, m[1] - t3, m[2] + r3, m[3] + b3)

    # Clamp the outer frame inside page with a uniform page margin.
    margin = rng.uniform(0.025, 0.04)
    dx_left = max(0, margin - o[0])
    dx_right = max(0, o[2] - (1 - margin))
    dy_top = max(0, margin - o[1])
    dy_bottom = max(0, o[3] - (1 - margin))

    shift_x = dx_left - dx_right
    shift_y = dy_top - dy_bottom

    def shift(r):
        return (r[0] + shift_x, r[1] + shift_y, r[2] + shift_x, r[3] + shift_y)

    return {
        "core": shift(core),
        "direct_outer": shift(d),
        "middle_outer": shift(m),
        "apparatus_outer": shift(o),
        "page": (margin, margin, 1 - margin, 1 - margin),
    }

def split_positions(inner: Rect, outer: Rect, rng: random.Random, jitter: float = 0.12) -> Dict[str, float]:
    # Split each side near the center of the corresponding inner edge.
    # These splits ensure the main content edge is not owned by one region.
    ix1, iy1, ix2, iy2 = inner
    ox1, oy1, ox2, oy2 = outer

    def j(a, b):
        mid = (a + b) / 2
        span = b - a
        return max(a + 0.30 * span, min(b - 0.30 * span, mid + rng.uniform(-jitter, jitter) * span))

    return {
        "top_x": j(ix1, ix2),
        "bottom_x": j(ix1, ix2),
        "left_y": j(iy1, iy2),
        "right_y": j(iy1, iy2),
    }

def ring_arcs(inner: Rect, outer: Rect, splits: Dict[str, float]) -> Dict[str, object]:
    ix1, iy1, ix2, iy2 = inner
    ox1, oy1, ox2, oy2 = outer
    tx = splits["top_x"]
    bx = splits["bottom_x"]
    ly = splits["left_y"]
    ry = splits["right_y"]

    # Four corner-wrap L arcs. Each is a union of one horizontal band segment
    # and one vertical band segment. No U shapes.
    NW = clean_union([
        B((ox1, oy1, tx, iy1)),        # top-left band segment
        B((ox1, iy1, ix1, ly)),        # left-upper band segment
    ])
    NE = clean_union([
        B((tx, oy1, ox2, iy1)),        # top-right band segment
        B((ix2, iy1, ox2, ry)),        # right-upper band segment
    ])
    SE = clean_union([
        B((ix2, ry, ox2, iy2)),        # right-lower band segment
        B((bx, iy2, ox2, oy2)),        # bottom-right band segment
    ])
    SW = clean_union([
        B((ox1, iy2, bx, oy2)),        # bottom-left band segment
        B((ox1, ly, ix1, iy2)),        # left-lower band segment
    ])
    return {"NW": NW, "NE": NE, "SE": SE, "SW": SW}

def outer_shelves(inner: Rect, outer: Rect) -> Dict[str, object]:
    ix1, iy1, ix2, iy2 = inner
    ox1, oy1, ox2, oy2 = outer
    # Simple shelves/rails. Corners belong to top/bottom shelves; left/right rails
    # exclude them. This keeps seams straight.
    return {
        "N": B((ox1, oy1, ox2, iy1)),
        "E": B((ix2, iy1, ox2, iy2)),
        "S": B((ox1, iy2, ox2, oy2)),
        "W": B((ox1, iy1, ix1, iy2)),
    }

def geom_parts(geom):
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]

def polygon_to_svg_path(poly: Polygon, sx: float, sy: float, ox: float, oy: float) -> str:
    coords = list(poly.exterior.coords)
    if not coords:
        return ""
    cmds = []
    for i, (x, y) in enumerate(coords):
        px = ox + x * sx
        py = oy + y * sy
        cmds.append(("M" if i == 0 else "L") + f"{px:.2f},{py:.2f}")
    cmds.append("Z")
    for ring in poly.interiors:
        pts = list(ring.coords)
        for i, (x, y) in enumerate(pts):
            px = ox + x * sx
            py = oy + y * sy
            cmds.append(("M" if i == 0 else "L") + f"{px:.2f},{py:.2f}")
        cmds.append("Z")
    return " ".join(cmds)

def geom_label_point(geom) -> Tuple[float, float]:
    # Representative point is guaranteed inside.
    p = geom.representative_point()
    return p.x, p.y

def complexity_stats(geom) -> Dict[str, int]:
    # Count rough polygon complexity for manifest validation. These layouts are
    # generated from rectangles and simple L unions, so the count stays low.
    polygons = geom_parts(geom)
    vertices = 0
    holes = 0
    for p in polygons:
        vertices += max(0, len(p.exterior.coords) - 1)
        holes += len(p.interiors)
    return {"polygon_count": len(polygons), "vertices": vertices, "holes": holes}

def make_layout(seed: int) -> Dict:
    rng = random.Random(seed)
    rects = nested_rects(rng)

    territories: Dict[str, List] = {}
    add(territories, CORE, B(rects["core"]))

    # Ring 1: direct commentary touching the main content.
    direct_splits = split_positions(rects["core"], rects["direct_outer"], rng)
    direct_arcs = ring_arcs(rects["core"], rects["direct_outer"], direct_splits)

    # Ring 2: commentary-on-commentary. Some arcs can merge radially with
    # direct commentary so a region spans two rings.
    second_splits = split_positions(rects["direct_outer"], rects["middle_outer"], rng, jitter=0.18)
    second_arcs = ring_arcs(rects["direct_outer"], rects["middle_outer"], second_splits)

    # Choose which direct territories span into the second band.
    quads = ["NW", "NE", "SE", "SW"]
    rng.shuffle(quads)
    span_count = rng.choice([1, 2, 2, 3])
    radial_spans = set(quads[:span_count])

    for q in ["NW", "NE", "SE", "SW"]:
        direct_code = DIRECT_CODES[q]
        add(territories, direct_code, direct_arcs[q])
        if q in radial_spans:
            add(territories, direct_code, second_arcs[q])
        else:
            add(territories, SECOND_CODES[q], second_arcs[q])

    # Ring 3: mostly straight shelves/rails. Sometimes a middle-only territory
    # spans outward into the apparatus layer, but only if it was not already
    # merged into the direct layer. This creates "margin-to-margin" hierarchy
    # without U-shaped brackets.
    apparatus = outer_shelves(rects["middle_outer"], rects["apparatus_outer"])
    side_order = ["N", "E", "S", "W"]
    side_to_quad = {"N": "NW", "E": "NE", "S": "SE", "W": "SW"}
    rng.shuffle(side_order)

    outer_span_sides = set(side_order[:rng.choice([0, 1, 1, 2])])
    side_variant = rng.randrange(4)

    for side in ["N", "E", "S", "W"]:
        q = side_to_quad[side]
        if side in outer_span_sides and q not in radial_spans:
            # Merge the shelf with a second-layer territory, giving a larger
            # outer apparatus block that is still not touching the main content.
            code = SECOND_CODES[q]
        else:
            choices = OUTER_SIDE_CODES[side]
            code = choices[side_variant % len(choices)]
        add(territories, code, apparatus[side])

    # Merge per code.
    merged = {code: clean_union(parts) for code, parts in territories.items()}

    # Manifest stats and geometric sanity checks.
    stats = {}
    for code, geom in merged.items():
        cstats = complexity_stats(geom)
        stats[code] = {
            "name": ROLES[code].name,
            "area": round(float(geom.area), 5),
            **cstats,
            "touches_main_content": bool(code != CORE and geom.touches(merged[CORE])),
        }

    # Core side ownership: every side is split across two direct territories.
    # In geometry terms, this is guaranteed by the split construction above.
    constraints = {
        "main_content_is_white": True,
        "main_content_is_a_single_rectangle": True,
        "main_content_is_central": True,
        "main_content_does_not_touch_exterior": True,
        "inner_edge_is_split_by_direct_commentaries": True,
        "territories_may_span_two_bands": True,
        "outer_apparatus_mostly_straight_shelves": True,
        "u_shapes_disallowed_by_construction": True,
        "jagged_random_walk_edges_disallowed_by_construction": True,
        "all_boundaries_are_axis_aligned": True,
    }

    relations = []
    for code in sorted(merged.keys()):
        if code == CORE:
            continue
        if code in "GSDA":
            to = "C"
        elif code in "HKVN":
            to = {"H": "G", "K": "S", "V": "D", "N": "A"}[code]
        else:
            to = ["middle apparatus", "nearest commentary"]
        relations.append({"from": code, "to": to, "type": ROLES[code].name})

    return {
        "language": "ORL-CLEAN-BAND-1.0",
        "seed": seed,
        "rectangles": {k: [round(v, 5) for v in vals] for k, vals in rects.items()},
        "direct_splits": {k: round(v, 5) for k, v in direct_splits.items()},
        "second_splits": {k: round(v, 5) for k, v in second_splits.items()},
        "radial_spans": sorted(radial_spans),
        "territories": {
            code: {
                "role": asdict(ROLES[code]),
                "wkt": merged[code].wkt,
                "stats": stats[code],
            }
            for code in sorted(merged.keys())
        },
        "relations": relations,
        "constraints": constraints,
    }

def load_geoms(layout: Dict) -> Dict[str, object]:
    from shapely import wkt
    return {code: wkt.loads(data["wkt"]) for code, data in layout["territories"].items()}

def render_svg(layouts: List[Dict], path: Path) -> None:
    tile = 350
    pad = 18
    gap = 28
    legend_h = 135
    width = pad * 2 + tile * 3 + gap * 2
    height = pad * 2 + tile * 3 + gap * 2 + legend_h
    draw = 306

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        f'<rect width="100%" height="100%" fill="{PAGE_BG}"/>',
        '<style>',
        'text{font-family:Inter,Arial,sans-serif;font-weight:800;dominant-baseline:middle;text-anchor:middle;}',
        '.title{font-size:12px;text-anchor:start;font-weight:850;}',
        '.subtitle{font-size:9px;text-anchor:start;font-weight:750;}',
        '.code{font-size:12px;}',
        '.main{font-size:14px;font-weight:900;}',
        '.legend{font-size:10.5px;text-anchor:start;font-weight:750;}',
        '</style>'
    ]

    for i, layout in enumerate(layouts):
        row, col = divmod(i, 3)
        x0 = pad + col * (tile + gap)
        y0 = pad + row * (tile + gap)
        ox = x0 + (tile - draw) / 2
        oy = y0 + 30
        geoms = load_geoms(layout)

        span = ", ".join(layout["radial_spans"]) if layout["radial_spans"] else "none"
        parts.append(f'<g transform="translate({x0},{y0})">')
        parts.append(f'<rect x="0" y="0" width="{tile}" height="{tile}" fill="{TILE_BG}" stroke="{BORDER}" stroke-width="2"/>')
        parts.append(f'<text class="title" x="10" y="13" fill="#111">ORL-CLEAN-BAND seed {layout["seed"]}</text>')
        parts.append(f'<text class="subtitle" x="10" y="27" fill="#444">two-band spans: {span}</text>')

        # Draw fills first.
        draw_order = [c for c in sorted(geoms.keys()) if c != CORE] + [CORE]
        for code in draw_order:
            geom = geoms[code]
            color = ROLES[code].color
            for poly in geom_parts(geom):
                d = polygon_to_svg_path(poly, draw, draw, ox - x0, oy - y0)
                parts.append(f'<path d="{d}" fill="{color}" stroke="none" fill-rule="evenodd"/>')

        # Then draw clean boundaries.
        for code in draw_order:
            geom = geoms[code]
            for poly in geom_parts(geom):
                d = polygon_to_svg_path(poly, draw, draw, ox - x0, oy - y0)
                sw = "3" if code == CORE else "1.9"
                parts.append(f'<path d="{d}" fill="none" stroke="{BORDER}" stroke-width="{sw}" fill-rule="evenodd"/>')

        # Labels.
        for code in draw_order:
            geom = geoms[code]
            x, y = geom_label_point(geom)
            label = "MAIN" if code == CORE else code
            cls = "main" if code == CORE else "code"
            parts.append(
                f'<text class="{cls}" x="{ox - x0 + x * draw:.2f}" y="{oy - y0 + y * draw:.2f}" fill="#111">{label}</text>'
            )

        parts.append("</g>")

    # Legend with only roles that appeared.
    used = sorted({code for layout in layouts for code in layout["territories"]}, key=lambda c: (ROLES[c].layer_hint, c))
    entries = [(CORE, "MAIN = protected white core")] + [(c, f"{c} = {ROLES[c].name}") for c in used if c != CORE]
    col_w = (width - 2 * pad) / 4
    base_y = pad + 3 * tile + 2 * gap + 28
    parts.append("<g>")
    for idx, (code, label) in enumerate(entries):
        c = idx % 4
        r = idx // 4
        x = pad + c * col_w
        y = base_y + r * 23
        parts.append(f'<rect x="{x}" y="{y-8}" width="16" height="16" fill="{ROLES[code].color}" stroke="{BORDER}" stroke-width="1"/>')
        parts.append(f'<text class="legend" x="{x+22}" y="{y}" fill="#111">{label}</text>')
    parts.append("</g>")
    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")

def draw_shapely(draw_ctx, geom, fill, outline, width, scale, offset):
    ox, oy = offset
    sx = sy = scale
    for poly in geom_parts(geom):
        pts = [(ox + x * sx, oy + y * sy) for x, y in poly.exterior.coords]
        draw_ctx.polygon(pts, fill=fill)
    for poly in geom_parts(geom):
        pts = [(ox + x * sx, oy + y * sy) for x, y in poly.exterior.coords]
        draw_ctx.line(pts, fill=outline, width=width, joint="curve")

def render_png(layouts: List[Dict], path: Path) -> None:
    tile = 350
    pad = 18
    gap = 28
    legend_h = 135
    width = pad * 2 + tile * 3 + gap * 2
    height = pad * 2 + tile * 3 + gap * 2 + legend_h
    draw_size = 306

    img = Image.new("RGB", (width, height), PAGE_BG)
    d = ImageDraw.Draw(img)

    try:
        title_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 12)
        subtitle_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 9)
        code_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 12)
        main_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 14)
        legend_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 10)
    except Exception:
        title_font = subtitle_font = code_font = main_font = legend_font = None

    for i, layout in enumerate(layouts):
        row, col = divmod(i, 3)
        x0 = pad + col * (tile + gap)
        y0 = pad + row * (tile + gap)
        ox = x0 + (tile - draw_size) / 2
        oy = y0 + 30
        geoms = load_geoms(layout)

        span = ", ".join(layout["radial_spans"]) if layout["radial_spans"] else "none"
        d.rectangle([x0, y0, x0 + tile, y0 + tile], fill=TILE_BG, outline=BORDER, width=2)
        d.text((x0 + 10, y0 + 4), f'ORL-CLEAN-BAND seed {layout["seed"]}', fill="#111", font=title_font)
        d.text((x0 + 10, y0 + 18), f'two-band spans: {span}', fill="#444", font=subtitle_font)

        draw_order = [c for c in sorted(geoms.keys()) if c != CORE] + [CORE]
        for code in draw_order:
            draw_shapely(d, geoms[code], ROLES[code].color, ROLES[code].color, 1, draw_size, (ox, oy))
        for code in draw_order:
            draw_shapely(d, geoms[code], None, BORDER, 3 if code == CORE else 2, draw_size, (ox, oy))

        for code in draw_order:
            x, y = geom_label_point(geoms[code])
            label = "MAIN" if code == CORE else code
            font = main_font if code == CORE else code_font
            bbox = d.textbbox((0, 0), label, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            d.text((ox + x * draw_size - tw / 2, oy + y * draw_size - th / 2), label, fill="#111", font=font)

    used = sorted({code for layout in layouts for code in layout["territories"]}, key=lambda c: (ROLES[c].layer_hint, c))
    entries = [(CORE, "MAIN = protected white core")] + [(c, f"{c} = {ROLES[c].name}") for c in used if c != CORE]
    col_w = (width - 2 * pad) / 4
    base_y = pad + 3 * tile + 2 * gap + 28
    for idx, (code, label) in enumerate(entries):
        c = idx % 4
        r = idx // 4
        x = int(pad + c * col_w)
        y = int(base_y + r * 23)
        d.rectangle([x, y - 8, x + 16, y + 8], fill=ROLES[code].color, outline=BORDER, width=1)
        d.text((x + 22, y - 8), label, fill="#111", font=legend_font)

    img.save(path)

def main() -> None:
    seeds = [5101, 5279, 5441, 5639, 5801, 5987, 6151, 6317, 6521]
    layouts = [make_layout(seed) for seed in seeds]

    manifest = {
        "language": "ORL-CLEAN-BAND-1.0",
        "description": (
            "Clean hierarchical orthogonal layout language. It uses nested bands around a central white core. "
            "Regions are rectangles or single-corner L-shaped territories. Some regions span two bands by "
            "radial merge, but no region uses random jagged interlocking or U-shaped brackets."
        ),
        "grammar": {
            "Layout": "Core + DirectBand + MiddleBand + ApparatusBand + RadialSpans + Relations",
            "Core": "single central white rectangle",
            "DirectBand": "four L-shaped direct-commentary arcs, split so no full core edge belongs to one region",
            "MiddleBand": "four L-shaped supercommentary arcs; optionally merges radially with a direct arc",
            "ApparatusBand": "mostly rectangular outer shelves and rails",
            "RadialSpan": "same quadrant territory merges across adjacent bands, creating a meaningful two-ring span",
            "Disallowed": ["U-shape", "multi-step seam", "random-walk polyomino", "jagged interlock"],
        },
        "roles": [asdict(r) for r in ROLES.values()],
        "layouts": layouts,
    }

    JSON_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    render_svg(layouts, SVG)
    render_png(layouts, PNG)
    print(f"Created: {PNG}")
    print(f"Created: {SVG}")
    print(f"Created: {JSON_PATH}")

if __name__ == "__main__":
    main()
